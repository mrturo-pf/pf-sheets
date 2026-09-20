# Development

## Code layout

```
src/
├── domain/          # pure functions, no Apps Script globals — unit-tested with Jest
├── infrastructure/  # SpreadsheetApp/DriveApp/UrlFetchApp/PropertiesService adapters
├── interfaces/      # updateExchangeRates(), onOpen() — thin entry points
└── appsscript.json  # manifest, reconciled via `clasp pull`
```

See [`../AGENTS.md`](../AGENTS.md#architecture) for the layering rules and the
dual-environment export guard every `src/` file must use.

## Testing

- `domain/` functions are plain Node-testable — no mocks needed, just inputs/outputs.
- `infrastructure/` functions take the Apps Script global (e.g. `SpreadsheetApp`) as a
  parameter instead of referencing it directly, so tests can pass a lightweight fake.
- `interfaces/` is the composition root (the only file touching bare Apps Script
  globals) — it gets a smoke test only, not full coverage; validated for real by
  running the pushed macro (see [`ci.md`](ci.md)).
- Run `make test` (`npx jest`) or `make check` (lint + coverage-enforced test).

### Coverage threshold

`jest.config.js` enforces **100% statements/lines/functions and 90%+ branches** on
`src/domain/` and `src/infrastructure/` (the two testable-in-isolation layers).
`src/interfaces/` is excluded from the threshold on purpose — see the comment in
`jest.config.js`. `npm run test:coverage` (or `make check`) fails the build if either
layer drops below the bar; this is what "zero coverage, single ~250-line monolithic
function" turns into once it's actually enforced.

## Adding a new document/target (scaling to N Sheets)

Apps Script has a hard constraint: a **bound script** lives 1:1 attached to a single
container document. There is no native way to link one Apps Script project to several
Sheets at once, and `clasp` reflects that (one `.clasp.json` = one `scriptId` = one
document). So "scaling to N documents" means **N Apps Script projects managed from
this one repo**, not one project spanning several Sheets.

### Models considered

| Model | How it works | Verdict |
| --- | --- | --- |
| **A. Multi-target push (chosen)** | One repo/source tree; N `scriptId`s (one per document); CI pushes the same code to each. | Preserves the manual-macro-per-Sheet execution model without duplicating code. |
| B. Apps Script Library | A standalone project publishes the logic as a versioned library; each Sheet has a minimal bound script that calls it. | Discarded for now — adds library versioning, latency, and permission quirks that aren't justified with 1-2 documents. Reconsider if logic ever diverges per document. |
| C. Standalone config-driven | One non-bound project, triggered by a time-based trigger, iterates `spreadsheetId`s from config. | Discarded — changes the execution model (stops being a macro the user runs by hand), which this project must preserve. |

### How Model A works in practice

1. **One source tree (`src/`).** The logic in `domain/`, `infrastructure/`,
   `interfaces/` is identical for every document — there are no N copies of the code,
   just N push *destinations*.
2. **N clasp configs, not N repos** — one per document in
   `clasp-targets/<alias>.clasp.json`, each with its own `scriptId` but the same
   `rootDir` (`./src`). `targets.json` at the repo root is the single source of truth:
   `[{ "alias": "exchange-rates", "config": "clasp-targets/exchange-rates.clasp.json" }]`.
3. **Push mechanics ("swap and push").** `clasp` has no native multi-project flag, so
   the standard community pattern is to copy the active target's config into
   `.clasp.json` before pushing:
   ```bash
   cp clasp-targets/exchange-rates.clasp.json .clasp.json
   clasp push
   ```
   This lives in `scripts/push-target.sh <alias>`, invoked once per `targets.json`
   entry.
4. **Authentication is shared, not duplicated.** `.clasprc.json` (the OAuth refresh
   token) authorizes the **Google account**, not a specific Apps Script project. As
   long as that account has edit access to all N projects, the same CI secret pushes
   to every one of them — no per-document credentials needed.
5. **Per-document config lives where it already lives:** each Apps Script project has
   its own `PropertiesService.getScriptProperties()`. The Drive `fileId`, sheet tab
   name, etc. stay isolated per document without polluting the shared code with
   ID-based conditionals.
6. **CI becomes a matrix job** over `targets.json` — see
   [`../.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

### Runbook: adding document #2 (when the time comes)

1. Create the bound script in the new Sheet (Extensions → Apps Script), copy its
   `scriptId`.
2. Add `clasp-targets/<alias>.clasp.json` with `{ "scriptId": "...", "rootDir": "./src" }`.
3. Add `{ "alias": "<alias>", "config": "clasp-targets/<alias>.clasp.json" }` to
   `targets.json`.
4. Set that project's own Script Properties (see
   [`getting-started.md`](getting-started.md)).
5. Nothing in `src/` changes — the CI matrix in [`ci.md`](ci.md) picks up the new alias
   automatically once it exists.

### Honest limit of this model

This works as long as every document runs the **same logic** (which is the case today:
sync exchange rates into a Sheet). If a future document needed genuinely different
logic — not just different config — this model falls short for that one divergent
piece, and Model B (shared library) is worth reconsidering, but only for the part that
actually diverges, not the whole repo.

## Git hooks

Not yet configured (nothing enforces lint/test locally before commit today) — this
mirrors the state of a brand-new repo. Add a `pre-commit` hook here the same way
`pf-rates`/`pf-payroll` do (`git config core.hooksPath .githooks`) once the team wants
that friction.
