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
 * ---------------------------------------------------------------------
 * ROUND 14 UPDATE: real product catalog + per-item sales history
 * ---------------------------------------------------------------------
 * The dashboard's "Product Performance" table used to run entirely on a
 * small hand-written sample of ~20 brands. This version instead:
 *
 *   1. Pulls the FULL active item catalog from Lightspeed (name, brand,
 *      category) every run, so every brand/category the store actually
 *      carries shows up in the dashboard's filter dropdowns — not just
 *      whatever happened to be in a hand-picked sample list.
 *   2. Keeps a small rolling-window history file
 *      (public/product-sales-history.json) of each day's per-item units
 *      and revenue, so "Avg. Units/Wk", "Avg. Sales/Wk", and the
 *      units/sales trend can be computed from real transactions instead
 *      of invented numbers. This file is NOT read by the dashboard
 *      directly — it's this script's own memory between runs, committed
 *      to the repo so it survives from one GitHub Actions run to the
 *      next.
 *   3. Supports an optional one-time BACKFILL_DAYS environment variable
 *      (see "Backfill mode" below) to seed several weeks of history in
 *      one run instead of waiting for the daily job to accumulate it.
 *
 * The existing top-level fields (totalRevenue, transactionCount,
 * topItems, lowStockItems, etc.) are untouched — this only ADDS a new
 * `products` array to public/data.json.
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   LS_CLIENT_ID
 *   LS_CLIENT_SECRET
 *   LS_REFRESH_TOKEN
 *   LS_ACCOUNT_ID
 *
 * Optional environment variables:
 *   LOW_STOCK_THRESHOLD   (default 5)
 *   HISTORY_WINDOW_DAYS   (default 84 — 12 weeks of rolling history kept)
 *   BACKFILL_DAYS         (default unset — see "Backfill mode" below)
 *   BACKFILL_MAX_CHUNKS   (default 600 — safety cap on API pages during
 *                          a backfill; each chunk is 100 sales)
 *
 * ---------------------------------------------------------------------
 * Backfill mode
 * ---------------------------------------------------------------------
 * On a brand-new setup, the rolling history file starts empty, so
 * "Avg. Units/Wk" etc. will show 0 for everything until ~8 weeks of
 * daily runs have accumulated enough history for a trend. To skip that
 * wait, trigger the GitHub Actions workflow manually from the Actions
 * tab ("Run workflow") with the backfill_days input set to something
 * like 84 (12 weeks). That does a one-time larger historical pull to
 * seed the history file immediately, in addition to the normal
 * yesterday-sync. This is slower (many more API pages) and should be
 * run manually, NOT left as part of the daily cron — the workflow file
 * only passes this through when you fill in the input by hand.
 *
 * ---------------------------------------------------------------------
 * NOTE ON API DETAILS (confirmed against a live account):
 * This API does not support a "sort" parameter, and it silently ignores
 * timeStamp range-filter query params too — it just returns records
 * oldest-first from the very beginning of the account's history. So
 * fetchSalesForDateRange() below reads the total record count the API
 * DOES report correctly, jumps near the end via a large "offset", and
 * walks backward until it's covered the whole target window. See that
 * function's own comment for details.
 *
 * NOTE ON ASSUMPTIONS THAT COULDN'T BE VERIFIED FROM HERE:
 * The brand/category field names below (Item.Manufacturer.name and
 * Item.Category.name) are based on Lightspeed's published data model but
 * weren't tested against this specific account. The code checks a
 * couple of casing variants defensively and logs a warning if most items
 * come back without a resolved brand/category, so a wrong guess fails
 * loud (falls back to "Unspecified"/"Uncategorized") rather than silently.
 * If that warning shows up in the Actions log, the fix is almost
 * certainly just adjusting the field name in itemBrand()/itemCategory()
 * below to match what your account actually returns — the console.log
 * of a sample raw item (below) will show the real shape.
 */

const LS_TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LS_API_BASE = 'https://api.lightspeedapp.com/API/Account';

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD || 5);
const HISTORY_WINDOW_DAYS = Number(process.env.HISTORY_WINDOW_DAYS || 84);
const BACKFILL_DAYS = process.env.BACKFILL_DAYS ? Number(process.env.BACKFILL_DAYS) : 0;
const BACKFILL_MAX_CHUNKS = Number(process.env.BACKFILL_MAX_CHUNKS || 600);
const HISTORY_FILE = 'public/product-sales-history.json';

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
 * Fetches Sale records whose timeStamp falls in [rangeStart, rangeEnd)
 * (both Date objects, rangeEnd exclusive).
 *
 * CONFIRMED (against a live account, ~464k total sales dating to 2012):
 * this API silently ignores timeStamp range-filter query params — it just
 * returns records oldest-first from the very beginning, regardless of any
 * filter passed. So instead of filtering server-side, this reads the
 * "@attributes.count" total the API DOES report correctly, jumps near the
 * end of that ordered list via a large "offset", and walks backward in
 * chunks until it's gone far enough to cover the whole target range.
 *
 * Used both for the daily single-day pull (see fetchSalesForDate below)
 * and for an optional multi-week backfill (see main()) — the single-day
 * case is just a range of one day.
 */
