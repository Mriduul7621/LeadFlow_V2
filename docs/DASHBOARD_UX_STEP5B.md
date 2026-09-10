# Dashboard UX & Role-Aligned CRM Workspace (Step 5B)

This document describes the Step 5B redesign of the Dashboard and the sidebar
reorganization into a professional CRM / sales-execution workspace, while
strictly preserving the server-authoritative data rules established in
Step 5 (see `docs/DASHBOARD_METRICS.md`).

> PostgreSQL/Supabase remains the single source of truth. No PostgreSQL schema
> change was made in this step, and no `scheduled_activities` entity was added.

---

## 1. Dashboard information architecture

The Dashboard is ordered top-to-bottom as follows:

1. **Header / Controls**
   - Dashboard title and a live description line (server timezone + authority note).
   - Date-range / period selector: `TODAY · THIS MONTH · LAST MONTH · CUSTOM · ALL`.
   - Date picker (shown for `TODAY`) and custom start/end pickers (shown for `CUSTOM`).
   - Refresh action that re-loads metrics (and the Today/Tomorrow activity panel).
   - **No team, employee, or campaign filters** are rendered — none of those are
     server-authoritative today, and non-functional fake filters are forbidden.

2. **Primary KPI row** (server `GET /api/dashboard` only)
   - Total Leads · Untouched · Due Today · Overdue · Converted.
   - `Due Today` / `Overdue` read `followUpCounts.today` / `followUpCounts.overdue`.

3. **Secondary KPI row**
   - Projected NCP · Collected NCP · Conversion Rate · Active Leads.
   - Active Leads carries the pipeline-locked count as its sub-caption.
   - `avgResponseTAT` is never restored — the field stays `null` server-side
     and is not shown at all on the new dashboard.

4. **Sales Pipeline**
   - Canonical stages from existing `current_status` values:
     `Untouched → Contacted → Interested → Meeting Fixed → Meeting Completed → Pipeline Locked → Converted`.
   - Counts come from `statusCounts`; each stage shows count + % of visible total.
   - No per-stage NCP is fabricated (the server does not provide it).

5. **Daily Execution** (two-column)
   - LEFT — *Today & Tomorrow* activity, computed from the existing lead data
     source (`leadService.getLeads()` → `activityEngine.buildActivities()`), the
     same path the Activities page and TaskCalendar use. It is **informational
     drill-down only** and never feeds a KPI. If an activity type has no real
     data, an explicit empty state is shown.
   - RIGHT — the existing **TaskCalendar** embedded component (unchanged, still
     fully interactive).
   - The dedicated `scheduled_activities` backend arrives in **Step 5C**.

6. **Follow-up Health**
   - Overdue · Due Today · Upcoming from `followUpCounts` (Step 4B / Step 5).
   - Each card deep-links to `/follow-up?bucket=overdue|today|upcoming`.
   - Counts are **never** computed from `localStorage`, `localDb`, or client `getLeads()`.

7. **Needs Attention**
   - Only items derivable from authoritative fields today:
     - Untouched leads → `/leads`
     - Overdue follow-ups → `/follow-up?bucket=overdue`
   - Advanced rules (untouched >24h, overdue >3 days, inactive pipeline,
     no-next-action scoring) are **not** implemented and are represented by the
     explicit placeholder *“Additional attention rules coming in a later phase.”*

8. **Trend**
   - Empty state **“No trend data available”** — a real server time-series
     endpoint does not exist yet and no client-generated trend is recreated.

9. **Team Performance**
   - Unavailable empty state — PR #17 intentionally returns `teamStats: []`
     because area text is not a canonical team identity. No area-based fake teams.

10. **Lead Status Distribution**
    - `campaignStats` is actually a status breakdown, so the section is renamed
      **Lead Status Distribution** (it is no longer mislabeled “Campaign Performance”).

### UX rules

- Compact KPI cards, clear visual hierarchy, no oversized typography.
- Responsive at desktop / tablet / mobile widths.
- Loading skeletons while metrics fetch; explicit unavailable / error states
  (with a Retry action) on failure.
- Accessible labels (each KPI is labeled; refresh has a title; pipeline uses
  text + bars, no fake charts or sample numbers).
- Shanta / LeadFlow identity preserved (gold `#978C21`, `#F9F9F4` surface,
  `brand-text` dark text).

---

## 2. Sidebar grouping

The flat menu in `src/layouts/AppLayout.tsx` was replaced with grouped
sections (`menuSections`). Every item keeps its original **path** and its
original **role / `menuAccess`** semantics — grouping is purely visual.

