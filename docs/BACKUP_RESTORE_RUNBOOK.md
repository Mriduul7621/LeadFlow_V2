# LeadFlow — Backup & Restore Runbook

Production readiness requires a real, tested backup-and-restore operating
procedure. This runbook documents **what is known to exist**, what the
operator must configure, and the exact steps to back up, restore and validate.
It does **not** claim automated backups exist unless they are verified —
see §4 (provider responsibility).

> A CSV/XLSX lead export is **not** a database backup. Business exports help
> operations but cannot recover users, roles, permissions, hierarchy,
> activities, audit history or configuration (see §7).

**Tooling added by the reliability audit** (all read-only unless stated;
none run in CI; see `DATA_INTEGRITY_AND_RECOVERY.md`):

| Command | What it verifies | Touches data? |
| --- | --- | --- |
| `npm run verify:backup -- <dump>` | a `pg_dump` file exists, is non-empty, is a recognizable format, and its catalog lists every critical LeadFlow table with data (§8) | No — never connects, never runs `pg_dump` |
| `npm run verify:db-schema` | expected tables + critical indexes on a live database | No |
| `npm run verify:data-integrity` | the business invariant matrix (orphans, cycles, duplicate completions, idempotency, RBAC refs …) → PASS/WARN/FAIL | No — `READ ONLY` transaction |
| `npm run restore:drill -- <dump>` | full rehearsal: restore into an **isolated** database → schema → integrity → read-only smoke (§9) | **Isolated target only**, default deny |

**Backup types and who verifies them**

| Backup type | Produced by | Verified by tooling in this repo | Verified manually by the operator |
| --- | --- | --- | --- |
| Logical `pg_dump` (custom / plain / tar / directory) | operator (`pg_dump`, §5) | `verify:backup` (file + catalog), `restore:drill` (restorability + integrity) | storage location, retention, SHA-256 record |
| Supabase scheduled backup | provider | ❌ (outside repository control) | console: schedule, retention, last successful run, a tested restore (§4) |
| Supabase PITR | provider (paid, plan-dependent) | ❌ | console: enabled, retention window, a tested point-in-time restore |
| CSV/XLSX export | UI | ❌ | not a backup (§7) |

---

## 1. Backup scope

LeadFlow is a single PostgreSQL database (Supabase, or a PostgreSQL host
reachable via `DATABASE_URL`). **What must be backed up:**

- the **entire PostgreSQL database** — this is the authoritative source of
  truth for every business entity:
  - users, roles, permissions (`roles`, `permissions`, `role_permissions`,
    `user_permissions`, `fine_permissions`)
  - hierarchy (`departments`, `teams`, `hierarchies`, `employee_departments`,
    `employee_reporting`, `user_visibility`, `team_members`, `territories`,
    `user_territories`)
  - leads and history (`leads`, `lead_status`, `lead_activities`,
    `scheduled_activities`)
  - reference/config (`options`, `metadata`, `metadata_types`, `form_fields`,
    `forms`, `workflows`, `workflow_rules`, `products`, `campaigns`)
  - operational (`sessions`, `audit_logs`, `notifications`)

**Outside the database (not covered by a DB backup):**

- Vercel project configuration, environment variables and secrets — managed
  in the Vercel dashboard, exported/recorded as part of the deployment config.
- Client bundle / static assets — rebuilt from Git (reproducible, not "data").
- Supabase project settings (auth keys, connection string, row-level policies).

There is no durable file/binary storage wired up (lead documents are metadata
references only), so the database is the complete business-data surface.

---

## 2. Recommended frequency & retention

| Data | Frequency | Retention |
| --- | --- | --- |
| PostgreSQL | Daily (point-in-time if available) | 30 days daily, 12 monthly |
| Pre-release snapshot | Immediately before every release | Until the release is accepted |
| Pre-destructive-migration snapshot | Immediately before the migration | Until restore is validated |

These are **recommendations**, not a claim that they are configured. The
operator must confirm the actual schedule in the provider console.

