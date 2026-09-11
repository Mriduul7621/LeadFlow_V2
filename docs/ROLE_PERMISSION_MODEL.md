# Role Permission Model

This document defines the three independent permission layers that govern
what a signed-in user can see and do in LeadFlow, how they are stored, how
they are enforced, and how legacy configuration keeps working.

> Supersedes the mapping notes in `docs/ROLE_FEATURE_ACCESS_ALIGNMENT.md`
> (kept for the label/route history it records).

---

## 1. The three layers

| Layer | Question it answers | Storage | Enforced by |
| --- | --- | --- | --- |
| **A. Data Visibility** | **WHICH records** the role can access | `roles.data_visibility` | `resolveVisibility()` (`server/authz.ts`) on every lead / follow-up / dashboard / scheduled-activity read and write |
| **B. Feature Access** | **WHICH modules/pages** appear for the role | `roles.menu_access` JSONB (+ legacy `roles.feature_permissions` JSONB) | Sidebar via `resolveMenuVisibility()` (`src/layouts/menuVisibility.ts`) and page gates via `usePermissions().canAccess()` |
| **C. Action Permissions** | **WHAT the role can do** inside a module | `permissions` × `role_permissions` (+ `user_permissions` overrides) | `hasPermissionCode()` / `requirePermissionCode()` in `server/routes/production.routes.ts` — always server-side, fail closed |

The layers are independent: enabling a Feature Access toggle never grants an
action, and granting an action never widens the data scope.

---

## 2. Layer A — Data Visibility (unchanged)

Scopes, resolved server-side from the reporting tree (`users.manager_id`):

- `Own` — only the caller's own records (default / least privilege)
- `DownTeam` — the caller plus their reporting subtree
- `FullTeam` — everyone in the caller's department
- `Organization` — everyone (ADMIN/SUPERADMIN always resolve to this)

Query parameters (`role`, `employeeId`, `assignedTo`) can **narrow** the
scope, never widen it. ADMIN/SUPERADMIN bypass scope restrictions.

## 3. Layer B — Feature Access (module/page visibility only)

Feature Access contains **module/page toggles only** — one `view` flag per
sidebar entry. It writes `menuAccess[path]` on save. It deliberately
contains **no action-like child toggles** (those moved to Action
Permissions).

| Section | Module (editor label) | Internal key | Route |
| --- | --- | --- | --- |
| Overview | Dashboard | `dashboard` | `/` |
| My Work | Daily Workbench | `workbench` | `/workbench` |
| My Work | Activities | `activities` | `/activities` |
| My Work | Task Calendar | `task_calendar` | `/task-calendar` |
| My Work | Follow-up Queue | `follow_up_strategy` | `/follow-up` |
| Leads | Lead Tracking | `lead_tracking` | `/leads` |
| Leads | Add New Lead | `lead_generate` | `/leads/new` |
| Leads | Bulk Upload | `lead_upload` | `/leads/upload` |
| Leads | All Leads | `all_leads` | `/leads/all` |
| Insights | Performance | `execution_intelligence` | `/execution-intelligence` |
| Insights | NCP Progress | `ncp_progress` | `/ncp-progress` |
| Insights | Trends | `trend_charts` | `/trend-charts` |
| Insights | Campaigns | `campaign_breakdown` | `/campaign-breakdown` |
| Management | Team | `team_progress` | `/team` |
| Management | Users | `user_management` | `/users` |
| System | Settings | `settings_control` | `/settings` |

Defaults: `workbench` and `all_leads` fail closed for roles without a legacy
signal (an admin grants them explicitly); every other module follows the
role's stored `menuAccess` route map. ADMIN/SUPERADMIN always see everything
(bypass).

## 4. Layer C — Canonical Action Permissions (the canonical permission matrix)

Codes are the canonical catalog seeded by **migration 025** into the
`permissions` table. Grants persist per role in **`role_permissions`**
(migration 026) with per-user overrides in **`user_permissions`**
(migration 027). The Roles & Access editor exposes exactly this matrix;
every code below is enforced server-side on the mounted router.

