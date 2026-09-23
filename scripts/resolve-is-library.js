#!/usr/bin/env node
"use strict";

/**
 * Resolves a target alias (from targets.json) to whether it should be
 * published as an Apps Script Library after every push -- see
 * docs/getting-started.md's "GET_CLP Library" section for why only
 * `exchange-rates` needs this today (it's the project GET_CLP/
 * GET_CLP_RANGE's client logic lives in -- see src/interfaces/library.js
 * and plan-get-clp-02-range-batch.md, "Punto 2"). Prints "true" or an
 * empty string (never an error) so scripts/push-target.sh can treat "not
 * a library" as the normal, expected case for every other target.
 *
 * Deliberately not sharing a helper module with resolve-target.js /
 * resolve-webapp-deployment.js (same reasoning as the latter: a few
 * lines of duplication is safer than touching scripts already relied on
 * by CI).
 *
 * Usage: node scripts/resolve-is-library.js <alias>
 */

const fs = require("fs");
const path = require("path");

function resolveIsLibrary(alias, targets) {
  const match = targets.find((entry) => entry.alias === alias);
  if (!match) {
    throw new Error(`No target found for alias: ${alias}`);
  }
  return match.isLibrary ? "true" : "";
}

function main() {
  const alias = process.argv[2];
  if (!alias) {
    console.error("Usage: resolve-is-library.js <alias>");
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const targetsPath = path.join(repoRoot, "targets.json");
  const targets = JSON.parse(fs.readFileSync(targetsPath, "utf8"));

  try {
    console.log(resolveIsLibrary(alias, targets));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveIsLibrary };
