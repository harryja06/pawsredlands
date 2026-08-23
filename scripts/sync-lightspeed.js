#!/usr/bin/env node
/**
 * sync-lightspeed.js
 *
 * Pulls yesterday's sales data from the Lightspeed Retail (R-Series) API,
 * aggregates a few dashboard-friendly numbers, and writes them to
 * public/data.json for the static dashboard to read.
 *
 * Runs once a day via the GitHub Actions workflow in
 * .github/workflows/daily-sync.yml
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   LS_CLIENT_ID
 *   LS_CLIENT_SECRET
 *   LS_REFRESH_TOKEN
 *   LS_ACCOUNT_ID
 *
 * NOTE ON API DETAILS (confirmed against a live account):
 * This API does not support a "sort" parameter, and it silently ignores
 * timeStamp range-filter query params too — it just returns records
 * oldest-first from the very beginning of the account's history. So
 * fetchSalesForDate() below reads the total record count the API DOES
 * report correctly, jumps near the end via a large "offset", and walks
 * backward until it's covered the whole target day. See that function's
 * own comment for details.
 */

const LS_TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LS_API_BASE = 'https://api.lightspeedapp.com/API/Account';

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD || 5);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function refreshAccessToken() {
  const clientId = requireEnv('LS_CLIENT_ID');
  const clientSecret = requireEnv('LS_CLIENT_SECRET');
  const refreshToken = requireEnv('LS_REFRESH_TOKEN');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(LS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`Token refresh response missing access_token: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

/**
 * @param {Array<[string,string]>} paramPairs - array of [key, value] tuples
 * (rather than a plain object) so query params could repeat a key if ever
 * needed.
 */
async function apiGet(accessToken, accountId, path, paramPairs = []) {
  const url = new URL(`${LS_API_BASE}/${accountId}/${path}`);
  for (const [key, value] of paramPairs) {
    url.searchParams.append(key, value);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    // Leaky-bucket rate limit hit. Back off and retry once.
    const retryAfter = Number(res.headers.get('Retry-After') || 5);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return apiGet(accessToken, accountId, path, paramPairs);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Fetches Sale records for a single UTC day.
 *
 * CONFIRMED (against a live account, ~464k total sales dating to 2012):
 * this API silently ignores timeStamp range-filter query params — it just
 * returns records oldest-first from the very beginning, regardless of any
 * filter passed. So instead of filtering server-side, this reads the
 * "@attributes.count" total the API DOES report correctly, jumps near the
 * end of that ordered list via a large "offset", and walks backward in
 * chunks until it's gone far enough to cover the whole target day.
 */
async function fetchSalesForDate(accessToken, accountId, targetDateStr) {
  const limit = 100;
  const MAX_CHUNKS = 30; // safety cap: ~3000 of the most recent sales

  const targetStart = new Date(`${targetDateStr}T00:00:00Z`);
  const targetEnd = new Date(targetStart.getTime() + 24 * 60 * 60 * 1000); // exclusive, next midnight UTC

  // Hard floor: never walk back further than 5 years before the target
  // day, no matter what. In normal operation this is never actually hit —
  // "yesterday" is always right at the end of the data — it's just a
  // guardrail against ever accidentally scanning deep/old history.
  const earliestAllowed = new Date(targetStart);
  earliestAllowed.setUTCFullYear(earliestAllowed.getUTCFullYear() - 5);

  const countProbe = await apiGet(accessToken, accountId, 'Sale.json', [
    ['limit', '1'],
    ['offset', '0'],
  ]);
  const totalCount = Number(countProbe['@attributes']?.count || 0);

  const sales = [];
  let cursor = totalCount;
  let chunksFetched = 0;
  let hitFiveYearFloor = false;

  while (cursor > 0 && chunksFetched < MAX_CHUNKS) {
    const offset = Math.max(0, cursor - limit);
    const page = await apiGet(accessToken, accountId, 'Sale.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['load_relations', '["SaleLines","SaleLines.Item"]'],
    ]);

    const batch = Array.isArray(page.Sale) ? page.Sale : page.Sale ? [page.Sale] : [];
    chunksFetched += 1;

    let oldestInBatch = null;
    for (const sale of batch) {
      const saleTime = new Date(sale.timeStamp);
      if (oldestInBatch === null || saleTime < oldestInBatch) oldestInBatch = saleTime;

      const isCompleted = sale.completed === 'true' || sale.completed === true;
      if (isCompleted && saleTime >= targetStart && saleTime < targetEnd) {
        sales.push(sale);
      }
    }

    if (offset === 0) break; // reached the very beginning of all sales
    if (oldestInBatch && oldestInBatch < targetStart) break; // gone back far enough
    if (oldestInBatch && oldestInBatch < earliestAllowed) {
      hitFiveYearFloor = true;
      break; // refuse to walk back further than 5 years, no matter what
    }

    cursor = offset;
  }

  if (chunksFetched >= MAX_CHUNKS) {
    console.warn(`Stopped after ${MAX_CHUNKS} chunks — yesterday's sales may need a larger search window.`);
  }
  if (hitFiveYearFloor) {
    console.warn(
      `Stopped at the 5-year lookback floor (${earliestAllowed.toISOString().slice(0, 10)}) without confirming the full target day was covered.`
    );
  }

  return sales;
}

