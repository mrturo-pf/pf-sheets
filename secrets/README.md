# secrets/ (pf-sheets, local-only)

Module-scoped, machine-local secrets for `pf-sheets`. Everything placed in
this folder — including new subfolders — is gitignored by default (see
`.gitignore` right here): only this `README.md` and the `.gitignore` itself
can ever be committed.

## This is NOT where the real clasp/OAuth credentials live

`pf-sheets`'s actual live credentials follow a different, already-documented
convention — don't duplicate them here:

- `.clasprc.json` at the **module root** (`../.clasprc.json`, already
  gitignored via `../.gitignore`) is what the `clasp` CLI reads directly —
  it must stay at that exact path/name for `clasp` to find it.
- A synced backup copy lives at the **ecosystem root**,
  `../../../secrets/pf-sheets/clasprc.json`, alongside the OAuth Desktop
  Client ID JSON (`client_secret_*.json`). See
  [`../../../secrets/README.md`](../../../secrets/README.md) and
  [`../docs/ci.md`](../docs/ci.md) for the full setup/rotation flow.

This local folder is only for anything narrower and disposable that doesn't
fit either of those — a one-off script credential, a local test Sheet ID,
etc. Empty today; nothing here yet.

## Rules

- Never hardcode a path to a file here inside committed code — read it from
  an environment variable.
- If you're tempted to put `.clasprc.json` here instead of at the module
  root: don't — `clasp` won't find it there. Keep using `../.clasprc.json`.
