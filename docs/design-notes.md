# Design notes: `GET_CLP` / `GET_CLP_RANGE`

Durable architectural facts and decisions behind `GET_CLP`/`GET_CLP_RANGE` that are
still referenced by code comments and other docs, but no longer belong in an
incident/planning doc once the work they came from has shipped -- this page is their
permanent home for the parts still worth knowing, not a history of every incident
along the way (see `api.md` and `ci.md` for the current, user-facing behavior; git
history for the full incident-by-incident narrative if ever needed).

## Apps Script custom-function sandbox constraints

Discovered during the original spike that led to `GET_CLP`:

- **A custom function's sandbox forbids `SpreadsheetApp.openById()`/`openByUrl()`
  outright**, full stop, regardless of who owns the target spreadsheet. This is *the*
  reason `GET_CLP`'s server side is a Web App (`doGet`/`doPost` in
  `src/interfaces/webapp.js`), not a plain custom function reading the central sheet
  directly, and not an Apps Script Library either -- a Library's public function
  executes inside the **same sandboxed call stack** as whatever custom function
  invoked it, so the restriction follows it there too (`src/interfaces/library.js`
  never touches `SpreadsheetApp.openById()` for this reason).
- **Any custom function is killed by the platform at a hard 30-second ceiling.**
  `GET_CLP`/`GET_CLP_RANGE`'s retry/backoff budget
  (`GET_CLP_MAX_RETRY_BUDGET_MILLIS_` in `library.js`) is deliberately set below that,
  so they give up on their own terms (a clean, `IFERROR`-catchable error) instead of
  being killed mid-flight.
- **Throwing an error from a function whose result spills into a multi-cell range
  blanks out the *entire* range**, not just the cell that actually failed. This is why
  `doPost`/`GET_CLP_RANGE` never throw per row -- every row resolves to a plain string
  (a number, `""`, `"Not found"`, or `"Missing parameters"`) instead, so one bad pair
  never takes down the rest of the batch. See `api.md`, "'Not found' vs. blank", for
  the full consumer-facing consequence of this (why `IFERROR` can't be used per-cell
  on `GET_CLP_RANGE` the way it can on `GET_CLP`).
- **A Web App deployment freezes a specific code version at the moment it's
  deployed.** `clasp push` alone updates the Apps Script project's code but does
  **not** change what a live Web App URL actually serves -- `clasp deploy -i <id>` is
  required to move the deployment forward (see `ci.md`, "Web App redeploys").
- **The custom-function picker only scans top-level functions defined in the calling
  project itself** -- a function that exists only inside an *imported Library* is
  invisible to it. `=ExchangeRates.GET_CLP(...)` cannot be typed directly into a cell;
  every consuming project needs its own thin top-level wrapper that delegates to the
  Library (see `api.md`, "Consuming `GET_CLP`/`GET_CLP_RANGE`... (Library)", for the
  actual wrapper snippet).
- **Apps Script has no supported "always use HEAD" option for a Library reference
  from a production custom-function call.** A consumer always pins to a specific
  version number; a fix or improvement only reaches it once someone manually bumps
  that pinned version (Apps Script editor → Libraries → change version). This is why
  every `clasp push` to `exchange-rates` cuts a fresh, immutable Library version
  automatically (see `ci.md`, "Library version cut") -- it guarantees a version always
  exists to point consumers at, but never forces the update on them.

## Web App access control: anonymous reachability plus a key

`src/appsscript.json`'s Web App deployment is configured `ANYONE_ANONYMOUS` ("who has
access"), which sounds like "no security" but isn't: that setting only controls
whether the deployment is *reachable* at all by an unauthenticated `UrlFetchApp.fetch`
call from a consumer's own Apps Script project (which has no Google-session context to
present). It is required precisely because every consumer is itself anonymous from the
Web App's point of view -- there is no other supported way for cross-project
server-to-server calls to authenticate at the platform level.

The **actual** access control is the `key` query param, checked in both `doGet` and
`doPost` against the `GET_CLP_API_KEY` Script Property. Neither the deployment ID nor
its URL are secrets by themselves -- hitting the URL without a valid `key` just gets
`"Unauthorized"` back.

## Cross-realm `instanceof` gotcha in Apps Script Libraries

Every Apps Script project runs in its own V8 "realm" with its own built-in
constructors. A `Date` object constructed in a **consuming** project (Payroll,
MedicalRefund) and passed as an argument into a function published by **this**
project's Library can fail `value instanceof Date` inside that Library function even
though it genuinely is a `Date` -- the classic cross-realm `instanceof` gotcha (same
root cause as `instanceof Array` failing across iframes in a browser).

This bit `GET_CLP`/`GET_CLP_RANGE` for real: the broken branch silently fell back to
`String(date)` (e.g. `"Mon Jan 15 2024 00:00:00 GMT-0300 ..."`) instead of formatting
to `"yyyy-MM-dd"`, so no lookup ever matched -- 100% `"Not found"` for every consumer
going through the Library. Fixed with `isDateValue_()` in `src/interfaces/library.js`:

```javascript
function isDateValue_(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}
```

`Object.prototype.toString.call(...)` reads the internal `[[Class]]` tag instead of
walking the prototype chain, so it stays correct across realm boundaries.
`src/domain/index.js`'s own `rawDate instanceof Date` (in `normalizeDateKey`) does
**not** need this treatment -- `domain/` and `webapp.js` always run together in the
same realm (`exchange-rates`'s own execution), never crossing a Library boundary.

**Rule of thumb for any future Library code here:** any value that could have been
constructed by a *different* Apps Script project must be type-checked with
`Object.prototype.toString.call(...)`, never bare `instanceof`.

## Why `GET_CLP`/`GET_CLP_RANGE`'s client code is distributed as an Apps Script Library

Three options were evaluated for getting `GET_CLP`/`GET_CLP_RANGE`'s client-side logic
(retry/backoff, request building, response parsing) into consumer projects like
Payroll and MedicalRefund:

1. **Publish as an Apps Script Library** (what was chosen) -- consumers add a
   reference to this project as a Library and get a thin, stable wrapper; updates
   ship by cutting a new Library version (automatic, on every push) and consumers
   opt in by bumping their pinned version number.
2. **This repo takes ownership of Payroll/MedicalRefund's entire Apps Script
   project** (e.g. `clasp push --force` their whole codebase) -- rejected: this repo
   cannot see whatever *other* macros/code those projects might already contain, so a
   forceful push risks silently deleting code this repo has no visibility into.
3. **Just detect version desync** (e.g. a periodic check comparing a consumer's pasted
   snippet against the latest known-good version, without actually updating it) --
   rejected: still requires manually re-pasting code by hand on every fix, the exact
   maintenance cost the Library model eliminates.

Option 1 won because it is the only one that gives consumers an actual "update"
mechanism (bump a version number) without this repo ever touching code it can't fully
see. The trade-off is the wrapper-function requirement described above (every
consumer needs its own top-level `GET_CLP`/`GET_CLP_RANGE` function delegating to the
Library) -- unavoidable given how the Apps Script custom-function picker works, but
still a 3-line function instead of the entire retry/parsing implementation.
