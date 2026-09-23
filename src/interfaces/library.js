/**
 * Public Apps Script Library surface for GET_CLP / GET_CLP_RANGE -- lets
 * other Apps Script projects (Payroll, MedicalRefund, ...) call these as
 * `<LibraryIdentifier>.GET_CLP(...)` / `.GET_CLP_RANGE(...)` from a tiny
 * @customfunction wrapper defined in their own bound script, instead of
 * every consumer hand-pasting this whole file's logic (see
 * plan-get-clp-02-range-batch.md, "Punto 2" -- Apps Script custom
 * functions must be top-level in the CALLING project; `=Lib.GET_CLP(...)`
 * directly from a cell is not supported, confirmed in
 * plan-get-clp-01-webapp.md's Fase 1.5 spike -- so the wrapper can't be
 * skipped, but it's now 3 lines instead of this entire file).
 *
 * Publishing this as a Library does NOT change how GET_CLP/GET_CLP_RANGE
 * actually get their data: they still go through the Web App
 * (`doGet`/`doPost` in webapp.js) over UrlFetchApp. Library code executes
 * inside the SAME sandboxed call stack as whatever custom function
 * invoked it (confirmed in plan-get-clp-01-webapp.md's Fase 1.5), so
 * `SpreadsheetApp.openById()`/`openByUrl()` stay forbidden here exactly
 * like they would in the consumer's own script -- only the transport-
 * agnostic client logic (retry/backoff, request building, response
 * parsing) is centralized here.
 *
 * IMPORTANT -- Apps Script Library visibility rule: any top-level
 * function/var NOT ending in "_" is exposed to consuming scripts.
 * GET_CLP and GET_CLP_RANGE are deliberately public (no trailing
 * underscore); every helper below is deliberately private (trailing
 * underscore) -- consumers only ever need the two public functions.
 *
 * PropertiesService.getScriptProperties() and
 * SpreadsheetApp.getActiveSpreadsheet() below resolve to the CALLING
 * project's own properties/spreadsheet, not this library project's --
 * standard Apps Script Library semantics, and exactly what keeps each
 * consumer's own GET_CLP_API_KEY and own time zone correctly scoped
 * without this file ever knowing which consumer is calling.
 *
 * Not unit-tested here, same rationale as doGet/doPost in webapp.js --
 * this is the one other file (besides index.js and webapp.js) allowed to
 * reference bare Apps Script globals directly; validated end-to-end
 * against a real consumer, not with faked globals. See
 * tests/interfaces.test.js for the smoke test.
 */

var GET_CLP_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec";

// Custom functions get killed by the platform at 30s, full stop (see
// plan-get-clp-01-webapp.md's Fase 1.5) -- budgeting retries to this
// ceiling means GET_CLP/GET_CLP_RANGE give up on their OWN terms (a
// clean, throwable, IFERROR-catchable error) well before Google's
// platform forcibly kills the whole execution.
var GET_CLP_MAX_RETRY_BUDGET_MILLIS_ = 25000;

/**
 * Safe cross-realm replacement for `value instanceof Date`. Every Apps
 * Script project runs in its own V8 "realm" with its own Date
 * constructor; a Date built in a CONSUMING project (Payroll,
 * MedicalRefund) and passed as an argument into this Library's public
 * functions fails `instanceof Date` here even though it genuinely is a
 * Date -- the classic cross-realm instanceof gotcha (same root cause as
 * `instanceof Array` failing across iframes in a browser). Confirmed as
 * the root cause of the "Not found" incident in
 * plan-get-clp-02-range-batch.md: the broken branch silently fell back to
 * `String(date)` (e.g. "Mon Jan 15 2024 00:00:00 GMT-0300 ...") instead
 * of formatting to "yyyy-MM-dd", so no lookup ever matched.
 * `Object.prototype.toString.call(...)` reads the internal `[[Class]]`
 * tag instead of walking the prototype chain, so it stays correct across
 * realm boundaries.
 * @param {*} value
 * @return {boolean}
 */
function isDateValue_(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}

/**
 * Looks up a single CLP value from the shared financial-data spreadsheet.
 * Usage (from a consumer's own wrapper): =GET_CLP(DATE(2026,9,15), "USD")
 * @param {Date|string} date
 * @param {string} code e.g. "USD", "EUR", "UF", "UTM", "IPC_CL"
 * @return {number|string} the CLP value, or "Unauthorized" /
 *   "Missing parameters" for real misconfigurations (returned as plain
 *   text on purpose, so IFERROR does not silently swallow them).
 * @throws {Error} "Not found" when there's no data for that (code, date)
 *   yet -- thrown, not returned, so IFERROR(GET_CLP(...), ...) can catch
 *   just this one recoverable case. Also throws "Unexpected response"
 *   after exhausting retries against a Web App infra glitch under burst
 *   load (see fetchGetClpResponseWithRetries_ below).
 */
