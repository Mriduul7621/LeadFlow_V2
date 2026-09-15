# LeadFlow — Data Integrity & Recovery

Reliability-audit outcome for the PostgreSQL authority: which business
invariants exist, which of them the **database** enforces, which only the
**application** enforces, how drift is **detected without touching data**, and
how a backup is **verified and rehearsed** without ever pointing a destructive
tool at production.

Companion documents: `BACKUP_RESTORE_RUNBOOK.md` (procedure),
`INCIDENT_RESPONSE_RUNBOOK.md` §7–§9 (when to use which tool),
`DATABASE_PERFORMANCE_AUDIT.md` (indexes), `PRODUCTION_READINESS.md` (gates).

> Nothing in this document, and none of the tooling it describes, modifies
> production data. The integrity checker is read-only; the backup verifier
> never connects to a database; the restore drill refuses production-like
> targets by default. Auto-repair is deliberately **not** provided.

---

## 1. Integrity model

LeadFlow's state is one PostgreSQL database (migrations `001`–`042`). The
authoritative relationships are:

```
departments ──< teams            roles ──< users >── departments
                                          │  ▲ manager_id (self-FK, SET NULL)
                                          │  └── reporting_chain / subordinates (derived JSONB caches)
                                          │  └── hierarchies (derived, write-only table)
        users ──< leads (assigned_to / created_by / deleted_by …, all SET NULL)
                    │  ├── status_history / assignment_history / custom_fields (JSONB, app-managed)
                    │  ├──< lead_activities (CASCADE)  ◄── scheduled_activities.completed_activity_id (SET NULL)
                    │  └──< scheduled_activities (CASCADE)
        users ──< notifications (CASCADE)   reference_id → leads (NO FK, by design)
        roles ──< role_permissions >── permissions   users ──< user_permissions >── permissions
        users ──< audit_logs (actor / target, SET NULL)
```

Three classes of invariant follow from this:

| Class | Enforced by | Examples | Can drift? |
| --- | --- | --- | --- |
| **Structural** | DB (PK / FK / UNIQUE / CHECK / NOT NULL) | FK targets exist, unique lead_code, scheduled status domain, notification idempotency key | Only if a constraint is dropped or a migration is skipped → detect anyway |
| **Business** | Application code inside one transaction | completion = 1 activity + 1 schedule update, assignment history appended with owner change, no self-manager / cycles (validated on save) | Yes — legacy rows, direct SQL, retried partial writes |
| **Derived** | Application recompute | `reporting_chain`, `subordinates`, `hierarchies`, `custom_fields.assignedTo` shadow | Yes — any write path that forgets to recompute |

The checker verifies all three classes; the migration only *adds* DB
enforcement where the invariant is already app-enforced on every write path
**and** production data cannot be broken by it (§5).

---

## 2. Invariant matrix

Legend — **DB?** enforced by a constraint; **APP?** enforced by route code;
**Drift** whether stored data can violate it today; **Repair** whether an
automatic fix would be safe (always *No* → never auto-repaired; the ACTION
column says what an operator does).

Check ids are the exact identifiers printed by `npm run verify:data-integrity`.

### users / hierarchy

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| manager_id references an existing user (`users.manager_dangling`) | ✅ FK SET NULL | ✅ | No | BLOCKER | Constraint missing → apply migrations |
| no self-manager (`users.self_manager`) | ✅ **042** CHECK `NOT VALID` (new writes) | ✅ `validateReportingLink`, bulk import | Legacy only | BLOCKER | Fix the row via the hierarchy UI, then `VALIDATE CONSTRAINT users_no_self_manager` |
| no manager cycle (`users.manager_cycle`) | ❌ (needs recursion) | ✅ walk-up guard on save | Legacy / concurrent edits | BLOCKER | Break the cycle via the hierarchy UI (recompute runs automatically) |
| role / department / team refs valid (`users.role_dangling`, `…department_dangling`, `…team_dangling`) | ✅ FK | ✅ | No | BLOCKER | Apply migrations |
| active user does not report to an inactive manager (`users.manager_inactive`) | ❌ | ✅ on save only | Yes (deactivation later) | WARNING | Re-parent in the hierarchy UI |
| `reporting_chain[0]` = manager's employee_id (`users.reporting_chain_stale`) | ❌ derived | ✅ `recomputeReportingChains` after every hierarchy write | Yes | WARNING | Save any hierarchy link (full recompute) |
| `hierarchies` mirrors `users.manager_id` (`users.hierarchies_mismatch`) | ❌ derived, **no readers** | ✅ same recompute | Yes | INFO | Informational; table has no consumers |

