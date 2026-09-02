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
 *   STORE_TIMEZONE        (default 'America/Los_Angeles' — the IANA zone the
 *                          store trades in. ROUND 23: every day boundary and
 *                          hourly bucket is derived in this zone. Before that
 *                          they were derived in UTC, which booked each
 *                          Pacific evening's sales to the following day.)
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
const STORE_HISTORY_FILE = 'public/store-sales-history.json'; // ROUND 18: whole-store
// daily totals (revenue/transactions/cost), the counterpart to HISTORY_FILE's
// per-item breakdown — feeds data.dailyTotals for the dashboard's real "This
// Week's Performance" / Overview daily view.

// ROUND 20/21/22: opt-in historical pull for real Monthly totals (see
// fetchHistoricalTotals()'s comment below). Unset by default — this is a
// manual, occasional workflow_dispatch input, never part of the daily cron.
// ROUND 21: dropped the Yearly view entirely — the report now goes no deeper
// than Monthly. ROUND 22: the report shows only the most recent
// MONTHLY_VIEW_MAX_MONTHS (12, i.e. 1 year) so every shown month can carry a
// genuine "vs same month last year" figure — that requires the underlying
// pull to reach back twice as deep (HISTORICAL_MONTHS=24, i.e. 2 years)
// so each shown month's year-ago counterpart (12 months further back) is
// still inside the pulled history, even for the oldest of the 12 shown
// months. (fetchHistoricalTotals() still buckets a `yearly` total alongside
// `monthly` internally in period-totals-state.json — that's harmless, free
// bookkeeping from the same walk — it's just never surfaced to the
// dashboard anymore.)
const HISTORICAL_MONTHS = process.env.HISTORICAL_MONTHS ? Number(process.env.HISTORICAL_MONTHS) : 0;
const HISTORICAL_MAX_CHUNKS = Number(process.env.HISTORICAL_MAX_CHUNKS || 3000);
const PERIOD_TOTALS_STATE_FILE = 'public/period-totals-state.json';
const MONTHLY_VIEW_MAX_MONTHS = 12; // ROUND 22: only the most recent 12 months
// (1 year) are shown on the dashboard, regardless of how much more history
// the state file has accumulated. Pulling the standard/recommended
// HISTORICAL_MONTHS=24 (2 years) gives EVERY one of these 12 shown months a
// real "vs same month last year" comparison — each shown month's year-ago
// counterpart is 12-24 months back, which is still within a 24-month-deep
// pull. (A shallower pull, e.g. HISTORICAL_MONTHS=12, would leave every shown
// month without a year-ago match — always request at least 24.)
const HOURLY_TRAILING_DAYS = Number(process.env.HOURLY_TRAILING_DAYS || 28); // how many
// of the most recent real days' hourly buckets to average for the Overview
// tab's "today vs trailing 4 weeks" Hourly comparison.

// ---------------------------------------------------------------------
// ROUND 23: store-local time
// ---------------------------------------------------------------------
// Every date and hour in this script used to be derived in UTC
// (toISOString().slice(0,10) for the day, getUTCHours() for the hour).
// For a store in Pacific time that is simply wrong:
//
//   * A sale rung up at 5:00pm PDT on Aug 20 is 00:00 UTC on Aug 21, so it
//     was being counted toward the WRONG DAY. Every evening's trade — the
//     last 7 hours of a Pacific business day in summer — was landing on the
//     following calendar day's revenue, transactions and cost.
//   * The 24 hourly buckets were UTC hours, so a 9am-7pm PDT trading day
//     was recorded in buckets 16-23 and 0-2 and would have rendered on the
//     dashboard's "By Hour" axis as 4p...11p, 12a, 1a, 2a.
//
// Everything below now buckets by the store's own local day and hour.
// Set STORE_TIMEZONE to any IANA zone name if the store ever moves or a
// second location is added; the default matches Redlands, CA.
const STORE_TIMEZONE = process.env.STORE_TIMEZONE || 'America/Los_Angeles';

/**
 * Minutes to ADD to a UTC instant to get store-local wall-clock time
 * (negative west of Greenwich). Derived from Intl rather than hardcoded so
 * daylight saving is handled automatically and correctly on the changeover
 * days themselves.
 */
function tzOffsetMinutes(date) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  // Some ICU builds format midnight as hour "24" under hour12:false.
  const asUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtcMs - date.getTime()) / 60000);
}

/**
 * Store-local calendar parts for a UTC instant. Shifting the instant by the
 * zone offset and then reading it back with the getUTC* accessors is the
 * standard trick for "read this moment as if it were local" without pulling
 * in a date library.
 */
function storeLocalParts(date) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes(date) * 60000);
  const iso = shifted.toISOString();
  return {
    dateStr: iso.slice(0, 10),   // YYYY-MM-DD, store-local
    monthKey: iso.slice(0, 7),   // YYYY-MM,    store-local
    year: String(shifted.getUTCFullYear()),
    hour: shifted.getUTCHours(), // 0-23,       store-local
  };
}

/**
 * The UTC instant at which a given store-local calendar day begins. Used to
 * turn "yesterday, in store time" into the absolute range this script pulls
 * and compares against. The offset is resolved twice because the first guess
 * is evaluated at the wrong instant on the two DST changeover days a year.
 */
function storeLocalMidnightUtc(dateStr) {
  const naive = new Date(`${dateStr}T00:00:00Z`);
  const firstPass = new Date(naive.getTime() - tzOffsetMinutes(naive) * 60000);
  const settled = tzOffsetMinutes(firstPass);
  return new Date(naive.getTime() - settled * 60000);
}

