/**
 * Pure domain logic for pf-sheets: normalizes CSV/date/currency data and
 * computes the exchange-rates upsert delta. Zero references to Apps
 * Script globals (SpreadsheetApp, DriveApp, UrlFetchApp,
 * PropertiesService, Utilities) — that's what keeps this layer
 * unit-testable with plain Jest/Node, mirroring the `domain/` boundary
 * used in pf-rates/pf-payroll.
 *
 * Files under src/ are pushed as-is into Apps Script by `clasp`, which has
 * no `module`/`require`. The guarded `module.exports` at the bottom is a
 * safe no-op there and a normal CommonJS export under Node/Jest.
 */

var REQUIRED_CSV_COLUMNS = ["currency_code", "rate_date", "value_clp"];

// Combined pf-rates export (POST /exports/financial-data) header --
// see pf-rates/docs/api.md for the authoritative contract. The
// series_type discriminator value itself is intentionally not modeled
// here: pf-sheets no longer branches on it (see buildValuesCsvRows).
var REQUIRED_COMBINED_CSV_COLUMNS = ["series_type", "code", "period_date", "value"];

/**
 * Cache of Intl.DateTimeFormat instances keyed by IANA time zone.
 * Constructing a formatter is expensive relative to using one, and
 * normalizeDateKey is called extremely often -- once per existing sheet
 * row while indexing, plus twice per comparison while sorting the full
 * sheet (see computeUpsertPlan). At small row counts a fresh formatter
 * per call went unnoticed; at ~30k rows the sort alone drives hundreds
 * of thousands of comparisons, and allocating a new Intl.DateTimeFormat
 * on every single one of them was enough to exhaust Apps Script's V8
 * runtime memory ("Out of memory error") -- there is only ever one
 * timeZone per sync run, so memoizing by that key is sufficient here.
 * @type {Map<string, Intl.DateTimeFormat>}
 */
var dateFormattersByTimeZone = new Map();

/**
 * Returns a memoized "en-CA" (YYYY-MM-DD) Intl.DateTimeFormat for the
 * given IANA time zone, creating and caching one on first use.
 * @param {string} timeZone e.g. "America/Santiago"
 * @returns {Intl.DateTimeFormat}
 */
function getDateFormatter(timeZone) {
  var cached = dateFormattersByTimeZone.get(timeZone);
  if (cached) {
    return cached;
  }
  // "en-CA" formats as YYYY-MM-DD by locale convention — no manual
  // string surgery needed, and it respects the given IANA time zone.
  var formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateFormattersByTimeZone.set(timeZone, formatter);
  return formatter;
}

/**
 * Normalizes any date representation (a real Date, or a CSV/sheet string)
 * into a "YYYY-MM-DD" key. Real Dates are formatted using `timeZone` so the
 * same instant always normalizes to the same calendar day regardless of
 * the server's default timezone — replaces the legacy script's
 * `Utilities.formatDate(...)` call with a pure equivalent.
 * @param {Date|string|*} rawDate
 * @param {string} timeZone e.g. "America/Santiago"
 * @returns {string}
 */
function normalizeDateKey(rawDate, timeZone) {
  if (!rawDate) {
    return "";
  }
  if (rawDate instanceof Date) {
    return getDateFormatter(timeZone).format(rawDate);
  }
  return String(rawDate).trim().substring(0, 10);
}

/**
 * Parses a rate value string that may contain thousands separators
 * (e.g. "1,234.56") into a float.
 * @param {*} rawValue
 * @returns {number} NaN if unparsable
 */
function parseRateValue(rawValue) {
  var cleaned = String(rawValue).replace(/,/g, "").trim();
  return parseFloat(cleaned);
}

/**
 * Resolves the column indices for the required CSV fields, tolerant of
 * header case/whitespace.
 * @param {string[]} headerRow
 * @returns {{columns: {currency: number, date: number, value: number}, isComplete: boolean, normalizedHeader: string[]}}
 */