| Module | Action (editor label) | Code | Server enforcement mapping (mounted routes) |
| --- | --- | --- | --- |
| Dashboard | View | `dashboard.view` | `GET /api/dashboard` (with `leads.view` fallback) |
| Leads | View | `leads.view` | `GET /leads`, `GET /leads/follow-ups`, `GET /leads/:id`, `GET /leads/:id/activities`, `GET /leads/:id/scheduled-activities`, `GET /scheduled-activities*` |
| Leads | Create | `leads.create` | `POST /leads`, `POST /leads/bulk` (with import) |
| Leads | Edit | `leads.edit` | `POST /leads/:id/follow-up`; scheduled activities create/complete/cancel/edit/delete (Task Calendar + Daily Workbench); bulk import row updates |
| Leads | Delete | `leads.delete` | `DELETE /leads/:id` (visibility + ownership still apply) |
| Leads | Assign | `leads.assign` | Assignment targets on lead create / bulk import / reassign / scheduled-activity assignee |
| Leads | Transfer | `leads.transfer` | Cross-scope lead ownership transfer |
| Leads | Import | `leads.import` | `POST /leads/bulk` (bulk upload) |
| Leads | Export | `leads.export` | UI export gating — export is a **client-side download** over visibility-filtered data; no dedicated server export endpoint exists |
| Users | Create | `users.create` | `POST /api/users` |
| Users | Edit | `users.edit` | `PUT /api/users/:id` (employee details, activate/deactivate via status; inline password changes are rejected for non-admin callers) |
| Users | Delete | `users.delete` | `DELETE /api/users/:id` |
| Roles | Manage Roles | `roles.manage` | `POST /api/roles` (create/update), `DELETE /api/roles/:roleId` |
| Roles | Manage User Permission Overrides | `permissions.manage` | `PUT /api/users/:id/permissions` (per-user overrides) |
| Departments | Manage | `departments.manage` | `POST /api/departments`, `DELETE /api/departments/:id` |
| Hierarchy & Teams | Manage Teams | `teams.manage` | `POST /api/teams`, `DELETE /api/teams/:id` |
| Hierarchy & Teams | Manage Reporting Hierarchy | `hierarchy.manage` | `POST /api/hierarchies`, `DELETE /api/hierarchies/:id`, `PUT /api/hierarchy-config` |
| Settings | Manage Parameters | `settings.manage` | `POST/DELETE /api/metadata-types`, `POST /api/options`, `DELETE /api/options/:type/:value`, `POST /api/options/reorder` |
| Settings | Manage Workflow Rules | `workflow.manage` | `POST /api/workflow-rules`, `DELETE /api/workflow-rules/:id` |

**Resolution semantics** (`hasPermissionCode`, unchanged and preserved):

1. `ADMIN` / `SUPERADMIN` → **allow** (explicit bypass).
2. Permission definition missing → **deny** (fail closed).
3. User override row (`user_permissions`) exists → its `is_allowed` wins.
4. Role grant row (`role_permissions`) exists → its `is_allowed`.
5. No rows / DB error → **deny** (fail closed).

**Deliberately not exposed as toggles** (no mounted endpoint needs a distinct
grant, so exposing them would create dead controls):

- `users.view`, `roles.view`, `departments.view`, `teams.view` — the shared
  lookup reads (`GET /users`, `/roles`, `/departments`, `/teams`) are
  authenticated-user infrastructure: assignee pickers, manager selection,
  filter panels, the Team page and Performance page depend on them at every
  level. Module/page "View" is the Feature Access toggle's job. The codes
  remain in the catalog for the identity API.
- `users.activate`, `users.lock` — endpoints live on the unmounted identity
  API; on the mounted API activate/deactivate is part of `users.edit`.
- `users.view`/`departments.view` etc. stay fail-closed (deny) for custom
  roles until a future PR attaches them to narrowed endpoints.
- `campaigns.view`, `products.view`, `reports.view`, `notifications.view` —
  no distinct mounted server action beyond existing gating.

