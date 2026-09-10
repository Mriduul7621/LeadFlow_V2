# Performance & Latency Hardening

Focused step to reduce three measurable user-facing latencies:

1. Delay after submitting login credentials
2. Slow-feeling sidebar / page navigation
3. Delay when creating / saving / updating records

All changes are compatibility-preserving: no RBAC rewrite, no JWT/session
contract change, no visibility-model change, no schema change, and
PostgreSQL remains the source of truth.

---

## 1. Observed performance causes (measured in the code, not guessed)

### 1.1 Global polling in `AppLayout` (the navigation lag)

`src/layouts/AppLayout.tsx` ran **two permanent API polls** for the whole
authenticated session:

| Poll | Interval | Endpoint | DB cost per tick |
|---|---|---|---|
| `setInterval(fetchPerms, 6000)` | **6 s** | `GET /api/roles` | `ensureDefaultRoles` check + full `SELECT * FROM roles` |
| `setInterval(fetchNotifs, 8000)` | **8 s** | `GET /api/notifications/users/:emp` | `notifications LEFT JOIN users` |

Worse: **every route in `App.tsx` is a separate `ProtectedRoute` element**,
so `AppLayout` *remounts on every navigation*. Each remount re-ran both
`[user]` effects, i.e. **every single click in the sidebar issued
2 additional API requests (and their DB queries) immediately**, plus the
6 s / 8 s polls continued in the background. For a user browsing a few
screens per minute this was the dominant source of "the app feels slow
when I click around", and it kept the pool/DB busy with zero user value.

`usePermissions` additionally polled `localStorage` every **3 s**
(`src/modules/shared/hooks/usePermissions.ts`) to notice same-tab role
cache writes — re-rendering every permission-consuming component on a
timer with no server work, and the browser `storage` event it coexisted
with only fires in *other* tabs anyway.

### 1.2 Login critical path (the post-credential delay)

`POST /api/auth/login` (server) serialized four DB round-trips before
responding, one of which was pure bookkeeping:

1. `SELECT ... users JOIN roles ... WHERE employee_id/email` (user lookup)
2. `bcrypt.compare` (CPU-bound, **must stay** — not weakened)
3. `UPDATE users SET last_login = NOW()` — **awaited on the response
   path**, then
4. `JWT sign` + response.

The `last_login` update does not affect authentication; awaiting it added
a full pool round-trip to the critical path on every login.

### 1.3 Repeated sequential authorization lookups (every lead request)

Every lead endpoint paid for the same lookups multiple times:

- `getCallerDbInfo(req)` — `users LEFT JOIN roles` (up to **twice** per
  request: `DELETE /leads/:id` resolved it once in the guard and again in
  the handler).
- `hasPermissionCode(caller, code)` — **3 sequential queries**
  (`permissions` → `user_permissions` → `role_permissions`), re-run for
  each code: `POST /leads` could check `leads.create|edit|assign|transfer`
  (4 codes × 3 queries), `GET /dashboard` checked two, the follow-up queue
  and lead list one each.
- `resolveCallerVisibility(caller)` — `roles.data_visibility` lookup +
  recursive downline CTE + `users` fetch, re-resolved for every scope
  check in the same request.
- `managerEmployeeId` — called **twice, sequentially** on the
  `POST /leads` response path (assigned_to + assigned_by).
- `POST /leads/:id/follow-up` re-fetched the **entire lead row with
  `SELECT l.*` + two joins after COMMIT** just to re-derive two employee
  ids the transaction had not changed.

### 1.4 Save latency (the slow "Saving…")

- Client `leadService.createLead` / `updateLead` **awaited the
  assignment-notification fan-out** after the lead commit: that fan-out
  fetches the full users list and then issues **one sequential
  `POST /api/notifications` per supervisor** up the chain. The lead was
  already committed server-side, yet the UI "saving" state stretched to
  the whole fan-out.
- `LeadList` **refetched the full lead list after every successful
  status/follow-up save** (`leadService.getLeads`, which also fetches the
  full users list for the visibility filter) although the follow-up
  response already contains the authoritative updated lead. Same for
  quick status updates and deletes.

### 1.5 Database pool

Reviewed `server/database/connection.ts`: the `pg.Pool` is **module-scoped
(reused across requests — correct)**, `max: 20`, idle timeout, explicit
`client.release()` in `finally` blocks, and `pool.query` is used where no
transaction is needed. **No change required.** (Vercel serverless
functions still get a fresh process per invocation — that cold start is
infra-dependent, see §7.)

---

## 2. Changes made

### 2.1 Removal of aggressive global polling (client)

`src/layouts/AppLayout.tsx` now uses a **session-scoped in-memory cache**
(new: `src/modules/shared/api/sessionCache.ts` — keyed by user, cleared on
logout, written only after a successful API response):

