/**
 * HTTP entry point for `GET_CLP` -- the Web App counterpart to
 * `interfaces/index.js`'s bound macro. Split into its own file by SRP:
 * "macro triggered manually from a menu" and "public HTTP API" are
 * different reasons to change, not just a way to dodge a line-count
 * limit (see AGENTS.md / plan-get-clp-webapp.md Fase 2).
 *
 * A `doGet` invocation runs as a genuinely separate execution from
 * whatever custom function called it via `UrlFetchApp.fetch(...)` -- that
 * separation is *why* this design works at all: a custom function's own
 * sandbox forbids `SpreadsheetApp.openById()`/`openByUrl()` outright (see
 * plan-get-clp-webapp.md, Fase 1.5), but this file isn't running inside
 * that sandbox, so it can use `openById()` freely.
 *
 * Like `interfaces/index.js`, this is one of the few files allowed to
 * reference bare Apps Script globals (SpreadsheetApp, PropertiesService,
 * ContentService) directly, and calls domain/infrastructure functions by
 * bare name relying on Apps Script's single flat concatenated scope (see
 * AGENTS.md). Not unit-tested here for the same reason `index.js` isn't:
 * faking every global involved for a handful of branches has little
 * signal over running it end-to-end against the real deployment --
 * `domain/` and `infrastructure/` carry the real test coverage this
 * delegates to.
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
  var sheet = spreadsheet.getSheetByName(VALUES_SHEET_NAME);
  if (!sheet) {
    console.error('Sheet tab "' + VALUES_SHEET_NAME + '" was not found in the central spreadsheet.');
    return respondPlainText("Not found");
  }

  var accessor = createSheetRowAccessor(sheet);
  var value = findRateValue(accessor, params.code, params.date, spreadsheet.getSpreadsheetTimeZone());
  if (value === null) {
    return respondPlainText("Not found");
  }

  return respondPlainText(String(value));
}

if (typeof module !== "undefined") {
  module.exports = { doGet: doGet, respondPlainText: respondPlainText };
}
