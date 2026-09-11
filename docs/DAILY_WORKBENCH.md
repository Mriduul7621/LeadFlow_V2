# Daily Workbench — focused daily lead execution

> A first-class execution workspace: *"What do I need to execute today, and what can I complete quickly from one place?"*
> It is **not** a dashboard, **not** a calendar and **not** a lead list. It composes the two existing
> authoritative sources into one sorted daily work queue with quick actions.

---

## 1. Purpose & scope

The Daily Workbench answers one question per user, per day: what has to be executed **today**.
It deliberately stays a thin composition layer on top of already-shipped architecture:

- PR #4B follow-up queue (`GET /api/leads/follow-ups`) — untouched
- PR #21 scheduled activities (`GET /api/scheduled-activities`, complete/cancel/update) — untouched
- One new **read-only** count endpoint: `GET /api/scheduled-activities/completed-today`
- PostgreSQL remains the source of truth; the server remains the visibility boundary.

Intentionally out of scope (not implemented): manager attention board, lead scoring, AI/next-best-action,
productivity scores, coaching, automatic task generation, notification automation, messaging channels,
RLS, spreadsheet reconciliation, localization. See the PR description for the full list.

## 2. Route & sidebar

| Item | Value |
| --- | --- |
| Route | `/workbench` (`src/App.tsx`, wrapped in the shared `ProtectedRoute`) |
| Page | `src/modules/workbench/pages/DailyWorkbench.tsx` |
| Composition layer | `src/modules/workbench/services/workbenchService.ts` |
| Sidebar | **MY WORK → Daily Workbench** (first item, before Activities, Task Calendar, Follow-up Queue) |

Sidebar visibility uses the **unchanged** `resolveMenuVisibility` architecture
(`src/layouts/menuVisibility.ts`): ADMIN bypass → dynamic role `menuAccess[path]` override → static
role fallback (`ALL_ROLES`, same as the other MY WORK entries). No new permission code was invented.
Route/sidebar guards in `server/tests/dashboard-ux-step5b-source-guards.test.ts` were extended with
`/workbench` (the list test requires every sidebar path to be a real, protected route).

## 3. Page structure

```
Page header (title, subtitle, Dhaka date line, Refresh, Open Calendar)
→ Daily Summary (6 compact cards)
→ Quick Filters (chips with counts)
→ Execution Queue (one unified list, rows expand into a quick-action area)
→ Tomorrow Preview (counts only)
```

## 4. Data sources (exactly three bounded parallel requests)

| Request | Purpose | Bound |
| --- | --- | --- |
| `GET /api/leads/follow-ups?bucket=all&limit=200` | overdue + today (+ tomorrow slice for preview) follow-ups and the authoritative `counts` over the whole visible scope | server max page (200) |
| `GET /api/scheduled-activities?from=<today>&to=<tomorrow>&limit=200` | today's and tomorrow's planned call/meeting/follow_up/task rows | server max page (200) |
| `GET /api/scheduled-activities/completed-today` | authoritative "Completed Today" count | single count query |

- `from`/`to` are Asia/Dhaka calendar dates computed on the client (`en-CA` + `Asia/Dhaka`) purely to
  address the server's day filter; **the server performs the authoritative boundary math** via
  `getDhakaBusinessDayBounds`.
- The page **never** calls `leadService.getLeads()`, never fetches lead detail per row, and derives
  display fields (name, status, assignee) from fields already present in the API responses.
- `Refresh` is manual. The page adds **no polling, no intervals, no notification reloads**.

## 5. Queue composition & sort order

Unified execution queue = overdue follow-ups + today follow-ups + today scheduled
`call` / `meeting` / `follow_up` / `task` (status `scheduled` only — completed/cancelled are terminal
history maintained by the server and never enter the queue).

Sort order (`sortWorkbenchQueue`):

1. **Overdue first** (most overdue — smallest timestamp — at the top)
2. **Today items by scheduled/due time** ascending
3. **Invalid/unscheduled time items last** (stable order)

Follow-up rows reuse the server's `dueState` (`overdue` / `today`) — the client never re-classifies
buckets. Scheduled rows are split by Asia/Dhaka calendar date because the server already filtered the
loaded page to `[today, tomorrow]`. Tomorrow items never enter today's queue; they only feed the
Tomorrow Preview counts.

### De-duplication rule (documented, deliberate)

A follow-up queue row `id` identifies a **lead**; a scheduled activity `id` identifies an **independent
planned activity**. The two loaded contracts supply **no item-level cross-link**, so matching by lead,
name or timestamp would be a heuristic and is **not done**. Items are keyed by exact namespaced
identifiers (`follow-up:<id>` vs `scheduled:<id>`) and only exact duplicate keys within the same source
collapse. A lead due in the queue *and* having a scheduled `follow_up` today legitimately appears as
**two rows**.

## 6. Quick actions

Rows are compact; tapping/clicking a row expands its quick-action area:

| Item type | Actions | Implementation |
| --- | --- | --- |
| Scheduled activity | **Complete / Cancel / Reschedule** (when permitted) + Open Lead | Reuses `scheduledActivityService.complete/cancel/update` (PR #21 endpoints). No duplicated completion logic, no direct DB access. |
| Follow-up queue item | **Open Lead** | Navigates to the existing Lead360 route (`/leads/:id`); completion stays in the existing Lead360/follow-up flow. No second follow-up completion engine. |

Reschedule uses a `datetime-local` input converted to an ISO timestamp — identical semantics to
Lead360's edit form. After any confirmed mutation the page updates **local state only**
(`applyCompletedMutation` / `applyCancelledMutation` / `applyRescheduleMutation`) — no full refetch and
no notification fan-out. Overdue follow-ups are prominent (red accents, `N d` badge) but stay ordinary
queue rows; overdue follow-ups are **never** auto-converted into scheduled activities and get no
fabricated urgency scores — the follow-up queue remains authoritative.

## 7. Permission behavior

- **Read**: page data requires the same server permissions as the underlying endpoints
  (`leads.view`), enforced server-side with `resolveCallerVisibility`
  (Own / DownTeam / FullTeam / Organization). Query params cannot widen scope.
- **Write**: `complete`, `cancel` and `update` require `leads.edit` **on the server**. The client
  surfaces those buttons only when the signed-in user holds the matching capability via the existing
  `usePermissions().canAccess('lead_tracking', 'edit')` mapping (→ `leads.edit`). Follow-up rows always
  keep Open Lead (a read-level action). Client gating is UX only — **the server remains the security
  boundary**; users without `leads.edit` cannot mutate even if the UI were bypassed.
- **Menu**: unchanged `menuAccess` / static fallback / admin bypass (see §2).

## 8. Asia/Dhaka semantics

- All day boundaries are the server's (`getDhakaBusinessDayBounds`, fixed UTC+6, no DST).
- `todayYmd`/`tomorrowYmd` on the client exist only to parameterize the server's `from`/`to` filter and
  to split the already server-filtered page into today vs tomorrow.
- Row times render with `Asia/Dhaka` (`en-GB`, 12-hour).
- Boundary checks in post-mutation state updates (`completedAt` on today's Dhaka date) use the same
  client helper (`dhakaYmdOf`), covered by unit tests incl. month/year/leap rollovers.

## 9. "Completed Today" semantics

`Completed Today` = **scheduled activities whose server-stamped `completed_at` falls inside today's
Asia/Dhaka business day, within the caller's lead visibility**. It binds to the new read-only
`GET /api/scheduled-activities/completed-today` (same visibility clause as the list endpoint), never to
local UI state, imported history rows or arbitrary lead-status changes. If the source fails, the card
renders `—` (never a fabricated zero). A successful complete increments the count only when the
**server-returned** `completedAt` is on today's Dhaka date. Historical `lead_activities` created by the
Lead360 follow-up flow are deliberately **not** counted in v1 (no scoped global activity endpoint; see
§12).

## 10. Performance safeguards

- Exactly **three** bounded requests per manual load; no `getLeads()`, no N+1, no per-row fetches
  (asserted at runtime by `daily-workbench.test.ts` E1: exact request count + URLs).
- Quick filters are pure client-side operations over the already-loaded daily set — no per-tab refetch.
- Mutations update local state from the server's response; only the manual **Refresh** button reloads.
- No polling/interval is introduced on this page (PR #19 hardening preserved; full suite stays green).
- Follow-up summary cards (`Overdue Follow-ups`, `Follow-ups Today`) bind to the server's authoritative
  `counts` (scope-wide), not just the fetched page; scheduled-type cards count the loaded daily page
  (documented bound: 200 rows/day).

## 11. Error, partial & empty states

- **Loading**: skeleton cards with `role="status"` — never a false "clear for today".
- **Total failure** (both primary sources down): neutral *"Daily work could not be loaded. / Please try
  again."* with **Retry**. No "offline mode" claims.
- **Partial failure**: explicit amber banner naming the failed source (e.g. *"Could not load the
  follow-up queue"*); failed counts render `—`, never silently zero.
- **Empty**: *"You're clear for today"* / *"No overdue follow-ups or scheduled activities are currently
  due."* with an **Open Calendar** CTA. No congratulations, no fabricated scores.

## 12. Intentionally deferred

- **Completed Today from `lead_activities`** (e.g. Lead360 follow-up completions): requires a new
  scoped global activity query; deferred to keep this PR read-only-plus-one-count. The current
  definition covers exactly what the workbench completes.
- **Completed filter tab**: only a count exists (no completed list is loaded), so no Completed chip.
- **Assignee on scheduled rows**: `GET /scheduled-activities` does not return assignee names; shown for
  follow-up rows (where available) only.
- **Tomorrow large list**: preview shows counts only; Task Calendar remains the planning view.

## 13. Tests

`server/tests/daily-workbench.test.ts` (49 cases):

- Route/sidebar/permission source guards (protected route, MY WORK order, `menuAccess` fallback intact,
  no `getLeads`, existing services reused, action gating, no Dashboard changes)
- Pure composition: all four scheduled types + overdue/today follow-ups in queue; tomorrow excluded;
  ordering (overdue → chronological → invalid last); exact-identifier-only dedup; filters with counts
- Asia/Dhaka boundary units (18:00Z roll, month/year/leap)
- Render states (loading ≠ empty, empty copy, neutral error, partial banner, `—` vs 0, unauthorized row
  hides Complete/Cancel/Reschedule)
- Runtime request discipline (exactly three requests, correct Dhaka `from`/`to`, failed source → `null`
  count, no full lead-list URL)
- pglite integration for `completed-today`: auth required, visibility scoping (admin vs Own employee),
  today-only by `completed_at`, terminal/deleted exclusion

Existing suites that must stay green all run in CI: PR #19 `perf-latency-hardening`, PR #21
`scheduled-activities-*`, PR #22 `ui-localization-modernization`, PR #24/#25
`dashboard-productivity-refinement` + `dashboard-ux-step5b-source-guards` (its route lists were
extended with `/workbench`), and the RBAC/visibility suites.
