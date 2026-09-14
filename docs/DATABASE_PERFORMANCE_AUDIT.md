# Database Performance Audit — Evidence-Based Indexes & Query-Shape Fixes

Audit of LeadFlow's production PostgreSQL query patterns. Scope: add ONLY
evidence-based indexes and narrowly-scoped query-shape improvements that
materially reduce latency for real high-frequency paths, while preserving
correctness, permissions, visibility, transactional behavior, and write
performance.

- Baseline: `main` @ `70a8d40` (PR #45 observability merged)
- Implemented in: migration **041**, `production.routes.ts`,
  `leadQualitySignals.ts`, `runMigrations.ts`, `verify-db-schema.mjs`
- Isolated plan evidence: `node scripts/db-performance-audit.mjs`
  (PGlite, synthetic data — **never** production)
- Regression proof: `server/tests/db-performance-audit.test.ts` (24 tests)

---

## 1. Methodology

1. **Inspect first, change nothing**: every migration (001–040), the schema
   files, `production.routes.ts` (all endpoints), the dashboard aggregation,
   follow-up queue, scheduled activities, lead quality signals, hierarchy /
   visibility CTEs, notifications, bulk import/assignment, RBAC lookups and
   the PR #45 observability hooks were read end-to-end before any edit.
2. **Build the query inventory** (matrix below) with the exact predicate /
   join / order / pagination shape of every hot path.
3. **Prove the gap with plans**: isolated PGlite database, production-shaped
   schema + full migration suite, realistic synthetic volumes
   (200–40k rows per table), `EXPLAIN ANALYZE` before/after. PGlite is real
   PostgreSQL semantics but its cost calibration differs from Supabase —
   timings are labeled synthetic everywhere and are never treated as
   production numbers.
4. **Change only what evidence justifies**, then prove result-set identity
   (legacy vs shipped SQL over the same synthetic data) and plan shape with
   automated tests.

---

## 2. Audit matrix (hot paths)

Legend — GAP codes: `CAST` = function/cast on indexed column defeats index;
`NOIDX` = no usable index; `SUBPLAN` = hashed SubPlan poisons estimates;
`OK` = covered. ACTION codes: `SHAPE` = query-shape fix, `INDEX` = new
index, `NONE` = intentionally unchanged.

| # | Query / endpoint | Table(s) | Filters | Joins | Order / pagination | Current indexes | Gap | Action | Rationale | Risk |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `GET /api/dashboard` — metric aggregate | leads | is_deleted, visibility, optional created_at range | — | — | assigned_to, created_by, created_at | `CAST`: visibility used `assigned_to::text = ANY(text[])` → seq scan | `SHAPE` uuid-typed ANY | BitmapOr over existing indexes; identical rows | none — ids are server-resolved users.id |
| 2 | `GET /api/dashboard` — follow-up bucket counts | leads | is_deleted, next_follow_up_at NOT NULL, status <> terminals, visibility | — | GROUP BY bucket | idx_leads_next_follow_up_active | `CAST` (visibility) | `SHAPE` | same as #1 | none |
| 3 | `GET /api/dashboard` — agent breakdown | leads ⋈ users | is_deleted, visibility, optional period | LEFT JOIN users | GROUP BY agent, LIMIT 200 | assigned_to | `CAST` (visibility) | `SHAPE` | same as #1 | none |
| 4 | `GET /api/dashboard` — quality aggregation | leads, lead_activities, scheduled_activities | is_deleted, status <> terminals, visibility; lead_id ANY | — | GROUP BY lead_id | lead_activities(lead_id, created_at DESC); scheduled(lead_id, scheduled_at) | `NOIDX` for open-only scheduled rows; `CAST` visibility | `SHAPE` + `INDEX` (041) | see §5 | none |
| 5 | `GET /api/leads` | leads ⋈ users | is_deleted, created_at range, status, assignedTo, search, visibility | LEFT JOIN users ×2 | created_at DESC LIMIT 5000 | assigned_to, created_by, created_at | `CAST` (visibility + assignedTo) | `SHAPE` | index-served visibility; uuid-guarded assignedTo keeps malformed-input behavior | none |
| 6 | `GET /api/leads/follow-ups` (today/overdue/upcoming/all) | leads ⋈ users, LATERAL lead_activities | is_deleted, next_follow_up_at NOT NULL, terminals, status, assignedTo, date range, visibility | LEFT JOIN users; LATERAL latest activity | next_follow_up_at ASC, LIMIT/OFFSET | idx_leads_assigned_next_follow_up_active (038) existed but was UNUSABLE due to `CAST` | `CAST` | `SHAPE` | unlocks migration 038's partial composite: 7.6 ms → 0.1 ms synthetic | none — assignedFilter.userId is a DB-resolved uuid |
| 7 | `GET /api/scheduled-activities` | scheduled_activities ⋈ leads | leadId, type, status, priority, assignedTo, scheduled_at range, visibility via lead | JOIN leads | scheduled_at ASC, LIMIT/OFFSET | lead_scheduled, scheduled_at, assigned_to | `CAST` (assignedTo, visibility); LOWER() on CHECK-constrained cols | `SHAPE` | sargable equality over the constrained lowercase domain | none — CHECK constraint proves equivalence |
| 8 | Lead Quality planned-action signals (`fetchScheduledQualitySignals`) | scheduled_activities | lead_id ANY, status scheduled | — | MIN(scheduled_at) GROUP BY lead_id | (lead_id, scheduled_at) fetched completed+cancelled history then filtered | `NOIDX` for open-only | `INDEX` (041) + `SHAPE` | see §5 | none |
| 9 | Lead Quality history signals (`fetchActivityQualitySignals`) | lead_activities | lead_id ANY | — | MAX(created_at), filtered COUNTs, GROUP BY lead_id | (lead_id, created_at DESC) | `OK` | `NONE` | plan already bitmap-uses lead_id index | — |
| 10 | `GET /api/notifications/users/:userId` | notifications (+users lookup) | recipient_key / user_id / employee match | subquery into users | created_at DESC | recipient_key, user_id, created_at DESC | `CAST` + `SUBPLAN` (hashed SubPlan estimated ~50% of table at every scale → seq scan) | `SHAPE` (pre-resolve) | three plain equalities, BitmapOr over existing indexes: 5.4 ms → 0.2 ms synthetic | none — employee_id UNIQUE ⇒ subquery returns ≤1 id |
| 11 | read-all / delete notifications | notifications | same as #10 | same | — | same | same | `SHAPE` | same | same |
| 12 | `POST /api/leads/bulk` existing-lead lookup | leads ⋈ users | lead_code ANY, normalized-phone expression, UPPER(email) ANY | LEFT JOIN users, LATERAL normalization | — | lead_code UNIQUE | phone/email normalization is function-wrapped | `NONE` (deferred) | see §7 | — |
| 13 | Visibility resolution (`resolveVisibility`, getDownlineIds) | users | manager_id recursion; department_id; id ANY | recursive CTE | — | idx_users_manager, idx_users_department, PK | `OK` | `NONE` | CTE joins on manager_id (indexed); users table is small | — |
| 14 | Auth login / session / caller lookup | users ⋈ roles | UPPER(employee_id)/UPPER(email) or id | LEFT JOIN roles | LIMIT 1 | UNIQUE employee_id, UNIQUE email | UPPER() defeats unique indexes, but users table is small and lookup is once per request/session | `NONE` | sub-millisecond at org scale; expression index rejected (§7) | — |
| 15 | `hasPermissionCode` | permissions, user_permissions, role_permissions | permission_code; (user_id, permission_id); (role_id, permission_id) | 2 LEFT JOINs | — | permissions UNIQUE code; both grant tables have composite PKs covering equality on both columns | `OK` | `NONE` | single round trip, PK-served, request-memoized | — |
| 16 | Organogram / users list / reporting options | users ⋈ roles ⋈ departments | is_active, role codes, department | LEFT JOINs | full_name | manager/role/department indexes | `OK` | `NONE` | small dimension tables | — |
| 17 | audit-logs list | audit_logs | actor/target/action/created_at | — | created_at DESC | actor, target, action, created_at DESC | `OK` | `NONE` | covered | — |
| 18 | Single-lead workspace ops (GET /leads/:id, follow-up save, delete, quality, activities) | leads, lead_activities, scheduled_activities | lead_code OR id | — | LIMIT 1 / FOR UPDATE | leads PK + lead_code UNIQUE | `CAST` on PK branch (`id::text`) | `SHAPE` | PK-served dual lookup, identical result set | none (canonical-uuid guard) |
| 19 | Single scheduled-activity ops (view/update/complete/cancel/delete) | scheduled_activities ⋈ leads | sa.id | — | LIMIT 1 / FOR UPDATE | scheduled_activities PK | `CAST` on PK | `SHAPE` | same | same |
| 20 | Notification mark-read / lead-scoped history | notifications | n.id; lead_code OR reference_id | LEFT JOIN users | created_at DESC | PK; recipient_key | `CAST` on PK / redundant branch | `SHAPE` | same | same |

---

## 3. Current index inventory (before this change)

### leads (write-heavy: status, assignment, follow-ups, imports)
| Index | Columns / predicate | Notes |
|---|---|---|
| leads_pkey | id | PK |
| leads_lead_code_key | lead_code UNIQUE | upsert conflict target |
| idx_leads_code | lead_code | **redundant** with UNIQUE constraint (§6) |
| idx_leads_mobile / _email | mobile / email | bulk-import matching |
| idx_leads_product / _campaign / _status | fk columns | reference filters |
| idx_leads_assigned_to / _assigned_by | assigned_to / assigned_by | visibility BitmapOr |
| idx_leads_source / _priority / _district / _division | business filters | low-cardinality; retained (documented) |
| idx_leads_next_follow_up / _last_contacted | timestamps | queue/recency |
| idx_leads_created_by / _created_at (DESC) | creator / recency | visibility + list ordering |
| idx_leads_deleted | is_deleted | low value, retained (documented) |
| idx_leads_assignment_status | (assigned_to, status_id) WHERE is_deleted=FALSE | status_id-era path |
| idx_leads_followup_active | next_follow_up_at WHERE is_deleted=FALSE | near-subsumed (§6) |
| idx_leads_current_status | current_status WHERE is_deleted=FALSE | 035 |
| idx_leads_next_follow_up_active | next_follow_up_at WHERE is_deleted=FALSE AND next_follow_up_at IS NOT NULL | 038 |
| idx_leads_assigned_next_follow_up_active | (assigned_to, next_follow_up_at) WHERE same | 038 — **existed but unusable** before this PR (text casts) |
| idx_leads_custom_fields / _tags | GIN | JSON search |

### users / RBAC
users: PK, UNIQUE employee_id, UNIQUE email, idx_users_manager,
idx_users_department, idx_users_team, idx_users_role, idx_users_account_status,
idx_users_employee_record_id. role_permissions / user_permissions: composite
PKs fully serve `hasPermissionCode` (equality on both columns).
permissions: UNIQUE permission_code.

### lead_activities
PK; idx_lead_activities_lead_id; idx_lead_activities_lead_created_at
(lead_id, created_at DESC); idx_lead_activities_created_at; _created_by; _status.

### scheduled_activities
PK; lead_id; scheduled_at; (lead_id, scheduled_at); status; activity_type;
created_by; assigned_to; updated_by; completed_by; completed_activity_id;
(scheduled_at, status); priority. **Added: idx_scheduled_activities_open_lead.**

### notifications
PK; user_id; is_read; type; created_at DESC; recipient_key; event_type
(partial); idempotency_key **UNIQUE partial** (PR #40/#44 — untouched).

### audit_logs / others
audit_logs: actor, target, action, created_at DESC. sessions, territories,
user_territories, employees, employee_departments, hierarchies: unchanged.

---

## 4. Bottlenecks found (with plan evidence)

All evidence from `scripts/db-performance-audit.mjs` (isolated PGlite,
synthetic: 200 users / 40k leads / 15k scheduled activities / 20k
notifications). **These are plan-shape facts + synthetic relative timings,
NOT Supabase production latency.**

1. **Visibility casts defeated every lead index.** Every visibility-scoped
   query (dashboard ×4 queries, lead list, follow-up queue, scheduled list,
   quality scan) used
   `(l.assigned_to::text = ANY($N::text[]) OR l.created_by::text = ANY($N::text[]))`.
   Casting the indexed columns to text made them unsargable → Seq Scan on
   leads (synthetic: 22 ms vs 6.7 ms after fix at 40k rows; the delta grows
   with table size because the scan is O(leads) while the fixed plan is
   O(visible rows)).
2. **Migration 038's follow-up queue index was dead code.** The queue's
   `assignedTo` filter used `l.assigned_to::text = $N`, so
   `idx_leads_assigned_next_follow_up_active` could never be chosen:
   plans scanned ~24.6k index rows and discarded ~24.5k (synthetic
   7.6 ms → 0.1 ms after the uuid equality).
3. **Lead Quality planned-action signal paid for all history.**
   `LOWER(s.status) = 'scheduled'` forced fetching every completed/cancelled
   row per lead and filtering after the scan; the open set is small but
   history grows forever.
4. **Notification user queries seq-scanned at every scale.** Two causes:
   the redundant `user_id::text = $1` branch, and the OR-ed hashed SubPlan
   (`user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = ...)`)
   whose estimate was ~50% of the table regardless of scale (5.4 ms seq
   scan → 0.2 ms BitmapOr after fix at 20k rows).
5. Dashboard DB time (~1.4 s observed in prior production diagnostics) is
   dominated by four parallel visibility-scoped scans — all improved by fix 1
   without touching dashboard architecture or semantics.

---

## 5. Indexes ADDED (exactly one)

### `idx_scheduled_activities_open_lead ON scheduled_activities(lead_id, scheduled_at) WHERE status = 'scheduled'` (migration 041)

- **Concrete query shape**: `fetchScheduledQualitySignals()` —
  `SELECT lead_id, MIN(scheduled_at) FROM scheduled_activities WHERE lead_id = ANY($1::uuid[]) AND status = 'scheduled' GROUP BY lead_id`.
- **Frequency**: runs on EVERY dashboard, lead list, follow-up queue,
  scheduled-activity list, single-lead read and lead save (Lead Quality is
  read-time scored; no materialization added).
- **Why current indexes insufficient**: `(lead_id, scheduled_at)` scans all
  history rows for the requested leads and discards completed/cancelled rows
  after the scan (synthetic: 1250 rows fetched → 500 discarded).
- **Read benefit**: partial index contains only open rows; synthetic
  EXPLAIN: 3.6 ms → 0.8 ms at 15k rows; the benefit grows as completed
  history accumulates (open set stays small).
- **Write cost**: maintained only for rows whose status is `scheduled` —
  insert (always `scheduled`) and the single transition out (complete /
  cancel). scheduled_activities is write-moderate and far quieter than
  leads/notifications. Storage: strictly smaller than the equivalent full
  index.
- **Why it outweighs cost**: highest-frequency aggregate in the app vs
  negligible incremental maintenance on a low-write table.

---

## 6. Indexes NOT added — and why

| Candidate | Reason rejected |
|---|---|
| `scheduled_activities(assigned_to, scheduled_at) WHERE status='scheduled'` (Workbench) | Existing BitmapAnd of single-column assigned_to + scheduled_at indexes already serves the day-window query well in plans (synthetic 0.2 ms). Fewer high-value indexes preferred; revisit if PR #45 post-deploy metrics disagree (§11). |
| `notifications(user_id, created_at DESC)` | The fixed 3-equality shape BitmapOr's the existing recipient_key + user_id indexes and sorts a small per-user set (synthetic 0.2 ms). notifications is write-heavy (assignment fan-out) — no extra index burden justified. |
| `users` expression indexes (`UPPER(employee_id)`, `UPPER(email)`) | users is a small dimension table; login/session/caller lookups are once per request/session and sub-millisecond at org scale. |
| immutable expression index for bulk-import phone/email normalization | Bulk import is periodic batch work, not a continuous hot path; expression indexes add write cost to the hottest table (leads). Deferred (§12). |
| `leads(assigned_to, created_at DESC)` for the lead list | BitmapOr + top-N sort over LIMIT 5000 is adequate; would add write cost for a narrow shape. |
| `leads(current_status, updated_at)` and other speculative composites | No production query shape filters+orders on this pair. |
| JSONB `reporting_chain` index | No query uses operators a GIN/jsonb index could serve; traversal uses users.manager_id (indexed). |

## Redundant indexes observed — intentionally LEFT ALONE (documented, not dropped)

Dropping indexes requires production usage evidence (pg_stat_user_indexes)
we do not have; candidates for a future ops review:

- `idx_leads_code` duplicates the `leads_lead_code_key` UNIQUE constraint.
- `idx_users_employee_id` / `idx_users_email` duplicate the users UNIQUE constraints.
- `idx_leads_followup_active` (next_follow_up_at WHERE is_deleted=FALSE) is
  nearly subsumed by `idx_leads_next_follow_up_active` (same + NOT NULL).
- `idx_leads_next_follow_up` (full) overlaps both partials above.
- `idx_lead_activities_lead_id` is a leading-column prefix of
  `idx_lead_activities_lead_created_at`.
- `idx_scheduled_activities_lead_id` is a prefix of
  `idx_scheduled_activities_lead_scheduled`.
- Low-cardinality singles (`idx_leads_deleted`, `idx_leads_priority`,
  `idx_notification_read`) are weak but harmless at current scale.

---

## 7. Query changes made (all result-identical, narrowly scoped)

1. **Visibility predicates → uuid-typed ANY** (`buildDashboardVisibilitySql`
   + the inline copies in `GET /leads`, `GET /leads/follow-ups`,
   `GET /scheduled-activities`):
   `(l.assigned_to = ANY($N::uuid[]) OR l.created_by = ANY($N::uuid[]))`.
   `userIds` are always server-resolved `users.id` values, so semantics are
   unchanged; the planner can now BitmapOr existing indexes.
2. **Follow-up queue assignedTo → `l.assigned_to = $N::uuid`** (resolved
   users.id). Unlocks migration 038's partial composite index.
3. **GET /leads assignedTo** uses uuid equality when the filter is a
   canonical-lowercase UUID (resolved or supplied); anything else keeps the
   legacy text comparison — malformed inputs behave exactly as before
   (`isCanonicalLowerUuid` guard).
4. **Scheduled activities**: `sa.assigned_to = $N::uuid` for the resolved
   filter; `sa.status = $N` / `sa.activity_type = $N` plain equality —
   exactly equivalent because CHECK constraints restrict both columns to the
   lowercase literal domain the validated inputs already use; `priority`
   stays `UPPER()`-wrapped (no CHECK domain guarantee).
5. **Lead Quality planned-action signals**: `LOWER(s.status) = 'scheduled'`
   → `s.status = 'scheduled'` (same CHECK-domain argument), so the new
   partial index applies.
6. **Notifications (list / read-all / delete)**: removed the provably
   redundant `user_id::text = $1` branch (its match set is a strict subset
   of the `user_id = $2` branch), and replaced the OR-ed
   `user_id IN (SELECT id FROM users WHERE UPPER(employee_id)=UPPER($1))`
   hashed SubPlan with a tiny pre-resolved lookup
   (`employee_id` is UNIQUE → at most one users.id) passed as a third
   equality. Same result set, every branch index-served, honest planner
   estimates. Trade-off: one extra sub-millisecond users lookup per request
   in exchange for eliminating a notifications-table seq scan.
7. **bulkResolveUserRefs**: id branch now `id = ANY($2::uuid[])`, limited
   to canonical-lowercase inputs (identical match set).
8. **Single-row PK lookups de-cast** (all behavior-identical via the
   `isCanonicalLowerUuid` guard — non-canonical inputs keep the legacy
   no-match/404 behavior):
   - lead dual lookups `lead_code = $1 OR id::text = $1` →
     `lead_code = $1 OR id = $2` (findLeadByIdRaw, follow-up row lock,
     pre-upsert existence check, GET /leads/:id visibility read,
     soft-delete) — opens the leads PK index;
   - scheduled-activity by-id reads/locks/deletes (`sa.id::text`) —
     opens the scheduled_activities PK;
   - notification by-id read (`n.id::text`) and lead-scoped history
     (redundant `reference_id::text` branch removed).
   These are the per-item Workbench / Lead Workspace operations; each was a
   cast-defeated PK lookup.

Remaining `id::text` casts are small dimension-table reference resolvers
(users/departments/roles/teams/workflow_rules/form_fields lookups); their
tables are tiny and the lookups sub-millisecond, so they are intentionally
unchanged (documented, not speculative).

NOT changed: dashboard architecture, pagination semantics, visibility
behavior, notification transactional semantics (PR #44), Lead Quality
formula, scheduled-activity workflow, RBAC, repository layer.

---

## 8. EXPLAIN / plan evidence

Reproduce with `node scripts/db-performance-audit.mjs` (isolated PGlite;
prints full plan summaries). Highlights (synthetic 40k leads / 15k
scheduled / 20k notifications):

| Hot path | Before (plan) | After (plan) | Synthetic Δ |
|---|---|---|---|
| Visibility scope (dashboard/queue/lists) | Seq Scan on leads, 22 ms | BitmapOr → idx_leads_assigned_to + idx_leads_created_by, 6.7 ms | ~3.3× |
| Follow-up queue `assignedTo` | idx_leads_next_follow_up_active scan + filter discarding ~99.6% (7.6 ms) | Index Scan idx_leads_assigned_next_follow_up_active (0.1 ms) | ~70× |
| Lead Quality planned signals | Bitmap scan + post-filter over history (3.6 ms) | Bitmap on idx_scheduled_activities_open_lead (0.8 ms) | ~4× |
| Notification user list | Seq Scan on notifications (5.4 ms) | BitmapOr recipient_key + user_id (0.2 ms) | ~22× |

**Limitation**: PGlite planner ≠ Supabase/PostgreSQL production calibration.
The plan-shape changes (seq scan → index scan) are the transferable fact;
absolute numbers must be re-measured post-deploy (§11). No EXPLAIN ANALYZE
was run against production, and no production writes occurred.

---

## 9. Write-cost & storage trade-offs (summary)

- **leads**: ZERO new indexes (most write-heavy table: status updates,
  assignments, follow-ups, imports). Its gain comes purely from making
  existing indexes usable.
- **scheduled_activities**: +1 partial index, open rows only; maintained on
  insert + one status transition per row. Table is write-moderate.
- **notifications**: ZERO new indexes despite being write-heavy (assignment
  fan-out). The fix is query-shape only.
- **users**: +1 tiny indexed lookup per notification user-scope request
  (UNIQUE-served, sub-ms); no schema change.
- Migration 041 is a plain `CREATE INDEX IF NOT EXISTS`. The migration
  runner executes each migration via the shared pool in autocommit;
  `CREATE INDEX CONCURRENTLY` was considered and deliberately NOT forced:
  the runner's PGlite test pool and cold-start model don't support it, and
  the scheduled_activities table is small enough that a brief build lock is
  acceptable. Operational note: on a very large production
  scheduled_activities table an operator may instead create the index
  CONCURRENTLY out-of-band; the migration's `IF NOT EXISTS` makes that safe.

---

## 10. Validation strategy

Automated (in `server/tests/db-performance-audit.test.ts`, run by `npm test`):

1. full migration suite runs **twice** on isolated PGlite (idempotent)
2. migration 041 index exists with the exact partial definition
3. all critical hot-path indexes exist after migrations
4. no duplicate index definitions
5. users/leads uniqueness constraints + RBAC composite PKs remain
6. notifications idempotency UNIQUE partial index remains AND still rejects duplicates
7–13. legacy vs shipped SQL return **identical result sets** for visibility,
   queue rows/counts/order, queue assignedTo, quality signals, scheduled
   type/status filters, notification match sets, pagination ordering,
   single-lead dual lookups and lead-scoped notification history
14. hierarchy downline CTE == BFS ground truth; DownTeam lead scoping exact
15. assignment/reassignment flips queue membership correctly
16–19. EXPLAIN plan guards: queue uses the 038 partial composite; visibility
   and notifications are index-driven; quality signals use the new partial index
20. quality aggregation stays constant-query (no N+1: 2 signals + 1 scope scan)
21–24. source guards prevent the cast/subplan regressions from returning

Plus the full pre-existing suite (818 tests) and the existing
notification-atomicity, RBAC, visibility, observability and
production-readiness suites.

`verify:db-schema` now also checks the critical index set (read-only),
including `idx_scheduled_activities_open_lead` and the notification
idempotency index.

---

## 11. Post-deploy monitoring (PR #45 observability)

Compare the same endpoints before/after deploy using the already-merged
observability surface — no new instrumentation:

- `http_request_complete` → `dbQueryCount` / `dbDurationMs` per endpoint,
  plus total request duration and Server-Timing headers.
- `db_query_slow` warnings (threshold `OBSERVABILITY_SLOW_DB_MS`).
- Browser Performance Diagnostics panel (PR #30) for client-perceived waits.

Watch targets:

| Endpoint | Expectation |
|---|---|
| `GET /api/dashboard` | dbDurationMs drops materially (four visibility-scoped queries no longer seq-scan leads); dbQueryCount unchanged |
| `GET /api/leads/follow-ups?bucket=…` | large drop for assignedTo-filtered reads; counts/list stable |
| `GET /api/leads` | drop proportional to visible-share of non-admin scopes |
| `GET /api/notifications/users/:id` | drop from seq scan → index; dbQueryCount +1 (employee pre-resolve) |
| `GET /api/scheduled-activities` | modest drop; stable |

Also monitor write latency on leads/scheduled_activities around the deploy
to confirm the new index adds no measurable write cost, and re-record the
mobile diagnostics session from `docs/PERFORMANCE_PHASE_3.md` §1 for the
same three endpoints.

---

## 12. Deferred optimization candidates

1. **Bulk-import phone/email normalization index** — an immutable expression
   index matching `normalizePhoneKey()` / `UPPER(email)` would remove the
   leads scan in `POST /leads/bulk` dedupe; deferred because imports are
   periodic and the expression must stay byte-identical to the normalization
   code (coupling risk on the hottest table).
2. **Scheduled-activities Workbench composite** `(assigned_to, scheduled_at) WHERE status='scheduled'`
   — revisit only if post-deploy `dbDurationMs` for the Workbench stays high.
3. **Redundant index cleanup** (§6 list) — after collecting 2–4 weeks of
   `pg_stat_user_indexes` usage evidence in production.
4. **Auth lookup expression indexes** on users — only if the users table
   grows by orders of magnitude.
5. **`GET /api/roles` ~1.15 s mobile observation** (PERFORMANCE_PHASE_3) —
   server DB time was not the bottleneck there; client-side coalescing was
   the chosen fix; no DB change warranted.

---

## 13. Known limitations

- Plan evidence comes from PGlite (WASM PostgreSQL) with synthetic data;
  cost calibration and IO behavior differ from Supabase. Plan shapes
  transfer; absolute timings do not.
- `CREATE INDEX CONCURRENTLY` is not used by the migration runner (see §9).
- Tie-breaking for equal `next_follow_up_at` values in the follow-up queue
  remains non-deterministic (established behavior, unchanged).
- This audit does not tune PostgreSQL server parameters or Supabase
  infrastructure (out of scope by design).

## 14. Confirmations

- No production data was accessed or modified (all evidence is isolated
  PGlite + synthetic rows).
- No infrastructure settings changed.
- No changes to: Redis/caches (none), materialized views (none), schema
  architecture, auth, RBAC, Data Visibility semantics, notification
  semantics (PR #44 atomicity preserved), Lead Quality formula, scheduled
  activity workflow, pagination semantics.
