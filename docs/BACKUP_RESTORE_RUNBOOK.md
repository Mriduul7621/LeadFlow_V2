# LeadFlow — Backup & Restore Runbook

Production readiness requires a real, tested backup-and-restore operating
procedure. This runbook documents **what is known to exist**, what the
operator must configure, and the exact steps to back up, restore and validate.
It does **not** claim automated backups exist unless they are verified —
see §4 (provider responsibility).

> A CSV/XLSX lead export is **not** a database backup. Business exports help
> operations but cannot recover users, roles, permissions, hierarchy,
> activities, audit history or configuration (see §7).

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
drill (see §5).

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
placeholders** (see `PRODUCTION_READINESS.md` §6, finding #5). Use the
PostgreSQL tools directly:

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
- Record the SHA-256 of the dump for tamper/verification.

### Restore (to a **separate** instance — never over live production)

```bash
createdb leadflow_restore_test
pg_restore --dbname="$RESTORE_URL" --no-owner --no-privileges \
  --clean --if-exists leadflow_<timestamp>.dump
```

Always restore into a scratch/verification instance first (§6). Restoring
over live production is destructive and is an incident action, not routine.

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
