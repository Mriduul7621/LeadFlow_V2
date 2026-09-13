# LeadFlow — Production Release Runbook

Operating procedure for releasing LeadFlow to production. Complements
`PRODUCTION_READINESS.md` (contracts, Go/No-Go) and
`BACKUP_RESTORE_RUNBOOK.md` / `INCIDENT_RESPONSE_RUNBOOK.md` (recovery).

---

## 1. Release sequence (end to end)

1. PR approved (review complete, conversations resolved).
2. `LeadFlow CI / validate` green on the PR head.
3. Vercel preview / build green.
4. Migration impact reviewed (§3).
5. Backup state verified (`BACKUP_RESTORE_RUNBOOK.md` §verify).
6. Merge to `main` (no force push; see §6).
7. `main` CI green on the merge commit.
8. Production deployment completes (Vercel).
9. Production smoke test green (`npm run smoke:production`).
10. Health + readiness verification (§4).
11. Critical business-flow verification
    (`PRODUCTION_READINESS.md` §9).
12. Monitor errors / latency (§5).
13. Release accepted **or** rollback initiated (§7).

---

## 2. Pre-release

- Confirm the branch is based on the latest merged `main`.
- Confirm no secrets are staged (`git diff --check`; review the diff for
  `DATABASE_URL` / `JWT_SECRET` / key material).
- Run the local gate before pushing (same commands as CI):

  ```bash
  npm ci
  npm test -- --run
  npx tsc --noEmit
  npm run build
  npm run verify:serverless
  git diff --check
  ```

---

## 3. Migration procedure

LeadFlow applies migrations automatically at startup (idempotent
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT EXISTS` DDL plus
empty-table seeds). There is no separate migration CLI and no version ledger.

- **Review** every migration file in the release diff. Classify each as
  additive (safe), or destructive (drop / rewrite / backfill).
- **Destructive migrations are the only ones that need a written plan**: a
  destructive step must be preceded by a verified backup and a rollback
  decision (see §7 — never "revert" a destructive migration blindly after
  data has been written).
- **Verify readiness after deploy** (never trust "no error in logs"):

  ```bash
  DATABASE_URL="$DATABASE_URL" npm run verify:db-schema
  ```

  This is read-only: connect, `SELECT 1`, compare `information_schema`
  against the expected table set, and exit non-zero when tables are missing.

- **Cold-start race note:** on serverless, the migration check runs per warm
  instance at first request. A failed migration is logged but not surfaced as
  readiness — always confirm with `verify:db-schema` and the readiness
  endpoint rather than assuming a green deploy means a complete schema.

---

## 4. Post-deployment verification

```bash
BASE=https://<host>

# liveness (must be 200, ok:true)
curl -sf "$BASE/api/health"

# database status (must be 200, connected:true)
curl -sf "$BASE/api/db-status"

# readiness (must be 200, status:"ready")
curl -sf "$BASE/api/health/readiness"

# full smoke test (read-only)
LEADFLOW_BASE_URL="$BASE" npm run smoke:production
```

Readiness is the definitive signal: `200 ready` means runtime + config +
database are all healthy. A `503 not_ready` includes the failing check
(`config.issues`, `database.reachable`) without leaking secrets.

---

## 5. Acceptance monitoring (first 24–48 h)

- Watch Vercel function logs for `[config] BLOCKER …`, `[api-error]`,
  `[readiness] … not_ready`, and `[security] … rate limit exceeded` lines.
- Watch `GET /api/db-status` for `database-unreachable` / `503`.
- Watch error rate and latency in the Vercel dashboard.
- If a BLOCKER or an unexpected `not_ready` appears, follow the incident
  runbook and be prepared to roll back.

---

## 6. GitHub / release protection

- The required check is **`LeadFlow CI / validate`** (see
  `CI_RELEASE_GATE.md`). This repository does **not** claim that branch
  protection is currently enabled — verify the live state in
  **Settings → Rules / Branches** before relying on it.
- Release policy **should** require: PR before merge, `LeadFlow CI / validate`,
  Vercel check (if desired), resolved conversations, and **no force push to
  `main`**. Apply these in GitHub settings; this PR does not change
  repository settings.

---

## 7. Rollback decision tree

Application and database rollback are **different** and decided separately.

### Application rollback

1. Identify the last known-good deployment / commit.
2. On Vercel, redeploy the previous known-good deployment (or
   `git revert` and redeploy) — no data is touched.
3. Re-run §4 verification.
4. If the app depends on a schema the database no longer has (or vice versa),
   treat it as a database-compatibility problem, not a pure redeploy.

### Database rollback

- **Never blindly revert a destructive migration after production data has
  been written.** A `DROP COLUMN` / rewrite that has already committed data
  changes cannot be "undone" by re-running the forward migration.
- Prefer **forward-fix** for data/schema drift: write a new migration that
  repairs forward, after restoring from a verified backup if necessary.
- Use **restore** only when the incident is contained and the restore point
  is known-good (see `BACKUP_RESTORE_RUNBOOK.md` §restore) — and only against
  a stopped-write database.

| Situation | Action |
| --- | --- |
| Bad app code, schema unaffected | Redeploy previous app. |
| Schema incomplete / migration failed | Forward-fix migration; verify with `verify:db-schema`. |
| Destructive migration already wrote data | Stop writes; restore from backup or forward-fix — do **not** revert the migration. |
| Data corruption suspected | Stop writes; declare incident; restore from backup after triage. |
| Widespread outage | Declare incident; follow `INCIDENT_RESPONSE_RUNBOOK.md`. |

**Stop writes** (e.g. pause traffic at the proxy / disable write endpoints /
take the app into maintenance) whenever continuing to write would worsen the
incident. **Declare incident** per the incident runbook whenever the outage
meets its severity thresholds.

---

## 8. Acceptance / sign-off

A release is **accepted** only when:

- every item in `PRODUCTION_READINESS.md` §8 (Go/No-Go) is green,
- §4 verification is green,
- §9 critical business flows (`PRODUCTION_READINESS.md`) are verified,
- known blocker defects = 0 and HIGH risks are explicitly signed off.

A release is **rejected** (rollback initiated) otherwise.
