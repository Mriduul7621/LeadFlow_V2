# Performance Phase 2 — Cold Start, Login & Navigation Latency

Phase 1 (`PERFORMANCE_LATENCY_HARDENING.md`) removed the server-side
waterfalls (login `last_login` await, per-request authorization
re-lookups, aggressive 6 s / 8 s client polling, post-mutation full-list
refetches) and added `Server-Timing` / `[perf]` instrumentation. Phase 2
attacks what remained on the critical path:

1. the **initial JavaScript payload** (every feature compiled into one
   1.96 MB bundle, parsed on the login page and on every cold load),
2. the **dashboard startup fan-out** (including the embedded Task
   Calendar's 90-day window loading in parallel with the KPIs),
3. **concurrent duplicate reads** (React StrictMode double effects,
   mount/unmount races, two components reading the same endpoint),
4. the **serverless cold start** (the first request paying for the
   production-router import + DB init on its own critical path).

All changes are compatibility-preserving: PostgreSQL remains the source
of truth, the auth/session flow and PR #28 RBAC are untouched, and every
previously merged behavior (Dashboard semantics, Daily Workbench,
follow-up queue, scheduled activities, bulk import, routes, English-only
UI, permission/menu semantics) is guarded by the existing test suite.

---

## 1. Symptoms reproduced

From the production recording (prolonged spinners on login, first
dashboard, cold reload and navigation) and from code inspection:

| Symptom | Measured cause |
|---|---|
| Long wait on first paint / login screen | One initial JS chunk of **1,962 kB (568 kB gzip)** — every route (recharts, xlsx, calendar, admin tables) downloaded + parsed before anything interactive. |
| Dashboard spinner stays long after KPIs could be shown | The embedded **Task Calendar** (own 90-day `GET /api/scheduled-activities` window + ~32 KB component) mounted in parallel and its chunk lived in the initial bundle. |
| "Early post-login period" slower than later navigation | Post-login = initial bundle parse + 9 parallel startup requests + calendar window. Later navigation only reuses the session cache (roles/notifications/permissions) — which Phase 1 already fixed — so the delta was dominated by the bundle + fan-out. |
| Cold serverless start slower than warm | First request awaited production-router import **and** DB init (health check + migrations + seeds) before any dispatch. |
| Dev-mode cold load worse than prod | React StrictMode double-runs every effect: roles, notifications, dashboard data, daily execution and the calendar each fired **twice** before the first response settled. |

## 2. Baseline request graph (measured, warm)

Harness: `scripts/perf-baseline.ts` — boots the real production router
(`api/index.ts`) over HTTP against a real (PGlite) PostgreSQL, seeds an
RM/RO hierarchy with 40 leads + 25 scheduled activities, and times
15 warm iterations of each endpoint plus the exact parallel batch the
browser fires after login/reload. Warm median / p95 (localhost, in-process
DB — absolute values exclude the remote-Supabase round-trip; structure
and span breakdown are the real signal):

```
A1 POST /api/auth/login (warm)                 85 ms  (p95 89)   [server-timing: total 80.7 = bcrypt 79 + db.userLookup 1.4]
B1 GET /api/auth/session                        3 ms  (p95  5)   [total 1.4 = db.userLookup 1.4]
C1 GET /api/dashboard                           4 ms  (p95  5)   [total 3.3 = authz.caller 1.4 + authz.permission 1.9]
C2 GET /api/leads/follow-ups?bucket=today       3 ms  (p95  6)
C3 GET /api/leads/follow-ups?bucket=upcoming    3 ms  (p95  4)
C4 GET /api/scheduled-activities (today..tomorrow) 3 ms (p95  6)
C5 GET /api/scheduled-activities (90-day window)   3 ms (p95  5)
D1 GET /api/roles                               2 ms  (p95  4)
D2 GET /api/notifications/users/:emp            2 ms  (p95  4)
D3 GET /api/users/:id/permissions               3 ms  (p95  6)
C6 dashboard fan-out (the 8 above in parallel, wall) 22 ms (p95 31)
E1 workbench navigation fan-out (3 requests, wall)    8 ms (p95 12)
```

Startup request graph the browser actually fired **before** (warm,
single tab):

```
cold reload :  GET /api/auth/session            (startup gate, blocks shell)
login       :  GET /api/auth/bootstrap-status   (login page, decides setup mode)
after login/reload, in parallel:
             1  GET /api/dashboard                      (KPIs — critical)
             2  GET /api/leads/follow-ups?bucket=today  (Today/Tomorrow — critical)
             3  GET /api/leads/follow-ups?bucket=upcoming (Tomorrow filter — critical)
             4  GET /api/scheduled-activities (today..tomorrow)  (Today/Tomorrow — critical)
             5  GET /api/scheduled-activities (-30d..+60d)       (embedded calendar — NON-critical)
             6  GET /api/roles                            (sidebar menu — shared)
             7  GET /api/notifications/users/:emp         (bell — shared)
             8  GET /api/users/:id/permissions            (granular RBAC — shared)
             9  (background, fire-and-forget) GET /api/options (lead-status warm-up)
```

So the "first usable dashboard" waited on **8 concurrent round-trips**
(one of them the calendar's heavy window) plus the initial 568 kB-gzip
bundle parse — and in development StrictMode doubled the page-level
effects (up to ~18 requests) because nothing coalesced concurrent
identical reads.

## 3. Root causes found

1. **No route-level code splitting.** `src/App.tsx` statically imported
   all 17 feature pages. The production build emitted a single
   `index-*.js` of 1,962 kB (568 kB gzip) with Vite's own
   "chunks are larger than 500 kB" warning. Login, cold load and every
   first navigation paid the full parse cost; recharts/xlsx/calendar
   code was never actually needed on the login page.
2. **Embedded Task Calendar in the critical fan-out.** The Dashboard's
   last section rendered `<TaskCalendar embedded/>` immediately on
   mount: its own 90-day `scheduled-activities` request joined the
   startup fan-out even though it carries no KPI or Today-execution
   data, and its chunk was in the initial bundle.
3. **No in-flight de-duplication.** StrictMode (dev) and mount/unmount
   races could issue the same GET twice concurrently (roles,
   notifications, dashboard metrics, follow-up buckets, calendar
   window). Phase 1's session cache only helps *after* a response
   settles — it can't collapse two requests in flight at the same time.
4. **Serverless cold start on the first request.** `api/index.ts`
   loaded the production router and ran DB init (`initializeDatabase`:
   health check + 39 idempotent migrations + seeds) *inside* the first
   request's handler. On Vercel, that is the entire first-response
   latency after container boot.
5. **Server-side per-request cost: not a bottleneck (confirmed).**
   Login = user lookup + bcrypt (79 of 85 ms — deliberate, security
   first); session validation = 1 query; dashboard = caller + permission
   + visibility (memoized per request in Phase 1) + 3 aggregates in one
   `Promise.all`; roles = 1 query (role seeding is process-memoized);
   pool is module-scoped with `max: 20`. No change required — see §9/§11.

## 4. Exact optimizations applied

### 4.1 Route-level code splitting — `src/App.tsx`

- All 17 authenticated feature pages are now `React.lazy` chunks
  (Dashboard, LeadGenerate, LeadList, LeadUpload, AllLeads,
  FollowUpStrategy, TaskCalendar, Activities, DailyWorkbench, Lead360,
  UserManagement, TeamHierarchy, ExecutionIntelligence, NcpProgress,
  TrendCharts, CampaignBreakdown, Settings).
- **Login stays a static import** — it is the only unauthenticated
  route and must render without a chunk round-trip.
- Each route element is `<ProtectedRoute><LazyPage page={<X />} /></ProtectedRoute>`:
  one `<Suspense>` boundary per page **inside** `AppLayout`, so during a
  chunk load the **sidebar/header stay visible** and only the content
  area shows a compact animated placeholder (`RouteFallback`,
  `role="status"`). No full-screen spinner per internal navigation; the
  router's route table, paths and guard are byte-for-byte the same
  contracts the existing source guards assert (all 17 routes still
  wrapped in `ProtectedRoute`, `initializeAuthSession` wiring unchanged,
  no auth state in `App.tsx`).
- Security is unchanged: the gate still releases a route only after
  `isInitialized` (server-confirmed session); lazy loading only delays
  *page code*, never the *permission decision* (which happens before
  any business data, exactly as before).

### 4.2 Deferred, code-split embedded Task Calendar — `Dashboard.tsx`

- The embedded calendar is now `lazy(() => import(…TaskCalendar))` and
  renders inside its own `<Suspense>` with a lightweight skeleton
  (`TaskCalendarPlaceholder`).
- It is mounted only when `calendarReady = !loading && !dailyLoading` —
  i.e. **after the primary KPIs and the Today/Tomorrow execution data
  have settled**. Until then the section shows the skeleton; the
  calendar's chunk fetch and its 90-day request happen strictly after
  the critical content is on screen.
- The calendar remains the last section, still renders
  `embedded={true}`, and the dedicated `/task-calendar` route is
  unchanged (same component, its own chunk).
- No data semantics change: KPIs still come only from
  `GET /api/dashboard`, Today/Tomorrow only from the follow-up queue +
  `scheduled_activities` (all server-authoritative).

### 4.3 In-flight GET coalescing — new `src/modules/shared/api/coalesce.ts`

- `coalesceGet(key, fn)`: concurrent callers of the **same URL** share
  one in-flight request; the key (full path + query) is dropped the
  instant the request settles (success *or* failure) — so nothing is
  cached across requests, failures reach every waiter, and the next call
  is a fresh request. TTLs/invalidation remain the domain of Phase 1's
  `sessionCache` — this only collapses duplicates of the *same logical
  request* while it is in flight.
- Applied to exactly six shared **read** paths (GET only — no mutation
  goes through it):
  | Reader | Coalesced URL |
  |---|---|
  | `adminService.getRoles` | `/api/roles` |
  | `notificationService.getNotifications` | `/api/notifications/users/:emp` |
  | `usePermissions` (own permission sheet) | `/api/users/:id/permissions` |
  | `dashboardService.getDashboard` | `/api/dashboard?…` |
  | `leadService.getFollowUpQueue` | `/api/leads/follow-ups?…` |
  | `scheduledActivityService` list reader | `/api/scheduled-activities?…` |
- Consequences:
  - StrictMode (dev) cold load drops from up to ~18 requests to the ~10
    unique ones (the session validation is already single-shot via the
    Phase 1 initialization guard).
  - In production, remount races (fast A→B→A, Dashboard + embedded
    child on the same tick) can no longer double a read that is still
    in flight.
  - No authorization semantics change: the permission sheet still has
    its 5-minute TTL and is invalidated by the override-save flow and
    logout; coalescing only joins concurrent requests for the *same*
    user's own data.
- **Logout hygiene**: `authStore.logout` now also calls
  `clearCoalescing()`, so a read started for the signed-out user can
  never be joined by the next session's request (behaviorally asserted
  in `perf-phase2-source-guards.test.ts` M).

### 4.4 Serverless cold-start kick-off — `api/index.ts`

- `void loadRoutes().catch(() => undefined)` now runs at **module
  scope** (during function boot), before the first request is
  dispatched. `loadRoutes` is memoized and the `/api` dispatch still
  awaits the *same* promise — so there is no second init, no changed
  404/authz behavior, and cold-start failures still surface on the
  first request exactly as before. What moved off the first request's
  critical path: the production-router module import/link and the
  *start* of DB init (health check + migrations + seeds), which now
  overlap container warm-up and network time to the first request.

### 4.5 Measurement tooling (dev-only)

- `scripts/perf-baseline.ts` — warm endpoint timing + the exact
  post-login fan-out batch (re-run: `npx tsx scripts/perf-baseline.ts`).
- `scripts/perf-coldstart.mjs` — serverless cold start
  (spawn → first `/api` response) on the `verify:serverless` compiled
  tree (re-run: `npm run verify:serverless && node
  scripts/perf-coldstart.mjs`).
- No new production logging; the existing `Server-Timing` header and
  development-only `[perf]` console line are reused as-is.

## 5. Auth security considerations

- **Session gate unchanged.** `initializeAuthSession` still: waits for
  hydration → validates the persisted token with `GET /api/auth/session`
  (at most once per page load, StrictMode-safe) → only then sets
  `isInitialized`. 401 still logs out; 5xx/network keeps the session
  with per-request 401 safety nets; malformed/incomplete snapshots fail
  closed. Nothing was moved to the client.
- **Lazy routes cannot bypass RBAC.** The `ProtectedRoute` gate and the
  server `requireAuth` + permission guards run exactly as before; a lazy
  chunk is only fetched for a route the gate already released.
- **Coalescing is read-only and in-flight-only.** No new authorization
  state is stored anywhere; the map holds at most one pending promise
  per URL and is emptied on settlement and on logout. A revoked
  permission can never persist via coalescing (there is no result
  reuse across requests), and the permission sheet's existing
  TTL/invalidation (5 min; invalidated on override save + logout) is
  untouched.
- **bcrypt cost unchanged** (79 ms of the 85 ms warm login) —
  deliberately kept.
- The `sameProfile`/`lastLogin`-exclusion profile-compare (Phase 1) that
  prevents user-object rewrites on cold reload is untouched; no new
  request sources were added that could re-trigger `[user]` effects.

## 6. Bundle size before/after (measured, `vite build`)

| Artifact | Before | After | Δ |
|---|---:|---:|---:|
| **Initial JS (index-*.js)** | **1,962.28 kB** (568.49 kB gzip) | **653.33 kB** (202.94 kB gzip) | **−66.7 % / −64.3 %** |
| CSS (index-*.css) | 105.85 kB (16.95 kB gzip) | 105.92 kB (16.96 kB gzip) | ~0 |
| Login background PNG | 718.20 kB | 718.20 kB | unchanged (see §10) |

Login no longer pulls heavy CRM modules: the 2.5 MB of page/vendor code
that used to sit in the initial bundle now splits into per-route chunks
(largest, raw / gzip):

```
xlsx-BBWTpfDg.js                 424.73 kB │ 141.75 kB   (Lead Upload — xlsx parser)
CategoricalChart-D0JYXcJn.js     304.56 kB │  94.57 kB   (recharts — trend/campaign pages)
translations-BSR33X1d.js           59.53 kB │  14.75 kB   (settings i18n table)
Settings-BpsIqy46.js               52.90 kB │  12.09 kB
UserManagement-B6H3AgDE.js         43.63 kB │  10.81 kB
CampaignBreakdown-CQscyKCl.js      35.76 kB │  10.49 kB
LeadList-CJOQBhjM.js               34.66 kB │   8.03 kB
TaskCalendar-D-9Pbg4F.js           31.90 kB │   7.29 kB   (was in the initial bundle)
Dashboard-M8U5_oHY.js              31.72 kB │   8.56 kB   (was in the initial bundle)
AllLeads / LeadGenerate / DailyWorkbench / LeadUpload / Lead360 /
TeamHierarchy / ExecutionIntelligence / NcpProgress / TrendCharts /
Activities / FollowUpStrategy     4.7–31 kB each
```

Each route's chunk is loaded only when that route is first rendered;
shared framework code stays in the 653 kB entry (React, router,
zustand, framer-motion, lucide, http/session layers, AppLayout, Login).

## 7. Request count before/after

| Scenario | Before | After |
|---|---:|---:|
| Warm login → first dashboard (prod, 1 tab) | 1 (bootstrap-status) + 8 parallel + 1 background = 10; **critical path included the calendar's 90-day window** | 1 + 7 parallel + 1 background = 9 on the critical path; the **9th (calendar window) fires only after KPI + Today/Tomorrow settle** |
| Warm authenticated cold reload | `session` + the same 8 + 1 background | `session` + 7 + 1 background; calendar window deferred |
| Dev (StrictMode) cold load | up to ~18 (page-level effects double-fire: roles, notifs, dashboard, 2 follow-up buckets, 2× scheduled windows, calendar) | ~10 unique (concurrent duplicates coalesced; session validation already single-shot) |
| Sidebar click (internal navigation) | 0 shared requests (Phase 1 session cache) + page-specific loads | unchanged, + the one-time route chunk (cached after first visit) |

## 8. Endpoint timing observations

- Warm per-request server cost is **not** the bottleneck on this code:
  with the in-process PGlite DB, all startup GETs are 2–6 ms and the
  8-request fan-out completes in ~22 ms wall; login's 85 ms is 79 ms of
  deliberate bcrypt. Against production Supabase each request additionally
  pays the network round-trip, so the client-side work (bundle parse,
  fan-out shape, deferrals) is where Phase 2's wins come from.
- `Server-Timing` (existing) confirms the Phase 1 authz memoization:
  dashboard = `authz.caller 1.4 + authz.permission 1.9` (one joined
  permission query, not N×3); session = a single `db.userLookup`.
- After the Phase 2 changes the warm numbers are **identical** (login
  85 ms, session 3 ms, dashboard 4 ms, fan-out ~24 ms) — the server
  logic on warm paths is unchanged, by design.

## 9. Cold start vs warm start (measured separately)

Cold start harness: `scripts/perf-coldstart.mjs` — spawns the
`verify:serverless` compiled ESM tree in production mode (`VERCEL=1`, no
`DATABASE_URL`), times process-spawn → first `/api/auth/login` response
(the request that, before the change, also paid for the router import +
DB-init start). 5 runs each, medians:

| | Before | After |
|---|---:|---:|
| spawn → module ready | 106 ms | 105 ms |
| **spawn → first /api response** | **221 ms** | **217 ms** |
| second (warm) request | +6 ms | +7 ms |

Honest reading: on this machine (local disk, no `DATABASE_URL` so DB
init is skipped, router import ≈ 40–50 ms) the delta is within noise
(~4 ms). The kick-off's value scales with what it overlaps: on Vercel
the first invocation additionally pays the **remote** Supabase health
check + 39 idempotent migration statements + seeds before any route can
dispatch, and that cost (typically well above the local numbers) is now
started during container boot instead of on the first request's critical
path. The Lambda process spin-up itself and the remote DB RTT remain
infrastructure — they cannot be claimed as fixed here. Warm invocations
are unaffected by construction (memoized `loadRoutes`).

## 10. Remaining bottlenecks

1. **Login background image: 718 kB PNG** in the initial critical path
   (unchanged asset). A WebP/AVIF conversion or lazy `loading` strategy
   would cut ~700 kB off the login page — deliberately not touched here
   (asset/UI change, no measured latency dependency).
2. **Remote PostgreSQL round-trip per request** — every startup GET
   pays it; mitigated by parallelism + deferral, not by the code alone.
3. **Vercel per-invocation cold start** (process boot + remote DB init)
   — see §9; hosting-model dependent.
4. **bcrypt (79 ms)** on the login critical path — security first,
   intentionally unchanged.
5. **xlsx chunk (425 kB)** — only loaded by Bulk Upload / All-Leads
   export paths now; a lighter streaming parser would be a later UI-phase
   item.

## 11. Things deliberately NOT changed

- **PostgreSQL pool** (`server/database/connection.ts`): module-scoped,
  reused across requests, `max: 20`, idle timeout, explicit releases —
  already correct; no per-request pool construction exists. Left alone.
- **Auth/session flow and the startup gate**: still one server-confirmed
  validation before protected routes; 401 logout; fail-closed on
  malformed snapshots. The full-screen "initializing" state is the
  *gate* for a single ~RTT round-trip, not a measurable delay — removing
  it would mean rendering the shell on unconfirmed state, which the
  current security model does not allow.
- **Dashboard business logic / KPI authority**: `GET /api/dashboard`
  remains the sole KPI source; Today/Tomorrow remains follow-up queue +
  `scheduled_activities`; the calendar deferral changes *when* it loads,
  never *what* it shows.
- **No stale-while-revalidate for KPI/follow-up/scheduled data.** The
  prompt allows it, but: (a) Phase 1's session cache already provides
  safe short-TTL reuse for exactly the shared reads that repeat
  (roles/menu, notifications, permission sheet) with correct
  invalidation; (b) KPI and follow-up counts are *operational* numbers
  (Due Today, Overdue) where a stale-then-refresh flash is worse than
  the single fast parallel fetch; (c) adding a display-data SWR layer
  would mean touching every dashboard consumer for a gain the
  measurements do not show. Skipped and documented per the brief.
- **RBAC / PR #28**: no permission code, route guard, data-scope or
  menu-visibility logic changed.
- **Server query shapes**: no query was shown to be slow in the
  baseline (dashboard = 3 parallel aggregates; roles = 1 query;
  permissions = 1 joined query memoized per request) — so no
  schema/index work was performed in this PR.
- **Routes, routes' paths, English-only copy, Workbench, follow-up
  queue, bulk import, scheduled-activity semantics**: untouched (all
  existing source guards remain green).

## 12. Recommended later DB/index work

None required by this phase's measurements. For the dedicated
DB-performance phase, the same candidates as Phase 1 remain:
`next_follow_up_at` bucket scans and visibility-scoped lead filters at
production data volume (verify with `EXPLAIN ANALYZE` on the real
Supabase dataset before touching indexes — no blind index additions).

---

## Verification (all green on this branch)

- `npm test -- --run` — **399/399, 0 fail** (baseline 386 + 14 new Phase
  2 guards in `server/tests/perf-phase2-source-guards.test.ts` — lazy
  routes, deferred calendar, GET-only coalescing, behavioral
  coalescing/logout tests, serverless kick-off — the +13 vs +14
  difference is node:test's TAP accounting of suite vs file entries);
  all Phase 1 `perf-latency-hardening` guards, auth-flow, RBAC,
  dashboard, workbench, follow-up and scheduled-activity suites green.
- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds; initial JS 1,962 kB → 653 kB (see §6).
- `npm run verify:serverless` — all checks pass with the module-scope
  kick-off (production ESM output boots, 404/401/503 contracts intact,
  no unhandled rejections).
- New guards assert: lazy (not eager) route imports; Login stays static;
  Suspense lives inside the ProtectedRoute shell; the embedded calendar
  is lazy + deferred + still rendered `embedded`; coalescing is wired to
  the six GET readers and to **no** mutation; coalesce behavior
  (collapse / per-key / no persistence / failure fan-out / retry after
  failure); logout clears coalesced in-flight state; serverless kick-off
  precedes dispatch and stays memoized.
