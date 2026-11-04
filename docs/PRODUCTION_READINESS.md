# LeadFlow — Production Readiness

Status: **one stage of the production-readiness roadmap — not a claim of full
production readiness.** This document describes the operational hardening that
exists today, the contracts operators can rely on, and the work that is still
open. It is the top-level reference; the runbooks cover procedure (release,
backup/restore, incident response) and link back here.

---

## 1. Readiness architecture at a glance

| Layer | Mechanism | Where |
| --- | --- | --- |
| Configuration validation | `server/config/env.ts` — pure, secret-free classification + validation | server-side only |
| Liveness | `GET /api/health` (`/health`) | both entrypoints |
| Readiness | `GET /api/health/readiness` (`/health/readiness`) — **new, additive** | both entrypoints |
| Database status | `GET /api/db-status` | both entrypoints |
| Build identification | `VERCEL_GIT_COMMIT_SHA` / `GIT_SHA` / `COMMIT_SHA` | readiness body |
| Production smoke test | `npm run smoke:production` (`scripts/smoke-production.ts`) | read-only |
| Schema verification | `npm run verify:db-schema` (`scripts/verify-db-schema.mjs`) | read-only |
| Release gate | `LeadFlow CI / validate` (`.github/workflows/ci.yml`) | CI |

Both production entrypoints — `api/index.ts` (Vercel serverless) and
`server.ts` (standalone) — mount the same configuration validation, the same
liveness endpoint, and the same readiness endpoint.

**Server layout (post-Phase-1).** `server/routes/production.routes.ts` is a
148-line mount shell: it holds the re-export surface, `GET /db-status`, and
one `router.use(...)` mount per domain. All route handlers live in
`server/routes/production/` — `auth.routes.ts`, `notifications.routes.ts`,
`metadata.routes.ts`, `roadshows.routes.ts`, `users.routes.ts`,
`leads.routes.ts`, `dashboard.routes.ts` — over `shared.ts` (JWT/auth
middleware and `signToken`, caller/visibility resolution, the audit helper).
Authentication is custom JWT (bcrypt + `jsonwebtoken`) and data access is
raw `pg` against PostgreSQL; there is no Supabase client/SDK in the stack.

