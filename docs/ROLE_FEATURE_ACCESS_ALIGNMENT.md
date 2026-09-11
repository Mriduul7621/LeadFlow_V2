# Role Feature Access Alignment

This document records how the **Role Feature Access** administration UI
(the "Roles & Access" tab under **Users → User Management**) is aligned with
the live application sidebar, routes, Dashboard, and Daily Workbench.

- Editor: `src/modules/users/pages/UserManagement.tsx` (`APP_FEATURES` + `handleSaveRole`)
- Role defaults / reconciliation: `src/modules/admin/services/adminService.ts`
- Sidebar source of truth: `src/layouts/AppLayout.tsx`
- Live route source of truth: `src/App.tsx`

---

## Canonical sidebar & routes

The sidebar (`src/layouts/AppLayout.tsx`) is the authority for which screens
exist and what they are called:

| Section | Visible label | Route |
| --- | --- | --- |
| Overview | Dashboard | `/` |
| My Work | Daily Workbench | `/workbench` |
| My Work | Activities | `/activities` |
| My Work | Task Calendar | `/task-calendar` |
| My Work | Follow-up Queue | `/follow-up` |
| Leads | Lead Tracking | `/leads` |
| Leads | Add New Lead | `/leads/new` |
| Leads | Bulk Upload | `/leads/upload` |
| Leads | All Leads | `/leads/all` |
| Insights | Performance | `/execution-intelligence` |
| Insights | NCP Progress | `/ncp-progress` |
| Insights | Trends | `/trend-charts` |
| Insights | Campaigns | `/campaign-breakdown` |
| Management | Team | `/team` |
| Management | Users | `/users` |
| System | Settings | `/settings` |

---

## Feature Access → sidebar mapping

Internal permission keys are **preserved** (they are the storage contract);
only the visible labels were updated to match the current sidebar names.

| Visible label | Internal key | Route | Enforcement | Status |
| --- | --- | --- | --- | --- |
| Dashboard | `dashboard` | `/` | `menuAccess['/']` | Aligned (single view flag) |
| Daily Workbench | `workbench` | `/workbench` | `menuAccess['/workbench']` | **Added** |
| Activities | `activities` | `/activities` | `menuAccess['/activities']` | Aligned |
| Task Calendar | `task_calendar` | `/task-calendar` | `menuAccess['/task-calendar']` | Aligned |
| Follow-up Queue | `follow_up_strategy` | `/follow-up` | `menuAccess['/follow-up']` | Renamed |
| Lead Tracking | `lead_tracking` | `/leads` | `menuAccess['/leads']` | Aligned |
| Add New Lead | `lead_generate` | `/leads/new` | `menuAccess['/leads/new']` | Renamed |
| Bulk Upload | `lead_upload` | `/leads/upload` | `menuAccess['/leads/upload']` | Aligned |
| All Leads | `lead_tracking.view_all_leads_tab` | `/leads/all` | `menuAccess['/leads/all']` | Renamed (sub-option) |
| Performance | `execution_intelligence` | `/execution-intelligence` | `menuAccess['/execution-intelligence']` | Renamed |
| NCP Progress | `ncp_progress` | `/ncp-progress` | `menuAccess['/ncp-progress']` | Aligned |
| Trends | `trend_charts` | `/trend-charts` | `menuAccess['/trend-charts']` | Renamed |
| Campaigns | `campaign_breakdown` | `/campaign-breakdown` | `menuAccess['/campaign-breakdown']` | Renamed |
| Team | `team_progress` | `/team` | `menuAccess['/team']` | Renamed |
| Users | `user_management` | `/users` | `menuAccess['/users']` | Renamed |
| Settings | `settings_control` | `/settings` | `menuAccess['/settings']` | Aligned |

---

## Changes made

### 1. Removed unenforced dashboard child toggles

The previous editor exposed nine fine-grained "dashboard section" toggles:

`view_calls_stats`, `view_pipeline_ncp`, `view_division_table`,
`view_ncp_chart`, `view_trend_chart`, `view_campaign_pie`,
`view_critical_alerts`, `view_agent_table`, `view_task_calendar`.

