/**
 * Entry points Apps Script calls: the bound macro (`updateExchangeRates`)
 * and the custom menu (`onOpen`). Kept thin — orchestration only,
 * delegating computation to `domain/` and I/O to `infrastructure/`.
 *
 * This is the ONLY file allowed to reference the bare Apps Script globals
 * (SpreadsheetApp, DriveApp, UrlFetchApp, PropertiesService, Utilities)
 * directly — every other layer receives them as explicit parameters. Not
 * unit-tested here (exercising it would mean faking all five globals at
 * once, for very little signal); validated instead by running the pushed
 * macro for real, end-to-end, against the live Sheet. `domain/` and
 * `infrastructure/` carry the real test coverage.
 *
 * Calls domain/infrastructure functions by bare name (no `require`) —
 * this works because Apps Script concatenates every file in the project
 * into one flat global scope at runtime. See AGENTS.md for why this is
 * safe and what it does NOT let us do (unit-test this file in isolation).
 */

var EXCH_RATE_SHEET_NAME = "EXCH_RATE";
var ECON_INDEX_SHEET_NAME = "ECON_INDEX";

/**
 * Creates the "Rate Values" custom menu when the spreadsheet opens.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Rate Values").addItem("Update", "updateExchangeRates").addToUi();
}

/**
 * Syncs one sheet tab against its already-split, legacy-shaped CSV rows
 * (currency_code,rate_date,value_clp -- see splitCombinedCsvBySeriesType).
 * Both EXCH_RATE and ECON_INDEX share the exact same upsert algorithm and
 * 5-column layout, so this one helper drives both instead of duplicating
 * the load/compute/write sequence per tab.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @param {Array<Array<*>>} legacyCsvRows
 * @returns {{updatedCount: number, insertedCount: number, untouchedCount: number}|null} null if the tab doesn't exist (alert already shown)
 */
function syncSheetTab(spreadsheet, sheetName, legacyCsvRows) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    var notFoundMessage = 'Sheet tab "' + sheetName + '" was not found in this spreadsheet.';
    console.error(notFoundMessage);
    showAlert(SpreadsheetApp, notFoundMessage);
    return null;
  }

  var columnResolution = resolveCsvColumns(legacyCsvRows[0]);
  var existingRows = readExistingRows(sheet);
  console.log('Loaded ' + existingRows.length + ' existing row(s) from "' + sheetName + '".');

  var plan = computeUpsertPlan({
    existingRows: existingRows,
    csvRows: legacyCsvRows,
    columns: columnResolution.columns,
    timeZone: spreadsheet.getSpreadsheetTimeZone(),
    executionTimestamp: new Date(),
  });

  if (plan.skippedRowNumbers.length > 0) {
    console.warn(
      '"' + sheetName + '": skipped ' + plan.skippedRowNumbers.length + ' invalid row(s) at line(s): ' + plan.skippedRowNumbers.join(", ")
    );
  }

  if (plan.updatedCount > 0 || plan.insertedCount > 0) {
    writeRows(sheet, plan.rows);
    console.log('"' + sheetName + '" grid updated: ' + plan.rows.length + ' total row(s) written.');
  } else {
    console.log('"' + sheetName + '": no updates or inserts needed - sheet write skipped.');
  }

  return { updatedCount: plan.updatedCount, insertedCount: plan.insertedCount, untouchedCount: plan.untouchedCount };
}

/**
 * Synchronizes financial data: triggers the pf-rates combined export,
 * reads the resulting CSV from Drive regardless of that call's outcome,
 * splits it by series type, and performs an incremental upsert into both
 * the EXCH_RATE and ECON_INDEX sheet tabs. See docs/api.md for the full
 * behavior contract. Kept as `updateExchangeRates` (not renamed) so any
 * existing menu/trigger binding to this exact function name keeps working
 * -- it now covers both tabs internally instead of a parallel macro being
 * added alongside it.
 */
