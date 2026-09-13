# LeadFlow CI — Release Validation Gate

`LeadFlow CI` is the mandatory release-validation gate for this repository. It
replaced the empty placeholder workflows that GitHub Actions used to register
and fail on every push (see [Before this gate](#before-this-gate)).

This document is the operating contract: what runs, how to reproduce it
locally, what may merge, and what must be configured in GitHub (which this
repository's PR did **not** change — branch protection is a repository setting,
not a code change).

---

## 1. At a glance

| Item | Value |
| --- | --- |
| Workflow name | `LeadFlow CI` |
| Workflow file | `.github/workflows/ci.yml` |
| Job id / job name | `validate` |
| **Required check name** | **`LeadFlow CI / validate`** |
| Triggers | `pull_request` → `main`, `push` → `main`, `workflow_dispatch` |
| Runner | `ubuntu-latest` (GitHub-hosted) |
| Node.js | 22.x LTS (installed by `actions/setup-node`, resolved from the runner tool cache) |
| npm | bundled with Node 22 (`npm ci`) |
| Caching | `actions/setup-node` npm download cache keyed on `package-lock.json` |
| Token permissions | `contents: read` only |
| Secrets required | **none** (no production credentials, no paid services) |
| Job timeout | 25 minutes |
| Concurrency | `LeadFlow CI-<PR number \| ref>`, `cancel-in-progress: true` |
| Deployment | none — this workflow never deploys anything |

---

## 2. Triggers

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:
```

- **`pull_request` → `main`** — every PR targeting `main` is validated before it
  can be considered merge-ready. No path filters are used: there is no
  "skip CI because only docs changed" loophole.
- **`push` → `main`** — the same jobs re-run on the merge commit itself, which
  is the final integrity check that what actually landed on `main` is valid
  (it also catches the case where a merge resolves differently from the PR
  head). This is a *validation* run only: no automatic deployment, migration
  or rollback happens.
- **`workflow_dispatch`** — manual re-run for ad-hoc validation or to refresh a
  stale result without pushing a new commit.

Note: GitHub does **not** create PR-branch `push` runs for a workflow that is
not yet on the default branch. The first `LeadFlow CI` run on a new branch may
therefore appear only after the branch is pushed as part of an open PR (or after
the workflow is merged into `main`). Once it is on `main`, every PR gets checks.

## 3. Job and check name

There is deliberately **one** job, `validate`. GitHub reports it as the check
run:

```
LeadFlow CI / validate
```

Branch protection / rulesets should require exactly that check name. Keeping a
single job means there is exactly one thing to require and one thing to read when
a run goes red — no fan-out into fragile per-area check names that drift over
time. The stages inside the job are ordered fastest-failure-first where it is
free to do so, but they are all blocking: there is no `continue-on-error`, no
`if: always()` masking, and no per-path skipping anywhere in the workflow.

## 4. Validation gates (exact commands)

The job runs these steps, in order. Every one of them is blocking — a non-zero
exit fails the job and the required check.

| # | Step name in the run | Exact command | What it protects |
| --- | --- | --- | --- |
| 1 | Install dependencies | `npm ci` | Reproducible installs; also proves `package.json` and `package-lock.json` are in sync (`npm ci` refuses to run when they diverge) |
| 2 | Full test suite | `npm test -- --run` | The whole server suite: auth/session, RBAC + fallback safety, lead visibility / workspace / pool, bulk lead import, bulk user import, scheduled activities, dashboards, source guards, chunk recovery, flexible reporting hierarchy, Lead Quality, production security |
| 3 | Typecheck | `npx tsc --noEmit` | TypeScript correctness across client, server, scripts |
| 4 | Production build | `npm run build` | Vite client build + bundled `dist/server.cjs` server build |
| 5 | Serverless verification | `npm run verify:serverless` | Vercel-style per-file ESM serverless build + boot smoke test (`/api/health`, `/api/db-status`, auth protection, 404 handling, no `ERR_MODULE_NOT_FOUND`) |
| 6 | Diff / whitespace validation | `git diff --check` | Whitespace errors, conflict markers and similar diff defects |

The tests are the real suite — nothing is excluded, disabled or weakened for CI.
`npm test` is `tsx --test server/tests/*.test.ts`; the `--run` argument is the
documented gate invocation and is passed straight through.

### About gate 6

`git diff --check` on its own only inspects the index and working tree, which in
a fresh CI checkout is empty. The step therefore runs the documented command
first and then repeats the same check across the commits the run is validating:

```bash
git diff --check                                        # documented gate
git diff --check "$(git merge-base origin/main HEAD)" HEAD   # commits in this run
```

Both are the same check; the second one is what actually catches a PR that
commits trailing whitespace or an unresolved conflict marker. If the base ref
(or its merge base) is unavailable in the checkout, the step emits a
`::warning::` and skips only the range check — it never fails the job for
infrastructure reasons.

## 5. Node.js version — 22.x, and why

The gates run on **Node 22 LTS** (`node-version: '22'`, which resolves to the
latest 22.x in the runner's tool cache — 22.23.x at the time of writing).
Node 20 was evaluated first, because it is the conservative choice for a
release gate, and rejected for a concrete, reproducible reason:

- The mandated gate command `npm test -- --run` expands to
  `node --test server/tests/*.test.ts --run`. On Node 20 the CLI treats the
  trailing `--run` as a test file path and aborts:

  ```
  Could not find '.../--run'          # Node 20.18.0, exit code 1
  node: bad option: --run             # if the flag is placed before the files
  ```

  On Node 22 the same command runs the full suite (verified locally: 723 tests,
  0 failures). Node 22 is therefore the only version where the required gate is
  usable as specified.
- Dependency engine ranges require it or a very recent Node 20:
  `eslint@10` and `@vitejs/plugin-react@5` declare
  `^20.19.0 || >=22.12.0`; `@supabase/supabase-js` requires `>=20.0.0`;
  the repo's own `@types/node` is `^22`.
- The repository's serverless verification transpiles with an esbuild
  `target: node20` (syntax baseline), so Node 22 is a strict superset of the
  deployed runtime's syntax requirements.
- Node 20 is in maintenance and reaching end of life; Node 22 is the current
  LTS line.

`package.json` intentionally has **no `engines` field and no `.nvmrc`** — adding
one would be a project-wide policy change outside the scope of the CI PR. The CI
Node version is pinned in exactly one place: `node-version: '22'` in
`.github/workflows/ci.yml`. If you want the pin enforced for local development
too, add an `.nvmrc` / `engines` entry in a dedicated follow-up PR.

## 6. Secrets and environment policy

**CI requires no production secrets, and none are configured.**

- No `DATABASE_URL`. The integration tests provision their own isolated,
  in-process PostgreSQL via PGlite and set `process.env.DATABASE_URL =
  'pglite://memory'` themselves. No Supabase project, no network database, no
  paid service is touched.
- No `JWT_SECRET`. Tests that sign tokens fall back to
  `process.env.JWT_SECRET || 'leadflow_development_only_secret'`, and
  `scripts/verify-serverless-build.mjs` boots its harness with a test-only
  secret when the environment does not provide one.
- No Vercel token, no Supabase service key, no third-party API key. The Gemini /
  Supabase browser variables (`GEMINI_API_KEY`, `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`) are read by `vite.config.ts` and default to empty
  strings when absent, so the production build succeeds without them.
- The workflow declares no `env:` block at all, because inspection showed no
  test or build step needs one. If a future test genuinely requires a value,
  add a clearly-labelled CI-only dummy in the workflow, e.g.

  ```yaml
  env:
    JWT_SECRET: leadflow-ci-only-secret   # never a production value
  ```

  Real credentials must never be added to workflow files or committed `.env`
  files; long-lived deployment credentials stay in Vercel/GitHub settings, and
  this workflow has no `secrets.*` references.
- `npm run verify:serverless` is run **without** `DATABASE_URL` on purpose. That
  is its production-honesty mode: it asserts `/api/auth/login` returns 503
  ("Database is not configured") rather than silently falling back to
  in-memory storage. Do not add a database URL to CI to "make it pass" — that
  would trade a real production guarantee for a prettier log.

## 7. Caching policy

- `actions/setup-node` with `cache: npm` and
  `cache-dependency-path: package-lock.json`. This caches npm's download cache
  only (`~/.npm`), keyed on the lockfile hash.
- `node_modules` is intentionally **never** cached. An install cache must not be
  able to hide a broken lockfile, a platform mismatch or a stale native
  dependency, and `npm ci` (which deletes `node_modules` first) is what
  guarantees a clean, reproducible install.
- `npm install` is never used in CI, and `package-lock.json` is never
  regenerated by the workflow. If `npm ci` fails because `package.json` and the
  lockfile disagree, that is a real defect to fix in the PR — not something CI
  should paper over by re-resolving dependencies.
- Cache misses are expected on the first run after a lockfile change and cost
  a few seconds; correctness is not traded for cache hits.

## 8. Concurrency and cancellation

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

Validation runs are grouped per pull request (falling back to the branch ref for
pushes). When a correction commit is pushed to an open PR — routine for
Arena-generated PRs — the superseded run is cancelled immediately instead of
finishing and reporting a stale red/green result. The newest commit always owns
the check status for the PR.

## 9. Timeout and resource safety

`timeout-minutes: 25` on the single job bounds any hung install, test, build or
serverless harness. Measured locally on the reference environment the full gate
takes roughly 3.5 minutes of wall clock:

| Step | Local time |
| --- | --- |
| `npm ci` (warm cache) | ~10 s |
| `npm test -- --run` | ~2 m 09 s |
| `npx tsc --noEmit` | ~9 s |
| `npm run build` | ~9 s |
| `npm run verify:serverless` | ~30 s |
| `git diff --check` | < 1 s |

GitHub's hosted runners are slower than a developer machine, so 25 minutes
leaves a wide margin while still guaranteeing the job dies rather than burning
CI minutes indefinitely. The test suite runs its files sequentially in one
process; if runtime ever approaches the limit, split the suite into jobs
*behind* the same required check name rather than sharding silently.

## 10. What to do when a run fails

Open the run from the PR's **Checks** tab, expand the failed step, and read the
step name — each step maps 1:1 to a command you can run locally:

| Failed step | Reproduce locally | Typical cause |
| --- | --- | --- |
| Install dependencies | `npm ci` | `package.json` / `package-lock.json` out of sync, or a registry/network hiccup (re-run first) |
| Full test suite | `npm test -- --run` | A real regression, or a genuine CI-only timing issue — see below |
| Typecheck | `npx tsc --noEmit` | Type error, or a missing/renamed type import |
| Production build | `npm run build` | Vite/esbuild build error, unresolved import, missing asset |
| Serverless verification | `npm run verify:serverless` | Bare extensionless relative import (Lambda `ERR_MODULE_NOT_FOUND`), an endpoint changed status codes, or a silent in-memory fallback appeared in production mode |
| Diff / whitespace validation | `git diff --check` | Trailing whitespace, tab/space mix or conflict marker on a changed line |

Diagnostic tips:

1. **Reproduce with the same runtime.** Use Node 22 (`nvm use 22`) — a pass on
   Node 18/20 tells you nothing about the CI result, as section 5 explains.
2. **Read the first failure, not the last.** Later steps are ordered so the
   earliest failure is usually the real one.
3. **Flaky or timing-dependent failure.** Re-run once (`gh run rerun <id>` or the
   "Re-run failed jobs" button). If it reproduces, treat it as a real,
   deterministic bug and fix the root cause in the PR: do not add retries,
   timeouts, `--test-force-exit`, `continue-on-error`, or a skipped test to get
   to green. Excluding a test to unblock a merge is not an acceptable fix.
4. **Whitespace failure on a line you did not touch.** The range check only
   inspects lines the run adds or changes; run `git diff --check` in the PR
   branch and strip the reported whitespace.
5. **Cancelled run.** Expected: a newer commit on the same PR cancels the older
   run. Read the newest run instead.

Runs can also be re-triggered manually:

```bash
gh workflow run "LeadFlow CI" --ref <branch>     # workflow_dispatch
gh run list --workflow "LeadFlow CI"             # recent runs
gh run view <run-id> --log-failed                # only the failing steps
```

## 11. Relationship to Vercel

- Vercel's GitHub Git integration is **unchanged** by this workflow and remains
  the deployment mechanism. Vercel builds a preview for PRs and production from
  `main`, producing the `Vercel` status/check.
- This workflow contains **no** deploy, `vercel` CLI, token, or
  production-migration step. It has read-only repository permission and no
  credentials at all.
- CI and Vercel answer different questions and neither substitutes for the
  other: Vercel proves "the platform could build and serve this revision";
  `LeadFlow CI` proves "the suite passes, the types are sound, the production
  build succeeds, the serverless bundle boots, and the diff is clean". A green
  Vercel deployment **does not** replace CI, and CI going green does not deploy
  anything.
- Observed before this gate was added: `LeadFlow CI` did not exist, and PRs
  #37–#40 showed only `Vercel` / `Vercel Preview Comments` checks (plus a
  skipped `Supabase Preview`). In other words, "Vercel is green" was the only
  automated signal — exactly the gap this workflow closes.

## 12. Release rule (what may merge)

A pull request is **not merge-ready** unless all of the following hold:

1. **`LeadFlow CI / validate` passes** on the head commit of the PR.
2. **Vercel's PR preview / build check passes** when applicable (it is a
   separate, optional-to-require signal — see below).
3. **Code review is complete** and any review comments are resolved.

Additional rules:

- A successful Vercel deployment **alone never satisfies** the release rule.
- Do not merge on a cancelled, stale or superseded run — only the run for the
  current head commit counts.
- Do not merge by pushing to `main` directly while CI is red.
- `main` must stay releasable: the `push` run on the merge commit is the
  post-merge audit; if it fails, treat it as a production-risk incident and fix
  forward immediately.

## 13. Branch protection / ruleset recommendation

> **Status: not configured by this PR.** This PR adds the workflow only. No
> repository setting, ruleset, branch protection rule, collaborator, secret or
> environment was modified, and no claim is made here that protection is
> currently enabled. The repository currently exposes **no rulesets**
> (`GET /repos/.../rulesets` returned an empty list), and reading
> `main`'s branch protection requires repository admin rights that the tooling
> used for this change does not have (HTTP 403). Verify the live state in
> **Settings → Rules / Branches** before relying on it.

Recommended configuration for `main` (apply in GitHub Settings → Rules, or
Branches → Branch protection rules; requires repository admin):

- Require a pull request before merging (at least 1 approval, dismiss stale
  approvals, require review of the latest push).
- **Require status checks to pass before merging**, and require:
  - `LeadFlow CI / validate` — the canonical required check.
  - Optionally `Vercel` if you want the preview build to block merges too.
- Require branches to be up to date before merging (so the validated commit is
  the commit that lands).
- Require conversation resolution, block force pushes, and restrict deletions on
  `main`.
- Do not enable "Allow specified actors to bypass required pull requests"
  for routine work; if an emergency bypass is needed, it should be a deliberate,
  logged action.

With the ruleset in place, a red `LeadFlow CI / validate` makes the PR
unmergeable rather than merely frowned upon.

## 14. Reproduce the gate locally (pre-push checklist)

```bash
# Node 22 required — see section 5
node -v                      # v22.x

npm ci                       # 1. reproducible install
npm test -- --run            # 2. full suite (≈2 min)
npx tsc --noEmit             # 3. typecheck
npm run build                # 4. production build
npm run verify:serverless    # 5. serverless verification (no DATABASE_URL!)
git diff --check             # 6. whitespace / diff errors
```

Run the same list before pushing a correction commit to an open PR, so the CI
result is a confirmation rather than a surprise.

## 15. Before this gate

At inspection time the repository contained three **zero-byte** workflow files:

| File | Size | Behaviour |
| --- | --- | --- |
| `.github/workflows/client.yml` | 0 bytes | Registered by Actions, failed on every push (0 s, no jobs) |
| `.github/workflows/server.yml` | 0 bytes | Same |
| `.github/workflows/deploy.yml` | 0 bytes | Same |

Each push to `main` — and each push to a PR branch — produced three
always-failing runs, which trained everyone to ignore red Actions results while
providing no validation whatsoever. They were deleted in favour of this single
canonical workflow; no check name from the placeholder era survives, so there
are no duplicate or competing checks.

## 16. Explicit non-goals

This workflow deliberately does **not**:

- deploy, promote or roll back anything, on any provider;
- run database migrations against any environment;
- call the Vercel API, read a Vercel token, or replace Vercel's Git integration;
- require or read production secrets;
- auto-merge PRs, auto-approve, or add dependency-update bots;
- change application behaviour (Lead Quality, RBAC, hierarchy, auth or
  production security code are all untouched);
- weaken, skip or delete any existing test.