These were only enforced by the legacy, unmounted `src/pages/Dashboard.tsx`.
The live route (`/`) mounts `src/modules/dashboard/pages/Dashboard.tsx`, which
does **not** read those keys. They were therefore dead controls and were
removed from both the editor (`APP_FEATURES`) and the role defaults
(`adminService.ts` `ensureFeaturePermissions`), leaving a single Dashboard
`view` flag.

### 2. Added Daily Workbench

A new `workbench` feature maps to `/workbench`. Its `view` flag drives
`menuAccess['/workbench']`. It defaults **fail-closed** (`workbench: { view: false }`)
so existing custom/restricted roles do **not** silently gain the new feature —
an admin must grant `/workbench` explicitly. `ADMIN` / `SUPERADMIN` retain
full access via the explicit bypass.

### 3. Renamed legacy labels (internal keys preserved)

| Legacy label | Current label |
| --- | --- |
| Lead Generation | Add New Lead |
| Execution Intelligence | Performance |
| Trend Charts | Trends |
| Campaign Breakdown | Campaigns |
| Follow-up Strategy | Follow-up Queue |
| Team Progress | Team |
| User Management | Users |
| All Leads Tab | All Leads |
| Sync Settings | System Connection |

`view_sync` was relabeled to **System Connection** because it only gates the
cloud database connection-status check; it does not perform data
synchronization.

### 4. Preserved leads.edit for Workbench mutations

Daily Workbench mutation capability (Complete / Cancel / Edit / Reschedule)
continues to gate on `canAccess('lead_tracking', 'edit')`, which maps to the
server permission code `leads.edit` (final authorization boundary in
`server/routes/production.routes.ts` via `hasPermissionCode`). The new
`workbench` feature controls **menu/route access only** and does not affect
mutation authorization. "Open Lead" remains outside the edit guard (visibility
permits it independently).

### 5. Preserved data visibility scopes

The Data Visibility selector (`Own` / `DownTeam` / `FullTeam` /
`Organization`) is unchanged and maps to `roles.data_visibility`
(`server/authz.ts` resolves it). Menu access and data visibility are
deliberately independent: enabling a route never broadens the server-side
data scope.

---

## Action permissions (granular, server-enforced)

In addition to feature/menu visibility, the editor exposes the canonical
**action permission** model so Admin can independently grant or revoke what a
role can *do* inside the modules it can *see*.

These are **three independent layers**:

| Layer | What it controls | Persisted where | Enforced by |
| --- | --- | --- | --- |
| A. Feature / menu visibility | which routes are visible | `roles.menu_access` (JSONB) | `resolveMenuVisibility` (client) |
| B. Action permissions | what the user can do inside a route | `role_permissions` (canonical) | `hasPermissionCode` (server) |
| C. Data visibility | Own / DownTeam / FullTeam / Organization | `roles.data_visibility` | `server/authz.ts` |

Granting menu access never broadens data visibility, and granting `View`
never grants `Edit`/`Delete` (and vice-versa).

### Module / action matrix

| Module | View | Create | Edit | Delete | Assign | Transfer | Import | Export | Canonical code |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dashboard | ✅ | — | — | — | — | — | — | — | `dashboard.view` |
| Leads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | `leads.view/create/edit/delete/assign/transfer/import/export` |

Each cell is an independent toggle. A configuration such as
`View ✅, Create ✅, Edit ❌, Delete ❌, Assign ✅, Transfer ❌, Import ❌, Export ✅`
is a valid role configuration.

### Canonical code → UI behavior mapping

