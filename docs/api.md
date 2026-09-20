# What the macro does

## `updateExchangeRates()`

Entry point, implemented in `src/interfaces/`. Bound to the "Rate Values →
Update" menu item (`onOpen()`). Kept as `updateExchangeRates` (not renamed)
so any existing menu/time-driven trigger binding to this exact function
name keeps working -- it now syncs **both** tabs from one combined export
instead of a second macro being added alongside it.

1. Calls `POST {PF_RATES_BASE_URL}/exports/financial-data` on
   [`pf-rates`](../../pf-rates) with `{ lookback_days, forward_days }`, authenticated
   via the `PF_RATES_API_KEY` Script Property. This is the **combined**
   export (exchange rates + economic indices in one CSV) -- see
   [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the endpoint contract.
2. Reads the resulting CSV from Google Drive (`EXPORT_DRIVE_FILE_ID` Script Property).
3. Splits the CSV by `series_type` into two legacy-shaped row sets (pure,
   see `splitCombinedCsvBySeriesType` in `src/domain/`).
4. Performs an incremental upsert into **both** the `EXCH_RATE` and
   `ECON_INDEX` sheet tabs, each keyed by `CODE|YYYY-MM-DD`:
   - Updates `value` + `last_modified_at` when the value changed.
   - Leaves untouched rows whose value didn't change (preserves the original
     `last_modified_at`).
   - Appends new rows with an auto-incremented `id` and the current timestamp.
   - Never deletes rows absent from the CSV.
5. Shows one summary via `spreadsheet.toast(...)` covering both tabs.

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
`pf-sheets` does not do any expansion itself, it only routes rows by
`series_type` and reuses the exact same per-day upsert logic for both.

Rows with an unrecognized `series_type` (or missing/incomplete columns)
are skipped and their line numbers logged, same "skip and count" behavior
`computeUpsertPlan` already uses for malformed rows.

See [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the authoritative contract
of the export endpoint.