**Still admin-only (`requireAdmin`, no canonical toggle):** the role
permission matrix itself (`GET`/`PUT /api/roles/:roleId/permissions`), the
legacy fine-permission matrix (`POST/DELETE /api/permissions*`),
`DELETE /leads/campaign/:campaign`, `POST /leads/clear-all`, and **admin
password reset** (`POST /api/users/:id/reset-password`, plus the inline
password field on `PUT /api/users/:id`). The migration-025 catalog contains
no dedicated password-reset / credential-management permission and none was
invented — so generic `users.edit` can edit employee details but can never
set another account's password. Granting Feature Access or any action never
reaches these admin-only capabilities.

---

## 5. Legacy compatibility mapping

Old roles stored action-like intent as Feature Access sub-options. The
editor no longer exposes them, but compatibility is preserved:

| Legacy sub-option (stored) | Now derived from | Where kept alive |
| --- | --- | --- |
| `lead_generate.create` ("Create Leads") | `leads.create` grant | `roles.actions.create`, `featurePermissions.lead_generate.create` written on save |
| `lead_upload.upload` ("Upload Excel File") | `leads.import` grant | `roles.actions.upload`, `featurePermissions.lead_upload.upload` |
| `lead_tracking.status_update` ("Update Lead Status") | `leads.edit` grant | `roles.actions.edit`/`approve`, `featurePermissions.lead_tracking.status_update` |
| `lead_upload.delete` ("Delete Campaign Leads") | (admin-only capability; no canonical code) | campaign delete stays `requireAdmin`; `featurePermissions.lead_upload.delete` mirrors `leads.delete` |
| `lead_tracking.view_all_leads_tab` | `all_leads` module toggle, backfilled on read from the stored sub-option or `menuAccess['/leads/all']` | `ensureFeaturePermissions()` legacy backfill |
| `user_management.user_*/role_*/dept_*/hier_*` | canonical `users.*` / `roles.manage` / `permissions.manage` / `departments.manage` / `hierarchy.manage` | no longer written; stored values are ignored (they never had server enforcement for non-admins) |
| `settings_control.view_*` (self-service) | Feature Access `settings_control` module toggle | `usePermissions` `SELF_SERVICE_SETTINGS_KEYS` bypass (see §7) |
| `settings_control.configure_parameters` | `settings.manage` grant | `usePermissions` maps `configure_parameters` / `configure_global_metadata` → `settings.manage` |
| legacy `roles.actions` JSONB `{view,create,edit,delete,approve,upload}` | derived from canonical grants on every save | unchanged consumers |

Other preserved behavior:

- `roles.feature_permissions` and `roles.menu_access` JSONB stay the
  Feature Access storage (menu visibility), untouched in shape.
- `fine_permissions` (migration 036) remains served and admin-gated; it is
  a legacy per-role module matrix, unchanged by this PR.
- `usePermissions().canAccess` still resolves legacy compound action keys
  (`upload_raw_csv_xlsx`, `delete_destroy_leads`, `reassign_global_leads`,
  …) to canonical codes.

## 6. Role migration behavior (no DB migration required)

**No schema or data migration ships with this PR**, because:

- Every exposed code already exists (`permissions` is seeded by migration
  025, re-applied idempotently on boot). No new codes were invented.
- Grant storage (`role_permissions` / `user_permissions`) already exists
  (migrations 026/027) and the role editor already persists there.
- **Nothing is seeded for existing custom roles.** Their grant rows start
  absent → deny, which exactly matches the previous effective behavior
  (those mutations were `requireAdmin`-gated, so non-admins were already
  rejected server-side). No custom role silently gains a newly introduced
  action; capability only appears when an admin explicitly grants it.
- ADMIN/SUPERADMIN keep full behavior via the explicit bypass — migration
  026 also re-seeds allow-all rows for ADMIN on every boot.
- Unknown permission codes in PUT payloads are skipped server-side and
  denied by `hasPermissionCode` (fail closed). Unknown Feature Access keys
  in stored JSONB are preserved but ignored.

## 7. Role editor UX

The role editor presents four numbered sections:

