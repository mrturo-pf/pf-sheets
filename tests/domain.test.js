const {
  normalizeDateKey,
  parseRateValue,
  resolveCsvColumns,
  parseCsvDataRow,
  buildRegistryIndex,
  compareSheetRows,
  computeUpsertPlan,
  resolveCombinedCsvColumns,
  applySheetCodeAlias,
  buildValuesCsvRows,
  createArrayRowAccessor,
  findFirstRowIndexAtOrAfterDate,
  findRateValue,
  findRateValues,
} = require("../src/domain");

const TZ = "America/Santiago";

describe("normalizeDateKey", () => {
  it("returns an empty string for falsy input", () => {
    expect(normalizeDateKey(null, TZ)).toBe("");
    expect(normalizeDateKey("", TZ)).toBe("");
  });

  it("formats a Date instance as YYYY-MM-DD in the given time zone", () => {
    // 2026-01-15T02:00:00Z is 2026-01-14 23:00 in America/Santiago (UTC-3, Chilean summer DST).
    const date = new Date(Date.UTC(2026, 0, 15, 2, 0, 0));
    expect(normalizeDateKey(date, TZ)).toBe("2026-01-14");
  });

  it("truncates a string representation to its first 10 characters", () => {
    expect(normalizeDateKey("2026-01-15T00:00:00.000Z", TZ)).toBe("2026-01-15");
  });
});

describe("parseRateValue", () => {
  it("parses a plain numeric string", () => {
    expect(parseRateValue("950.25")).toBeCloseTo(950.25);
  });

  it("strips thousands separators before parsing", () => {
    expect(parseRateValue("1,234.56")).toBeCloseTo(1234.56);
  });

  it("returns NaN for unparsable input", () => {
    expect(Number.isNaN(parseRateValue("not-a-number"))).toBe(true);
  });
});

describe("resolveCsvColumns", () => {
  it("resolves all three required columns regardless of case/whitespace", () => {
    const result = resolveCsvColumns([" Currency_Code ", "RATE_DATE", "value_clp"]);
    expect(result.isComplete).toBe(true);
    expect(result.columns).toEqual({ currency: 0, date: 1, value: 2 });
  });

  it("flags isComplete=false when a required column is missing", () => {
    const result = resolveCsvColumns(["currency_code", "rate_date"]);
    expect(result.isComplete).toBe(false);
  });
});

describe("parseCsvDataRow", () => {
  const columns = { currency: 0, date: 1, value: 2 };

  it("parses a valid row, uppercasing the currency", () => {
    const result = parseCsvDataRow(["usd", "2026-01-15", "950.5"], columns, TZ);
    expect(result).toEqual({ currency: "USD", dateKey: "2026-01-15", value: 950.5 });
  });

  it("returns null when the row is too short", () => {
    expect(parseCsvDataRow(["usd"], columns, TZ)).toBeNull();
  });

  it("returns null when the value isn't numeric", () => {
    expect(parseCsvDataRow(["usd", "2026-01-15", "n/a"], columns, TZ)).toBeNull();
  });
});

describe("buildRegistryIndex", () => {
  it("indexes rows by CURRENCY|DATE and tracks the max id", () => {
    const existingRows = [
      [1, "usd", "2026-01-14", 940, new Date()],
      [2, "eur", "2026-01-14", 1020, new Date()],
    ];
    const { registryMap, maxId } = buildRegistryIndex(existingRows, TZ);
    expect(maxId).toBe(2);
    expect(registryMap.get("USD|2026-01-14")).toBe(0);
    expect(registryMap.get("EUR|2026-01-14")).toBe(1);
  });

  it("keeps the highest id seen even when later rows have a smaller id", () => {
    const existingRows = [
      [10, "usd", "2026-01-14", 940, new Date()],
      [3, "eur", "2026-01-14", 1020, new Date()],
    ];
    const { maxId } = buildRegistryIndex(existingRows, TZ);
    expect(maxId).toBe(10);
  });

  it("skips indexing a row with an empty currency or an unparsable date", () => {
    const existingRows = [
      [1, "", "2026-01-14", 940, new Date()],
      [2, "eur", "", 1020, new Date()],
    ];
    const { registryMap } = buildRegistryIndex(existingRows, TZ);
    expect(registryMap.size).toBe(0);
  });

  it("treats a missing/non-numeric id as 0 instead of throwing", () => {
    const existingRows = [["not-a-number", "usd", "2026-01-14", 940, new Date()]];
    const { maxId } = buildRegistryIndex(existingRows, TZ);
    expect(maxId).toBe(0);
  });
});

