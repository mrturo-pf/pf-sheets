#!/usr/bin/env bash
# Pushes src/ to one Apps Script project, identified by an alias in
# targets.json. This is how one repo manages N Apps Script projects
# (N scriptIds) from a single shared src/ tree — see
# docs/development.md for the full multi-target model.
#
# Usage: scripts/push-target.sh <alias>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <alias>" >&2
  exit 1
fi

alias_name="$1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# clasp reads/writes credentials wherever `clasp_config_auth` points (see
# docs/ci.md#clasp-version-pinned-exactly-not-a-range) — default to the
# repo-local file so this never depends on the caller's $HOME, but let an
# already-exported value (e.g. a CI step restoring the secret elsewhere) win.
export clasp_config_auth="${clasp_config_auth:-${repo_root}/.clasprc.json}"

config_path="$(node "${repo_root}/scripts/resolve-target.js" "${alias_name}")"
full_config_path="${repo_root}/${config_path}"

if [[ ! -f "${full_config_path}" ]]; then
  echo "Clasp config not found: ${full_config_path}" >&2
  exit 1
fi

echo "==> Pushing target '${alias_name}' using ${config_path}"
cp "${full_config_path}" "${repo_root}/.clasp.json"
(cd "${repo_root}" && npx clasp push --force)
echo "==> Done: ${alias_name}"

# Redeploy the Web App, if this target has one configured (see
# targets.json's optional webAppDeploymentId -- today only
# 'exchange-rates' has one, for GET_CLP; see
# docs/getting-started.md#get_clp-web-app-deployment-once-per-apps-script-project).
# `clasp push` alone does NOT update a live Web App URL's served code --
# a Web App deployment freezes a specific version at deploy time, so this
# step is what actually makes new doGet code reachable at the existing
# URL. `-i <id>` reuses the same deployment/URL instead of creating a
# brand new one.
webapp_deployment_id="$(node "${repo_root}/scripts/resolve-webapp-deployment.js" "${alias_name}")"
if [[ -n "${webapp_deployment_id}" ]]; then
  echo "==> Redeploying Web App for '${alias_name}' (deployment ${webapp_deployment_id})"
  (cd "${repo_root}" && npx clasp deploy -i "${webapp_deployment_id}" -d "CI redeploy: ${GITHUB_SHA:-local}")
  echo "==> Web App redeployed: ${alias_name}"
fi

# Cut a new immutable Library version, if this target is published as one
# (see targets.json's optional isLibrary flag -- today only
# 'exchange-rates' is, for GET_CLP/GET_CLP_RANGE's client code in
# src/interfaces/library.js -- see docs/getting-started.md's "GET_CLP
# Library" section). A Library reference in a consuming project is always
# pinned to a specific version number -- Apps Script has no supported
# "always use HEAD" option for production custom-function calls (see
# plan-get-clp-01-webapp.md's Fase 1.5) -- so `clasp push` alone does NOT
# make new library code reachable by consumers; a fresh version has to
# exist for someone to point a consumer at it (see
# docs/ci.md#library-version-cut-get_clpget_clp_range).
is_library="$(node "${repo_root}/scripts/resolve-is-library.js" "${alias_name}")"
if [[ -n "${is_library}" ]]; then
  echo "==> Cutting a new Library version for '${alias_name}'"
  (cd "${repo_root}" && npx clasp version "CI: ${GITHUB_SHA:-local}")
  echo "==> Library version cut: ${alias_name}"
fi