1. **Role Details** — name and role ID.
2. **Data Visibility** — Own / DownTeam / FullTeam / Organization.
3. **Feature Access** — one enable/disable toggle per module (page
   visibility only).
4. **Action Permissions** — the canonical matrix grouped by module.

Helper text in the editor: *"Feature Access controls whether the module is
available. Action Permissions control what the role can do inside it."*

Dependency rule: when every module mapped to an action group is hidden in
Feature Access, the group is dimmed, its checkboxes are disabled
**visually**, and a note states the exact semantics: the role cannot reach
these actions in the UI, the grants stay saved, and they **still apply at
the API** (Feature Access is presentation-level; it never weakens or
removes server-side enforcement). Saved grants are never deleted, and
toggling one action never mutates its siblings. `Edit` never auto-grants
`View`.

## 8. Example roles

**ADMIN / SUPERADMIN** — bypass everywhere. Sees every module, all data
(`Organization`), every action. Role permission matrix editing stays
admin-only.

**Manager (e.g. `MANAGER`, DownTeam)** — typical grants:

- Feature Access: Dashboard, Daily Workbench, Activities, Task Calendar,
  Follow-up Queue, Lead Tracking, Add New Lead, All Leads, Team.
- Data Visibility: `DownTeam`.
- Actions: `dashboard.view`, `leads.view/create/edit/assign/import/export`;
  typically NOT `leads.delete`, `users.*`, `roles.*`, `settings.manage`.
- Effect: manages the team's pipeline, sees team data, cannot administer
  users/roles/departments even with the Users module visible.

**Relationship Officer / Agent (e.g. `EMPLOYEE`, Own)** — typical grants:

- Feature Access: Dashboard, Daily Workbench, Activities, Task Calendar,
  Follow-up Queue, Lead Tracking, Add New Lead.
- Data Visibility: `Own`.
- Actions: `dashboard.view`, `leads.view/create/edit` (+ optional
  `leads.import` if they upload their own sheets).
- Effect: works their own leads end to end; no assignment, transfer,
  deletion or administration.

## 9. Security notes

- The browser never decides authorization: every protected mutation is
  re-checked server-side (`hasPermissionCode` / `requirePermissionCode`),
  fail closed. UI toggles are cosmetics.
- A non-admin role never gains administration capability from a Feature
  Access toggle — capability comes only from explicit canonical grants.
- Identity fields (caller, assignedBy, createdBy, visibility) are always
  derived from the authenticated session; client-supplied values are
  sanitized (`FORBIDDEN_CUSTOM_KEYS`).
- Lead security boundary unchanged: delete/assign/transfer also require the
  target to be inside the caller's data-visibility scope.
- Admin autonomy guards unchanged: the last active administrator cannot be
  demoted/deactivated; an admin cannot lock themselves out.
- Password changes never ride on `users.edit`. Self-service change
  (`POST /auth/change-password`) is self-or-admin only; admin reset
  (`POST /users/:id/reset-password` and the inline password field on
  `PUT /users/:id`) is `requireAdmin`-only, because the catalog has no
  dedicated password-reset code (none invented).
- Per-user permission overrides require `permissions.manage`; the role
  permission matrix (role-level grants) remains admin-only.
- Partial-failure honesty: if role metadata saves but the canonical grant
  write fails, the editor reports exactly that and stays open.

## 10. Known follow-up work

- **Forced-password (first-login) flow fix** — next separate PR (explicitly
  out of scope here).
- Bulk User Import — out of scope.
- Attach `users.view` / `roles.view` / `departments.view` / `teams.view` /
  `users.activate` / `users.lock` to the mounted API once the shared lookup
  reads get role-scoped variants.
- `leads.export`: consider a server-side export endpoint so the export
  action is enforced where the bytes are produced.
- Introduce a dedicated canonical password-reset / credential-management
  permission (new migration) so the admin reset can move off
  `requireAdmin` onto an explicitly grantable code.
- Audit log reads (`GET /api/audit-logs`) remain authenticated-user on the
  mounted router; `audit.view` exists in the catalog for tightening later.
- Manager Attention / Lead Quality — out of scope.
