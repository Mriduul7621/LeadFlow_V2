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

**Correlating a failing request (structured logs):** every API response
carries an `X-Request-ID` header, and every server log event carries the same
id as `"requestId":"…"` plus the deployment's `"build":"…"`. To trace one
request, filter Vercel Runtime Logs (or the standalone process log) for its
id — see `docs/PRODUCTION_OBSERVABILITY.md` §9. Key events:
`http_request_complete` (status + duration + DB time), `http_request_error`
(5xx, sanitized), `http_request_slow` / `db_query_slow` (latency),
`auth_*` / `rate_limit_rejected` (security), `readiness_check` (probe
outcomes).

---

## 1. Application unavailable

- **Verify:** `/api/health` timing out / 5xx; Vercel function logs; last
  deploy state. Confirm WHICH build is failing via the `"build"` field in
  structured log events and the `build` value in `/api/health/readiness`.
- **Contain:** confirm it is not a deploy-in-progress; if it is a bad release,
  redeploy the previous known-good deployment (application rollback).
- **Recover:** redeploy previous version, then re-run the smoke test.
- **Evidence:** health/readiness output, function logs (`http_request_error`
  events with their `requestId`), deploy history, timestamps.
- **Do not** restore the database for a pure application failure.

## 2. Database unavailable

- **Verify:** `/api/db-status` → `database-unreachable` / 503; readiness →
  `not_ready` with `database.reachable:false`; provider console status.
  Structured correlation: `readiness_check` warnings plus
  `http_request_error` events whose `errorCode` is a pg/connection code.
- **Contain:** confirm whether it is a provider outage vs. credential/network
  change vs. connection-pool exhaustion. **Do not** start mutating data.
- **Recover:** wait for provider recovery, or fix the connection/credential,
  or scale down connection pressure; then verify `db-status` → connected.
- **Evidence:** db-status/readiness bodies, provider status page, connection
  error codes (`ECONNREFUSED`, `57P01`, `08006`, …).
- **Do not** enable demo/in-memory mode or switch to a different store.

## 3. Login unavailable

- **Verify:** login 5xx vs 429 vs 401; the structured auth events
  (`rate_limit_rejected` with `limiter:"auth"`, `auth_login_failed`,
  `auth_token_rejected`); `JWT_SECRET` config validity. These logs never
  contain passwords, tokens, emails or submitted identifiers by design.
- **Contain:** if 429, it is rate limiting (by design) — wait/whitelist; if
  5xx, it is database/config — see §2 and check `[config] BLOCKER` logs.
- **Recover:** fix the underlying DB/config issue; **never** rotate
  `JWT_SECRET` in place while users hold valid tokens without a deliberate
  session-invalidation plan.
- **Evidence:** status codes, auth/rate-limit events (with `requestId`),
  config validation output.
- **Do not** disable the auth limiter to "fix" logins.

## 4. Severe latency

- **Verify:** whether slowness is systematic: filter logs for
  `"event":"http_request_slow"` (+ a `"route"` value) to see which routes
  breach `OBSERVABILITY_SLOW_REQUEST_MS` (default 2000 ms), and compare
  `durationMs` against `dbDurationMs`/`dbQueryCount` to decide auth vs. DB
  vs. application work; a single `db_query_slow` warning marks an individual
  >`OBSERVABILITY_SLOW_DB_MS` (default 750 ms) operation. `createPerf` spans
  (`Server-Timing`) remain available per route where instrumented.
- **Contain:** identify the hot path (dashboard? bulk import? a missing
  index). Throttle or disable the specific feature if it is abusive.
- **Recover:** add/verify index, bound the query, or scale; re-measure.
- **Evidence:** latency traces (`requestId`-correlated), query plans, pool
  metrics, timestamps.
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

- **Verify:** `npm run verify:db-schema` → missing tables/indexes; startup
  logs show `❌ Migration failed: migrations=failed completed=<n>/<total>
  failedAt=<name> error=<first line>` (the runner's failure marker names the
  exact migration; everything before it completed).
- **Contain:** stop writes if the schema is half-applied; do **not** re-run
  partially-applied destructive DDL blindly. All shipped migrations are
  idempotent (`IF NOT EXISTS` / guarded `DO $$` blocks), so a plain re-run
  (redeploy / cold start) is the normal recovery once the cause is fixed.
- **Recover:** forward-fix with an idempotent migration, re-run, then
  `verify:db-schema` **and** `npm run verify:data-integrity` (a BLOCKER here
  after a migration means the schema and the data disagree). Restore from a
  pre-migration backup only per `BACKUP_RESTORE_RUNBOOK.md` §10.
- **Evidence:** migration logs (failure marker line), `verify:db-schema` and
  `verify:data-integrity` output, backup SHA.
- **Do not** revert a destructive migration after data was written.

## 8. Suspected data corruption

- **Verify:** `DATABASE_URL=… npm run verify:data-integrity` (read-only;
  BLOCKER = structural/business break, WARNING = drift). Add `--diagnostic`
  to get opaque row ids for the failing invariants, then inspect those rows
  yourself. Correlate with application misbehaviour and `audit_logs`
  anomalies (`LEAD_CAMPAIGN_PURGE`, `LEAD_CLEAR_ALL`, `users-bulk-import`).
- **Contain:** stop writes immediately; freeze the database; do **not** run
  repair scripts speculatively — the checker never repairs, by design.
- **Recover:** decide forward-fix vs. restore with the decision tree in
  `BACKUP_RESTORE_RUNBOOK.md` §10. WARNING-class findings are corrected
  through the application (re-save the hierarchy link, reassign the lead,
  cancel the schedule). Only an unrecoverable BLOCKER window justifies a
  restore — into a scratch target first (`restore:drill`), validate, then
  go/no-go.
- **Evidence:** `verify:data-integrity` output before and after, pre- and
  post-corruption dumps/SHAs, audit logs, the queries you ran.
- **Do not** overwrite live data with an unvalidated restore.

## 9. Accidental bulk operation

- **Verify:** scope of the bulk create/update/delete — row counts and
  timestamps in `audit_logs` (`users-bulk-import`, `LEAD_CAMPAIGN_PURGE`,
  `LEAD_CLEAR_ALL`; the lead purges record actor + counts only). Soft-deleted
  leads keep `deleted_by` / `deleted_at`, so the affected set is
  `SELECT id FROM leads WHERE deleted_at BETWEEN … AND deleted_by = …`.
- **Contain:** stop further bulk actions; identify the exact rows affected.
- **Recover:** if the operation is recoverable from audit/backup, restore the
  affected rows or the last good backup; otherwise forward-fix and document.
- **Evidence:** audit-log entries, the import file name, affected row counts.
- **Do not** run a second bulk operation to "undo" the first.

## 10. Notification failure

- **Verify:** notifications not created/delivered (check `notifications`
  table; correlate the failing business request by its `X-Request-ID` →
  `http_request_error` / 5xx log events). System notifications (assignment,
  upline) are created **inside the business transaction** with a
  deterministic `idempotency_key` (PR #44): if the lead save committed, its
  notifications committed with it; a retry can never duplicate them. Run
  `verify:data-integrity` — `notifications.idempotency_index_present` /
  `notifications.idempotency_key_duplicate` must PASS.
- **Contain:** confirm it is a notification issue and not a DB issue (§2).
- **Recover:** a missing unique index (BLOCKER) means migrations did not
  complete → §7. Otherwise re-create missed notifications manually only where
  the business event is confirmed, or accept the gap and record it.
- **Evidence:** notification rows, trigger timestamps, logs, checker output.
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
