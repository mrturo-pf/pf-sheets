const vm = require("vm");
const { isDateValue_ } = require("../src/interfaces/library");

// Regression test for the "Not found" incident documented in
// plan-get-clp-02-range-batch.md: `value instanceof Date` fails when the
// Date object was constructed in a DIFFERENT Apps Script "realm" (the
// calling project, e.g. Payroll) than the one doing the check (this
// Library, exchange-rates) -- each Apps Script project gets its own V8
// realm with its own Date constructor, so `instanceof` walks a prototype
// chain that simply doesn't match. `vm.runInNewContext` is Node's own
// realm boundary and reproduces the exact same failure mode without
// needing a real multi-project Apps Script deploy to prove the fix.
describe("isDateValue_ (pf-sheets library, cross-realm regression)", () => {
  it("recognizes a Date constructed in a different vm realm", () => {
    const otherRealmDate = vm.runInNewContext("new Date('2024-01-15T00:00:00Z')");

    // Sanity check: this is the actual bug being fixed -- the naive
    // check that broke production fails on a cross-realm Date.
    expect(otherRealmDate instanceof Date).toBe(false);

    // The fix stays correct across the realm boundary.
    expect(isDateValue_(otherRealmDate)).toBe(true);
  });

  it("recognizes a same-realm Date (the common case)", () => {
    expect(isDateValue_(new Date("2024-01-15"))).toBe(true);
  });

  it("rejects non-Date values (the same-realm string/number path GET_CLP relies on)", () => {
    expect(isDateValue_("2024-01-15")).toBe(false);
    expect(isDateValue_(46167)).toBe(false);
    expect(isDateValue_(null)).toBe(false);
    expect(isDateValue_(undefined)).toBe(false);
  });
});