async function fetchSalesForDateRange(accessToken, accountId, rangeStart, rangeEnd, maxChunks) {
  const limit = 100;

  // Hard floor: never walk back further than 5 years before the range
  // start, no matter what. In normal operation this is never actually
  // hit — it's just a guardrail against ever accidentally scanning
  // deep/old history if something above passes a bad date.
  const earliestAllowed = new Date(rangeStart);
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

  while (cursor > 0 && chunksFetched < maxChunks) {
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
      if (isCompleted && saleTime >= rangeStart && saleTime < rangeEnd) {
        sales.push(sale);
      }
    }

    if (offset === 0) break; // reached the very beginning of all sales
    if (oldestInBatch && oldestInBatch < rangeStart) break; // gone back far enough
    if (oldestInBatch && oldestInBatch < earliestAllowed) {
      hitFiveYearFloor = true;
      break; // refuse to walk back further than 5 years, no matter what
    }

    cursor = offset;

    if (chunksFetched % 25 === 0) {
      console.log(`  ...scanned ${chunksFetched} chunks so far (still walking back to ${rangeStart.toISOString().slice(0, 10)})`);
    }
  }

  if (chunksFetched >= maxChunks) {
    console.warn(`Stopped after ${maxChunks} chunks — the requested window may need a larger search (raise BACKFILL_MAX_CHUNKS).`);
  }
  if (hitFiveYearFloor) {
    console.warn(
      `Stopped at the 5-year lookback floor (${earliestAllowed.toISOString().slice(0, 10)}) without confirming the full target range was covered.`
    );
  }

  return sales;
}

