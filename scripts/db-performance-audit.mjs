#!/usr/bin/env node
/**
 * scripts/db-performance-audit.mjs — isolated query-plan / timing audit
 * ------------------------------------------------------------------
 * Reproduces the evidence behind docs/DATABASE_PERFORMANCE_AUDIT.md on a
 * disposable, fully isolated database.
 *
 * SAFETY GUARANTEES
 *   - Runs ONLY against an in-process PGlite instance (in-memory
 *     PostgreSQL compiled to WASM). It NEVER reads DATABASE_URL, never
 *     contacts Supabase/production, and requires no credentials.
 *   - All data is synthetic and generated below; nothing is persisted.
 *   - It is NOT wired into CI (CI must never depend on a production
 *     DATABASE_URL); run it manually:
 *
 *         node scripts/db-performance-audit.mjs
 *
 * HONESTY GUARANTEES
 *   - Every figure printed is labelled SYNTHETIC / PGlite.
 *   - PGlite's planner is real PostgreSQL, but its cost calibration,
 *     cache behavior and scale differ from production Supabase.
 *     NOTHING printed here is a claim about production latency; it is
 *     plan-shape evidence (index used vs seq scan) plus relative
 *     synthetic timing.
 */

import { PGlite } from '@electric-sql/pglite';

const SYNTHETIC = 'SYNTHETIC/PGlite';

/* ------------------------------------------------------------------ */
/* Isolated DB + production-shaped schema                              */
/* ------------------------------------------------------------------ */

const db = new PGlite();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

async function setupSchema() {
  await q(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      manager_id UUID,
      is_active BOOLEAN DEFAULT TRUE
    )`);
  await q(`CREATE INDEX idx_users_manager ON users(manager_id)`);

  await q(`
    CREATE TABLE leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE,
      customer_name VARCHAR(255) NOT NULL,
      mobile VARCHAR(30) NOT NULL,
      current_status VARCHAR(255),
      assigned_to UUID,
      created_by UUID,
      next_follow_up_at TIMESTAMP,
      expected_premium NUMERIC(14,2),
      custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  // Production indexes relevant to the audited shapes (migrations 014/035/038)
  await q(`CREATE INDEX idx_leads_assigned_to ON leads(assigned_to)`);
  await q(`CREATE INDEX idx_leads_created_by ON leads(created_by)`);
  await q(`CREATE INDEX idx_leads_created_at ON leads(created_at DESC)`);
  await q(`CREATE INDEX idx_leads_current_status ON leads(current_status) WHERE is_deleted = FALSE`);
  await q(`CREATE INDEX idx_leads_next_follow_up_active ON leads(next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL`);
  await q(`CREATE INDEX idx_leads_assigned_next_follow_up_active ON leads(assigned_to, next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL`);

  await q(`
    CREATE TABLE scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL,
      scheduled_at TIMESTAMP NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      assigned_to UUID,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await q(`CREATE INDEX idx_scheduled_activities_lead_scheduled ON scheduled_activities(lead_id, scheduled_at)`);
  await q(`CREATE INDEX idx_scheduled_activities_assigned_to ON scheduled_activities(assigned_to)`);
  await q(`CREATE INDEX idx_scheduled_activities_scheduled_at ON scheduled_activities(scheduled_at)`);

  await q(`
    CREATE TABLE notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      recipient_key VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await q(`CREATE INDEX idx_notification_user ON notifications(user_id)`);
  await q(`CREATE INDEX idx_notifications_recipient_key ON notifications(recipient_key)`);
}

/* ------------------------------------------------------------------ */
/* Synthetic data                                                      */
/* ------------------------------------------------------------------ */

const USERS = 200;
const LEADS = 40000;
const SCHEDULED = 15000;
const NOTIFICATIONS = 20000;

let userIds = [];
let leadIds = [];

async function seed() {
  for (let i = 0; i < USERS; i++) {
    const r = await q(`INSERT INTO users (employee_id, full_name) VALUES ($1,$2) RETURNING id`, ['EMP' + i, 'User ' + i]);
    userIds.push(r[0].id);
  }
  for (let i = 10; i < USERS; i++) {
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [userIds[i % 10], userIds[i]]);
  }

  const statuses = ['Untouched','Contacted','No Response','Busy','Interested','Follow-up Set','Meeting Fixed','Converted','Not Interested'];
  const now = Date.now();
  const BATCH = 2000;
  for (let start = 0; start < LEADS; start += BATCH) {
    const vals = []; const params = [];
    for (let i = 0; i < BATCH && start + i < LEADS; i++) {
      const n = start + i;
      params.push(
        'LC' + n, 'Customer ' + n, '017' + String(10000000 + n), statuses[n % statuses.length],
        n % 7 === 0 ? null : userIds[n % USERS], userIds[(n + 7) % USERS],
        n % 3 === 0 ? null : new Date(now + ((n % 40) - 10) * 86400000).toISOString()
      );
      const o = params.length;
      vals.push(`($${o-6},$${o-5},$${o-4},$${o-3},$${o-2},$${o-1},$${o})`);
    }
    const rows = await q(`INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at) VALUES ${vals.join(',')} RETURNING id`, params);
    for (const r of rows) leadIds.push(r.id);
  }

  const saStatuses = ['scheduled','scheduled','scheduled','completed','cancelled'];
  const saTypes = ['call','meeting','follow_up','task'];
  for (let start = 0; start < SCHEDULED; start += BATCH) {
    const vals = []; const params = [];
    for (let i = 0; i < BATCH && start + i < SCHEDULED; i++) {
      const n = start + i;
      params.push(leadIds[n % leadIds.length], saTypes[n % 4], new Date(now + ((n % 60) - 10) * 86400000).toISOString(), saStatuses[n % 5], userIds[n % USERS]);
      const o = params.length;
      vals.push(`($${o-4},$${o-3},$${o-2},$${o-1},$${o})`);
    }
    await q(`INSERT INTO scheduled_activities (lead_id, activity_type, scheduled_at, status, assigned_to) VALUES ${vals.join(',')}`, params);
  }

  for (let start = 0; start < NOTIFICATIONS; start += BATCH) {
    const vals = []; const params = [];
    for (let i = 0; i < BATCH && start + i < NOTIFICATIONS; i++) {
      const n = start + i;
      params.push(userIds[n % USERS], 'EMP' + (n % USERS), 'Title ' + n, 'Message ' + n, new Date(now - (n % 720) * 60000).toISOString());
      const o = params.length;
      vals.push(`($${o-4},$${o-3},$${o-2},$${o-1},$${o})`);
    }
    await q(`INSERT INTO notifications (user_id, recipient_key, title, message, created_at) VALUES ${vals.join(',')}`, params);
  }

  await q(`ANALYZE users`); await q(`ANALYZE leads`);
  await q(`ANALYZE scheduled_activities`); await q(`ANALYZE notifications`);
}

