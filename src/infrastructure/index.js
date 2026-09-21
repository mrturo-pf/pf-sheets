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
 * id, code, date, value, last_modified_at.
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

if (typeof module !== "undefined") {
  module.exports = {
    getConfig: getConfig,
    triggerFinancialDataExport: triggerFinancialDataExport,
    fetchCsvRows: fetchCsvRows,
    readExistingRows: readExistingRows,
    writeRows: writeRows,
    getActiveSpreadsheet: getActiveSpreadsheet,
    showAlert: showAlert,
  };
}
