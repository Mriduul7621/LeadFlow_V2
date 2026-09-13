# LeadFlow — Incident Response Runbook

Concise production incident procedure. Each category answers four questions:
**first verification → containment → recovery direction → evidence to
preserve**, plus when **not** to perform a destructive action.

General escalation/decision guidance is in §11. No external incident
platform is required or assumed.

---

## 0. Immediate checks for any incident

```bash
BASE=https://<host>
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/api/health"
curl -sS "$BASE/api/health/readiness"     # 200 ready vs 503 not_ready + failing check
curl -sS "$BASE/api/db-status"            # connected:true/false, mode
```

These three tell you whether the runtime, the configuration and the database
are each healthy — without exposing secrets.

---

## 1. Application unavailable

- **Verify:** `/api/health` timing out / 5xx; Vercel function logs; last
  deploy state.
- **Contain:** confirm it is not a deploy-in-progress; if it is a bad release,
  redeploy the previous known-good deployment (application rollback).
- **Recover:** redeploy previous version, then re-run the smoke test.
- **Evidence:** health/readiness output, function logs, deploy history,
  timestamps.
- **Do not** restore the database for a pure application failure.

## 2. Database unavailable

- **Verify:** `/api/db-status` → `database-unreachable` / 503; readiness →
  `not_ready` with `database.reachable:false`; provider console status.
- **Contain:** confirm whether it is a provider outage vs. credential/network
  change vs. connection-pool exhaustion. **Do not** start mutating data.
- **Recover:** wait for provider recovery, or fix the connection/credential,
  or scale down connection pressure; then verify `db-status` → connected.
- **Evidence:** db-status/readiness bodies, provider status page, connection
  error codes (`ECONNREFUSED`, `57P01`, `08006`, …).
- **Do not** enable demo/in-memory mode or switch to a different store.

## 3. Login unavailable

- **Verify:** login 5xx vs 429 vs 401; auth limiter logs
  (`[security] auth rate limit exceeded`); `JWT_SECRET` config validity.
- **Contain:** if 429, it is rate limiting (by design) — wait/whitelist; if
  5xx, it is database/config — see §2 and check `[config] BLOCKER` logs.
- **Recover:** fix the underlying DB/config issue; **never** rotate
  `JWT_SECRET` in place while users hold valid tokens without a deliberate
  session-invalidation plan.
- **Evidence:** status codes, limiter logs, config validation output.
- **Do not** disable the auth limiter to "fix" logins.

## 4. Severe latency

- **Verify:** function latency, DB query latency, connection-pool saturation;
  `createPerf` spans in logs where enabled.
- **Contain:** identify the hot path (dashboard? bulk import? a missing
  index). Throttle or disable the specific feature if it is abusive.
- **Recover:** add/verify index, bound the query, or scale; re-measure.
- **Evidence:** latency traces, query plans, pool metrics, timestamps.
- **Do not** raise global rate limits as a latency fix.

## 5. Permission / access incident

- **Verify:** an unauthorized action succeeded (403 missing) or an authorized
  action failed (false 403). Confirm against the canonical permission catalog
  and the caller's role.
- **Contain:** if a privilege is wrongly granted, revoke the grant row
  (`role_permissions` / `user_permissions`) — do **not** delete users.
- **Recover:** correct the grant, audit `audit_logs` for what the window
  allowed.
- **Evidence:** audit-log rows, the permission rows, the affected account,
  request logs.
- **Do not** disable RBAC checks; fix the grant.

## 6. Failed deployment

- **Verify:** Vercel build/deploy failure vs. runtime failure after deploy.
- **Contain:** redeploy previous known-good deployment; do not merge further
  on top of a broken head.
- **Recover:** fix forward, re-run the gate, redeploy.
- **Evidence:** build logs, deploy history, CI status.
- **Do not** leave the broken revision serving "while you investigate".

## 7. Failed migration

- **Verify:** `npm run verify:db-schema` → missing tables; startup logs show
  migration failure.
- **Contain:** stop writes if the schema is half-applied; do **not** re-run
  partially-applied destructive DDL blindly.
- **Recover:** forward-fix with an idempotent migration, or restore from a
  pre-migration backup (see `BACKUP_RESTORE_RUNBOOK.md` §5–6).
- **Evidence:** migration logs, `verify:db-schema` output, backup SHA.
- **Do not** revert a destructive migration after data was written.

## 8. Suspected data corruption

- **Verify:** integrity queries (orphan FK checks in
  `BACKUP_RESTORE_RUNBOOK.md` §6), application misbehaviour, audit-log
  anomalies.
- **Contain:** stop writes immediately; freeze the database; do **not** run
  repair scripts speculatively.
- **Recover:** determine the corruption window, then restore the last
  known-good point into a scratch instance, validate, and cut over — or
  forward-fix only after root cause is understood.
- **Evidence:** pre- and post-corruption dumps/SHAs, audit logs, queries.
- **Do not** overwrite live data with an unvalidated restore.

## 9. Accidental bulk operation

- **Verify:** scope of the bulk create/update/delete (row counts, timestamps
  in `audit_logs` for `users-bulk-import`, campaign/clear-all actions).
- **Contain:** stop further bulk actions; identify the exact rows affected.
- **Recover:** if the operation is recoverable from audit/backup, restore the
  affected rows or the last good backup; otherwise forward-fix and document.
- **Evidence:** audit-log entries, the import file name, affected row counts.
- **Do not** run a second bulk operation to "undo" the first.

## 10. Notification failure

- **Verify:** notifications not created/delivered (check `notifications` table
  and the relevant logs). Note: server-side notification **reliability** is a
  planned roadmap item, so today's notifications are synchronous/best-effort.
- **Contain:** confirm it is a notification issue and not a DB issue (§2).
- **Recover:** re-create the missed notifications manually where safe, or
  accept the gap and record it; escalate to the Notification Reliability item.
- **Evidence:** notification rows, trigger timestamps, logs.
- **Do not** mass-insert notifications without understanding the trigger.

---

## 11. Escalation & decision guidance

- **Severity = user impact + data risk + reversibility.** A read-only
  slowdown is lower than a write-path data-integrity risk.
- **Declare an incident** as soon as any of §0's checks show `not_ready`, or
  a write path is failing, or data integrity is in doubt.
- **First action is containment** (stop writes / roll back app / isolate),
  **second is diagnosis**, **third is recovery**, **fourth is post-mortem**.
- **Never** perform a destructive action (restore-over-prod, revert a
  destructive migration, drop data) without a validated backup and an
  explicit go/no-go decision.
- Preserve logs, dumps and timestamps **before** recovering — evidence is
  destroyed by the same action that fixes the incident.