### leads

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| assigned_to / created_by reference users (`leads.assigned_to_dangling`, `leads.created_by_dangling`) | ✅ FK SET NULL | ✅ | No | BLOCKER | Apply migrations |
| lead_code present (`leads.lead_code_missing`) | UNIQUE but nullable | ✅ every writer | Legacy only | WARNING | Assign a code (readers fall back to row id) |
| soft-delete flags agree (`leads.soft_delete_inconsistent`) | ❌ | ✅ all three delete paths set both | Legacy / direct SQL | WARNING | Set `deleted_at` on flagged rows after review |
| deleted lead has no open schedule (`leads.deleted_with_open_schedule`) | ❌ | ❌ (readers filter `is_deleted`) | Yes | WARNING | Cancel via API if the lead is restored; otherwise cosmetic |
| terminal lead has no open schedule / future follow-up (`leads.terminal_with_open_schedule`, `leads.terminal_with_future_follow_up`) | ❌ | partial (queue readers exclude terminal) | Yes | WARNING | Cancel the schedule / clear the follow-up via the UI |
| `custom_fields.assignedTo` shadow = canonical owner (`leads.owner_shadow_mismatch`) | ❌ | ✅ writers sync it; readers **never** trust it | Legacy imports | WARNING | Re-save assignment (server rewrites the shadow) |

### assignment history

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| latest entry's `toEmployeeId` = current owner (`assignment_history.latest_owner_mismatch`) | ❌ | ✅ appended in the same UPSERT | Legacy / direct SQL | WARNING | Reassign once via the UI (appends a correct entry) |
| no duplicate entry ids (`assignment_history.duplicate_entry_ids`) | ❌ | ❌ | A retried request could append twice | WARNING | Review; history is append-only, do not rewrite blindly |
| historical employee ids resolve (`assignment_history.unknown_employee_ids`) | ❌ | n/a | Yes (deleted users) | INFO | None — historical record |

### lead_activities (immutable timeline)

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| lead_id references a lead (`lead_activities.lead_dangling`) | ✅ FK CASCADE | ✅ | No | BLOCKER | Apply migrations |
| created_by references a user (`lead_activities.created_by_dangling`) | ✅ FK SET NULL | ✅ | No | BLOCKER | Apply migrations |
| immutability | ❌ (no trigger) | ✅ **no route issues UPDATE/DELETE on lead_activities** (verified by grep) | Direct SQL only | — | Policy; enforce via DB role grants if required |

### scheduled_activities

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| lead / assigned_to valid (`scheduled_activities.lead_dangling`, `…assigned_to_dangling`) | ✅ FK | ✅ | No | BLOCKER | Apply migrations |
| status ∈ {scheduled, completed, cancelled} (`scheduled_activities.status_domain`) | ✅ CHECK (039) | ✅ | No | BLOCKER | Apply migrations |
| completed ⇒ completed_at + existing activity (`scheduled_activities.completed_without_activity`) | ❌ | ✅ single transaction, `FOR UPDATE` | Legacy / direct SQL | BLOCKER | Investigate; do not fabricate activities |
| completion activity belongs to the same lead (`scheduled_activities.completed_activity_wrong_lead`) | ❌ | ✅ | Direct SQL only | BLOCKER | Investigate |
| one completion = one activity (`scheduled_activities.duplicate_completion`) | ✅ **042** partial UNIQUE (created only when clean) | ✅ 409 on second completion | Legacy only | BLOCKER | Resolve duplicates, re-run migrations (index then appears) |
| non-completed rows carry no completion fields (`scheduled_activities.open_with_completion_fields`) | ❌ | ✅ | Legacy / direct SQL | WARNING | Review |

### notifications

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| user_id references a user (`notifications.user_dangling`) | ✅ FK CASCADE | ✅ | No | BLOCKER | Apply migrations |
| `reference_type='lead'` ⇒ lead exists (`notifications.lead_reference_dangling`) | ❌ **by design** (legacy rows outlive purged leads; client rows have NULL type) | ✅ server flows | Yes | WARNING | None required; UI degrades to text |
| recipient_key = recipient's employee_id (`notifications.recipient_key_mismatch`) | ❌ | ✅ | Legacy | WARNING | Review |
| idempotency_key unique (`notifications.idempotency_key_duplicate`) | ✅ partial UNIQUE (040) | ✅ `ON CONFLICT DO NOTHING` | No | BLOCKER | Apply migrations |
| the unique index exists (`notifications.idempotency_index_present`) | ✅ | — | Dropped index | BLOCKER | Apply migrations |

