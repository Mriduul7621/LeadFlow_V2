# Production Observability — Request Tracing, Structured Logs & Latency Diagnostics

Production-grade backend observability for LeadFlow using **only** stdout/stderr
structured logs. No paid monitoring service, no OpenTelemetry collector, no
persistent telemetry tables — everything here works with Vercel's built-in log
capture (or any process manager's log stream).

This document covers: architecture, the request-id lifecycle, the event catalog
and schema, the redaction/privacy policy, latency diagnostics, DB timing,
serverless compatibility, and the correlation workflow for incidents.

---

## 1. Architecture at a glance

```
/api/* request
   │
   ▼
applyProductionHttpSecurity()            server/middleware.ts
   ├─ trust proxy
   ├─ createApiObservabilityMiddleware() server/observability/http.ts   ◄── NEW
   │     ├─ resolve/generate X-Request-ID
   │     ├─ open AsyncLocalStorage request context                     ◄── NEW
   │     └─ on response finish: http_request_complete (+ http_request_slow)
   ├─ security headers (helmet)
   ├─ rate limiters ─────── 429 → rate_limit_rejected                  ◄── NEW
   ├─ body parsers
   ▼
routes (production.routes.ts)
   ├─ auth events: auth_login_success / auth_login_failed /
   │    auth_token_rejected / auth_forced_password_change_completed /
   │    auth_admin_password_reset                                      ◄── NEW
   └─ PostgreSQL via getPool().query()
         └─ instrumentPoolForObservability: per-request               ◄── NEW
              dbQueryCount / dbDurationMs (+ db_query_slow warnings)
   ▼
createApiErrorHandler() ── error → http_request_error                 ◄── NEW
```

One event = **one single-line JSON object** on stdout/stderr. Vercel captures
these natively (Runtime Logs); a standalone deployment's process manager or
container runtime captures the same stream. Nothing is written to PostgreSQL,
to disk, or to any external service.

Modules (all under `server/observability/`):

| File | Role |
|---|---|
| `requestId.ts` | X-Request-ID generation + strict incoming-id validation |
| `context.ts` | AsyncLocalStorage request context (serverless concurrency-safe) |
| `logger.ts` | JSON-line logger: levels, allowlist picking, redaction pipeline |
| `redaction.ts` | Sensitive-key redaction + shape limits |
| `http.ts` | Express middleware: header, context, completion + slow-request logs |
| `dbTiming.ts` | Pool instrumentation (durations/counts only, never SQL) |
| `events.ts` | Central event catalog: auth / rate-limit / readiness / error helpers |
| `config.ts` | `OBSERVABILITY_SLOW_REQUEST_MS` / `OBSERVABILITY_SLOW_DB_MS` resolution |

---

## 2. Request ID lifecycle

1. **Generation/adoption** — for every `/api/*` request the middleware resolves
   the correlation id:
   - an incoming `X-Request-ID` header is **adopted only when it validates**
     against `^[A-Za-z0-9_-]{8,64}$` (bounded length, whitelist charset — a
     caller can never inject whitespace, newlines or a forged second "event"
     into log lines);
   - otherwise a fresh server id (`crypto.randomUUID()`) is generated.
   Non-API traffic (SPA shell, static assets) is not observed.
2. **Attachment** — the id is stored in the AsyncLocalStorage request context
   and on `req.requestId`. Every structured event emitted while handling the
   request (auth, rate-limit, slow-DB, error, completion) carries this id
   **automatically**.
3. **Echo** — the response always carries `X-Request-ID: <id>`: on success, on
   4xx, on 429s, on 5xx. A user (or admin on mobile) can read this id from
   browser DevTools → Network to correlate with server logs.
4. **Teardown** — the context dies with the AsyncLocalStorage scope when the
   response finishes. There is no global mutable request state; concurrent
   serverless invocations in one warm instance cannot see each other's context.

Request ids are **never** derived from auth tokens, session ids or arbitrary
user input.

---

## 3. Event schema

Common envelope (every event):

```json
{
  "ts": "2026-09-14T10:00:00.000Z",
  "level": "info",
  "event": "http_request_complete",
  "build": "57058309f34dabd84df79711a7e72c2e72ee5853",
  "env": "vercel",
  "requestId": "0f3d2c1b-…"
}
```

- `build` — the **PR #42 build identifier** (`resolveBuildIdentifier()`):
  `VERCEL_GIT_COMMIT_SHA` → `COMMIT_SHA`/`GIT_SHA`/… — omitted when unset, never
  re-implemented elsewhere.
- `env` — `resolveEnvironmentIdentifier()` (`vercel` | `production` | `test` |
  `development`).
- `requestId` — attached from the request context when the event is emitted
  inside a request (an explicitly supplied `requestId` field wins).

### Event catalog

| Event | Level | Fields (allowlisted) |
|---|---|---|
| `http_request_complete` | info | requestId, method, route, status, durationMs, dbQueryCount, dbDurationMs, userId, role, serverTiming |
| `http_request_slow` | warn | requestId, method, route, status, durationMs, dbQueryCount, dbDurationMs, thresholdMs |
| `http_request_error` | error (≥500) / warn (4xx) | requestId, method, route, status, durationMs, errorName, errorCode, errorType; `message`/`stack` **only outside production** |
| `http_probe_complete` | debug | same shape as completion (passing probes) |
| `http_probe_unhealthy` | warn | same shape (5xx probes) |
| `readiness_check` | debug when ready / warn when not_ready | status, summary |
| `rate_limit_rejected` | warn | limiter (`general`/`auth`), method, route (+ auto requestId) |
| `db_query_slow` | warn | durationMs, thresholdMs (+ auto requestId) |
| `auth_login_success` | info | userId (uuid), role |
| `auth_login_failed` | info | reason (`invalid_credentials`, …) — **never** the submitted identifier |
| `auth_token_rejected` | info | reason (`expired`/`invalid`) — never the token bytes |
| `auth_forced_password_change_completed` | info | userId |
| `auth_admin_password_reset` | info | actorUserId, targetUserId |

Example — answering "which route was slow, and where did the time go?":

```json
{"ts":"…","level":"info","event":"http_request_complete","build":"5705830…","env":"vercel","requestId":"9d8c…","method":"GET","route":"/api/dashboard","status":200,"durationMs":2418.6,"dbQueryCount":6,"dbDurationMs":2214.9,"userId":"7c9e…","role":"MANAGER","serverTiming":"total;dur=2418.6, authz.caller;dur=152.3, db.queries;dur=2214.9"}
{"ts":"…","level":"warn","event":"http_request_slow","build":"5705830…","env":"vercel","requestId":"9d8c…","method":"GET","route":"/api/dashboard","status":200,"durationMs":2418.6,"dbQueryCount":6,"dbDurationMs":2214.9,"thresholdMs":2000}
```

Two lines say: this exact request (9d8c…) was slow (2.4 s > 2 s), and ~2.2 s of
it was PostgreSQL time across 6 queries — i.e. DB-bound, not auth-bound.

---

## 4. Log levels

`OBSERVABILITY_LOG_LEVEL` = `debug` | `info` | `warn` | `error`.

- **Default:** `info` in production, `debug` elsewhere.
- **Unknown value:** falls back to `info` (never to `debug`, so a typo cannot
  enable more-verbose output in production).
- The one-per-request completion event is `info`; slow requests and rate-limit
  rejections are `warn`; 5xx error events are `error`.

---

## 5. Redaction & privacy policy

**Layers** (enforced by code + tests, not just convention):

1. **Allowlist first.** Every event helper copies *only* its named, reviewed
   fields. Unknown fields are dropped before serialization.
2. **Key redaction.** Any key (nested included) matching these concepts is
   replaced with `<redacted>`: `authorization`, `cookie` (incl. `set-cookie`),
   `token`, `secret`, `password`, `database_url`, `jwt`, `api_key`, `email`,
   `phone`, `mobile`.
3. **Shape limits.** Strings ≤ 500 chars, depth ≤ 4, arrays ≤ 20 items — one
   bounded line per event, O(1) per request. Non-plain objects collapse to a
   type label so a stray Request/Response can never smuggle headers or bodies.
4. **Route normalization.** Log lines never contain the raw query string;
   UUID/long-numeric path segments collapse to `:id`.

**Allowed** (examples): method, normalized route, status, durations, query
counts, thresholds, user **uuid**, role code, build id, error class name,
machine error codes (e.g. pg code `23505`), body-parser error types.

**Forbidden** (examples — all covered by tests): Authorization headers, JWTs,
cookies, passwords (and new/reset passwords), `DATABASE_URL`, `JWT_SECRET`,
request/response bodies, lead or customer free-text (names, notes, remarks),
email addresses, phone numbers, arbitrary query parameter values, raw SQL,
connection strings, raw client IPs, stack traces (production).

Logs are **operational, not a shadow database**. If you need business facts,
query PostgreSQL; if you need request behavior, read the logs.

---

## 6. Latency diagnostics

### Slow-request detection

- Threshold: `OBSERVABILITY_SLOW_REQUEST_MS`, **default 2000 ms**.
- At or above the threshold one extra `http_request_slow` warning is emitted
  with the timing breakdown (`durationMs`, `dbQueryCount`, `dbDurationMs` —
  answering "was time spent in DB or in application work?").
- **Slow is never a failure**: the request completes normally.

### DB timing

- Threshold: `OBSERVABILITY_SLOW_DB_MS`, **default 750 ms** for a *single*
  instrumented operation (`db_query_slow` warning).
- Implementation: the *smallest safe hook* — `getPool()` wraps `pool.query`
  once (symbol-marked, idempotent); no call sites were rewritten.
  Contributions land in the request context via `recordDbQuery()`, and the
  completion event reports the aggregates. Queries outside a request (startup,
  scripts) are ignored.
- **Never logged: SQL text, parameters, row contents.** Counts and durations
  only. There are deliberately **no per-query info logs** (that would be spam);
  only per-request aggregates and the slow-query warning.
- Known approximation: queries run on a checked-out client
  (`pool.connect()` transactions) are not timed — documented limitation; the
  aggregates are a lower bound, and still identify DB-bound requests.

### Server-Timing (unchanged)

The existing `createPerf` spans (`authz.*`, `db.*`, …) and the `Server-Timing`
response header keep working exactly as before. Observability **integrates**:
the completion event echoes the (capped) `Server-Timing` header value, so the
span breakdown is also visible in the log line. Mobile Performance Diagnostics
(PR #30) keeps reading the same header — backend and browser diagnostics
complement each other:

- **Browser panel** = what *this device* experienced (network + server).
- **Backend events** = what *the deployment* did for a specific requestId.

---

## 7. Health & readiness (noise policy)

- Passing probes (`/api/health`, `/api/health/readiness`, `/api/db-status`)
  emit at **debug** (`http_probe_complete`) — invisible at the production
  default `info` level. Uptime monitors no longer spam production logs.
- Failing probes (5xx) emit `http_probe_unhealthy` at **warn**, and each
  readiness evaluation still emits one `readiness_check` (debug when ready,
  warn when not) with the existing secret-free summary line.
- The PR #42 endpoint **contracts are unchanged** — same bodies, same statuses.

---

## 8. Serverless (Vercel) compatibility

- **Concurrency:** AsyncLocalStorage is per-async-execution; Node ≥ 22 on
  Vercel supports it natively. There is no module-level request state.
- **Cold start:** the middleware adds two clock reads + one header per request;
  the completion log is one bounded JSON.stringify. Negligible overhead.
- **Log capture:** single-line JSON on stdout/stderr is exactly what Vercel
  Runtime Logs index; search by `requestId`, `event`, `route` or `build`.
- **No flush/daemon:** events are written synchronously to console before the
  response lifecycle ends; nothing needs a shutdown hook.
- **Both entrypoints share the pipeline**: `server.ts` (standalone) and
  `api/index.ts` (Vercel) mount the identical middleware via
  `applyProductionHttpSecurity()`.

---

## 9. Correlation workflow (incidents)

1. Get the request id: browser DevTools → Network → response headers
   `X-Request-ID` (e.g. `9d8c…`), or from a user's report of the failing
   request time + route.
2. In Vercel Runtime Logs, filter for `"requestId":"9d8c…"`:
   - `http_request_complete` — status and total duration.
   - `http_request_error` — error class + safe code (5xx).
   - `http_request_slow` / `db_query_slow` — latency breakdown.
   - `auth_*` / `rate_limit_rejected` — security context.
3. Add `"build":"…"` to confirm which deployment handled the request; cross
   check `/api/health/readiness` (same build field) for the current state.
4. Check **repeatability**: filter `"event":"http_request_slow"` +
   `"route":"/api/dashboard"` over a time window to see whether the route is
   *systematically* slow (and whether `dbDurationMs` dominates).
5. Escalate per `docs/INCIDENT_RESPONSE_RUNBOOK.md` (§1 app unavailable,
   §2 DB unavailable, §4 severe latency).

---

## 10. Relationship to `audit_logs`

- **`audit_logs`** (PostgreSQL) remain **business/security audit records**:
  who changed what business entity (bulk import, forced password change
  completion, permission changes). They persist and are queryable in-app.
- **Structured request logs** are **operational telemetry**: latency, errors,
  throughput. They are never written to PostgreSQL — logging must not add DB
  write pressure, and a DB outage must still be observable.
- The two complement each other: an audit row explains a business mutation;
  the requestId on the same operation's log lines explains *how the request
  behaved*.

---

## 11. Environment variables

| Variable | Allowed | Default | Fallback on invalid |
|---|---|---|---|
| `OBSERVABILITY_LOG_LEVEL` | `debug` `info` `warn` `error` | `info` in production, else `debug` | `info` |
| `OBSERVABILITY_SLOW_REQUEST_MS` | positive number (ms) | `2000` | `2000` |
| `OBSERVABILITY_SLOW_DB_MS` | positive number (ms) | `750` | `750` |
| Build id (PR #42) | `VERCEL_GIT_COMMIT_SHA` / `GIT_SHA` / `COMMIT_SHA` | — | omitted |

All three observability variables are also catalogued as OPTIONAL in
`server/config/env.ts` (the central env registry).

---

## 12. Safe vs. forbidden log content (examples)

**Safe** (real shapes):

```json
{"ts":"…","level":"info","event":"http_request_complete","env":"vercel","requestId":"ab12…","method":"POST","route":"/api/auth/login","status":401,"durationMs":212.0,"dbQueryCount":1,"dbDurationMs":84.2}
{"ts":"…","level":"info","event":"auth_login_failed","env":"vercel","requestId":"ab12…","reason":"invalid_credentials"}
{"ts":"…","level":"warn","event":"rate_limit_rejected","env":"vercel","requestId":"cd34…","limiter":"auth","method":"POST","route":"/api/auth/login"}
{"ts":"…","level":"warn","event":"db_query_slow","env":"vercel","requestId":"ef56…","durationMs":962.3,"thresholdMs":750}
{"ts":"…","level":"error","event":"http_request_error","env":"vercel","requestId":"gh78…","method":"GET","route":"/api/leads","status":500,"durationMs":140.2,"errorName":"Error","errorCode":"57P01"}
```

**Forbidden** (never emitted; asserted by tests):

```jsonc
// ❌ headers/bodies/secrets/PII
{"headers": {"authorization": "Bearer eyJ…", "cookie": "session=…"}}
{"body": {"employeeId": "E1001", "password": "…"}}
{"query": "?search=Rahim&phone=01711…"}
{"error": "connect postgres://user:password@host/db …"}
{"sql": "SELECT * FROM leads WHERE mobile = '01711…'", "params": ["01711…"]}
{"stack": "Error\n    at /var/task/server/routes/production.routes.js …"}  // production
```

---

## 13. Known limitations

- `pool.connect()` **transaction clients** are not timed (only `pool.query`):
  `dbQueryCount`/`dbDurationMs` are a lower bound for transaction-heavy writes.
- If a client disconnects mid-request, the completion event keys off the
  response `finish` event; an aborted response can miss its line (the error
  handler still logs the failure path).
- Rate-limit events are throttled to one per 10 s per process (the rejection
  HTTP behavior is **not** throttled — only the logging, to survive an attack
  without log flooding).
- The request id is function-instance scoped truth: two ids are globally
  unique (random UUID), but correlating *across* services beyond this app is
  out of scope (no tracing backend).
- Server-Timing spans cover the already-instrumented routes only; the
  completion event's timing fields cover every API route.

---

## 14. What this is NOT

No Sentry, Datadog, New Relic or any paid/external monitoring. No OpenTelemetry
exporter. No Redis. No telemetry tables. No changes to audit semantics, auth,
notifications, permissions or any business behavior.
