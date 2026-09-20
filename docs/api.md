# What the macro does

## `updateExchangeRates()`

Entry point, implemented in `src/interfaces/`. Bound to the "Rate Values →
Update" menu item (`onOpen()`), same behavior as before the migration:

1. Calls `POST {PF_RATES_BASE_URL}/exchange-rates/export` on
   [`pf-rates`](../../pf-rates) with `{ lookback_days, forward_days }`, authenticated
   via the `PF_RATES_API_KEY` Script Property.
2. Reads the resulting CSV from Google Drive (`EXPORT_DRIVE_FILE_ID` Script Property).
3. Performs an incremental upsert into the sheet's `EXCH_RATE` tab, keyed by
   `CURRENCY_CODE|YYYY-MM-DD`:
   - Updates `value_clp` + `last_modified_at` when the value changed.
   - Leaves untouched rows whose value didn't change (preserves the original
     `last_modified_at`).
   - Appends new rows with an auto-incremented `id` and the current timestamp.
   - Never deletes rows absent from the CSV.
4. Shows a summary via `spreadsheet.toast(...)`.

## Expected CSV contract (from `pf-rates`)

| Column | Meaning |
| --- | --- |
| `currency_code` | e.g. `USD`, `EUR` |
| `rate_date` | `YYYY-MM-DD` |
| `value_clp` | numeric, may contain thousands separators (stripped before parsing) |

See [`pf-rates/docs/api.md`](../../pf-rates/docs/api.md) for the authoritative contract
of the export endpoint.