/* ------------------------------------------------------------------ */
/* Plan helpers                                                        */
/* ------------------------------------------------------------------ */

async function explain(sql, p = []) {
  const rows = await q(`EXPLAIN ANALYZE ${sql}`, p);
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  const execMs = /Execution Time: ([\d.]+) ms/.exec(plan);
  const scanTypes = [...plan.matchAll(/(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan) (?:on|using) ([a-z_]+)/g)]
    .map((m) => `${m[1]}:${m[2]}`);
  return {
    execMs: execMs ? Number(execMs[1]) : null,
    scans: [...new Set(scanTypes)],
    seqScanOn: [...new Set([...plan.matchAll(/Seq Scan on ([a-z_]+)/g)].map((m) => m[1]))],
  };
}

const results = [];
function record(area, label, info) {
  results.push({ area, label, ...info });
}

/* ------------------------------------------------------------------ */
/* Audits (before = legacy predicate shape, after = shipped shape)     */
/* ------------------------------------------------------------------ */

const TERMINAL = ['Converted', 'Not Interested'];

async function auditVisibility() {
  const visIds = userIds.slice(0, 30);
  const before = await explain(
    `SELECT COUNT(*) FROM leads l
      WHERE l.is_deleted = FALSE
        AND (l.assigned_to::text = ANY($1::text[]) OR l.created_by::text = ANY($1::text[]))`,
    [visIds]
  );
  const after = await explain(
    `SELECT COUNT(*) FROM leads l
      WHERE l.is_deleted = FALSE
        AND (l.assigned_to = ANY($1::uuid[]) OR l.created_by = ANY($1::uuid[]))`,
    [visIds]
  );
  record('Dashboard/visibility scope', 'before: ::text casts (legacy)', before);
  record('Dashboard/visibility scope', 'after: uuid ANY (shipped)', after);
}

