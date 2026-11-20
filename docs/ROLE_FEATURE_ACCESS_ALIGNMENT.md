# Role Feature Access Alignment

This document records how the **Role Feature Access** administration UI
(the "Roles & Access" tab under **Users & Roles**) is aligned with the
live enterprise workspace navigation (sidebar groups, page titles),
routes, and Daily Workbench.

- Editor: `src/modules/users/pages/UserManagement.tsx` (`APP_FEATURES` + `handleSaveRole`)
- Role defaults / reconciliation: `src/modules/admin/services/adminService.ts`
- Navigation source: `src/layouts/enterpriseNav.ts` (sidebar labels + `FALLBACK_LABELS` page titles)
- Live route source of truth: `src/App.tsx`

---

## Canonical navigation & routes

The enterprise workspace sidebar has one **WORKSPACE** group per role
(Admin adds **CONFIGURATION** and **ADMINISTRATION** groups), a profile
block with a settings gear, and a Help/About footer. Notifications live
behind the topbar bell. Pages below marked "URL only" have no sidebar
item; their routes stay live.

| Navigation group | Visible label | Route |
| --- | --- | --- |
| Workspace | My Work / Team Overview | `/` |
| Workspace | My Leads / Team Leads / All Leads | `/leads` |
| Workspace | Add Lead | `/leads/new` |
| Workspace | Lead Intake | `/leads/upload` |
| Workspace | Lead Pool | `/leads/all` |
| Workspace | Follow-up Queue / Follow-up Monitor | `/follow-up` |
| Workspace | Team Members | `/team` |
| Workspace | My Performance / Team Performance | `/execution-intelligence` |
| Workspace | Task Calendar | `/task-calendar` |
| Workspace | Roadshow | `/roadshows` |
| Workspace | Activities | `/activities` |
| Workspace (Agent bottom bar + URL) | Daily Workbench | `/workbench` |
| URL only | NCP Progress | `/ncp-progress` |
| URL only | Trends & Reports | `/trend-charts` |
| URL only | Campaigns | `/campaign-breakdown` |
| Workspace (Admin) | Users & Roles | `/users` |
| Profile gear | Profile & Settings | `/settings` |
| Topbar bell | Notifications | `/notifications` |
| Sidebar footer | Help | `/help` |
| Sidebar footer | About | `/about` |
| Configuration (Admin) | Status & Pipeline / Products & Campaigns / System Settings | `/settings/status-pipeline`, `/settings/products-campaigns`, `/settings/system` |
| Administration (Admin) | Administration | `/administration` |

---

## Feature Access → navigation mapping

Internal permission keys are **preserved** (they are the storage contract);
the feature groups and visible labels match the current navigation structure.

| Visible label | Navigation group | Internal key | Route | Enforcement |
| --- | --- | --- | --- | --- |
| My Work / Team Overview | Workspace | `dashboard` | `/` | `menuAccess['/']` |
| My Leads / Team Leads / All Leads | Workspace | `lead_tracking` | `/leads` | `menuAccess['/leads']` |
| Add Lead | Workspace | `lead_generate` | `/leads/new` | `menuAccess['/leads/new']` |
| Lead Intake | Workspace | `lead_upload` | `/leads/upload` | `menuAccess['/leads/upload']` |
| Lead Pool | Workspace | `all_leads` | `/leads/all` | `menuAccess['/leads/all']` |
| Follow-up Queue | Workspace | `follow_up_strategy` | `/follow-up` | `menuAccess['/follow-up']` |
| Team Members | Workspace | `team_progress` | `/team` | `menuAccess['/team']` |
| My Performance / Team Performance | Workspace | `execution_intelligence` | `/execution-intelligence` | `menuAccess['/execution-intelligence']` |
| Task Calendar | Workspace | `task_calendar` | `/task-calendar` | `menuAccess['/task-calendar']` |
| Roadshow | Workspace | `roadshow_follow_up` | `/roadshows` | `menuAccess['/roadshows']` |
| Activities | Workspace | `activities` | `/activities` | `menuAccess['/activities']` |
| Daily Workbench | Workspace | `workbench` | `/workbench` | `menuAccess['/workbench']` |
| NCP Progress | Reports | `ncp_progress` | `/ncp-progress` | `menuAccess['/ncp-progress']` |
| Trends & Reports | Reports | `trend_charts` | `/trend-charts` | `menuAccess['/trend-charts']` |
| Campaigns | Reports | `campaign_breakdown` | `/campaign-breakdown` | `menuAccess['/campaign-breakdown']` |
| Users & Roles | Administration | `user_management` | `/users` | `menuAccess['/users']` |
| Profile & Settings | Administration | `settings_control` | `/settings` | `menuAccess['/settings']` |
| Notifications | More pages | `notifications` | `/notifications` | `menuAccess['/notifications']` |
| Help | More pages | `help_support` | `/help` | `menuAccess['/help']` |
| About | More pages | `about_leadflow` | `/about` | `menuAccess['/about']` |

