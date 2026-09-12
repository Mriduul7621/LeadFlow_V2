# Production Security Hardening — HTTP Middleware & Abuse Protection

Status: implemented (single PR, no business-route changes).
Scope: the production HTTP surface only — security headers, request-size
controls, authentication abuse protection, general API rate limiting and
safe JSON error responses.

---

## 1. Current-state findings (why this change exists)

| Finding | Evidence |
|---|---|
| Security middleware was **defined but never mounted** | `server/middleware.ts` exported `securityHeaders` (helmet), `apiLimiter` and `authLimiter`, but no file in the repository imported the module. Production requests received no security headers and no rate limiting at all. |
| Both production entrypoints mounted the **same process-wide JSON parser** | `server.ts` and `api/index.ts` each called `express.json({ limit: '50mb' })`. Any endpoint (authenticated or not) accepted a 50 MB body. |
| `trust proxy` was never configured | `req.ip` was the socket peer address. Behind Vercel every request shares the proxy address, so an IP-keyed limiter would have throttled *all* users as one client — the main reason a naive fix is unsafe. |
| No JSON error handling on the standalone path | `api/index.ts` had a generic handler that echoed `error.message` (pg failures can contain SQL / connection details); `server.ts` had none, so a thrown error produced Express's HTML error page. |
| Thresholds were copied from library defaults | 200 requests / 15 min globally is roughly one heavy dashboard session plus a workbench burst — it would throttle legitimate users. |
| Production DB honesty was already correct | Missing `DATABASE_URL` in production already answers 503 / `mode: 'db-unconfigured'` and never switches to the in-memory demo store. This is now locked in by regression tests. |

---

## 2. Middleware mounting — exact order (both entrypoints)

`server/middleware.ts` is the single source of truth. Both entrypoints call
`applyProductionHttpSecurity(app, { production: IS_PRODUCTION })` **before
any route is registered**, then each adds its own 404 + error handler:

| # | Middleware | Standalone (`server.ts`) | Vercel (`api/index.ts`) |
|---|---|---|---|
| 1 | `trust proxy` resolution | `TRUST_PROXY` env, default `false` | `1` (Vercel) |
| 2 | `disable('x-powered-by')` + helmet security headers | yes | yes |
| 3 | general API limiter — `app.use('/api', apiLimiter)` | yes | yes |
| 4 | auth limiter — `AUTH_SENSITIVE_PATHS` | yes | yes |
| 5 | bulk JSON parser (50 MB, route-scoped) | yes | yes |
| 6 | global JSON parser (10 MB) | yes | yes |
| 7 | routes / lazy router dispatch | `app.use('/api', productionRoutes)` | memoized lazy `loadRoutes()` |
| 8 | JSON API 404 | shared handler | shared handler |
| 9 | JSON API error handler | shared handler | shared handler |

Health (`/health`, `/api/health`) and `/api/db-status` are registered after
the limiters and are exempt from them (see §6).

### Standalone vs Vercel behavior

| Aspect | Standalone `server.ts` | Vercel `api/index.ts` |
|---|---|---|
| Security headers | mounted | mounted |
| Frame protection (`X-Frame-Options: SAMEORIGIN`) | production only | yes |
| General limiter 3000/15 min | yes | yes |
| Auth limiter 20 failed attempts/15 min | yes | yes |
| Limiter persistence | per process (memory) | per warm function instance (memory) |
| `trust proxy` | `TRUST_PROXY` (default: off) | `1` |
| JSON body limits | bulk 50 MB / global 10 MB | bulk 50 MB / global 10 MB |
| JSON 404 + JSON error handler | yes | yes |
| SPA handling | Vite (dev) / `express.static` + `index.html` (prod) | Vercel filesystem routes |
| Cold start | n/a | PR #31 prewarm preserved (`void loadRoutes().catch(...)` still at module scope, dispatch still `await loadRoutes()`) |

Nothing in the Vercel path changed structurally: the lazy router load, the
memoized promise, `/api/health`, `/api/db-status`, route order, the JSON 404
and the chunk-recovery/static-asset routing all stay as they were.

---

## 3. Security headers

