/**
 * HTTP entry point for `GET_CLP` -- the Web App counterpart to
 * `interfaces/index.js`'s bound macro. Split into its own file by SRP:
 * "macro triggered manually from a menu" and "public HTTP API" are
 * different reasons to change, not just a way to dodge a line-count
 * limit (see AGENTS.md / plan-get-clp-01-webapp.md Fase 2).
 *
 * A `doGet` invocation runs as a genuinely separate execution from
 * whatever custom function called it via `UrlFetchApp.fetch(...)` -- that
 * separation is *why* this design works at all: a custom function's own
 * sandbox forbids `SpreadsheetApp.openById()`/`openByUrl()` outright (see
 * plan-get-clp-01-webapp.md, Fase 1.5), but this file isn't running inside
 * that sandbox, so it can use `openById()` freely.
 *
 * Like `interfaces/index.js`, this is one of the few files allowed to
 * reference bare Apps Script globals (SpreadsheetApp, PropertiesService,
 * ContentService, CacheService) directly, and calls domain/infrastructure
 * functions by bare name relying on Apps Script's single flat
 * concatenated scope (see AGENTS.md). Not unit-tested here for the same
 * reason `index.js` isn't: faking every global involved for a handful of
 * branches has little signal over running it end-to-end against the real
 * deployment -- `domain/` and `infrastructure/` carry the real test
 * coverage this delegates to.
 */

// The central spreadsheet this container-bound project already lives in
// (see docs/getting-started.md) -- hardcoded, not a Script Property,
// because it's a structural constant of this project (like
// VALUES_SHEET_NAME in interfaces/index.js), not something expected to
// ever point elsewhere. SpreadsheetApp.getActiveSpreadsheet() is
// deliberately not used here even though the script is bound to this
// exact spreadsheet -- it depends on an active UI session that a Web App
// HTTP request never has, bound or not (same reason interfaces/index.js
// avoids it for updateExchangeRates' triggered runs).
var GET_CLP_SPREADSHEET_ID = "1WLAE02oOJlDjLwQ4aS-ranKLNgV2bVuAt9L96m7-8DA";

