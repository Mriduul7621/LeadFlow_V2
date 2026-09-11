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
`menuAccess['/workbench']`. `adminService.ts` seeds `workbench: { view: true }`
for the Admin default role and reconciles it for custom roles.

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

Source-guard tests live in `server/tests/role-feature-access-alignment.test.ts`
and assert the items above (dead dashboard toggles removed, Daily Workbench
added and routed, labels renamed with keys preserved, `leads.edit` workbench
mutation boundary, data visibility scopes, and this document's existence).
