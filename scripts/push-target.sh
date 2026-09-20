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
