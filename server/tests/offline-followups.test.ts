/**
 * offline-followups.test.ts
 * ------------------------------------------------------------------
 * Phase 3 PR #2 — offline follow-up capture: on-device outbox +
 * idempotent sync.
 *
 *   1. Migration 050 — registered as the tail; creates
 *      processed_followup_mutations; idempotent.
 *   2. Server idempotency over real HTTP (PGlite): the same
 *      clientMutationId posted twice applies the follow-up EXACTLY
 *      ONCE (status history, follow_up_count, activity rows all
 *      prove it) and the retry is answered from the recorded outcome
 *      (deduplicated:true, same activity id); two different ids apply
 *      twice; no id keeps the legacy behaviour; a malformed id is a
 *      400; a failed application (404 lead) rolls the claim back so
 *      the id can still be used.
 *   3. Client outbox core — pure queue state machine: enqueue dedupe,
 *      FIFO order, attempt/attention/requeue transitions, per-user
 *      isolation of listing + counts, status classifiers.
 *   4. Wiring guards — the submit path mints + sends the mutation id
 *      and queues ONLY on network failure; the Workbench indicator,
 *      the sync triggers and the call-site "Saved offline" handling
 *      are in place.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';

import {
  enqueueEntry,
  entriesForUser,
  isAttentionStatus,
  isAuthFailureStatus,
  isNetworkFailureStatus,
  markAttention,
  markAttemptFailed,
  newMutationId,
  nextQueuedEntry,
  outboxCounts,
  removeEntry,
  requeueEntry,
  type FollowUpOutboxEntry,
} from '../../src/modules/leads/utils/followUpOutboxCore';

const JWT_SECRET = '<MASKED_SECRET_002>';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

async function setupSchema(pool: any) {
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL,
      alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150),
      address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100),
      priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2),
      notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID,
      last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'New',
      status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb,
      documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb,
      created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT,
      next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255),
      collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2),
      product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value))`);
}

const MUT_A = '11111111-1111-4111-8111-111111111111';
const MUT_B = '22222222-2222-4222-8222-222222222222';
const MUT_C = '33333333-3333-4333-8333-333333333333';
const MUT_D = '44444444-4444-4444-8444-444444444444';
const MISSING_LEAD = '99999999-9999-4999-8999-999999999999';

describe('Offline follow-up capture — idempotent sync (Phase 3 PR #2)', () => {
  let pool: any;
  let app: express.Express;
  let employeeA: any;

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/leadflow_test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);
    // The table under test is created by the REAL migration.
    const { up } = await import('../database/migrations/050_processed_followup_mutations.js');
    await up();

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = (deptRes.rows[0] as any).id;
    const roleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const roleId = (roleRes.rows[0] as any).id;
    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, (res.rows[0] as any).id]);
    }
    const statuses = ['New', 'Contacted', 'Interested', 'Follow-up Set', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, true) ON CONFLICT DO NOTHING`, [statuses[i], i + 1]);
    }
    const empRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'Employee A', 'empaa@test.com', 'hashed', $1, $2, true) RETURNING id`, [roleId, deptId]);
    employeeA = { id: (empRes.rows[0] as any).id, employeeId: 'EMPA', email: 'empaa@test.com', role: 'EMPLOYEE' };

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    try { await pool.query(`DELETE FROM processed_followup_mutations`); } catch {}
    try { await pool.query(`DELETE FROM lead_activities`); } catch {}
    try { await pool.query(`DELETE FROM leads`); } catch {}
  });

  function token(): string {
    return signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
  }

  async function createLead(): Promise<any> {
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${token()}`).send({
      customerName: 'Offline Prospect',
      mobile: `0170000${Math.floor(1000 + Math.random() * 9000)}`,
    });
    assert.equal(res.status, 200, `createLead failed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function postFollowUp(leadId: string, body: Record<string, any>) {
    return request(app).post(`/api/leads/${leadId}/follow-up`).set('Authorization', `Bearer ${token()}`).send(body);
  }

  async function leadState(leadRef: string) {
    // The API's public lead id is the lead_code; resolve the row the
    // same dual way the handler does, then count activities by PK.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadRef);
    const res: any = await pool.query(
      `SELECT id, current_status, follow_up_count, jsonb_array_length(COALESCE(status_history, '[]'::jsonb)) AS hist_len FROM leads WHERE lead_code = $1 OR id = $2`,
      [leadRef, isUuid ? leadRef : null]
    );
    const acts: any = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1`, [res.rows[0].id]);
    return { ...res.rows[0], activities: acts.rows[0].n };
  }

  it('migration 050 is registered (051_lead_sla_config later became the tail)', () => {
    assert.ok(MIGRATION_IDS.includes('050_processed_followup_mutations'));
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('050_processed_followup_mutations'));
  });

  it('migration 050 is idempotent (up() can run twice)', async () => {
    const { up } = await import('../database/migrations/050_processed_followup_mutations.js');
    await up();
    const res: any = await pool.query(`SELECT COUNT(*)::int AS n FROM processed_followup_mutations`);
    assert.equal(res.rows[0].n, 0);
  });

  it('same clientMutationId twice applies EXACTLY ONCE and replays the recorded outcome', async () => {
    const lead = await createLead();
    const body = { status: 'Contacted', remarks: 'Called from the field', clientMutationId: MUT_A };

    const first = await postFollowUp(lead.id, body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.deduplicated, undefined);

    const retry = await postFollowUp(lead.id, body);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.deduplicated, true);
    assert.equal(retry.body.data.activity.id, first.body.data.activity.id);
    assert.equal(retry.body.data.lead.currentStatus, 'Contacted');

    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 1);
    assert.equal(state.hist_len, 1);
    assert.equal(state.activities, 1);
    assert.equal(state.current_status, 'Contacted');
  });

  it('two different mutation ids apply twice (each is a distinct submission)', async () => {
    const lead = await createLead();
    const r1 = await postFollowUp(lead.id, { status: 'Contacted', remarks: 'one', clientMutationId: MUT_A });
    const r2 = await postFollowUp(lead.id, { status: 'Contacted', remarks: 'two', clientMutationId: MUT_B });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 2);
    assert.equal(state.activities, 2);
  });

  it('no clientMutationId keeps legacy behaviour (every post applies)', async () => {
    const lead = await createLead();
    await postFollowUp(lead.id, { status: 'Contacted', remarks: 'one' });
    await postFollowUp(lead.id, { status: 'Contacted', remarks: 'two' });
    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 2);
    const claims: any = await pool.query(`SELECT COUNT(*)::int AS n FROM processed_followup_mutations`);
    assert.equal(claims.rows[0].n, 0);
  });

  it('malformed clientMutationId is a 400 and applies nothing', async () => {
    const lead = await createLead();
    const res = await postFollowUp(lead.id, { status: 'Contacted', clientMutationId: '<MASKED_SECRET_001>' });
    assert.equal(res.status, 400);
    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 0);
    assert.equal(state.activities, 0);
  });

  it('a validation-rejected submission does not burn the mutation id (corrected retry applies)', async () => {
    const lead = await createLead();
    const bad = await postFollowUp(lead.id, { status: 'Bogus Status', clientMutationId: MUT_C });
    assert.equal(bad.status, 400);
    const fixed = await postFollowUp(lead.id, { status: 'Contacted', remarks: 'fixed', clientMutationId: MUT_C });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 1);
  });

  it('a failed application (missing lead, 404 inside the tx) rolls the claim back', async () => {
    const missing = await postFollowUp(MISSING_LEAD, { status: 'Contacted', clientMutationId: MUT_D });
    assert.equal(missing.status, 404);
    const lead = await createLead();
    const ok = await postFollowUp(lead.id, { status: 'Contacted', remarks: 'real', clientMutationId: MUT_D });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.deduplicated, undefined);
    const state = await leadState(lead.id);
    assert.equal(state.follow_up_count, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Client outbox core — pure queue state machine                        */