/** Adds (or subtracts) whole days to a YYYY-MM-DD string. */
function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// ROUND 23: proper-case normalization for catalog text
// ---------------------------------------------------------------------
// Lightspeed catalogs are typically keyed in by hand at the register and
// come back SHOUTING ("BLUE BUFFALO LIFE PROTECTION FORMULA 30#"). These
// strings feed the dashboard's table rows AND its filter dropdowns, so they
// are normalized once here, at the point the catalog is read, rather than in
// the frontend — that way the JSON, the table, the dropdowns and any future
// widget can never disagree about how a brand is spelled.
//
// Only strings that are entirely uppercase or entirely lowercase are
// rewritten. Anything already in deliberate mixed case is passed through
// untouched, which protects intentional styling (RAWZ, pH, iCare) that a
// blanket title-case pass would flatten.
//
// NOTE: this is display text only. product-sales-history.json is keyed by
// Lightspeed itemID, not by name, so changing the casing does NOT orphan any
// accumulated trend history.

// Kept lowercase in the middle of a name; still capitalized first or last.
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'or', 'over', 'per', 'the', 'to', 'via', 'vs', 'with',
]);

// Tokens whose casing is fixed regardless of position. Extend this as the
// real catalog turns up brands the generic rules get wrong.
const FORCED_CASE = new Map(Object.entries({
  k9: 'K9', ii: 'II', iii: 'III', iv: 'IV', vi: 'VI', vii: 'VII',
  xs: 'XS', xl: 'XL', xxl: 'XXL', sm: 'SM', md: 'MD', lg: 'LG',
  usa: 'USA', uk: 'UK', us: 'US', uv: 'UV', led: 'LED', pvc: 'PVC',
  ph: 'pH', dha: 'DHA', epa: 'EPA', msm: 'MSM', ala: 'ALA', omega: 'Omega',
  bpa: 'BPA', usda: 'USDA', aafco: 'AAFCO', grf: 'GRF',
  // Brands that are genuinely styled in all caps. An all-caps brand is
  // indistinguishable from a shouted one, so the only way to protect it is to
  // name it here. Add to this list as the real catalog turns up more.
  rawz: 'RAWZ', vetiq: 'VetIQ', petiq: 'PetIQ', nutrisource: 'NutriSource',
}));

// A number glued to a unit: 24OZ -> 24oz, 3.5LB -> 3.5lb, 12CT -> 12ct
const NUMBER_UNIT = /^(\d+(?:\.\d+)?)(oz|lb|lbs|kg|g|mg|ml|l|ct|pk|pc|in|ft|iu|mm|cm|qt|gal)$/i;

