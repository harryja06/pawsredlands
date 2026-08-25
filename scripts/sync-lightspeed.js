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
 * Optional environment variables:
 *   DEBUG_FIELDS=1   Prints one raw sample record each for Item (low-stock
 *                    scan), SaleLines.Item (Category/Manufacturer/cost), and
 *                    Customer (createTime) to the run log, to confirm real
 *                    Lightspeed field names on this account. Safe to leave
 *                    on permanently (it only adds console output), but it's
 *                    meant as a one-off: trigger a manual "Run workflow"
 *                    with this set, read the log, then turn it back off.
 *   LOW_STOCK_THRESHOLD   Quantity-on-hand cutoff for a "low stock" alert
 *                         (default 5).
 *   LOW_STOCK_MAX_ITEMS   Cap on how many low-stock alerts are written to
 *                         the dashboard, most urgent (lowest qty) first
 *                         (default 25) — a large/old catalog can have far
 *                         more at-or-under-threshold SKUs than belong on a
 *                         daily alert panel.
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
 * Relations to pull on each Sale line's Item. We ask for Category and
 * Manufacturer too (candidates for "revenue by category" and "top 5
 * brands by revenue") but nested relations two levels deep aren't
 * guaranteed to work on every Lightspeed account, so fetchSalesForDate()
 * probes once with the rich set and falls back to the plain set if the
 * API rejects it.
 */
const RICH_LINE_RELATIONS = '["SaleLines","SaleLines.Item","SaleLines.Item.Category","SaleLines.Item.Manufacturer"]';
const BASIC_LINE_RELATIONS = '["SaleLines","SaleLines.Item"]';
 
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
 
  // Probe once to see whether the rich (Category + Manufacturer) relation
  // set is supported on this account. If not, fall back quietly rather
  // than failing the whole sync.
  let lineRelations = RICH_LINE_RELATIONS;
  try {
    await apiGet(accessToken, accountId, 'Sale.json', [
      ['limit', '1'],
      ['offset', '0'],
      ['load_relations', RICH_LINE_RELATIONS],
    ]);
  } catch (err) {
    console.warn(
      `Rich Item relations (Category/Manufacturer) not supported here, falling back to basics: ${err.message}`
    );
    lineRelations = BASIC_LINE_RELATIONS;
  }
 
  const sales = [];
  let cursor = totalCount;
  let chunksFetched = 0;
  let hitFiveYearFloor = false;
 
  while (cursor > 0 && chunksFetched < MAX_CHUNKS) {
    const offset = Math.max(0, cursor - limit);
    const page = await apiGet(accessToken, accountId, 'Sale.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['load_relations', lineRelations],
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
 
// Non-physical ledger entries Lightspeed sometimes lists as "items" (store
// credit / opening balance adjustments, coupons, fees, test rows) — these
// aren't real stock, so they get filtered out of the low-stock alert list as
// noise. Confirmed against a live sync: the unfiltered list ran to 7,000+
// entries, dominated by discontinued/dead SKUs and non-inventory rows like
// this, not genuine low-stock alerts.
const NON_PHYSICAL_ITEM_PATTERN =
  /account entry|opening balance|coupon|redemption|re-?stocking fee|gift (card|certificate)|service fee|shipping (charge|fee)/i;
 
function isNonPhysicalItem(description) {
  const trimmed = (description || '').trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === 'test') return true;
  return NON_PHYSICAL_ITEM_PATTERN.test(trimmed);
}
 
// Even after filtering out non-physical rows, a large or long-running
// catalog can still have far more at-or-under-threshold SKUs than belong on
// a daily alert panel (old discontinued items sitting at 0 forever). Rather
// than silently dumping all of them, show the most urgent (lowest quantity
// first) up to this cap, and log how many were left off so it's visible in
// the Action run rather than hidden.
const LOW_STOCK_MAX_ITEMS = Number(process.env.LOW_STOCK_MAX_ITEMS || 25);
 
async function fetchLowStockItems(accessToken, accountId) {
  const lowStock = [];
  let offset = 0;
  const limit = 100;
  let debugSampleLogged = false;
 
  while (true) {
    const page = await apiGet(accessToken, accountId, 'Item.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      ['load_relations', '["ItemShops"]'],
    ]);
 
    const batch = Array.isArray(page.Item) ? page.Item : page.Item ? [page.Item] : [];
    if (batch.length === 0) break;
 
    for (const item of batch) {
      if (process.env.DEBUG_FIELDS === '1' && !debugSampleLogged) {
        debugSampleLogged = true;
        console.log('--- DEBUG_FIELDS: sample raw Item.json record ---');
        console.log(JSON.stringify(item, null, 2));
      }
      if (isNonPhysicalItem(item.description)) continue;
 
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
 
  lowStock.sort((a, b) => a.quantityOnHand - b.quantityOnHand);
  if (lowStock.length > LOW_STOCK_MAX_ITEMS) {
    console.warn(
      `${lowStock.length} items are at or under the low-stock threshold (${LOW_STOCK_THRESHOLD}) after filtering — showing the ${LOW_STOCK_MAX_ITEMS} most urgent on the dashboard. The rest may be dead/discontinued SKUs worth reviewing in Lightspeed, or the threshold may need lowering.`
    );
  }
  return lowStock.slice(0, LOW_STOCK_MAX_ITEMS);
}
 
/**
 * Known pet-supply brand names to match against an Item's description as a
 * fallback when there's no Manufacturer relation on this account. This list
 * is a stopgap — TODO: drop it once the Manufacturer-field diagnostic
 * confirms real brand data is available on every Item.
 */
const KNOWN_BRAND_FALLBACKS = [
  "Dr. Marty", 'Nulo', 'RAWZ', "Tucker's", 'Small Batch', 'Fromm', 'Orijen',
  'Acana', "Stella & Chewy's", 'Primal', 'Wellness', 'Merrick', 'Zignature',
];
 
function resolveBrand(item) {
  const manufacturerName = item?.Manufacturer?.name;
  if (manufacturerName && manufacturerName.trim()) return manufacturerName.trim();
 
  const description = item?.description || '';
  const matched = KNOWN_BRAND_FALLBACKS.find((brand) =>
    description.toLowerCase().includes(brand.toLowerCase())
  );
  return matched || 'Other';
}
 
function resolveCategory(item) {
  const categoryName = item?.Category?.name;
  return categoryName && categoryName.trim() ? categoryName.trim() : 'Uncategorized';
}
 
/**
 * Per-unit cost for margin math. Lightspeed accounts commonly expose one of
 * these two fields on Item; try the weighted average cost first, then the
 * default (list) cost. Returns null (rather than 0) when neither is present
 * so callers can tell "no cost data" apart from "cost is genuinely zero."
 */
function resolveUnitCost(item) {
  if (item?.avgCost !== undefined && item.avgCost !== null && item.avgCost !== '') {
    return Number(item.avgCost);
  }
  if (item?.defaultCost !== undefined && item.defaultCost !== null && item.defaultCost !== '') {
    return Number(item.defaultCost);
  }
  return null;
}
 
/**
 * Store-local hour (0-23) a sale happened in, straight from the clock digits
 * in the Lightspeed timeStamp string (e.g. "2026-08-22T11:15:32+00:00" ->
 * 11). We deliberately do NOT run this through `new Date(...).getHours()` /
 * `.getUTCHours()` — those convert to the runtime's local time or to UTC,
 * neither of which is guaranteed to be the store's local time. Reading the
 * digits directly assumes Lightspeed's timeStamp clock portion is already
 * in the store's local time — TODO: confirm against a real Sale.json
 * sample and adjust if it turns out to be UTC instead.
 */
function storeLocalHour(timeStampStr) {
  const match = /T(\d{2}):/.exec(timeStampStr || '');
  return match ? Number(match[1]) : null;
}
 
function aggregate(sales) {
  let totalRevenue = 0;
  const transactionCount = sales.length;
  let totalUnits = 0;
  let revenueWithCost = 0;
  let costOfRevenueWithCost = 0;
  let anyCostDataFound = false;
 
  const brandRevenue = new Map();
  const categoryRevenue = new Map();
  const itemStats = new Map(); // name -> { revenue, unitsSold }
  const hourCounts = new Map();
  let debugSampleLogged = false;
 
  for (const sale of sales) {
    const saleTotal = Number(sale.total || 0);
    totalRevenue += saleTotal;
 
    const hour = storeLocalHour(sale.timeStamp);
    if (hour !== null) {
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }
 
    const lines = Array.isArray(sale.SaleLines?.SaleLine)
      ? sale.SaleLines.SaleLine
      : sale.SaleLines?.SaleLine
      ? [sale.SaleLines.SaleLine]
      : [];
 
    for (const line of lines) {
      const item = line.Item;
      if (process.env.DEBUG_FIELDS === '1' && !debugSampleLogged && item) {
        debugSampleLogged = true;
        console.log('--- DEBUG_FIELDS: sample SaleLine.Item record (Category/Manufacturer/cost fields) ---');
        console.log(JSON.stringify(item, null, 2));
      }
      const lineTotal = Number(line.calcTotal || line.unitPrice * line.unitQuantity || 0);
      const unitQuantity = Number(line.unitQuantity || 0);
      totalUnits += unitQuantity;
 
      const brand = resolveBrand(item);
      brandRevenue.set(brand, (brandRevenue.get(brand) || 0) + lineTotal);
 
      const category = resolveCategory(item);
      categoryRevenue.set(category, (categoryRevenue.get(category) || 0) + lineTotal);
 
      const itemName = item?.description || 'Unknown item';
      const prevStats = itemStats.get(itemName) || { revenue: 0, unitsSold: 0 };
      itemStats.set(itemName, {
        revenue: prevStats.revenue + lineTotal,
        unitsSold: prevStats.unitsSold + unitQuantity,
      });
 
      const unitCost = resolveUnitCost(item);
      if (unitCost !== null) {
        anyCostDataFound = true;
        revenueWithCost += lineTotal;
        costOfRevenueWithCost += unitCost * unitQuantity;
      }
    }
  }
 
  const topBrands = [...brandRevenue.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }));
 
  const revenueByCategory = [...categoryRevenue.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }));
 
  // Top individual items by revenue (as opposed to topBrands, which rolls
  // items up by manufacturer). Keyed by item description, so two different
  // SKUs that happen to share an identical description would be combined —
  // an acceptable simplification for a top-10 revenue ranking.
  const topItems = [...itemStats.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([name, stats]) => ({
      name,
      revenue: Math.round(stats.revenue * 100) / 100,
      unitsSold: stats.unitsSold,
    }));
 
  // Full hour-by-hour breakdown (only hours with at least one sale) so the
  // dashboard can draw the whole histogram, not just the single peak.
  const hourlyCounts = [...hourCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, count]) => ({ hour, count }));
 
  let busiestHour = null;
  let busiestHourCount = 0;
  for (const [hour, count] of hourCounts.entries()) {
    if (count > busiestHourCount) {
      busiestHour = hour;
      busiestHourCount = count;
    }
  }
 
  const avgMarginPct =
    anyCostDataFound && revenueWithCost > 0
      ? Math.round(((revenueWithCost - costOfRevenueWithCost) / revenueWithCost) * 1000) / 10
      : null;
 
  if (!anyCostDataFound) {
    console.warn('No Item cost field (avgCost/defaultCost) found on any line item — avgMarginPct will be null.');
  }
 
  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    transactionCount,
    avgTransactionValue:
      transactionCount > 0 ? Math.round((totalRevenue / transactionCount) * 100) / 100 : 0,
    avgUnitsPerTransaction:
      transactionCount > 0 ? Math.round((totalUnits / transactionCount) * 10) / 10 : 0,
    avgMarginPct,
    topBrands,
    revenueByCategory,
    topItems, // [{name, revenue, unitsSold}], top 10 individual items by revenue
    hourlyCounts, // [{hour: 0-23, count}], only hours with sales
    busiestHour, // 0-23, or null if no sales
    busiestHourCount,
  };
}
 
