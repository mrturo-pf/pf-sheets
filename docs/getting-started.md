# Getting Started

## Prerequisites

- Node.js >= 18 and npm.
- A Google account with edit access to the exchange-rates Apps Script project:
  - Spreadsheet: https://docs.google.com/spreadsheets/d/1WLAE02oOJlDjLwQ4aS-ranKLNgV2bVuAt9L96m7-8DA/edit
  - Apps Script project: https://script.google.com/u/0/home/projects/1DMVavLk-uV8kSkdpLmvYCzk_7w5becIcwjOukVO09cpD8WNi2ECAK4m-/edit
    (same `scriptId` pinned in [`../clasp-targets/exchange-rates.clasp.json`](../clasp-targets/exchange-rates.clasp.json)
    — a `scriptId` is an identifier, not a secret, so it's safe to version and to print here)
- The Google Apps Script API enabled for that account:
  https://script.google.com/home/usersettings

## Install

```bash
git clone https://github.com/mrturo-pf/pf-sheets.git
cd pf-sheets
make install     # npm install — clasp comes in via devDependencies, invoked with npx
```

## Authenticate `clasp` locally

This is a one-time, interactive step (not part of CI — CI reuses the resulting token,
see [`ci.md`](ci.md)):

```bash
npx clasp login --creds <path-to-oauth-desktop-client-creds.json>
```

Use the **same OAuth "Desktop app" Client ID already created for `pf-rates`'s Google
Drive export** (see `pf-rates/docs/deployment.md` / `secrets/README.md` at the
ecosystem root) — no need to create a new one. This produces `~/.clasprc.json`. Copy it
to `../secrets/pf-sheets/clasprc.json` (repo-root-level `secrets/` folder, already
gitignored) for safekeeping; this is also the file whose contents get uploaded as the
`CLASP_CREDENTIALS` GitHub secret (see [`ci.md`](ci.md)).

## Link to the real Apps Script project

The `scriptId` for the exchange-rates document is already pinned in
[`../clasp-targets/exchange-rates.clasp.json`](../clasp-targets/exchange-rates.clasp.json)
(extracted from the legacy script's project URL — a `scriptId` is an identifier, not a
secret, so it's safe to version). To work against it locally:

```bash
cp clasp-targets/exchange-rates.clasp.json .clasp.json
npx clasp pull      # bring down the real appsscript.json + current source, once
```

> `.clasp.json` itself is **not** committed (see `.gitignore`) — it's always generated
> from a `clasp-targets/*.clasp.json` file, so switching targets never requires editing
> a tracked file. The `appsscript.json` checked into `src/` today is a placeholder;
> reconcile it against the real manifest the first time you run `clasp pull`.

## Configure Script Properties (once, per Apps Script project)

Open the project in the Apps Script web editor (Project Settings → Script Properties)
and set:

| Property | Value |
| --- | --- |
| `PF_RATES_API_KEY` | the `X-API-Key` used to call `pf-rates`'s export endpoint |
| `EXPORT_DRIVE_FILE_ID` | the Google Drive file ID of the exported **combined** CSV (`financial-data.csv`, from `POST /exports/financial-data`) |
| `GET_CLP_API_KEY` | shared secret required as the `key` query param on the `GET_CLP` Web App endpoint (see "GET_CLP Web App deployment" below and [`api.md`](api.md)) |

These replace the values that were previously hardcoded in source. See
[`api.md`](api.md) for how the code reads them.

The spreadsheet must have a `VALUES` tab with 5 columns, in this exact
order: ID, Code, Date, CLP Value and Last Modified -- `updateExchangeRates()`
upserts into it from the CSV. The header row's actual text is purely
decorative: Apps Script never reads it (see `readExistingRows`/`writeRows`
in `src/infrastructure/`, both start at row 2), so relabeling a header --
e.g. showing "Last Modified" instead of "last_modified_at" -- is safe at
any time, with no code change and no redeploy. Only the **column order**
matters.

## GET_CLP Web App deployment (once, per Apps Script project)

`GET_CLP` (see [`api.md`](api.md)) is served by a Web App deployment of the same
`exchange-rates` Apps Script project -- not a separate project. Unlike
`scriptId` (versioned in [`clasp-targets/exchange-rates.clasp.json`](../clasp-targets/exchange-rates.clasp.json)
and consumed directly by `clasp`), the deployment ID below isn't read by any
tooling yet (that lands in a later phase, alongside `clasp deploy -i <id>` in CI) --
it's recorded here purely so it doesn't only live in one person's browser history.

| | |
| --- | --- |
| Deployment ID | `AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk` |
| Web app URL | `https://script.google.com/macros/s/AKfycbw4QLt1lRwNAIltLr36L3Obmdgawm2FmhFB5BfAiY2iqi5OhGR6Bi1Xr5jJXqfc0YAk/exec` |
| Execute as | Me (`USER_DEPLOYING` in the manifest) |
| Who has access | Anyone, including anonymous requests (`ANYONE_ANONYMOUS` in the manifest) -- access control is enforced by the `key` query param, not by this setting; see [`design-notes.md`](design-notes.md#web-app-access-control-anonymous-reachability-plus-a-key) |

Neither value is a secret -- an Apps Script deployment ID/URL grants nothing by
itself, since `doGet` (once implemented) still requires `GET_CLP_API_KEY`. The
real secret is that Script Property.

This deployment currently serves no code (`doGet` doesn't exist in `src/`
yet) -- hitting the URL above returns Google's generic "Script function not
found: doGet" error until that lands. Redeploying after future code changes
reuses this same ID via `clasp deploy -i <id>` (never `clasp deploy` without
`-i`, which would create a brand new, separate deployment/URL instead of
updating this one).

## GET_CLP Library (for other Apps Script projects to consume `GET_CLP`/`GET_CLP_RANGE`)

The **same** `exchange-rates` project is also published as an Apps Script **Library**
(`src/interfaces/library.js`) -- this is how other Apps Script projects (Payroll,
MedicalRefund, ...) get `GET_CLP`/`GET_CLP_RANGE` without hand-pasting the full retry/
parsing logic; see [`api.md`](api.md#consuming-get_clp--get_clp_range-from-another-apps-script-project-library)
for the consumer-side install runbook and
[`design-notes.md`](design-notes.md#why-get_clpget_clp_ranges-client-code-is-distributed-as-an-apps-script-library)
for why a Library was chosen over hand-pasting or this repo owning consumer projects
wholesale.

| | |
| --- | --- |
| Library script ID | Same as the `scriptId` above: `1DMVavLk-uV8kSkdpLmvYCzk_7w5becIcwjOukVO09cpD8WNi2ECAK4m-` -- not a secret. |
| Version management | `scripts/push-target.sh` cuts a new immutable Library version (`clasp version`) after every `clasp push` to this target (see [`ci.md`](ci.md#library-version-cut-get_clpget_clp_range)) -- automatic, no manual step here. |

A Library version is immutable and consumers pin to a specific number (Apps Script has
no supported "always use HEAD" option for production custom-function calls) -- so a new
version existing here does **not** automatically reach any consumer; someone still has
to bump the version pointer in each consumer's own Apps Script editor (Libraries panel)
when they want the update. This is a deliberate, human-reviewed step, not a gap.

## Run tests

```bash
make check   # lint + jest
```

## Push manually (normally CI does this on merge to `main`)

```bash
make push ALIAS=exchange-rates
```
