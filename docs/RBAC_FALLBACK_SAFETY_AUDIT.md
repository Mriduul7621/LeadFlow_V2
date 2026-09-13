# RBAC / Production Fallback Safety Audit

**Scope:** Production safety audit + hardening of the LeadFlow V2 RBAC model (Data
Visibility / Feature Access / Action Permissions), browser-side local cache,
cross-user cache isolation, and offline/network/DB-outage fallback behavior.
No business features were added; the established three-layer model, the
ADMIN/SUPERADMIN bypass, and all merged behavior (PR #37 Lead Quality, PR #38,
PR #39) are preserved.

**Method:** Full read of the production route surface (`server/routes/production.routes.ts`),
the server authz helpers (`server/authz.ts`, `server/middleware/*`), the permission
catalog (`server/database/migrations/025_permissions.ts`), role seeding, and every
client service/store that touches localStorage or the API. Each finding below was
verified against the code and is now locked by a regression test (see
[Test evidence](#test-evidence)).

---

## 1. Audit findings (actual gaps) and exact fixes

| # | Gap (verified) | Risk | Fix in this PR |
|---|----------------|------|----------------|
| G1 | `GET /api/audit-logs` was authenticated-only (`requireAuth`) with **no permission gate** — any logged-in employee could read the org audit trail. | Information disclosure of admin actions (bulk imports, password resets, role saves). | Added `requirePermissionCode('audit.view')` — a canonical code already in the 025 catalog (no new codes invented). Fail closed: no grant → 403; ADMIN/SUPERADMIN bypass unchanged. |
| G2 | `GET /api/notifications/leads/:leadId` had **no permission and no Data Visibility check** — any authenticated user could read the notification history of **any** lead code (existence leak + who-was-notified leak), including leads outside their visibility scope. | Cross-scope data leak. | Handler now requires `leads.view` **and** `isLeadAccessible(leadRow, visibility, caller)`; out-of-scope or unknown leads return `404` (no existence leak). Demo and PG paths both guarded. |
| G3 | `POST /api/notifications` let **any authenticated user create notifications for any other user** (`userId` was an unconstrained parameter). The only business flow producing cross-user notifications is lead assignment/transfer fan-out. | Cross-user write surface (spam/injection into arbitrary accounts). | Self-directed notifications remain self-service (authenticated). Cross-user creation now requires `leads.assign` **or** `leads.transfer` (canonical routing grants) or the ADMIN/SUPERADMIN bypass; everything else 403. |
| G4 | Browser business caches (`localDb.ts`) were stored under **unscoped global** keys — `shanta_leads`, `shanta_users`, `shanta_notifications`. After User A logged out and User B logged in on the same browser, B's offline read fallback (network/5xx) could surface **A's** previously cached leads/users/notifications. | Cross-user data leak via the offline fallback path — the exact failure class this audit targets. | `localDb.ts` rewritten: business keys are now **per authenticated user** (`shanta_leads:<uid>`, …). When no user is resolvable, reads return the empty fallback and writes are **no-ops** (business data is never persisted unscoped). `setLocalDbUserIdProvider` (registered by `authStore`) resolves the current user; `clearUserCaches(uid)` deletes a user's scoped caches; `clearLegacyGlobalCaches()` purges the pre-hardening unscoped globals. `shanta_options` stays global by design (org-wide reference data, identical for all users, no per-user secrets). |
| G5 | `authStore.logout` removed the token but left the signing-out user's **business caches** and the in-memory **session caches** (sessionCache, read coalescing, startup priority) intact for the next login. | Next user on the same browser inherits prior session state. | `logout` now, in order: captures the signing-out user, removes `leadflow-auth` + `leadflow_last_activity`, `clearSessionCache()`, `clearCoalescing()`, `resetStartupPriority()`, `clearUserCaches(signingOutUser?.id)`, `clearLegacyGlobalCaches()`, then resets auth state. (The persisted snapshot may be re-written by zustand during the final `set()` but provably holds `user:null / token:null / isAuthenticated:false` — re-validated against the server on cold load by `authFlow.ts`.) |
| G6 | `notificationService.ts` wrote notification caches directly to raw `localStorage` (bypassing `localDb` scoping). | Cross-user leak persisted by the notification flow itself. | Both write paths now go through `localDb.saveNotifications` (scoped). |
| G7 | Feature Access (Layer B) was enforced **only in the sidebar** (menu items hidden). A disabled module's page could still be reached by typing/pasting its URL. | Feature toggle bypass for non-admin roles. | New `src/layouts/featureRouteAccess.ts` (pure `resolveFeatureRouteAccess` + `FEATURE_ROUTES` registry, static fallbacks identical to `AppLayout`) and `src/modules/auth/components/FeatureGate.tsx` (reads roles from the same `roles:<uid>` session cache + `adminService.getRoles()` as the sidebar, `Navigate` on deny). **All 18 page routes** in `App.tsx` are wrapped `<ProtectedRoute><FeatureGate route="…"><LazyPage…/></FeatureGate></ProtectedRoute>`. This is a visibility gate — the server remains the security boundary for every API call. |
| G8 | Each of the 8 API-first read services inlined its own cache-fallback condition (`err.status === 0 \|\| err.status >= 500`, and one inverted variant `err.status !== 0 && err.status < 500`) — policy drift risk: a future service could mask a 403/404 with stale cached business data. | Inconsistent offline authority rule. | New shared `src/modules/shared/api/offlinePolicy.ts`: `shouldFallBackToCache(status)` = `status === 0 \|\| status >= 500` (transport/server unavailable only); `isAuthoritativeClientError(status)` = 4xx. All 8 services now gate their read fallback through the helper; 401/403/404/400 **always rethrow**. |

**Confirmed safe (no change needed):** lead CRUD/follow-up/bulk/scheduled-activity
mutations (canonical grants + visibility, params narrow only), role permission
matrix write, campaign purge, clear-all, admin password reset, form-field admin
routes (all `requireAdmin`), forced-password server truth (`change-required-password`
is caller-only and 409s unless `must_change_password`), `hasPermissionCode` DB
error → 503 deny, `resolveCallerVisibility` DB error → `Own`, production without
`DATABASE_URL` → 503 (`demoModeAllowed = !IS_PRODUCTION && !useDb()`, so the demo
fallback store is structurally unreachable in production).

---

## 2. The three-layer model (preserved)

| Layer | Question it answers | Where enforced | Server authority |
|-------|--------------------|----------------|------------------|
| **A. Data Visibility** (`roles.data_visibility`: `Own` / `DownTeam` / `FullTeam` / `Organization`) | *Which rows may this user see?* | `resolveCallerVisibility` in every leads/dashboard/notification query — the clause is ANDed into the SQL; query params can **only narrow**. | Yes — client `dataScope.ts` is UX-only. |
| **B. Feature Access** (`roles.menu_access` per module path) | *Which pages may this user open?* | Sidebar (`AppLayout` → `resolveMenuVisibility`) **and** route (`FeatureGate` → `resolveFeatureRouteAccess`, same decision). | No — visibility gate only; never grants an API action. |
| **C. Action Permissions** (canonical codes in `role_permissions` / `user_permissions`, 025 catalog) | *Which actions may this user perform?* | `requirePermissionCode` / `hasPermissionCode` on every mutation + privileged read. | Yes — the security boundary. |

ADMIN/SUPERADMIN bypass in Layer C (`hasPermissionCode`) and Layer B is unchanged.
Layer A is applied to **all** roles including admins (admins get `Organization`
semantics via the helper, which is the established behavior). `role_permissions`
remains unseeded (fail closed); grants are made only via the admin role editor.

## 3. Route → guard coverage matrix (every mounted production route)

`requireAuth` = JWT (401 anonymous). `requireAdmin` = ADMIN/SUPERADMIN. Codes are
canonical 025-catalog codes. **All mutation routes are covered; no mounted route is
ungated** (locked by `rbac-fallback-safety-audit.test.ts` A1/D3).

### Auth
| Route | Guard |
|---|---|
| `GET /auth/bootstrap-status`, `GET /auth/bootstrap-admin`, `POST /auth/login` | open (pre-auth) |
| `GET /auth/session` | requireAuth |
| `POST /auth/change-password` | requireAuth + self-or-admin in handler |
| `POST /auth/change-required-password` | requireAuth, **caller-only**, 409 unless `must_change_password` (server truth) |

### Users
| Route | Guard |
|---|---|
| `GET /users`, `GET /users/:id`, `GET /users/:id/permissions`, `GET /users/:id/audit-logs`… (reference reads) | requireAuth (self-or-admin where marked) |
| `POST /users` | requireAuth + `users.create` |
| `PUT /users/:id` | requireAuth + `users.edit` |
| `DELETE /users/:id` | requireAuth + `users.delete` |
| `POST /users/:id/reset-password` | **requireAdmin** (deliberately admin-only, no action code) |
| `POST /users/bulk/validate` / `POST /users/bulk/commit` | requireAuth + in-handler `users.create` / `users.edit` per row (Bulk User Import perms) |
| `PUT /users/:id/permissions` | requireAuth + `permissions.manage` (per-user overrides are **not** self-service) |
| `GET /audit-logs` | requireAuth + **`audit.view`** ← *new (G1)* |

### Admin surface
| Route | Guard |
|---|---|
| Departments CRUD | `departments.manage` |
| `POST /roles`, `DELETE /roles/:id` | `roles.manage` |
| `GET /roles/:id/permissions`, `PUT /roles/:id/permissions` | **requireAdmin** (role permission matrix stays admin-only) |
| `GET /permissions` | requireAuth | `POST/DELETE /permissions…` | requireAdmin (ADMIN matrix row undeletable) |
| Teams CRUD | `teams.manage` |
| Hierarchy create/delete, `PUT /hierarchy-config` | `hierarchy.manage` |
| `GET /organogram` | requireAuth |
| Settings | `settings.manage` |
| Workflow rules | `workflow.manage` |
| Form fields (+reorder) | **requireAdmin** |

### Notifications
| Route | Guard |
|---|---|
| `GET /notifications/users/:userId`, `POST …/read-all`, `DELETE …/:id/read`, `DELETE …/:id` | self-or-admin (`requireSelfOrAdmin`) |
| `GET /notifications/leads/:leadId` | requireAuth + **`leads.view` + lead Data Visibility, 404 out-of-scope** ← *new (G2)* |
| `POST /notifications` | self-service for self; **`leads.assign` \| `leads.transfer`** for cross-user; admin bypass ← *new (G3)* |

### Leads
| Route | Guard |
|---|---|
| `GET /leads` | requireAuth + `leads.view` + visibility clause (params narrow only) |
| `POST /leads` | `leads.create` (owner reassignment on create needs `leads.assign`\|`leads.transfer` + `isAssignedToAllowed`) |
| `POST /leads/bulk` | `leads.import` \| `leads.create` |
| `GET /leads/:id` | `leads.view` + `isLeadAccessible` (404 out-of-scope) |
| `GET /leads/:id/quality` | **same boundary as the lead itself** (PR #38 — no new mutation permission, no widening) |
| `POST /leads/:id/follow-up` | `leads.edit` + accessibility |
| `PUT /leads/:id` | `leads.edit` (+ reassignment rules) |
| `DELETE /leads/:id` | `leads.delete` (or admin) + accessibility |
| `DELETE /leads/campaign/:campaign` | **requireAdmin** (campaign purge) |
| `POST /leads/clear-all` | **requireAdmin** (clear-all) |

### Scheduled activities
| Route | Guard |
|---|---|
| reads | `leads.view` + lead visibility (`assignedTo` param narrows only; out-of-scope → empty payload) |
| create/update/cancel/complete | `leads.edit` (reassignment `leads.assign` + `isAssignedToAllowed`); completed/cancelled → 409 |

### Dashboard
| Route | Guard |
|---|---|
| `GET /dashboard` | `dashboard.view` OR `leads.view`; every aggregate scoped by the caller visibility |

## 4. Feature Access (Layer B) mapping — page routes

Static role fallbacks are identical to the `AppLayout` sidebar; an explicit dynamic
`menuAccess[path]` (true **or** false) wins. `ADMIN`/`SUPERADMIN` always pass.
Locked by `feature-route-access.test.ts` (pure decision + registry ↔ App.tsx ↔
AppLayout lockstep + FeatureGate source guard).

| Route (FeatureGate key) | Module path | Static roles |
|---|---|---|
| `/` (Dashboard) | `/` | all roles |
| `/workbench` (Daily Workbench) | `/workbench` | all roles |
| `/activities` | `/activities` | all roles |
| `/task-calendar` | `/task-calendar` | all roles |
| `/follow-up` (Follow-up Queue) | `/follow-up` | all roles |
| `/leads` (Lead Workspace) | `/leads` | all roles |
| `/leads/new` (Add New Lead) | `/leads/new` | all roles |
| `/leads/upload` (Bulk Upload) | `/leads/upload` | ADMIN |
| `/leads/all` (Lead Pool) | `/leads/all` | ADMIN |
| `/execution-intelligence` (Performance) | same | ADMIN, RO, RM |
| `/ncp-progress` | same | ADMIN, RO, RM |
| `/trend-charts` (Trends) | same | ADMIN, RO, RM |
| `/campaign-breakdown` (Campaigns) | same | ADMIN, RO, RM |
| `/team` (Team / Hierarchy) | `/team` | ADMIN, RM, ASM, BDM, BE, BH |
| `/users` (Users) | `/users` | ADMIN |
| `/settings` | `/settings` | all roles |
| `/settings/performance-diagnostics` | same | ADMIN, SUPERADMIN (plus `AdminRoute` inside) |
| `/leads/:id` (Lead 360) | inherits `/leads` | all roles |

Note: Layers B and C are independent — an explicit `menuAccess` true only opens the
**page**; the API still requires the canonical grants (proven by B1: full menuAccess
+ Organization visibility with **zero** grants → every mutation 403, even `GET /leads`
403 without `leads.view`).

## 5. Admin-only capabilities (kept admin-only)

Role permission matrix read/write, campaign purge, clear-all leads, admin password
reset, form-field administration, fine-permission writes, `permissions.manage`
surfaces, performance diagnostics page. Locked by A1/D1/D3.

## 6. Data Visibility (Layer A) mapping — server-side only

| Visibility | Rows visible (leads) | Proven by |
|---|---|---|
| `Own` | leads where `assigned_to` or `created_by` = caller | E1 |
| `DownTeam` | recursive reporting subtree (manager chain), caller included | E2 |
| `FullTeam` | caller's department (with department fallback for downline resolution) | E3 |
| `Organization` | all non-deleted leads | E4 |

Rules: the clause is ANDed into every query (list, detail, quality, follow-up queue,
dashboard, scheduled activities, lead-scoped notifications); query params can only
narrow (C2: forged `assignedTo` + Own → empty, never widened); action grants can
never widen (C1: full `leads.*` + Own → still own-only, foreign detail 404, foreign
mutation 403); DB failure resolves to `Own` (fail safe). Lead Quality (PR #38)
follows the identical boundary (F1/F2).

## 7. localStorage / localDb classification

| Key | Class | Behavior |
|---|---|---|
| `shanta_leads:<uid>`, `shanta_users:<uid>`, `shanta_notifications:<uid>` | **Read-only offline cache** (user-scoped) | Written only after a server-confirmed read/commit. Offline **reads** may use them when the server gave no answer (status 0 / 5xx) via `offlinePolicy`. **Never** authoritative for mutations; unscoped → empty reads / no-op writes; deleted on logout. |
| `shanta_options` | **Safe reference cache** (org-wide, global by design) | Option lists returned identically to every user; no per-user secrets. |
| `lf_local_roles_permissions`, `lf_local_teams`, `lf_local_fine_permissions` | **Reference cache** (org-wide) | Role/team/fine-permission profiles mirror the server; every read is API-first with the local copy as offline convenience, and the server re-authorizes every request (`hasPermissionCode`), so these caches can never grant authority. `roles:<uid>` in the in-memory sessionCache is per-user and cleared on logout. |
| `leadflow-auth`, `leadflow_last_activity` | **Session cache** | Token snapshot is a cache, never proof — `authFlow.ts` re-validates on cold load; both removed on logout (snapshot provably emptied). |
| `shanta_leads`, `shanta_users`, `shanta_notifications` (unscoped, pre-hardening) | **Unsafe legacy** | Purged on every logout by `clearLegacyGlobalCaches()`. |
| `fallbackStore` (server in-memory) | **Demo-only, structurally unreachable in production** | `demoModeAllowed() = !IS_PRODUCTION && !useDb()`; production without `DATABASE_URL` returns 503. |

**Authority rule:** no local store (browser or server in-memory) can authorize or
persist a production mutation. Writes are API-first and a failed write throws.

## 8. Cross-user cache policy (logout / user switch)

On `logout()`: signing-out user's scoped business caches deleted; legacy unscoped
globals purged; `sessionCache` (roles, permission sheet, notifications), read
coalescing, and startup priority sequencing reset; persisted snapshot emptied.
Result — proven behaviorally: **B cannot read A's cached leads, users, or
notifications** (fresh scope starts empty until B's own API reads land), and a
logged-out browser neither reads nor persists business data.

## 9. Offline / network-failure policy

- **Reads:** fall back to the current user's scoped cache **only** for status `0`
  (transport failure) or `>=500` (server/DB unavailable) — `offlinePolicy.shouldFallBackToCache`.
- **401 / 403 / 404 (and every 4xx): authoritative server answers — always
  rethrown, never masked by cached business data.** A 401 cannot "succeed" with
  cached leads; a 403 cannot "succeed" with data the scope hid; a 404 cannot
  resurrect a deleted/foreign record. 401 for the active token additionally ends
  the session (`http.ts`).
- **Writes:** no offline policy exists — every mutation goes to the API and a
  failed write throws; no local cache ever reports a false success.
- **Permission/role failures fail closed:** `hasPermissionCode` DB error → 503
  deny; missing permission definition → deny; visibility DB error → `Own`.
- **DB outage in production:** requests fail 403/503; the in-memory demo store is
  provably untouched (H1); demo mode cannot be enabled in production (no
  `DATABASE_URL` → 503).

## 10. Production fallback policy (summary)

Production is either fully DB-backed or refuses to serve (503). The only offline
surface is the browser's read-only, per-user, logout-cleared cache, reachable only
after a genuine "no answer" (0/5xx) and only within the user's own prior scope.
Everything else — auth, authorization, visibility, mutation persistence — is
server truth.

## 11. Files changed

- `server/routes/production.routes.ts` — G1 audit-logs gate; G2 lead-scoped
  notification visibility; G3 cross-user notification gate.
- `src/services/localDb.ts` — G4 per-user scoping + fail-safe +
  `setLocalDbUserIdProvider` / `clearUserCaches` / `clearLegacyGlobalCaches` /
  `saveNotifications`.
- `src/modules/auth/store/authStore.ts` — G5 logout cleanup + user-id provider.
- `src/modules/notifications/services/notificationService.ts` — G6 scoped writes +
  shared offline policy.
- `src/layouts/featureRouteAccess.ts` — new (G7 registry + pure decision).
- `src/modules/auth/components/FeatureGate.tsx` — new (G7 route gate).
- `src/App.tsx` — G7: 18 page routes wrapped.
- `src/modules/shared/api/offlinePolicy.ts` — new (G8 shared rule).
- 8 read services (`adminService`, `formBuilderService`, `orgService`,
  `leadService`, `metadataService`, `notificationService`, `userService`,
  `workflowService`) — G8: inline fallback conditions replaced by the helper.
- Tests: `server/tests/rbac-fallback-safety-audit.test.ts` (new, 20),
  `server/tests/local-cache-cross-user-isolation.test.ts` (new, 9),
  `server/tests/feature-route-access.test.ts` (new, 7); updated
  `server/tests/perf-phase2-source-guards.test.ts` (C: 18 wrapped routes) and
  `server/tests/lead-hardening.test.ts` (shared fallback helper assertion).

## 12. Test evidence (32 required proofs)

| # | Required proof | Where proven |
|---|----------------|--------------|
| 1 | Every mounted mutation route has the expected guard | `rbac-fallback-safety-audit` A1 (~35-route fail-closed matrix) |
| 2 | Feature Access cannot grant an API action | A1 (ungranted matrix) + B1 (full menuAccess, zero grants → all mutations 403) |
| 3 | Action Permissions cannot widen Data Visibility | C1 (full `leads.*` + Own → own-only; foreign 404/403), C2 (params narrow only) |
| 4 | Disabled Feature Access blocks the page route | `feature-route-access` (explicit false → deny; `/leads/:id` inherits) + App.tsx lockstep guard |
| 5 | Admin bypass consistent | D1/D2 (ADMIN & SUPERADMIN: audit, matrix, reset — with zero stored grants) |
| 6 | Own isolated | E1 |
| 7 | DownTeam recursive hierarchy | E2 |
| 8 | FullTeam department-scoped | E3 |
| 9 | Organization correct | E4 |
| 10 | Lead Quality doesn't widen | F1 (own 200 / foreign 404), F2 (dashboard quality scoped) |
| 11–13 | 401/403/404 never fall back to cached leads/detail | `local-cache` offlinePolicy table (4xx → no fallback) + service source guards (4xx rethrow) + H2 (404/403 semantics) |
| 14 | Network/5xx write never succeeds locally | H1 (outage writes 403/503, never 2xx) + `lead-hardening` API-first |
| 15 | localDb never authoritative | H1 (fallbackStore untouched) + `local-cache` (writes no-op unscoped; reads only own scope) |
| 16 | Logout clears session-sensitive caches | `local-cache` logout test |
| 17 | B cannot read A's cached leads | `local-cache` scoping test |
| 18 | B cannot inherit A's notifications | `local-cache` scoping + logout tests |
| 19 | Role/permission caches don't cross users | `roles:<uid>` sessionCache per-user + cleared on logout (source guard + logout test); `lf_local_*` org-wide reference, server re-authorizes (documented §7) |
| 20 | Coalescing/startup/session caches reset | `local-cache` logout test (`clearCoalescing`, `resetStartupPriority`, `clearSessionCache`) |
| 21 | DB outage cannot enable demo persistence | H1 |
| 22 | Forced-password server truth | `auth-session` suite (green) + `change-required-password` caller-only/409 design |
| 23 | Lead Pool assignment perms | A1 (`/leads/all` mutations admin-only; reads require `leads.view` per matrix) |
| 24 | Bulk User Import perms | A1 (`bulk/commit` 403 without `users.create`/`users.edit`) |
| 25 | Scheduled-activity mutation perm | A1 (scheduled-activities matrix: `leads.edit`/`leads.assign`) |
| 26 | Campaign purge admin-only | A1 + D3 |
| 27 | Clear-all admin-only | A1 + D3 |
| 28 | Password reset admin-only | A1 + D1 |
| 29–32 | PR #38/#39/#37 + auth/session tests stay green | full `npm test -- --run` suite (all pre-existing suites green) |

## 13. Accepted risks

1. **Org-wide reference caches** (`lf_local_roles_permissions`, `lf_local_teams`,
   `lf_local_fine_permissions`, `shanta_options`) are not user-scoped. They contain
   no per-user secrets and are never authority: every request is re-authorized
   server-side, and the role editor surfaces require `requireAdmin` /
   `permissions.manage`. Scoping them would only duplicate bytes.
2. **FeatureGate is a visibility gate, not the security boundary.** A client that
   skips the gate (direct API call, devtools) is still fully enforced by the
   server (Layers A + C). This is the established design.
3. **Offline read fallback (0/5xx)** may serve the current user's previously
   visible data when the server is down. That data was previously authorized to
   this user and is refreshed on every successful read; per the audit directive,
   where scoped offline reads can't be guaranteed we fail safe (fail closed)
   rather than serve potentially unauthorized data.
4. **SUPERADMIN sidebar parity:** the sidebar's static lists predate SUPERADMIN;
   the route gate intentionally bypasses SUPERADMIN (server parity). The sidebar
   still honors explicit `menuAccess` for SUPERADMIN roles.

## 14. Deferred follow-up (out of scope by directive)

1. User-scoping of the org-wide reference caches if a future requirement stores
   per-user secrets in them (none today).
2. Server-side audit of the legacy unmounted `client/` tree (out of scope — not
   built/served; Vite builds `src/` only).
3. A server-side "session generation" token to harden in-flight coalescing across
   logout (client-side reset currently covers the single-browser case; the server
   remains authoritative regardless).
4. Optional: move the `options` reference cache under an org-scoped key if option
   lists ever become role-differentiated (they are currently identical for all
   authenticated users).