---

## 3. RPO / RTO

- **RPO (Recovery Point Objective)** — maximum acceptable data loss. With a
  daily backup, the worst-case RPO is ~24 h of writes. A Supabase
  **Point-in-Time Recovery (PITR)** subscription narrows this to minutes;
  PITR is a paid provider feature and is **not** asserted to be enabled here.
- **RTO (Recovery Time Objective)** — maximum acceptable time to restore.
  Depends on database size and provider; a same-provider restore is typically
  faster than a manual `pg_restore`. The operator must define the target
  (e.g. 1 h) and test it.

Decide both targets **before** an incident, and validate them with a restore
drill (§9). Record the measured drill duration as the evidence for the RTO
claim, and the backup timestamp gap as the evidence for the RPO claim — an
RPO/RTO that has never been measured is an aspiration, not a target.

---

## 4. Provider responsibility (Supabase)

If the database is hosted on Supabase, backup/pitR is provider-managed and
**outside repository control**. The operator must confirm in the Supabase
console:

- [ ] scheduled backups / PITR enabled (plan-dependent, may be paid)
- [ ] retention window meets §2
- [ ] restore-from-backup is possible without a code change (operator action)
- [ ] a point-in-time restore has been tested at least once

**Do not** claim automated backups exist because this document says so — the
console is the source of truth. If provider backups are not enabled, treat the
manual `pg_dump` procedure below as the **only** backup and schedule it
externally (e.g. a cron on an operator machine), then document where those
dumps are stored.

---

## 5. Manual backup & restore (`pg_dump` / `pg_restore`)

