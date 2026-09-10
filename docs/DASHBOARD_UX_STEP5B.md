# Dashboard UI/UX + Sidebar + Role Access Alignment (Step 5B)

## Overview

Step 5B is a **visual/navigation reorganization only**. It does not change:

- the PostgreSQL/Supabase schema,
- the `GET /api/dashboard` / `GET /api/leads/follow-ups` contracts or their
  server-side visibility resolution (Own / DownTeam / FullTeam / Organization),
- soft-delete exclusion or Asia/Dhaka business-day authority,
- the existing `RolePermission` / `menuAccess` / `featurePermissions`
  authorization model in `AppLayout.tsx`, `usePermissions.ts`, and
  `adminService.ts`.

Everything in this document builds strictly on top of Step 4A/4B/5's
server-authoritative dashboard metrics and follow-up queue semantics.

## 1. Dashboard section hierarchy

`src/modules/dashboard/pages/Dashboard.tsx` renders, top to bottom:

1. **Header** — title, period selector (`TODAY` / `THIS MONTH` / `LAST MONTH`
   / `CUSTOM`), date/custom-range inputs, and an explicit **Refresh** button
   that re-calls `loadDashboardData()`. No team/employee/campaign filter is
   shown because none of those are backed by real server-side dashboard
   filtering in this PR — adding a fake one was explicitly out of scope.
2. **Primary KPI row** — Total Leads, Untouched, Due Today, Overdue,
   Converted. Bound 1:1 to `metrics.totalLeads`, `metrics.statusCounts.Untouched`,
   `metrics.followUpCounts.today`, `metrics.followUpCounts.overdue`,
   `metrics.converted`.
3. **Secondary KPI row** — Projected NCP, Collected NCP, Conversion Rate,
   Active Leads / Pipeline Locked. `avgResponseTAT` is **not** shown here as a
   headline KPI; it remains available lower on the page (Financial section)
   and always renders `'N/A'` when the server returns `null` — it is never
   coerced to a fabricated default (e.g. `'24.0h'`).
4. **Sales Pipeline** — canonical `current_status` sequence (`Untouched →
   Contacted → Interested → Meeting Fixed → Meeting Completed → Pipeline
   Locked → Converted`), each stage rendering `metrics.statusCounts[stage]`
   plus an optional `% of visible total`. No per-stage NCP is fabricated.
5. **Daily Execution** — two columns:
   - **Left: Today & Tomorrow Activity.** Reuses the exact same
     `leadService.getLeads()` + `activityEngine.buildActivities/groupByCategory`
     pipeline as the standalone `/activities` page, filtered to the `Today`
     and `Tomorrow` categories. This is a **read-only convenience list**, not
     an authoritative KPI source — it never feeds `stats`/`statusCounts`/etc.
     Building a new `scheduled_activities` backend concept was explicitly
     deferred to Step 5C; this section only consumes fields that already
     exist on `Lead` (`nextCallDate`, `meetingDate`, `nextFollowUpDate`).
   - **Right: Calendar.** The existing `<TaskCalendar embedded={true} />` is
     reused unmodified (same component backing the standalone `/task-calendar`
     route).
6. **Follow-up Health** — three cards (Overdue / Due Today / Upcoming) bound to
   `metrics.followUpCounts` (same Step 4B/5 authoritative bucket counts used
   by `GET /api/leads/follow-ups`). Each card deep-links to
   `/follow-up?bucket=overdue|today|upcoming`.
7. **Needs Attention** — only two entries, both derived from fields the server
   already returns: Untouched Leads (`statusCounts.Untouched`) and Overdue
   Follow-ups (`followUpCounts.overdue`), each linking into the relevant
   filtered view. The section explicitly states *"Additional attention rules
   coming in a later phase"* rather than fabricating untouched>24h,
   overdue>3days, inactive-pipeline, or no-next-action scoring logic — none of
   that is implemented in this PR.
