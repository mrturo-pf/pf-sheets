#!/usr/bin/env node
"use strict";

/**
 * Resolves a target alias (from targets.json) to its Web App deployment
 * ID, if that target has one configured. Not every target needs a Web
 * App -- see docs/getting-started.md's "GET_CLP Web App deployment"
 * section for why only `exchange-rates` has one today. Prints an empty
 * string (not an error) when a target has no deployment configured, so
 * scripts/push-target.sh can treat "no Web App for this target" as a
 * normal, expected case instead of a failure.
 *
 * Deliberately not sharing a helper module with resolve-target.js (both
 * read targets.json the same way) -- that file is already relied on by
 * every existing CI deploy; a small, self-contained duplication here is
 * safer than touching its internals for a few shared lines.
 *
 * Usage: node scripts/resolve-webapp-deployment.js <alias>
 */

const fs = require("fs");
const path = require("path");

function resolveWebAppDeploymentId(alias, targets) {
  const match = targets.find((entry) => entry.alias === alias);
  if (!match) {
    throw new Error(`No target found for alias: ${alias}`);
  }
  return match.webAppDeploymentId || "";
}

function main() {
  const alias = process.argv[2];
  if (!alias) {
    console.error("Usage: resolve-webapp-deployment.js <alias>");
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const targetsPath = path.join(repoRoot, "targets.json");
  const targets = JSON.parse(fs.readFileSync(targetsPath, "utf8"));

  try {
    console.log(resolveWebAppDeploymentId(alias, targets));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveWebAppDeploymentId };
