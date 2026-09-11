# Daily Workbench — Focused Daily Lead Execution

## Purpose
"What do I need to execute today, and what can I complete quickly from one place?"

Daily Workbench is an execution workspace, not another dashboard, calendar, or full lead list. It surfaces only today's actionable work and allows quick completion from one place.

## Route & Sidebar
- Route: `/workbench`
- Protected: wrapped in `ProtectedRoute` (same auth/session/JWT as all other routes)
- Sidebar location: MY WORK (first item)
  - Order: Daily Workbench, Activities, Task Calendar, Follow-up Queue
- Menu visibility: reuses existing `menuAccess` override + static `roles.includes` fallback + ADMIN bypass via `resolveMenuVisibility`. No Admin-only hardcode; ALL_ROLES static fallback.
- Permission: reuses existing `dashboard.view` / `leads.view` semantics via `usePermissions`. Workbench maps to `dashboard.view` for server permission sheet, and `lead_tracking.edit` for scheduled actions. Server remains security boundary.

## Data Sources (authoritative only)
- `GET /api/leads/follow-ups?bucket=all&limit=200` via `leadService.getFollowUpQueue`
  - Returns items with `dueState` (overdue/today/upcoming), `nextFollowUpAt`, `currentStatus`, lead name, assignee, campaign/product/area, overdueDays.
  - Counts: overdue, today, upcoming, all.
  - Visibility: server-enforced Own/DownTeam/FullTeam/Organization (Asia/Dhaka).
- `GET /api/scheduled-activities?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=200` via `scheduledActivityService.list`
  - Returns scheduled activities with `scheduledAt`, `activityType` (call/meeting/follow_up/task), `status`, `title`, `remarks`, `priority`, `meetingType`, `location`, `leadCustomerName`, `leadMobile`, `leadStatus`, `completedAt/by/activityId`.
  - Filtered by Dhaka day boundaries: `from`/`to` are Dhaka midnights.
  - Visibility: inherited from parent lead.
- `GET /api/scheduled-activities?status=completed&limit=100` for Completed Today (optional)
  - Filtered client-side by `completedAt` Dhaka date = today. Bounded (100) to avoid full scan.
  - This is authoritative completed scheduled data; lead_activities bulk endpoint does not exist, so we avoid N+1.

No `leadService.getLeads()` full list fetch. No per-row lead detail fetch. Only 2–3 bounded requests per load, manual Refresh.

## Queue Composition
Unified work queue for:
- overdue follow-ups (queue `dueState=overdue`)
- today follow-ups (queue `dueState=today`)
- today scheduled calls (`activityType=call`, status=scheduled, Dhaka date=today)
- today scheduled meetings (`meeting`)
- today scheduled tasks (`task`)
- today scheduled follow_up activities (`follow_up`)

Tomorrow items do NOT enter today's execution queue. Tomorrow Preview shows only counts.

## Sort Order
1. overdue first (follow-up overdue)
2. then today items by scheduled/due time ascending (earliest first)
3. unscheduled/invalid-time items last (`sortTime = MAX_SAFE_INTEGER`)

Implementation: `toWorkItems` builds namespaced keys `follow_up:<leadId>` and `scheduled:<activityId>`; sorts by `overdue` flag then `sortTime`.

## Quick Filters
Client-side over already loaded authoritative daily work set (no refetch per tab):
- All
- Overdue
- Calls
- Meetings
- Follow-ups
- Tasks

Counts shown in filter chips (e.g., `All 12`, `Overdue 3`).

Optional Completed filter omitted in v1 because completed data is shown separately.

## Queue Item Design
Each row shows where available:
- activity type icon (Phone/Video/History/ClipboardCheck)
- lead/prospect/customer name
- scheduled/due time (Asia/Dhaka formatted)
- current lead status badge (via `getLeadStatusColorClasses`)
- title / purpose (remarks/title)
- overdue indicator (red badge + AlertTriangle)
- assignee only if useful (follow-up queue provides `assignedEmployeeName`)
- source badge: Follow-up / Call / Meeting / Task
- CTA: Open Lead (link to `/leads/:id` existing Lead360)

Rows compact, enterprise layout, warm neutral surfaces, radius 10–12px, shadow scale from design system.

## Quick Actions
Goal: reduce clicks.

For scheduled activities (where permission permits):
- Complete: `scheduledActivityService.complete(id)` — atomic, server-derived `completed_at/by/activity_id`, creates immutable `lead_activities` row, duplicate returns 409.
- Cancel: `scheduledActivityService.cancel(id)` — soft-cancel preserves row.
- Edit / Reschedule: modal with title, scheduledAt (datetime-local), remarks → `scheduledActivityService.update(id, payload)` — only pending editable, completed/cancelled immutable 409.

Reuse existing PR #21 services and semantics. No direct DB mutation from client. No bypass of permissions. Server remains security boundary.

For follow-up queue items:
- Open Lead → existing Lead360/follow-up flow
- No second follow-up completion engine in this PR (prefer Open Lead)

After success: local state patched efficiently (remove/update item), no full-page refetch, no duplicate notification fanout, preserves PR #19 performance.

## Overdue Follow-ups
Prominent but not overwhelming: red badge, due date/time, lead name, current status, Open Lead CTA. No fake urgency scores. No auto-convert to scheduled activity. Follow-up queue remains authoritative.

