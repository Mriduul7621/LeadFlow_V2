# Notification Reliability — Server-Side Idempotent Business Delivery

> Scope: production business-notification delivery. Introduced by
> `reliability: move business notifications to server-side idempotent delivery`.
> Companion documents: `docs/RBAC_FALLBACK_SAFETY_AUDIT.md` (PR #40 read
> boundaries), `docs/PRODUCTION_READINESS.md`, `docs/FLEXIBLE_REPORTING_HIERARCHY.md`.

---

## 1. Before / after architecture

### Before (client-driven, fire-and-forget)

```
Browser                                   PostgreSQL
  │  POST /api/leads  (assignment)  ────────►  upsert lead (+ merged assignment_history)
  │  ◄──────────────────────── 200 ──────────
  │
  ├─ void sendHierarchyNotifications(...)          ← fire-and-forget
  │    ├─ GET  /api/users                          (load whole directory)
  │    ├─ POST /api/notifications  → assignee      (one round trip each)
  │    ├─ POST /api/notifications  → manager 1
  │    └─ POST /api/notifications  → manager N
  │         .catch(...) → warning toast only
```

Failure modes:
- tab closed / network drop / page navigation after the save → notifications
  lost forever, nobody notices;
- every recipient was a separate best-effort request (N+1 fan-out);
- recipients were derived from the client-side users list;
- the "actor" name in the message came from the client payload;
- retries (double submit) duplicated notifications; nothing deduped.

### After (server-owned, transactional, idempotent)

```
Browser                                   PostgreSQL
  │  POST /api/leads  (assignment)  ────────►  BEGIN
  │                                             ├─ upsert lead (+ server-merged assignment_history)
  │                                             ├─ WITH RECURSIVE resolve assignee + upline (1 query)
  │                                             ├─ INSERT notifications … ON CONFLICT (event_key) DO NOTHING (1 query)
  │                                             └─ COMMIT     (any failure → ROLLBACK → save fails)
  │  ◄──────────────────────── 200 ──────────
  │
  └─ (nothing else). Notification reads/refresh are display-only.
```

**Serverless memory is NOT a durable queue.** There is no in-process retry
queue, no timer, no outbox-worker and no background task anywhere in this
design: every notification row is either part of the committed PostgreSQL
transaction or it does not exist. Retries are client-observable HTTP retries,
made safe by idempotency — not by process memory.

## 2. Source-of-truth matrix (audited)

| # | Event | Business mutation (authoritative) | Producer BEFORE | Recipients | Failure mode BEFORE | Owner AFTER |
|---|-------|-----------------------------------|-----------------|------------|---------------------|-------------|
| 1 | Lead assigned (create with assignee) | `POST /api/leads` | **Browser** `leadService.createLead` → `sendHierarchyNotifications` (fire-and-forget) | assignee + active upline chain | lost if tab closed; duplicated on double submit | **Server, transactional** in `POST /api/leads` |
| 2 | Lead reassigned / transferred | `POST /api/leads` (update path) | **Browser** `leadService.updateLead` (same helper) | new assignee + their active upline chain | same | **Server, transactional** in `POST /api/leads` |
| 3 | Lead unassigned | `POST /api/leads` (`assignedTo: ''`) | none (client guard required a truthy assignee) | — | n/a | unchanged — **intentionally silent** (no notification was ever produced; none invented) |
| 4 | Follow-up scheduled | `POST /api/leads/:id/follow-up` | none | — | n/a | unchanged — out of scope (no existing producer to move) |
| 5 | Meeting / scheduled activity created | `POST /api/scheduled-activities` | none | — | n/a | unchanged — out of scope |
| 6 | Scheduled activity completed / cancelled | `POST /api/scheduled-activities/:id/complete` / `/cancel` | none | — | n/a | unchanged — out of scope |
| 7 | Lead moved to Pipeline Locked | follow-up route (status move) | none | — | n/a | unchanged — out of scope |
| 8 | Lead Converted | follow-up route (status move) | none | — | n/a | unchanged — out of scope |
| 9 | Manager / upline alerts | (part of 1–2 only) | **Browser loop, one POST per manager** | see §5 | silent loss / duplicates | **Server** (recursive graph resolution) |
| 10 | Bulk lead import / bulk assign rows | `POST /api/leads/bulk` | none (deliberately — a 5000-row import never fanned out one HTTP request per row) | — | n/a | unchanged — see §9 |
| 11 | Lead Pool batch (re)assign | client loop of `POST /api/leads` (per selected lead) | Browser (via 2) | per-lead, as rows save | same as 1–2 | **Server** — each lead's own transaction owns its notifications; the client loop still issues ONE request per lead and zero notification requests |
| 12 | Self-service / manual notification | `POST /api/notifications` | Server | self (or grant-holding actor for cross-user) | error surfaced | unchanged (policy hardened wording, §8) |
| 13 | Notification reads, mark-read, clear | `GET/POST/DELETE /api/notifications*` | Server | user-scoped | PR #40 policy | unchanged |
| 14 | Account delete cleanup | `DELETE /api/users/:id` | Server (`DELETE FROM notifications …`) | — | — | unchanged |
| 15 | User bulk import | `POST /api/users/bulk/commit` | none | — | n/a | unchanged — no notification requirement exists |

Only events 1, 2 and (their upline component) 9 were **moved**. Everything else
kept its established behavior; absent notification producers were intentionally
NOT invented (no new business notification types).

## 3. Authoritative producers after this PR

- `POST /api/leads` (single-lead create/update) — the ONLY producer of
  `lead-assigned` system notifications (assignee + upline). Both runtimes
  (standalone `server.ts`, Vercel `api/index.ts`) mount the same router, so
  serverless inherits the behavior with no per-runtime code.
- `POST /api/notifications` — self-service/manual notifications only
  (plus the retained, tightly-gated cross-user path; §8).
- Dev-demo mode (`fallbackStore`, no `DATABASE_URL`) mirrors the same recipient
  rules in memory for local usability only — it promises no durability, and
  never runs in production.

## 4. Atomicity / transaction semantics per event

Notifications are classified per the PR brief:

| Event | Class | Semantics |
|-------|-------|-----------|
| Lead assigned / reassigned / transferred (incl. upline alerts) | **A. business-critical, transactional** | lead upsert + assignment-history merge + notification batch insert run in ONE `BEGIN…COMMIT`. If the notification insert fails, the WHOLE save rolls back: the client gets an error, no lead state and no assignment history is persisted, and no orphan notification exists. Retry = replay of the original request; idempotency keys make the replay safe (§6). |
| Manual/self-service notification (`POST /api/notifications`) | B. non-critical, single statement | no business state to stay consistent with; the API returns the row or an error — never a locally-"successful" write. |
| Follow-up / scheduled activity / status moves / bulk import | — | produce no notifications (established behavior; nothing changed) |

Why class A instead of a durable-pending-record: the assignment is useless if
the assignee is never told, and the current stack has exactly one reliable
durable substrate — PostgreSQL itself. A pending/outbox table plus a worker
would only add machinery that cannot run (serverless) without a scheduler, and
an external queue is out of scope by design. Same-transaction is therefore the
simplest safe PostgreSQL-native choice. No silent mixing of semantics exists:
the only moved producer is class A.

## 5. Recipient resolution (server-side; client-sent recipients ignored)

For a system event the recipients are derived exclusively from server state:

1. **Assignee** — `leads.assigned_to` as written by the mutation itself
   (already resolved from `users` by the existing `resolveAssignedTo`
   anti-spoofing path; a client-supplied `assignedTo` that does not resolve
   400s before any side effect).
2. **Upline chain** — one bounded `WITH RECURSIVE` query over the
   authoritative `users.manager_id` graph (see `resolveLeadAssignmentUpline`).

Rules (preserved exactly from the removed client loop):

- the chain starts at the assignee and walks `manager_id` upward;
- only managers with `is_active` true AND `account_status <> 'INACTIVE'` are
  walked; `account_status` is read through `to_jsonb` so pre-035 legacy shapes
  without the column keep working (missing column ⇒ not inactive, exactly the
  035 default);
- traversal **stops** at the first inactive/missing manager — the chain above
  that point is NOT widened (matching the client `break`);
