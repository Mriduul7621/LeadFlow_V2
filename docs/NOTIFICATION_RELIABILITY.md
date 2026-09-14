# Notification Reliability

> Server-side idempotent notification delivery for LeadFlow business events.

## Architecture — Option A: Transactional Atomicity

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

### After (this PR — Option A: Transactional Atomicity)

```
Browser                              Server
  │                                    │
  │ POST /api/leads (assignment) ────►│ BEGIN
  │                                    │   lead upsert
  │                                    │   assignment history insert
  │                                    │   resolve upline from users.manager_id
  │                                    │   INSERT notification (assignee)
  │                                    │   INSERT notification ×N (managers)
  │                                    │ COMMIT  ← all-or-nothing
  │◄── 200 OK / 500 failure ─────────│
  │                                    │
  │ (no separate notification call)    │
```

**Key properties:**
- Lead assignment, assignment history, and notification rows are all in
  the **same PostgreSQL transaction** — no SAVEPOINT to isolate notifications.
- If any notification INSERT fails, the entire transaction (lead + history +
  notifications) **rolls back** and the client receives a 500 error.
- No partial commits: the authoritative business event cannot commit while
  its required notification is permanently lost.

## Failure Semantics

| Failure point | Outcome |
|---|---|
| Lead upsert fails | ROLLBACK. Client gets 500. No lead change. |
| Assignment history insert fails | ROLLBACK. Client gets 500. No lead change. |
| Notification INSERT fails | ROLLBACK. Client gets 500. No lead change, no history, no notifications. |
| Network drops before COMMIT | PostgreSQL ROLLBACK. No data persisted. |
| Network drops after COMMIT | All data (lead + history + notifications) persisted atomically. |
| Client retries same request | Idempotency keys ensure at-most-once notification per recipient. |

## Idempotency

### Key format

```
{event_type}:{assignment_history_id}:{recipient_user_id}:v1
```

The `assignment_history_id` is **deterministic**, derived from business state:

```
assign_{leadCode}_{previousOwnerId}_{newOwnerId}
```

This means retrying the same logical assignment request produces the same
assignment history ID and therefore the same notification idempotency keys.
The DB unique partial index enforces at-most-once delivery even if
application-level dedup is bypassed.

### Event types

| Scenario | Event type |
|---|---|
| First assignment (lead was unassigned) | `lead-assigned` |
| Reassignment (lead was already assigned to someone) | `lead-reassigned` |

## What Changed in the Client

`sendHierarchyNotifications()` in `leadService.ts` has been **fully deleted**.
Both call sites (in `createLead` and `updateLead`) are removed. The browser
no longer fires any notification requests — all notification delivery is
server-side and transactional.

## Database Schema

### Notifications table

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  recipient_key VARCHAR(255),
  title VARCHAR(255) NOT NULL,
  message TEXT,
  type VARCHAR(50) DEFAULT 'info',
  event_type VARCHAR(100),
  idempotency_key VARCHAR(500),
  reference_type VARCHAR(100),
  reference_id UUID,
  lead_code VARCHAR(50),
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Unique partial index (final dedupe boundary)

```sql
CREATE UNIQUE INDEX idx_notifications_idempotency_key
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

## Test Coverage

| Test | What it proves |
|---|---|
| M | Notification INSERT failure → HTTP 500 (no SAVEPOINT to swallow it) |
| N | Source guard: no SAVEPOINT in notification path, direct await, no catch |
| N2 | Deterministic assignment history ID (no Date.now()) |
| O | Retry after success produces no duplicate notifications |
| P | Same logical assignment → same idempotency keys across retries |
| Q | Reassignment to different user → new idempotency keys; retry → no duplicates |
| R | DB unique constraint enforces at-most-once (final dedupe boundary) |
| S | Notifications have server-derived event_type and idempotency_key |

## What This PR Does NOT Change

- Generic `POST /api/notifications` endpoint is preserved and remains
  permission-gated.
- RBAC, Data Visibility, feature access, auth, and hierarchy are unchanged.
- Lead Quality scoring is unchanged.
- No Redis, message brokers, paid services, SMS, email, or push added.

## Authoritative Notification Producers

All assignment/reassignment notifications are created by `production.routes.ts`
in the POST /leads handler, inside the same DB transaction as the lead upsert.

The client-side `sendHierarchyNotifications()` function has been fully deleted.

## Event Matrix

| Event | Trigger | Recipients | Event type |
|---|---|---|---|
| Lead assigned | POST /leads with assignedTo | Assignee + upline managers | `lead-assigned` |
| Lead reassigned | POST /leads changes existing assignment | Assignee + upline managers | `lead-reassigned` |
| Lead unassigned | POST /leads with blank assignedTo | Previous owner's managers | `lead-unassigned` |

## Recipient Resolution

Recipients are resolved server-side using `resolveUplineRecipients()` from
`NotificationService.ts`. It walks `users.manager_id` from the assignee upward
to the CEO. Falls back to `users.reporting_chain` JSONB column when available.
Traversal is bounded to 20 levels and cycle-safe.

## Generic POST /api/notifications

The generic `POST /api/notifications` endpoint is preserved and remains
permission-gated. It is not used for assignment notifications — those are
created directly inside the business transaction.

## Bulk Import

Bulk lead import (`POST /api/leads/bulk`) does not create assignment
notifications. Bulk imports may assign leads but notification fan-out is
deferred to avoid transaction timeouts on large batches.

## Cache

Notification reads (`GET /api/notifications/users/:employeeId`) query the
database directly. No in-memory cache layer. Reads are scoped by the caller's
Data Visibility.

## Known Limitations

- **Serverless memory is NOT a durable queue.** If the serverless function
  crashes between BEGIN and COMMIT, PostgreSQL automatically rolls back.
  No data is lost, but the client must retry.
- Notification creation increases transaction duration by the number of
  upline managers. For very deep hierarchies (>10 levels), consider batch
  notification inserts.
- The idempotency key uses `v1` as version. Schema changes to notification
  format may require a version bump.
