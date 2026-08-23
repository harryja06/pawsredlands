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
 * NOTE ON API DETAILS:
 * This API does not support a "sort" parameter (confirmed against a live
 * account, which rejected it as an unrecognized field). Instead, results
 * are filtered directly by timeStamp using the API's field-filter syntax:
 * fieldName=OPERATOR,value (e.g. timeStamp=>,2026-08-21T00:00:00+00:00).
 * Client-side date/status checks are kept as a safety net in case the
 * server-side filter doesn't narrow things exactly as expected.
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
 * @param {Array<[string,string]>} paramPairs - array of [key, value] tuples.
 * Using an array (rather than a plain object) lets the same key (e.g.
 * "timeStamp") appear more than once, which this API relies on for
 * expressing a range: one entry for the lower bound, one for the upper.
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
 * Fetches Sale records filtered to a single UTC day, using the API's own
 * timeStamp range filter (rather than relying on sort + early-exit, which
 * this API doesn't support). Client-side date/status checks stay in place
 * as a safety net, and a page cap guards against the filter not narrowing
 * things as expected.
 */
async function fetchSalesForDate(accessToken, accountId, targetDateStr) {
  const sales = [];
  const limit = 100;
  const MAX_PAGES = 20;

  const targetStart = new Date(`${targetDateStr}T00:00:00Z`);
  const targetEnd = new Date(targetStart.getTime() + 24 * 60 * 60 * 1000); // exclusive, next midnight UTC
  const startFilter = `${targetDateStr}T00:00:00+00:00`;
  const endFilter = `${targetEnd.toISOString().slice(0, 10)}T00:00:00+00:00`;

  let offset = 0;
  let page = 0;

  while (page < MAX_PAGES) {
    const response = await apiGet(accessToken, accountId, 'Sale.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['load_relations', '["SaleLines","SaleLines.Item"]'],
      ['timeStamp', `>,${startFilter}`],
      ['timeStamp', `<,${endFilter}`],
    ]);

    const batch = Array.isArray(response.Sale) ? response.Sale : response.Sale ? [response.Sale] : [];
    if (batch.length === 0) break;

    for (const sale of batch) {
      const saleTime = new Date(sale.timeStamp);
      const isCompleted = sale.completed === 'true' || sale.completed === true;
      if (isCompleted && saleTime >= targetStart && saleTime < targetEnd) {
        sales.push(sale);
      }
    }

    if (batch.length < limit) break;
    offset += limit;
    page += 1;
  }

  if (page >= MAX_PAGES) {
    console.warn(
      `Stopped after ${MAX_PAGES} pages (${MAX_PAGES * limit} records) — the date filter may not be narrowing results as expected.`
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