The repository's `scripts/backup-db.ts` / `restore-db.ts` are **empty
placeholders** (see `PRODUCTION_READINESS.md` §6, finding #5) and are not
wired to anything. Producing a dump is a deliberate operator action with the
PostgreSQL tools — no script in this repository connects to production to
create a backup on its own:

### Backup (read-only; safe to run against production)

```bash
# Logical, schema + data, consistent snapshot.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --file="leadflow_$(date -u +%Y%m%dT%H%M%SZ).dump"
```

- `--format=custom` gives a single compressed file, restorable selectively.
- Store the dump **outside** the database host and outside the repository
  (e.g. object storage with access logging). Never commit a dump to Git.
- Record the SHA-256 of the dump for tamper/verification:

```bash
sha256sum leadflow_<timestamp>.dump > leadflow_<timestamp>.dump.sha256
npm run verify:backup -- leadflow_<timestamp>.dump --sha256 "$(cut -d' ' -f1 leadflow_<timestamp>.dump.sha256)"
```

### Restore (to a **separate** instance — never over live production)

```bash
createdb leadflow_restore_test
pg_restore --dbname="$RESTORE_URL" --no-owner --no-privileges \
  --clean --if-exists leadflow_<timestamp>.dump
```

Always restore into a scratch/verification instance first (§6, or the
automated drill in §9). Restoring over live production is destructive and is
an incident action, not routine (§10).

---

## 6. Restore verification — a backup is not trustworthy until validated

A backup file existing proves nothing. Validate a restore against the scratch
instance with **counts, integrity and representative spot-checks**:

```sql
-- counts (compare against pre-incident baseline)
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM leads;
SELECT COUNT(*) FROM lead_activities;
SELECT COUNT(*) FROM scheduled_activities;
SELECT COUNT(*) FROM roles;
SELECT COUNT(*) FROM permissions;

-- roles/permissions intact (no missing grant catalog)
SELECT COUNT(*) FROM role_permissions;
SELECT COUNT(*) FROM user_permissions;

-- hierarchy links intact (every non-root user resolves or is explicitly root)
SELECT COUNT(*) FROM users WHERE manager_id IS NOT NULL;
SELECT COUNT(*) FROM hierarchies;

-- representative lead history (a recent lead still has its history)
SELECT lead_code, jsonb_array_length(status_history) FROM leads
ORDER BY created_at DESC LIMIT 10;

-- critical FK/integrity checks (example)
SELECT COUNT(*) FROM scheduled_activities sa
  LEFT JOIN leads l ON l.id = sa.lead_id WHERE l.id IS NULL;  -- expect 0
SELECT COUNT(*) FROM lead_activities a
  LEFT JOIN leads l ON l.id = a.lead_id WHERE l.id IS NULL;   -- expect 0
```

Then re-point a **non-production** app at the restored instance and verify
login, a lead read, and a follow-up read. Only after all of the above pass is
the restore considered valid.

The manual SQL above is superseded for routine use by the read-only tooling,
which runs the full invariant matrix instead of a handful of spot checks:

```bash
DATABASE_URL="$RESTORE_URL" npm run verify:db-schema        # tables + critical indexes
DATABASE_URL="$RESTORE_URL" npm run verify:data-integrity   # PASS / WARN / FAIL, exit 1 on BLOCKER
```

**Never test restore against live production by overwriting it.**

---

## 7. Limitations of CSV/XLSX exports

LeadFlow can export CSV/XLSX from the UI (lead list CSV, NCP ledger, execution
intelligence XLSX). These are **business exports**, not backups:

| Capability | CSV/XLSX export | PostgreSQL backup |
| --- | --- | --- |
| Lead rows | ✅ (visible subset) | ✅ full table incl. soft-deleted |
| Users / roles / permissions | ❌ | ✅ |
| Hierarchy / teams / territories | ❌ | ✅ |
| Activities / scheduled activities | ❌ | ✅ |
| Audit log history | ❌ | ✅ |
| Notifications | ❌ | ✅ |
| Configuration (options, forms, workflows) | ❌ | ✅ |
| Restore capability | ❌ | ✅ |

Do not treat an export as a recovery mechanism for anything except the lead
list itself, and even then it is a lossy, visible-subset extract.

---

## 8. Backup verification (`npm run verify:backup`)

A backup is an unverified file until its catalog has been read. The verifier
inspects the artifact **without restoring it and without connecting to any
database**:

| Step | PASS when | FAIL when |
| --- | --- | --- |
| `file.exists` | path is readable | missing / unreadable |
| `file.size` | > 0 bytes (or directory with `toc.dat`) | empty |
| `file.format` | `PGDMP` custom, tar, directory, plain SQL, gzip plain SQL | anything else |
| `file.sha256` | digest computed (and equals `--sha256` when given) | mismatch |
| `catalog.pg_restore` | `pg_restore --version` works (archive formats only) | **tool missing → explicit FAIL** ("catalog could NOT be verified") — never a silent pass |
| `catalog.list` | `pg_restore --list` (archive) or streamed identifier scan (plain SQL) succeeds | unreadable / corrupt |
| `catalog.critical_tables` | all of `users, roles, permissions, role_permissions, user_permissions, departments, teams, leads, lead_activities, scheduled_activities, notifications, audit_logs, options` present | any missing |
| `catalog.critical_table_data` | each critical table has a `TABLE DATA` / `COPY` section | schema-only dump |

Output lists table **identifiers** only; row payloads (`COPY` bodies) are
consumed unread. Exit 0 = PASS, 1 = FAIL. `--json` for machine-readable
evidence.

---

## 9. Restore drill (`npm run restore:drill`)

The drill proves *restorability*, not just file validity. It **only** ever
writes to the isolated target you name, and refuses to start unless every
guard passes:

```bash
ALLOW_DESTRUCTIVE_RESTORE=YES \
RESTORE_TARGET_DATABASE_URL="postgresql://drill:<pw>@scratch-host:5432/leadflow_restore_drill" \
npm run restore:drill -- ./leadflow_<timestamp>.dump

# dry run: guards + backup + tooling only, no database touched
npm run restore:drill -- ./leadflow_<timestamp>.dump --plan
```

### Safety guards (default deny)

| Guard | Rule |
| --- | --- |
| explicit confirmation | `ALLOW_DESTRUCTIVE_RESTORE` must be exactly `YES` (`yes`, `true`, `1` are refused) |
| isolated target | `RESTORE_TARGET_DATABASE_URL` is required; `DATABASE_URL` is **never** used as the target |
| never production | refused when the target host ends in `supabase.co/.com/.in/.net`, when host / database / user contains `prod`, `production` or `live`, or when the target equals `DATABASE_URL` |
| redacted echo | the target is printed only as `postgresql://[user]@host:port/db` |
| no fake success | missing `pg_restore` / `psql` → FAIL before any restore |

Exit codes: 0 PASS · 1 FAIL · 2 REFUSED by a guard.

### Pipeline & post-restore checks

1. `backup.verify` — §8 on the dump (format, catalog, SHA-256).
2. `restore.tooling` — `pg_restore` (archive) or `psql` (plain) present.
3. `restore.apply` — `pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error` into the target (plain SQL: `psql -v ON_ERROR_STOP=1`).
4. `verify.schema` — `verify-db-schema.mjs` against the target.
5. `verify.integrity` — `verify-data-integrity.mjs` against the target (BLOCKER → drill FAIL; WARNINGS are printed for review).
6. `smoke.read_only` — bounded counts inside a `READ ONLY` transaction: users, roles, permissions, leads, activities, scheduled activities, notifications, audit rows, and **at least one active ADMIN/SUPERADMIN** (a restore without an administrator is not usable).

Then, manually: point a **non-production** app instance at the target and
verify login, one lead read and one follow-up read.

### Evidence to record per drill

- dump file name, size, SHA-256 (from `verify:backup`)
- backup timestamp vs. drill time (RPO evidence) and drill duration (RTO evidence)
- `restore:drill` output (all step lines) and `verify:data-integrity` output
- the operator, the date, and the target's redacted URL

Store the evidence with the release/incident record. **Until a drill has been
run against a real dump and its evidence recorded, LeadFlow does not have a
verified backup** — the existence of provider backups (§4) is an external
operational dependency, not a verified capability of this system.

---

## 10. When NOT to restore — forward-fix vs. restore

Restoring replaces **every** row written since the backup. It is the right
tool for a small set of situations and the wrong tool for most.

**Do NOT restore when:**

- the damage is scoped (one campaign purge, one bulk import, a handful of
  rows) and `audit_logs` / `assignment_history` / `status_history` identify
  exactly what changed — forward-fix those rows instead;
- the "corruption" is a WARNING-class drift (`reporting_chain_stale`,
  `owner_shadow_mismatch`, terminal anomalies) — these are recomputed or
  corrected through the application;
- the schema is incomplete after a failed migration — re-run the idempotent
  migrations / fix forward (`INCIDENT_RESPONSE_RUNBOOK.md` §7);
- writes have continued for hours since the backup and the business cannot
  absorb losing them;
- the backup has not been verified (§8) and drilled (§9) — an unverified
  restore can make an incident worse.

**Decision tree**

```
Is data actually lost/corrupted?  (verify:data-integrity → BLOCKERs? audit_logs?)
 ├─ no  → forward-fix / recompute; no restore
 └─ yes → Is the affected set identifiable from audit_logs / history JSON?
           ├─ yes → forward-fix the identified rows in a reviewed, transactional change
           └─ no  → Is the corruption window shorter than the writes you would lose?
                     ├─ no  → forward-fix + accept documented gap
                     └─ yes → restore the last verified dump into a SCRATCH target (restore:drill),
                              compare counts/invariants, extract or cut over only after go/no-go;
                              never pg_restore --clean over live production
```

**Restore is justified when:** the primary database is unrecoverable, a
destructive migration or mass operation cannot be reconstructed from
history, or the provider requires it — and only after a verified drill and
an explicit go/no-go decision (`INCIDENT_RESPONSE_RUNBOOK.md` §11).
