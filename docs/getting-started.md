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

## Run tests

```bash
make check   # lint + jest
```

## Push manually (normally CI does this on merge to `main`)

```bash
make push ALIAS=exchange-rates
```