Helmet is mounted with a deliberately **reduced** configuration:

| Header | Value | Note |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | |
| `X-Frame-Options` | `SAMEORIGIN` | production/Vercel; **disabled in development** so the local preview host can embed the dev server |
| `X-DNS-Prefetch-Control` | `off` | |
| `Cross-Origin-Opener-Policy` | `same-origin` | |
| `Cross-Origin-Resource-Policy` | `same-origin` | |
| `X-Permitted-Cross-Domain-Policies` | `none` | |
| `Strict-Transport-Security` | helmet default | only meaningful over HTTPS |
| `Origin-Agent-Cluster`, `X-Download-Options` | helmet defaults | |
| `X-Powered-By` | removed | |
| `Content-Security-Policy` | **not set — deferred (§10)** | |
| `Cross-Origin-Embedder-Policy` | not set | helmet default; enabling it would break cross-origin images |

Development (the Vite dev server, and any `NODE_ENV !== production`
standalone run) keeps `X-Frame-Options` off on purpose: the preview/embedding
host loads the app in a cross-origin iframe, and frame protection on a
developer machine protects nothing.

---

## 4. Auth rate-limit policy

* Endpoints (`AUTH_SENSITIVE_PATHS`):
  * `POST /api/auth/login`
  * `POST /api/auth/bootstrap-admin` (first-admin setup — unauthenticated)
  * `POST /api/auth/change-password`
  * `POST /api/auth/change-required-password`
  * `POST /api/users/:id/reset-password` (admin reset; mounted by path pattern so the parameterised route is covered)
* Threshold: **20 requests / 15 minutes / client identity**.
* `skipSuccessfulRequests: true` — responses with status < 400 are **not**
  counted, so:
  * a user (or an entire office behind one NAT IP) may log in as often as
    needed, including repeated logins during a rollout or a shared terminal;
  * only failed attempts (401/403/503/… ) consume budget, capping password
    guessing at 20 tries per 15 minutes per client.
* Keying: the **default IP key** (`req.ip`, IPv6-safe `/56` subnet). No
  request-body field, header or cookie is ever used as the key — a caller
  cannot select their own bucket, and a caller cannot push another account
  into a limit.
* No account-existence disclosure: the 401 body (`Invalid credentials`) and
  the 429 body are byte-identical whether or not the account exists.

---

## 5. General API rate-limit policy

