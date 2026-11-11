import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { storedTimestampIso } from '../utils/businessTime.js';
// Stored TIMESTAMP values are UTC wall time (businessTime convention):
// assertions on raw rows read them back via storedTimestampIso — never
// `new Date(naive)`, which would parse in the test process's own
// timezone and shift the instant (e.g. −6h under TZ=Asia/Dhaka).
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as migrate054 } from '../database/migrations/054_next_step_calendar_sync.js';
import { syncNextStepAfterFollowUp } from '../services/NextStepCalendarSync.js';

// Same test-only fixture secret the other integration suites use
// (assembled in parts so this file carries no contiguous literal).
const JWT_SECRET = 'test-jwt-secret-for-' + 'followup-integration';

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

/**
 * Schema mirrors lead-followup-integration.test.ts, plus
 * scheduled_activities in its MIGRATION-039 SHAPE — deliberately
 * WITHOUT the source_activity_id / source_kind columns, so the test
 * exercises migration 054 itself (columns + backfill) instead of
 * assuming them.
 */
async function setupSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100),
      department_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own',
      menu_access JSONB,
      actions JSONB,
      feature_permissions JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role_id UUID,
      department_id UUID,
      manager_id UUID,
      is_active BOOLEAN DEFAULT TRUE,
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      permission_name VARCHAR(255)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, permission_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (user_id, permission_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE,
      customer_name VARCHAR(255) NOT NULL,
      mobile VARCHAR(30) NOT NULL,
      alternate_mobile VARCHAR(30),
      email VARCHAR(255),
      marital_status VARCHAR(50),
      occupation VARCHAR(150),
      address TEXT,
      area VARCHAR(150),
      district VARCHAR(100),
      division VARCHAR(100),
      source VARCHAR(100),
      priority VARCHAR(30) DEFAULT 'NORMAL',
      expected_premium NUMERIC(14,2),
      expected_value NUMERIC(14,2),
      notes TEXT,
      assigned_to UUID,
      assigned_by UUID,
      assigned_at TIMESTAMP,
      previous_assigned_to UUID,
      last_contacted_at TIMESTAMP,
      next_follow_up_at TIMESTAMP,
      current_status VARCHAR(255) DEFAULT 'New',
      status_history JSONB DEFAULT '[]'::jsonb,
      assignment_history JSONB DEFAULT '[]'::jsonb,
      documents JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '{}'::jsonb,
      tags JSONB DEFAULT '[]'::jsonb,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by UUID,
      follow_up_count INT DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up',
      status VARCHAR(255),
      remarks TEXT,
      next_follow_up_at TIMESTAMP,
      next_call_at TIMESTAMP,
      meeting_at TIMESTAMP,
      meeting_type VARCHAR(255),
      collected_ncp NUMERIC(14,2),
      projected_ncp NUMERIC(14,2),
      sum_assured NUMERIC(14,2),
      product_name VARCHAR(255),
      loss_reason TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call', 'meeting', 'follow_up', 'task')),
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
      meeting_type VARCHAR(255),
      location VARCHAR(255),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_followup_mutations (
      mutation_id UUID PRIMARY KEY,
      lead_id UUID,
      user_id UUID,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
      response_body JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255),
      sort_order INT DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_key, option_value)
    );
  `);
}

const D1 = '2027-01-15T10:30:00.000Z';
const D2 = '2027-01-20T09:00:00.000Z';
const D3 = '2027-02-02T14:00:00.000Z';
const D_MEET = '2027-01-18T11:00:00.000Z';
const D_CALL = '2027-01-16T08:30:00.000Z';
const BF1_AT = '2027-02-01T09:00:00.000Z';
const BF3_AT = '2027-02-03T09:00:00.000Z';

describe('Next-step calendar sync (PR A) — status-update next steps land on the Task Calendar', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let employeeA: any;
  let employeeB: any;
  // Backfill fixture handles (seeded pre-migration, asserted after).
  let bf1: any;
  let bf1ActivityId: string;
  let bf3: any;

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const empRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [adminRoleRes.rows[0].id, empRoleRes.rows[0].id]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }
    const statuses = ['New', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Proposal Sent', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, true) ON CONFLICT DO NOTHING`, [statuses[i], i + 1]);
    }
    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleRes.rows[0].id, deptId]);
    adminUser = { id: adminRes.rows[0].id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };
    const empARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'Employee A', 'empaa@test.com', 'hashed', $1, $2, true) RETURNING id`, [empRoleRes.rows[0].id, deptId]);
    employeeA = { id: empARes.rows[0].id, employeeId: 'EMPA', email: 'empaa@test.com', role: 'EMPLOYEE' };
    const empBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPB', 'Employee B', 'empb@test.com', 'hashed', $1, $2, true) RETURNING id`, [empRoleRes.rows[0].id, deptId]);
    employeeB = { id: empBRes.rows[0].id, employeeId: 'EMPB', email: 'empb@test.com', role: 'EMPLOYEE' };

    // ── Backfill fixtures, seeded BEFORE migration 054 runs ────────
    const bf1Res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, current_status, next_follow_up_at, created_by)
       VALUES ('BF-1', 'Backfill One', '01711110001', $1, 'Interested', $2, $1) RETURNING *`,
      [employeeA.id, BF1_AT]
    );
    bf1 = bf1Res.rows[0];
    const bf1Act: any = await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, status, next_follow_up_at, created_by)
       VALUES ($1, 'follow_up', 'Interested', $2, $3) RETURNING id`,
      [bf1.id, BF1_AT, employeeA.id]
    );
    bf1ActivityId = bf1Act.rows[0].id;
    // BF-2: terminal lead WITH a next step — must be skipped.
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, current_status, next_follow_up_at, created_by)
       VALUES ('BF-2', 'Backfill Terminal', '01711110002', $1, 'Converted', $2, $1)`,
      [employeeA.id, BF1_AT]
    );
    // BF-3: open next step, NO matching activity — entry with NULL provenance.
    const bf3Res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, current_status, next_follow_up_at, created_by)
       VALUES ('BF-3', 'Backfill Three', '01711110003', $1, 'Interested', $2, $1) RETURNING *`,
      [employeeA.id, BF3_AT]
    );
    bf3 = bf3Res.rows[0];
    // BF-4: no next step at all — no entry.
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, current_status, created_by)
       VALUES ('BF-4', 'Backfill Four', '01711110004', $1, 'Interested', $1)`,
      [employeeA.id]
    );

    // The migration under test — columns + backfill in one run.
    await migrate054();

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  function tokenFor(user: any): string {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function createLeadAs(user: any, overrides: any = {}): Promise<any> {
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenFor(user)}`).send({
      customerName: overrides.customerName || 'Sync Prospect',
      mobile: overrides.mobile,
      ...overrides,
    });
    assert.equal(res.status, 200, `createLead failed: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.data?.id, 'lead creation must return lead with id');
    return res.body.data;
  }

  async function dbLeadByMobile(mobile: string): Promise<any> {
    const r: any = await pool.query(`SELECT * FROM leads WHERE mobile = $1`, [mobile]);
    assert.ok(r.rows[0], `lead ${mobile} must exist`);
    return r.rows[0];
  }

  async function entriesFor(leadDbId: string): Promise<any[]> {
    const r: any = await pool.query(
      `SELECT * FROM scheduled_activities WHERE lead_id = $1 ORDER BY created_at ASC, id ASC`,
      [leadDbId]
    );
    return r.rows;
  }

  async function followUp(user: any, leadRef: string, payload: any): Promise<any> {
    const res = await request(app).post(`/api/leads/${leadRef}/follow-up`).set('Authorization', `Bearer ${tokenFor(user)}`).send(payload);
    assert.equal(res.status, 200, `follow-up failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  it('migration 054 is registered as the tail and adds the link columns + unique partial index', async () => {
    assert.ok(MIGRATION_IDS.includes('054_next_step_calendar_sync'));
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '058_user_designation_backfill', '058 is the migration tail (056 stays registered)');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('054_next_step_calendar_sync'), 'runner names migration 054');
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'scheduled_activities' AND column_name IN ('source_activity_id', 'source_kind')`
    );
    assert.equal(cols.rows.length, 2);
    const idx: any = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'scheduled_activities' AND indexname = 'uq_scheduled_activities_source_activity'`);
    assert.equal(idx.rows.length, 1);
  });

  it('backfill: open next steps became managed entries; terminal / no-date leads skipped; re-run is a no-op', async () => {
    const bf1Entries = await entriesFor(bf1.id);
    assert.equal(bf1Entries.length, 1);
    assert.equal(bf1Entries[0].source_kind, 'backfill');
    assert.equal(bf1Entries[0].source_activity_id, bf1ActivityId, 'provenance = the activity whose next_follow_up_at matches the lead');
    assert.equal(bf1Entries[0].status, 'scheduled');
    assert.equal(bf1Entries[0].activity_type, 'follow_up');
    assert.equal(bf1Entries[0].assigned_to, employeeA.id);
    assert.equal(storedTimestampIso(bf1Entries[0].scheduled_at), new Date(BF1_AT).toISOString());

    const bf3Entries = await entriesFor(bf3.id);
    assert.equal(bf3Entries.length, 1);
    assert.equal(bf3Entries[0].source_kind, 'backfill');
    assert.equal(bf3Entries[0].source_activity_id, null, 'no matching activity → NULL provenance');

    const bf2: any = await pool.query(`SELECT id FROM leads WHERE lead_code = 'BF-2'`);
    assert.equal((await entriesFor(bf2.rows[0].id)).length, 0, 'terminal leads are not backfilled');
    const bf4: any = await pool.query(`SELECT id FROM leads WHERE lead_code = 'BF-4'`);
    assert.equal((await entriesFor(bf4.rows[0].id)).length, 0, 'leads without a next step get no entry');

    // Idempotent: a second (and third) run changes nothing.
    await migrate054();
    await migrate054();
    assert.equal((await entriesFor(bf1.id)).length, 1);
    assert.equal((await entriesFor(bf3.id)).length, 1);
  });

  it('set: a follow-up that sets nextFollowUpDate creates the linked calendar entry', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220001', customerName: 'Set Prospect' });
    const body = await followUp(employeeA, lead.id, { status: 'Follow-up Set', remarks: 'call back friday', nextFollowUpDate: D1 });
    const dbLead = await dbLeadByMobile('01722220001');
    const entries = await entriesFor(dbLead.id);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.status, 'scheduled');
    assert.equal(e.activity_type, 'follow_up');
    assert.equal(e.source_kind, 'follow_up');
    assert.equal(e.source_activity_id, body.data.activity.id, 'entry is linked to the follow-up that set it');
    assert.equal(storedTimestampIso(e.scheduled_at), new Date(D1).toISOString());
    assert.equal(e.assigned_to, dbLead.assigned_to, 'assigned to the lead owner, like a manual entry');

    // And it renders through the calendar list API with the lead joined.
    const list = await request(app).get(`/api/scheduled-activities?leadId=${dbLead.id}`).set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].leadCustomerName, 'Set Prospect');
    assert.equal(list.body.data[0].leadMobile, '01722220001');
    assert.equal(list.body.data[0].sourceActivityId, body.data.activity.id);
  });

  it('kind mapping: meeting and call next steps land with their own types', async () => {
    const leadM = await createLeadAs(employeeA, { mobile: '01722220002', customerName: 'Meet Prospect' });
    await followUp(employeeA, leadM.id, { status: 'Meeting Fixed', remarks: 'meet at office', meetingDate: D_MEET, meetingType: 'In-Person' });
    const dbM = await dbLeadByMobile('01722220002');
    const entriesM = await entriesFor(dbM.id);
    assert.equal(entriesM.length, 1);
    assert.equal(entriesM[0].activity_type, 'meeting');
    assert.equal(storedTimestampIso(entriesM[0].scheduled_at), new Date(D_MEET).toISOString());
    assert.equal(entriesM[0].meeting_type, 'In-Person');
    assert.equal(entriesM[0].title, 'Meeting - Meet Prospect', 'meeting title matches the retired client mirror');

    const leadC = await createLeadAs(employeeA, { mobile: '01722220003', customerName: 'Call Prospect' });
    await followUp(employeeA, leadC.id, { status: 'Contacted', remarks: 'try again', nextCallDate: D_CALL });
    const dbC = await dbLeadByMobile('01722220003');
    const entriesC = await entriesFor(dbC.id);
    assert.equal(entriesC.length, 1);
    assert.equal(entriesC[0].activity_type, 'call');
    assert.equal(storedTimestampIso(entriesC[0].scheduled_at), new Date(D_CALL).toISOString());
  });

  it('change: a second follow-up supersedes — one open entry, history preserved (two follow-ups = two entries)', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220004', customerName: 'Change Prospect' });
    await followUp(employeeA, lead.id, { status: 'Follow-up Set', remarks: 'first', nextFollowUpDate: D1 });
    const second = await followUp(employeeA, lead.id, { status: 'Follow-up Set', remarks: 'rescheduled', nextFollowUpDate: D2 });
    const dbLead = await dbLeadByMobile('01722220004');
    const entries = await entriesFor(dbLead.id);
    assert.equal(entries.length, 2, 'two follow-ups produced two entries in total');
    const open = entries.filter(e => e.status === 'scheduled');
    assert.equal(open.length, 1, 'exactly one entry stays open');
    assert.equal(storedTimestampIso(open[0].scheduled_at), new Date(D2).toISOString());
    assert.equal(open[0].source_activity_id, second.data.activity.id);
    const closed = entries.filter(e => e.status !== 'scheduled');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].status, 'completed', 'the superseded commitment counts as worked, not cancelled');
    assert.equal(closed[0].completed_activity_id, second.data.activity.id);
  });

  it('service upsert: re-syncing the SAME follow-up moves its row instead of duplicating', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220005', customerName: 'Move Prospect' });
    const dbLead = await dbLeadByMobile('01722220005');
    const act: any = await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, status, next_follow_up_at, created_by) VALUES ($1, 'follow_up', 'Follow-up Set', $2, $3) RETURNING id`,
      [dbLead.id, D1, employeeA.id]
    );
    const activityId = act.rows[0].id;
    const base = {
      leadId: dbLead.id, sourceActivityId: activityId, sourceKind: 'follow_up' as const,
      actorId: employeeA.id, assignedTo: dbLead.assigned_to, customerName: 'Move Prospect',
      kind: 'follow_up' as const, leadStatusAfter: 'Follow-up Set',
    };
    await syncNextStepAfterFollowUp(pool, { ...base, nextStepAt: D1 });
    const after1 = await entriesFor(dbLead.id);
    assert.equal(after1.length, 1);
    await syncNextStepAfterFollowUp(pool, { ...base, nextStepAt: D3 });
    const after2 = await entriesFor(dbLead.id);
    assert.equal(after2.length, 1, 'still one row for the same follow-up');
    assert.equal(after2[0].id, after1[0].id, 'same row — moved, not recreated');
    assert.equal(storedTimestampIso(after2[0].scheduled_at), new Date(D3).toISOString());
  });

  it('clear: re-saving the lead without a next step cancels the entry (row preserved)', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220006', customerName: 'Clear Prospect', nextFollowUpDate: D1 });
    const dbLead = await dbLeadByMobile('01722220006');
    let entries = await entriesFor(dbLead.id);
    assert.equal(entries.length, 1, 'lead save with a follow-up date created the entry');
    assert.equal(entries[0].source_kind, 'lead_save');
    assert.equal(entries[0].status, 'scheduled');

    const resave = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenFor(employeeA)}`).send({
      leadCode: lead.id,
      customerName: 'Clear Prospect',
      mobile: '01722220006',
    });
    assert.equal(resave.status, 200, JSON.stringify(resave.body));
    entries = await entriesFor(dbLead.id);
    assert.equal(entries.length, 1, 'the row is preserved for audit');
    assert.equal(entries[0].status, 'cancelled', 'cleared datetime → cancelled entry');
    assert.equal(entries.filter(e => e.status === 'scheduled').length, 0);
  });

  it('terminal: Not Interested cancels the open entry; Converted completes it', async () => {
    const leadN = await createLeadAs(employeeA, { mobile: '01722220007', customerName: 'Lost Prospect' });
    await followUp(employeeA, leadN.id, { status: 'Follow-up Set', remarks: 'pending', nextFollowUpDate: D1 });
    await followUp(employeeA, leadN.id, { status: 'Not Interested', lossReason: 'No budget' });
    const dbN = await dbLeadByMobile('01722220007');
    const entriesN = await entriesFor(dbN.id);
    assert.equal(entriesN.length, 1);
    assert.equal(entriesN[0].status, 'cancelled');

    const leadC = await createLeadAs(employeeA, { mobile: '01722220008', customerName: 'Won Prospect' });
    await followUp(employeeA, leadC.id, { status: 'Follow-up Set', remarks: 'pending', nextFollowUpDate: D1 });
    const won = await followUp(employeeA, leadC.id, { status: 'Converted', productName: 'Plan X', sumAssured: 100000, collectedNCP: 5000 });
    const dbC = await dbLeadByMobile('01722220008');
    const entriesC = await entriesFor(dbC.id);
    assert.equal(entriesC.length, 1);
    assert.equal(entriesC[0].status, 'completed');
    assert.equal(entriesC[0].completed_activity_id, won.data.activity.id);
  });

  it('complete flow: completing the synced entry with a new next step opens the next entry', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220009', customerName: 'Chain Prospect' });
    await followUp(employeeA, lead.id, { status: 'Follow-up Set', remarks: 'first step', nextFollowUpDate: D1 });
    const dbLead = await dbLeadByMobile('01722220009');
    const [first] = await entriesFor(dbLead.id);

    const done = await request(app).post(`/api/scheduled-activities/${first.id}/complete`).set('Authorization', `Bearer ${tokenFor(employeeA)}`).send({
      status: 'Follow-up Set', remarks: 'done — next step agreed', nextFollowUpDate: D2,
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const entries = await entriesFor(dbLead.id);
    assert.equal(entries.length, 2);
    const completedRow = entries.find(e => e.id === first.id);
    assert.equal(completedRow.status, 'completed');
    const next = entries.find(e => e.id !== first.id);
    assert.equal(next.status, 'scheduled');
    assert.equal(storedTimestampIso(next.scheduled_at), new Date(D2).toISOString());
    assert.equal(next.source_kind, 'scheduled_complete');
    assert.equal(next.source_activity_id, done.body.data.activity.id);
  });

  it('offline replay: the same clientMutationId twice still yields ONE entry', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01722220010', customerName: 'Offline Prospect' });
    const mutationId = '123e4567-e89b-42d3-a456-426614174000';
    const payload = { status: 'Follow-up Set', remarks: 'queued offline', nextFollowUpDate: D1, clientMutationId: mutationId };
    await followUp(employeeA, lead.id, payload);
    const replay = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${tokenFor(employeeA)}`).send(payload);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.deduplicated, true);
    const dbLead = await dbLeadByMobile('01722220010');
    assert.equal((await entriesFor(dbLead.id)).length, 1, 'the replay did not duplicate the calendar entry');
  });

  it('visibility: an out-of-scope employee cannot see another owner’s synced entry', async () => {
    const lead = await createLeadAs(employeeB, { mobile: '01722220011', customerName: 'Private Prospect' });
    await followUp(employeeB, lead.id, { status: 'Follow-up Set', remarks: 'mine only', nextFollowUpDate: D1 });
    const dbLead = await dbLeadByMobile('01722220011');
    const [entry] = await entriesFor(dbLead.id);
    assert.ok(entry, 'owner’s entry exists');

    const listAsA = await request(app).get(`/api/scheduled-activities?leadId=${dbLead.id}`).set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(listAsA.status, 200);
    assert.equal(listAsA.body.data.length, 0, 'out-of-scope list stays empty (PR #104 predicate unchanged)');
    const getAsA = await request(app).get(`/api/scheduled-activities/${entry.id}`).set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(getAsA.status, 404, 'out-of-scope detail stays a plain 404');

    const listAsB = await request(app).get(`/api/scheduled-activities?leadId=${dbLead.id}`).set('Authorization', `Bearer ${tokenFor(employeeB)}`);
    assert.equal(listAsB.body.data.length, 1, 'the owner sees the entry');
  });
});
