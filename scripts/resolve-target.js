#!/usr/bin/env node
"use strict";

/**
 * Resolves a target alias (from targets.json) to its clasp config path.
 * Kept as a tiny standalone module so scripts/push-target.sh never has to
 * hand-parse JSON inside a shell string (fragile, hard to test).
 *
 * Usage: node scripts/resolve-target.js <alias>
 */

const fs = require("fs");
const path = require("path");

function resolveTargetConfig(alias, targets) {
  const match = targets.find((entry) => entry.alias === alias);
  if (!match) {
    throw new Error(`No target found for alias: ${alias}`);
  }
  return match.config;
}

function main() {
  const alias = process.argv[2];
  if (!alias) {
    console.error("Usage: resolve-target.js <alias>");
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const targetsPath = path.join(repoRoot, "targets.json");
  const targets = JSON.parse(fs.readFileSync(targetsPath, "utf8"));

  try {
    console.log(resolveTargetConfig(alias, targets));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveTargetConfig };
