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
| `DATABASE_URL` | **REQUIRED** | PostgreSQL (Supabase) connection string. Server-only. |
| `JWT_SECRET` | **REQUIRED** | Strong, production-specific signing secret. Weak/default values are rejected. |
| `NODE_ENV` | REQUIRED | `production` for standalone; Vercel sets it automatically. |
| `TRUST_PROXY` | OPTIONAL | Trusted reverse-proxy hop count for rate-limit client IPs. |
| `PORT`, `PGSSL` | OPTIONAL | Standalone listen port / SSL override. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | OPTIONAL | Public browser config (compiled into the client bundle). |
| `GEMINI_API_KEY` | OPTIONAL | See §6 (secret exposure finding). |
| `SESSION_SECRET` | OPTIONAL | Reserved; the current auth flow is JWT-based. |

**In production:**

- Missing `DATABASE_URL` or `JWT_SECRET` is a **BLOCKER**.
- A `JWT_SECRET` that is missing, shorter than 16 characters, or an exact
  match for a known development/default/CI placeholder
  (`leadflow_development_only_secret`, `replace-with-a-long-random-secret`,
  `leadflow-ci-only-secret`, `changeme`, `secret`, …) is a **BLOCKER**.
- Configuration errors are explicit **but never expose a secret value**: the
  validator reports variable names and static, operator-facing messages only.

Consequences are enforced where they matter:

- `production.routes.ts` `signToken` refuses to sign a token in production
  when the secret is missing or weak.
- The readiness endpoint reports `config.ok: false` with the offending
  variable names.
- Startup logs a secret-free `[config]` summary + per-issue lines.

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
| 1 | `GEMINI_API_KEY` is injected into the **browser bundle** (`vite.config.ts`), i.e. exposed to any client that loads the app. | **HIGH** | Documented as an open item; moving the Gemini call server-side is an architecture change tracked under the roadmap. |
| 2 | Migration failures are logged but not surfaced as a readiness signal (see §5). | **HIGH** | Mitigated operationally by `verify:db-schema` + release-runbook gate; structural fix deferred. |
| 3 | `server/db.ts` and `server/server.ts` are legacy, unused duplicates (not imported by either entrypoint); `server/db.ts` contains a contradictory "fallback to in-memory" log line and unconditionally `rejectUnauthorized: false`. | MEDIUM | Left untouched (avoid rewriting); they are dead code and should be deleted in a cleanup PR. |
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