/**
 * @param {string} text
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function respondPlainText(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Serves GET_CLP over HTTP: `?date=YYYY-MM-DD&code=USD&key=...`.
 * Always responds 200 with a plain-text body -- either the numeric value
 * or one of the fixed error strings below -- so the calling custom
 * function (Fase 4) always has something clean to show in a cell instead
 * of a broken formula.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  var params = (e && e.parameter) || {};

  var expectedKey = getGetClpApiKey(PropertiesService);
  if (!expectedKey || params.key !== expectedKey) {
    return respondPlainText("Unauthorized");
  }

  if (!params.date || !params.code) {
    return respondPlainText("Missing parameters");
  }

  var spreadsheet = SpreadsheetApp.openById(GET_CLP_SPREADSHEET_ID);
  var timeZone = spreadsheet.getSpreadsheetTimeZone();

  // Normalize once, up front, so the cache key is stable regardless of
  // input casing/whitespace/alias ("uf" and "UF" -- stored as "CLF" --
  // must hit the same cache entry). findRateValue re-applies both
  // normalizations internally, but they're idempotent, so passing
  // already-normalized values through it again is a no-op, not a bug.
  var normalizedCode = applySheetCodeAlias(params.code);
  var normalizedDate = normalizeDateKey(params.date, timeZone);
  var cacheKey = normalizedCode + "|" + normalizedDate;

  var cachedValue = getCachedRateValue(CacheService, cacheKey);
  if (cachedValue !== null) {
    return respondPlainText(String(cachedValue));
  }

  var sheet = spreadsheet.getSheetByName(VALUES_SHEET_NAME);
  if (!sheet) {
    console.error('Sheet tab "' + VALUES_SHEET_NAME + '" was not found in the central spreadsheet.');
    return respondPlainText("Not found");
  }

  var accessor = createSheetRowAccessor(sheet);
  var value = findRateValue(accessor, normalizedCode, normalizedDate, timeZone);
  if (value === null) {
    return respondPlainText("Not found");
  }

  cacheRateValue(CacheService, cacheKey, value);
  return respondPlainText(String(value));
}

// Max (code, date) pairs accepted per GET_CLP_RANGE request. Generous
// relative to the problem that motivated this endpoint (108 cells today,
// +24/year in "(05) Payroll" -- see plan-get-clp-02-range-batch.md), while
// still bounding how much of the ~30k-row VALUES sheet a single request
// can scan through on a full cache miss.
var GET_CLP_RANGE_MAX_PAIRS = 500;

/**
 * @param {*} payload JSON-serializable value
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function respondJson(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Serves GET_CLP_RANGE over HTTP -- the batch counterpart to doGet, so a
 * burst of many cells recalculating together (see
 * plan-get-clp-02-range-batch.md, "(05) Payroll": 108+ cells) pays for
 * ONE HTTP round trip and ONE doPost invocation instead of one doGet per
 * cell. `key` stays a query param (`?key=...`), same as doGet -- only the
 * pairs themselves move into a JSON POST body, since 100+ date/code pairs
 * would blow past a GET URL's practical length limit.
 *
 * Request body: `{"pairs": [{"date": "...", "code": "..."}, ...]}`.
 * Response body: a JSON array, same length/order as `pairs`, where each
 * element is either a number (successful lookup) or one of doGet's own
 * fixed strings (`"Not found"`, `"Missing parameters"`) -- one bad pair
 * never fails the whole batch. Request-level failures (bad key, malformed
 * body, empty/oversized batch) respond with `{"error": "..."}` instead of
 * an array, since there's no per-pair result to report in those cases.
 *
 * Per-pair caching mirrors doGet exactly (same `code|date` cache key, see
 * getCachedRateValue/cacheRateValue) so a partially-repeated batch, or one
 * that overlaps with prior single GET_CLP calls, only ever touches the
 * Sheet for genuine misses -- resolved in one call to findRateValues
 * (domain/) rather than looping calls to findRateValue one at a time.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var params = (e && e.parameter) || {};

  var expectedKey = getGetClpApiKey(PropertiesService);
  if (!expectedKey || params.key !== expectedKey) {
    return respondJson({ error: "Unauthorized" });
  }

  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch {
    return respondJson({ error: "Invalid JSON body" });
  }

  var pairs = body.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return respondJson({ error: "Missing parameters" });
  }
  if (pairs.length > GET_CLP_RANGE_MAX_PAIRS) {
    return respondJson({ error: "Batch too large (max " + GET_CLP_RANGE_MAX_PAIRS + " pairs)" });
  }

  var spreadsheet = SpreadsheetApp.openById(GET_CLP_SPREADSHEET_ID);
  var timeZone = spreadsheet.getSpreadsheetTimeZone();
  var sheet = spreadsheet.getSheetByName(VALUES_SHEET_NAME);
  if (!sheet) {
    console.error('Sheet tab "' + VALUES_SHEET_NAME + '" was not found in the central spreadsheet.');
  }
  var accessor = sheet ? createSheetRowAccessor(sheet) : null;

  var normalizedPairs = pairs.map(function (pair) {
    var rawCode = pair && pair.code;
    var rawDate = pair && pair.date;
    if (!rawCode || !rawDate) {
      return null;
    }
    return { code: applySheetCodeAlias(rawCode), date: normalizeDateKey(rawDate, timeZone) };
  });

  var results = new Array(pairs.length);
  var missIndexes = [];
  var missPairs = [];

  normalizedPairs.forEach(function (normalizedPair, index) {
    if (!normalizedPair) {
      results[index] = "Missing parameters";
      return;
    }
    var cacheKey = normalizedPair.code + "|" + normalizedPair.date;
    var cachedValue = getCachedRateValue(CacheService, cacheKey);
    if (cachedValue !== null) {
      results[index] = cachedValue;
      return;
    }
    missIndexes.push(index);
    missPairs.push(normalizedPair);
  });

  if (missPairs.length > 0 && accessor) {
    var resolvedValues = findRateValues(accessor, missPairs, timeZone);
    resolvedValues.forEach(function (value, i) {
      var index = missIndexes[i];
      if (value === null) {
        results[index] = "Not found";
        return;
      }
      results[index] = value;
      cacheRateValue(CacheService, missPairs[i].code + "|" + missPairs[i].date, value);
    });
  } else {
    missIndexes.forEach(function (index) {
      results[index] = "Not found";
    });
  }

  return respondJson(results);
}

if (typeof module !== "undefined") {
  module.exports = { doGet: doGet, doPost: doPost, respondPlainText: respondPlainText, respondJson: respondJson };
}
