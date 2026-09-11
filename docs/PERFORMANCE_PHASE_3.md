# Performance Phase 3 — Startup Request Contention & Duplicate Reference-Data Reads

Phase 1 removed server-side waterfalls and aggressive polling.
Phase 2 (`PERFORMANCE_PHASE_2.md`) split the JS bundle, deferred the
embedded Task Calendar, and added **in-flight GET coalescing** (PR #29).
PR #30 added the admin-only mobile Performance Diagnostics panel.

Phase 3 attacks what the **mobile production recording** showed next:
the first dashboard paint waiting ~45–47 s even though the server said
it finished in ~1.6 s.

PostgreSQL remains the source of truth. Auth/session, RBAC, visibility,
Dashboard KPI semantics, Follow-up Queue semantics, Scheduled Activities
semantics, Workbench behavior, routes and API contracts are unchanged.

---

## 1. Production evidence (do not treat local PGlite as success)

Mobile production diagnostics recorded:

| Endpoint | Client total | Server-Timing |
|---|---:|---:|
| `GET /api/dashboard` | **47.632 s** | **1.635 s** (`db.queries` 1.425 s) |
| `GET /api/leads/follow-ups?bucket=today&limit=50` | **46.801 s** | (not the bottleneck) |
| `GET /api/leads/follow-ups?bucket=upcoming&limit=50` | **45.110 s** | (not the bottleneck) |
| `GET /api/scheduled-activities…` | ≈ 0.9 s | |
| `GET /api/users` | ≈ 0.5 s | |
| `GET /api/options` | ≈ 0.5 s | |
| `GET /api/roles` | ≈ 1.15 s | |
| `GET /api/leads` (later in the same session) | ≈ 0.89–0.93 s | |

The same session also showed **repeated** `/api/users`, `/api/options`
and `/api/leads`.

Interpretation (hypothesis, verified in code before changing behavior):

- Backend SQL alone does **not** explain the 45–47 s waits
  (`Server-Timing total = 1.635 s`).
- The huge delay is mostly **outside** server execution.
- Startup request burst / browser connection contention / overlapping
  reads are the likely contributors (mobile browsers still cap ~6
  HTTP/1.1 connections per origin; even HTTP/2 multiplexes poorly on a
  constrained radio when many requests start on the same tick).
- Duplicate reference-data reads increase startup pressure.

This phase does **not** claim the 47 s figure is fixed from local
timings. After deploy, re-record the same three endpoints from mobile
(see §9).

---

## 2. Exact startup request graph (inspected)

After login (or an authenticated cold reload that lands on `/`), these
effects run. “PR #29 coalescing” = in-flight-only, session-scoped, GET
only — it does **not** cache results across requests.

### 2.1 Before Phase 3 (as shipped on `main` after PR #29 / #30)

| # | Request | Caller | When | Critical for first usable dashboard? | Same data requested elsewhere? | PR #29 covers in-flight dupes? | Starts before another request settles? |
|---|---|---|---|---|---|---|---|
| G0 | `GET /api/auth/session` | `authFlow.initializeAuthSession` | Cold reload only (startup gate). Login path skips this (login *is* the proof). | Session must already be valid before the shell. | No. | Single-shot guard in authFlow. | Blocks the shell; nothing else authenticated starts before `isInitialized`. |
| L0 | `POST /api/auth/login` | `Login` → `loginWithCredentials` | Submit. | Yes (auth). | No. | n/a (mutation). | Then `activateSession` navigates to `/`. |
| L1 | `GET /api/options` | `Login.warmUpAfterAuthentication` → `preloadLeadStatuses` → `metadataService.getAllValues('FollowUpStatus')` | Fire-and-forget **immediately** after navigate. | **No.** Defaults render until this returns. | Dashboard `getLeadStatusColorClasses` can kick the same load; LeadList/Settings also read options. **Each type used to fire a full `/api/options` GET** because there was no in-flight coalesce and no session cache. | **No** (not one of the six coalesced readers). | **Yes — joins the dashboard burst.** |
| S1 | `GET /api/roles` | `AppLayout` `[user]` effect | Layout mount (every protected route). Session-cached 5 min (Phase 1). | Shell menu. Not KPI. | `adminService.getRoles` elsewhere. | **Yes.** | **Yes — parallel with dashboard.** |
| S2 | `GET /api/notifications/users/:emp` | `AppLayout` `[user]` effect | Layout mount if no session cache. | **No** (bell). | Panel-open refresh; 60 s tick. | **Yes.** | **Yes — parallel with dashboard.** |
| S3 | `GET /api/users/:id/permissions` | `usePermissions` | Every page that uses the hook (Dashboard does, for Add Lead). Session-cached 5 min. | Add Lead button only. | User Management override panel (raw `fetch`, not coalesced). | **Yes** (own sheet). | **Yes — parallel with dashboard.** |
| D1 | **`GET /api/dashboard?…`** | `Dashboard.loadDashboardData` | Dashboard mount / period change. | **YES — Tier 1.** Sole KPI authority. | StrictMode remount. | **Yes.** | Starts in parallel with D2/D3/D4. |
| D2 | `GET /api/leads/follow-ups?bucket=today&limit=50` | `Dashboard.loadDailyExecution` | Dashboard mount (same tick as D1). | Tier 2 (Today panel items). KPI overdue/today/upcoming **counts** come from D1, not this. | Follow-up Queue page (on navigation). Workbench uses `bucket=all`, not these. | **Yes** (per URL, so today ≠ upcoming). | **Yes — `Promise.all` with D1’s sibling effect and D3/D4.** |
| D3 | `GET /api/leads/follow-ups?bucket=upcoming&limit=50` | `Dashboard.loadDailyExecution` | Same `Promise.all` as D2. | Tier 2 (Tomorrow filter). Cannot be derived from D2 (`bucket=today` has no tomorrow rows). `bucket=all&limit=50` would truncate. | Follow-up Queue upcoming tab; Workbench `bucket=all` (different page, different limit). | **Yes** (separate URL). | **Yes.** |
| D4 | `GET /api/scheduled-activities?from=today&to=tomorrow&limit=100` | `Dashboard.loadDailyExecution` | Same `Promise.all` as D2/D3. | Tier 3. Today/Tomorrow panel mixes these with follow-ups; KPIs do not. | Task Calendar (90-day window, different query); Workbench (today..tomorrow + completed). | **Yes** (URL includes query). | **Yes.** |
| D5 | `GET /api/scheduled-activities?from=-30d&to=+60d` | Embedded `TaskCalendar` | **Already deferred** (Phase 2): mounts only when `!loading && !dailyLoading`. | **No.** | Dedicated `/task-calendar` route. | **Yes.** | Starts only after D1 + daily settle. |

Not started by the Dashboard itself, but observed in the same session:

| Request | Typical caller | Notes |
|---|---|---|
| `GET /api/users` | `userService.getAllUsers` — LeadList, AllLeads, TeamHierarchy, ExecutionIntelligence, AdvancedFilterPanel, leadService visibility filter, User Management, notification fan-out | **No coalesce, no session cache** before Phase 3. Two components on one page (LeadList: own effect + `getLeads` visibility filter) issued two GETs. |
| `GET /api/leads` | LeadList / insights pages (`leadService.getLeads`) | Operational, **not** cached as reference data (and must not be). Dashboard does not call it. |
| `GET /api/leads/follow-ups?bucket=all` | **Daily Workbench only** (limit 200). Not the Dashboard. | Kept. Dashboard does not switch to `bucket=all`. |

### 2.2 After Phase 3

```
cold reload :  GET /api/auth/session            (startup gate — unchanged)
login       :  POST /api/auth/login
             → navigate '/'
             → localDb.createUser (no network)
             → GET /api/options WAITING on shell settle
               (shell settle = first Dashboard KPI, or a non-`/` route)

layout mount (parallel with Tier 1, not deferred — menu / Add Lead):
             GET /api/roles                         (session-cached, coalesced)
             GET /api/users/:id/permissions         (session-cached, coalesced)

Tier 1 — critical:
             GET /api/dashboard?…                   (KPI shell)
             ↳ markCriticalStartupSettled()
                (also marks shell settled)

Tier 2 — after critical settles:
             GET /api/leads/follow-ups?bucket=today
             GET /api/leads/follow-ups?bucket=upcoming   (parallel with each other)

Tier 3 — after follow-ups settle:
             GET /api/scheduled-activities (today..tomorrow)
             GET /api/notifications/users/:emp           (was waiting on SHELL)
             GET /api/options                            (lead-status warm-up, SHELL)

After daily settles (unchanged Phase 2):
             embedded Task Calendar chunk + 90-day window
```

Non-dashboard first route (cold reload on `/workbench`, `/users`, `/leads`,
etc.): `AppLayout` marks **shell** settled immediately so notifications /
options cannot hang. It does **not** mark first-dashboard-critical. The
later first Dashboard load of that session still runs GET `/api/dashboard`
before today/upcoming follow-ups.

After that first Dashboard KPI of the session settles, later Dashboard
revisits skip the first-login sequence (no deadlock). Logout resets both
gates.

---

## 3. Root causes found

1. **Dashboard launched four operational reads on the same tick as the
   KPI request.** `loadDashboardData` and `loadDailyExecution` were
   independent `useEffect`s; daily used `Promise.all([today, upcoming,
   scheduled])`. On a 6-connection mobile pool that put the KPI GET in
   the same burst as two follow-up scans and a scheduled-activity
   window — matching the 47 s / 46 s / 45 s trio vs 0.9 s scheduled.
2. **Today + upcoming cannot be merged without changing semantics.**
   Tomorrow is a filter of `bucket=upcoming` using server
   `bounds.tomorrowStart`. `bucket=today` has no tomorrow rows.
   `bucket=all&limit=50` would mix overdue/today/upcoming and truncate.
   Workbench’s `bucket=all&limit=200` is a different page. Keep two
   APIs; stop firing them *with* the KPI request.
3. **`GET /api/users` had no coalesce and no session cache.** Every
   caller (`getAllUsers`, `getUser`, `getLeads` visibility, LeadList
   roster, fan-out) issued a full list GET. Production’s repeated
   `/api/users` is this, not `/api/users/:id/permissions` (already
   coalesced + session-cached in Phase 1/2).
4. **`GET /api/options` had a per-type in-memory index but still
   re-fetched the full table per type** and had **no in-flight
   coalescing**. Login warm-up + any `getLeadStatusColorClasses` miss +
   LeadList FollowUpStatus/Product = multiple full GETs. The module
   index also survived SPA logout (cross-user residue).
5. **Lead-status warm-up and the notification first-fetch joined the
   burst** even though neither is needed for the KPI shell.
6. **Server SQL is not the 47 s story** (Phase 1/2 already measured
   warm dashboard at a few ms locally, and production Server-Timing
   is 1.6 s). No schema, index, Redis, or query-shape change in this
   phase.

---

## 4. Changes made

### 4.1 Two gates — `startupPriority.ts`

`src/modules/shared/api/startupPriority.ts` keeps **two independent
flags** (one module-global `settled` boolean is not enough: marking it
on `/workbench` would skip sequencing on the later first Dashboard):

| Gate | Waiters | Marked by | Not marked by |
|---|---|---|---|
| **First-dashboard-critical** `waitForCriticalStartup` | Dashboard today/upcoming follow-ups | Dashboard KPI `finally` (success **or** failure) | AppLayout on `/workbench`, `/users`, `/leads`, … |
| **Shell** `waitForShellStartup` | First notification fetch, login options warm-up | AppLayout on any path other than `/`, **and** the first Dashboard KPI settle | — |

- **No `setTimeout`, no global fetch queue, no serialization of all
  business requests.**
- Later Dashboard revisits in the same session resolve immediately
  (the first KPI of the session already ran).
- Logout (`resetStartupPriority`) clears **both** gates and drops
  in-flight waiters (not resolved — they must not fetch under the next
  token).

### 4.2 Dashboard daily execution

- Still **two** server-authoritative follow-up reads
  (`bucket=today|upcoming`, `limit=50`) and **one**
  `scheduledActivityService.list({ from: today, to: tomorrow, limit: 100 })`.
- Follow-ups start only after critical settle; scheduled activities
  start only after those two follow-up reads settle.
- KPI loader is unchanged in authority: `dashboardService.getDashboard`
  only. Today/Tomorrow still does not use `getLeads()`, localStorage or
  localDb. Embedded calendar still waits for `!loading && !dailyLoading`.

Why this order (from the production numbers, not taste):

| Request | Class | Why |
|---|---|---|
| Session (already validated) | given | Security gate. Untouched. |
| `/api/dashboard` | **Tier 1 critical** | Sole KPI authority; 47 s client wait with 1.6 s server. Must own the first connection. |
| follow-up `today` + `upcoming` | **Tier 2** | Needed for the Today/Tomorrow *list*, not for KPI counts (those are on `/api/dashboard`). Two buckets kept (see §3.2). Started together *after* KPIs because they are independent of each other. |
| scheduled today..tomorrow | **Tier 3** | Completes the same panel but is not KPI; production already showed it finishing in ~0.9 s when it was not stuck behind the trio. |
| 90-day calendar | **Tier 3** | Already deferred in Phase 2. |
| notifications first fetch | **Tier 3** | Bell badge. Not first-usable dashboard. |
| `/api/options` warm-up | **Tier 3** | Status colors have hardcoded defaults until it returns. |
| `/api/roles`, own permission sheet | layout | Menu / Add Lead. Session-cached; not deferred (wrong menu flash is worse than one extra GET, and they are already cheap + cached). |

### 4.3 Reference-data session cache (extends Phase 1 `sessionCache` + Phase 2 `coalesceGet`)

| Data | Mechanism | TTL | Key | Invalidation |
|---|---|---|---|---|
| Users list `GET /api/users` | `coalesceGet` + `sessionCache` | 5 min (same as roles) | `users:<user.id>` | `createUser` / `updateUser` / `deleteUser` / `resetPassword` after server confirm; logout |
| Options `GET /api/options` | `coalesceGet` + `sessionCache` (full list, then per-type filter) | 5 min | `options:<user.id>` | add/update/delete/reorder/deleteType after server confirm; logout (plus the per-type memory index via `registerSessionCacheClearHandler`) |
| Roles | already | 5 min | `roles:<user.id>` | role save/delete (unchanged) |
| Notifications | already | 60 s refresh | `notifications:<emp>` | mutations / panel open / logout (unchanged) |
| Own permission sheet | already | 5 min | `userPermissions:<user.id>` | override save / logout (unchanged) |

**Not cached as reference data (and guarded):** dashboard KPI, follow-up
queue, scheduled-activity lists, lead execution state.

Rules (all asserted):

- Server remains authoritative — cache written only after a successful GET.
- Same-session only; keyed by authenticated `user.id`.
- GET reads only; mutations never go through `coalesceGet`.
- No cross-user leakage (logout clears session cache + in-memory indexes).
- No Redis, no persistence, no SWR flash of stale KPIs.

---

## 5. Cache policy / invalidation policy (summary)

```
write  : after successful GET /api/users or GET /api/options
read   : same authenticated user, within 5 minutes, else fresh GET
join   : in-flight identical URL + session (PR #29 coalesceGet)
drop   : mutation of that reference set (server-confirmed) OR logout
never  : dashboard / follow-ups / scheduled activities / leads list
never  : cross-user, cross-tab persistence, authorization decisions
```

---

## 6. Before / after request-count expectation

Deterministic, first login → Dashboard, one tab, production (not StrictMode):

| | Before | After |
|---|---|---|
| On the critical path (before KPI paint) | session/login + dashboard + today + upcoming + scheduled + roles + notifications + permissions + options warm-up ≈ **8–9 parallel** | login/session + **dashboard** + roles + permissions ≈ **3–4**. Options + notifications **wait**. Follow-ups **wait**. |
| Unique `/api/users` GETs in one startup window | 0 on Dashboard itself; **N** as soon as any page called `getAllUsers` (LeadList could issue 2) | **≤ 1** per user per 5 min, coalesced if concurrent |
| Unique `/api/options` GETs in one startup window | 1 per type per caller (login warm-up + LeadList FollowUpStatus + Product = 3) | **≤ 1** per user per 5 min, coalesced if concurrent |
| Follow-up GETs on Dashboard | 2, simultaneous with KPI | 2, **after** KPI settle, still not `bucket=all` |
| Scheduled GETs on Dashboard | 1, simultaneous with KPI + follow-ups | 1, **after** follow-ups; 90-day still after daily |
| StrictMode duplicate GETs | collapsed by PR #29 for the six readers; users/options were **not** | users/options now collapsed too |

KPI **counts** (Overdue / Due Today / Upcoming on Follow-up Discipline)
still come only from `/api/dashboard`. The follow-up GETs still feed
the Today/Tomorrow **list**. No stale business-data flash: those lists
keep `dailyLoading` skeletons until both follow-ups *and* scheduled
activities have settled.

---

## 7. Why each request is critical / not

See the table in §4.2. Short version: **first usable dashboard = KPI
cards from `/api/dashboard`**. Everything else is either the same
panel’s details (Tier 2/3) or chrome (bell, status colors, menu).

---

## 8. Things deliberately NOT changed

- DB schema, indexes, Redis, paid monitoring
- Auth/session flow, bcrypt, RBAC, lead visibility
- Follow-up queue API / Workbench `bucket=all` / scheduled-activity API
- Forced password change, Bulk User Import, Manager Attention, Lead Quality
- Broad AppLayout refactor (only: defer first notification fetch; release
  the gate on non-`/` routes)
- API client rewrite; PR #30 diagnostics (untouched)
- Stale-while-revalidate for KPI / follow-up / scheduled data

---

## 9. Mobile validation steps (required after deploy)

Do **not** treat local `scripts/perf-baseline.ts` / PGlite numbers as
success. Use the existing admin-only panel:

1. Log out completely (diagnostics wipe on logout).
2. On the **same Android mobile browser** as the 47 s recording, log in
   as Admin and land on Dashboard. Wait until KPIs **and** Today/Tomorrow
   have settled. Do not open other pages yet.
3. Open **System → Performance Diagnostics**.
4. Copy summary. Compare the **same three rows**:

| Endpoint | Before (this doc) | After (fill in from mobile) |
|---|---:|---:|
| `/api/dashboard` | 47.632 s client / 1.635 s Server-Timing | |
| `/api/leads/follow-ups?bucket=today` | 46.801 s | |
| `/api/leads/follow-ups?bucket=upcoming` | 45.110 s | |

5. Confirm in the numbered list that:
   - `/api/dashboard` appears **before** the two follow-up GETs
     (sequence numbers).
   - `/api/options` and `/api/notifications/users/…` appear **after**
     dashboard (or not at all if unused).
   - `/api/users` and `/api/options` appear **at most once** in the
     startup window.
6. Internal marker in source (for grep / code review):
   `STARTUP_CRITICAL = GET /api/dashboard` in
   `src/modules/shared/api/startupPriority.ts` and
   `Dashboard.loadDashboardData`.

A win looks like: dashboard client total drops toward Server-Timing
plus one RTT (not 45 s), and the two follow-up rows are no longer
tied to the same 45 s cliff.

---

## 10. Remaining risks

- **Mobile radio / TLS / HTTP/2 head-of-line** can still inflate any
  single GET. Sequencing removes *contention*, not physics.
- **Vercel cold start + remote Postgres RTT** still sit inside
  Server-Timing (~1.6 s on the recorded dashboard). Out of scope.
- If a future route is mounted at `/` that is not the Dashboard, the
  first-dashboard-critical gate would wait for a KPI load that never
  runs — today `/` **is** Dashboard. Non-`/` paths release only the
  **shell** gate; they no longer pretend the first Dashboard already ran.
- Users/options 5-minute TTL can be up to 5 minutes behind another
  admin’s edits in a different tab. Same trade as roles. Mutations in
  *this* session invalidate immediately.
- First Today/Tomorrow paint is a few hundred ms later than KPIs (by
  design). Skeletons stay until server data arrives — no empty-then-fill
  of operational counts.

---

## 11. Verification

- `npm test -- --run`
- `npx tsc --noEmit`
- `npm run build`
- `npm run verify:serverless`

New guards: `server/tests/perf-phase3-source-guards.test.ts`.
Existing PR #29 (`perf-phase2-source-guards`), PR #30
(`perf-diagnostics-source-guards`), auth-flow, RBAC, dashboard,
follow-up and scheduled-activity suites must stay green.
