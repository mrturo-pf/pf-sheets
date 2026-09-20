"use strict";

/**
 * ESLint flat config for pf-sheets.
 *
 * `src/domain/` must stay free of Google Apps Script globals (SpreadsheetApp,
 * DriveApp, UrlFetchApp, PropertiesService, Utilities) — that boundary is what
 * keeps it unit-testable with plain Jest/Node. `src/infrastructure/` and
 * `src/interfaces/` are the only layers allowed to reference them.
 *
 * `module`/`require` are allowed (but not required) in src/ files only to
 * support the dual-environment export guard documented in AGENTS.md:
 *   if (typeof module !== "undefined") { module.exports = {...}; }
 */
const gasGlobals = {
  SpreadsheetApp: "readonly",
  DriveApp: "readonly",
  UrlFetchApp: "readonly",
  PropertiesService: "readonly",
  Utilities: "readonly",
};

const nodeInteropGlobals = {
  module: "readonly",
  require: "readonly",
  console: "readonly",
};

module.exports = [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: { ...nodeInteropGlobals },
    },
    rules: {
      "no-unused-vars": "warn",
    },
  },
  {
    files: ["src/infrastructure/**/*.js", "src/interfaces/**/*.js"],
    languageOptions: {
      globals: { ...nodeInteropGlobals, ...gasGlobals },
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        describe: "readonly",
        test: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        jest: "readonly",
      },
    },
  },
  {
    files: ["eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: { module: "readonly", require: "readonly" },
    },
  },
];