function resolveCsvColumns(headerRow) {
  var normalizedHeader = headerRow.map(function (header) {
    return String(header).trim().toLowerCase();
  });
  var columns = {
    currency: normalizedHeader.indexOf(REQUIRED_CSV_COLUMNS[0]),
    date: normalizedHeader.indexOf(REQUIRED_CSV_COLUMNS[1]),
    value: normalizedHeader.indexOf(REQUIRED_CSV_COLUMNS[2]),
  };
  var isComplete = columns.currency !== -1 && columns.date !== -1 && columns.value !== -1;
  return { columns: columns, isComplete: isComplete, normalizedHeader: normalizedHeader };
}

/**
 * Parses a single CSV data row into a normalized record, or null if the
 * row is incomplete/invalid (the caller is expected to skip and count it).
 * @param {Array<*>} row
 * @param {{currency: number, date: number, value: number}} columns
 * @param {string} timeZone
 * @returns {{currency: string, dateKey: string, value: number}|null}
 */
function parseCsvDataRow(row, columns, timeZone) {
  if (!row || row.length < 3) {
    return null;
  }
  var currency = String(row[columns.currency]).trim().toUpperCase();
  var dateKey = normalizeDateKey(row[columns.date], timeZone);
  var value = parseRateValue(row[columns.value]);

  if (!currency || !dateKey || isNaN(value)) {
    return null;
  }
  return { currency: currency, dateKey: dateKey, value: value };
}

/**
 * Builds a lookup index (composite key "CURRENCY|YYYY-MM-DD" -> row index)
 * over existing sheet rows, plus the highest existing numeric id.
 * @param {Array<Array<*>>} existingRows [id, currency, rate_date, value, last_modified_at][]
 * @param {string} timeZone
 * @returns {{registryMap: Map<string, number>, maxId: number}}
 */
function buildRegistryIndex(existingRows, timeZone) {
  var registryMap = new Map();
  var maxId = 0;

  for (var i = 0; i < existingRows.length; i++) {
    var row = existingRows[i];
    var id = Number(row[0]) || 0;
    if (id > maxId) {
      maxId = id;
    }

    var currency = String(row[1]).trim().toUpperCase();
    var dateKey = normalizeDateKey(row[2], timeZone);
    if (currency && dateKey) {
      registryMap.set(currency + "|" + dateKey, i);
    }
  }

  return { registryMap: registryMap, maxId: maxId };
}

/**
 * Orders two VALUES-sheet rows ([id, code, date, value, last_modified_at])
 * by the sync's sort priority: (1) date, (2) code, (3) last_modified_at,
 * all ascending. Tolerant of a mixed date type across rows -- an existing
 * row's date/last_modified_at may be a real Date straight from Sheets,
 * while a freshly inserted/updated row's is a "YYYY-MM-DD" string or a
 * JS Date -- by normalizing the date column through normalizeDateKey and
 * the last_modified_at column through `new Date(...)` before comparing.
 * @param {Array<*>} rowA
 * @param {Array<*>} rowB
 * @param {string} timeZone
 * @returns {number}
 */
function compareSheetRows(rowA, rowB, timeZone) {
  var dateKeyA = normalizeDateKey(rowA[2], timeZone);
  var dateKeyB = normalizeDateKey(rowB[2], timeZone);
  if (dateKeyA !== dateKeyB) {
    return dateKeyA < dateKeyB ? -1 : 1;
  }

  var codeA = String(rowA[1]).trim().toUpperCase();
  var codeB = String(rowB[1]).trim().toUpperCase();
  if (codeA !== codeB) {
    return codeA < codeB ? -1 : 1;
  }

  return new Date(rowA[4]).getTime() - new Date(rowB[4]).getTime();
}

/**
 * Computes the full upsert delta between the current sheet rows and the
 * incoming CSV, without mutating its inputs:
 *   - updates value + last_modified_at when the value actually changed
 *     (float comparison with a 0.00001 tolerance);
 *   - leaves untouched rows whose value is identical (preserving their
 *     original last_modified_at);
 *   - appends new rows with an auto-incremented id and the execution
 *     timestamp;
 *   - never removes a row absent from the CSV;
 *   - returns `rows` sorted by date, then code, then last_modified_at
 *     (see compareSheetRows) so the sheet stays in a predictable order
 *     across every sync instead of just growing with appended rows at
 *     the bottom.
 * @param {{existingRows: Array<Array<*>>, csvRows: Array<Array<*>>, columns: {currency:number,date:number,value:number}, timeZone: string, executionTimestamp: Date}} options
 * @returns {{rows: Array<Array<*>>, updatedCount: number, insertedCount: number, untouchedCount: number, skippedRowNumbers: number[]}}
 */
