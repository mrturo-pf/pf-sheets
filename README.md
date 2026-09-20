# pf-sheets

Google Apps Script source for the exchange-rates sync macro, versioned in Git and
deployed via [`clasp`](https://github.com/google/clasp) instead of the
script.google.com web editor.

## Overview

This repo owns the **bound Apps Script project** attached to the exchange-rates Google
Sheet: a macro (`updateExchangeRates`) that triggers a CSV export from
[`pf-rates`](../pf-rates), reads the resulting file from Google Drive, and performs an
incremental upsert into the sheet's `EXCH_RATE` tab.

- Development happens **locally**, in this repo — not in the Apps Script web editor.
- Changes are pushed to the live Apps Script project automatically on merge to `main`.
- The result keeps working exactly as before: a macro the user runs manually from the
  Sheet's custom menu. Only the development/deploy model changes.

Previously, this Apps Script project was edited directly in the script.google.com web
editor, with no version control, no review, and no repeatable deploy path. This repo
replaces that with a normal local-development workflow — only how the code gets
written and shipped changed, not what the macro does.

## Quick start

See [`docs/getting-started.md`](docs/getting-started.md) for installation, `clasp`
login, and the first local push.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/getting-started.md`](docs/getting-started.md) | Installation, `clasp` auth, first local run |
| [`docs/development.md`](docs/development.md) | Code layout, testing, adding a new document/target |
| [`docs/ci.md`](docs/ci.md) | CI/CD pipeline, auth secret rotation, rollback |
| [`docs/api.md`](docs/api.md) | What the macro does, CSV contract with pf-rates |
| [`AGENTS.md`](AGENTS.md) | AI agent reference: architecture, code style, design principles |
