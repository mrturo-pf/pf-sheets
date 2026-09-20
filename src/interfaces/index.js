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

/**
 * Creates the "Rate Values" custom menu when the spreadsheet opens.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Rate Values").addItem("Update", "updateExchangeRates").addToUi();
}

/**
 * Synchronizes exchange rates: triggers the pf-rates export, reads the
 * resulting CSV from Drive regardless of that call's outcome, and
 * performs an incremental upsert into the EXCH_RATE sheet tab. See
 * docs/api.md for the full behavior contract.
 */
function updateExchangeRates() {
  var config = getConfig(PropertiesService);

  console.log(
    'Starting exchange rates synchronization. Sheet="' +
      EXCH_RATE_SHEET_NAME +
      '" DriveFileId="' +
      config.driveFileId +
      '"'
  );

  // Step 1: trigger the pf-rates export — best-effort. Step 3 reads
  // whatever CSV Drive currently has regardless of this call's outcome.
  var apiStatusSummary = "";
  try {
    var startTime = new Date().getTime();
    var exportResult = triggerRatesExport(UrlFetchApp, config, {
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

  // Step 2: locate the target sheet tab.
  var spreadsheet = getActiveSpreadsheet(SpreadsheetApp);
  var sheet = spreadsheet.getSheetByName(EXCH_RATE_SHEET_NAME);
  if (!sheet) {
    var notFoundMessage = 'Sheet tab "' + EXCH_RATE_SHEET_NAME + '" was not found in this spreadsheet.';
    console.error(notFoundMessage);
    showAlert(SpreadsheetApp, notFoundMessage);
    return;
  }

  // Step 3: read + parse the CSV from Drive.
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

  var columnResolution = resolveCsvColumns(rawCsvRows[0]);
  console.log("Detected headers: [" + columnResolution.normalizedHeader.join(", ") + "]");
  if (!columnResolution.isComplete) {
    var missingColumnsMessage =
      "CSV is missing one or more required columns ('currency_code', 'rate_date', 'value_clp').";
    console.error(missingColumnsMessage);
    showAlert(SpreadsheetApp, missingColumnsMessage);
    return;
  }

  // Step 4 & 5: load existing rows and compute the upsert delta (pure —
  // see src/domain/).
  var existingRows = readExistingRows(sheet);
  console.log('Loaded ' + existingRows.length + ' existing row(s) from "' + EXCH_RATE_SHEET_NAME + '".');

  var plan = computeUpsertPlan({
    existingRows: existingRows,
    csvRows: rawCsvRows,
    columns: columnResolution.columns,
    timeZone: spreadsheet.getSpreadsheetTimeZone(),
    executionTimestamp: new Date(),
  });

  if (plan.skippedRowNumbers.length > 0) {
    console.warn(
      "Skipped " + plan.skippedRowNumbers.length + " invalid CSV row(s) at line(s): " + plan.skippedRowNumbers.join(", ")
    );
  }

  // Step 6: commit changes to the grid, only if something actually changed.
  if (plan.updatedCount > 0 || plan.insertedCount > 0) {
    writeRows(sheet, plan.rows);
    console.log("Sheet grid updated: " + plan.rows.length + " total row(s) written.");
  } else {
    console.log("No updates or inserts needed - sheet write skipped.");
  }

  // Step 7: summarize.
  var summaryMessage =
    "[" + apiStatusSummary + "] Updated: " + plan.updatedCount + " | New: " + plan.insertedCount + " | Untouched: " + plan.untouchedCount;
  console.log(summaryMessage);
  spreadsheet.toast(summaryMessage, "Synchronization Complete", 7);
}

if (typeof module !== "undefined") {
  module.exports = { onOpen: onOpen, updateExchangeRates: updateExchangeRates };
}