function computeUpsertPlan(options) {
  var existingRows = options.existingRows;
  var csvRows = options.csvRows;
  var columns = options.columns;
  var timeZone = options.timeZone;
  var executionTimestamp = options.executionTimestamp;

  var rows = existingRows.map(function (row) {
    return row.slice();
  });
  var index = buildRegistryIndex(rows, timeZone);
  var registryMap = index.registryMap;
  var nextId = index.maxId;

  var updatedCount = 0;
  var insertedCount = 0;
  var untouchedCount = 0;
  var skippedRowNumbers = [];

  for (var i = 1; i < csvRows.length; i++) {
    var parsed = parseCsvDataRow(csvRows[i], columns, timeZone);
    if (!parsed) {
      skippedRowNumbers.push(i + 1);
      continue;
    }

    var key = parsed.currency + "|" + parsed.dateKey;

    if (registryMap.has(key)) {
      var rowIndex = registryMap.get(key);
      var currentValue = parseFloat(rows[rowIndex][3]);
      var hasChanged = isNaN(currentValue) || Math.abs(currentValue - parsed.value) > 0.00001;

      if (hasChanged) {
        rows[rowIndex][3] = parsed.value;
        rows[rowIndex][4] = executionTimestamp;
        updatedCount++;
      } else {
        untouchedCount++;
      }
    } else {
      nextId++;
      rows.push([nextId, parsed.currency, parsed.dateKey, parsed.value, executionTimestamp]);
      registryMap.set(key, rows.length - 1);
      insertedCount++;
    }
  }

  rows.sort(function (rowA, rowB) {
    return compareSheetRows(rowA, rowB, timeZone);
  });

  return {
    rows: rows,
    updatedCount: updatedCount,
    insertedCount: insertedCount,
    untouchedCount: untouchedCount,
    skippedRowNumbers: skippedRowNumbers,
  };
}

/**
 * Resolves the column indices for the combined-export CSV's required
 * fields (series_type, code, period_date, value), tolerant of header
 * case/whitespace -- mirrors resolveCsvColumns, one level up (four
 * columns instead of three, plus the series-type discriminator).
 * @param {string[]} headerRow
 * @returns {{columns: {seriesType: number, code: number, date: number, value: number}, isComplete: boolean, normalizedHeader: string[]}}
 */
function resolveCombinedCsvColumns(headerRow) {
  var normalizedHeader = headerRow.map(function (header) {
    return String(header).trim().toLowerCase();
  });
  var columns = {
    seriesType: normalizedHeader.indexOf(REQUIRED_COMBINED_CSV_COLUMNS[0]),
    code: normalizedHeader.indexOf(REQUIRED_COMBINED_CSV_COLUMNS[1]),
    date: normalizedHeader.indexOf(REQUIRED_COMBINED_CSV_COLUMNS[2]),
    value: normalizedHeader.indexOf(REQUIRED_COMBINED_CSV_COLUMNS[3]),
  };
  var isComplete =
    columns.seriesType !== -1 && columns.code !== -1 && columns.date !== -1 && columns.value !== -1;
  return { columns: columns, isComplete: isComplete, normalizedHeader: normalizedHeader };
}

/**
 * Renames specific codes as they get written into the VALUES sheet tab --
 * a presentation-only relabeling local to this spreadsheet. pf-rates'
 * own contract, pf-db's schema, and every other consumer of the combined
 * export are completely unaffected; only what a human sees in this one
 * Sheet changes.
 *
 * To rename another code later (e.g. UTM), add one more entry here --
 * nothing else in this file, `interfaces/`, or `infrastructure/` needs to
 * change. Keys are matched case-insensitively (see applySheetCodeAlias);
 * values are used verbatim.
 *
 * A Script-Properties-driven mapping (editable without a redeploy) was
 * considered and rejected for now -- YAGNI while it's a handful of known,
 * rarely-changing codes; revisit only if this ever needs to be edited by
 * someone without repo/CI access.
 */