function updateExchangeRates() {
  var config = getConfig(PropertiesService);

  console.log(
    'Starting financial data synchronization. Sheets="' +
      EXCH_RATE_SHEET_NAME +
      '", "' +
      ECON_INDEX_SHEET_NAME +
      '" DriveFileId="' +
      config.driveFileId +
      '"'
  );

  // Step 1: trigger the pf-rates combined export -- best-effort. Step 3
  // reads whatever CSV Drive currently has regardless of this call's outcome.
  var apiStatusSummary = "";
  try {
    var startTime = new Date().getTime();
    var exportResult = triggerFinancialDataExport(UrlFetchApp, config, {
      lookback_days: 90,
      forward_days: 30,
    });
    var elapsedMs = new Date().getTime() - startTime;

    if (exportResult.statusCode >= 200 && exportResult.statusCode < 300) {
      apiStatusSummary = "API: OK (" + exportResult.statusCode + ")";
      console.log("Export API responded in " + elapsedMs + " ms with status " + exportResult.statusCode);
    } else {
      apiStatusSummary = "API: Failed (" + exportResult.statusCode + ")";
      console.warn("Export API returned a non-2xx status (" + exportResult.statusCode + "): " + exportResult.body);
    }
  } catch (error) {
    apiStatusSummary = "API: Connection Error";
    console.error("Exception while triggering the export: " + error);
  }

  // Step 2: read + parse the combined CSV from Drive.
  var rawCsvRows;
  try {
    rawCsvRows = fetchCsvRows(DriveApp, Utilities, config.driveFileId);
    console.log("CSV parsed: " + rawCsvRows.length + " line(s) including header.");
  } catch (err) {
    var fileErrorMessage = "Failed to access or parse CSV from Drive: " + err.message;
    console.error(fileErrorMessage);
    showAlert(SpreadsheetApp, fileErrorMessage);
    return;
  }

  if (!rawCsvRows || rawCsvRows.length <= 1) {
    var emptyMessage = "The CSV file does not contain any data rows.";
    console.warn(emptyMessage);
    showAlert(SpreadsheetApp, emptyMessage);
    return;
  }

  // Step 3: split the combined CSV by series type (pure -- see src/domain/).
  var split = splitCombinedCsvBySeriesType(rawCsvRows);
  console.log("Detected headers: [" + split.normalizedHeader.join(", ") + "]");
  if (!split.isComplete) {
    var missingColumnsMessage =
      "CSV is missing one or more required columns ('series_type', 'code', 'period_date', 'value').";
    console.error(missingColumnsMessage);
    showAlert(SpreadsheetApp, missingColumnsMessage);
    return;
  }
  if (split.skippedRowNumbers.length > 0) {
    console.warn(
      "Skipped " +
        split.skippedRowNumbers.length +
        " row(s) with an unrecognized/incomplete series_type at line(s): " +
        split.skippedRowNumbers.join(", ")
    );
  }

  // Step 4: locate both target sheets and upsert each one (pure planning
  // logic shared via syncSheetTab -- see above).
  var spreadsheet = getActiveSpreadsheet(SpreadsheetApp);
  var exchangeRateSummary = syncSheetTab(spreadsheet, EXCH_RATE_SHEET_NAME, split.exchangeRateCsvRows);
  if (!exchangeRateSummary) {
    return;
  }
  var economicIndexSummary = syncSheetTab(spreadsheet, ECON_INDEX_SHEET_NAME, split.economicIndexCsvRows);
  if (!economicIndexSummary) {
    return;
  }

  // Step 5: summarize both tabs in one toast.
  var summaryMessage =
    "[" +
    apiStatusSummary +
    "] " +
    EXCH_RATE_SHEET_NAME +
    " -> Updated: " +
    exchangeRateSummary.updatedCount +
    " | New: " +
    exchangeRateSummary.insertedCount +
    " | Untouched: " +
    exchangeRateSummary.untouchedCount +
    ". " +
    ECON_INDEX_SHEET_NAME +
    " -> Updated: " +
    economicIndexSummary.updatedCount +
    " | New: " +
    economicIndexSummary.insertedCount +
    " | Untouched: " +
    economicIndexSummary.untouchedCount;
  console.log(summaryMessage);
  spreadsheet.toast(summaryMessage, "Synchronization Complete", 7);
}

if (typeof module !== "undefined") {
  module.exports = { onOpen: onOpen, updateExchangeRates: updateExchangeRates };
}