/* ------------------------------------------------------------------ */

function entry(overrides: Partial<FollowUpOutboxEntry> = {}): FollowUpOutboxEntry {
  return {
    mutationId: 'm-1',
    leadId: 'lead-1',
    leadLabel: 'Prospect One',
    userId: 'user-a',
    payload: { status: 'Contacted' },
    queuedAt: '2026-11-04T00:00:00.000Z',
    attempts: 0,
    state: 'queued',
    ...overrides,
  };
}

describe('Follow-up outbox core (pure queue logic)', () => {
  it('newMutationId returns distinct UUID-shaped ids', () => {
    const a = newMutationId();
    const b = newMutationId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(a, b);
  });

  it('enqueue appends FIFO and never queues the same mutation twice', () => {
    let q = enqueueEntry([], entry({ mutationId: 'm-1' }));
    q = enqueueEntry(q, entry({ mutationId: 'm-2', leadId: 'lead-2' }));
    q = enqueueEntry(q, entry({ mutationId: 'm-1' }));
    assert.equal(q.length, 2);
    assert.equal(nextQueuedEntry(q, 'user-a')?.mutationId, 'm-1');
  });

  it('per-user isolation: listing, next and counts never leak across users', () => {
    const q = [
      entry({ mutationId: 'm-1', userId: 'user-a' }),
      entry({ mutationId: 'm-2', userId: 'user-b' }),
      entry({ mutationId: 'm-3', userId: 'user-a', state: 'attention', lastError: 'rejected' }),
    ];
    assert.deepEqual(entriesForUser(q, 'user-a').map(e => e.mutationId), ['m-1', 'm-3']);
    assert.equal(nextQueuedEntry(q, 'user-b')?.mutationId, 'm-2');
    assert.deepEqual(outboxCounts(q, 'user-a'), { pending: 1, attention: 1, total: 2 });
    assert.deepEqual(outboxCounts(q, 'user-b'), { pending: 1, attention: 0, total: 1 });
  });

  it('transient failure keeps the entry queued with attempts + 1', () => {
    const q = markAttemptFailed([entry()], 'm-1', 'offline');
    assert.equal(q[0].state, 'queued');
    assert.equal(q[0].attempts, 1);
    assert.equal(q[0].lastError, 'offline');
  });

  it('server rejection moves the entry to attention; Retry requeues it; removal is explicit only', () => {
    let q = markAttention([entry()], 'm-1', 'Unknown status "X".');
    assert.equal(q[0].state, 'attention');
    assert.equal(q[0].lastError, 'Unknown status "X".');
    assert.equal(nextQueuedEntry(q, 'user-a'), undefined);
    q = requeueEntry(q, 'm-1');
    assert.equal(q[0].state, 'queued');
    assert.equal(q[0].lastError, undefined);
    assert.equal(nextQueuedEntry(q, 'user-a')?.mutationId, 'm-1');
    q = removeEntry(q, 'm-1');
    assert.equal(q.length, 0);
  });

  it('status classifiers: network=0, auth=401, definitive 4xx=attention, 5xx=transient', () => {
    assert.equal(isNetworkFailureStatus(0), true);
    assert.equal(isNetworkFailureStatus(500), false);
    assert.equal(isAuthFailureStatus(401), true);
    assert.equal(isAttentionStatus(400), true);
    assert.equal(isAttentionStatus(403), true);
    assert.equal(isAttentionStatus(409), true);
    assert.equal(isAttentionStatus(401), false);
    assert.equal(isAttentionStatus(500), false);
    assert.equal(isAttentionStatus(200), false);
  });

  it('wiring guards: submit path, queue triggers, indicator and call sites', () => {
    const leadService = readFileSync('src/modules/leads/services/leadService.ts', 'utf8');
    assert.ok(leadService.includes('clientMutationId'), 'leadService must send the mutation id');
    assert.ok(leadService.includes('enqueueFollowUp'), 'leadService must queue on network failure');
    assert.ok(leadService.includes('err.status === 0'), 'queueing must be network-failure only');

    const sync = readFileSync('src/modules/leads/services/followUpSync.ts', 'utf8');
    assert.ok(sync.includes("addEventListener('online'"), 'flush on the online event');
    assert.ok(sync.includes('visibilitychange'), 'flush on visibility return');
    assert.ok(sync.includes('isAuthFailureStatus'), 'flush must pause on 401');

    const workbench = readFileSync('src/modules/workbench/pages/DailyWorkbench.tsx', 'utf8');
    assert.ok(workbench.includes('OutboxIndicator'), 'Workbench header must show the indicator');
    assert.ok(workbench.includes('FOLLOWUP_SYNCED'), 'Workbench must refresh after a sync');

    const main = readFileSync('src/main.tsx', 'utf8');
    assert.ok(main.includes('installFollowUpOutboxSync'), 'sync triggers must be installed at boot');

    for (const page of ['src/modules/leads/pages/LeadUpdate.tsx', 'src/modules/leads/pages/LeadList.tsx']) {
      const src = readFileSync(page, 'utf8');
      assert.ok(src.includes('FollowUpQueuedOfflineError'), `${page} must handle the queued-offline case`);
      assert.ok(src.includes('Saved offline'), `${page} must tell the agent the follow-up was saved offline`);
    }

    const sw = readFileSync('public/sw.js', 'utf8');
    assert.ok(!sw.includes("addEventListener('fetch'"), 'this PR must not add a fetch-caching handler to sw.js');
  });
});
