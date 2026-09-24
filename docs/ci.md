# CI/CD

## Pipeline overview

[`../.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs:

```
Push/merge to main
   │
   ▼
[test]  npm ci → eslint → jest
   │
   ▼
[gate-with-approval]  pause on the `production` GitHub environment
   │
   ▼
[deploy]
   1. checkout
   2. setup-node
   3. npm ci
   4. restore CLASP_CREDENTIALS secret → ~/.clasprc.json
   5. read targets.json
   6. matrix: for each target → scripts/push-target.sh <alias>
   │
   ▼
[notify-success]
```

## npm registry: `package-lock.json` must resolve to the public registry

`.npmrc` points `registry` at Corporative's internal Artifactory npm mirror
(`npm.ci.artifacts.corporative.com`) — needed **locally**, on the corporate
network/VPN, where the public npm registry can return `407 Proxy
Authentication Required` without it. GitHub-hosted runners (`ubuntu-latest`)
are the opposite: public internet only, no route to that internal host.

The first real run of this pipeline failed on that mismatch, but not in the
obvious way. `npm ci` (unlike `npm install`) **ignores the configured
registry for packages that already have a `resolved` URL in the lockfile** —
it fetches that literal URL. Since `package-lock.json` had been generated
locally against the Corporative mirror, every single entry's `resolved` field
pointed at `npm.ci.artifacts.corporative.com`. Setting
`NPM_CONFIG_REGISTRY=https://registry.npmjs.org` at the workflow level (the
first fix attempted) changed nothing — `npm ci` never even looked at it. The
unreachable-host connection attempts hung until a known npm bug (`Exit
handler never called!`) let the step exit anyway without fully populating
`node_modules`, surfacing later, confusingly, as `sh: 1: eslint: not found`
in the *next* step instead of a clear registry/network error in `npm ci`
itself.

Real fix: regenerate `package-lock.json` so every `resolved` URL points at
the public registry — `rm -rf node_modules package-lock.json && \
NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm install`. `deploy.yml`
still sets `NPM_CONFIG_REGISTRY` at the workflow level as defense-in-depth
(it does matter for `npm install`/anything that re-resolves), but the
lockfile is the actual source of truth `npm ci` reads from.

**Gotcha for future `npm install`/`npm update`:** running them normally
resolves through whatever `.npmrc` currently points at (the Corporative mirror),
which silently reintroduces internal-mirror URLs into the lockfile for just
the touched packages and reproduces this exact CI failure on the next push.
Always force the public registry when the lockfile is going to change:
`NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm install <pkg>`.

## clasp version: pinned exactly, not a range

`package.json` pins `"@google/clasp": "3.4.1"` **without a caret**. This is
deliberate, not an oversight: clasp 2.x has a confirmed bug where a custom
`--creds` ("local") login never gets wired into the actual API clients used by
`push`/`pull`/`clone`/`deploy` — only `clasp run` honors local credentials in
that line. It always fails with a generic `Could not find script.` error that
has nothing to do with the scriptId. Version 3.x fixed this (rewrote the auth
layer around a single `-A/--auth` credential-file concept used uniformly by
every command). The `.clasprc.json` **file format also changed** between 2.x
and 3.x (flat/local-wrapped shape -> `{ "tokens": { "default": {...} } }`), so
a secret generated with one major version cannot be reused by the other.
**Never widen this to a caret range** without re-validating the whole login ->
pull -> push chain by hand first — see "War story: clasp 2.x vs 3.x" below if this
ever needs revisiting.

## Authentication: OAuth "Desktop app" + refresh token