var SHEET_CODE_ALIASES = {
  UF: "CLF",
};

/**
 * Looks up `rawCode` in SHEET_CODE_ALIASES, case-insensitively, and
 * always returns a trimmed, upper-cased code -- whether or not an alias
 * matched. This is the single place that decides the exact string that
 * ends up written to the VALUES sheet, so normalization lives here
 * instead of being an incidental side effect of a later pipeline stage.
 * @param {*} rawCode
 * @returns {string}
 */
function applySheetCodeAlias(rawCode) {
  var normalizedCode = String(rawCode).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SHEET_CODE_ALIASES, normalizedCode)
    ? SHEET_CODE_ALIASES[normalizedCode]
    : normalizedCode;
}

/**
 * Converts every row of a combined pf-rates export CSV
 * (series_type,code,period_date,value) into the legacy-shaped rows
 * (currency_code,rate_date,value_clp) that the existing
 * resolveCsvColumns/computeUpsertPlan pipeline already knows how to
 * upsert unchanged -- one shared upsert algorithm for the whole VALUES
 * sheet layout (id, code, date, value, last_modified_at), no matter
 * which series_type a row came in as.
 *
 * pf-rates' own EXCHANGE_RATE / ECONOMIC_INDEX split (see
 * pf-rates/src/rates/shared/constants.py) is that service's internal
 * classification of *how* it resolves a value -- it does NOT map onto
 * "currency vs. economic index" the way a human would expect. `UF` and
 * `UTM` are both exported there as `EXCHANGE_RATE`, even though most
 * people in Chile call them economic indices; only `IPC_CL` is actually
 * `ECONOMIC_INDEX`. An earlier version of this function filtered by
 * series_type and, as a direct consequence, silently dropped UF and UTM
 * from this sheet -- pf-sheets does not repeat pf-rates' split at all
 * anymore: every code pf-rates exports lands in the VALUES tab.
 *
 * Only structurally malformed rows (too few columns) are skipped and
 * their 1-based line numbers reported, mirroring computeUpsertPlan's own
 * "skip and count" behavior for malformed rows rather than aborting the
 * whole sync over one bad line.
 * @param {Array<Array<*>>} combinedCsvRows
 * @returns {{valuesCsvRows: Array<Array<*>>, isComplete: boolean, normalizedHeader: string[], skippedRowNumbers: number[]}}
 */
function buildValuesCsvRows(combinedCsvRows) {
  var resolution = resolveCombinedCsvColumns(combinedCsvRows[0] || []);
  var valuesCsvRows = [REQUIRED_CSV_COLUMNS.slice()];
  var skippedRowNumbers = [];

  if (!resolution.isComplete) {
    return {
      valuesCsvRows: valuesCsvRows,
      isComplete: false,
      normalizedHeader: resolution.normalizedHeader,
      skippedRowNumbers: skippedRowNumbers,
    };
  }

  var columns = resolution.columns;
  for (var i = 1; i < combinedCsvRows.length; i++) {
    var row = combinedCsvRows[i];
    if (!row || row.length < 4) {
      skippedRowNumbers.push(i + 1);
      continue;
    }

    valuesCsvRows.push([applySheetCodeAlias(row[columns.code]), row[columns.date], row[columns.value]]);
  }

  return {
    valuesCsvRows: valuesCsvRows,
    isComplete: true,
    normalizedHeader: resolution.normalizedHeader,
    skippedRowNumbers: skippedRowNumbers,
  };
}

/**
 * Minimal read interface `findRateValue` needs over the VALUES sheet's rows
 * (id, code, date, value, last_modified_at), decoupled from how those rows
 * are actually fetched. This is what lets `infrastructure/` implement it
 * with targeted `getRange(row, col).getValue()` calls against the real
 * Sheet -- never materializing all ~30k rows into memory just to answer
 * one GET_CLP lookup -- while this file stays testable with a trivial
 * array-backed fake.
 * @typedef {Object} RowAccessor
 * @property {function(): number} rowCount
 * @property {function(number): Array<*>} getRow 0-based row index -> [id, code, date, value, last_modified_at]
 */

