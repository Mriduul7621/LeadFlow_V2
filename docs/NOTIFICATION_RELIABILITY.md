# Notification Reliability

> Server-side idempotent notification delivery for LeadFlow business events.

## Before / After Architecture

### Before (PR #42 and earlier)

```
Browser                              Server
  │                                    │
  │ POST /api/leads (assignment) ────►│  commit lead
  │◄── 200 OK ───────────────────────│
  │                                    │
  │ ┌────────────────────────────────┐ │
  │ │ void sendHierarchyNotifications│ │  ← fire-and-forget
  │ │   POST /api/notifications ×N   │─┼─► INSERT notification
  │ │   (one per manager in chain)   │ │  INSERT notification
  │ │   .catch(() => {})             │ │  ... (best-effort)
  │ └────────────────────────────────┘ │
  │                                    │
```

**Problems:**
- Browser must stay open for notifications to be created
- Each manager = a separate `POST /api/notifications` round-trip
- No idempotency (client-generated random IDs)
- Hierarchy resolution is client-side (loads all users into browser)
- Notification failure is silently swallowed
- `POST /api/notifications` cross-user boundary is permission-gated but
  not coupled to the authoritative business mutation

### After (this PR)

```
Browser                              Server
  │                                    │
  │ POST /api/leads (assignment) ────►│ BEGIN
  │                                    │   commit lead upsert
  │                                    │   SAVEPOINT notification_sp
  │                                    │     resolve upline from users.manager_id
  │                                    │     INSERT notification (assignee)
  │                                    │     INSERT notification ×N (managers)
  │                                    │   RELEASE SAVEPOINT
  │                                    │ COMMIT
  │◄── 200 OK ───────────────────────│
  │                                    │
  │ (no separate notification call)    │
```

**Improvements:**
- Notifications are created in the SAME database transaction as the lead
- Hierarchy resolution is server-authoritative (users.reporting_chain / manager_id)
- Idempotency key prevents duplicate notifications on retry
- SAVEPOINT isolates notification failure from lead save
- No client-side fire-and-forget pattern
- No N+1 API round-trips from the browser

## Authoritative Notification Producers

| Producer | Location | Trigger |
|----------|----------|---------|
| Lead assignment | `POST /api/leads` (production.routes.ts) | New lead created with assignedTo |
| Lead reassignment | `POST /api/leads` (production.routes.ts) | Existing lead assignedTo changes |
| Lead unassignment | `POST /api/leads` (production.routes.ts) | Existing lead assignedTo set to empty |
| Generic self-service | `POST /api/notifications` | Client creates own notification |
| Cross-user (legacy) | `POST /api/notifications` | Requires leads.assign/transfer |

## Event Matrix

| Event | Mutation | Producer | Recipients | Failure Mode | Server-Side Owner |
|-------|----------|----------|------------|--------------|-------------------|
| Lead assigned | `POST /leads` | Server (transaction) | Assignee + upline managers | SAVEPOINT isolation; lead saves even if notification fails | `POST /leads` handler |
| Lead reassigned | `POST /leads` | Server (transaction) | New assignee + upline managers | SAVEPOINT isolation | `POST /leads` handler |
| Lead unassigned | `POST /leads` | Server (transaction) | None (no recipient) | N/A | `POST /leads` handler |
| Follow-up scheduled | `POST /leads/:id/follow-up` | None (no notification) | N/A | N/A | Not in scope |
| Scheduled activity created | `POST /scheduled-activities` | None (no notification) | N/A | N/A | Not in scope |
| Scheduled activity completed | `POST /scheduled-activities/:id/complete` | None (no notification) | N/A | N/A | Not in scope |
| Pipeline Locked | `POST /leads/:id/follow-up` | None (no notification) | N/A | N/A | Not in scope |
| Converted | `POST /leads/:id/follow-up` | None (no notification) | N/A | N/A | Not in scope |
| Bulk import | `POST /leads/bulk` | None (no notification) | N/A | N/A | Not in scope |

### Decision: Events NOT generating notifications