/** Single-day convenience wrapper around fetchSalesForDateRange, used by the normal daily sync. */
async function fetchSalesForDate(accessToken, accountId, targetDateStr) {
  const targetStart = new Date(`${targetDateStr}T00:00:00Z`);
  const targetEnd = new Date(targetStart.getTime() + 24 * 60 * 60 * 1000); // exclusive, next midnight UTC
  return fetchSalesForDateRange(accessToken, accountId, targetStart, targetEnd, 30);
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

// ---------------------------------------------------------------------
// Product catalog + species inference
// ---------------------------------------------------------------------

// Lightspeed has no native "species" field, so this infers one from the
// category name and/or item description. Pet stores usually name
// categories in a way this catches out of the box (e.g. "Dog Food",
// "Cat Litter"); if your account's naming is different, or you carry
// species this list doesn't cover, just extend SPECIES_RULES below —
// the dashboard's species filter dropdown is built from whatever values
// actually show up here, so adding a rule is the only change needed.
const SPECIES_RULES = [
  { species: 'Dog', pattern: /\bdogs?\b|\bpupp(y|ies)\b|\bcanine\b/i },
  { species: 'Cat', pattern: /\bcats?\b|\bkitten(s)?\b|\bfeline\b/i },
  { species: 'Small Pet', pattern: /\brabbit(s)?\b|\bhamster(s)?\b|\bguinea pig(s)?\b|\bferret(s)?\b|\bsmall (animal|pet)\b|\bgerbil(s)?\b|\bmouse\b|\bmice\b|\bchinchilla(s)?\b/i },
  { species: 'Bird', pattern: /\bbirds?\b|\bavian\b|\bparrot(s)?\b|\bparakeet(s)?\b|\bcockatiel(s)?\b/i },
  { species: 'Reptile & Aquatic', pattern: /\breptile(s)?\b|\baquarium(s)?\b|\bfish\b|\bturtle(s)?\b|\blizard(s)?\b|\bsnake(s)?\b|\baquatic\b/i },
];

function inferSpecies(category, description) {
  const text = `${category || ''} ${description || ''}`;
  for (const rule of SPECIES_RULES) {
    if (rule.pattern.test(text)) return rule.species;
  }
  return 'Other';
}

function itemBrand(item) {
  const mfr = item.Manufacturer || item.manufacturer;
  const name = mfr && (mfr.name || mfr.Name);
  return name && String(name).trim() ? String(name).trim() : 'Unspecified';
}

function itemCategory(item) {
  const cat = item.Category || item.category;
  const name = cat && (cat.name || cat.Name);
  return name && String(name).trim() ? String(name).trim() : 'Uncategorized';
}

/**
 * Pulls the full active item catalog (paginated) with brand + category
 * relations loaded, so every brand/category the store carries shows up
 * in the dashboard's filter dropdowns regardless of whether it sold
 * anything recently.
 *
 * The `archived: 'false'` filter is a best-effort guess at excluding
 * discontinued items — if this account's API ignores it (the API is
 * known to silently ignore filters it doesn't support, per the sales
 * lookup above), archived items just come through too, which is a
 * harmless degradation, not a failure.
 */
async function fetchAllItems(accessToken, accountId) {
  const items = [];
  let offset = 0;
  const limit = 100;
  const MAX_PAGES = 300; // safety cap: 30,000 items, far above any real catalog
  let pages = 0;
  let sampleLogged = false;

  while (pages < MAX_PAGES) {
    const page = await apiGet(accessToken, accountId, 'Item.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['archived', 'false'],
      ['load_relations', '["Category","Manufacturer"]'],
    ]);
    pages += 1;

    const batch = Array.isArray(page.Item) ? page.Item : page.Item ? [page.Item] : [];
    if (batch.length === 0) break;

    if (!sampleLogged) {
      // One-time raw sample so a wrong brand/category field-name guess is
      // easy to diagnose from the Actions log instead of failing silently.
      console.log('Sample raw item shape (first item, for diagnosing brand/category field names):');
      console.log(JSON.stringify(batch[0]).slice(0, 800));
      sampleLogged = true;
    }

    for (const item of batch) {
      if (item.archived === 'true' || item.archived === true) continue;
      const name = item.description || `Item #${item.itemID}`;
      const brand = itemBrand(item);
      const category = itemCategory(item);
      items.push({
        itemID: String(item.itemID),
        name,
        brand,
        category,
        species: inferSpecies(category, name),
      });
    }

    if (batch.length < limit) break;
    offset += limit;
  }

  if (pages >= MAX_PAGES) {
    console.warn(`Stopped item catalog pull after ${MAX_PAGES} pages — catalog may be larger than expected.`);
  }

  const unresolvedBrand = items.filter((it) => it.brand === 'Unspecified').length;
  if (items.length > 0 && unresolvedBrand / items.length > 0.5) {
    console.warn(
      `${unresolvedBrand} of ${items.length} items came back with no resolvable brand. ` +
      `The Manufacturer relation's field name may differ from what itemBrand() expects — ` +
      `check the sample raw item logged above and adjust itemBrand() in this script.`
    );
  }

  return items;
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

/**
 * Groups a list of Sale records (any date range) into a per-day,
 * per-item units/revenue map: { 'YYYY-MM-DD': { itemID: { qty, revenue } } }.
 * Used to update the rolling product-sales-history.json file.
 */
function aggregatePerItemByDate(sales) {
  const byDate = {};
  for (const sale of sales) {
    const dateStr = new Date(sale.timeStamp).toISOString().slice(0, 10);
    const lines = Array.isArray(sale.SaleLines?.SaleLine)
      ? sale.SaleLines.SaleLine
      : sale.SaleLines?.SaleLine
      ? [sale.SaleLines.SaleLine]
      : [];

    if (!byDate[dateStr]) byDate[dateStr] = {};
    const dayMap = byDate[dateStr];

    for (const line of lines) {
      const itemId = String(line.itemID);
      const qty = Number(line.unitQuantity || 0);
      const revenue = Number(line.calcTotal || line.unitPrice * line.unitQuantity || 0);
      if (!dayMap[itemId]) dayMap[itemId] = { qty: 0, revenue: 0 };
      dayMap[itemId].qty += qty;
      dayMap[itemId].revenue += revenue;
    }
  }
  return byDate;
}

async function loadHistory() {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.warn(`Could not read ${HISTORY_FILE} (${err.message}) — starting a fresh history.`);
    return {};
  }
}

function mergeHistory(history, perDateMap) {
  for (const [dateStr, dayMap] of Object.entries(perDateMap)) {
    history[dateStr] = dayMap; // full day is always known outright, so overwrite rather than add
  }
  return history;
}

