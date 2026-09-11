# Dashboard Productivity Refinement

## Overview

This document describes the Step 5B redesign of the LeadFlow Dashboard, focusing on
eliminating duplicate metrics, establishing clear ownership of each business question,
and creating a decision-oriented CRM workspace.

## Duplicate Metrics Identified and Removed

### From Executive Snapshot (moved to more appropriate sections):

| Metric | Removed From | Now Located |
|--------|-------------|-------------|
| Untouched | Top KPI row | Pipeline stage + Needs Attention section |
| Due Today | Top KPI row | Today & Tomorrow panel + Follow-up Discipline |
| Converted | Top KPI row | Pipeline stage (last item) |

### Rationale:

- **Untouched** → Redundant at top level; meaningful in Pipeline (leads not yet engaged) and Needs Attention (action required)
- **Due Today** → Better positioned in operational Today/Tomorrow panel where users act on immediate follow-ups; also in Follow-up Discipline compact view
- **Converted** → Canonical pipeline stage — naturally belongs in Sales Pipeline visualization

## Final Dashboard Information Hierarchy

### 1. Header + Date Range

- Persists: Dashboard title, live date-range selector (Today/WTD/MTD/LMTD/YTD/Custom/All Time)
- Preserved: Asia/Dhaka business dates, Today default, LMTD logic, Refresh action
- unchanged: date filter behavior, design tokens

### 2. Executive Snapshot

**Primary KPIs (server-authoritative from GET /api/dashboard):**

- **Total Leads** — overall lead count under current visibility scope
- **Conversion Rate** — `converted / totalLeads * 100`, safe `0.0%` when total = 0
- **Collected NCP** — `custom_fields.collectedNCP` aggregated across visible leads
- **Projected NCP** — `leads.expected_premium` / `custom_fields.projectedNCP` aggregated
- **Active Leads** — `metrics.activeLeads`; sub-caption passes through `metrics.pipelineLocked ?? 0` as “{pipelineLocked} Pipeline Locked” (never derived from active leads)
- **Overdue Follow-ups** — `followUpCounts.overdue` from server follow-up queue

**Removed from top snapshot (moved deliberately):**

- Untouched → Pipeline / Needs Attention
- Due Today → Today / Tomorrow + Follow-up Discipline
- Converted → Pipeline stage

**Purpose:** "How is the business performing overall?"

### 3. Today & Tomorrow — Prominent Operational Panel

**Purpose:** "What exactly do I need to do now and next?"

**Structure:**

| Day | Metrics | Items |
|-----|---------|-------|
| **Today** | - total activities<br>- Calls count<br>- Meetings count<br>- Follow-ups count<br>- Tasks count | One unified list ordered by existing due/scheduled timestamps; all loaded rows appear once in a bounded, scrollable list |
| **Tomorrow** | same structure | same structure |

**Data sources (server-authoritative, no `getLeads()` fetch):**

- Follow-ups: `GET /api/leads/follow-ups` (buckets: today, upcoming)
- Scheduled activities: `GET /api/scheduled-activities?from=YYYY-MM-DD&to=YYYY-MM-DD` (Asia/Dhaka)

**Display items per activity (compact badges/icons):**

- Scheduled time (Dhaka-formatted)
- Activity type: CALL, MEETING, FOLLOW_UP, TASK
- Lead/prospect name
- Activity title/agenda
- Current lead status for follow-up queue items

**Counting and de-duplication:**

- Calls / Meetings / Follow-ups / Tasks and the day total all count the same
  normalized, loaded rows that the list renders; these are not global KPI totals.
- Exact repeated IDs are removed within each source before counting and rendering.
- Queue `id` identifies a lead (code or ID); scheduled activity `id` identifies a
  separate planned activity. The loaded contracts do **not** expose a shared
  follow-up/activity ID or item-level linkage. Matching a lead, name or timestamp
  is not proof of duplication, so cross-source items remain distinct. No heuristic
  de-duplication, invented linkage fields, or extra fetches are introduced.