- **Follow-up/status changes**: No notification was generated before; not
  inventing new notification types without a business requirement.
- **Scheduled activity lifecycle**: No notification was generated before.
- **Pipeline Locked / Converted**: Status changes on follow-up; no notification.
- **Bulk import**: Client-side code never generated notifications for bulk
  imports. Bulk operations assign many rows; N×upline notification inserts
  would be expensive. Deferred until a business requirement exists.

## Transactional vs Non-Critical Semantics

### A. BUSINESS-CRITICAL (transactional)

**Lead assignment/reassignment notifications** are classified as
business-critical. They are created in the SAME PostgreSQL transaction as the
lead upsert, using a SAVEPOINT for isolation:

- If notification INSERT fails (e.g., missing table), the SAVEPOINT is rolled
  back and the lead save COMMITs normally.
- If the entire lead transaction fails (e.g., constraint violation), both the
  lead save and the notification inserts are rolled back.

This means: the notification is GUARANTEED to exist if the lead assignment
committed. But a notification infrastructure failure does NOT prevent the lead
from being saved.

### B. NON-CRITICAL

Generic `POST /api/notifications` (client self-service) remains outside a
business transaction. These are informational only.

## Idempotency Design

### Key Construction

```
event_type : entity_id : recipient_id : version
```

Examples:
```
lead-assigned:assign_1726234567:user-uuid-1234:v1
lead-reassigned:assign_1726234568:manager-uuid-5678:v1
```

### DB Constraint

```sql
CREATE UNIQUE INDEX idx_notifications_idempotency_key
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

- Partial index: only enforced for system-generated notifications (non-null key)
- Client-created generic notifications (null key) are unaffected
- ON CONFLICT DO NOTHING ensures retries are safe

### Retry Safety

| Scenario | Result |
|----------|--------|
| Client retries assignment after timeout | Server re-runs upsert + notifications; ON CONFLICT skips duplicates |
| Same business event processed twice | Same idempotency keys → duplicate inserts silently skipped |
| Duplicate notification INSERT | DB unique constraint prevents duplicate row |

## Recipient Resolution

### Server-side hierarchy traversal

1. Read `users.reporting_chain` (JSONB array of employee_ids from direct
   manager to CEO) for the assignee.
2. Resolve all chain members in ONE query:
   ```sql
   SELECT id, employee_id, is_active
   FROM users
   WHERE UPPER(employee_id) = ANY($1::text[])
     AND is_active = TRUE
   ```
3. If `reporting_chain` is empty, fall back to walking `users.manager_id`
   (bounded to 20 levels).
4. De-duplicate via a visited set.
5. Skip inactive users.
6. Skip the starting user and the actor (if excluded).

### Cycle prevention

- A `visited` set (uppercased IDs) prevents revisiting any user.
- Bounded to 20 levels maximum.
- Pre-existing corrupt cycles are detected and traversal stops.

## Hierarchy Fan-out Rules

- **Scope preserved**: Only managers in the assignee's `reporting_chain` or
  `manager_id` walk are notified.
- **Active only**: `is_active = FALSE` users are skipped.
- **No broadcast**: Only the direct chain upward, not the entire org.
- **De-duplication**: Each recipient appears at most once per event.
- **No unlimited traversal**: Bounded to 20 levels (matching the existing
  company ladder max of ~5-6 levels).

## Retry Behavior

- Server-side notification creation uses `ON CONFLICT DO NOTHING` on the
  idempotency key — retries are inherently safe.
- The client no longer needs to retry notification creation.
- If the lead save itself fails, the client retries the entire `POST /leads`
  request, which will re-attempt both the upsert and the notification creation.

## Failure Behavior

### Notification INSERT failure (SAVEPOINT isolation)

```
BEGIN
  lead upsert                    ← succeeds
  SAVEPOINT notification_sp
    notification INSERT          ← fails (e.g., table missing)
  ROLLBACK TO SAVEPOINT          ← undoes only the notification INSERT
  RELEASE SAVEPOINT