* Threshold: **3000 requests / 15 minutes / client identity** (`/api` only).
* Rationale (measured from the app's own startup/reference path documented in
  `docs/PERFORMANCE_PHASE_3.md` and the client's refresh timers):

| Traffic pattern | Requests / 15 min |
|---|---:|
| Cold start (session, dashboard, 2× follow-up buckets, scheduled activities, users, options, roles, leads, notifications) | ~10–15 |
| Background refreshes (notifications every 60 s, role/menu cache at most every 60 s when stale) | ≤ 30 |
| Heavy interactive session (filters, pagination, saves, ~2–3 s bursts) | 300–600 |
| Shared office NAT (5–15 users on one IP) | 1500–3000 worst case |

  3000/15 min ≈ 200 req/min sustained — roughly 5× headroom over the worst
  observed session, ~10× over a typical one, while still stopping a scripted
  client from running hundreds of requests per second.
* The previous library default (200/15 min) was **not** reused: a single
  dashboard load plus one workbench burst can approach it, so it would have
  throttled normal users.
* Static assets, SPA routes and the `favicon` never touch an HTTP limiter —
  only `/api/*`.
* `standardHeaders: true` emits `RateLimit-Policy`, `RateLimit-Limit`,
  `RateLimit-Remaining` (and `Retry-After` on 429) so clients and monitors can
  see the remaining budget.

---

## 6. Rate-limit responses & exemptions

* HTTP **429** with the established JSON envelope:

```json
{ "success": false, "message": "Too many requests. Please try again later." }
```

* Login/auth limiter message: `"Too many sign-in attempts. Please wait a few
  minutes and try again."` — endpoint-specific, account-agnostic.
* Exempt paths: `/api/health` and `/api/db-status` are skipped by the general
  limiter so uptime monitoring keeps working while a client IP is throttled.
  They are read-only probes with no session data and no request body.
* In-memory store: counters are per process (standalone) or per warm function
  instance (Vercel). See §11 for the deferred distributed-store work.

### Logging

One `[security] {scope} rate limit exceeded: METHOD /path (client IP)` line
per 10 s at most (flood protection). Never logged: bodies, passwords, tokens,
`Authorization` headers, cookies.

---

## 7. Proxy / IP assumptions

| Runtime | `trust proxy` | Client identity |
|---|---|---|
| Vercel | `1` | Vercel **overwrites** `X-Forwarded-For` with the connecting client IP ([Vercel request headers](https://vercel.com/docs/headers/request-headers), anti-spoofing), so one trusted hop yields the real IP. Vercel also ignores external `X-Forwarded-For` chains. |
| Standalone, directly exposed | `false` (default) | socket peer address |
| Standalone behind nginx/ALB/Cloudflare | `TRUST_PROXY=1` (or `2`, or `loopback`) | Express walks `X-Forwarded-For` from the **right**, i.e. the entry appended by the trusted proxy — a client-supplied prefix cannot change it |

`TRUST_PROXY=true` is accepted for compatibility but logs a warning: trusting
every hop lets any client forge `X-Forwarded-For` and choose its own
rate-limit bucket. A hop count is always preferable.

`docs/.env` guidance lives in `.env.example` (`TRUST_PROXY`, commented out —
opt in only when a proxy is actually in front of the process).

---

## 8. Body-size policy

| Parser | Limit | Applies to |
|---|---|---|
| Bulk JSON | **50 MB** | `POST /api/leads/bulk`, `POST /api/users/bulk/validate`, `POST /api/users/bulk/commit` |
| Global JSON | **10 MB** | every other `/api/*` request |

* The bulk allowance preserves the exact envelope the spreadsheet import
  already used (the client parses `.xlsx`/`.csv` locally and posts raw rows:
  up to 5000 lead rows / 1000 user rows with ~20 free-text columns — worst
  case well below 50 MB, and 50 MB covers even pathological cell content that
  previously fit in the global 50 MB parser).
* The global limit drops from 50 MB to 10 MB. The largest legitimate
  non-bulk payload is the 1.5 MB image upload in Settings/identity presets
  (≈ 2 MB once base64-encoded inside JSON), so 10 MB keeps ~5× headroom.
* Rejections are `413 { "success": false, "message": "Request payload is too
  large." }` (JSON, no parser internals). Malformed JSON is
  `400 { "success": false, "message": "Invalid JSON request body." }`.
* Follow-up (deferred): audit the remaining base64 image flow and consider
  lowering the global limit to 2–5 MB; this requires a client-side size check
  in Settings, which is outside this change's scope.

---

## 9. Error-handling policy

* Both entrypoints reply with `{ "success": false, "message": "…" }` for API
  failures — the contract the API client already consumes.
* Production never returns: stack traces, `DATABASE_URL` / connection
  strings, raw SQL, JWT secrets, `Authorization` headers, request bodies.
  In production the generic handler returns curated messages
  (`Internal server error` for 5xx, `Request payload is too large.`,
  `Failure to parse body`, status-mapped 4xx messages); the full error is
  logged server-side only (`[api-error] METHOD /path -> status`).
* Development keeps the detailed message for debugging.
* Non-API failures (Vite dev middleware, SPA fallback) are passed through to
  Express/Vite unchanged, so the React SPA behavior is untouched.
* Unknown `/api/*` routes return the established JSON 404
  (`API route not found: METHOD /path`) on **both** runtimes (the standalone
  server previously fell through to the SPA shell).

---

## 10. Deferred CSP decision

Content-Security-Policy is intentionally **not** enabled in this change:

1. The Vite development runtime injects inline scripts (React refresh
   preamble / HMR client), which helmet's default `script-src 'self'` blocks —
   the dev server would stop loading the app.
2. `default-src 'self'` blocks the external preset images
   (`images.unsplash.com`) used by Settings/identity presets and would need an
   explicit `img-src`.
3. Tailwind/React inline `style` attributes and inline SVG data URLs need
   `style-src 'unsafe-inline'` + `img-src data:`, i.e. a real audit rather than
   a copy-paste policy.
4. `upgrade-insecure-requests` breaks plain-HTTP local development.

Enabling CSP requires (a) auditing every external resource, (b) a production-only
policy (helmet's `useDefaults` in prod, disabled in dev) and (c)
end-to-end verification of login, dashboard, charts, exports and the
chunk-recovery reload path. `frame-ancestors` — the CSP-only frame protection —
is covered meanwhile by `X-Frame-Options: SAMEORIGIN` in production.

---

## 11. Deferred security work

* **Distributed limiter store** (Redis/Upstash or Vercel WAF rate limiting) so
  counters survive cold starts and are shared across instances. Requires a new
  paid dependency, which is explicitly out of scope here.
* **Per-account login backoff / lockout** in addition to per-IP limiting, to
  slow down distributed credential stuffing.
* **CSP** as described above.
* **Global body limit reduction** to 2–5 MB once the base64 image flows have
  client-side size guards.
* **Audit-log client IP** already benefits from the new `trust proxy`
  configuration (`server/routes/identity.routes.ts` reads `req.ip`).

---

## 12. Operational checks after deployment

1. `curl -sI https://<host>/api/health` → expect `x-content-type-options:
   nosniff`, `referrer-policy: no-referrer`, `x-frame-options: SAMEORIGIN`
   (production) and no `x-powered-by`.
2. `curl -sI https://<host>/api/leads` → expect `ratelimit-limit: 3000` and
   `ratelimit-policy: 3000;w=900`.
3. `curl -si -X POST https://<host>/api/auth/login -H 'content-type:
   application/json' -d '{"employeeId":"x","password":"y"}'` → expect
   `ratelimit-limit: 20`; after 20 failures expect `429` JSON
   `{"success":false,"message":"Too many sign-in attempts. …"}` plus
   `Retry-After`.
4. Confirm normal login still works (including several logins from the same
   office IP) — successful logins must never appear in the counter.
5. `curl -s https://<host>/api/db-status` → `mode` must be `database` in
   production; `db-unconfigured`/503 means `DATABASE_URL` is missing and data
   is **not** being persisted anywhere.
6. Standalone deployments behind a proxy: check the server log for the
   express-rate-limit `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation message.
   If it appears, set `TRUST_PROXY=1` (or the correct hop count).
7. Watch for `[security] … rate limit exceeded` lines — they are throttled to
   one per 10 s, so a sustained stream means real abuse.
8. Vercel: after the first request, confirm the logs no longer print
   `DATABASE_URL not set - running in fallback mode` (the message now states
   explicitly that database-backed requests are refused).

---

## 13. Tests

`server/tests/production-security-vercel.test.ts` — the real Vercel entrypoint
under `NODE_ENV=production`: headers, `trust proxy=1` + per-client buckets,
limiter thresholds (`20` vs `3000`) and their relative strictness, JSON 429 /
404 / 413 / 400 contracts, 12 MB bulk payload accepted on `/api/leads/bulk`
while `/api/leads` rejects it, production honesty without `DATABASE_URL`,
error-handler leak checks, and source guards proving both entrypoints mount
the shared pipeline before their routes.

`server/tests/production-security-standalone.test.ts` — the real standalone
entrypoint under production: headers incl. frame protection, `TRUST_PROXY`
resolution rules (Vercel = 1, direct = off, named lists), limiter thresholds,
`>10 MB` user-bulk payload accepted, JSON 404, `/health` + `/api/health`, and
503 behavior without `DATABASE_URL`.

`server/tests/production-security-auth-limits.test.ts` — auth limiter against a
working login flow: normal login works, 25 successful logins from one IP are
never throttled, wrong-password and unknown-account responses are identical,
the 429 body is identical for existing and non-existing accounts, a blocked
auth client can still use the rest of the API, and every credential endpoint
(including `/api/users/:id/reset-password`) carries the stricter limit.

Existing suites (auth/session, chunk recovery, hierarchy, Lead Quality,
bulk import, serverless verification) keep running unchanged and stay green.
