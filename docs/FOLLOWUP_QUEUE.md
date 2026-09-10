# Follow-up Queue (Step 4B)

## Endpoint

`GET /api/leads/follow-ups`

Registered **before** `GET /api/leads/:id` so `follow-ups` is never treated as an id.

Requires authentication and `leads.view`. Visibility is computed with `resolveCallerVisibility` (Own / DownTeam / FullTeam / Organization). Query params cannot widen scope.

### Query parameters

| Param | Notes |
| --- | --- |
| `bucket` | `overdue` \| `today` \| `upcoming` \| `all` (default `all`) |
| `from` / `to` | Optional `YYYY-MM-DD` Dhaka calendar bounds |
| `status` | Optional current_status AND with visibility |
| `assignedTo` | Optional; if outside caller scope, **zero results** (never widened) |
| `includeTerminal` | `true` to include Converted / Not Interested |
| `limit` | Default 50, **max 200** |
| `offset` | Offset pagination |

### Response

`{ success, data: { bucket, timezone, todayDate, bounds, items, counts, pagination } }`

Queue rows include lead id/code, name, mobile, assignee, status, next/last contact, follow-up count, campaign/product/area/priority, `overdueDays` / `dueState`, and latest activity (LATERAL join, no row duplication).

## Bucket semantics (Asia/Dhaka)

Server-side `getDhakaBusinessDayBounds()` — not the browser timezone. Stored timestamps are **not** rewritten.

- **overdue**: `next_follow_up_at < start of today (Dhaka)`
- **today**: `>= start of today` and `< start of tomorrow`
- **upcoming**: `>= start of tomorrow`
- **all**: any non-null `next_follow_up_at` in visibility

Soft-deleted leads are never returned. Null `next_follow_up_at` is excluded.

## Terminal statuses

`Converted` and `Not Interested` are excluded from the actionable queue by default. Pass `includeTerminal=true` to include stale follow-ups on closed leads.

## Indexes (038)

- `idx_leads_next_follow_up_active` on `leads(next_follow_up_at)` WHERE not deleted and date present
- `idx_leads_assigned_next_follow_up_active` on `(assigned_to, next_follow_up_at)` same predicate

Existing indexes are unchanged.

## Frontend

`/follow-up` (existing menu) loads `leadService.getFollowUpQueue` only. Completing a follow-up still uses Step 4A `POST /api/leads/:id/follow-up`. Dashboard is not changed in this PR.