- **Roles / menu permissions**: fetched **once per session**; the layout
  remount on navigation is served from the cache (zero requests per
  click). Refresh happens (a) after the explicit role save/delete flows
  (`adminService.saveRole` / `deleteRole` invalidate the cache), and (b) by
  a conservative tick that re-checks at most every **5 minutes** and only
  while `document.visibilityState === 'visible'`. The 6 s poll is gone.
  Dynamic `menuAccess` behavior and the ADMIN bypass are untouched
  (`isItemVisible` logic preserved, extracted verbatim to
  `src/layouts/menuVisibility.ts` for testability).
- **Notifications**: no 8 s poll. Initial fetch once per session; refresh
  when the **panel is opened**, after every **successful mutation**
  (mark read / mark all / delete all sync state + cache only after the
  server confirms), and a **60 s** background refresh that is **paused
  while the tab is hidden**. An in-flight de-duplication guard prevents
  double fetches when the panel is opened during the session fetch.
  localStorage remains a read-only offline cache; DB/API stays
  authoritative.
- `usePermissions` no longer polls localStorage every 3 s: the cache
  writer (`adminService.writeCache` for the roles key) now emits the
  same-tab event `lf-roles-cache-changed`
  (`src/modules/shared/utils/localCacheEvents.ts`) that the hook listens
  to, alongside the cross-tab `storage` event.
- The user's **own permission sheet** (`GET /api/users/:id/permissions`,
  fetched by `usePermissions` on every page mount) is now session-cached
  with a 5-minute TTL and invalidated when the signed-in user's overrides
  are saved in User Management.

### 2.2 Login latency (server)

`POST /api/auth/login`:

- `last_login` is still written for every successful login (semantics
  preserved) but **no longer blocks the response** — it is issued
  fire-and-forget after the password check passes, so a failure of the
  bookkeeping write can never fail or delay an authenticated session.
- No changes to credential validation, bcrypt (cost unchanged), JWT
  issuance, or the session profile contract.

### 2.3 Request-scoped authorization efficiency (server)

New: `server/utils/requestAuthz.ts` — a per-request memo attached to the
`req` object (non-enumerable, dies with the request):

- `getCallerDbInfo` is **memoized per request**: the caller row is
  resolved at most once no matter how many guards/handlers authorize.
- `hasPermissionCode` results are **memoized per (caller, code) for one
  request**, and the **3 sequential queries collapsed into ONE join**:
  ```sql
  SELECT up.permission_id IS NOT NULL AS has_user_override,
         up.is_allowed  AS user_override_allowed,
         rp.permission_id IS NOT NULL AS has_role_grant,
         rp.is_allowed  AS role_grant_allowed
    FROM (SELECT id FROM permissions WHERE permission_code = $3 LIMIT 1) p
    LEFT JOIN user_permissions up ON up.permission_id = p.id AND up.user_id = $1
    LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $2
  ```
  Semantics are **byte-for-byte identical** to the old sequential logic:
  missing definition → deny; **user override row beats role grant**
  (including an explicit `false` override); no grant → deny; DB error →
  deny (fail closed); ADMIN/SUPERADMIN bypass unchanged.
- `resolveCallerVisibility` is **memoized per caller instance** (one
  request), so visibility is resolved at most once per request.

Safety properties (all asserted in tests):

- no cross-user or cross-request caching (the memo lives on `req` / the
  per-request caller object);
- fail-closed on missing definitions and DB errors;
- override precedence unchanged;
- no client-side authorization of any kind.

### 2.4 Mutation response paths (server)

- `POST /leads`: the response joins for `assigned_to` / `assigned_by`
  now run as **one primary-key lookup** (`employeeIdsFor`) instead of two
  sequential per-user queries.
- `POST /leads/:id/follow-up`: the post-commit `SELECT l.* … + 2 joins`
  re-fetch is replaced by mapping the row the `UPDATE … RETURNING *`
  already returned, plus the same one primary-key employee-id lookup.
  The transaction, append-only activity semantics, row lock and commit
  boundaries are unchanged; the response body is unchanged.

### 2.5 Save latency (client)

- `leadService.createLead` / `updateLead`: the assignment-notification
  fan-out (users list fetch + one notification POST per supervisor) is
  **fire-and-forget after the lead commit**. The save resolves when the
  server confirms the lead; fan-out failures still surface via the
  existing warning toast. No optimistic success, no changed contracts.
- `LeadList`: after a successful follow-up/status save the **authoritative
  lead from the mutation response** patches the list in place
  (`applyLeadUpdate`) — no full lead-list refetch (and no accompanying
  users-list refetch). Delete removes the row locally after the server
  confirms the soft delete. Full refetch remains the fallback when a
  response lacks the row (defensive, not the common path).

### 2.6 Performance instrumentation (server)

New: `server/utils/perf.ts` — a minimal span tracker for critical paths:

- Instrumented events: `auth.login`, `auth.session`, `leads.list`,
  `lead.save`, `lead.followUp`, `dashboard`.