- recipients are deduped by user id (a recursive `path` array — a user can be
  in the chain once), so cycles (A↔B, self-loops) terminate immediately;
- deterministic bound `NOTIFICATION_MAX_UPLINE_DEPTH = 32` on top of
  cycle-detection — no unlimited org broadcast is possible;
- how many levels are notified: the entire active chain to the root — the
  established (pre-migration) business rule; unchanged;
- inactive users above a *reachable active* link are skipped the same way the
  client did (never notified); the assignee themselves is always notified
  (the assignment targets them even if inactive — matching the old behavior;
  the assignment route is the place to block inactive assignees, and blocking
  there would be a business-rule change out of scope here);
- no read of `users.reporting_chain` / JSONB denormalizations — `manager_id`
  is authoritative; flexible skip-level reporting (PR #37 rules) only shapes
  which edges may exist, and fan-out follows whatever the graph says;
- visibility is never widened: a caller who cannot mutate the lead cannot
  trigger its notifications at all (authorization precedes the side effect).

## 6. Idempotency design

New nullable columns on `notifications` (migration `040_notification_idempotency.ts`):

- `event_key VARCHAR(180)` — stable identity of a system-generated row;
- `event_type VARCHAR(60)` — coarse class (`lead-assigned`);
- `CREATE UNIQUE INDEX uniq_notifications_event_key ON notifications(event_key) WHERE event_key IS NOT NULL;`

Key shape:

```
lead-assigned:<leadCode>:<assignmentSeq>:<recipientKey>
```

- `<leadCode>` — canonical `leads.lead_code` (the API identity used by reads);
- `<assignmentSeq>` — length of the lead's `assignment_history` JSONB array
  **after** this save's server-side merge (0 for a first assign whose record
  carries an empty history). History grows monotonically, so every distinct
  business event has a distinct seq, while a rollback+retry recomputes the
  identical seq and therefore the identical key;
- `<recipientKey>` — recipient `employee_id` (one row per event × recipient).

Deliberately excluded: timestamps, random UUIDs, request ids — the key is
re-derived from DB state, so *any* client (including a hostile/retry-prone
one) lands on the same identity for the same business event.

Insert strategy: a single multi-row `INSERT … ON CONFLICT (event_key)
WHERE event_key IS NOT NULL DO NOTHING` — duplicates are collapsed by the
database, not by an in-memory check. Manual rows (`POST /api/notifications`)
write `event_key NULL` and are untouched by the constraint (old rows remain
readable; every read is `SELECT n.*` based and unchanged).

Replay outcomes (proven by the test suite):

| Scenario | Outcome |
|----------|---------|
| client retries assignment after timeout, attempt 1 rolled back | same recomputed keys; exactly one row per recipient |
| client retries after a LOST response (attempt 1 committed) | assignment no longer "changed" → no event produced at all |
| same business event processed twice (double submit, concurrent) | second transaction's batch hits the unique index → `DO NOTHING` |
| direct duplicate insert attempt | unique violation `23505` (proven); the delivery statement's ON CONFLICT variant inserts nothing |
| route "internal retry" | none implemented — one attempt inside one transaction; safety comes from the key, not from retry loops |

## 7. Retry / failure behavior

- **No infinite retry loop, anywhere.** Neither the server (no internal
  retries) nor the client (no notification retry calls at all) retries
  anything beyond the user re-submitting the save.
- **Failure injection is a supported test path:** with a `BEFORE INSERT`
  trigger raising on `notifications`, the save returns 500 and BOTH the lead
  row and the assignment history remain byte-identical, with zero orphan rows
  (`notification-reliability-integration.test.ts`, test 8-9). After repairing,
  the retry delivers exactly once per recipient.
- Errors are logged server-side (`[leads] lead save rolled back for <code>: <message>`)
  with ids and the database error message only — no secrets, no payload dumps.
  Audit-log conventions are untouched (lead assignment never wrote audit_logs
  before; inventing one here would change established behavior).

## 8. Generic `POST /api/notifications` policy

Unchanged in behavior, restated here as the canonical policy:

- **self-directed** (`userId` is the caller) — authenticated self-service,
  any user, no business permission needed;