/**
 * Wraps a plain array of VALUES-shaped rows as a RowAccessor. Reference
 * implementation used by tests; the real `infrastructure/` accessor reads
 * directly from the Sheet instead of holding every row in memory.
 * @param {Array<Array<*>>} rows
 * @returns {RowAccessor}
 */
function createArrayRowAccessor(rows) {
  return {
    rowCount: function () {
      return rows.length;
    },
    getRow: function (index) {
      return rows[index];
    },
  };
}

/**
 * Binary "lower bound" search: the smallest 0-based index whose row's date
 * key is >= targetDateKey, or `accessor.rowCount()` if every row's date is
 * smaller. Assumes rows are already sorted ascending by date (the
 * invariant `computeUpsertPlan` guarantees for the VALUES sheet -- see
 * compareSheetRows) -- this is what turns a lookup into O(log n) instead
 * of a full linear scan.
 * @param {RowAccessor} accessor
 * @param {string} targetDateKey "YYYY-MM-DD"
 * @param {string} timeZone
 * @returns {number}
 */
function findFirstRowIndexAtOrAfterDate(accessor, targetDateKey, timeZone) {
  var low = 0;
  var high = accessor.rowCount();
  while (low < high) {
    var mid = Math.floor((low + high) / 2);
    var midDateKey = normalizeDateKey(accessor.getRow(mid)[2], timeZone);
    if (midDateKey < targetDateKey) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Looks up a single VALUES-sheet value for (code, date) -- the core of
 * GET_CLP. Finds the start of the (small, contiguous) block of rows
 * sharing `date` via binary search, then scans forward only within that
 * block for a matching code, instead of a full linear scan. `code` is run
 * through `applySheetCodeAlias` first so callers can ask for "UF" even
 * though the sheet stores it as "CLF" (same alias the sync already
 * applies on write -- see applySheetCodeAlias).
 * @param {RowAccessor} accessor
 * @param {string} rawCode e.g. "USD", "uf"
 * @param {Date|string} rawDate
 * @param {string} timeZone e.g. "America/Santiago"
 * @returns {number|null} the CLP value, or null if not found / inputs invalid
 */
function findRateValue(accessor, rawCode, rawDate, timeZone) {
  var targetCode = applySheetCodeAlias(rawCode);
  var targetDateKey = normalizeDateKey(rawDate, timeZone);
  var rowCount = accessor.rowCount();

  if (!rowCount || !targetCode || !targetDateKey) {
    return null;
  }

  var index = findFirstRowIndexAtOrAfterDate(accessor, targetDateKey, timeZone);
  while (index < rowCount) {
    var row = accessor.getRow(index);
    if (normalizeDateKey(row[2], timeZone) !== targetDateKey) {
      break;
    }
    if (String(row[1]).trim().toUpperCase() === targetCode) {
      var value = parseFloat(row[3]);
      return isNaN(value) ? null : value;
    }
    index++;
  }
  return null;
}

/**
 * Batch counterpart to findRateValue, for GET_CLP_RANGE (see
 * plan-get-clp-02-range-batch.md) -- resolves every (code, date) pair
 * against the same accessor/timeZone in one call. Reuses findRateValue
 * per pair: each pair is still its own independent O(log n) binary
 * search, since the real perf win of batching comes from amortizing ONE
 * HTTP round trip + doPost invocation over N pairs, not from a smarter
 * search algorithm.
 *
 * A malformed pair (null/undefined, or missing code/date) resolves to
 * null at its own position, same as findRateValue does for a single
 * missing code/date -- one bad pair never throws or shifts positions, so
 * the caller can always zip `pairs` and the returned array back together
 * 1:1 by index.
 * @param {RowAccessor} accessor
 * @param {Array<{code: *, date: *}>} pairs
 * @param {string} timeZone e.g. "America/Santiago"
 * @returns {Array<number|null>} same length and order as `pairs`
 */
function findRateValues(accessor, pairs, timeZone) {
  return pairs.map(function (pair) {
    if (!pair) {
      return null;
    }
    return findRateValue(accessor, pair.code, pair.date, timeZone);
  });
}

/**
 * Decides what GET_CLP_RANGE should show for a pair that resolved to no
 * match in VALUES -- "" (blank cell) for a future date, since there's
 * genuinely no exchange rate to publish yet (not a data problem worth
 * flagging), or the "Not found" message for a present/past date, a real
 * gap in VALUES worth surfacing. See docs/api.md, "GET_CLP_RANGE and
 * future dates", for why this only applies to GET_CLP_RANGE and not
 * GET_CLP: GET_CLP throws per cell (its own top-level custom-function
 * call), so IFERROR already handles the future-date case fine at the
 * formula level -- GET_CLP_RANGE's whole batch is ONE function call
 * returning one array, so a thrown error would blank out every cell in
 * the range instead of just the missing one, and IFERROR can only wrap
 * the entire call, not a single cell inside its result.
 *
 * Comparing the two "YYYY-MM-DD" keys as plain strings (no re-parsing
 * back into Date objects) is intentional and safe: ISO-formatted date
 * keys sort lexicographically in exactly the same order as
 * chronologically.
 * @param {string} dateKey e.g. "2026-09-23" (already normalized)
 * @param {string} todayKey e.g. "2026-09-23" (already normalized, same
 *   timeZone as dateKey -- see normalizeDateKey)
 * @returns {string} "" for a future date, "Not found" otherwise
 */
function describeMissingRate(dateKey, todayKey) {
  return dateKey > todayKey ? "" : "Not found";
}

/**
 * Classifies a raw (code, date) pair from a GET_CLP_RANGE request body
 * BEFORE any normalization/lookup happens. Exists because an open-ended
 * range reference in a formula (e.g. `$F$4:$F`, covering a whole column
 * to the sheet's last row) sends one pair per sheet row, and most of
 * those rows past the real data are simply blank padding -- treating a
 * fully-blank pair the same as a genuinely malformed one (only code OR
 * date present, a real data-entry mistake worth flagging) would both
 * clutter the result with hundreds of "Missing parameters" cells AND
 * count every blank padding row against GET_CLP_RANGE_MAX_PAIRS, making
 * open-ended references fail outright on any sheet whose total row count
 * exceeds that cap regardless of how much real data it holds -- exactly
 * the incident reported for "(12) MedicalRefund" in
 * plan-get-clp-02-range-batch.md.
 * @param {*} rawCode
 * @param {*} rawDate
 * @returns {"blank"|"malformed"|{code: *, date: *}} "blank" when both are
 *   falsy (nothing to look up -- not an error), "malformed" when exactly
 *   one is falsy (a real mistake), or the pair itself when both are
 *   present (ready for normalizeDateKey/applySheetCodeAlias downstream)
 */
function classifyRangePair(rawCode, rawDate) {
  if (!rawCode && !rawDate) {
    return "blank";
  }
  if (!rawCode || !rawDate) {
    return "malformed";
  }
  return { code: rawCode, date: rawDate };
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeDateKey: normalizeDateKey,
    parseRateValue: parseRateValue,
    resolveCsvColumns: resolveCsvColumns,
    parseCsvDataRow: parseCsvDataRow,
    buildRegistryIndex: buildRegistryIndex,
    compareSheetRows: compareSheetRows,
    computeUpsertPlan: computeUpsertPlan,
    resolveCombinedCsvColumns: resolveCombinedCsvColumns,
    applySheetCodeAlias: applySheetCodeAlias,
    buildValuesCsvRows: buildValuesCsvRows,
    createArrayRowAccessor: createArrayRowAccessor,
    findFirstRowIndexAtOrAfterDate: findFirstRowIndexAtOrAfterDate,
    findRateValue: findRateValue,
    findRateValues: findRateValues,
    describeMissingRate: describeMissingRate,
    classifyRangePair: classifyRangePair,
  };
}
