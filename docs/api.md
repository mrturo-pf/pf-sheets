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

## `GET_CLP(date, code)` (Web App custom function)

Lets other Google Sheets (any document belonging to the same Google account that owns
the central spreadsheet) look up a single value from the `VALUES` tab as a formula,
without needing access to the spreadsheet itself. Served by a Web App deployment of
this same `exchange-rates` project (`src/interfaces/webapp.js`'s `doGet`) -- see
[`getting-started.md`](getting-started.md#get_clp-web-app-deployment-once-per-apps-script-project)
for the deployment ID/URL and
[`../plan-get-clp-01-webapp.md`](../plan-get-clp-01-webapp.md) for the full design rationale
(including why the *server* is a Web App and not an Apps Script Library -- custom
functions cannot call `SpreadsheetApp.openById()`/`openByUrl()`, full stop, regardless of
who owns what). See "Consuming from another Apps Script project" below for how the
*client* side (the formula itself) is distributed -- that part **does** use a Library,
for a different reason than the one this restriction rules out.

**GET /exec** (the Web App's fixed endpoint path -- Apps Script Web Apps have exactly
one `doGet` entry point, there's no routing)

**Authentication:** Required -- `key` query param, checked against the `GET_CLP_API_KEY`
Script Property. There is no other access control: the deployment itself is reachable
anonymously (`ANYONE_ANONYMOUS` in `src/appsscript.json`'s manifest -- see
`plan-get-clp-01-webapp.md` Fase 0 for why that's required, not just permissive), so this
key is the *only* real gate.

**Query params:**

| Param | Required | Format | Meaning |
| --- | --- | --- | --- |
| `key` | Yes | string | Must equal `GET_CLP_API_KEY`. |
| `date` | Yes | `YYYY-MM-DD` (or anything whose first 10 characters are that) | The date to look up, in the **central spreadsheet's** time zone (`America/Santiago`). |
| `code` | Yes | string, case-insensitive | e.g. `USD`, `EUR`, `UF` (resolved to `CLF`, see "Code aliases" above), `UTM`, `IPC_CL`. |

**Response:** always `200`, `Content-Type: text/plain`. Body is one of:

| Body | Meaning |
| --- | --- |
| a bare number, e.g. `957.53` | Successful lookup. |
| `Unauthorized` | `key` missing or didn't match `GET_CLP_API_KEY`. |
| `Missing parameters` | `date` or `code` missing. |
| `Not found` | No row for that exact `(code, date)` -- or, less commonly, the `VALUES` tab itself is missing (logged server-side via `console.error`, not distinguishable from a normal miss in the response body -- see `src/interfaces/webapp.js`). |

There are no other status codes or JSON error bodies by design -- see "Consuming from
another Apps Script project" below for how the client turns this plain-text contract
into either a number or a clean message in the calling cell.

**Example:**
```bash
curl "https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec?date=2026-09-15&code=USD&key=<GET_CLP_API_KEY>"
# => 957.53
```

## `GET_CLP_RANGE(dates, codes)` (Web App custom function, batch)

Batch counterpart to `GET_CLP`, for many cells recalculating together -- see
[`../plan-get-clp-02-range-batch.md`](../plan-get-clp-02-range-batch.md) for the full
diagnosis (a burst of 108+ separate `GET_CLP` calls in "(05) Payroll" competing for the
same Web App/central sheet under load). **`GET_CLP` is not deprecated or replaced by
this** -- both formulas coexist indefinitely; `GET_CLP_RANGE` only makes sense where many
cells would otherwise recalculate at once.

Instead of one HTTP request per cell, `GET_CLP_RANGE` sends every (date, code) pair in
one request and gets every value back in one response, using Google Sheets' array
"spill" behavior. `dates` and `codes` can each be **either a range (one value per row)
or a single constant reused for every row** -- whichever matches how the consuming
sheet is actually laid out:

```
=GET_CLP_RANGE(A1:A54, B1:B54)     -- both vary per row
=GET_CLP_RANGE($D$7:$D$60, "USD")  -- dates vary, code is the same for every row
```
instead of dragging `=GET_CLP(A1, B1)` (or `=GET_CLP(D7, "USD")`) down 54 rows.

At least one of `dates`/`codes` must be an actual range -- that's what tells the
function how many rows to resolve; passing two constants isn't a batch, it's a single
`GET_CLP` lookup, so use that directly instead.

**Open-ended ranges are supported** (e.g. `$F$4:$F`, covering a whole column down to
the sheet's last row) -- no need to keep bumping the formula's upper bound by hand as
real data grows, unlike "(05) Payroll"'s bounded `$D$7:$D$60`. See "Blank rows in an
open-ended range" below for how the padding rows past your real data are handled.

**POST /exec** (same fixed Web App endpoint path as `doGet` -- Apps Script Web Apps
route strictly by HTTP method, `doGet` vs `doPost`, not by URL).

**Authentication:** Same as `GET_CLP` -- `key` query param (`?key=...`), checked against
the same `GET_CLP_API_KEY` Script Property. Still the query string, not the body --
only the pairs themselves move into JSON, since a GET-style query string with 100+
date/code pairs would blow past a practical URL length limit.

**Request body** (JSON):
```json
{ "pairs": [{ "date": "2026-09-15", "code": "USD" }, { "date": "2026-09-16", "code": "USD" }] }
```
Max **500 REAL pairs** per request (`GET_CLP_RANGE_MAX_PAIRS` in
`src/interfaces/webapp.js`) -- generous relative to the problem that motivated this
(108 cells today, +24/year in "(05) Payroll"), while still bounding how much of the
~30k-row `VALUES` sheet one request can scan on a full cache miss. This cap applies
only to pairs where both `date` and `code` are present -- blank padding rows from an
open-ended range (see below) never count against it, so a whole-column reference on a
1000-row sheet with 150 real data rows is fine. A separate, much larger ceiling
(`GET_CLP_RANGE_MAX_REQUEST_PAIRS = 5000`) bounds the raw size of the incoming array
(real + blank + malformed combined) as a sanity check on payload size, not on lookup
cost.

**Response:** always `200`, `Content-Type: application/json`.

- **Success:** a JSON array, same length and order as the request's `pairs`. Each
  element is independently a bare number (successful lookup), `""` (a future date with
  no match, or a fully blank pair -- see "Not found vs. blank" and "Blank rows in an
  open-ended range" below), `"Not found"` (a present/past date with no match), or
  `"Missing parameters"` (exactly one of `date`/`code` present) -- one bad/blank pair
  never fails the whole batch:
  ```json
  [957.53, "", "Not found", 36000.12]
  ```
- **Request-level failure** (bad/missing `key`, unparsable body, empty or oversized
  `pairs`, or the `VALUES` tab itself missing): a JSON object instead of an array, since
  there's no per-pair result to give:
  ```json
  { "error": "Unauthorized" }
  ```

### "Not found" vs. blank ("") -- and why IFERROR doesn't apply here

`GET_CLP` throws `Error: Not found` -- a genuine per-cell error, because each
`=GET_CLP(...)` formula is its own independent custom-function call. That's exactly
what makes `=IFERROR(GET_CLP(...), "")` work: `IFERROR` intercepts a real thrown error
at that one cell, nowhere else.

`GET_CLP_RANGE` **cannot** do the same thing per row: the whole range is served by a
*single* function call returning *one* array that Sheets spreads across many cells. If
that one call threw for a single missing row, the platform would blank out **every**
cell in the range, not just the missing one (confirmed in `plan-get-clp-01-webapp.md`'s
Fase 1.5 spike) -- so `doPost`/`GET_CLP_RANGE` deliberately never throw per row, they
return a plain string in that row's position instead (see "Piezas de diseno", point 3,
in `plan-get-clp-02-range-batch.md`). A plain string is **not** an error value as far as
Sheets is concerned, so `IFERROR` does nothing to it -- there's no per-cell error inside
an array result to catch; wrapping the whole `GET_CLP_RANGE(...)` call in `IFERROR`
only ever protects against a *batch-level* failure (bad key, malformed body), never
against one row's `"Not found"`.

Given that, `GET_CLP_RANGE` resolves a missing (code, date) pair to one of two plain
strings, decided server-side by comparing the pair's date against "today" in the
central spreadsheet's own time zone (`describeMissingRate` in `src/domain/index.js`):

- **Future date, no match:** `""` (blank cell) -- there's genuinely no exchange rate to
  publish yet; not a data problem worth a visible message.
- **Present or past date, no match:** `"Not found"` -- a real gap in `VALUES` worth
  surfacing, same wording `GET_CLP` throws.

This means most consumers don't need any cell-level wrapping at all: blank cells for
future rows and an explicit `"Not found"` for a genuine data gap is already the
intended, final display. If a consumer wants to also blank out the `"Not found"` case
cosmetically, that has to be a **second, separate formula/column** doing a plain `IF`
comparison against the literal text (not `IFERROR`, since there's no error to catch):
```
=ARRAYFORMULA(IF(A1:A54="Not found", "", A1:A54))
```
where `A1:A54` is itself the spilled output of a `GET_CLP_RANGE(...)` formula elsewhere
-- this avoids calling `GET_CLP_RANGE` (and re-paying its HTTP batch) a second time just
to reformat its own output.

### Blank rows in an open-ended range

An open-ended reference like `=GET_CLP_RANGE($F$4:$F, $T$4:$T)` sends one `(date, code)`
pair **per sheet row**, all the way down to the sheet's actual total row count -- not
just the rows that currently hold real data. On a 1000-row sheet with 150 rows of real
data, that is ~850 pairs where both `date` and `code` are simply empty.

`doPost` classifies each pair before doing any lookup (`classifyRangePair` in
`src/domain/index.js`):

- **Both `date` and `code` empty:** `""` (blank cell) -- ordinary padding past your real
  data, not an error, and **does not count** against `GET_CLP_RANGE_MAX_PAIRS` (see
  above) or ever touch the `VALUES` sheet.
- **Exactly one of `date`/`code` empty:** `"Missing parameters"` -- this is NOT normal
  padding (a fully blank row has both empty), so it flags a real data-entry mistake
  (e.g. a currency code typed with no matching date, or vice versa) worth fixing.

This is what makes an open-ended range reference practical in the first place: you
never have to keep bumping the formula's upper bound as real rows are added (unlike
"(05) Payroll"'s bounded `$D$7:$D$60`), and the hundreds of padding rows past your data
stay silently blank instead of showing `"Missing parameters"` on every one of them or,
worse, tripping the batch-size cap and failing the entire formula (the original
incident reported for "(12) MedicalRefund" -- see `plan-get-clp-02-range-batch.md`).

Caching mirrors `GET_CLP` exactly -- same `code|date` `CacheService` key (see
"Response" above for `GET_CLP`), so a batch that overlaps with recent single `GET_CLP`
calls (or a repeated/partial `GET_CLP_RANGE` batch) only touches the `VALUES` sheet for
genuine cache misses.

**Example:**
```bash
curl -X POST \
  "https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec?key=<GET_CLP_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"pairs": [{"date": "2026-09-15", "code": "USD"}]}'
# => [957.53]
```

## Consuming `GET_CLP` / `GET_CLP_RANGE` from another Apps Script project (Library)

Both formulas are consumed as an **Apps Script Library** published from this same
`exchange-rates` project (`src/interfaces/library.js`) -- not by hand-pasting their full
implementation into every consumer. This does **not** change how they get their data:
the Library's `GET_CLP`/`GET_CLP_RANGE` still call the Web App above over `UrlFetchApp`,
exactly like the earlier pasted snippet did -- see "Why the Library still calls the Web
App" below for why that part couldn't change. Only *where the client code lives, and how
it reaches every consumer* changed (see
[`../plan-get-clp-02-range-batch.md`](../plan-get-clp-02-range-batch.md), "Punto 2", for
the full decision record and the alternatives that were discarded).

### Install (once per consuming Apps Script project)

1. Open the consuming spreadsheet's Extensions → Apps Script editor.
2. Project Settings → Script Properties → add `GET_CLP_API_KEY` with the same value
   configured on the `exchange-rates` project (ask whoever manages it -- it's the same
   secret documented in [`getting-started.md`](getting-started.md)). This is still
   required with a Library: `PropertiesService.getScriptProperties()` called from
   library code resolves to the **calling** project's own properties, not the library
   project's -- standard Apps Script Library semantics, which is exactly what keeps
   each consumer's own key correctly scoped.
3. In the editor's left sidebar, next to "Libraries", click **+** → paste the script ID
   `1DMVavLk-uV8kSkdpLmvYCzk_7w5becIcwjOukVO09cpD8WNi2ECAK4m-` (the `exchange-rates`
   project -- see [`getting-started.md`](getting-started.md), not a secret) → Look up →
   pick the latest version → Identifier: `ExchangeRates` (or any name -- it's whatever
   you reference it as below) → Add.
4. Paste this wrapper into a new script file (e.g. `GetClp.gs`) -- this is the entire
   file, nothing else needed:

   ```javascript
   /**
    * Usage: =GET_CLP(DATE(2026,9,15), "USD")
    * @param {Date|string} date
    * @param {string} code e.g. "USD", "EUR", "UF", "UTM", "IPC_CL"
    * @return {number|string} the CLP value, or "Unauthorized" /
    *   "Missing parameters" for real misconfigurations.
    * @throws {Error} "Not found" (catchable by IFERROR) or "Unexpected
    *   response" -- see api.md in the exchange-rates repo for details.
    * @customfunction
    */
   function GET_CLP(date, code) {
     return ExchangeRates.GET_CLP(date, code);
   }

   /**
    * Usage: =GET_CLP_RANGE(A1:A54, B1:B54) or =GET_CLP_RANGE($D$7:$D$60, "USD")
    * @param {Array<Array<Date|string>>|Date|string} dates
    * @param {Array<Array<string>>|string} codes
    * @return {Array<Array<number|string>>}
    * @customfunction
    */
   function GET_CLP_RANGE(dates, codes) {
     return ExchangeRates.GET_CLP_RANGE(dates, codes);
   }
   ```

5. Save. Both formulas should now work in any cell.

Why this wrapper can't be skipped entirely (i.e. why you can't just write
`=ExchangeRates.GET_CLP(...)` straight into a cell without it): Apps Script's custom
function picker only scans **top-level functions defined in the calling project itself**
-- a function that only exists inside an imported Library is invisible to it. This was
confirmed during the original spike (see `plan-get-clp-01-webapp.md`'s Fase 1.5, finding
#1) while evaluating -- and ultimately discarding -- a Library for the *server* side of
GET_CLP; the finding itself still holds here, just for a different piece of code.

### Updating the Library (whenever GET_CLP/GET_CLP_RANGE's logic changes)

Every `clasp push` to the `exchange-rates` target also cuts a new immutable Library
version automatically (see `scripts/push-target.sh` and
[`ci.md`](ci.md#library-version-cut-get_clpget_clp_range)) -- but existing consumers stay
pinned to whichever version they picked in step 3 above. Apps Script deliberately has no
supported "always use HEAD" option for production custom-function calls (confirmed in
`plan-get-clp-01-webapp.md`'s Fase 1.5, finding #2), so a fix or improvement only reaches
a given consumer once someone points it at the new version: Apps Script editor →
Libraries → change the version number next to the identifier → Save. That's the entire
update -- no code to re-paste, ever, unless the wrapper's own function *signature*
changes (rare, and would be called out explicitly if it ever happens).

### GOOGLEFINANCE fallback + `#N/A` (optional, per-cell)

`GET_CLP` itself cannot call `GOOGLEFINANCE` or any other formula internally -- custom
functions are read-only, they cannot write a formula to a cell to evaluate it. The
fallback has to be composed in the consuming **cell**, using `GET_CLP`'s `"Not found"`
throw so `IFERROR` has something real to catch:

```
=IFERROR(IFERROR(GET_CLP(date, code), INDEX(GOOGLEFINANCE("CURRENCY:" & code & "CLP", "price", date, date), 2, 2)), NA())
```

Why it looks like this, not simpler:
- `GOOGLEFINANCE("CURRENCY:" & code & "CLP", ...)` -- FX pairs need the `CURRENCY:` prefix
  plus the concatenated pair (e.g. `CURRENCY:USDCLP`); the bare code (`"USD"`) is not a
  valid symbol.
- `INDEX(..., 2, 2)` -- `GOOGLEFINANCE` with a historical date **always** returns a
  2-row table (a `Date`/`Close` header row plus one data row), never a bare number, even
  for a single day (`start_date = end_date`). `INDEX` pulls out just the price cell.
- Outer `NA()` -- the final, explicit `#N/A` when neither source has a value.

**This fallback only makes sense for real currency codes** (`USD`, `EUR`, ...).
`GOOGLEFINANCE` has no data for `UF`, `UTM`, or `IPC_CL` -- those are Chile-specific
indices (BCCh/INE), not tradeable instruments on public markets. For those codes the
`GOOGLEFINANCE(...)` branch will itself error out on an invalid symbol and the formula
correctly falls through to `NA()` -- this is expected, not a bug to chase.

### Why the Library still calls the Web App

Publishing `GET_CLP`/`GET_CLP_RANGE` as a Library does **not** let them read the central
spreadsheet directly. Library code executes inside the SAME sandboxed call stack as
whatever custom function invoked it (confirmed in `plan-get-clp-01-webapp.md`'s Fase
1.5) -- `SpreadsheetApp.openById()`/`openByUrl()` stay forbidden regardless of whether
the calling code lives in the consumer's own script or came from an imported Library.
`URL Fetch` remains the one service explicitly allowed, unrestricted, in that sandbox --
which is why `src/interfaces/library.js` still calls the Web App above over
`UrlFetchApp`, exactly like the original hand-pasted snippet did.
