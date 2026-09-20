module.exports = {
  testEnvironment: "node",
  collectCoverageFrom: ["src/domain/**/*.js", "src/infrastructure/**/*.js"],
  coverageThreshold: {
    // src/interfaces/ is intentionally excluded — it's the composition
    // root that touches the real Apps Script globals directly, validated
    // by running the pushed macro for real (see docs/ci.md), not by unit
    // tests. See tests/interfaces.test.js for why it only gets a smoke
    // test. domain/ and infrastructure/ carry the real coverage bar.
    global: {
      statements: 100,
      lines: 100,
      functions: 100,
      branches: 90,
    },
  },
};