async function fetchLowStockItems(accessToken, accountId) {
  const lowStock = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await apiGet(accessToken, accountId, 'Item.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['load_relations', '["ItemShops"]'],
    ]);

    const batch = Array.isArray(page.Item) ? page.Item : page.Item ? [page.Item] : [];
    if (batch.length === 0) break;

    for (const item of batch) {
      const shops = Array.isArray(item.ItemShops?.ItemShop)
        ? item.ItemShops.ItemShop
        : item.ItemShops?.ItemShop
        ? [item.ItemShops.ItemShop]
        : [];
      const totalQty = shops.reduce((sum, s) => sum + Number(s.qoh || 0), 0);
      if (totalQty <= LOW_STOCK_THRESHOLD) {
        lowStock.push({
          description: item.description,
          sku: item.customSku || item.systemSku,
          quantityOnHand: totalQty,
        });
      }
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  return lowStock;
}

function aggregate(sales) {
  let totalRevenue = 0;
  let transactionCount = sales.length;
  const itemRevenue = new Map();

  for (const sale of sales) {
    totalRevenue += Number(sale.total || 0);

    const lines = Array.isArray(sale.SaleLines?.SaleLine)
      ? sale.SaleLines.SaleLine
      : sale.SaleLines?.SaleLine
      ? [sale.SaleLines.SaleLine]
      : [];

    for (const line of lines) {
      const name = line.Item?.description || `Item #${line.itemID}`;
      const lineTotal = Number(line.calcTotal || line.unitPrice * line.unitQuantity || 0);
      itemRevenue.set(name, (itemRevenue.get(name) || 0) + lineTotal);
    }
  }

  const topItems = [...itemRevenue.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }));

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    transactionCount,
    topItems,
  };
}

async function main() {
  const accountId = requireEnv('LS_ACCOUNT_ID');

  // Report on "yesterday" (UTC) since the job runs once daily, typically
  // early morning, and the full previous day is what's fully closed out.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetDateStr = yesterday.toISOString().slice(0, 10);

  console.log(`Syncing Lightspeed data for ${targetDateStr}...`);

  const accessToken = await refreshAccessToken();
  const sales = await fetchSalesForDate(accessToken, accountId, targetDateStr);
  const lowStock = await fetchLowStockItems(accessToken, accountId);
  const summary = aggregate(sales);

  const output = {
    generatedAt: now.toISOString(),
    reportDate: targetDateStr,
    ...summary,
    lowStockItems: lowStock,
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/data.json', JSON.stringify(output, null, 2));

  console.log('Wrote public/data.json:');
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
