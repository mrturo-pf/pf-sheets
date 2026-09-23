const interfaces = require("../src/interfaces");
const webapp = require("../src/interfaces/webapp");
const library = require("../src/interfaces/library");

// interfaces/ is intentionally NOT exercised end-to-end here — it's the
// one file allowed to touch the bare Apps Script globals directly (see
// its header comment), so calling updateExchangeRates() would require
// faking all five of them at once for very little signal. This smoke test
// just guards against the file failing to load/export at all; real
// coverage lives in domain.test.js and infrastructure.test.js.
describe("interfaces (pf-sheets)", () => {
  it("exposes onOpen and updateExchangeRates as functions", () => {
    expect(typeof interfaces.onOpen).toBe("function");
    expect(typeof interfaces.updateExchangeRates).toBe("function");
  });
});

// Same rationale as above, applied to the Web App entry points: doGet
// and doPost touch SpreadsheetApp/PropertiesService/ContentService/
// CacheService directly, so they're validated end-to-end against the
// real deployment (not with faked globals here).
describe("interfaces/webapp (pf-sheets)", () => {
  it("exposes doGet and doPost as functions", () => {
    expect(typeof webapp.doGet).toBe("function");
    expect(typeof webapp.doPost).toBe("function");
  });
});

// Same rationale again, applied to the Library entry points: GET_CLP and
// GET_CLP_RANGE touch UrlFetchApp/PropertiesService/SpreadsheetApp/
// Utilities directly, validated end-to-end from a real consuming Apps
// Script project (see docs/design-notes.md, Why GET_CLP/GET_CLP_RANGE's
// client code is distributed as an Apps Script Library).
describe("interfaces/library (pf-sheets)", () => {
  it("exposes GET_CLP and GET_CLP_RANGE as functions", () => {
    expect(typeof library.GET_CLP).toBe("function");
    expect(typeof library.GET_CLP_RANGE).toBe("function");
  });
});