### RBAC

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| role_permissions / user_permissions refs valid (`rbac.role_permissions_dangling`, `rbac.user_permissions_dangling`) | ✅ FK CASCADE | ✅ | No | BLOCKER | Apply migrations |
| no duplicate grants (`rbac.duplicate_role_grants`, `rbac.duplicate_user_grants`) | ✅ composite PK | ✅ upsert | No | BLOCKER | Apply migrations |
| permission codes non-blank (`rbac.permission_code_blank`) | ✅ UNIQUE NOT NULL | seeded | No | BLOCKER | Apply migrations |

### teams / departments

| Invariant (check id) | DB? | APP? | Drift | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| team → department (`teams.department_dangling`) | ✅ FK RESTRICT | ✅ | No | BLOCKER | Apply migrations |
| team leader → user (`teams.leader_dangling`) | ✅ FK SET NULL | ✅ | No | BLOCKER | Apply migrations |

### schema precondition & volumes

`schema.required_tables` (BLOCKER when any catalog table is missing —
dependent checks are reported `SKIPPED`, never crash) and four INFO row
counts (`volume.users`, `volume.leads_active`, `volume.leads_deleted`,
`volume.scheduled_open`) for the drill evidence log.

---

## 3. Checker architecture

```
scripts/verify-data-integrity.mjs      CLI: pg.Client → BEGIN; SET TRANSACTION READ ONLY;
        │                              SET LOCAL statement_timeout → runIntegrityChecks → ROLLBACK
        └── scripts/lib/integrity-checks.mjs
              INTEGRITY_CHECKS[]       one entry per invariant: id, domain, severity,
                                       enforcedBy, countSql, optional sampleSql (LIMIT $1)
              assertReadOnlySql()      every statement must start with SELECT/WITH and
                                       contain no write/DDL verb outside string literals
              runIntegrityChecks(q)    table discovery → per-check COUNT → PASS/WARN/FAIL/INFO/
                                       SKIPPED/ERROR → summary + exit code
              formatReport()           PII-free text; diagnostic samples are opaque UUIDs only
```

Guarantees:

- **Read-only by construction.** The CLI opens a `READ ONLY` transaction
  (PostgreSQL rejects any write with `25006`), and the catalog guard rejects
  any statement that is not a `SELECT`/`WITH` before it is sent. The
  test-suite drives the same library on a PGlite database and asserts that
  only `SELECT`/`WITH` statements reach the pool.
- **No PII.** Detection queries project only `COUNT(*)` or `id`; the
  formatter prints invariant ids, statuses and integers. Employee ids and
  lead codes are never printed. `--diagnostic` adds up to 20 opaque UUIDs
  per failing check so an operator can `SELECT … WHERE id = …` themselves.
- **Bounded.** Aggregates only, explicit `LIMIT`, statement timeout (60 s by
  default, `INTEGRITY_STATEMENT_TIMEOUT_MS` to override), recursion depth
  capped at 100 for the cycle walk.
- **Isolated test DB.** `DATABASE_URL=pglite://…` is refused by the CLI; the
  tests import the library directly against migrated PGlite.
- **Not a health endpoint.** `/api/health/readiness` remains `SELECT 1`
  (guarded by `data-integrity-source-guards.test.ts`); the checker is an
  operator tool run on demand, after restores and during incidents.

---

## 4. Severity model

| Severity | Meaning | Exit code | Examples |
| --- | --- | --- | --- |
| **BLOCKER** (`FAIL`) | A state the schema or the business rules say is impossible; the application will misbehave or a guarantee (idempotency, single completion) is broken. Also raised when a detection query itself errors (`ERROR`) or a required table is missing. | **1** | self-manager, manager cycle, dangling FK targets, completed schedule without its activity, duplicate completion link, duplicate/unguarded idempotency keys, dangling RBAC grants |
| **WARNING** (`WARN`) | Drift that degrades correctness or hygiene but has a documented application-side correction; the system keeps working because readers do not depend on the drifting value. | 0 (reported) | stale `reporting_chain`, inactive manager, owner shadow / latest-history mismatch, soft-delete flag mismatch, terminal lead with open schedule, notification pointing at a purged lead |
| **INFO** | Purely informational counts; never fail. | 0 | `hierarchies` mismatch (write-only table), historical employee ids, table volumes |
| `SKIPPED` | Dependent table missing; the `schema.required_tables` BLOCKER already covers it. | (via BLOCKER) | — |

