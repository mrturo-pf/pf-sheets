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
(including why this is a Web App and not an Apps Script Library -- custom functions
cannot call `SpreadsheetApp.openById()`/`openByUrl()`, full stop, regardless of who
owns what).

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

There are no other status codes or JSON error bodies by design -- see "Install" below
for how the client snippet turns this plain-text contract into either a number or a
clean message in the calling cell.

**Example:**
```bash
curl "https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec?date=2026-09-15&code=USD&key=<GET_CLP_API_KEY>"
# => 957.53
```

**This is not code this repo pushes anywhere.** Unlike `updateExchangeRates`/`onOpen`
(pushed via `clasp` to every target in `targets.json`), the snippet below is meant to be
pasted manually, once, into each *consuming* Apps Script project -- those are separate
Google Sheets this repo doesn't own or track as a clasp target. Reusing the multi-target
push model here would push the entire sync macro (and a second, pointless `doGet`) into
every consumer, none of which need it -- see "Adding a new document/target" in
[`development.md`](development.md), which exists to scale `updateExchangeRates` to more
documents needing the *same* full sync behavior, not this.

### Install (once per consuming Apps Script project)

1. Open the consuming spreadsheet's Extensions → Apps Script editor.
2. Project Settings → Script Properties → add `GET_CLP_API_KEY` with the same value
   configured on the `exchange-rates` project (ask whoever manages it -- it's the same
   secret documented in [`getting-started.md`](getting-started.md)). Storing it in
   Script Properties here too (rather than hardcoding it in the snippet below) keeps
   the same "no secrets in source" rule this repo already follows for `PF_RATES_API_KEY`
   and `EXPORT_DRIVE_FILE_ID`.