COMMIT                           ← succeeds (lead is saved)
```

The lead save succeeds. The notification is lost. A retry from the client
will re-attempt both.

### Lead upsert failure

```
BEGIN
  lead upsert                    ← fails (e.g., constraint violation)
ROLLBACK                         ← everything rolls back
```

No lead state change, no notifications.

### Entire transaction failure (e.g., connection lost)

Client receives an error and may retry. Idempotency keys prevent duplicates.

## Generic POST /api/notifications Policy

| Scenario | Permission Required |
|----------|-------------------|
| Self-directed notification | `requireAuth` only |
| Cross-user notification | `leads.assign` OR `leads.transfer` |
| System-generated (server-side) | Inherited from business mutation (e.g., `leads.assign` for assignment) |

The generic endpoint is NOT removed. It remains for:
- Client self-service (e.g., local UI notifications)
- Backward compatibility

But it is NOT the authority for business notifications. Those are server-side.

## Bulk-Operation Decision

**Bulk lead import (`POST /leads/bulk`) does NOT generate notifications.**

Rationale:
- Client-side code never generated notifications for bulk imports before.
- A bulk import of 5000 rows would create 5000 × (1 + N managers) notification
  INSERTs, which is expensive.
- No business requirement for bulk import notifications has been expressed.

If bulk import notifications are needed in the future, they should use:
- Batch INSERT with UNNEST
- Bounded recipient resolution
- Idempotency keys per row/recipient

## Cache Interaction

- PR #40 behavior is preserved: notification cache is user-scoped via `localDb`.
- Cache writes only happen after server confirms persistence.
- 401/403/404 do not fall back to stale data.
- After server-side notification mutations succeed, the client cache refreshes
  normally via `getNotifications()`.

## Known Limitations

1. **No external queue**: Serverless memory is NOT a durable queue. If the
   server process dies between the SAVEPOINT and COMMIT, the notification may
   be lost. This is acceptable because:
   - The idempotency key means a client retry will create it.
   - PostgreSQL transactions are atomic within a connection.

2. **No notification for non-assignment events**: Follow-up, scheduled
   activity, pipeline, and conversion events do not generate notifications.
   This matches pre-existing behavior.

3. **No bulk import notifications**: Intentionally deferred.

4. **No email/SMS/push**: Out of scope per requirements.

## Deferred Work

- Notification for follow-up/scheduled activity events (if business requires)
- Bulk import notification batching
- Notification delivery status tracking
- Dead-letter queue for persistent notification failures
- Production observability for notification creation metrics

## Migration Details

### Migration 040: `040_notification_reliability.ts`

**Columns added:**
- `event_type VARCHAR(100)` — nullable, classifies the business event
- `idempotency_key VARCHAR(500)` — nullable, stable dedupe key

**Indexes added:**
- `idx_notifications_idempotency_key` — UNIQUE partial index on
  `idempotency_key WHERE idempotency_key IS NOT NULL`
- `idx_notifications_event_type` — index on `event_type WHERE event_type IS NOT NULL`

**Backward compatible:**
- Both columns are nullable; existing rows remain readable.
- Generic `POST /api/notifications` leaves both NULL.
- No destructive data rewrite.

## Query/Performance Approach

### Highest-volume path: lead assignment notification

For a single assignment:
- 1 query to read `users.reporting_chain` for the assignee
- 1 query to resolve upline managers (batch `ANY()`)
- 1-6 notification INSERTs (assignee + ~5 managers)

No N+1 user lookups. Upline is resolved in a single batch query.

### Bulk assignment (if added in future)

Would use:
```sql
INSERT INTO notifications (...)
SELECT ... FROM unnest($1, $2, $3, ...) AS t(user_id, recipient_key, title, message, ...)
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
```

## Confirmation

- ✅ No external queue/service (Redis, message broker, etc.) was added
- ✅ No production data was modified
- ✅ No paid services were added
- ✅ No email/SMS/push integrations were added
- ✅ All existing PR #39, #40, #42 behavior is preserved
- ✅ Serverless memory is NOT used as a durable queue