function properCaseToken(token, isFirst, isLast) {
  const bare = token.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!bare) return token;

  if (FORCED_CASE.has(bare)) {
    return token.replace(/[a-z0-9]+/i, FORCED_CASE.get(bare));
  }

  const unit = token.match(NUMBER_UNIT);
  if (unit) return unit[1] + unit[2].toLowerCase();

  // Size/count tokens that lead with a digit and carry no real word:
  // 30#, 6-PACK -> 30#, 6-Pack is handled by the segment logic below, but
  // pure tokens like "30#" or "5.5#" just lowercase harmlessly.
  if (/^\d/.test(token) && !/[a-z]{2,}/i.test(token)) return token.toLowerCase();

  if (!isFirst && !isLast && MINOR_WORDS.has(bare)) return token.toLowerCase();

  // Capitalize each hyphen-, slash- or period-separated segment
  // (GRAIN-FREE -> Grain-Free, W/CHICKEN -> W/Chicken), then walk back the
  // letter after an apostrophe so ZUKE'S becomes Zuke's rather than Zuke'S.
  return token
    .toLowerCase()
    .replace(/[a-z][a-z']*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1))
    .replace(/'([A-Z])/g, (m, c) => `'${c.toLowerCase()}`)
    .replace(/^'([a-z])/, (m, c) => `'${c.toUpperCase()}`);
}

function toProperCase(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const hasLower = /[a-z]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  if (hasLower && hasUpper) return trimmed; // deliberate mixed case — leave alone

  const tokens = trimmed.split(' ');
  return tokens
    .map((t, i) => properCaseToken(t, i === 0, i === tokens.length - 1))
    .join(' ');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

/**
 * ---------------------------------------------------------------------
 * ROUND 17 UPDATE: hard timeout on every network call
 * ---------------------------------------------------------------------
 * A run was observed to hang indefinitely (39+ minutes with no further
 * log output, no error) partway through a retried request after a token
 * refresh — plain `fetch()` with no timeout will wait forever if a
 * connection stalls or a response never arrives, and a GitHub Actions
 * job left like that just burns minutes until it eventually hits the
 * platform's own multi-hour default timeout. Wrapping every fetch with
 * an AbortController-based timeout turns a stall into a fast, clear
 * error (default 30s, override with REQUEST_TIMEOUT_MS) instead of a
 * silent hang.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms with no response`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

  const res = await fetchWithTimeout(LS_TOKEN_URL, {
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
 * ---------------------------------------------------------------------
 * ROUND 16 UPDATE: automatic token refresh-and-retry on a 401
 * ---------------------------------------------------------------------
 * A run can get a 401 "Token has expired" response on the very FIRST
 * authenticated call, immediately after a successful refreshAccessToken()
 * call — this has been observed in practice even when a token obtained
 * the same way lasted 14+ minutes in a previous run without issue. The
 * exact Lightspeed-side cause isn't confirmed (candidates: an
 * unexpectedly short-lived access token, or two workflow runs
 * overlapping and each refresh invalidating the other's token), but
 * either way the fix is the same: treat a 401 as "the token this call
 * was holding is no longer good," refresh once, and retry the same
 * request with the new token — instead of failing the whole run over
 * what is usually a one-off.
 *
 * To support that, every caller now passes a `tokenManager` (see
 * createTokenManager() below) instead of a raw access-token string, so
 * the refreshed token is shared with every call still to come in this
 * run, not just the one that hit the 401.
 */
function createTokenManager(initialToken) {
  let token = initialToken;
  return {
    get() {
      return token;
    },
    async refresh() {
      token = await refreshAccessToken();
      return token;
    },
  };
}

/**
 * @param {Array<[string,string]>} paramPairs - array of [key, value] tuples
 * (rather than a plain object) so query params could repeat a key if ever
 * needed.
 * @param {boolean} isRetryAfterRefresh - internal flag so a 401 is only
 * ever retried once per call site (a second 401 after a fresh refresh
 * means the refresh token itself is no longer valid, which needs a human
 * to fix in Lightspeed's OAuth settings, not another retry).
 * @param {number} networkRetriesLeft - a stalled/hung connection (see the
 * ROUND 17 timeout note above) or a transient network error gets a few
 * retries with a short backoff before giving up, since these are usually
 * a one-off blip rather than something a human needs to fix.
 */
async function apiGet(tokenManager, accountId, path, paramPairs = [], isRetryAfterRefresh = false, networkRetriesLeft = 3) {
  const url = new URL(`${LS_API_BASE}/${accountId}/${path}`);
  for (const [key, value] of paramPairs) {
    url.searchParams.append(key, value);
  }

  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${tokenManager.get()}` },
    });
  } catch (err) {
    if (networkRetriesLeft > 0) {
      console.warn(`${err.message} — retrying (${networkRetriesLeft} attempt(s) left)...`);
      await new Promise((r) => setTimeout(r, 5000));
      return apiGet(tokenManager, accountId, path, paramPairs, isRetryAfterRefresh, networkRetriesLeft - 1);
    }
    throw err;
  }

  if (res.status === 429) {
    // Leaky-bucket rate limit hit. Back off and retry once.
    const retryAfter = Number(res.headers.get('Retry-After') || 5);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return apiGet(tokenManager, accountId, path, paramPairs, isRetryAfterRefresh, networkRetriesLeft);
  }

  if (res.status === 401 && !isRetryAfterRefresh) {
    console.warn(`Got 401 on GET ${path} — refreshing the access token and retrying once...`);
    await tokenManager.refresh();
    return apiGet(tokenManager, accountId, path, paramPairs, true, networkRetriesLeft);
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
async function fetchSalesForDateRange(tokenManager, accountId, rangeStart, rangeEnd, maxChunks) {
  const limit = 100;

  // Hard floor: never walk back further than 5 years before the range
  // start, no matter what. In normal operation this is never actually
  // hit — it's just a guardrail against ever accidentally scanning
  // deep/old history if something above passes a bad date.
  const earliestAllowed = new Date(rangeStart);
  earliestAllowed.setUTCFullYear(earliestAllowed.getUTCFullYear() - 5);

  const countProbe = await apiGet(tokenManager, accountId, 'Sale.json', [
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
    const page = await apiGet(tokenManager, accountId, 'Sale.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      // ROUND 18: added "Customer" so each sale carries its customer's own
      // record (in particular Customer.createTime), used as a best-effort
      // "new vs returning" signal in aggregate() below — see that function's
      // comment for why this is a proxy rather than a guaranteed-accurate flag.
      ['load_relations', '["SaleLines","SaleLines.Item","Customer"]'],
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
async function fetchSalesForDate(tokenManager, accountId, targetDateStr) {
  // ROUND 23: the window is the store's own calendar day, not a UTC day —
  // midnight-to-midnight in STORE_TIMEZONE, expressed as absolute instants.
  // storeLocalMidnightUtc() is called for both ends rather than adding 24h to
  // the start, so the two DST changeover days (23h and 25h long) are covered
  // exactly instead of being clipped or double-counted.
  const targetStart = storeLocalMidnightUtc(targetDateStr);
  const targetEnd = storeLocalMidnightUtc(shiftDateStr(targetDateStr, 1)); // exclusive
  return fetchSalesForDateRange(tokenManager, accountId, targetStart, targetEnd, 30);
}

/**
 * ---------------------------------------------------------------------
 * ROUND 20/21 UPDATE: real Monthly totals, pulled directly (up to 2 years)
 * ---------------------------------------------------------------------
 * A real Monthly view — with genuine year-over-year comparisons — needs FAR
 * more history than the ~12-week rolling window the daily sync keeps
 * (HISTORY_WINDOW_DAYS). Lightspeed's API has no report/aggregate endpoint
 * (confirmed above), so getting real monthly totals means walking the FULL
 * transaction history the same way fetchSalesForDateRange() does, just
 * further back — this can mean tens of thousands of records for a store
 * this size, so a few things make it practical instead of another
 * 401-hang-style disaster:
 *
 *   1. Lightweight requests: no load_relations at all (SaleLines/Item/
 *      Customer aren't needed for period totals — only sale.total and
 *      sale.timeStamp are), which meaningfully shrinks each page's
 *      response versus the daily sync's relation-heavy pull.
 *   2. Streaming buckets instead of an in-memory array of every sale —
 *      a 2-year pull could otherwise be tens of thousands of records held
 *      in RAM at once.
 *   3. Checkpointed and resumable: progress (the running per-year/
 *      per-month sums — yes, still per-YEAR too internally, see
 *      MONTHLY_VIEW_MAX_MONTHS's comment above for why — and the offset to
 *      resume from) is saved to public/period-totals-state.json every 50
 *      chunks, so an interrupted run — or one that hits
 *      HISTORICAL_MAX_CHUNKS's per-run safety cap — picks up where it left
 *      off on the next run instead of starting the whole walk over. Re-run
 *      the workflow with the same HISTORICAL_MONTHS input as many times as
 *      it takes; each run continues, it doesn't restart.
 *
 * This is opt-in (HISTORICAL_MONTHS, unset by default) and meant to be
 * triggered manually via workflow_dispatch, NOT left running on the daily
 * cron — see daily-sync.yml. The standard depth is still 24 (2 years) —
 * ROUND 22: the dashboard now shows only the most recent
 * MONTHLY_VIEW_MAX_MONTHS (12) months, but the pull still needs to reach
 * twice that deep so every one of those 12 shown months has a real
 * same-month-last-year figure (its year-ago counterpart, 12-24 months back,
 * falls inside a 24-month-deep pull).
 */
async function fetchHistoricalTotals(tokenManager, accountId, rangeStart, maxChunks, state) {
  const limit = 100;

  // If the requested range now reaches further back than whatever a prior
  // (possibly partial or complete) run covered, the saved progress no longer
  // covers the full window that's being asked for — restart the walk from
  // the most recent sale rather than silently reporting a too-short range as
  // if it were the full requested depth.
  const rangeStartStr = rangeStart.toISOString().slice(0, 10);
  if (state.rangeStartUsed && new Date(state.rangeStartUsed) > rangeStart) {
    console.log(
      `Historical totals: requested range (back to ${rangeStartStr}) now reaches further than ` +
      `the saved progress (back to ${state.rangeStartUsed}) — restarting the walk from the most recent sale.`
    );
    state.yearly = {};
    state.monthly = {};
    state.cursor = null;
    state.complete = false;
  }
  state.rangeStartUsed = rangeStartStr;

  if (state.complete) {
    console.log('Historical totals: already walked back to the full requested range in a prior run — nothing new to fetch.');
    return state;
  }

  let cursor = state.cursor;
  if (cursor === null || cursor === undefined) {
    const countProbe = await apiGet(tokenManager, accountId, 'Sale.json', [
      ['limit', '1'],
      ['offset', '0'],
    ]);
    cursor = Number(countProbe['@attributes']?.count || 0);
    console.log(`Historical totals: starting a fresh walk from the most recent of ${cursor} total sales, back to ${rangeStartStr}.`);
  } else {
    console.log(`Historical totals: resuming a prior walk from offset ${cursor}, back to ${rangeStartStr}.`);
  }

  let chunksFetched = 0;
  let oldestSeen = null;

  while (cursor > 0 && chunksFetched < maxChunks) {
    const offset = Math.max(0, cursor - limit);
    const page = await apiGet(tokenManager, accountId, 'Sale.json', [
      ['limit', String(limit)],
      ['offset', String(offset)],
      // No load_relations here on purpose — only sale.total/timeStamp/completed
      // are needed for period totals, so this stays as light as possible over
      // what can be a very large pull.
    ]);
    chunksFetched += 1;

    const batch = Array.isArray(page.Sale) ? page.Sale : page.Sale ? [page.Sale] : [];
    let oldestInBatch = null;
    for (const sale of batch) {
      const saleTime = new Date(sale.timeStamp);
      if (oldestInBatch === null || saleTime < oldestInBatch) oldestInBatch = saleTime;

      const isCompleted = sale.completed === 'true' || sale.completed === true;
      if (!isCompleted) continue;

      const revenue = Number(sale.total || 0);
      // ROUND 23: store-local month, so the evening of the last day of a
      // month doesn't spill into the next month's total.
      const local = storeLocalParts(saleTime);
      const year = local.year;
      const monthKey = local.monthKey; // YYYY-MM, store-local

      if (!state.yearly[year]) state.yearly[year] = { revenue: 0, transactionCount: 0 };
      state.yearly[year].revenue += revenue;
      state.yearly[year].transactionCount += 1;

      if (!state.monthly[monthKey]) state.monthly[monthKey] = { revenue: 0, transactionCount: 0 };
      state.monthly[monthKey].revenue += revenue;
      state.monthly[monthKey].transactionCount += 1;
    }
    if (oldestInBatch && (oldestSeen === null || oldestInBatch < oldestSeen)) oldestSeen = oldestInBatch;

    const reachedBeginning = offset === 0;
    const reachedRangeStart = oldestInBatch && oldestInBatch < rangeStart;
    cursor = offset;

    if (reachedBeginning || reachedRangeStart) {
      state.complete = true;
      state.cursor = null;
      break;
    }

    if (chunksFetched % 50 === 0) {
      state.cursor = cursor;
      await savePeriodTotalsState(state);
      console.log(
        `  ...historical totals: ${chunksFetched} chunks this run, back to ${oldestSeen ? oldestSeen.toISOString().slice(0, 10) : '?'} (checkpoint saved).`
      );
    }
  }

  if (!state.complete) {
    state.cursor = cursor;
    console.log(
      `Historical totals: stopped after ${chunksFetched} chunks this run, back to ` +
      `${oldestSeen ? oldestSeen.toISOString().slice(0, 10) : '?'} — not yet back to ${rangeStartStr}. ` +
      `Re-run the workflow with the same HISTORICAL_MONTHS input to continue from here.`
    );
  } else {
    console.log(`Historical totals: reached the full requested range (back to ${rangeStartStr}).`);
  }

  return state;
}

async function savePeriodTotalsState(state) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(PERIOD_TOTALS_STATE_FILE, JSON.stringify(state));
}

async function loadPeriodTotalsState() {
  const raw = await loadHistoryFile(PERIOD_TOTALS_STATE_FILE);
  return {
    yearly: raw.yearly || {},
    monthly: raw.monthly || {},
    cursor: raw.cursor === undefined ? null : raw.cursor,
    complete: !!raw.complete,
    rangeStartUsed: raw.rangeStartUsed || null,
  };
}

/**
 * Builds the dashboard-facing monthlyTotals array (most recent MONTHLY_VIEW_MAX_MONTHS
 * months — ROUND 22: 12, i.e. 1 year, so the report reads as a clean trailing-12-months
 * view) from the full accumulated period-totals state. Each entry also carries
 * yearAgoRevenue/yearAgoTransactionCount — looked up against the FULL state.monthly
 * map (not just the slice being returned), so the dashboard can show a real "vs same
 * month last year" per row without needing extra months exposed in the output just
 * to make that one lookup possible. Both are null only when that month-12-back key
 * doesn't exist in the full state — with the standard HISTORICAL_MONTHS=24 pull (2
 * years), that never happens for any of the 12 shown months: each shown month's
 * year-ago counterpart is 12-24 months back, still within a 24-month-deep pull, so
 * ROUND 22 gives every one of the 12 shown rows a genuine year-over-year figure
 * (only a shallower-than-recommended pull, e.g. HISTORICAL_MONTHS=12, would leave
 * these null).
 *
 * ROUND 21: this used to have a buildYearlyTotalsOutput() sibling for a Yearly view;
 * that view was dropped per the user's request to keep the report at Monthly-at-most
 * granularity, so only this one remains. periodState.yearly is still populated by
 * fetchHistoricalTotals() (harmless, essentially free bookkeeping from the same
 * walk) — it's just never read into the dashboard-facing output anymore.
 */
function buildMonthlyTotalsOutput(periodState) {
  const monthKeys = Object.keys(periodState.monthly).sort();
  const shown = monthKeys.slice(-MONTHLY_VIEW_MAX_MONTHS);
  return shown.map((monthKey) => {
    const m = periodState.monthly[monthKey];
    const [y, mo] = monthKey.split('-').map(Number);
    const yearAgoKey = `${y - 1}-${String(mo).padStart(2, '0')}`;
    const yearAgo = periodState.monthly[yearAgoKey] || null;
    return {
      month: monthKey,
      revenue: Math.round(m.revenue * 100) / 100,
      transactionCount: m.transactionCount,
      avgTicket: m.transactionCount > 0 ? Math.round((m.revenue / m.transactionCount) * 100) / 100 : 0,
      yearAgoRevenue: yearAgo ? Math.round(yearAgo.revenue * 100) / 100 : null,
      yearAgoTransactionCount: yearAgo ? yearAgo.transactionCount : null,
    };
  });
}

async function fetchLowStockItems(tokenManager, accountId) {
  const lowStock = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await apiGet(tokenManager, accountId, 'Item.json', [
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
async function fetchAllItems(tokenManager, accountId) {
  const items = [];
  let offset = 0;
  const limit = 100;
  const MAX_PAGES = 300; // safety cap: 30,000 items, far above any real catalog
  let pages = 0;
  let sampleLogged = false;

  while (pages < MAX_PAGES) {
    const page = await apiGet(tokenManager, accountId, 'Item.json', [
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
      // ROUND 23: normalized to proper case here, at the single point the
      // catalog enters the pipeline, so the products array, the table rows and
      // the filter dropdowns all read from the same normalized strings. Species
      // inference runs on the normalized text too — SPECIES_RULES are
      // case-insensitive, so this doesn't change what it matches.
      const name = toProperCase(item.description || '') || `Item #${item.itemID}`;
      const brand = toProperCase(itemBrand(item));
      const category = toProperCase(itemCategory(item));
      items.push({
        itemID: String(item.itemID),
        name,
        brand,
        category,
        species: inferSpecies(category, name),
        // ROUND 18: cost, for a real avgMarginPct instead of the previously-missing
        // field. avgCost (a rolling average of what was actually paid) is preferred
        // over defaultCost (the manually-set list cost) when both are present.
        cost: Number(item.avgCost || item.defaultCost || 0),
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

/**
 * ---------------------------------------------------------------------
 * ROUND 18 UPDATE: restored/completed the dashboard's other summary fields
 * ---------------------------------------------------------------------
 * The Round 14 rewrite of this function only ever computed totalRevenue,
 * transactionCount, and topItems — every other field the dashboard's hero
 * tiles and widgets read from data.json (avgTransactionValue, avgMarginPct,
 * avgUnitsPerTransaction, busiestHour, newCustomers/returningCustomers,
 * topBrands, revenueByCategory) was silently missing, which is why those
 * tiles were showing $0.00 / 0.0 / "—" once a real sync finally completed
 * end-to-end. This restores all of them using data already being pulled
 * (the item catalog, for brand/category/cost) plus one added Sale relation
 * (Customer, for the new-vs-returning heuristic below).
 *
 * @param {Array} sales - completed Sale records for the target date.
 * @param {Map<string, object>} catalogById - itemID -> catalog entry (name,
 * brand, category, cost), built from fetchAllItems()'s output.
 * @param {boolean} costDataAvailable - whether ANY item in the catalog has a
 * nonzero cost. Lightspeed returns "0" for cost whether it's genuinely zero
 * or simply never entered, and most real retail items are never truly free
 * to stock — so if every item comes back at 0 cost, this is treated as
 * "this account doesn't track item cost," and avgMarginPct is reported as
 * unavailable (null, shown as "—" on the dashboard) rather than a
 * meaningless "100% margin."
 */
function aggregate(sales, catalogById, costDataAvailable) {
  let totalRevenue = 0;
  let totalUnits = 0;
  let totalCost = 0;
  const transactionCount = sales.length;
  const itemRevenue = new Map();
  const brandRevenue = new Map();
  const categoryRevenue = new Map();
  const hourlyCounts = new Map(); // hour (0-23, STORE-LOCAL) -> transaction count
  const hourlyRevenue = new Map(); // hour (0-23, STORE-LOCAL) -> revenue — ROUND 20: added
  // alongside the existing count so the dashboard's Hourly view can show a real
  // revenue/avg-ticket pattern, not just transaction count.
  const seenCustomersToday = new Set();
  let newCustomers = 0;
  let returningCustomers = 0;

  for (const sale of sales) {
    const saleTotal = Number(sale.total || 0);
    totalRevenue += saleTotal;

    const saleDate = new Date(sale.timeStamp);
    // ROUND 23: store-local hour, so busiestHour and the Overview tab's
    // Hourly view describe the actual trading day rather than a UTC one.
    const saleLocal = storeLocalParts(saleDate);
    const hour = saleLocal.hour;
    hourlyCounts.set(hour, (hourlyCounts.get(hour) || 0) + 1);
    hourlyRevenue.set(hour, (hourlyRevenue.get(hour) || 0) + saleTotal);

    // New vs returning: a sale with no attached customer (walk-in, or the
    // account's generic customerID 0) counts toward transactionCount but
    // isn't attributable to a person, so it's excluded from both counts —
    // same treatment the dashboard's own "customers/day" tile expects.
    // For a sale that IS attached to a customer, "new" is a best-effort
    // proxy: the Customer record's own createTime falls on this same
    // calendar day. Lightspeed doesn't expose a direct "this was their
    // first-ever purchase" flag, so this is an assumption, not a
    // certainty — documented here the same way the species-inference
    // heuristic is documented above, in case it needs tuning later.
    const cust = sale.Customer;
    const custId = cust && cust.customerID ? String(cust.customerID) : null;
    if (custId && custId !== '0' && !seenCustomersToday.has(custId)) {
      seenCustomersToday.add(custId);
      // ROUND 23: both sides compared in store-local days, so a customer
      // created during a Pacific evening isn't read as a different day than
      // the sale that created them.
      const createdDateStr = cust.createTime ? storeLocalParts(new Date(cust.createTime)).dateStr : null;
      const saleDateStr = saleLocal.dateStr;
      if (createdDateStr && createdDateStr === saleDateStr) {
        newCustomers += 1;
      } else {
        returningCustomers += 1;
      }
    }

    const lines = Array.isArray(sale.SaleLines?.SaleLine)
      ? sale.SaleLines.SaleLine
      : sale.SaleLines?.SaleLine
      ? [sale.SaleLines.SaleLine]
      : [];

    for (const line of lines) {
      const itemId = String(line.itemID);
      const qty = Number(line.unitQuantity || 0);
      const lineTotal = Number(line.calcTotal || line.unitPrice * line.unitQuantity || 0);
      totalUnits += qty;

      const catalogItem = catalogById.get(itemId);
      const name = line.Item?.description || catalogItem?.name || `Item #${itemId}`;
      itemRevenue.set(name, (itemRevenue.get(name) || 0) + lineTotal);

      if (catalogItem) {
        brandRevenue.set(catalogItem.brand, (brandRevenue.get(catalogItem.brand) || 0) + lineTotal);
        categoryRevenue.set(catalogItem.category, (categoryRevenue.get(catalogItem.category) || 0) + lineTotal);
        totalCost += (catalogItem.cost || 0) * qty;
      }
    }
  }

  function topN(map, n) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }));
  }

  const topItems = topN(itemRevenue, 5);
  const topBrands = topN(brandRevenue, 5);
  const revenueByCategory = topN(categoryRevenue, 5);

  let busiestHour = null;
  let busiestHourCount = 0;
  const hourlyCountsArr = [];
  for (const [hour, count] of hourlyCounts.entries()) {
    hourlyCountsArr.push({ hour, count, revenue: Math.round((hourlyRevenue.get(hour) || 0) * 100) / 100 });
    if (count > busiestHourCount) {
      busiestHourCount = count;
      busiestHour = hour;
    }
  }
  hourlyCountsArr.sort((a, b) => a.hour - b.hour);

  const avgTransactionValue = transactionCount > 0 ? Math.round((totalRevenue / transactionCount) * 100) / 100 : 0;
  const avgUnitsPerTransaction = transactionCount > 0 ? Math.round((totalUnits / transactionCount) * 10) / 10 : 0;
  const avgMarginPct =
    costDataAvailable && totalRevenue > 0
      ? Math.round(((totalRevenue - totalCost) / totalRevenue) * 1000) / 10
      : null;

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    transactionCount,
    avgTransactionValue,
    avgUnitsPerTransaction,
    avgMarginPct,
    topItems,
    topBrands,
    revenueByCategory,
    hourlyCounts: hourlyCountsArr,
    busiestHour,
    busiestHourCount,
    newCustomers,
    returningCustomers,
  };
}

/**
 * Groups a list of Sale records into whole-store daily totals:
 * { 'YYYY-MM-DD': { revenue, transactionCount, cost, hourly: [{revenue,
 * transactionCount} x24] } }. This is the store-wide counterpart to
 * aggregatePerItemByDate() below — same per-day bucketing, just summed
 * across the whole store instead of per item — used to feed the
 * dashboard's "This Week's Performance" and Overview-tab daily view with
 * real dates and real figures instead of the static sample arrays those
 * used to run on entirely.
 *
 * ROUND 20: added the per-day `hourly` breakdown (24 buckets, one per
 * UTC hour) alongside the existing daily total — this is what lets the
 * dashboard's Hourly views (both "This Week" vs. the prior week, and the
 * Overview tab's today-vs-trailing-4-weeks) show a REAL hour-by-hour
 * pattern instead of the old fabricated shape, without any extra API
 * calls: it's computed from the exact same sales already being pulled
 * for the daily sync and for a BACKFILL_DAYS backfill.
 */
function aggregateDailyTotals(sales, catalogById) {
  const byDate = {};
  // Per-day customer sets, held aside so they can be counted into plain
  // numbers at the end (a Set doesn't survive JSON.stringify).
  const customersByDate = {};

  for (const sale of sales) {
    const saleDate = new Date(sale.timeStamp);
    // ROUND 23: store-local day and hour. Previously both were UTC, which put
    // every Pacific evening's sales on the following day and pushed the
    // trading day's hourly buckets past midnight. See STORE_TIMEZONE above.
    const { dateStr, hour } = storeLocalParts(saleDate);

    if (!byDate[dateStr]) {
      byDate[dateStr] = {
        revenue: 0,
        transactionCount: 0,
        cost: 0,
        hourly: Array.from({ length: 24 }, () => ({ revenue: 0, transactionCount: 0 })),
      };
      customersByDate[dateStr] = { all: new Set(), fresh: new Set() };
    }
    const day = byDate[dateStr];
    const saleTotal = Number(sale.total || 0);
    day.revenue += saleTotal;
    day.transactionCount += 1;
    day.hourly[hour].revenue += saleTotal;
    day.hourly[hour].transactionCount += 1;

    // ROUND 23: per-day customer counts, using the Customer relation that is
    // already being loaded for aggregate()'s new-vs-returning heuristic — so
    // this costs no extra API calls. Same best-effort proxy as aggregate():
    // a customer whose record was created on the day of the sale is treated
    // as new. Walk-in sales carry no customer record and are simply not
    // counted, so these are "identified customers", not footfall.
    const customer = sale.Customer;
    const customerId = customer && customer.customerID ? String(customer.customerID) : null;
    if (customerId && customerId !== '0') {
      const bucket = customersByDate[dateStr];
      bucket.all.add(String(customerId));
      const created = customer.createTime ? new Date(customer.createTime) : null;
      if (created && !Number.isNaN(created.getTime()) && storeLocalParts(created).dateStr === dateStr) {
        bucket.fresh.add(String(customerId));
      }
    }

    const lines = Array.isArray(sale.SaleLines?.SaleLine)
      ? sale.SaleLines.SaleLine
      : sale.SaleLines?.SaleLine
      ? [sale.SaleLines.SaleLine]
      : [];
    for (const line of lines) {
      const catalogItem = catalogById.get(String(line.itemID));
      if (catalogItem) {
        const qty = Number(line.unitQuantity || 0);
        day.cost += (catalogItem.cost || 0) * qty;
      }
    }
  }

  for (const [dateStr, bucket] of Object.entries(customersByDate)) {
    byDate[dateStr].customerCount = bucket.all.size;
    byDate[dateStr].newCustomerCount = bucket.fresh.size;
    byDate[dateStr].returningCustomerCount = bucket.all.size - bucket.fresh.size;
  }

  return byDate;
}

/**
 * Groups a list of Sale records (any date range) into a per-day,
 * per-item units/revenue map: { 'YYYY-MM-DD': { itemID: { qty, revenue } } }.
 * Used to update the rolling product-sales-history.json file.
 */
function aggregatePerItemByDate(sales) {
  const byDate = {};
  for (const sale of sales) {
    // ROUND 23: store-local day, matching aggregateDailyTotals() above — the
    // two history files must agree on which day a sale belongs to.
    const dateStr = storeLocalParts(new Date(sale.timeStamp)).dateStr;
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

async function loadHistoryFile(filePath) {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.warn(`Could not read ${filePath} (${err.message}) — starting a fresh history.`);
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

  // Report on "yesterday" since the job runs once daily, typically early
  // morning, and the full previous day is what's fully closed out.
  //
  // ROUND 23: "yesterday" is now the store's own previous calendar day, not
  // the previous UTC day. The cron fires at 07:00 UTC, which is midnight
  // Pacific — so under the old UTC logic the script asked for a day that had
  // only just ended in one timezone and not the other, and then bucketed the
  // results into UTC days on top of that.
  const now = new Date();
  const targetDateStr = shiftDateStr(storeLocalParts(now).dateStr, -1);

  console.log(`Syncing Lightspeed data for ${targetDateStr} (store timezone: ${STORE_TIMEZONE})...`);

  const tokenManager = createTokenManager(await refreshAccessToken());
  const sales = await fetchSalesForDate(tokenManager, accountId, targetDateStr);
  const lowStock = await fetchLowStockItems(tokenManager, accountId);

  console.log('Fetching full item catalog (brand/category/cost)...');
  const catalog = await fetchAllItems(tokenManager, accountId);
  console.log(`Catalog: ${catalog.length} active items across ${new Set(catalog.map((i) => i.brand)).size} brands.`);
  const catalogById = new Map(catalog.map((item) => [item.itemID, item]));

  const costDataAvailable = catalog.some((item) => item.cost > 0);
  if (!costDataAvailable) {
    console.warn(
      'No items in the catalog have a nonzero cost (avgCost/defaultCost) — this Lightspeed ' +
      'account doesn\'t appear to have item cost data entered, so avgMarginPct will report as ' +
      'unavailable ("—" on the dashboard) rather than a misleading number. Enter item costs in ' +
      'Lightspeed to enable real margin tracking.'
    );
  }

  // ROUND 18: aggregate() now needs the catalog (brand/category/cost lookups),
  // so this runs after fetchAllItems() rather than right after fetchSalesForDate().
  const summary = aggregate(sales, catalogById, costDataAvailable);

  let history = await loadHistoryFile(HISTORY_FILE);
  let storeHistory = await loadHistoryFile(STORE_HISTORY_FILE);

  if (BACKFILL_DAYS > 0) {
    console.log(`Backfill requested: pulling the ${BACKFILL_DAYS} days before ${targetDateStr}. This can take a while...`);
    // ROUND 23: both ends are store-local midnights, so the backfill covers
    // whole trading days and lines up exactly with the daily sync's window.
    const targetStart = storeLocalMidnightUtc(targetDateStr);
    const backfillStart = storeLocalMidnightUtc(shiftDateStr(targetDateStr, -BACKFILL_DAYS));
    const backfillSales = await fetchSalesForDateRange(tokenManager, accountId, backfillStart, targetStart, BACKFILL_MAX_CHUNKS);
    console.log(`Backfill pulled ${backfillSales.length} sales across ${BACKFILL_DAYS} days.`);
    history = mergeHistory(history, aggregatePerItemByDate(backfillSales));
    storeHistory = mergeHistory(storeHistory, aggregateDailyTotals(backfillSales, catalogById));
  }

  // Always merge in yesterday's sales too (reusing the fetch already done
  // above for the existing totalRevenue/transactionCount summary).
  history = mergeHistory(history, aggregatePerItemByDate(sales));
  history = pruneHistory(history, targetDateStr);
  storeHistory = mergeHistory(storeHistory, aggregateDailyTotals(sales, catalogById));
  storeHistory = pruneHistory(storeHistory, targetDateStr);

  const products = computeProductStats(history, catalog);

  const dailyTotals = Object.keys(storeHistory)
    .sort()
    .map((date) => {
      const day = storeHistory[date];
      const revenue = Math.round(day.revenue * 100) / 100;
      const transactionCount = day.transactionCount;
      return {
        date,
        revenue,
        transactionCount,
        avgTicket: transactionCount > 0 ? Math.round((revenue / transactionCount) * 100) / 100 : 0,
        marginPct:
          costDataAvailable && revenue > 0
            ? Math.round(((revenue - day.cost) / revenue) * 1000) / 10
            : null,
        // ROUND 23: real per-day identified-customer counts, so the dashboard's
        // "Customers" metric can stop running on a sample array at the daily and
        // weekly grain. null (not 0) on days recorded before this shipped, so
        // the frontend can tell "no customers that day" apart from "this day
        // predates customer tracking" and show an honest dash for the latter.
        customerCount: day.customerCount ?? null,
        newCustomerCount: day.newCustomerCount ?? null,
        returningCustomerCount: day.returningCustomerCount ?? null,
        // ROUND 20: real per-hour breakdown for this day, rounded for the same
        // reason everything else here is — feeds the dashboard's real Hourly
        // views (see aggregateDailyTotals()'s comment).
        hourly: (day.hourly || []).map((h) => ({
          revenue: Math.round(h.revenue * 100) / 100,
          transactionCount: h.transactionCount,
        })),
      };
    });

  // ROUND 20: trailing-N-day average per hour, real counterpart to the old
  // fabricated HOURLY_WINDOW_DATA sample — averages whatever of the most
  // recent HOURLY_TRAILING_DAYS real days actually have hourly data (which,
  // right after this ships, may be fewer than HOURLY_TRAILING_DAYS; it grows
  // in day by day, same as everything else here).
  const recentDaysWithHourly = dailyTotals.slice(-HOURLY_TRAILING_DAYS).filter((d) => Array.isArray(d.hourly) && d.hourly.length === 24);
  let hourlyTrailingAvg = [];
  if (recentDaysWithHourly.length >= 7) {
    // Require at least a week of real days before showing a "trailing average" —
    // averaging over just 1-2 days isn't a meaningful baseline to compare "today" against.
    hourlyTrailingAvg = Array.from({ length: 24 }, (_, hour) => {
      const revenueSum = recentDaysWithHourly.reduce((sum, d) => sum + d.hourly[hour].revenue, 0);
      const txnSum = recentDaysWithHourly.reduce((sum, d) => sum + d.hourly[hour].transactionCount, 0);
      const n = recentDaysWithHourly.length;
      return {
        hour,
        avgRevenue: Math.round((revenueSum / n) * 100) / 100,
        avgTransactionCount: Math.round((txnSum / n) * 10) / 10,
      };
    });
  }

  // ROUND 20/21: real Monthly totals (up to 24 months / 2 years), opt-in via
  // HISTORICAL_MONTHS (see fetchHistoricalTotals()'s comment above main()). The
  // Yearly view was dropped entirely (Round 21) — the report now goes no deeper
  // than Monthly.
  let monthlyTotals = [];
  if (HISTORICAL_MONTHS > 0) {
    // ROUND 23: store-local midnight, for consistency with every other range
    // boundary in this script. The walk still deliberately overshoots this
    // start by up to one chunk, so a few hours either way changes nothing.
    const rangeStartNaive = new Date(`${targetDateStr}T00:00:00Z`);
    rangeStartNaive.setUTCMonth(rangeStartNaive.getUTCMonth() - Math.max(HISTORICAL_MONTHS, 1));
    const rangeStart = storeLocalMidnightUtc(rangeStartNaive.toISOString().slice(0, 10));

    let periodState = await loadPeriodTotalsState();
    periodState = await fetchHistoricalTotals(tokenManager, accountId, rangeStart, HISTORICAL_MAX_CHUNKS, periodState);
    await savePeriodTotalsState(periodState);

    monthlyTotals = buildMonthlyTotalsOutput(periodState);
  } else {
    // Even when no historical pull is requested this run, surface whatever a
    // PRIOR run already accumulated into period-totals-state.json, so the
    // dashboard keeps showing real Monthly data on every normal daily run
    // rather than only on the (heavy, occasional) historical-pull runs.
    const periodState = await loadPeriodTotalsState();
    if (Object.keys(periodState.monthly).length) {
      monthlyTotals = buildMonthlyTotalsOutput(periodState);
    }
  }

  const output = {
    generatedAt: now.toISOString(),
    reportDate: targetDateStr,
    ...summary,
    lowStockItems: lowStock,
    products,
    dailyTotals,
    hourlyTrailingAvg,
    monthlyTotals,
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('public', { recursive: true });
  await fs.writeFile('public/data.json', JSON.stringify(output, null, 2));
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history));
  await fs.writeFile(STORE_HISTORY_FILE, JSON.stringify(storeHistory));

  console.log(
    `Wrote public/data.json (${products.length} products, ${dailyTotals.length} days of daily totals, ` +
    `${monthlyTotals.length} months of period totals), ` +
    `${HISTORY_FILE} (${Object.keys(history).length} days of per-item history), and ` +
    `${STORE_HISTORY_FILE} (${Object.keys(storeHistory).length} days of store-wide history).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