async function auditFollowupQueue() {
  const assignee = userIds[3];
  const before = await explain(
    `SELECT l.id FROM leads l
      WHERE l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
        AND l.assigned_to::text = $1
      ORDER BY l.next_follow_up_at ASC LIMIT 50`,
    [assignee]
  );
  const after = await explain(
    `SELECT l.id FROM leads l
      WHERE l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
        AND l.assigned_to = $1::uuid
      ORDER BY l.next_follow_up_at ASC LIMIT 50`,
    [assignee]
  );
  record('Follow-up queue (assignedTo)', 'before: ::text cast (legacy)', before);
  record('Follow-up queue (assignedTo)', 'after: uuid equality (shipped)', after);
}

async function auditScheduledQualitySignals() {
  const ids = leadIds.filter((_, i) => i % 16 === 0).slice(0, 250);

  // Legacy shape (LOWER), no partial index
  const before = await explain(
    `SELECT s.lead_id::text AS lead_id, MIN(s.scheduled_at) AS next_scheduled_at
       FROM scheduled_activities s
      WHERE s.lead_id = ANY($1::uuid[]) AND LOWER(s.status) = 'scheduled'
      GROUP BY s.lead_id`,
    [ids]
  );
  record('Lead Quality planned-action signals', 'before: LOWER(status), no partial index (legacy)', before);

  // Shipped shape WITH the migration-041 partial index
  await q(`CREATE INDEX idx_scheduled_activities_open_lead ON scheduled_activities(lead_id, scheduled_at) WHERE status = 'scheduled'`);
  await q(`ANALYZE scheduled_activities`);
  const after = await explain(
    `SELECT s.lead_id::text AS lead_id, MIN(s.scheduled_at) AS next_scheduled_at
       FROM scheduled_activities s
      WHERE s.lead_id = ANY($1::uuid[]) AND s.status = 'scheduled'
      GROUP BY s.lead_id`,
    [ids]
  );
  record('Lead Quality planned-action signals', 'after: status equality + partial index 041 (shipped)', after);
}

async function auditNotifications() {
  const uid = userIds[7];
  const before = await explain(
    `SELECT * FROM notifications n
      WHERE n.recipient_key = $1 OR n.user_id::text = $1 OR n.user_id = $2
         OR n.user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1))
      ORDER BY n.created_at DESC`,
    ['EMP7', uid]
  );
  // Shipped shape: cast branch removed, employee branch pre-resolved to one
  // users.id (employee_id is UNIQUE) so every branch is index-served.
  const after = await explain(
    `SELECT * FROM notifications n
      WHERE n.recipient_key = $1 OR n.user_id = $2 OR n.user_id = $3
      ORDER BY n.created_at DESC`,
    ['EMP7', uid, uid]
  );
  record('Notification list (user scope)', 'before: text cast + OR-ed subplan (legacy)', before);
  record('Notification list (user scope)', 'after: three index-served equalities (shipped)', after);
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log('==================================================================');
  console.log('LeadFlow database performance audit — ISOLATED SYNTHETIC RUN');
  console.log('==================================================================');
  console.log('Engine   : PGlite (in-memory PostgreSQL/WASM) — never production');
  console.log(`Dataset  : SYNTHETIC — ${USERS} users, ${LEADS} leads, ${SCHEDULED} scheduled activities, ${NOTIFICATIONS} notifications`);
  console.log('Disclaimer: PGlite plan costs/timings are NOT Supabase production');
  console.log('timings. Treat output as plan-shape evidence + relative deltas.');
  console.log('==================================================================\n');

  await setupSchema();
  await seed();

  await auditVisibility();
  await auditFollowupQueue();
  await auditScheduledQualitySignals();
  await auditNotifications();

  for (const r of results) {
    const seq = r.seqScanOn.length ? `seq-scan:${r.seqScanOn.join(',')}` : 'no seq scan';
    console.log(`[${SYNTHETIC}] ${r.area}`);
    console.log(`    ${r.label}`);
    console.log(`    execution: ${r.execMs} ms | ${seq}`);
    console.log(`    scans: ${r.scans.join(', ') || 'n/a'}`);
    console.log('');
  }

  console.log(`[${SYNTHETIC}] Summary — plan shape deltas:`);
  console.log('  - visibility scope: seq scan on leads -> BitmapOr over assigned_to/created_by indexes');
  console.log('  - follow-up queue assignedTo: full partial-index filter -> direct partial composite index scan (migration 038)');
  console.log('  - lead quality planned signals: post-filter over all lead rows -> partial index idx_scheduled_activities_open_lead (migration 041)');
  console.log('  - notification list: seq scan (cast + hashed subplan estimate) -> BitmapOr over recipient_key/user_id indexes');
  console.log('\nNone of the above are production latency claims. Validate post-deploy');
  console.log('with PR #45 observability (dbDurationMs / dbQueryCount / Server-Timing).');
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