/** Drops any date keys older than HISTORY_WINDOW_DAYS before `mostRecentDateStr`. */
function pruneHistory(history, mostRecentDateStr) {
  const cutoff = new Date(`${mostRecentDateStr}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_WINDOW_DAYS);
  for (const dateStr of Object.keys(history)) {
    if (new Date(`${dateStr}T00:00:00Z`) < cutoff) delete history[dateStr];
  }
  return history;
}

/**
 * Combines the item catalog with the rolling sales history into the
 * dashboard-ready `products` array: every active item, with real
 * avg-units/wk, avg-sales/wk, and a units/sales trend (last 4 weeks of
 * history vs. the 4 weeks before that) wherever enough history exists
 * yet. Items with no sales in the window still appear (avg = 0, trend
 * = 0) so brand/category filters stay complete — this mirrors how the
 * old hand-written sample always included some slow movers.
 */
function computeProductStats(history, catalog) {
  const dates = Object.keys(history).sort(); // ascending
  const windowDays = dates.length;
  const recentCutoff = new Date();
  // Split the available window into "most recent 4 weeks" vs "the 4 weeks
  // before that" for trend purposes. Uses the history's own most recent
  // date as "today" so this works the same in backfill mode as it does
  // day-to-day.
  const mostRecentDateStr = dates[dates.length - 1];
  let recentStart = null;
  let priorStart = null;
  if (mostRecentDateStr) {
    const mostRecent = new Date(`${mostRecentDateStr}T00:00:00Z`);
    recentStart = new Date(mostRecent);
    recentStart.setUTCDate(recentStart.getUTCDate() - 27); // 4 weeks incl. today
    priorStart = new Date(recentStart);
    priorStart.setUTCDate(priorStart.getUTCDate() - 28); // the 4 weeks before that
  }

  const totals = new Map(); // itemID -> { qty, revenue, recentQty, recentRevenue, priorQty, priorRevenue }
  for (const dateStr of dates) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const dayMap = history[dateStr];
    for (const [itemId, v] of Object.entries(dayMap)) {
      if (!totals.has(itemId)) {
        totals.set(itemId, { qty: 0, revenue: 0, recentQty: 0, recentRevenue: 0, priorQty: 0, priorRevenue: 0 });
      }
      const t = totals.get(itemId);
      t.qty += v.qty;
      t.revenue += v.revenue;
      if (recentStart && d >= recentStart) {
        t.recentQty += v.qty;
        t.recentRevenue += v.revenue;
      } else if (priorStart && d >= priorStart && recentStart && d < recentStart) {
        t.priorQty += v.qty;
        t.priorRevenue += v.revenue;
      }
    }
  }

  function pctChange(curr, prev) {
    if (!prev) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
  }

  const haveFullTrendWindow = windowDays >= 56; // need both 4-week halves

  return catalog.map((item) => {
    const t = totals.get(item.itemID);
    const weeks = windowDays > 0 ? windowDays / 7 : 1;
    const avgUnitsWk = t ? Math.round((t.qty / weeks) * 10) / 10 : 0;
    const avgSalesWk = t ? Math.round((t.revenue / weeks) * 100) / 100 : 0;
    let unitsTrend = 0;
    let salesTrend = 0;
    if (t && haveFullTrendWindow) {
      unitsTrend = pctChange(t.recentQty / 4, t.priorQty / 4);
      salesTrend = pctChange(t.recentRevenue / 4, t.priorRevenue / 4);
    }
    return {
      name: item.name,
      brand: item.brand,
      category: item.category,
      species: item.species,
      avgUnitsWk,
      avgSalesWk,
      unitsTrend,
      salesTrend,
    };
  });
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

  console.log('Fetching full item catalog (brand/category)...');
  const catalog = await fetchAllItems(accessToken, accountId);
  console.log(`Catalog: ${catalog.length} active items across ${new Set(catalog.map((i) => i.brand)).size} brands.`);

  let history = await loadHistory();

  if (BACKFILL_DAYS > 0) {
    console.log(`Backfill requested: pulling the ${BACKFILL_DAYS} days before ${targetDateStr}. This can take a while...`);
    const targetStart = new Date(`${targetDateStr}T00:00:00Z`);
    const backfillStart = new Date(targetStart);
    backfillStart.setUTCDate(backfillStart.getUTCDate() - BACKFILL_DAYS);
    const backfillSales = await fetchSalesForDateRange(accessToken, accountId, backfillStart, targetStart, BACKFILL_MAX_CHUNKS);
    console.log(`Backfill pulled ${backfillSales.length} sales across ${BACKFILL_DAYS} days.`);
    history = mergeHistory(history, aggregatePerItemByDate(backfillSales));
  }

  // Always merge in yesterday's sales too (reusing the fetch already done
  // above for the existing totalRevenue/transactionCount summary).
  history = mergeHistory(history, aggregatePerItemByDate(sales));
  history = pruneHistory(history, targetDateStr);

  const products = computeProductStats(history, catalog);

  const output = {
    generatedAt: now.toISOString(),
    reportDate: targetDateStr,
    ...summary,
    lowStockItems: lowStock,
    products,
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/data.json', JSON.stringify(output, null, 2));
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history));

  console.log(`Wrote public/data.json (${products.length} products) and ${HISTORY_FILE} (${Object.keys(history).length} days of history).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
