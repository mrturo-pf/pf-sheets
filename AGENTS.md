# AGENTS.md — pf-sheets

Google Apps Script (bound to a Google Sheet) source, versioned in Git and deployed via
`clasp`. Not a FastAPI microservice — this is glue code that syncs
[`pf-rates`](../pf-rates) exchange-rate data into a spreadsheet.

## Purpose

Replaces the previous workflow (editing directly in script.google.com) with: develop
locally → push via CI on merge to `main`. The result stays a macro the user runs
manually from the Sheet's custom menu — only the development/deploy model changes, not
the execution model.

## Architecture

Google Apps Script has no real module system and no ports/DTOs, but the same
domain-vs-I/O separation used in `pf-rates`/`pf-payroll` still applies, adapted:

```
src/
├── domain/          # pure functions — zero Apps Script globals, unit-testable with Jest/Node
├── infrastructure/  # adapters over SpreadsheetApp/DriveApp/UrlFetchApp/PropertiesService
├── interfaces/      # entry points Apps Script calls: updateExchangeRates(), onOpen()
└── appsscript.json  # manifest — versioned, reconciled via `clasp pull`, never hand-invented
```

- `domain/` must never reference `SpreadsheetApp`, `DriveApp`, `UrlFetchApp`,
  `PropertiesService`, or `Utilities` — that boundary is what makes it testable outside
  the Apps Script runtime.
- `infrastructure/` and `interfaces/` are the only layers allowed to touch those globals.
- Apps Script flattens all files into one global scope regardless of folder — folders
  are a display/organizational convenience in the web editor, not a real module
  boundary. Filenames stay unique via their relative path (`domain/index`,
  `infrastructure/index`, ...), so no collisions.

### Dual-environment export guard

Files under `src/` are pushed as-is into Apps Script by `clasp`, which has no
`module`/`require`. Every file that needs to export something for Jest must guard it:

```js
if (typeof module !== "undefined") {
  module.exports = { myFunction };
}
```

`typeof module` never throws even when `module` doesn't exist (unlike a bare
reference), so this line is a safe no-op inside the real Apps Script runtime and a
normal CommonJS export inside Node/Jest.

## Multi-target deploy (scaling to N documents)

This repo can push the *same* `src/` tree to more than one Apps Script project (one per
Google Sheet) without duplicating code — see
[`docs/development.md`](docs/development.md#adding-a-new-documenttarget-scaling-to-n-sheets)
for the full model. In short:

- `targets.json` lists every `{ alias, config }` pair.
- `clasp-targets/<alias>.clasp.json` holds each target's `scriptId` (not a secret —
  safe to version).
- `scripts/push-target.sh <alias>` copies the right config into `.clasp.json` (the file
  `clasp` actually reads) and runs `clasp push`.
- Adding a document is pure config: new bound script → new `scriptId` → new
  `clasp-targets/*.clasp.json` entry + `targets.json` entry. No code changes.

## Language policy

- All code, identifiers, comments, and docstrings: English.
- Exception: preserve official Chilean regulatory terms/source literals only when
  translation would alter meaning (rarely applies here — this repo has no regulatory
  data of its own).

## Code style

- ESLint flat config (`eslint.config.js`) — plain JS (ES2021), no TypeScript build step
  (YAGNI — the script is simple enough that a transpilation step isn't worth the
  pipeline complexity yet).
- JSDoc-style block comments required for every exported function.
- Keep using `console.*` for diagnostics (goes to Cloud Logging in Apps Script, same as
  the legacy script); summarize user-facing outcomes via
  `SpreadsheetApp.getActiveSpreadsheet().toast(...)`.

## Design principles

- Apply DRY, SOLID, Clean Code — avoid god functions; the original macro was a single
  ~250-line function and was split into small, focused, pure pieces during migration.
- No silent fallbacks: if the CSV is missing required columns or the sheet tab doesn't
  exist, fail loudly (`SpreadsheetApp.getUi().alert(...)`), same as today.
- Secrets (the `pf-rates` API key, the Drive `fileId`) never live in source — they come
  from `PropertiesService.getScriptProperties()`, set once manually per Apps Script
  project (see [`docs/getting-started.md`](docs/getting-started.md)).
- **Cloud cost is always the priority in cloud decisions**: this repo introduces $0 of
  new infrastructure. Apps Script execution is free within quota; the CI runner is a
  standard ephemeral GitHub Actions job already covered by the ecosystem's existing
  usage. See [`docs/ci.md`](docs/ci.md).

## Development commands

See [`docs/development.md`](docs/development.md) for the full workflow. Quick reference:

```bash
make install                     # npm install
make check                       # lint + test
make push ALIAS=exchange-rates   # manual push to one target (normally CI does this)
```

## CI/CD pipeline

See [`docs/ci.md`](docs/ci.md) for the complete guide: pipeline jobs, the `clasp`
non-interactive auth mechanism (OAuth "Desktop app" + refresh token, same pattern as
`pf-rates`'s Google Drive export), secret rotation, and rollback (revert the commit,
let the pipeline `clasp push` the old code again — there is no Cloud Run-style traffic
rollback here).

Quick reference:

- **Trigger:** push to `main` (after manual approval via the `production` GitHub
  environment).
- **Deploy:** `clasp push` only (no versioned `clasp deploy` for now — YAGNI).
- **Auth secret:** `CLASP_CREDENTIALS` (a `.clasprc.json` generated once via
  `clasp login --creds`, never regenerated per push).

## Versioning and operations

- SemVer; Conventional Commits (English).
- Never autonomously commit, push branches, create issues, or open PRs — requires
  explicit user command.

## Database

None — this repo has no database of its own. It calls `pf-rates` over HTTP
(`POST /exports/financial-data`) and writes only to the Google Sheet grid (`VALUES` tab); `pf-rates`
remains the schema owner for the underlying exchange-rate and economic-index data (see
[`pf-db`](../pf-db) for the real source of truth).