- `dailyLoading` controls per-day skeletons during initial loading and refresh;
  empty messages and zero summaries are shown only after loading has settled.

**Avoids:** the second “Scheduled Activities” rendering block and repeating
top-level Follow-up Health cards

### 4. Sales Pipeline — Primary Stage Distribution

**Purpose:** "Where are my leads in the sales journey?"

**Canonical stages (unchanged):**

Untouched → Contacted → Interested → Meeting Fixed → Meeting Completed → Pipeline Locked → Converted

**Shows:** count + percentage of visible total for each stage

**Design:**

- Stage progression feels connected visually
- Converted uses success tone
- Untouched uses neutral/olive tone
- Restrained accent/progress bars

**Lead Status Distribution section removed** — it materially duplicates the same
statusCounts/pipeline information. If any data was meaningfully different, it was
merged into Pipeline; otherwise the redundant section is gone.

### 5. Follow-up Discipline — Operational Summary

**Purpose:** "Am I managing follow-ups properly?"

**Presentation:**

- One operational summary card/panel
- 3 compact metrics: Overdue / Due Today / Upcoming
- Overdue share ratio: `overdue / all follow-ups` (calculated only when both values
  are available from the same authoritative dashboard response)
- Clear CTA to Follow-up Queue (`/follow-up`); the Overdue card preserves the
  `/follow-up?bucket=overdue` deep link removed from Needs Attention

**Data:** uses `followUpCounts` from dashboard server response only. No fabricated
completion rates, discipline scores, SLA scores, or trends.

### 6. Needs Attention — Action-Oriented Signals

**Purpose:** "What requires intervention?"

**Current signals (authoritative only):**

- **Untouched Leads** → `statusCounts.Untouched`, links to `/leads`
- No Overdue Follow-ups row here: the high-level exception stays in Executive
  Snapshot and its operational context stays in Follow-up Discipline.

**Presentation:** one compact, full-width row linking to the existing screen.
Only `NeedsAttentionSection` remains; the unused `NeedsAttention` duplicate,
unused empty-state helper, imports and superseded computations are removed from
`Dashboard.tsx`.

**Excluded (future PRs):** lead scoring, AI risk, manager attention score, stale-lead
heuristics, fabricated priority.

No speculative attention-rule placeholder is displayed.

### 7. Performance Insights — Only When Useful

**Refactored from:** Trend, Team Performance, Lead Status Distribution

**A. Lead Status Distribution:** Removed if redundant with Pipeline (which it is — same
statusCounts data). The separate section is eliminated.

**B. Trend:** 

- If real `trendData` exists from server → render compact time-series
- If `trendData` is empty (backend does not yet publish time series) → compact
  unavailable state or hide section entirely. No large empty dashboard blocks.
- Never fabricate trend data.

**C. Team Performance:**

- If real `teamStats` exists → render compact table
- If `teamStats` is unavailable/empty → do not reserve large dashboard block.
  Preferred: compact informational state or hide entirely until real server data
  is available.

**Policy:** Dashboard prioritizes actionable data over large empty placeholders.

### 8. Task Calendar — Last Section

**Purpose:** "Detailed planning and calendar view"

**Role:** Task Calendar must remain the LAST dashboard section, providing deeper
calendar detail that Today/Tomorrow summarises immediately.

**Dedicated route:** `/task-calendar` remains separate and fully interactive.

**Avoids:** showing the exact same visual list twice. Today/Tomorrow summarizes;
Task Calendar provides the detailed view.

### 9. Productivity-First Layout

**Goals:** reduce vertical scrolling, stronger information density.

**Recommended layout flow (desktop):**

1. Executive Snapshot — compact KPI grid (1 row)
2. Today & Tomorrow — prominent operational panel
3. Sales Pipeline — horizontal responsive stage flow
4. Follow-up Discipline + Needs Attention — may share a responsive 2-column row on desktop
5. Performance Insights — only when useful data exists
6. Task Calendar — full-width at bottom

