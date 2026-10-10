# AGENTS.md — pf-sheets

Google Apps Script (bound to a Google Sheet) source, versioned in Git and deployed via
`clasp`. Not a FastAPI microservice — this is glue code that syncs
[`pf-rates`](../pf-rates) exchange-rate data into a spreadsheet.

## Scope

This file governs implementation, testing, documentation, and operations inside
`pf-sheets`. Ecosystem ownership boundaries and cross-repository coordination are defined
in the root [`AGENTS.md`](../../AGENTS.md). This file owns the Apps Script-specific details.

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

## Test-driven development

Use TDD for behavioral changes. Develop domain and infrastructure behavior with test-first Jest tests, using Outside-In or ATDD when a feature changes an observable macro or HTTP contract. Use BDD Given/When/Then scenarios only when they improve communication of business behavior.

Keep domain tests pure, infrastructure tests focused on injected fakes, and interface validation as smoke tests or real Apps Script execution where bare Apps Script globals are required. Documentation-only, formatting-only, and mechanical refactor changes do not require new tests but must run applicable checks.

## CLI policy

Do not implement, add, restore, or expand any product-facing CLI command in `pf-sheets`. Existing development, deployment, and automation commands such as `make`, `clasp`, and repository scripts may still be used unless explicitly prohibited. Use the supported Apps Script interfaces and existing automation instead. Any exception requires explicit user approval first.


Before any interaction with GitHub using `gh`, including read-only commands, execute
`unset-proxies` first:

```bash
unset-proxies
```

The alias is defined in `~/.zshrc` as:

```bash
alias unset-proxies="source $HOME/Documents/scripts/unset_proxies.sh"
```

If aliases are unavailable in the current shell, run:

```bash
source "$HOME/Documents/scripts/unset_proxies.sh"
```

Only then run `gh`. This applies to every `gh` command in this repository.


- [`docs/api.md`](docs/api.md) must describe the real behavior of the
  `GET_CLP`/`GET_CLP_RANGE` Apps Script Web App HTTP endpoints (`doGet`/`doPost` in
  `src/interfaces/webapp.js`) — any change to query params, response shape, or error
  strings requires updating `docs/api.md` in the **same change**, not "later".
- These endpoints are also mirrored in the shared Postman collection at the ecosystem
  root: `pf-base/postman/pf-ecosystem.postman_collection.json` (the
  `pf_sheets_webapp_url`/`pf_sheets_api_key` collection variables — pf-sheets has no
  local/gcp environment split, one Web App deployment covers both). Update that
  collection too in the same change when practical — see `pf-base/postman/README.md`
  for the sync mechanics and `pf-base/AGENTS.md` for the ecosystem-wide version of
  this rule.

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
- **Deploy:** `clasp push` for every target, plus `clasp deploy -i <id>` for any
  target that has a `webAppDeploymentId` configured in `targets.json` (today: only
  `exchange-rates`, to serve `GET_CLP` -- see `docs/getting-started.md`). Targets with
  no Web App skip that step entirely; `clasp push` alone was sufficient before
  `GET_CLP` existed and still is for the sync macro itself.
- **Auth secret:** `CLASP_CREDENTIALS` (a `.clasprc.json` generated once via
  `clasp login --creds`, never regenerated per push).

## Versioning and operations

- SemVer; Conventional Commits (English).
- Never autonomously commit, push branches, create issues, or open PRs — requires
  explicit user command.
- **Post-push monitoring:** before pushing, inspect the target workflow and cancel older superseded runs for the same repository, branch, and workflow. Cancel only active runs (`queued`, `pending`, `in_progress`, or `waiting`) using the actual status field; never cancel completed runs or runs from another branch/workflow. Verify each cancellation before pushing, then monitor the new run by exact SHA/run ID with `gh run watch`. Manual deployment approval requires explicit user authorization.
- **Network resilience:** if `gh`/GitHub is unreachable while monitoring (VPN/proxy
  hiccups happen), retry a couple of times with a short wait, then stop — never loop
  indefinitely, and never assume a push/cancel/approval-check succeeded just because
  an earlier command in the same sequence did. Report the blocker to the user
  explicitly and wait for them to fix connectivity or ask for a retry.

## Database

None — this repo has no database of its own. It calls `pf-rates` over HTTP
(`POST /exports/financial-data`) and writes only to the Google Sheet grid (`VALUES` tab).
`pf-db` remains the schema and migration owner for the underlying exchange-rate and
economic-index data; `pf-rates` owns the corresponding application domain and HTTP API
(see [`pf-db`](../pf-db) for the real source of truth).
