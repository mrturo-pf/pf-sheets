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
3. Extracts the `ECONOMIC_INDEX` rows out of the CSV, converted to a
   legacy-shaped row set (pure, see `extractEconomicIndexCsvRows` in
   `src/domain/`).
4. Performs an incremental upsert into the `VALUES` sheet tab,
   each keyed by `CODE|YYYY-MM-DD`:
   - Updates `value` + `last_modified_at` when the value changed.
   - Leaves untouched rows whose value didn't change (preserves the original
     `last_modified_at`).
   - Appends new rows with an auto-incremented `id` and the current timestamp.
   - Never deletes rows absent from the CSV.
5. Shows one summary via `spreadsheet.toast(...)` covering the `VALUES` tab.

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
`pf-sheets` does not do any expansion itself. It only keeps the
`ECONOMIC_INDEX` rows from this combined CSV; `EXCHANGE_RATE` rows are
present in the response but currently unused here (`pf-sheets` no longer
maintains an `EXCH_RATE` tab).

Rows with an unrecognized `series_type` (or missing/incomplete columns)
are skipped and their line numbers logged, same "skip and count" behavior
`computeUpsertPlan` already uses for malformed rows.

See [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the authoritative contract
of the export endpoint.