- Spans: `authz.caller`, `authz.permission(s)`, `authz.visibility`,
  `db.userLookup`, `auth.bcryptVerify`, `db.upsert`, `db.lockLead`,
  `db.updateAndActivity`, `db.commit`, `db.responseJoins`, `db.queries`,
  `db.query`.
- Output:
  - **`Server-Timing` header** on every instrumented response (body
    unchanged), e.g.
    `total;dur=87.4, db.userLookup;dur=3.1, auth.bcryptVerify;dur=61.2`.
  - **One structured console line** (`[perf] {"event":…,"totalMs":…,"spans":[…]}`)
    **only when development logging is enabled** (non-production, or
    explicit `PERF_LOGS=1`). Production logs nothing by default.
  - Only span labels and durations are ever recorded — never request
    bodies, tokens, credentials or customer data.

---

## 3. Request reduction, before vs after

Deterministic per-user, per-tab counts (authenticated, tab visible):

| Scenario | Before | After |
|---|---|---|
| **One full hour of a mostly idle logged-in session** (no user actions) | roles: **600×** `GET /api/roles` (1/6 s) + notifications: **450×** `GET /api/notifications/users/:emp` (1/8 s) ≈ **1050 API calls / 1050+ DB queries** | roles: **≤ 12** (5-min TTL re-check, paused when hidden) + notifications: **≤ 60** (60 s, paused when hidden) ≈ **≤ 72 calls** — **~93 % fewer** |
| **One sidebar click (route change)** | 2 extra API calls (roles + notifications) + all page-specific loads | **0 extra shared-session calls** (served from session cache) + page-specific loads only |
| **Login → land on dashboard** | +1 awaited `UPDATE users.last_login` on the login critical path | login critical path = user lookup + bcrypt + sign (last_login async) |
| **One `POST /leads` save (DB mode)** | caller(1) + visibility(2–3) + 1–2 permission checks(3–6) + upsert(1) + 2× employee lookup(2) ≈ **9–13 sequential queries** | caller(1) + visibility(1–3, once) + permissions(≤ 2 joins, memoized) + upsert(1) + 1 employee batch(1) ≈ **5–8 queries**, response joins halved |
| **Follow-up save** | … + post-commit `SELECT l.* + 2 joins`(1, heavy payload) | … + post-commit 1-row PK lookup(1, tiny payload) |
| **Status save in LeadList** | mutation(1) + full `GET /api/leads`(1) + `GET /api/users`(1) | mutation(1) — list patched from the response |

(The dashboard already ran its three aggregates via `Promise.all`;
unchanged.)

---

## 4. Caching & invalidation rules

| Cache | Scope | Written | Invalidated |
|---|---|---|---|
| Session roles (`roles:<userId>`) | in-memory, per user, per browser session | after successful `GET /api/roles` | role save/delete (`adminService`), logout (whole cache), 5-min TTL |
| Session notifications (`notifications:<emp>`) | in-memory, per user | after successful `GET /api/notifications/users/:emp` and after every confirmed mutation | logout, 60 s refetch, panel open |
| Session permission sheet (`userPermissions:<userId>`) | in-memory, per user | after successful `GET /api/users/:id/permissions` | signed-in user's override save, logout, 5-min TTL |
| localStorage `lf_local_roles_permissions` | per browser | after successful role reads/writes (unchanged) | same as before + same-tab event `lf-roles-cache-changed` (replaces the 3 s poll) |
| Request memo (caller / permissions / visibility) | **single HTTP request** | by the fail-closed helpers themselves | request end — never crosses users or requests |

Rules: DB/API always authoritative; localStorage never authoritative; no
authorization state cached across users; no long-lived security decisions.

---

## 5. What remains infrastructure-dependent

- **Vercel/Node serverless cold start**: each function invocation may spin
  up a process; `initializeDatabase()` (migrations check) runs once per
  process. Not addressable from this codebase without changing the
  hosting model.
- **Remote PostgreSQL (Supabase) network latency**: every query pays a
  round-trip; the pool is already module-scoped. Further wins (read
  replicas, connection pooling at the DB edge, indexes for
  `leads.custom_fields->>'assignedTo'` scans) belong to the dedicated
  **DB-performance phase** — deliberately deferred here (no schema/index
  changes in this PR).
- **bcrypt cost**: intentionally unchanged (10 rounds) — security first.

## 6. Deferred performance work

- DB indexes / query-plan work for visibility-scoped lead scans
  (custom_fields text-array filter, `next_follow_up_at` bucket queries).
- Consolidating the legacy route files (`server/routes/index.ts` and
  controllers) — dead code in the current mount; out of scope.
- A persistent (shared) session cache for multi-tab layouts.
- Virtualized lead table rendering for very large lists (UI phase).

## 7. Verification

- `npm test -- --run` — full suite (auth, lead security, visibility,
  bulk import, follow-up, dashboard, **plus the new
  `perf-latency-hardening` regression guards**).
- `npx tsc --noEmit`, `npx vite build`, `npm run build`,
  `npm run verify:serverless`.
- New guards: `server/tests/perf-latency-hardening.test.ts`.