function GET_CLP(date, code) {
  // Formatted using the CALLING spreadsheet's own time zone -- a custom
  // function genuinely does have an active bound spreadsheet, and this
  // reconstructs "the calendar day the user actually typed into the
  // cell", regardless of what time zone the central spreadsheet uses.
  var dateParam =
    isDateValue_(date)
      ? Utilities.formatDate(date, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd")
      : String(date);

  var apiKey = PropertiesService.getScriptProperties().getProperty("GET_CLP_API_KEY");
  var url =
    GET_CLP_WEB_APP_URL +
    "?date=" + encodeURIComponent(dateParam) +
    "&code=" + encodeURIComponent(code) +
    "&key=" + encodeURIComponent(apiKey || "");

  var text = fetchGetClpResponseWithRetries_(url);
  var value = parseFloat(text);

  if (!isNaN(value)) {
    return value;
  }
  if (text === "Not found") {
    throw new Error("Not found");
  }
  if (text === "Unauthorized" || text === "Missing parameters") {
    return text;
  }
  // Neither a number nor one of doGet's own fixed strings, even after
  // retries -- almost certainly Google's Web App redirect infrastructure
  // glitching under a burst of concurrent calls (confirmed via the
  // Executions log in a real incident, not guessed -- see
  // plan-get-clp-02-range-batch.md).
  throw new Error("Unexpected response");
}

/**
 * Retries a GET_CLP Web App call up to 3 times with a short backoff,
 * time-budget aware so it never blindly retries past the platform's own
 * 30s custom-function ceiling (see GET_CLP_MAX_RETRY_BUDGET_MILLIS_).
 * @param {string} url
 * @return {string} the raw response body from the last attempt
 */
function fetchGetClpResponseWithRetries_(url) {
  var maxAttempts = 3;
  var startedAt = Date.now();
  var lastText = "";
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && Date.now() - startedAt > GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
      break;
    }
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    lastText = response.getContentText();
    if (isRecognizedGetClpResponse_(lastText)) {
      return lastText;
    }
    if (attempt < maxAttempts && Date.now() - startedAt < GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
      Utilities.sleep(300 * attempt); // 300ms, then 600ms
    }
  }
  return lastText;
}

/**
 * @param {string} text
 * @return {boolean}
 */
function isRecognizedGetClpResponse_(text) {
  if (text === "Unauthorized" || text === "Missing parameters" || text === "Not found") {
    return true;
  }
  return !isNaN(parseFloat(text));
}

/**
 * Batch counterpart to GET_CLP for many cells recalculating together (see
 * plan-get-clp-02-range-batch.md). `dates` and `codes` can each be either
 * a range (one value per row) or a single constant reused for every row
 * -- whichever matches how the consuming sheet is actually laid out
 * (e.g. "(05) Payroll": a range of dates, and a range of codes where
 * every cell happens to hold the same code -- still a real range, not a
 * hardcoded literal; either form works). At least one of the two must be
 * a range, so the batch knows how many rows to resolve.
 *
 * Usage (from a consumer's own wrapper):
 *   =GET_CLP_RANGE(A1:A54, B1:B54)      -- both vary per row
 *   =GET_CLP_RANGE($D$7:$D$60, "USD")   -- codes fixed, dates vary
 * @param {Array<Array<Date|string>>|Date|string} dates a single-column
 *   range, or one date reused for every row
 * @param {Array<Array<string>>|string} codes a single-column range, or
 *   one code reused for every row
 * @return {Array<Array<number|string>>} one row per resolved pair, same
 *   order as the range argument(s)
 */
function GET_CLP_RANGE(dates, codes) {
  var datesIsRange = Array.isArray(dates);
  var codesIsRange = Array.isArray(codes);

  if (!datesIsRange && !codesIsRange) {
    return [["Missing parameters"]];
  }
  if (datesIsRange && codesIsRange && dates.length !== codes.length) {
    return [["Mismatched range sizes"]];
  }

  var rowCount = datesIsRange ? dates.length : codes.length;
  var timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  var pairs = [];
  for (var i = 0; i < rowCount; i++) {
    var rawDate = datesIsRange ? dates[i][0] : dates;
    var rawCode = codesIsRange ? codes[i][0] : codes;
    var dateParam =
      isDateValue_(rawDate) ? Utilities.formatDate(rawDate, timeZone, "yyyy-MM-dd") : String(rawDate);
    pairs.push({ date: dateParam, code: String(rawCode) });
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty("GET_CLP_API_KEY");
  var url = GET_CLP_WEB_APP_URL + "?key=" + encodeURIComponent(apiKey || "");

  var responseText = fetchGetClpRangeResponseWithRetries_(url, pairs);
  var parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Unexpected response");
  }

  if (!Array.isArray(parsed)) {
    // {"error": "..."} shape -- a batch-level failure (auth, malformed
    // body, empty/oversized pairs), not a per-row result.
    throw new Error((parsed && parsed.error) || "Unexpected response");
  }

  return parsed.map(function (value) {
    return [value];
  });
}

/**
 * Same rationale/pattern as fetchGetClpResponseWithRetries_ above,
 * adapted for a POST request carrying the batch payload instead of a GET
 * query string, and "recognized" meaning "valid JSON" (a batch-level
 * {"error"} object still counts -- GET_CLP_RANGE decides what to do with
 * it above; this helper's only job is not retrying on a genuinely
 * garbled response).
 * @param {string} url
 * @param {Array<{date: string, code: string}>} pairs
 * @return {string} the raw response body from the last attempt
 */
function fetchGetClpRangeResponseWithRetries_(url, pairs) {
  var maxAttempts = 3;
  var startedAt = Date.now();
  var lastText = "";
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ pairs: pairs }),
    muteHttpExceptions: true,
  };
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && Date.now() - startedAt > GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
      break;
    }
    var response = UrlFetchApp.fetch(url, options);
    lastText = response.getContentText();
    if (isRecognizedGetClpRangeResponse_(lastText)) {
      return lastText;
    }
    if (attempt < maxAttempts && Date.now() - startedAt < GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
      Utilities.sleep(300 * attempt);
    }
  }
  return lastText;
}

/**
 * @param {string} text
 * @return {boolean}
 */
function isRecognizedGetClpRangeResponse_(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

if (typeof module !== "undefined") {
  module.exports = { GET_CLP: GET_CLP, GET_CLP_RANGE: GET_CLP_RANGE, isDateValue_: isDateValue_ };
}