| Canonical code | Gates (client) | Server enforcement |
| --- | --- | --- |
| `leads.view` | Lead Tracking / All Leads directory | `hasPermissionCode(caller, 'leads.view')` |
| `leads.create` | Add New Lead | `hasPermissionCode(caller, 'leads.create')` |
| `leads.edit` | Lead status update + Daily Workbench Complete/Edit/Cancel/Reschedule | `hasPermissionCode(caller, 'leads.edit')` |
| `leads.delete` | All Leads delete | `hasPermissionCode(caller, 'leads.delete')` |
| `leads.assign` | Assign / reassign ownership | `hasPermissionCode(caller, 'leads.assign')` |
| `leads.transfer` | Transfer ownership | `hasPermissionCode(caller, 'leads.transfer')` |
| `leads.import` | Bulk Upload | `hasPermissionCode(caller, 'leads.import')` |
| `leads.export` | Export audit logs | client gate (`all_leads.export_raw_xlsx`) — no server export endpoint exists |
| `dashboard.view` | Dashboard | `hasPermissionCode(caller, 'dashboard.view')` |

> `leads.export` is a canonical code (migration `025_permissions`) and is
> exposed and persisted for Admin to grant/revoke, but its only current
> consumer is a client-side audit-log CSV download — there is no server
> export endpoint yet. Hiding the button is **not** the security boundary;
> the server remains the boundary for every action that has a server endpoint.

The client maps legacy compound action keys to these canonical codes in
`usePermissions` (`upload_raw_csv_xlsx → import`, `delete_destroy_leads → delete`,
`reassign_global_leads → assign`, `export_raw_xlsx → export`, etc.) so the
granular role grants actually gate the existing UI buttons.

### DB-backed persistence

Every role permission change is persisted to PostgreSQL, **not** to
localStorage (the localStorage role copy is a read-through cache only):

- `GET /api/roles/:roleId/permissions` — lists every canonical code with its
  effective allowance.
- `PUT /api/roles/:roleId/permissions` — upserts grants into `role_permissions`
  (`role_id`, `permission_id`, `is_allowed`). Unknown codes are ignored, so a
  forged payload can never mint a permission (fail closed).
- `hasPermissionCode()` reads the same `role_permissions` rows, so the server
  authorization boundary and the editor operate on one source of truth.
- A page reload / session restart re-reads the persisted rows — nothing is
  reconstructed from client state.

Exact DB fields:

| Table | Fields |
| --- | --- |
| `permissions` | `permission_code`, `module_name`, `action_name`, `is_active` |
| `role_permissions` | `role_id` → `roles.id`, `permission_id` → `permissions.id`, `is_allowed` |
| `roles` | `menu_access` (JSONB), `data_visibility`, `actions` (JSONB), `feature_permissions` (JSONB) |

### Admin behavior

- `ADMIN` / `SUPERADMIN` bypass every `hasPermissionCode` check and see every
  sidebar item regardless of stored grants.
- Role permission **writes** are `requireAdmin`-gated.
- `GET /roles/:roleId/permissions` is read for any authenticated admin editing
  a role.

---

## Backward compatibility

- All existing internal permission keys are unchanged, so previously saved
  `roles.feature_permissions` / `menu_access` blobs remain valid.
- `ensureFeaturePermissions` reconciles roles that predate this change by
  merging the `workbench` default on read; roles edited and saved through the
  new editor now persist `menuAccess['/workbench']` explicitly.
- `All Leads` remains a sub-option of `lead_tracking`
  (`view_all_leads_tab`), preserving the existing
  `menuAccess['/leads/all']` semantics and the in-page capability check
  (`canAccess('all_leads', ...)`, mapped to `lead_tracking`).

---

## Regression coverage

- `server/tests/role-feature-access-alignment.test.ts` — source guards:
  dead dashboard toggles removed, Daily Workbench added + routed + fail-closed,
  labels renamed with keys preserved, the canonical action matrix exposed and
  independently toggled, `leads.edit` workbench mutation boundary, data
  visibility scopes, and this document's existence.
- `server/tests/role-action-permissions-integration.test.ts` — DB-backed
  (PGlite) checks that `PUT /roles/:roleId/permissions` persists to
  `role_permissions`, `GET` reads them back, `hasPermissionCode` reflects them,
  actions are independent (revoke Edit ≠ revoke View; grant View ≠ grant Edit),
  unknown/malformed codes fail closed, writes are admin-gated, and ADMIN keeps
  its bypass.