The Administration directory, System settings, and Performance Diagnostics
remain guarded by the admin route boundary and are not grants for custom
non-admin roles.

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
| Lead Generation | Add Lead |
| Execution Intelligence | My Performance / Team Performance |
| Trend Charts | Trends & Reports |
| Campaign Breakdown | Campaigns |
| Follow-up Strategy | Follow-up Queue |
| Team Progress | Team Members |
| User Management | Users & Roles |
| Lead Pool Tab | Lead Pool |

The labels were renamed again in the 2026-11-20 checklist redesign
(§6) to match the enterprise workspace names; internal keys never change.

Personal Settings is now self-service profile and password management only.
System configuration remains in the admin-only Administration → System
directory and is not exposed as a grant for custom non-admin roles.

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
| `leads.view` | My Leads / Team Leads / All Leads / Lead Pool | `hasPermissionCode(caller, 'leads.view')` |
| `leads.create` | Add Lead | `hasPermissionCode(caller, 'leads.create')` |
| `leads.edit` | Lead status update + Daily Workbench Complete/Edit/Cancel/Reschedule | `hasPermissionCode(caller, 'leads.edit')` |
| `leads.delete` | Lead Pool individual delete | `hasPermissionCode(caller, 'leads.delete')` |
| `leads.assign` | Normal assign / reassign / unassign | `hasPermissionCode(caller, 'leads.assign')`; server also permits this grant for existing-owner transfers |
| `leads.transfer` | Existing-owner transfer alternative | `hasPermissionCode(caller, 'leads.transfer')` on mounted update/import transfer paths; server visibility/target checks remain authoritative |
| `leads.import` | Lead Intake | `hasPermissionCode(caller, 'leads.import')` |
| `leads.export` | Export audit logs | client gate (`all_leads.export_raw_xlsx`) — no server export endpoint exists |
| `dashboard.view` | My Work / Team Overview | `hasPermissionCode(caller, 'dashboard.view')` |

> Campaign purge is not the Lead Pool individual-delete action. The mounted
> `DELETE /leads/campaign/:campaign` route remains `requireAdmin`, so only
> ADMIN/SUPERADMIN can purge a campaign; it does not consult `leads.delete`.
> Feature Access controls page visibility only and cannot weaken this boundary.

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
  primary navigation and More directory item regardless of stored grants.
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
- `Lead Pool` remains the standalone `all_leads` feature key
  (`view_all_leads_tab`), preserving the existing
  `menuAccess['/leads/all']` semantics and the in-page capability check
  (`canAccess('all_leads', ...)`).

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
- `server/tests/role-editor-checklist.test.ts` — the 2026-11-20 checklist
  redesign: full label table, enterpriseNav cross-check, action coverage
  per feature, save-payload equivalence, `reports.view` sync, bypass,
  structure, mobile.

---

## Update — canonical separation (current model)