**Spreadsheet handling (client).** Excel import/export runs through one
wrapper, `src/modules/shared/utils/excel.ts`, on `exceljs` (lazy-loaded
chunk; replaced the vulnerable, unmaintained `xlsx@0.18.5` in PR #100).
Legacy binary `.xls` uploads are rejected with a clear "save as .xlsx or
.csv" message — `exceljs` cannot read the pre-2007 format.

---

## 2. Liveness vs readiness

LeadFlow keeps the two concepts separate, because "Express responded" must
never be mistaken for "the business can operate":

- **Liveness** (`/api/health`): the application runtime can produce a
  response. It answers `200` with `ok: true` even when PostgreSQL is down,
  because the runtime *is* alive — but the `database` and `status` fields tell
  the whole truth (`degraded`, `misconfigured`, etc.).

- **Readiness** (`/api/health/readiness`): the critical dependencies required
  for real business operations are available. It answers `200` with
  `status: "ready"` only when the runtime is alive, the configuration is
  valid, **and** the database is both configured and reachable; otherwise it
  answers `503` with `status: "not_ready"` and the failing checks.

Liveness keeps its exact pre-existing response shape for backward
compatibility (existing consumers and regression tests depend on it).
Readiness is a new endpoint and does not disturb any existing consumer.

### Readiness body (example, secret-free)

```json
{
  "status": "ready",
  "service": "leadflow-api",
  "checks": {
    "runtime": { "ok": true },
    "config": { "ok": true, "issues": [] },
    "database": { "configured": true, "reachable": true }
  },
  "build": "abc123…",
  "environment": "production",
  "timestamp": "2026-09-13T00:00:00.000Z"
}
```

`build` is the Git commit SHA / deployment identifier when the environment
provides one (`VERCEL_GIT_COMMIT_SHA` on Vercel, `GIT_SHA` / `COMMIT_SHA`
standalone), or `null` when unavailable — never fabricated. Neither endpoint
ever returns a connection string, hostname, credential, SQL fragment or stack
trace.

---

## 3. Environment requirements

The canonical catalog lives in `server/config/env.ts`
(`ENV_VAR_SPECS`). Classification summary:

| Variable | Class | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **REQUIRED** | PostgreSQL connection string (the production database is hosted on Supabase; the app connects with the plain `pg` driver — no Supabase client/SDK). Server-only. |
| `JWT_SECRET` | **REQUIRED** | Strong, production-specific signing secret. Weak/default values are rejected. |
| `NODE_ENV` | REQUIRED | `production` for standalone; Vercel sets it automatically. |
| `TRUST_PROXY` | OPTIONAL | Trusted reverse-proxy hop count for rate-limit client IPs. |
| `PORT`, `PGSSL` | OPTIONAL | Standalone listen port / SSL override. |
| `SESSION_SECRET` | OPTIONAL | Reserved; the current auth flow is JWT-based. |
| `OBSERVABILITY_LOG_LEVEL` | OPTIONAL | Structured log level (`debug` \| `info` \| `warn` \| `error`). |
| `OBSERVABILITY_SLOW_REQUEST_MS`, `OBSERVABILITY_SLOW_DB_MS` | OPTIONAL | Slow-request / slow-query warning thresholds (defaults 2000 ms / 750 ms). |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | OPTIONAL | Web Push key pair for the follow-up reminder pushes (§3.1). Unset = push reminders disabled. Generate with `npx web-push generate-vapid-keys`. |
| `VAPID_SUBJECT` | OPTIONAL | VAPID contact URI; defaults to `mailto:admin@shantalife.com` when unset. |
| `CRON_SECRET` | OPTIONAL | Bearer secret guarding the daily push-reminder cron endpoint (§3.1). Unset = cron endpoint disabled (503). |

**In production:**

- Missing `DATABASE_URL` or `JWT_SECRET` is a **BLOCKER**.
- A `JWT_SECRET` that is missing, shorter than 16 characters, or an exact
  match for a known development/default/CI placeholder
  (`leadflow_development_only_secret`, `replace-with-a-long-random-secret`,
  `leadflow-ci-only-secret`, `changeme`, `secret`, …) is a **BLOCKER**.
- Configuration errors are explicit **but never expose a secret value**: the
  validator reports variable names and static, operator-facing messages only.

Consequences are enforced where they matter:

- The production router's `signToken` (`server/routes/production/shared.ts`)
  refuses to sign a token in production when the secret is missing or weak.
- The readiness endpoint reports `config.ok: false` with the offending
  variable names.
- Startup logs a secret-free `[config]` summary + per-issue lines.

### Production secrets policy (client boundary)

- **Server secrets are never injected into the browser bundle.** `DATABASE_URL`
  and `JWT_SECRET` are server-only and never appear in `vite.config.ts`
  `define` or any `import.meta.env` value.
- Only **public-by-design** variables may reach the client, and only via the
  `VITE_` prefix. The only one remaining is the build-time
  `VITE_API_BASE_URL` (API origin, set in `vite.config.ts` / `src/lib/apiBase.ts`);
  the former `VITE_SUPABASE_*` pair was removed with the unused Supabase
  client (PR #85, PR #100).
- A prior finding — `GEMINI_API_KEY` injected into the bundle via
  `vite.config.ts` — has been **fixed**: the key is not used by any runtime
  feature, so the Vite `define` entry, the only client import of
  `@google/genai`, and the now-unused dependency were all removed. Source
  guards (`production-readiness.test.ts` Part 5) and a built-output search
  prove the key name/value cannot be bundled into browser assets.
- If a server-side AI call is ever added, it must go through a server API
  boundary and **never** return the raw key to the client.

### 3.1 Feature switches and the daily reminder cron

Two Phase-3 automations are **runtime feature switches, default OFF**,
stored as Metadata options and toggled by an admin in
**Settings → Overview**. Until an admin enables one, behaviour is exactly
as before (all reads fail closed to OFF):

- **Lead Auto-Assignment** — option `LeadAutoAssignment` / `enabled`
  (seeded INACTIVE by migration 049). When ON, leads that arrive without
  an assignee are auto-assigned to the least-loaded active member of the
  creator's visibility scope, with the same audit + notification trail as
  a manual assignment.
- **First-Contact SLA** — options `LeadSla` / `enabled` (switch) and
  `LeadSla` / `firstContactHours` (`meta.hours`, **default 24**, clamped
  1–720), seeded by migration 051. When ON, the Workbench shows SLA
  chips and breached leads raise one-time assignee + manager alerts.

**Push reminders** (PR #95) are env-gated instead: they need
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (+ optional `VAPID_SUBJECT`) and
`CRON_SECRET` set on the Vercel project; with the keys unset the feature
is fully disabled and nothing else changes. One daily Vercel cron —
`30 2 * * *` UTC = **08:30 Asia/Dhaka** — calls
`GET /api/notifications/push/cron-daily`. **Caveat:** this repo's
`vercel.json` still uses the legacy `routes` array; after each deploy,
verify the cron is actually listed under **Vercel → Settings → Cron
Jobs**. If it is not, trigger the same endpoint from any external
scheduler with the `x-cron-secret` header (or
`Authorization: Bearer <CRON_SECRET>`).

---

## 4. Database failure policy (preserved, now covered by tests)

PostgreSQL remains authoritative. When the database is unavailable or
unconfigured in production:

- **writes fail** (HTTP 5xx/503 via `dbErrorStatus`),
- **no local mutation fallback**, no in-memory business persistence, no fake
  success, no automatic demo mode,
- the API returns an appropriate **503 / 5xx contract**.

Development-only demo mode (the `fallbackStore`) is activated **only** when
`NODE_ENV !== production`, `VERCEL` is unset, and `DATABASE_URL` is unset —
and is labelled `X-Data-Mode: dev-demo`. This is PR #40's fallback protection,
unchanged, and now exercised by `production-readiness.test.ts` and the
existing `rbac-fallback-safety-audit.test.ts`.

---

## 5. Migration discipline (current state + verification)

- Migrations run **automatically at startup** (`initializeDatabase()` →
  `runMigrations()` → `runSeeds()`), on both entrypoints.
- Migrations are **idempotent** (`CREATE TABLE IF NOT EXISTS` /
  `ALTER TABLE … IF NOT EXISTS`); seeds only run when their table is empty.
- **Finding (BLOCKER for unattended deploys):** a migration failure during a
  serverless cold start is logged but not surfaced as a readiness signal —
  the instance then serves per-request `503`s against an incomplete schema
  rather than failing fast. The `verify:db-schema` script (below) closes the
  operator-visible gap; restructuring the migration runner itself was judged
  out of scope (see §10).
- No migration-tracking table exists (migrations are re-runnable idempotent
  DDL, not a versioned ledger). Destructive migrations must be reviewed
  explicitly (see the release runbook).
- The migration sequence currently runs to **051**: 048
  `push_subscriptions`, 049 Lead Auto-Assignment flag seed, 050
  `processed_followup_mutations` (offline follow-up idempotency), 051
  Lead SLA config seed. Migrations 049/051 only seed Metadata option
  rows; the features they gate default to OFF (§3.1).

`npm run verify:db-schema` performs a **read-only** schema readiness check:
connect, `SELECT 1`, compare `information_schema` against the expected table
set, and exit non-zero when tables are missing. It never writes, never runs
migrations, and is deliberately **not** part of CI (CI must not require a
real production database).

---

## 6. Known risks / findings

Recorded during the audit; not all are fixed in this stage.

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | ~~`GEMINI_API_KEY` injected into the browser bundle via `vite.config.ts`.~~ | ~~HIGH~~ **FIXED** | The Vite `define` injection, the only client import of `@google/genai`, and the now-unused dependency were removed. The key is **not** used by any runtime feature (the client Gemini import was an unused placeholder). Source guards + built-output search prove it cannot be bundled. |
| 2 | Migration failures are logged but not surfaced as a readiness signal (see §5). | **HIGH** | Mitigated operationally by `verify:db-schema` + release-runbook gate; structural fix deferred. |
| 3 | `server/db.ts` and `server/server.ts` are legacy, unused duplicates (not imported by either entrypoint); `server/db.ts` contains a contradictory "fallback to in-memory" log line and unconditionally `rejectUnauthorized: false`. | MEDIUM | **Partially resolved:** `server/server.ts` and the rest of the dead modular tree were deleted in PR #93; `server/db.ts` remains (still unreferenced) for a future cleanup. |
| 4 | `DATABASE_URL` connections use `ssl: { rejectUnauthorized: false }` (Supabase convention). | MEDIUM | Accepted for Supabase; document for non-Supabase hosts in the deployment runbook. |
| 5 | Backup/restore scripts (`scripts/backup-db.ts`, `restore-db.ts`, `reset-db.ts`, `migrate.ts`, `health-check.ts`) are empty placeholders. | MEDIUM | Documented as unimplemented; procedure covered in `BACKUP_RESTORE_RUNBOOK.md` via `pg_dump`. |
| 6 | `server/utils/jwt.ts` (legacy JWT path) still falls back to the development secret and only checks `NODE_ENV === 'production'` (not `VERCEL`). The active production router (`production.routes.ts`) is hardened; the legacy path is not used by either entrypoint. | MEDIUM | Documented; delete with the legacy cleanup (see #3). |
| 7 | No CSP, distributed rate-limit store, or per-account lockout yet (deferred in `PRODUCTION_SECURITY_HARDENING.md`). | MEDIUM | Existing, tracked. |

---

## 7. Production smoke test

`npm run smoke:production` (`scripts/smoke-production.ts`) runs an
**unauthenticated, read-only** smoke test against `LEADFLOW_BASE_URL`. It
checks liveness, the readiness contract, the database-status contract, that a
protected endpoint returns `401`, that an unknown API endpoint returns a JSON
`404`, that expected security headers are present, and (soft) that the HTML
shell is served. It issues **only GET/HEAD** — it can never create, update or
delete leads or any other business data in a default run. Exit code is
non-zero on any failed check.

```bash
LEADFLOW_BASE_URL=https://<host> npm run smoke:production
# optional overrides:
#   LEADFLOW_SMOKE_EXPECT_READY=0   (don't require readiness)
#   LEADFLOW_SMOKE_CHECK_HTML=0     (skip the HTML-shell check)
```

Authenticated / destructive smoke tests are **out of scope** unless a safe,
dedicated test account and environment already exist.

---

## 8. Go / No-Go checklist

**GO** requires **all** of the following to hold:

- [ ] `LeadFlow CI / validate` green
- [ ] Vercel deployment / build green
- [ ] production configuration valid (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`)
- [ ] strong, production-specific `JWT_SECRET` configured
- [ ] PostgreSQL configured (`DATABASE_URL`)
- [ ] database reachable (`/api/db-status` → `connected: true`)
- [ ] schema / migrations current (`npm run verify:db-schema` → exit 0)
- [ ] health green and readiness green (`/api/health/readiness` → `ready`)
- [ ] security middleware verified (headers, rate limits — see `PRODUCTION_SECURITY_HARDENING.md`)
- [ ] RBAC regression green
- [ ] production fallback protections green (no silent demo mode)
- [ ] backup mechanism confirmed (see `BACKUP_RESTORE_RUNBOOK.md`)
- [ ] restore procedure documented and validated
- [ ] rollback path known (see `PRODUCTION_RELEASE_RUNBOOK.md` §rollback)
- [ ] production smoke test green
- [ ] critical business workflow manually verified (§9)
- [ ] known critical / blocker defects = **0**

### Severity classification

| Severity | Meaning | Gate effect |
| --- | --- | --- |
| **BLOCKER** | Prevents safe operation or correct data handling. | **NO-GO** until resolved. |
| **HIGH** | Material risk to a production capability (see §6). | Requires explicit sign-off to proceed. |
| **ACCEPTED NON-BLOCKING RISK** | Documented, bounded, no immediate operational impact. | Recorded; proceeds. |

---

## 9. Critical business-flow checklist (post-deployment, manual)

Do **not** automate destructive production actions. Verify by hand with a
real (non-production-data-mutating where possible) account:

**Admin**

- [ ] login works
- [ ] user management (create / edit / deactivate) works
- [ ] roles & access assignments apply correctly
- [ ] department / team / hierarchy edits apply correctly

**Lead operation**

- [ ] create / upload a lead
- [ ] Lead Pool population correct
- [ ] assign a lead
- [ ] assigned employee sees the lead (visibility)
- [ ] Lead Workspace reflects the assignment
- [ ] status update
- [ ] follow-up recorded
- [ ] scheduled activity created / completed
- [ ] Lead360 / history correct
- [ ] Lead Quality band updates
- [ ] conversion / terminal status transitions

**Manager**

- [ ] DownTeam visibility correct
- [ ] skip-level reporting visibility correct
- [ ] dashboard metrics correct
- [ ] Workbench correct

**Security**

- [ ] an unauthorized user cannot reach a protected action (403)
- [ ] a disabled feature cannot be opened directly
- [ ] logout → login as another account does not expose the previous user's data

---

## 10. Remaining production-readiness roadmap

This PR is **one stage**, not the endpoint. Still planned (not implemented
here):

- **Server-side Notification Reliability** — notifications are currently
  synchronous / best-effort; delivery reliability is its own work item.
- **Production Observability** — structured logging, request correlation,
  tracing (explicitly deferred; this PR only adds safe operational messages
  for config / DB readiness / migration / smoke).
- **Database Performance / Index Audit** — index and query-plan review under
  production load.
- **Data Integrity & Recovery Hardening** — automated, verified backup +
  restore drill cadence (beyond the documented manual procedure).
- **Authentication / Session Production Audit** — rotate-token / session
  invalidation depth, legacy `server/utils/jwt.ts` removal.
- **Load / Concurrency / Failure Testing** — scale and chaos testing against a
  staging environment.
- **Final Production Release Gate** — the sign-off that combines everything
  above.

See `PRODUCTION_RELEASE_RUNBOOK.md`, `BACKUP_RESTORE_RUNBOOK.md` and
`INCIDENT_RESPONSE_RUNBOOK.md` for operating procedure.
