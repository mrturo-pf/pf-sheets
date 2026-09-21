const {
  getConfig,
  triggerFinancialDataExport,
  fetchCsvRows,
  readExistingRows,
  writeRows,
  getActiveSpreadsheet,
  showAlert,
  getGetClpApiKey,
  createSheetRowAccessor,
} = require("../src/infrastructure");

describe("getConfig", () => {
  it("reads all three properties from the injected PropertiesService", () => {
    const store = {
      PF_RATES_BASE_URL: "https://pf-rates.example.com",
      PF_RATES_API_KEY: "secret-key",
      EXPORT_DRIVE_FILE_ID: "drive-file-id",
    };
    const fakePropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => store[key],
      }),
    };

    expect(getConfig(fakePropertiesService)).toEqual({
      apiBaseUrl: "https://pf-rates.example.com",
      apiKey: "secret-key",
      driveFileId: "drive-file-id",
    });
  });
});

describe("triggerFinancialDataExport", () => {
  it("posts the payload with the X-API-Key header and returns status + body", () => {
    const fetchCalls = [];
    const fakeUrlFetchApp = {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => '{"ok":true}',
        };
      },
    };

    const result = triggerFinancialDataExport(
      fakeUrlFetchApp,
      { apiBaseUrl: "https://pf-rates.example.com", apiKey: "secret-key" },
      { lookback_days: 90, forward_days: 30 }
    );

    expect(result).toEqual({ statusCode: 200, body: '{"ok":true}' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://pf-rates.example.com/exports/financial-data");
    expect(fetchCalls[0].options.headers["X-API-Key"]).toBe("secret-key");
    expect(JSON.parse(fetchCalls[0].options.payload)).toEqual({ lookback_days: 90, forward_days: 30 });
    expect(fetchCalls[0].options.muteHttpExceptions).toBe(true);
  });
});

describe("fetchCsvRows", () => {
  it("downloads the file and parses it as CSV via the injected Utilities", () => {
    const fakeDriveApp = {
      getFileById: (fileId) => ({
        getBlob: () => ({
          getDataAsString: () => `currency_code,rate_date,value_clp\nUSD,2026-01-14,950\n`,
        }),
      }),
    };
    const fakeUtilities = {
      parseCsv: (content) => content.trim().split("\n").map((line) => line.split(",")),
    };

    const rows = fetchCsvRows(fakeDriveApp, fakeUtilities, "some-file-id");

    expect(rows).toEqual([
      ["currency_code", "rate_date", "value_clp"],
      ["USD", "2026-01-14", "950"],
    ]);
  });
});

describe("readExistingRows", () => {
  it("returns an empty array when the sheet has only a header row", () => {
    const fakeSheet = { getLastRow: () => 1 };
    expect(readExistingRows(fakeSheet)).toEqual([]);
  });

  it("reads the 5-column range starting at row 2", () => {
    const getRangeCalls = [];
    const fakeSheet = {
      getLastRow: () => 3,
      getRange: (...args) => {
        getRangeCalls.push(args);
        return { getValues: () => [[1, "USD", "2026-01-14", 950, "ts"]] };
      },
    };

    const rows = readExistingRows(fakeSheet);

    expect(getRangeCalls[0]).toEqual([2, 1, 2, 5]);
    expect(rows).toEqual([[1, "USD", "2026-01-14", 950, "ts"]]);
  });
});

describe("writeRows", () => {
  it("does nothing when there are no rows to write", () => {
    const fakeSheet = { getRange: jest.fn() };
    writeRows(fakeSheet, []);
    expect(fakeSheet.getRange).not.toHaveBeenCalled();
  });

  it("writes the values and formats the last_modified_at column", () => {
    const setValuesCalls = [];
    const setNumberFormatCalls = [];
    const fakeSheet = {
      getRange: (row, col, numRows, numCols) => {
        if (numCols === 5) {
          return { setValues: (values) => setValuesCalls.push(values) };
        }
        return { setNumberFormat: (format) => setNumberFormatCalls.push(format) };
      },
    };

    const rows = [[1, "USD", "2026-01-14", 950, new Date()]];
    writeRows(fakeSheet, rows);

    expect(setValuesCalls).toEqual([rows]);
    expect(setNumberFormatCalls).toEqual(["yyyy-mm-dd hh:mm:ss"]);
  });
});

describe("getActiveSpreadsheet / showAlert", () => {
  it("delegates to the injected SpreadsheetApp", () => {
    const fakeSpreadsheet = { id: "sheet-1" };
    const fakeSpreadsheetApp = { getActiveSpreadsheet: () => fakeSpreadsheet };
    expect(getActiveSpreadsheet(fakeSpreadsheetApp)).toBe(fakeSpreadsheet);
  });

  it("shows an alert via SpreadsheetApp.getUi()", () => {
    const alertCalls = [];
    const fakeSpreadsheetApp = {
      getUi: () => ({ alert: (message) => alertCalls.push(message) }),
    };

    showAlert(fakeSpreadsheetApp, "something went wrong");

    expect(alertCalls).toEqual(["something went wrong"]);
  });
});

describe("getGetClpApiKey", () => {
  it("reads GET_CLP_API_KEY from the injected PropertiesService", () => {
    const fakePropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => (key === "GET_CLP_API_KEY" ? "shh-its-a-secret" : undefined),
      }),
    };

    expect(getGetClpApiKey(fakePropertiesService)).toBe("shh-its-a-secret");
  });

  it("returns whatever falsy value PropertiesService gives back when unset", () => {
    const fakePropertiesService = {
      getScriptProperties: () => ({ getProperty: () => null }),
    };

    expect(getGetClpApiKey(fakePropertiesService)).toBeNull();
  });
});

describe("createSheetRowAccessor", () => {
  it("reports zero rows when the sheet only has a header row", () => {
    const fakeSheet = { getLastRow: () => 1 };
    expect(createSheetRowAccessor(fakeSheet).rowCount()).toBe(0);
  });

  it("reports zero rows for a completely empty sheet", () => {
    const fakeSheet = { getLastRow: () => 0 };
    expect(createSheetRowAccessor(fakeSheet).rowCount()).toBe(0);
  });

  it("computes rowCount as lastRow - 1 (excluding the header)", () => {
    const fakeSheet = { getLastRow: () => 4 };
    expect(createSheetRowAccessor(fakeSheet).rowCount()).toBe(3);
  });

  it("reads exactly one 5-column row at the +2 offset per getRow call, not the whole sheet", () => {
    const getRangeCalls = [];
    const fakeSheet = {
      getLastRow: () => 4,
      getRange: (...args) => {
        getRangeCalls.push(args);
        return { getValues: () => [[3, "USD", "2026-01-16", 860, "ts"]] };
      },
    };

    const row = createSheetRowAccessor(fakeSheet).getRow(2);

    expect(getRangeCalls).toEqual([[4, 1, 1, 5]]);
    expect(row).toEqual([3, "USD", "2026-01-16", 860, "ts"]);
  });
});