describe("computeUpsertPlan", () => {
  const columns = { currency: 0, date: 1, value: 2 };
  const executionTimestamp = new Date("2026-01-15T12:00:00Z");

  it("updates a row whose value changed", () => {
    const existingRows = [[1, "USD", "2026-01-14", 940, "old-timestamp"]];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["usd", "2026-01-14", "950"],
    ];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.updatedCount).toBe(1);
    expect(plan.insertedCount).toBe(0);
    expect(plan.untouchedCount).toBe(0);
    expect(plan.rows[0][3]).toBe(950);
    expect(plan.rows[0][4]).toBe(executionTimestamp);
  });

  it("leaves a row untouched (and its timestamp intact) when the value is within tolerance", () => {
    const existingRows = [[1, "USD", "2026-01-14", 950, "original-timestamp"]];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["usd", "2026-01-14", "950.000001"],
    ];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.untouchedCount).toBe(1);
    expect(plan.updatedCount).toBe(0);
    expect(plan.rows[0][4]).toBe("original-timestamp");
  });

  it("inserts a new row with an auto-incremented id", () => {
    const existingRows = [[5, "USD", "2026-01-14", 950, "ts"]];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["eur", "2026-01-14", "1020"],
    ];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.insertedCount).toBe(1);
    expect(plan.rows).toContainEqual([6, "EUR", "2026-01-14", 1020, executionTimestamp]);
  });

  it("keeps existing rows absent from the CSV, untouched", () => {
    const existingRows = [[1, "GBP", "2026-01-10", 1100, "ts"]];
    const csvRows = [["currency_code", "rate_date", "value_clp"]];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.rows).toHaveLength(1);
    expect(plan.updatedCount + plan.insertedCount).toBe(0);
  });

  it("skips invalid rows and reports their (1-based) line numbers", () => {
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["usd", "2026-01-14", "950"],
      ["bad", "row"],
    ];

    const plan = computeUpsertPlan({ existingRows: [], csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.skippedRowNumbers).toEqual([3]);
  });

  it("does not mutate the existingRows array passed in", () => {
    const existingRows = [[1, "USD", "2026-01-14", 940, "ts"]];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["usd", "2026-01-14", "950"],
    ];

    computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(existingRows[0][3]).toBe(940);
  });

  it("handles a realistic mixed CSV: one update, one insert, one untouched, one absent-from-CSV, one skipped", () => {
    const existingRows = [
      [1, "USD", "2026-01-14", 940, "usd-old-ts"], // will be updated (value changes)
      [2, "EUR", "2026-01-14", 1020, "eur-old-ts"], // will stay untouched (same value)
      [3, "GBP", "2026-01-10", 1150, "gbp-old-ts"], // absent from CSV -> must survive untouched
    ];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["usd", "2026-01-14", "955"], // update
      ["eur", "2026-01-14", "1020"], // untouched
      ["clp", "2026-01-14", "1"], // insert (new currency)
      ["bad", "row-with-too-few-cols"], // skipped
    ];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.updatedCount).toBe(1);
    expect(plan.insertedCount).toBe(1);
    expect(plan.untouchedCount).toBe(1);
    expect(plan.skippedRowNumbers).toEqual([5]);
    // 3 original rows + 1 inserted = 4, none dropped.
    expect(plan.rows).toHaveLength(4);

    const usdRow = plan.rows.find((row) => row[1] === "USD");
    expect(usdRow[3]).toBe(955);
    expect(usdRow[4]).toBe(executionTimestamp);

    const eurRow = plan.rows.find((row) => row[1] === "EUR");
    expect(eurRow[4]).toBe("eur-old-ts"); // preserved, not overwritten

    const gbpRow = plan.rows.find((row) => row[1] === "GBP");
    expect(gbpRow).toBeDefined(); // survived even though absent from the CSV

    const clpRow = plan.rows.find((row) => row[1] === "CLP");
    expect(clpRow[0]).toBe(4); // auto-incremented past the highest existing id (3)
  });

  it("returns rows sorted by date, then code, then last_modified_at", () => {
    const existingRows = [
      [1, "USD", "2026-01-14", 950, new Date("2026-01-14T09:00:00Z")],
      [2, "EUR", "2026-01-10", 1020, new Date("2026-01-10T09:00:00Z")],
    ];
    const csvRows = [
      ["currency_code", "rate_date", "value_clp"],
      ["clp", "2026-01-14", "1"], // same date as USD, but "CLP" < "USD"
    ];

    const plan = computeUpsertPlan({ existingRows, csvRows, columns, timeZone: TZ, executionTimestamp });

    expect(plan.rows.map((row) => row[1])).toEqual(["EUR", "CLP", "USD"]);
  });
});

