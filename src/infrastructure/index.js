/**
 * Adapters over Google Apps Script's global services. Every function here
 * takes the relevant global (SpreadsheetApp, DriveApp, UrlFetchApp,
 * PropertiesService, Utilities) as an explicit parameter instead of
 * referencing it directly — that's what lets these be unit-tested with
 * plain fakes in Jest, with zero Apps Script runtime involved.
 *
 * `src/interfaces/index.js` is the only place that passes the *real*
 * globals in; every function here stays agnostic of where they came from.
 */

/**
 * Reads pf-sheets configuration from Script Properties. Replaces the
 * previously hardcoded API key / Drive file ID.
 * @param {GoogleAppsScript.Properties.PropertiesService} propertiesService
 * @returns {{apiBaseUrl: string, apiKey: string, driveFileId: string}}
 */
function getConfig(propertiesService) {
  var properties = propertiesService.getScriptProperties();
  return {
    apiBaseUrl: properties.getProperty("PF_RATES_BASE_URL"),
    apiKey: properties.getProperty("PF_RATES_API_KEY"),
    driveFileId: properties.getProperty("EXPORT_DRIVE_FILE_ID"),
  };
}

/**
 * Triggers the pf-rates combined financial-data export endpoint
 * (fire-and-report -- the caller decides what to do with a failed/erroring
 * call). Covers both exchange rates and economic indices in one CSV; see
 * pf-rates/docs/api.md#export-combined-exchange-rate--economic-index-data-to-google-drive.
 * @param {GoogleAppsScript.URL_Fetch.UrlFetchApp} urlFetchApp
 * @param {{apiBaseUrl: string, apiKey: string}} config
 * @param {{lookback_days: number, forward_days: number}} payload
 * @returns {{statusCode: number, body: string}}
 */
function triggerFinancialDataExport(urlFetchApp, config, payload) {
  var requestOptions = {
    method: "post",
    contentType: "application/json",
    headers: { "X-API-Key": config.apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = urlFetchApp.fetch(config.apiBaseUrl + "/exports/financial-data", requestOptions);
  return {
    statusCode: response.getResponseCode(),
    body: response.getContentText(),
  };
}

/**
 * Downloads and parses the exported CSV from Google Drive.
 * @param {GoogleAppsScript.Drive.DriveApp} driveApp
 * @param {GoogleAppsScript.Utilities.Utilities} utilities
 * @param {string} fileId
 * @returns {string[][]} parsed CSV rows, header included
 */
function fetchCsvRows(driveApp, utilities, fileId) {
  var file = driveApp.getFileById(fileId);
  var content = file.getBlob().getDataAsString("UTF-8");
  return utilities.parseCsv(content);
}

/**
 * Reads the current data rows (excluding the header) of a sheet, assuming
 * the shared 5-column financial-data layout used by the VALUES tab:
 * id, code, date, value, last_modified_at -- by column position, not by
 * header text. The header row (row 1) is never read; whatever label a
 * human types there (e.g. "Last Modified") is purely decorative and can
 * be changed freely without touching this function.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array<Array<*>>}
 */
function readExistingRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }
  return sheet.getRange(2, 1, lastRow - 1, 5).getValues();
}

/**
 * Writes the full set of rows back to the sheet grid and formats the
 * last_modified_at column.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<Array<*>>} rows
 */
function writeRows(sheet, rows) {
  if (rows.length === 0) {
    return;
  }
  sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  sheet.getRange(2, 5, rows.length, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}

/**
 * @param {GoogleAppsScript.Spreadsheet.SpreadsheetApp} spreadsheetApp
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getActiveSpreadsheet(spreadsheetApp) {
  return spreadsheetApp.getActiveSpreadsheet();
}

/**
 * @param {GoogleAppsScript.Spreadsheet.SpreadsheetApp} spreadsheetApp
 * @param {string} message
 */
function showAlert(spreadsheetApp, message) {
  spreadsheetApp.getUi().alert(message);
}

/**
 * Reads the shared secret GET_CLP's Web App endpoint compares the
 * caller-supplied `key` query param against. Kept separate from
 * `getConfig` (which covers the unrelated pf-rates sync config) --
 * this key protects a different, unrelated capability.
 * @param {GoogleAppsScript.Properties.PropertiesService} propertiesService
 * @returns {string|null}
 */
function getGetClpApiKey(propertiesService) {
  return propertiesService.getScriptProperties().getProperty("GET_CLP_API_KEY");
}

/**
 * Builds a RowAccessor (see domain/index.js's findRateValue) backed by
 * targeted, per-row range reads against a real Sheet, instead of loading
 * every row into memory up front -- this is what keeps findRateValue's
 * binary search genuinely cheap in practice, not just in the pure domain
 * logic. Mirrors readExistingRows' column layout (id, code, date, value,
 * last_modified_at) and 1-based row offset (+2 for the header row).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {{rowCount: function(): number, getRow: function(number): Array<*>}}
 */
function createSheetRowAccessor(sheet) {
  var lastRow = sheet.getLastRow();
  var rowCount = lastRow > 1 ? lastRow - 1 : 0;
  return {
    rowCount: function () {
      return rowCount;
    },
    getRow: function (index) {
      return sheet.getRange(index + 2, 1, 1, 5).getValues()[0];
    },
  };
}

// CacheService's own hard cap on TTL (6 hours) -- see
// https://developers.google.com/apps-script/reference/cache/cache#putkey,-value,-expirationinseconds
var GET_CLP_CACHE_TTL_SECONDS = 21600;

/**
 * Reads a previously cached GET_CLP value for a (code, date) cache key,
 * or null on a cache miss. Only successful lookups are ever cached (see
 * cacheRateValue) -- "not found" results are deliberately never cached,
 * since those are exactly the ones likely to change soon (a value not
 * synced yet), and a stale negative could mask a sync that already
 * happened for up to 6 hours.
 * @param {GoogleAppsScript.Cache.CacheService} cacheService
 * @param {string} cacheKey e.g. "USD|2026-01-15"
 * @returns {number|null}
 */
function getCachedRateValue(cacheService, cacheKey) {
  var cached = cacheService.getScriptCache().get(cacheKey);
  if (cached === null) {
    return null;
  }
  var value = parseFloat(cached);
  return isNaN(value) ? null : value;
}

/**
 * Caches a successful GET_CLP lookup for up to 6 hours (CacheService's
 * own maximum) so repeated queries for the same (code, date) -- likely
 * across many consumer sheets hitting this one Web App -- don't re-touch
 * the Sheet.
 * @param {GoogleAppsScript.Cache.CacheService} cacheService
 * @param {string} cacheKey
 * @param {number} value
 */
function cacheRateValue(cacheService, cacheKey, value) {
  cacheService.getScriptCache().put(cacheKey, String(value), GET_CLP_CACHE_TTL_SECONDS);
}

if (typeof module !== "undefined") {
  module.exports = {
    getConfig: getConfig,
    triggerFinancialDataExport: triggerFinancialDataExport,
    fetchCsvRows: fetchCsvRows,
    readExistingRows: readExistingRows,
    writeRows: writeRows,
    getActiveSpreadsheet: getActiveSpreadsheet,
    showAlert: showAlert,
    getGetClpApiKey: getGetClpApiKey,
    createSheetRowAccessor: createSheetRowAccessor,
    getCachedRateValue: getCachedRateValue,
    cacheRateValue: cacheRateValue,
  };
}