8. **Financial Extraction & Target Tracking**, **Team Performance** (per-team
   `teamStats` table, still empty per Step 5's intentional deferral — "Team
   performance unavailable — canonical team metrics are not published yet"),
   **Campaign Trend Chart** (`trendData`, still "No trend data available" per
   Step 5), **Lead Status Distribution**, and **Executive Performance**
   (agent-level table) are all preserved from Step 5 with **no metric
   changes** — only the "Campaign Performance Intelligence" pie/legend was
   relabeled to **Lead Status Distribution**, because `campaignStats` is
   actually a canonical status breakdown (`server/routes/production.routes.ts`
   builds it from `statusCounts`), not real per-campaign attribution.

None of the above sections were removed; all existing `canAccess('dashboard',
…)` guards (`view_task_calendar`, `view_division_table`, `view_ncp_chart`,
`view_trend_chart`, `view_campaign_pie`, `view_agent_table`, etc.) are
preserved verbatim.

## 2. Sidebar grouping

`src/layouts/AppLayout.tsx` now partitions the existing `menuItems` array into
six labeled groups, in this order:

| Group | Items (path) |
| --- | --- |
| OVERVIEW | Dashboard (`/`) |
| MY WORK | Activities (`/activities`), Task Calendar (`/task-calendar`), Follow-up Queue (`/follow-up`) |
| LEADS | Lead Tracking (`/leads`), Add New Lead (`/leads/new`), Bulk Upload (`/leads/upload`), All Leads (`/leads/all`) |
| INSIGHTS | Performance (`/execution-intelligence`), NCP Progress (`/ncp-progress`), Trends (`/trend-charts`), Campaigns (`/campaign-breakdown`) |
| MANAGEMENT | Team (`/team`), Users (`/users`) |
| SYSTEM | Settings (`/settings`) |

Every path above already existed and is already routed (see `src/App.tsx`)
and already wrapped in `<ProtectedRoute>`. **No Pipeline entry is added** —
there is no dedicated `/pipeline` route, and inventing one was explicitly out
of scope.

Grouping is implemented as a pure post-filter step:

```
const filteredMenu = menuItems.filter(item => { ...unchanged admin/menuAccess/role logic... });
const groupedMenu = groupMenuItems(filteredMenu); // groups an already-authorized list
```

`groupMenuItems()` only partitions `filteredMenu` by each item's static
`group` field and drops empty sections — it never reads `roles` or
`menuAccess` itself. If a role loses access to every item in a group, that
whole section simply disappears; grouping cannot grant or deny anything by
itself.

Both desktop and mobile nav render `groupedMenu` with uppercase section
headings (translated via `navSectionOverview` / `navSectionMyWork` / … in
`translations.ts`) and preserve the existing collapse/expand + mobile overlay
behavior. Mobile nav additionally scrolls (`overflow-y-auto
max-h-[calc(100vh-6rem)]`) so the longer grouped list stays usable on small
screens.

## 3. Route mapping (sidebar path → page component)

| Path | Component | Notes |
| --- | --- | --- |
| `/` | `Dashboard` | restructured in this PR |
| `/activities` | `Activities` | unmodified |
| `/task-calendar` | `TaskCalendar` | unmodified |
| `/follow-up` | `FollowUpStrategy` | now supports `?bucket=overdue\|today\|upcoming` deep-linking from the Dashboard's Follow-up Health cards |
| `/leads` | `LeadList` | unmodified |
| `/leads/new` | `LeadGenerate` | unmodified |
| `/leads/upload` | `LeadUpload` | unmodified |
| `/leads/all` | `AllLeads` | unmodified |
| `/execution-intelligence` | `ExecutionIntelligence` | unmodified |
| `/ncp-progress` | `NcpProgress` | unmodified |
| `/trend-charts` | `TrendCharts` | unmodified |
| `/campaign-breakdown` | `CampaignBreakdown` | unmodified |
| `/team` | `TeamHierarchy` | unmodified |
| `/users` | `UserManagement` | Role Configure UI updated (see below) |
| `/settings` | `Settings` | unmodified |

All of the above are declared in `src/App.tsx` and every one is wrapped in
`<ProtectedRoute>`, which itself only gates `isInitialized` /
`isAuthenticated` — it does not implement or bypass per-route authorization.

## 4. Permission mapping

No new authorization model was introduced. This PR only **extends** the
existing maps so every sidebar route (including the pre-existing `/activities`
route, which previously had no Role Configure UI entry) can be explicitly
enabled or disabled per role:

- `src/modules/users/pages/UserManagement.tsx` (`APP_FEATURES`):
  added an `activities` feature entry ("Activities (My Work)") and wired
  `'/activities': roleFormFeatures?.activities?.view ?? false` into
  `handleSaveRole`'s `menuAccess` payload. The `follow_up_strategy` feature
  label was updated to "Follow-up Queue" to match the renamed sidebar entry
  (the underlying feature key and permission wiring are unchanged).
- `src/modules/admin/services/adminService.ts`:
  - `DEFAULT_ROLE_PERMISSIONS` (ADMIN default) now includes
    `'/activities': true`.
  - `FINE_PERMISSION_MODULES` now includes `'activities'`.
  - `ensureFeaturePermissions()` (the reverse `menuAccess` → `featurePermissions`
    mapper used when a role has menu access but no fine-grained
    `featurePermissions` yet) now defaults `activities: { view: true }` and
    maps the `activities` feature to the `/activities` route.

`AppLayout.tsx`'s `filteredMenu` computation — admin always sees everything,
then `matchedPermission.menuAccess[path]` override, then static `roles`
fallback — is completely untouched. The new grouping (`groupedMenu`) is
computed strictly after that filter, so it cannot widen or narrow what any
role can already reach.

## 5. Intentionally deferred items (not implemented in this PR)

Per the Step 5B/5C boundary and the "no fake metrics" rule, the following are
explicitly **out of scope** here and should not be inferred as implemented:

- A `scheduled_activities` backend/table — the Daily Execution section
  continues to derive Today/Tomorrow items from existing `Lead` date fields
  only (same approach as `/activities`).
- A real trend-data endpoint — `trendData` stays `[]` and the UI shows
  "No trend data available" (unchanged from Step 5).
- Canonical team performance (`teamStats`) — remains `[]` with an explicit
  "Team performance unavailable" message; no area→team fake mapping was added.
- Advanced "Needs Attention" scoring (untouched > 24h, overdue > 3 days,
  inactive pipeline, no-next-action scoring) — the section shows only the two
  authoritative counts it already has, plus the placeholder text "Additional
  attention rules coming in a later phase."
- Lead scoring / prioritization models — not part of this PR.
- Real per-campaign attribution — the "Campaign Performance" pie was honestly
  relabeled to "Lead Status Distribution" instead of being backed by fake
  campaign data, since the underlying `campaignStats` payload is actually a
  status breakdown.

## 6. Tests

`server/tests/dashboard-ux-step5b.test.ts` adds static content assertions
(A–M) covering: server-authoritative KPI/pipeline/follow-up consumption, no
fabricated `avgResponseTAT`/trend/team data, honest Lead Status Distribution
labeling, Daily Execution reusing `TaskCalendar` + the existing
`leadService.getLeads()`/`activityEngine` pipeline (never as a KPI source),
Follow-up Health deep-linking, the Needs Attention placeholder text, sidebar
grouping using only the approved static path list (no invented `/pipeline`
route), every sidebar path resolving to a real `ProtectedRoute`-wrapped page,
`groupMenuItems()` never re-implementing authorization, and Role Configure UI
/ `adminService` coverage for the `/activities` route. All prior Step
4A/4B/5 dashboard and follow-up queue tests (`dashboard-metrics-integration.test.ts`,
`lead-followup-queue-integration.test.ts`, etc.) remain green and unmodified.

Run before merging:

```
npm test -- --run
npx tsc --noEmit
npx vite build
npm run build
npm run verify:serverless
```