**Mobile:** stacks naturally, readability preserved.

### 10. Visual Refinement (using PR #22 design tokens)

**Design system:** brand tokens only — no second design system invented.

**Tokens preserved:** brand `#978C21` gold, `#F3702B` orange, `#F9F9F4` warm surface,
`#FDFBF7` page background, `brand-text #3C3C3C` dark text.

**Hierarchy by semantic accent:**

- Executive Snapshot: strongest numeric emphasis, subtle semantic accent, concise labels
- Today/Tomorrow: visually prominent, two clearly separated day groups, activity-type badges
- Pipeline: stage progression with restrained accent/progress; Converted success tone,
  Untouched neutral/olive
- Needs Attention: warning emphasis only where genuinely needed; do not make entire page
  red/orange
- Follow-up Discipline: semantic colors (red/amber/blue) for overdue/due today/upcoming

### 11. Color Usage — Keep Enterprise Aesthetic

**Avoid:**

- Every panel having a different background color
- Full saturated gradient cards
- Excessive shadows
- Excessive hover movement
- Neon colors
- Glass-heavy layout

**Use semantic color only for:**

- Overdue → red / `kpi-card-red`
- Success → green / `kpi-card-emerald`
- Warning → amber / `kpi-card-orange`
- Information → sky/blue / `kpi-card-blue`
- Brand emphasis → gold `/ `kpi-card-olive` (via `#978C21`)

### 12. Date Filter — Preserved Exactly

**PR #22 unified date selector preserved:**

- Items: Today, WTD, MTD, LMTD, YTD, Custom, All Time
- Today default
- LMTD logic (last month, same elapsed days)
- Asia/Dhaka semantics
- Server dashboard request
- No client KPI derivation

**Not redesigned** unless a bug is found.

### 13. Today/Tomorrow Data Authority

**Sources (must remain):**

- `GET /api/leads/follow-ups` — follow-up queue (today/upcoming buckets)
- `GET /api/scheduled-activities` — planned work (Asia/Dhaka date range)

**Must NOT use:**

- `leadService.getLeads()` — full lead list fetch
- localStorage business data
- manually derived lead activity from arbitrary fields

**semantics:** `scheduled_activities` = planned work; `lead_activities` = completed actual history.

### 14. English-Only

**Remains:** English-only app. No EN/BN, no translation selector, no translation hooks
reintroduced into active Dashboard/AppLayout/Login.

**Legacy files:** not broadly deleted unless causing a problem.

### 15. Performance / Security Guards

**Preserved from PR #19 and PR #21:**

- Server visibility boundary (Own / DownTeam / FullTeam / Organization)
- Fail-closed authorization
- PR #19 caching/memoization
- PR #21 activity queries

**Forbidden:**

- Full lead list dashboard fetch
- N+1 requests
- New aggressive polling
- Frequent role reloads
- Frequent notification reloads
- Unnecessary post-mutation refreshes
- Client-side authorization
- Browser-authoritative business data

### 16. No Backend Fabrication

**Policy:** Do not add backend metrics merely to make the dashboard look richer unless
the data is truly available and the change is small and correct.

**Never fabricate:**

- Comparison percentages
- Previous period growth
- Conversion trend
- Follow-up completion rate
- Productivity score
- Team score
- Risk score
- Lead quality score

**If data is not available:** keep the UI honest.

## Tests / Regression Guards

Added 26 focused regressions in
`server/tests/dashboard-productivity-refinement.test.ts`:

- Real React rendering with imported History and all four activity-type icons
- Dashboard-only TypeScript diagnostics with unused-local/parameter checks
- Pipeline Locked receives `metrics.pipelineLocked ?? 0`, independent of active leads
- Today and Tomorrow each show their own Calls / Meetings / Follow-ups / Tasks counts
- Every scheduled/queue row renders once, preserves links/badges, and is ordered by time
- Exact source-ID duplicates are removed; no lead/name/time heuristic merging
- All loaded rows remain available beyond six items per source
- Daily-loading and refresh skeletons cannot show false empty messages or zero counts
- Needs Attention contains only Untouched Leads; overdue queue navigation is preserved
- `rounded-[10px]` replaces the typo on the Add Lead action
- No full lead fetch or additional daily requests
- Final section order is preserved with Task Calendar last
- Existing date controls/default/query mapping, plus Dhaka date behavior in three
  browser timezones, February/leap-year caps and year rollover