Classification rule of thumb: *would a correct application ever have written
this?* → BLOCKER. *Could a correct application have left this behind after a
later, unrelated change?* → WARNING. *Is nobody reading it?* → INFO.

The overall result is `FAIL` if any BLOCKER, else `WARN` if any WARNING, else
`PASS`. The restore drill treats only BLOCKERs as a failed restore; WARNINGS
are printed for review in the drill evidence.

---

## 5. Constraints added vs. detect-only (decision record)

Rule applied: add a DB constraint **only** if (a) every production write
path already enforces it, (b) the seed and the dev-demo fallback model agree,
(c) legacy rows cannot make a cold-start migration fail, and (d) nulls are
not intentionally permitted. Everything else is detect-only.

| Candidate | Decision | Why |
| --- | --- | --- |
| `users.manager_id <> id` | **Added (042)** as `CHECK … NOT VALID` | App rejects it on every path; `NOT VALID` enforces new writes without scanning legacy rows, so startup can never fail; operators validate after the checker reports 0 |
| `UNIQUE scheduled_activities(completed_activity_id) WHERE NOT NULL` | **Added (042)**, created only when no duplicates exist (otherwise `RAISE WARNING`, checker BLOCKER) | Makes duplicate completion storage-impossible; route already prevents it; index skipped instead of failing on dirty data |
| manager-cycle CHECK | Detect-only | Not expressible as a CHECK; trigger would be a framework change |
| `completed ⇒ completed_at/activity NOT NULL` CHECK | Detect-only | Legacy rows and the dev-demo store shape differ; a `NOT VALID` CHECK across three columns adds risk without preventing the real failure mode (partial writes, already transactional) |
| `notifications.reference_id → leads` FK | Detect-only | Deliberately absent: notifications outlive purged leads; client-created rows have NULL type |
| `leads.lead_code NOT NULL` | Detect-only | Nullable by original migration; legacy rows may exist; readers fall back to id |
| `custom_fields.assignedTo` = owner | Detect-only | Legacy display shadow; canonical readers never use it |
| `hierarchies` consistency | Detect-only (INFO) | Write-only table, no readers |

No constraint was added that could reject data the application writes today.

---

## 6. Transaction audit (partial-write review)