3. Paste this into a new script file (e.g. `GetClp.gs`):

   ```javascript
   var GET_CLP_WEB_APP_URL =
     "https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec";

   /**
    * Looks up a CLP value from the shared financial-data spreadsheet.
    * Usage: =GET_CLP(DATE(2026,9,15), "USD")
    * @param {Date|string} date
    * @param {string} code e.g. "USD", "EUR", "UF", "UTM", "IPC_CL"
    * @return {number|string} the CLP value, or the string "Unauthorized" /
    *   "Missing parameters" for real misconfigurations (returned as plain
    *   text on purpose -- see the "GOOGLEFINANCE fallback" section below
    *   for why these must NOT be silently swallowed by IFERROR).
    * @throws {Error} "Not found" when there's no data for that (code, date)
    *   yet -- thrown, not returned, specifically so
    *   IFERROR(GET_CLP(...), ...) can catch just this one recoverable case.
    *   Also throws "Unexpected response" if a burst of concurrent GET_CLP
    *   calls trips Google's own Web App infrastructure (see the retry
    *   helper below) three times in a row -- rare, but confirmed to happen
    *   via the Executions log: doGet completed fine server-side every time,
    *   yet the caller still got back Google's own generic error HTML
    *   instead of doGet's real response.
    * @customfunction
    */
   function GET_CLP(date, code) {
     // Formatted using THIS spreadsheet's own time zone (getActiveSpreadsheet
     // is fine here -- unlike doGet, a custom function genuinely does have
     // an active bound spreadsheet, and this reconstructs "the calendar day
     // the user actually typed into the cell", regardless of what time zone
     // the central spreadsheet happens to use).
     var dateParam =
       date instanceof Date
         ? Utilities.formatDate(date, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd")
         : String(date);

     var apiKey = PropertiesService.getScriptProperties().getProperty("GET_CLP_API_KEY");
     var url =
       GET_CLP_WEB_APP_URL +
       "?date=" + encodeURIComponent(dateParam) +
       "&code=" + encodeURIComponent(code) +
       "&key=" + encodeURIComponent(apiKey || "");

     var text = fetchGetClpResponseWithRetries_(url);
     var value = parseFloat(text);

     if (!isNaN(value)) {
       return value;
     }
     if (text === "Not found") {
       // The ONE case worth recovering from at the formula level -- thrown
       // (not returned as a string) so an outer IFERROR(GET_CLP(...), ...)
       // can catch it and fall back to GOOGLEFINANCE. "Unauthorized"/
       // "Missing parameters" return as plain text instead: those are real
       // misconfigurations, not "no data yet".
       throw new Error("Not found");
     }
     if (text === "Unauthorized" || text === "Missing parameters") {
       return text;
     }
     // Neither a number nor one of doGet's own fixed strings, even after
     // retries -- almost certainly Google's Web App redirect infrastructure
     // itself glitching under a burst of concurrent GET_CLP calls (observed
     // directly: many simultaneous doGet executions in the Executions log,
     // every one "Completed" server-side, yet the caller still got back an
     // HTML "Sorry, unable to open the file" page instead of doGet's real
     // response -- a known Apps Script Web App flakiness pattern, not a bug
     // in doGet). Thrown as a real error so it's catchable the same way as
     // "Not found", instead of dumping raw HTML into the cell.
     throw new Error("Unexpected response");
   }

   // Custom functions get killed by the platform at 30s, full stop (see
   // plan-get-clp-01-webapp.md's Fase 1.5) -- that hard kill produces an
   // ugly, non-catchable-by-IFERROR "Exceeded maximum execution time"
   // error. Budgeting retries to this ceiling means GET_CLP gives up on
   // ITS OWN terms (a clean, throwable, IFERROR-catchable error) well
   // before Google's platform forcibly kills the whole execution.
   var GET_CLP_MAX_RETRY_BUDGET_MILLIS_ = 25000;

   /**
    * Retries a GET_CLP Web App call up to 3 times with a short backoff,
    * because a burst of many simultaneous GET_CLP cells recalculating at
    * once can trip Google's own Web App redirect infrastructure (returns
    * a generic Drive-style HTML error page even though doGet itself
    * completed fine server-side -- confirmed via the Executions log, not
    * guessed). A single flaky hop shouldn't surface as a broken formula.
    *
    * Time-budget aware on purpose: under a big enough burst, individual
    * attempts themselves can already run several seconds long (observed
    * directly in the Executions log). Blindly retrying 3 times on top of
    * that risks tripping the platform's own 30s custom-function ceiling,
    * which fails far worse (see the constant above) than just giving up
    * a bit early with a clean thrown error.
    * @param {string} url
    * @return {string} the raw response body from the last attempt
    */
   function fetchGetClpResponseWithRetries_(url) {
     var maxAttempts = 3;
     var startedAt = Date.now();
     var lastText = "";
     for (var attempt = 1; attempt <= maxAttempts; attempt++) {
       if (attempt > 1 && Date.now() - startedAt > GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
         break;
       }
       var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
       lastText = response.getContentText();
       if (isRecognizedGetClpResponse_(lastText)) {
         return lastText;
       }
       if (attempt < maxAttempts && Date.now() - startedAt < GET_CLP_MAX_RETRY_BUDGET_MILLIS_) {
         Utilities.sleep(300 * attempt); // 300ms, then 600ms
       }
     }
     return lastText;
   }

   /**
    * @param {string} text
    * @return {boolean}
    */
   function isRecognizedGetClpResponse_(text) {
     if (text === "Unauthorized" || text === "Missing parameters" || text === "Not found") {
       return true;
     }
     return !isNaN(parseFloat(text));
   }
   ```

4. Save. `=GET_CLP(DATE(2026,9,15), "USD")` should now work in any cell.

### GOOGLEFINANCE fallback + `#N/A` (optional, per-cell)

`GET_CLP` itself cannot call `GOOGLEFINANCE` or any other formula internally -- same
platform restriction as the Library dead end (custom functions are read-only, cannot
write a formula to a cell to evaluate it). The fallback has to be composed in the
consuming **cell**, using `GET_CLP`'s `"Not found"` throw (added above) so `IFERROR`
has something real to catch:

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

### Why `UrlFetchApp`, not a Library call

`URL Fetch` is one of the few services explicitly allowed, unrestricted, inside a
custom function's sandbox -- see plan-get-clp-01-webapp.md's Fase 1.5. This is precisely
what makes the Web App design work at all: `doGet` executes as a fully separate,
unrestricted execution triggered by this HTTP call, not as part of this custom
function's own restricted call stack.