## Today Follow-ups vs Scheduled FOLLOW_UP
Important: a lead due in follow-up queue AND a scheduled activity of type follow_up are distinct unless an exact shared identifier proves same logical item. Current APIs do NOT provide shared identifier, so we keep them distinct and namespaced. Documented in code comment and here.

## Completed Today
Semantics v1:
- Completed Today = scheduled activities where `status=completed` and `completedAt` Dhaka date = today (authoritative `completed_at` from server).
- Derived from bounded `GET /api/scheduled-activities?status=completed&limit=100` filtered client-side.
- Does NOT count arbitrary lead status updates, historical imported rows, or client-side status changes.
- Lead_activities bulk count would require new endpoint; deferred to keep change minimal. If needed, future extension could add `GET /api/activities/completed-today` with visibility.

Failure handling (must not fail to zero):
- Success with no items → card shows `0` with subtext `Scheduled completed`.
- Request failure → card shows `—` with subtext `Unavailable`, not `0`. Primary workbench (follow-ups + scheduled today) still loads; failure is not fatal.
- After a successful Complete mutation, unavailable state clears and item is added to completed list if completed today.

If completed fetch fails, summary shows unavailable but does not hide other data; error is not silent zero for primary sources.

## Tomorrow Preview
Lightweight counts at bottom:
- Calls (scheduled tomorrow)
- Meetings
- Follow-ups (queue upcoming filtered to tomorrow + scheduled follow_up tomorrow)
- Tasks

No large duplicate list. Today remains core workbench. Task Calendar remains detailed planning view.

## Performance Safeguards
- No `leadService.getLeads()` or `getAllLeads()` in DailyWorkbench (guarded by tests)
- No N+1 lead detail fetches (`getLead` per row) — lead name/status already in API responses
- Bounded requests: follow-ups all 200, scheduled range 200, completed 100
- No aggressive polling, no background intervals
- Manual Refresh button
- Local state patch after mutation
- Reuses existing services
- Preserves PR #19: no seconds-level polling, session cache for roles/notifications, fail-closed permission

## Error Handling
Honest neutral states:
- "Daily work could not be loaded." + "Please try again." + Retry
- Partial failure: "Follow-ups could not be loaded. Scheduled activities may still be available." and vice versa, not silent zero.
- Loading state shows skeletons, not false empty.

## Empty State
When no work today:
- Title: "You're clear for today"
- Subtitle: "No overdue follow-ups or scheduled activities are currently due."
- CTA: Open Calendar
- No fabricated congratulations or performance scores.

## Design
Uses PR #22 English-only design system:
- Warm neutral surfaces #FDFBF7, #FFFCF8, white cards
- Radius 12px cards, 10px inputs/buttons/pills
- Shadow scale card, card-hover, elevated
- Semantic colors: red overdue, sky call, amber meeting, emerald follow-up, purple task
- Icon capsules
- Compact enterprise layout, accessible focus states, responsive grid, single-column mobile touch-friendly

## Permission Behavior
- Sidebar: ALL_ROLES static fallback, dynamic `menuAccess['/workbench']` override if configured, ADMIN bypass preserved.
- Page actions: `canAccess('lead_tracking','edit')` ONLY gates Complete/Cancel/Edit/Reschedule. Server final boundary is `leads.edit` (checked in `production.routes.ts` for POST `/scheduled-activities/:id/complete`, `/cancel`, PUT `/:id`, DELETE `/:id`). `dashboard.view` alone MUST NOT expose mutation buttons; `lead_generate.edit` is not sufficient. UI hides mutation buttons when lacking edit permission, but server remains security boundary.
- Follow-up Open Lead uses existing Lead360 which already enforces visibility. Open Lead remains allowed when visibility permits even without edit permission.

## Asia/Dhaka Semantics
- Today/tomorrow YMD via `toLocaleDateString('en-CA', {timeZone:'Asia/Dhaka'})`
- Due/scheduled formatting via `toLocaleString('en-GB', {timeZone:'Asia/Dhaka'})`
- Filtering: `isDhakaYmd(iso, ymd)` checks if ISO instant falls on given Dhaka YMD.
- Day boundaries same as dashboard and follow-up queue (server bounds use Asia/Dhaka).

## De-duplication Rule
No heuristic cross-source deduplication by lead, name, timestamp. Only exact shared identifier would merge, which does not exist. Keys namespaced: `follow_up:<leadId>` vs `scheduled:<activityId>`. Documented in code and here.

## Intentionally Deferred
- Manager Attention Board
- Lead Scoring, AI recommendation, Next Best Action, productivity score, coaching
- Automatic task generation
- Notifications automation, SMS/email/WhatsApp
- RLS, Google Sheet reconciliation, broad DB redesign, legacy cleanup, localization, commission, attendance
- Completed Today from immutable `lead_activities` bulk (requires new endpoint)
- Overdue scheduled activities in queue (currently only overdue follow-ups per spec)
- Advanced reschedule with assignee/priority editing (v1 supports title/time/remarks; priority/location already in Lead360)

## Verification
- `npm test -- --run` must stay green (existing PR #19, #21, #22, #24, #25 guards)
- New guards in `daily-workbench.test.ts`
- `npx tsc --noEmit` passes
- `npm run build` passes
- `npm run verify:serverless` passes