| Section | Items (paths) |
| --- | --- |
| **OVERVIEW** | Dashboard `/` |
| **MY WORK** | Activities `/activities` · Task Calendar `/task-calendar` · Follow-up Queue `/follow-up` |
| **LEADS** | Lead Tracking `/leads` · Add New Lead `/leads/new` · Bulk Upload `/leads/upload` · All Leads `/leads/all` |
| **INSIGHTS** | Performance `/execution-intelligence` · NCP Progress `/ncp-progress` · Trends `/trend-charts` · Campaigns `/campaign-breakdown` |
| **MANAGEMENT** | Team `/team` · Users `/users` |
| **SYSTEM** | Settings `/settings` |

- Section headings are visual only; a section is rendered **only** when at
  least one of its items is visible for the current role.
- No dead links and no invented routes (there is deliberately no “Pipeline”
  route in Step 5B because no page backs it yet).
- Mobile drawer uses the same grouped structure and still closes on navigation.

---

## 3. Route mapping (all routes already exist in `src/App.tsx`)

| Path | Page | Protected |
| --- | --- | --- |
| `/` | Dashboard | ✅ |
| `/activities` | Activities | ✅ |
| `/task-calendar` | Task Calendar | ✅ |
| `/follow-up` | Follow-up Queue (supports `?bucket=`) | ✅ |
| `/leads` | Lead Tracking | ✅ |
| `/leads/new` | Add New Lead | ✅ |
| `/leads/upload` | Bulk Upload | ✅ |
| `/leads/all` | All Leads | ✅ |
| `/leads/:id` | Lead360 | ✅ |
| `/execution-intelligence` | Performance | ✅ |
| `/ncp-progress` | NCP Progress | ✅ |
| `/trend-charts` | Trends | ✅ |
| `/campaign-breakdown` | Campaigns | ✅ |
| `/team` | Team Hierarchy | ✅ |
| `/users` | User Management | ✅ |
| `/settings` | Settings | ✅ |

---

## 4. Permission / menu-access mapping

The grouped sidebar continues to be driven by the **existing** permission
model — no new authorization system was introduced.

- `src/layouts/AppLayout.tsx`
  - `isItemVisible(item)`: ADMIN → always visible; else the dynamic role
    `menuAccess[path]` override wins when configured; else the static
    `item.roles` fallback. `visibleSections` filters sections through the same
    single check.
- `src/modules/shared/hooks/usePermissions.ts`
  - `featurePathMapping` extended with `follow_up_strategy`, `task_calendar`
    and `activities` so `canAccess` keeps aligning menu permissions with routes.
- `src/modules/admin/services/adminService.ts`
  - `FINE_PERMISSION_MODULES` and the default feature-permission matrix now
    include `task_calendar` and `activities`; the route map knows `/activities`.
- `src/modules/users/pages/UserManagement.tsx`
  - The Role Configure UI gained an **Activities** feature entry and maps
    `/activities` into `menuAccess`, so every sidebar route can still be
    enabled/disabled correctly.

Capability permissions (`dashboard.view`, `leads.view`, `leads.create`,
`leads.edit`, …) are preserved. Backend authorization was **not** converted
into UI-only checks; the server routes remain the enforcement point.

---

## 5. Data authority rules (unchanged from Step 5)

- PostgreSQL / Supabase is the source of truth.
- `GET /api/dashboard` is the only source of dashboard KPIs.
- `GET /api/leads/follow-ups` remains authoritative for queue semantics.
- Server-side visibility `Own · DownTeam · FullTeam · Organization` is enforced
  server-side and can never be widened by query params.
- Soft-deleted leads are excluded everywhere.
- Business day authority: **Asia/Dhaka** (`server/utils/businessTime.ts`).
- `localStorage`, `localDb`, and client `getLeads()` are **never** used as
  authoritative metric sources.

---

## 6. Tests / source guards

`server/tests/dashboard-ux-step5b-source-guards.test.ts` adds fast, dependency-
free source guards covering: server-dashboard KPI consumption, no fabricated
avgResponseTAT / team list / trend series, no client KPI authority, calendar +
follow-up navigation, real-routes-only sidebar, menuAccess visibility, admin
bypass, ProtectedRoute coverage, and mobile sidebar behavior.

Existing Step 4A / 4B / Step 5 tests in
`server/tests/dashboard-metrics-integration.test.ts` (and the rest of the
suite) remain green — `npm test -- --run` passes.

---

## 7. Intentionally deferred (later phases)

| Item | Phase |
| --- | --- |
| `scheduled_activities` backend | Step 5C |
| Real trend time-series endpoint | later |
| Canonical team performance (hierarchy/team joins) | later |
| Advanced “needs attention” rules | later |
| Lead scoring / no-next-action scoring | later |
