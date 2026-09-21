const {
  normalizeDateKey,
  parseRateValue,
  resolveCsvColumns,
  parseCsvDataRow,
  buildRegistryIndex,
  computeUpsertPlan,
  resolveCombinedCsvColumns,
  applySheetCodeAlias,
  extractEconomicIndexCsvRows,
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
    expect(plan.rows[1]).toEqual([6, "EUR", "2026-01-14", 1020, executionTimestamp]);
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

describe("extractEconomicIndexCsvRows", () => {
  it("applies the configured code alias (UF -> CLF) while leaving other codes untouched", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["ECONOMIC_INDEX", "UF", "2026-01-14", "38000.12"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.economicIndexCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["CLF", "2026-01-14", "38000.12"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("trims and upper-cases every code, aliased or not, regardless of how pf-rates sent it", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["ECONOMIC_INDEX", " uf ", "2026-01-14", "38000.12"],
      ["ECONOMIC_INDEX", "ipc_cl", "2026-01-14", "125.5"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.economicIndexCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["CLF", "2026-01-14", "38000.12"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("extracts ECONOMIC_INDEX rows into a legacy-shaped CSV, dropping EXCHANGE_RATE rows without flagging them as skipped", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "USD", "2026-01-14", "950"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
      ["EXCHANGE_RATE", "EUR", "2026-01-14", "1020"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.isComplete).toBe(true);
    expect(result.skippedRowNumbers).toEqual([]);
    expect(result.economicIndexCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("is case-insensitive on the series_type value", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["economic_index", "IPC_CL", "2026-01-14", "125.5"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.economicIndexCsvRows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["IPC_CL", "2026-01-14", "125.5"],
    ]);
  });

  it("skips rows with an unrecognized series_type and reports their line number", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "USD", "2026-01-14", "950"],
      ["SOMETHING_ELSE", "XYZ", "2026-01-14", "1"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.skippedRowNumbers).toEqual([3]);
    expect(result.economicIndexCsvRows).toHaveLength(1); // header only
  });

  it("skips rows with too few columns and reports their line number", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["EXCHANGE_RATE", "USD", "2026-01-14"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.skippedRowNumbers).toEqual([2]);
  });

  it("returns isComplete=false and an empty result when the header is missing columns", () => {
    const combinedCsvRows = [
      ["series_type", "code"],
      ["EXCHANGE_RATE", "USD"],
    ];

    const result = extractEconomicIndexCsvRows(combinedCsvRows);

    expect(result.isComplete).toBe(false);
    expect(result.economicIndexCsvRows).toEqual([["currency_code", "rate_date", "value_clp"]]);
  });

  it("produces output that computeUpsertPlan can consume unchanged (end-to-end)", () => {
    const combinedCsvRows = [
      ["series_type", "code", "period_date", "value"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-14", "125.5"],
      ["ECONOMIC_INDEX", "IPC_CL", "2026-01-15", "125.5"],
    ];
    const extraction = extractEconomicIndexCsvRows(combinedCsvRows);
    const columnResolution = resolveCsvColumns(extraction.economicIndexCsvRows[0]);

    const plan = computeUpsertPlan({
      existingRows: [],
      csvRows: extraction.economicIndexCsvRows,
      columns: columnResolution.columns,
      timeZone: TZ,
      executionTimestamp: new Date("2026-01-15T12:00:00Z"),
    });

    expect(plan.insertedCount).toBe(2);
    expect(plan.rows.map((row) => row[1])).toEqual(["IPC_CL", "IPC_CL"]);
  });
});