This document's mapping above is the historical record. The **current**
model separates the three layers and is specified in
[`docs/ROLE_PERMISSION_MODEL.md`](./ROLE_PERMISSION_MODEL.md):

- **Feature Access** is module/page visibility **only**. All action-like
  sub-options (including `view_all_leads_tab`) were removed from the
  editor. `Lead Pool` is now the standalone `all_leads` feature mapping to
  `/leads/all`; on read it is backfilled from the legacy
  `view_all_leads_tab` / `menuAccess['/leads/all']` so existing roles keep
  their effective access.
- **Action Permissions** are the canonical, server-enforced grants
  (`permissions` × `role_permissions`), now covering Users, Roles,
  Departments, Hierarchy & Teams and Settings in addition to Dashboard and
  Leads.
- The legacy sub-option keys are derived from the canonical grants on save
  (compatibility mapping), so older client fallbacks keep working without
  exposing duplicate toggles.
- Daily Workbench mutation boundary is unchanged: complete/edit/cancel/
  reschedule still gate on `canAccess('lead_tracking', 'edit')` →
  `leads.edit` server enforcement.

---

## Update — checklist redesign (2026-11-20)

Mahadi found the old editor unfriendly: the feature names did not match
the app's names, and granting access meant jumping across four sections.
The editor is now **Role Details** (role name/ID + Data Visibility +
Save Role) followed by **one Access Checklist**: enabling a feature
reveals that feature's specific actions inline as checkboxes, right
there. The old separate "Feature Access" and "Action Permissions"
panels are gone; the saved permission model is unchanged
(`handleSaveRole` is untouched — same `menuAccess`, same
`role_permissions` grants, same `dataVisibility`).

The mapping from each action to its checklist home lives in
`FEATURE_ACTION_CODES` (presentation only — the save path still builds
grants from `ACTION_PERMISSION_GROUPS`). Each action appears under
exactly one feature, except `reports.view`, which is shared by the four
report pages and appears under each of them; all four checkboxes read
and write the one underlying grant, so they can never disagree. Turning
a feature off hides its actions but never drops the grants — the editor
shows a counted note and the grants still apply at the API.

Old → new labels (internal keys and routes unchanged):

| Internal key | Old label [group] | New label [group] |
| --- | --- | --- |
| `dashboard` | Dashboard [Primary navigation] | My Work / Team Overview [Workspace] |
| `workbench` | Daily Workbench [Primary navigation] | Daily Workbench [Workspace] |
| `lead_tracking` | Lead Workspace [Primary navigation] | My Leads / Team Leads / All Leads [Workspace] |
| `lead_generate` | Add New Lead [Primary navigation] | Add Lead [Workspace] |
| `lead_upload` | Bulk Upload [Administration] | Lead Intake [Workspace] |
| `all_leads` | Lead Pool [Administration] | Lead Pool [Workspace] |
| `follow_up_strategy` | Follow-up Queue [More → Reports] | Follow-up Queue [Workspace] |
| `team_progress` | Team [More → Reports] | Team Members [Workspace] |
| `execution_intelligence` | Performance [More → Reports] | My Performance / Team Performance [Workspace] |
| `task_calendar` | Task Calendar [More → Reports] | Task Calendar [Workspace] |
| `roadshow_follow_up` | Roadshow Follow-up [More] | Roadshow [Workspace] |
| `activities` | Activities [More → Reports] | Activities [Workspace] |
| `ncp_progress` | NCP Progress [More → Reports] | NCP Progress [Reports] |
| `trend_charts` | Trends [More → Reports] | Trends & Reports [Reports] |
| `campaign_breakdown` | Campaigns [More → Reports] | Campaigns [Reports] |
| `user_management` | Users [Administration] | Users & Roles [Administration] |
| `settings_control` | Settings [More] | Profile & Settings [Administration] |
| `notifications` | Notifications [More] | Notifications [More pages] |
| `help_support` | Help & Support [More] | Help [More pages] |
| `about_leadflow` | About LeadFlow [More] | About [More pages] |
