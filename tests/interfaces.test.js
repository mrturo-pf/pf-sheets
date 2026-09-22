const interfaces = require("../src/interfaces");
const webapp = require("../src/interfaces/webapp");

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
// real deployment (see plan-get-clp-01-webapp.md "Verificación final" and
// plan-get-clp-02-range-batch.md), not with faked globals here.
describe("interfaces/webapp (pf-sheets)", () => {
  it("exposes doGet and doPost as functions", () => {
    expect(typeof webapp.doGet).toBe("function");
    expect(typeof webapp.doPost).toBe("function");
  });
});
