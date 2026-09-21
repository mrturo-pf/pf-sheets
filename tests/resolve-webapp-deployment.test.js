const { resolveWebAppDeploymentId } = require("../scripts/resolve-webapp-deployment");

describe("resolveWebAppDeploymentId", () => {
  it("returns the configured deployment ID for a target that has one", () => {
    const targets = [
      { alias: "exchange-rates", config: "clasp-targets/exchange-rates.clasp.json", webAppDeploymentId: "AKfycb-abc123" },
    ];

    expect(resolveWebAppDeploymentId("exchange-rates", targets)).toBe("AKfycb-abc123");
  });

  it("returns an empty string (not an error) for a target with no deployment configured", () => {
    const targets = [{ alias: "some-other-sheet", config: "clasp-targets/some-other-sheet.clasp.json" }];

    expect(resolveWebAppDeploymentId("some-other-sheet", targets)).toBe("");
  });

  it("throws when the alias doesn't exist in targets.json", () => {
    expect(() => resolveWebAppDeploymentId("nonexistent", [])).toThrow("No target found for alias: nonexistent");
  });
});