Same mechanism already validated in `pf-rates` for its Google Drive export (see
`pf-rates/docs/deployment.md` and the ecosystem's `secrets/README.md`): a Service
Account cannot operate the Apps Script API on behalf of a real user, so instead:

1. A Google Cloud OAuth Client ID of type **Desktop app** (reuse the one already
   created for `pf-rates`) is used for a one-time, interactive login, run from
   inside `pf-sheets/` so the credential file lands in the repo checkout instead
   of the real `~/.clasprc.json` (which would collide with any other clasp
   project on the same machine):
   ```bash
   clasp_config_auth="$(pwd)/.clasprc.json" npx clasp login --creds <path-to-client-secret.json> --no-localhost
   ```
2. clasp 3.x's `--no-localhost` no longer supports Google's (deprecated) pure
   "oob" copy-paste-a-code flow. It still prints a URL to open, and the redirect
   target (`http://localhost:8888/...`) will **fail to load in the browser —
   that's expected**, nothing is meant to be listening there. Copy the full
   URL from the browser's address bar (not just the `code` value) and paste it
   back at the CLI prompt ("After authorizing, copy the URL from your browser
   and paste it here").
3. That produces a local `.clasprc.json` (path controlled by the
   `clasp_config_auth` env var — same mechanism used in CI, see below),
   containing a refresh token bound to the custom OAuth client.
4. Its content is stored as the GitHub encrypted secret `CLASP_CREDENTIALS`.
5. The GCP project must be published as **"In production"** (not "Testing") in the
   OAuth consent screen, or the refresh token expires after 7 days.
6. In CI, a step restores the secret to a repo-relative file (e.g.
   `$GITHUB_WORKSPACE/pf-sheets/.clasprc.json`) and every clasp invocation sets
   `clasp_config_auth` to that same path — no dependency on the runner's `HOME`.

## Rotating the secret

If the token is revoked or stops working:

1. Repeat the one-time login (same `clasp_config_auth=... npx clasp login --creds ... --no-localhost`
   command above) locally.
2. Update the `CLASP_CREDENTIALS` GitHub secret with the new `.clasprc.json` content.
3. Update the local copy at `../../secrets/pf-sheets/clasprc.json` too (kept in sync,
   never committed).

## War story: clasp 2.x vs 3.x (login + pull gotchas)

Getting the very first `clasp login` + `clasp pull` working surfaced a chain of bugs
and gotchas in `clasp` itself, not in this project. Documented here so nobody has to
rediscover it:

1. **`clasp login` hangs with no error**: in some environments (a managed-security
   corporate machine, for example) clasp's local server + browser auto-open hangs
   silently. Workaround: `--no-localhost`.
2. **`clasp login` requires an existing `.clasp.json`**, even just to log in (arguably
   shouldn't, but that's how it's implemented) — you need a `.clasp.json` with a real
   `scriptId` before the first login.
3. **With `--creds`, clasp 2.x only requests the `script.webapp.deploy` scope** unless
   the local `appsscript.json` declares explicit `oauthScopes` — otherwise the token
   ends up without `script.projects` and is useless for anything real. Temporary
   workaround: declare the full `oauthScopes` in the local manifest just for the
   login, then let the next `clasp pull` replace them with the real ones.
4. **Confirmed bug in clasp 2.5.0**: the API clients (`script`, `drive`, `logger`) are
   instantiated once at module load, always bound to clasp's *global* default OAuth
   client — never to the *local* OAuth client that `--creds` sets up. Result: with
   local credentials, **`clasp run` works** but **`clasp pull`/`push`/`clone`/`deploy`
   always fail** with the generic `Could not find script.` message — regardless of the
   scriptId, account, and permissions all being 100% correct (verified by calling the
   Apps Script REST API directly with the same token: `200 OK`). Real fix: upgrade to
   **clasp 3.x**, which rewrote the auth layer around a single credential concept
   (`-A/--auth`, env var `clasp_config_auth`) used uniformly by every command.
5. **The `.clasprc.json` format changed** between 2.x and 3.x (from a local/global
   wrapper shape to `{ "tokens": { "default": {...} } }`) — a secret generated with
   one major version doesn't work with the other. That's why `package.json` pins
   `clasp` to an **exact** version (`3.4.1`, no `^`), not a range.
6. **`--no-localhost` on clasp 3.x no longer uses the classic "oob" flow** (Google
   deprecated it) — it still redirects to `http://localhost:8888/...`, which **will
   fail to load in the browser** (expected — nothing is listening there). Copy the
   **full URL** from the address bar (not just the `code` value) and paste it back at
   the terminal prompt.
7. **`clasp login --status` can report "unknown user" or mark domains unreachable**
   even with a valid login — it's an unreliable network check (`is-reachable`) plus a
   minor bug in `getLoggedInEmail()` (uses the global client even for a local login),
   not a real problem. Not observed anymore on clasp 3.x for the email part
   specifically.

Operative conclusion: always prefix any `clasp` invocation in this repo (local or CI)
with `clasp_config_auth="$(pwd)/.clasprc.json"` — see the "Authentication" section
above for the current, up-to-date detail.

## Rollback

There is no Cloud Run-style traffic rollback here — `clasp push` simply overwrites the
Apps Script project's HEAD. To roll back a bad deploy: revert the offending commit in
Git, merge to `main` again, and let the pipeline run `clasp push` with the previous
code.

## Multi-target deploys

See [`development.md`](development.md#adding-a-new-documenttarget-scaling-to-n-sheets)
— the `deploy` job matrixes over every entry in `targets.json`, so adding a document
never requires a pipeline change.

## Web App redeploys (GET_CLP)

`clasp push` updates a target's Apps Script project code, but **does not** by itself
update what a live Web App URL serves — a Web App deployment freezes a specific code
version at the moment it's deployed (see
[`getting-started.md`](getting-started.md#get_clp-web-app-deployment-once-per-apps-script-project)
for how that deployment was first created, and
[`design-notes.md`](design-notes.md#apps-script-custom-function-sandbox-constraints)
for the full design). So for any
target that has one, `scripts/push-target.sh` runs one extra step after `clasp push`:

```bash
clasp deploy -i <webAppDeploymentId>
```

`-i <id>` reuses the existing deployment/URL (never creates a new one, which would
change the URL every consumer sheet is hardcoded to call). The ID comes from
`targets.json`'s optional `webAppDeploymentId` field, resolved via
`scripts/resolve-webapp-deployment.js`; a target with no such field silently skips this
step — not every target needs a Web App (today only `exchange-rates` does).

This still goes through the exact same `Approval Gate` as the `clasp push` step — there
is no separate/lighter approval path for Web App redeploys, since they expand the
public-facing surface of the system just as much as (arguably more than) a code push
that only affects the bound macro.

**Rollback for the Web App specifically:** same mechanism as the rest of this
pipeline—revert the offending commit, merge to `main`, and the next `clasp push` +
`clasp deploy -i <id>` cycle serves the previous code again at the same URL. There is no
separate "pin an old Web App version" step to remember.

## Library version cut (GET_CLP/GET_CLP_RANGE)

`exchange-rates` is also published as an Apps Script Library (`src/interfaces/
library.js`) -- see [`getting-started.md`](getting-started.md#get_clp-library-for-other-apps-script-projects-to-consume-get_clpget_clp_range)
and [`api.md`](api.md#consuming-get_clp--get_clp_range-from-another-apps-script-project-library).
After `clasp push` (and any Web App redeploy above), `scripts/push-target.sh` runs one
more step for any target flagged `"isLibrary": true` in `targets.json` (today only
`exchange-rates`):

```bash
clasp version "CI: <commit sha>"
```

This cuts a new **immutable** Library version -- required because a Library reference in
a consuming project always pins to a specific version number; there is no supported
"always use HEAD" option for production custom-function calls (see
[`design-notes.md`](design-notes.md#apps-script-custom-function-sandbox-constraints)).
So this step guarantees a fresh version always
exists after every deploy, but it deliberately does **not** update any consumer's
pinned version pointer -- that stays a manual, human-reviewed step per consumer (Apps
Script editor → Libraries → change version), same as picking the version in the first
place during install.

Gated by `scripts/resolve-is-library.js`, mirroring `resolve-webapp-deployment.js`'s
pattern exactly: a target with no `isLibrary` flag silently skips this step.