describe("compareSheetRows", () => {
  it("orders by date first, regardless of code", () => {
    const earlier = [1, "ZZZ", "2026-01-01", 1, new Date("2026-01-01T12:00:00Z")];
    const later = [2, "AAA", "2026-01-02", 1, new Date("2026-01-01T12:00:00Z")];

    expect(compareSheetRows(earlier, later, TZ)).toBeLessThan(0);
    expect(compareSheetRows(later, earlier, TZ)).toBeGreaterThan(0);
  });

  it("breaks a same-date tie by code", () => {
    const eur = [1, "EUR", "2026-01-01", 1, new Date("2026-01-01T12:00:00Z")];
    const usd = [2, "USD", "2026-01-01", 1, new Date("2026-01-01T12:00:00Z")];

    expect(compareSheetRows(eur, usd, TZ)).toBeLessThan(0);
  });

  it("breaks a same-date-and-code tie by last_modified_at", () => {
    const olderModified = [1, "USD", "2026-01-01", 1, new Date("2026-01-01T09:00:00Z")];
    const newerModified = [2, "USD", "2026-01-01", 1, new Date("2026-01-01T10:00:00Z")];

    expect(compareSheetRows(olderModified, newerModified, TZ)).toBeLessThan(0);
  });

  it("treats a real Date and an equivalent 'YYYY-MM-DD' string in the date column as the same date", () => {
    const asDate = [1, "USD", new Date("2026-01-01T12:00:00Z"), 1, new Date("2026-01-01T12:00:00Z")];
    const asString = [1, "USD", "2026-01-01", 1, new Date("2026-01-01T12:00:00Z")];

    expect(compareSheetRows(asDate, asString, TZ)).toBe(0);
  });
});

describe("resolveCombinedCsvColumns", () => {
  it("resolves all four required columns regardless of case/whitespace", () => {
    const result = resolveCombinedCsvColumns([" Series_Type ", "CODE", "period_date", "Value"]);
    expect(result.isComplete).toBe(true);
    expect(result.columns).toEqual({ seriesType: 0, code: 1, date: 2, value: 3 });
  });

  it("flags isComplete=false when a required column is missing", () => {
    const result = resolveCombinedCsvColumns(["series_type", "code", "period_date"]);
    expect(result.isComplete).toBe(false);
  });
});

