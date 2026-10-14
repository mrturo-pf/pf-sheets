# GitHub Actions Workflows

This directory contains the CI/CD workflow for `pf-sheets`. Unlike `pf-rates` and
`pf-payroll`, this is **not** a thin caller into `pf-common`'s reusable workflows —
those are 100% Docker/Cloud Run and don't apply to an Apps Script project pushed via
`clasp` (there's no container, no Cloud Run service, no Cloud SQL). This workflow is
self-contained instead.

## `deploy.yml` — CI / Deploy Apps Script

**Trigger:** push to `main`, pull requests targeting `main`.

A 5-job pipeline (only Test & Lint runs on pull requests):

| # | Job | What it does |
|---|---|---|
| 1 | **Test & Lint** | `npm ci` → eslint → `jest --coverage` |
| 2 | **Resolve targets.json** | Reads `targets.json`, exposes the list of aliases as a matrix for deployment |
| 3 | **Deploy (matrix)** | One run per target alias: restores `CLASP_CREDENTIALS` to a repo-relative `.clasprc.json`, then `scripts/push-target.sh <alias>` (swaps in that target's `.clasp.json` and runs `clasp push`) |
| 4 | **Notify — Failure** | Emails on deployment failure (push to `main` only). No-ops if `MAIL_*` secrets aren't set |
| 5 | **Notify — Success** | Emails only after Deploy succeeds for every target (push to `main` only). Same no-op behavior |

There is no build/image/scan step — the entire "deploy" is `clasp push` overwriting the
Apps Script project's HEAD. See [`../../docs/ci.md`](../../docs/ci.md) for the full
authentication story (including why `clasp` is pinned to an exact version) and
[`../../docs/development.md`](../../docs/development.md#adding-a-new-documenttarget-scaling-to-n-sheets)
for how adding a new target document only touches `targets.json`/`clasp-targets/` —
never this workflow.

There is no separate manual production approval gate. The merge to protected
`main` is the release approval; deployment runs automatically after the merge.

## Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `CLASP_CREDENTIALS` | Content of a clasp 3.x `.clasprc.json`, generated once via the interactive login documented in `docs/ci.md`. Restored to a repo-relative file per job run, never written to `$HOME`, never logged. |
| `MAIL_SERVER`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM`, `MAIL_TO` | (Optional) SMTP config for the Notify jobs — same convention as `pf-rates`/`pf-payroll`. If unset, the email step fails silently (`continue-on-error: true`) without failing the pipeline. |

## Rotating `CLASP_CREDENTIALS`

See [`../../docs/ci.md`](../../docs/ci.md#rotating-the-secret).

## Troubleshooting

- **`Could not find script.` during deploy:** almost certainly a `clasp` version
  mismatch, not a real permissions problem — see the "War story: clasp 2.x vs 3.x"
  section in [`../../docs/ci.md`](../../docs/ci.md). Confirm `package.json` still pins
  `@google/clasp` to the exact version the `CLASP_CREDENTIALS` secret was generated
  with.
- **Deploy job can't find a target's scriptId:** confirm `targets.json` and the
  matching `clasp-targets/<alias>.clasp.json` are both committed — `scripts/
  resolve-target.js` fails loudly if the alias isn't listed.
- **Workflow not triggering:** confirm the push/PR targets `main` and the workflow
  file is enabled under Actions.

## See Also

- [`../../docs/ci.md`](../../docs/ci.md) — full authentication + rotation guide.
- [`../../docs/development.md`](../../docs/development.md) — multi-target model.
- [`../../Makefile`](../../Makefile) — local equivalents of the CI quality gates
  (`make check`) and of a manual push (`make push ALIAS=<alias>`).