| Flow | Route(s) | Shape | Finding |
| --- | --- | --- | --- |
| Lead create / assignment | `POST /leads` | `BEGIN → LEAD_UPSERT_SQL → createAssignmentNotifications(client) → COMMIT` | Atomic (PR #44 semantics preserved). Note: the UPSERT resets `is_deleted=FALSE` — re-saving a soft-deleted lead by code resurrects it (documented behaviour, not changed) |
| Bulk lead update | `POST /leads/bulk` | one transaction, per-row `SAVEPOINT bulk_row` | Sound: a failing row rolls back only itself |
| Follow-up save | `POST /leads/:id/follow-up` | `BEGIN → SELECT … FOR UPDATE → UPDATE leads → INSERT lead_activities → COMMIT` | Atomic |
| Scheduled completion | `POST /scheduled-activities/:id/complete` | lock `FOR UPDATE`, 409 unless `scheduled`, optional lead update, `INSERT lead_activities`, `UPDATE scheduled_activities`, `COMMIT` | Atomic; now also storage-guarded by 042 |
| Scheduled cancellation | `…/cancel` | lock, 409 on completed/cancelled, single UPDATE | Atomic |
| Bulk user create + manager link | `POST /users/bulk/commit` | phase A create (savepoints) → phase B link (savepoints, row-atomic rollback) → `recomputeReportingChains` → `COMMIT`; audit best-effort after commit | Sound; recompute failure rolls back the whole batch |
| Notification creation (system) | `NotificationService.insertNotificationWithIdempotency` | inside caller's transaction, `ON CONFLICT (idempotency_key) DO NOTHING` | Retry-safe |
| Notification creation (client) | `POST /notifications` | single INSERT, `reference_type` NULL | No integrity claim to protect; checker ignores NULL-typed rows |
| User delete | `DELETE /users/:id` | `BEGIN → … → DELETE hierarchies (.catch) → DELETE notifications (.catch) → DELETE users → COMMIT` | **Latent poisoned-transaction pattern**: a swallowed failure would leave the transaction aborted so the final DELETE fails with `25P02` and the route rolls back → outcome is still *no partial write* (fail-closed). Left unchanged (no data-loss path); recorded as deferred cleanup |
| Permission overrides | `PUT /users/:id/permissions` | transaction, upsert per code | **Fixed**: INSERT referenced a `granted_at` column that migration 027 never created → `42703` on a real database (masked in tests by a synthetic table). Column list now matches the migration; regression test runs on the real schema |

### Bulk-operation safety

| Route | Gate | Scope | Txn | Audit | Change |
| --- | --- | --- | --- | --- | --- |
| `DELETE /leads/campaign/:campaign` | `requireAdmin` | `custom_fields->>'campaignName' = $1 AND is_deleted = FALSE` | single UPDATE | **added** `LEAD_CAMPAIGN_PURGE` (counts only) | **blank / whitespace name → 400** (fail closed) |
| `POST /leads/clear-all` | `requireAdmin` | all active leads | single UPDATE | **added** `LEAD_CLEAR_ALL` (count only) | audit failure never masks the result |
| `DELETE /leads/:id` | `leads.delete` | one row | single UPDATE | — | unchanged (soft delete) |
| `DELETE /users/:id` | `users.delete` | one row + children | transaction | — | unchanged (see above) |
| `DELETE /departments|roles|teams/:id` | manage codes | one row, FK RESTRICT/CASCADE | single statement | — | unchanged |
| bulk user import | `users.create/edit` | ≤1000 rows | transaction + savepoints | `users-bulk-import` | unchanged |

No reset / seed / debug endpoint exists on the mounted router.

---

## 7. Recovery tooling

| Command | Purpose | Touches data? | Needs |
| --- | --- | --- | --- |
| `npm run verify:db-schema` | tables + critical indexes present | No (read-only) | `DATABASE_URL` |
| `npm run verify:data-integrity [-- --diagnostic] [-- --json]` | invariant matrix → PASS/WARN/FAIL, exit 1 on BLOCKER | No (READ ONLY txn) | `DATABASE_URL` |
| `npm run verify:backup -- <dump> [--sha256 <digest>]` | dump exists, non-empty, recognizable format, catalog lists critical tables with data | No (never connects, never runs `pg_dump`) | `pg_restore` for custom/tar/directory dumps (explicit FAIL if missing) |
| `npm run restore:drill -- <dump> [--plan]` | restore into an **isolated** DB → schema → integrity → read-only smoke | **Yes, on the isolated target only** | `ALLOW_DESTRUCTIVE_RESTORE=YES`, `RESTORE_TARGET_DATABASE_URL`, `pg_restore`/`psql` |
| `npm run smoke:production` | unauthenticated GET-only HTTP smoke | No | `LEADFLOW_BASE_URL` |

None of these are CI steps (CI has no production database; the test-suite
covers them on PGlite / synthetic files).

---

## 8. Restore safety model

```
                      ┌──────────────── default deny ────────────────┐
 backup path ─────────┤ ALLOW_DESTRUCTIVE_RESTORE == "YES" (exact)   ├─ any FAIL → REFUSED (exit 2),
 env ─────────────────┤ RESTORE_TARGET_DATABASE_URL set              │  nothing executed
                      │ target host not *.supabase.co/.com/.in/.net │
                      │ host / db / user not prod|production|live    │
                      │ target ≠ DATABASE_URL                        │
                      └──────────────────────────────────────────────┘
                                          │ all PASS
   verify-backup ──► tooling present? ──► pg_restore --clean --if-exists --exit-on-error (target)
        │                 │ missing → FAIL          │
        └ FAIL → stop     └ (never "assumed")       ▼
                                   verify-db-schema (target) ──► verify-data-integrity (target)
                                                                          │
                                                          read-only smoke (counts, ≥1 active admin)
                                                                          ▼
                                                              PASS / FAIL evidence lines
```

- The target is echoed **only** as `postgresql://[user]@host:port/db`.
- `DATABASE_URL` is never a target; it is only read for the equality guard.
- `--plan` evaluates guards, backup and tooling and touches no database.
- `pg_restore --clean` is applied to the isolated target only; the drill
  never issues `DROP DATABASE`, `TRUNCATE` or a reset against anything.

---

## 9. Migration safety findings

| Aspect | Finding | Disposition |
| --- | --- | --- |
| Tracking | Fixed list, no ledger table; every migration is idempotent DDL (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DO $$ … IF NOT EXISTS`) | Preserved (redesign out of scope) |
| Retry | Re-running the whole list is safe — proven twice in `db-performance-audit.test.ts` and `migration-retry-idempotent.test.ts` (no duplicate constraints/indexes) | — |
| Partial failure | Previously: migration name logged, error rethrown, no process-local record | **Added** an in-memory run summary (`getLastMigrationRunSummary()` / `describeMigrationRun()`): status, completed list, `failedAt`, sanitized first-line error, timestamps. Logged at failure. Never written to the DB, never exposed as an endpoint |
| Startup | `initializeDatabase()` rejects → entrypoints log and serve 503s; readiness stays honest | Unchanged |
| Operator action | `verify:db-schema` (tables/indexes) then `verify:data-integrity` (invariants); fix forward with an idempotent migration; never revert destructive DDL after writes | Runbook §7 updated |
| Empty placeholder scripts | `backup-db.ts`, `restore-db.ts`, `reset-db.ts`, `migrate.ts`, `health-check.ts`, `clean-uploads.ts`, `generate-seed.ts` are 0-byte | Left as-is (no test references; unreferenced by npm scripts); backup/restore capability is provided by the new `.mjs` tools. Recorded in `PRODUCTION_READINESS.md` finding #5 |

---

## 10. Operator commands (cheat sheet)

```bash
# schema + invariants against an environment (read-only)
DATABASE_URL="$URL" npm run verify:db-schema
DATABASE_URL="$URL" npm run verify:data-integrity
DATABASE_URL="$URL" npm run verify:data-integrity -- --diagnostic   # opaque UUIDs for failing checks
DATABASE_URL="$URL" npm run verify:data-integrity -- --json         # machine-readable

# verify a dump you already produced (never connects to a database)
npm run verify:backup -- ./leadflow_20260914T010000Z.dump --sha256 "$(cat leadflow_20260914T010000Z.dump.sha256)"

# rehearse a restore into an ISOLATED scratch database
ALLOW_DESTRUCTIVE_RESTORE=YES \
RESTORE_TARGET_DATABASE_URL="postgresql://drill:***@scratch-host:5432/leadflow_restore_drill" \
npm run restore:drill -- ./leadflow_20260914T010000Z.dump          # add --plan for a dry run
```

Exit codes: `verify:*` → 0 PASS / 1 FAIL; `restore:drill` → 0 PASS / 1 FAIL /
2 REFUSED by a guard.

---

## 11. Limitations

- **No automatic repair.** Every finding requires a human decision; the
  tools print what to look at, not what to change.
- **Exact counts scan tables.** On very large databases run the checker
  against a replica or a restored copy; raise
  `INTEGRITY_STATEMENT_TIMEOUT_MS` deliberately, never in a health probe.
- **PGlite ≠ Supabase.** Invariants and SQL are proven on real PostgreSQL
  semantics, but timing, extensions and role grants differ.
- **The sandbox where this PR was built has no `pg_dump`/`pg_restore`.** The
  verifier's `pg_restore --list` branch and the drill's restore step are
  proven with injected process results and a fake catalog; their real-tool
  behaviour must be exercised once by an operator with client tools
  installed (see runbook §9 evidence checklist).
- **Provider backups are external.** Supabase scheduled backups / PITR are
  not asserted by this repository; see runbook §4. **LeadFlow does not
  claim a verified production backup** until the drill has been run against
  a real dump and its evidence recorded.
- **`NOT VALID` constraint.** `users_no_self_manager` protects new writes
  immediately; legacy violations (if any) surface only through the checker
  until an operator runs `ALTER TABLE users VALIDATE CONSTRAINT
  users_no_self_manager`.

---

## 12. Deferred items

| Item | Why deferred |
| --- | --- |
| `DELETE /users/:id` child-delete `.catch` inside the transaction | Fail-closed today (aborted txn → rollback, no partial write); cleaning it up is a behaviour-neutral refactor without a data-integrity payoff |
| CHECK coupling `status='completed'` ⇔ completion columns | Needs a legacy-data survey first; three-column `NOT VALID` CHECK adds risk without preventing the actual failure mode |
| Trigger-based immutability for `lead_activities` | Framework-level change; no route mutates the table today (asserted by grep in the audit) |
| Removing the write-only `hierarchies` table | Schema removal is a separate, reviewed migration |
| Filling the 0-byte placeholder scripts | Their intent is covered by the new tools; deleting them is a cleanup PR |
| Provider-side backup automation / off-site storage / PITR | Explicitly out of scope (paid services, cron infra) |
