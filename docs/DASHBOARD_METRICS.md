# Dashboard Metrics (Step 5)

## Overview

`GET /api/dashboard` is the **server-authoritative** source of dashboard KPIs.
PostgreSQL is the source of truth. Soft-deleted leads never count. Visibility is
enforced with the same resolver used by the leads list and follow-up queue
(`resolveCallerVisibility` / Own · DownTeam · FullTeam · Organization).

The frontend `dashboardService.getDashboard()` consumes this endpoint only.
Production totals are **not** derived from `getLeads()`, `localStorage`, or `localDb`.

## Permissions

- Requires authentication.
- Requires `dashboard.view` **or** `leads.view` (admin/superadmin bypass via existing permission helper).
- Missing permission → **403** (fail closed).
- Query params `role`, `employeeId`, `assignedTo` are **ignored for scope** and cannot widen results.

## Visibility model

| Scope | Sees |
| --- | --- |
| Organization / ADMIN | All non-deleted leads |
| FullTeam | Department peers (+ self) |
| DownTeam | Reporting subtree (+ self) |
| Own | Only caller’s assigned / created leads |

Assignment uses canonical `leads.assigned_to` (user UUID) with
`custom_fields.assignedTo` (employee id) as compatibility fallback — same
predicate as leads list / follow-up queue.

## Timezone rules

- Business day authority: **Asia/Dhaka** (`server/utils/businessTime.ts`).
- Follow-up buckets (overdue / today / upcoming) reuse
  `getDhakaBusinessDayBounds` and the same CASE expression as Step 4B
  `GET /api/leads/follow-ups`.
- Optional period filters (`TODAY`, `THIS_MONTH`, `LAST_MONTH`, `CUSTOM`) use
  Dhaka calendar boundaries on `leads.created_at`. Follow-up queue counts are
  **not** period-filtered so they stay identical to the queue.

## Status handling

Canonical `current_status` values only (no silent merges):

- Untouched, Contacted, No Response, Busy, Interested, Follow-up Set,
  Meeting Fixed, Meeting Completed, Pipeline Locked, Converted, Not Interested

**Active leads** = total − Converted − Not Interested  
**Conversion rate** = `converted / totalLeads * 100` (safe `0.0%` when total = 0)

## Financial field mapping

| UI metric | Source |
| --- | --- |
| Projected NCP | `leads.expected_premium`, fallback `custom_fields.projectedNCP` |
| Collected NCP | `custom_fields.collectedNCP` (no dedicated column) |
| Sum Assured | `leads.expected_value`, fallback `custom_fields.sumAssured` |

## Intentionally unavailable metrics (no fabrication)

| Field | Behavior |
| --- | --- |
| `avgResponseTAT` | Always `null` until a proven first-contact timestamp exists. UI shows **N/A**. Never defaults to `24.0h`. |
| `teamStats` | Always `[]` for Step 5. Area text (Gulshan/Banani/…) is **not** a team identity. Real Team Performance deferred to Step 5B / hierarchy joins. |
| `trendData` | Always `[]` until the server publishes real time-series. UI shows **No trend data available**. A single aggregate total is not a trend. |

## Follow-up counts

`data.followUpCounts` / `data.followUpsQueue`:

- Exclude soft-deleted
- Exclude terminal statuses Converted / Not Interested (default, same as queue)
- Require non-null `next_follow_up_at`
- Buckets: overdue / today / upcoming under Asia/Dhaka

**Must match** `GET /api/leads/follow-ups` counts for the same user/scope.

## SQL / query design

Typically four parallel aggregates:

1. Lead status + financial FILTER/CASE aggregates
2. Follow-up bucket GROUP BY (Step 4B expression)
3. Agent breakdown GROUP BY assignee
4. Area/team breakdown for known regions

No N+1 lead fetches for metrics.

## Response shape (key fields)

```json
{
  "success": true,
  "data": {
    "timezone": "Asia/Dhaka",
    "totalLeads": 0,
    "activeLeads": 0,
    "converted": 0,
    "statusCounts": { "Untouched": 0, "Converted": 0 },
    "projected": 0,
    "collected": 0,
    "sumAssured": 0,
    "conversionRate": "0.0%",
    "followUpCounts": { "overdue": 0, "today": 0, "upcoming": 0, "all": 0 },
    "agentStats": [],
    "teamStats": [],
    "campaignStats": []
  }
}
```

## Tests

`server/tests/dashboard-metrics-integration.test.ts` covers visibility,
soft-delete, status/rate, NCP/sum assured, forged params, permissions,
follow-up parity with Step 4B, and client source checks.
