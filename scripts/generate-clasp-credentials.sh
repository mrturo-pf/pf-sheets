#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUTPUT_FILE="$REPO_ROOT/secrets/clasprc.json"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/generate-clasp-credentials.sh /path/to/oauth-desktop-client.json

The OAuth client JSON is used only by clasp. The generated refresh-token file is
written to pf-sheets/secrets/clasprc.json. No credential contents are printed.
USAGE
}

[[ "${1:-}" != "" && "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 2
}

OAUTH_CLIENT_FILE="$1"
[[ -f "$OAUTH_CLIENT_FILE" ]] || {
  printf 'OAuth client file not found: %s\n' "$OAUTH_CLIENT_FILE" >&2
  exit 1
}
OAUTH_CLIENT_FILE="$(cd -- "$(dirname -- "$OAUTH_CLIENT_FILE")" && pwd)/$(basename -- "$OAUTH_CLIENT_FILE")"
command -v jq >/dev/null 2>&1 || { printf 'Missing command: jq\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'Missing command: npm\n' >&2; exit 1; }

jq -e 'type == "object" and (.installed or .web)' "$OAUTH_CLIENT_FILE" >/dev/null || {
  printf 'The input is not a Google OAuth Desktop/Web client JSON file.\n' >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT_FILE")"
if [[ -e "$OUTPUT_FILE" ]]; then
  read -r -p "$OUTPUT_FILE exists. Replace it? [y/N] " confirmation
  [[ "$confirmation" == "y" || "$confirmation" == "Y" ]] || {
    printf 'cancelled=true\n'
    exit 0
  }
  unset confirmation
fi

printf 'Starting interactive clasp OAuth login. No credential values will be printed.\n'
(cd "$REPO_ROOT" && \
  clasp_config_auth="$OUTPUT_FILE" \
  npx --no-install clasp login --creds "$OAUTH_CLIENT_FILE" --no-localhost)

[[ -s "$OUTPUT_FILE" ]] || {
  printf 'clasp did not create %s\n' "$OUTPUT_FILE" >&2
  exit 1
}
chmod 600 "$OUTPUT_FILE"
jq -e 'type == "object"' "$OUTPUT_FILE" >/dev/null || {
  printf 'Generated clasp credentials are not valid JSON.\n' >&2
  exit 1
}

printf 'status=completed\n'
printf 'generated_file=%s\n' "$OUTPUT_FILE"
printf 'next_step=run clasp_config_auth=%q npx --no-install clasp login --status\n' "$OUTPUT_FILE"
