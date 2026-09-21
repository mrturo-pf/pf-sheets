# What the macro does

## `updateExchangeRates()`

Entry point, implemented in `src/interfaces/`. Bound to the "Rate Values →
Update" menu item (`onOpen()`). Kept as `updateExchangeRates` (not renamed)
so any existing menu/time-driven trigger binding to this exact function
name keeps working, even though it now syncs the `VALUES` tab from
the combined export instead of exchange rates directly.

1. Calls `POST {PF_RATES_BASE_URL}/exports/financial-data` on
   [`pf-rates`](../../pf-rates) with `{ lookback_days, forward_days }`, authenticated
   via the `PF_RATES_API_KEY` Script Property. This is the **combined**
   export (exchange rates + economic indices in one CSV) -- see
   [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the endpoint contract.
2. Reads the resulting CSV from Google Drive (`EXPORT_DRIVE_FILE_ID` Script Property).
3. Converts every row of the CSV to a legacy-shaped row set (pure, see
   `buildValuesCsvRows` in `src/domain/`) -- every `code` pf-rates
   exports, regardless of its own `series_type`; see "Expected CSV
   contract" below for why this does NOT filter by `series_type`. Each
   row's `code` is passed through `applySheetCodeAlias` on the way --
   see "Code aliases" below.
4. Performs an incremental upsert into the `VALUES` sheet tab,
   each keyed by `CODE|YYYY-MM-DD`:
   - Updates `value` + `last_modified_at` when the value changed.
   - Leaves untouched rows whose value didn't change (preserves the original
     `last_modified_at`).
   - Appends new rows with an auto-incremented `id` and the current timestamp.
   - Never deletes rows absent from the CSV.
   - Rewrites the whole grid sorted by **date, then code, then
     last_modified_at** (all ascending; see `compareSheetRows` and
     "Row order" below) instead of just growing with new rows appended
     at the bottom.
5. Shows one summary via `spreadsheet.toast(...)` covering the `VALUES` tab.

## Row order

Every sync rewrites the `VALUES` grid sorted with this priority:

1. **Date** (`period_date` / the sheet's `date` column) -- ascending.
2. **Code** -- ascending, alphabetical, as a tie-breaker within the same date.
3. **last_modified_at** -- ascending, as a final tie-breaker (in practice
   this rarely matters, since `date + code` is already the upsert's unique
   key -- see "Expected CSV contract" below).

This is computed once, purely, in `compareSheetRows` (`src/domain/`) and
applied at the end of `computeUpsertPlan`, so the sheet ends up in the same
predictable order after every run regardless of the order rows arrived in
the combined CSV or how long they've existed in the sheet.

## Expected CSV contract (from `pf-rates`)

`POST /exports/financial-data` returns one CSV covering both series types:

| Column | Meaning |
| --- | --- |
| `series_type` | `EXCHANGE_RATE` or `ECONOMIC_INDEX` |
| `code` | e.g. `USD`, `EUR`, `UF`, `UTM`, `IPC_CL` |
| `period_date` | `YYYY-MM-DD` |
| `value` | numeric, may contain thousands separators (stripped before parsing) |

Economic-index rows are already expanded to one row per calendar day
(pf-rates repeats each month's stored value across every day in it) --
`pf-sheets` does not do any expansion itself.

**`pf-sheets` does not filter by `series_type` at all -- every row lands in
the `VALUES` tab.** This matters because `series_type` is `pf-rates`'
*internal* classification of how it resolves a value, not a "currency vs.
economic index" split a human would expect. Concretely (see
[`pf-rates/src/rates/shared/constants.py`](../../pf-rates/src/rates/shared/constants.py)):

| Code | `series_type` in this CSV |
| --- | --- |
| `USD`, `EUR` | `EXCHANGE_RATE` |
| `UF` | `EXCHANGE_RATE` (even though most people in Chile call it an economic index) |
| `UTM` | `EXCHANGE_RATE` (same reason as `UF`) |
| `IPC_CL` | `ECONOMIC_INDEX` (currently the *only* code with this series_type) |

An earlier version of `pf-sheets` filtered this CSV down to
`ECONOMIC_INDEX` rows only (when the separate `EXCH_RATE` tab was
dropped in favor of one `VALUES` tab) and, as a direct consequence,
silently dropped `UF` and `UTM` from the sheet -- only `IPC_CL` kept
syncing. `buildValuesCsvRows` (`src/domain/`) fixed this by dropping the
`series_type` check entirely; it is read purely for header-completeness
validation now, never to filter rows.

Rows with too few columns (structurally malformed) are still skipped and
their line numbers logged, same "skip and count" behavior
`computeUpsertPlan` already uses for malformed rows.

See [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the authoritative contract
of the export endpoint.

## Code aliases

pf-rates emits `code` values from its own domain (`USD`, `EUR`, `UF`, `UTM`,
`IPC_CL`, ...) -- that's the contract every consumer shares, and it does not
change here. But this specific spreadsheet wants some of those codes
displayed under a different label; today `UF` is written to the `VALUES`
tab as `CLF` instead.

This is a **presentation-only relabeling local to `pf-sheets`**: `pf-rates`,
`pf-db`, and any other consumer of the combined export keep seeing/storing
`UF` exactly as before. The mapping lives in one place,
`SHEET_CODE_ALIASES` in `src/domain/index.js`, and is applied by
`applySheetCodeAlias` right where `buildValuesCsvRows` builds each
row -- nowhere else needs to know about it.

**To rename another code later** (e.g. show `UTM` as something else), add
one more `key: "value"` entry to `SHEET_CODE_ALIASES` and redeploy -- no
other file changes. Keys are matched case-insensitively; `applySheetCodeAlias`
always returns a trimmed, upper-cased code -- both aliased and
not-configured codes come out normalized this way, so the `VALUES` tab
never ends up with inconsistent casing/whitespace regardless of how
`pf-rates` sent it.