/**
 * Splits today's sales into "new" vs "returning" customers, using each
 * Customer record's createTime: if the account was created on the report
 * date itself, we count that customer as new for the day. Walk-in sales
 * with no linked customerID are excluded from both counts (there's no way
 * to tell), so newCustomers + returningCustomers may be less than
 * transactionCount.
 *
 * TODO: confirm "createTime" is the real field name for when a Customer
 * record was created (vs. some other name) once the diagnostic comes back;
 * this degrades gracefully (logs a warning, returns nulls) if the field
 * isn't there at all.
 */
async function fetchCustomerNewness(accessToken, accountId, sales, targetDateStr) {
  const customerIds = [...new Set(sales.map((s) => s.customerID).filter((id) => id && id !== '0'))];
  if (customerIds.length === 0) {
    return { newCustomers: 0, returningCustomers: 0 };
  }
 
  let customers = [];
  try {
    const page = await apiGet(accessToken, accountId, 'Customer.json', [
      ['customerID', `IN,${customerIds.join('|')}`],
      ['limit', String(customerIds.length)],
    ]);
    customers = Array.isArray(page.Customer) ? page.Customer : page.Customer ? [page.Customer] : [];
  } catch (err) {
    console.warn(`Customer lookup for new-vs-returning failed, skipping: ${err.message}`);
    return { newCustomers: null, returningCustomers: null };
  }
 
  if (customers.length !== customerIds.length) {
    console.warn(
      `Customer.json IN-filter returned ${customers.length} of ${customerIds.length} requested — filter may not be supported on this account; new-vs-returning may be incomplete.`
    );
  }
 
  let newCustomers = 0;
  let returningCustomers = 0;
  let anyCreateTimeFound = false;
 
  if (process.env.DEBUG_FIELDS === '1' && customers[0]) {
    console.log('--- DEBUG_FIELDS: sample Customer.json record (createTime field) ---');
    console.log(JSON.stringify(customers[0], null, 2));
  }
 
  for (const customer of customers) {
    const createTime = customer.createTime || customer.timeStamp;
    if (!createTime) continue;
    anyCreateTimeFound = true;
    const createdDateStr = new Date(createTime).toISOString().slice(0, 10);
    if (createdDateStr === targetDateStr) {
      newCustomers += 1;
    } else {
      returningCustomers += 1;
    }
  }
 
  if (!anyCreateTimeFound) {
    console.warn('No createTime/timeStamp field found on Customer records — new-vs-returning will be null.');
    return { newCustomers: null, returningCustomers: null };
  }
 
  return { newCustomers, returningCustomers };
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
  const customerNewness = await fetchCustomerNewness(accessToken, accountId, sales, targetDateStr);
 
  const output = {
    generatedAt: now.toISOString(),
    reportDate: targetDateStr,
    ...summary,
    ...customerNewness,
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