- **arbitrary cross-user** — still gated to the canonical routing grants
  `leads.assign` OR `leads.transfer` (PR #40). It cannot become a backdoor
  around business APIs: it never touches lead state, its rows carry no
  `event_key`, and the authoritative business fan-out no longer flows
  through it;
- after the server owns business events, the browser needs NO extra
  notification permission for assignment — authorization for the notification
  side effect inherits the lead mutation's permission entirely
  (`leads.create`/`leads.edit` + `leads.assign`/`leads.transfer` + Data
  Visibility + assignment-scope checks, all evaluated before any write).

`GET /api/notifications/users/:userId` (self/admin), `POST …/read`,
`read-all`, `DELETE` and `GET /api/notifications/leads/:leadId`
(leads.view + actual lead visibility, 404 no-existence-leak) are unchanged.

## 9. Bulk-operation behavior

- `POST /api/leads/bulk` (spreadsheet import / bulk assign endpoint):
  **no notifications before, none after** — a 5000-row import never issued
  thousands of notification requests and still does not. This is a deliberate
  documented decision: adding per-row fan-out would be a new business feature
  (explicitly out of scope). If a future requirement needs it, the shape is
  already prepared: rows are inserted in one transaction; a set-based
  `INSERT … SELECT … FROM unnest(...) ON CONFLICT DO NOTHING` can stamp the
  same `event_key` identity with zero per-row round trips.
- Lead Pool "batch assign" remains a bounded client loop of single-lead saves
  (established PR #34 behavior). Each lead's save now performs exactly:
  1 upsert + 1 upline-resolution query + 1 batched multi-recipient insert +
  1 caller-name PK lookup — constant per lead, independent of recipient
  count (no N+1 within an event either).

## 10. Performance notes (highest-volume path)

Single notified lead save ⇒ **at most +3 added queries**, each O(1) round
trips: `users.manager_id` recursive CTE (depth-bounded, index-friendly),
caller display name (PK lookup), one multi-row notification INSERT.
Recipient count never adds queries; there are no per-recipient loops anymore
(the removed client fan-out cost `2 + recipients` HTTP requests and the whole
users directory fetch). Notification reads keep using the existing
`recipient_key` index from 035; `event_key` uniqueness rides its own partial
index.

## 11. Local cache interaction (PR #40 preserved)

- `localDb` notification cache stays **user-scoped**; the cache is never the
  authority; client writes go through the API first and only refresh the cache
  after the server confirms;
- 401/403/404 never fall back to stale notification data (shared
  `offlinePolicy`);
- after server-side business notification commits, inboxes refresh through the
  normal display path (AppLayout: initial fetch + 60 s visibility-paused
  refresh + panel-open refresh). The client no longer performs any *production*
  of business notifications — `src/modules/leads/services/leadService.ts`
  contains zero references to the notification API (enforced by a source-guard
  test walking the entire `src/` tree);
- no raw global `localStorage` notification writes were reintroduced.

## 12. Known limitations / deferred work

1. Committed-but-lost-response retries on the *initial create* with a client
   that changes `leadCode` per attempt would produce a second event (identity
   is lead_code-anchored by design). Callers already key saves by lead code;
   no API contract change was made to police it.
2. Demo/fallback mode has no durable dedupe (in-memory by definition, dev-only).
3. Soft-deleted→resurrected lead re-created with the identical history length
   can collapse to an already-used event key ("at most once" wins over
   "exactly once" in this exotic replay window; documented rather than
   papered over with extra state).
4. No email/SMS/push delivery, no external queue/broker, no outbox worker,
   no notification taxonomy expansion — all explicitly out of scope; the
   `event_type` column exists so a future channel can subscribe to classes
   without reshaping rows.
5. Full observability (metrics, DLQ dashboards) intentionally deferred.

## 13. Verification

Run: `npm test -- --run` — includes
`server/tests/notification-reliability-integration.test.ts` (19+ behavioral
tests above), the updated `perf-latency-hardening` client guard (K), and all
PR #37–#42 suites. Schema check after migration replay:
`npm run verify:db-schema` against a test database (expect the
`notifications` table plus 040's columns; `verify:db-schema` lists tables
only and needed no expectation change — no new tables were added).