The existing Step 5B loader guard now ends at `loadDailyExecution` instead of the
removed `formattedDateRange` variable; its server-authority assertion is unchanged.
PR #19 performance, PR #21 scheduled activity, and PR #22 English-only/design/date
suites remain part of the full test run, alongside authentication, RBAC, visibility,
import, follow-up and dashboard API integration coverage.

Run:

```
npm test -- --run
npx tsc --noEmit
npm run build
npm run verify:serverless
```

### Verification — 2026-09-11

| Command | Result |
|---------|--------|
| `npm test -- --run` | Passed: 312 tests across 24 suites, 0 failures/skips (includes 26 new focused tests and the PR #19/#21/#22 guards) |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed; Vite reports a non-blocking chunk-size warning above 500 kB |
| `npm run verify:serverless` | Passed: all 8 checks in production DB-unconfigured mode |

No `DATABASE_URL` was configured for the serverless smoke test, so it verifies
compiled ESM boot, routes, authentication protection, and honest 503 responses
without a database—not a live hosted PostgreSQL deployment. The full test suite
also exercises the existing PGlite-backed integration coverage.

## Intentionally Hidden / Unavailable Analytics

| Metric | Reason |
|--------|--------|
| `avgResponseTAT` | Always `null` until proven first-contact timestamp exists; UI shows N/A |
| `teamStats` | Always `[]` for Step 5; area text is not a team identity |
| `trendData` | Always `[]` until server publishes real time-series |
| Advanced "needs attention" rules | Deferred to later phase (untouched >24h, overdue >3 days, etc.) |

## Data-Authority Guarantees

- **PostgreSQL** is the single source of truth
- `GET /api/dashboard` is the only source of dashboard KPIs
- `GET /api/leads/follow-ups` remains authoritative for queue semantics
- Server-side visibility (`Own` / `DownTeam` / `FullTeam` / `Organization`) is enforced
  server-side and can never be widened by query params
- Soft-deleted leads are excluded everywhere
- Business day authority: **Asia/Dhaka** (`server/utils/businessTime.ts`)
- `localStorage`, `localDb`, and client `getLeads()` are **never** used as authoritative metric sources

## Performance Safeguards

- No full lead list fetch for dashboard KPIs or Today/Tomorrow panel
- Follow-up queue and scheduled-activities are individually paged (default limit 50/100)
- Date-range filtering uses server-computed boundaries (no client-side derivation of totals)
- Metrics skeletons and independent Today/Tomorrow skeletons while daily execution
  loads; existing dashboard error handling is preserved
- Refresh action reloads only what's needed (dashboard data + daily execution)

## No Fabricated Metrics Policy

The dashboard UI is intentionally honest: if a metric is not available from the
server-authoritative `GET /api/dashboard` or `GET /api/leads/follow-ups` endpoints, it
does not appear. No fabricated growth percentages or scores. KPI values are passed
through from the dashboard response with the existing nullish zero fallback while
unavailable. The presentation computations are limited to:

- Conversion rate = `converted / totalLeads * 100` (safe `0.0%` when total = 0)
- Overdue share = `overdue / all` (only when both values come from the same dashboard response)
- Percentage of total per pipeline stage (derived from statusCounts + totalLeads)
- Per-day type counts and totals from the already-loaded, exact-ID-unique activity rows

All other values are passed through exactly as provided by the server.

---
*This refinement replaces the prior Dashboard collection of repeated counts with a
decision-oriented CRM workspace. Each section answers a distinct business question.
No metric is duplicated without clearly different context or actionability.*