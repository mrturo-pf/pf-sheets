const { resolveIsLibrary } = require("../scripts/resolve-is-library");

describe("resolveIsLibrary", () => {
  it("returns \"true\" for a target flagged as a library", () => {
    const targets = [{ alias: "exchange-rates", config: "clasp-targets/exchange-rates.clasp.json", isLibrary: true }];

    expect(resolveIsLibrary("exchange-rates", targets)).toBe("true");
  });

  it("returns an empty string (not an error) for a target with no isLibrary flag", () => {
    const targets = [{ alias: "some-other-sheet", config: "clasp-targets/some-other-sheet.clasp.json" }];

    expect(resolveIsLibrary("some-other-sheet", targets)).toBe("");
  });

  it("returns an empty string for a target with isLibrary explicitly false", () => {
    const targets = [{ alias: "some-other-sheet", config: "clasp-targets/some-other-sheet.clasp.json", isLibrary: false }];

    expect(resolveIsLibrary("some-other-sheet", targets)).toBe("");
  });

  it("throws when the alias doesn't exist in targets.json", () => {
    expect(() => resolveIsLibrary("nonexistent", [])).toThrow("No target found for alias: nonexistent");
  });
});