describe("applySheetCodeAlias", () => {
  it("renames UF to CLF", () => {
    expect(applySheetCodeAlias("UF")).toBe("CLF");
  });

  it("is case-insensitive when matching the configured alias", () => {
    expect(applySheetCodeAlias("uf")).toBe("CLF");
    expect(applySheetCodeAlias(" Uf ")).toBe("CLF");
  });

  it("passes codes with no configured alias through, but still trimmed and upper-cased", () => {
    expect(applySheetCodeAlias("IPC_CL")).toBe("IPC_CL");
    expect(applySheetCodeAlias(" ipc_cl ")).toBe("IPC_CL");
    expect(applySheetCodeAlias("utm")).toBe("UTM");
  });
});

describe("buildValuesCsvRows", () => {
  it("includes EXCHANGE_RATE rows (e.g. UF, USD) alongside ECONOMIC_INDEX rows -- no series_type filtering", () => {
    // Regression test: pf-rates classifies UF and UTM as EXCHANGE_RATE
    // (see pf-rates/src/rates/shared/constants.py), not ECONOMIC_INDEX --
    // an earlier version of this function filtered by series_type and, as
    // a direct consequence, silently dropped UF/UTM from the VALUES tab.
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "USD", "2026-01-14", "950"],
      ["EXCHANGE_RATE", "UF", "2026-01-14", "38000.12"],
      ["EXCHANGE_RATE", "UTM", "2026-01-14", "66000"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
    ];

    const result = buildValuesCsvRows(combinedCsvRows);

    expect(result.isComplete).toBe(true);
    expect(result.skippedRowNumbers).toEqual([]);
    expect(result.valuesCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["USD", "2026-01-14", "950"],
      ["CLF", "2026-01-14", "38000.12"], // UF aliased to CLF
      ["UTM", "2026-01-14", "66000"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("applies the configured code alias (UF -> CLF) while leaving other codes untouched", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "UF", "2026-01-14", "38000.12"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
    ];

    const result = buildValuesCsvRows(combinedCsvRows);

    expect(result.valuesCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["CLF", "2026-01-14", "38000.12"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("trims and upper-cases every code, aliased or not, regardless of how pf-rates sent it", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", " uf ", "2026-01-14", "38000.12"],
      ["ECONOMIC_INDEX", "ipc_cl", "2026-01-14", "125.5"],
    ];

    const result = buildValuesCsvRows(combinedCsvRows);

    expect(result.valuesCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["CLF", "2026-01-14", "38000.12"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("skips only structurally malformed rows (too few columns) and reports their line number", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "USD", "2026-01-14", "950"],
      ["EXCHANGE_RATE", "USD", "2026-01-14"],
    ];

    const result = buildValuesCsvRows(combinedCsvRows);

    expect(result.skippedRowNumbers).toEqual([3]);
    expect(result.valuesCsvRows).toHaveLength(2); // header + the one valid row
  });

  it("returns isComplete=false and an empty result when the header is missing columns", () => {
    const combinedCsvRows = [
      ["series_type", "code"],
      ["EXCHANGE_RATE", "USD"],
    ];

    const result = buildValuesCsvRows(combinedCsvRows);

    expect(result.isComplete).toBe(false);
    expect(result.valuesCsvRows).toEqual([["currency_code", "rate_date", "value_clp"]]);
  });

  it("produces output that computeUpsertPlan can consume unchanged (end-to-end)", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-15", "125.5"],
    ];
    const extraction = buildValuesCsvRows(combinedCsvRows);
    const columnResolution = resolveCsvColumns(extraction.valuesCsvRows[0]);

    const plan = computeUpsertPlan({
      existingRows: [],
      csvRows: extraction.valuesCsvRows,
      columns: columnResolution.columns,
      timeZone: TZ,
      executionTimestamp: new Date("2026-01-15T12:00:00Z"),
    });

    expect(plan.insertedCount).toBe(2);
    expect(plan.rows.map((row) => row[1])).toEqual(["IPC_CL", "IPC_CL"]);
  });
});

// Fixture mirrors the real VALUES sheet invariant: sorted by date, then
// code (see compareSheetRows / computeUpsertPlan) -- deliberately includes
// gaps (no 2026-01-12 or 2026-01-14 rows) and a variable number of codes
// per date, since that's the real shape findRateValue has to handle.
const SORTED_FIXTURE_ROWS = [
  [1, "EUR", "2026-01-10", 900, "2026-01-10T12:00:00Z"],
  [2, "USD", "2026-01-10", 850, "2026-01-10T12:00:00Z"],
  [3, "EUR", "2026-01-11", 905, "2026-01-11T12:00:00Z"],
  [4, "USD", "2026-01-11", 855, "2026-01-11T12:00:00Z"],
  [5, "CLF", "2026-01-13", 36000, "2026-01-13T12:00:00Z"],
  [6, "EUR", "2026-01-13", 910, "2026-01-13T12:00:00Z"],
  [7, "USD", "2026-01-13", 860, "2026-01-13T12:00:00Z"],
  [8, "UTM", "2026-01-13", 65000, "2026-01-13T12:00:00Z"],
  [9, "EUR", "2026-01-15", 915, "2026-01-15T12:00:00Z"],
  [10, "USD", "2026-01-15", 865, "2026-01-15T12:00:00Z"],
];

describe("findFirstRowIndexAtOrAfterDate", () => {
  const accessor = createArrayRowAccessor(SORTED_FIXTURE_ROWS);

  it("returns index 0 when the target date is before every row", () => {
    expect(findFirstRowIndexAtOrAfterDate(accessor, "2026-01-01", TZ)).toBe(0);
  });

  it("returns the start of a date's block when the target matches exactly", () => {
    expect(findFirstRowIndexAtOrAfterDate(accessor, "2026-01-13", TZ)).toBe(4);
  });

  it("returns the next block's start when the target date falls in a gap", () => {
    // 2026-01-12 has no rows -- lower bound lands on the first 2026-01-13 row.
    expect(findFirstRowIndexAtOrAfterDate(accessor, "2026-01-12", TZ)).toBe(4);
  });

  it("returns rowCount() when the target date is after every row", () => {
    expect(findFirstRowIndexAtOrAfterDate(accessor, "2026-02-01", TZ)).toBe(10);
  });
});

describe("findRateValue", () => {
  const accessor = createArrayRowAccessor(SORTED_FIXTURE_ROWS);

  it("finds an exact match on the very first row", () => {
    expect(findRateValue(accessor, "EUR", "2026-01-10", TZ)).toBe(900);
  });

  it("finds an exact match on the very last row", () => {
    expect(findRateValue(accessor, "USD", "2026-01-15", TZ)).toBe(865);
  });

  it("finds the right code among several sharing the same date", () => {
    expect(findRateValue(accessor, "UTM", "2026-01-13", TZ)).toBe(65000);
    expect(findRateValue(accessor, "CLF", "2026-01-13", TZ)).toBe(36000);
  });

  it("applies the sheet code alias so callers can ask for UF and get CLF's value", () => {
    expect(findRateValue(accessor, "UF", "2026-01-13", TZ)).toBe(36000);
  });

  it("is case-insensitive on the code", () => {
    expect(findRateValue(accessor, "usd", "2026-01-10", TZ)).toBe(850);
  });

  it("accepts a real Date instance for the date argument, not just a string", () => {
    const date = new Date(Date.UTC(2026, 0, 10, 15, 0, 0)); // noon in America/Santiago
    expect(findRateValue(accessor, "EUR", date, TZ)).toBe(900);
  });

  it("returns null for a code that doesn't exist on an otherwise valid date", () => {
    expect(findRateValue(accessor, "UTM", "2026-01-10", TZ)).toBeNull();
  });

  it("returns null for a date that falls in a gap between existing dates", () => {
    expect(findRateValue(accessor, "USD", "2026-01-12", TZ)).toBeNull();
  });

  it("returns null for a date before the first row", () => {
    expect(findRateValue(accessor, "USD", "2026-01-01", TZ)).toBeNull();
  });

  it("returns null for a date after the last row", () => {
    expect(findRateValue(accessor, "USD", "2026-02-01", TZ)).toBeNull();
  });

  it("returns null when the accessor has zero rows", () => {
    expect(findRateValue(createArrayRowAccessor([]), "USD", "2026-01-10", TZ)).toBeNull();
  });

  it("returns null for missing code or date arguments", () => {
    expect(findRateValue(accessor, "", "2026-01-10", TZ)).toBeNull();
    expect(findRateValue(accessor, "USD", "", TZ)).toBeNull();
  });

  it("returns null instead of NaN when the matched row's value isn't numeric", () => {
    const dirtyRows = [[1, "USD", "2026-01-10", "N/A", "2026-01-10T12:00:00Z"]];
    expect(findRateValue(createArrayRowAccessor(dirtyRows), "USD", "2026-01-10", TZ)).toBeNull();
  });

  it("stays fast on a ~30k-row sheet -- regression guard against reintroducing a linear scan", () => {
    const codes = ["USD", "EUR", "CLF", "UTM", "IPC_CL"];
    const start = new Date(Date.UTC(2010, 0, 1));
    const dayCount = 6000;
    const largeRows = [];
    let id = 0;
    for (let d = 0; d < dayCount; d++) {
      const date = new Date(start.getTime() + d * 86400000).toISOString().slice(0, 10);
      for (const code of codes) {
        id++;
        largeRows.push([id, code, date, 100 + d, date]);
      }
    }
    const largeAccessor = createArrayRowAccessor(largeRows);

    const firstDate = largeRows[0][2];
    const lastDate = largeRows[largeRows.length - 1][2];
    const midDate = largeRows[Math.floor(largeRows.length / 2)][2];

    const startMs = Date.now();
    expect(findRateValue(largeAccessor, "USD", firstDate, TZ)).not.toBeNull();
    expect(findRateValue(largeAccessor, "EUR", lastDate, TZ)).not.toBeNull();
    expect(findRateValue(largeAccessor, "UTM", midDate, TZ)).not.toBeNull();
    expect(findRateValue(largeAccessor, "XYZ", midDate, TZ)).toBeNull();
    const elapsedMs = Date.now() - startMs;

    // A true O(log n) lookup over 30k rows should take low single-digit ms;
    // 50ms leaves generous headroom for slow CI runners while still failing
    // hard if this regresses back to an O(n) scan.
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe("findRateValues", () => {
  const accessor = createArrayRowAccessor(SORTED_FIXTURE_ROWS);

  it("resolves multiple pairs in order, same as calling findRateValue individually", () => {
    const pairs = [
      { code: "EUR", date: "2026-01-10" },
      { code: "USD", date: "2026-01-15" },
      { code: "UTM", date: "2026-01-13" },
    ];
    expect(findRateValues(accessor, pairs, TZ)).toEqual([900, 865, 65000]);
  });

  it("resolves an alias code the same way findRateValue does", () => {
    expect(findRateValues(accessor, [{ code: "UF", date: "2026-01-13" }], TZ)).toEqual([36000]);
  });

  it("returns null at the position of a pair with no match, without affecting other positions", () => {
    const pairs = [
      { code: "EUR", date: "2026-01-10" },
      { code: "USD", date: "2026-01-01" }, // before the first row -- no match
      { code: "UTM", date: "2026-01-13" },
    ];
    expect(findRateValues(accessor, pairs, TZ)).toEqual([900, null, 65000]);
  });

  it("returns null for a malformed pair (null/undefined) without throwing or shifting positions", () => {
    const pairs = [{ code: "EUR", date: "2026-01-10" }, null, undefined, { code: "USD", date: "2026-01-15" }];
    expect(findRateValues(accessor, pairs, TZ)).toEqual([900, null, null, 865]);
  });

  it("returns null for a pair missing code or date", () => {
    const pairs = [
      { code: "", date: "2026-01-10" },
      { code: "EUR", date: "" },
    ];
    expect(findRateValues(accessor, pairs, TZ)).toEqual([null, null]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(findRateValues(accessor, [], TZ)).toEqual([]);
  });
});
