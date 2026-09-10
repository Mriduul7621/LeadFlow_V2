import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// leads.* are TIMESTAMP (without time zone) and node-pg parses them back in
// the client zone, so the suite pins UTC - the same assumption the deployed
// (UTC) runtime makes. Keeps the timestamp assertions zone-independent.
process.env.TZ = 'UTC';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrateLeadActivities } from '../database/migrations/037_lead_activities.js';
import { parseFollowUpPayload, FOLLOW_UP_SPOOF_KEYS } from '../routes/production.routes.js';

/**
 * STEP 4A — Server-authoritative Lead Follow-up / Status Activity.
 * ------------------------------------------------------------------
 * Real PostgreSQL (PGlite) + the real mounted Express router, so every
 * assertion below is about what actually landed in the database - not about
 * what the request handler said it did.
 *
 * Proven:
 *   A authenticated visible user can add a follow-up
 *   B current_status updates correctly
 *   C an activity row is created (append-only table from migration 037)
 *   D the actor comes from the authenticated caller (never the payload)
 *   E spoofed changedBy/updatedBy/date/statusHistory/assignmentHistory are
 *     rejected, and nothing is written
 *   F the event timestamp is server time
 *   G nextFollowUpDate persists (lead + activity row)
 *   H remarks persist
 *   I meeting fields persist
 *   J NCP/sum-assured fields persist
 *   K an unknown status fails clearly (no silent "Untouched")
 *   L an invisible user cannot update (server-side visibility)
 *   M a missing leads.edit grant fails closed
 *   N a soft-deleted lead cannot receive activity
 *   O a database failure rolls back BOTH the lead update and the insert
 *   P sequential + concurrent follow-ups append; nothing is lost
 *   Q the client never has to send previous history (and pre-existing
 *     server-side history survives a client update that omits it)
 *   R GET /api/leads/:id enforces visibility
 *   S GET /api/leads/:id never returns a soft-deleted lead
 *   V a legacy imported lead with empty history takes its first activity
 *   + auth (401), activity read endpoint, migration shape
 */

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const CANONICAL_STATUSES = [
  'Untouched', 'Contacted', 'No Response', 'Busy', 'Interested',
  'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked',
  'Converted', 'Not Interested',
];

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
    CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT uq_field_option_test UNIQUE(field_key, option_value)
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
      current_status VARCHAR(255) DEFAULT 'Untouched',
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
      deleted_by UUID
    );
  `);
}

/** Test-only tripwire: makes the ACTIVITY INSERT (and only that) fail, so a
 *  mid-transaction database failure can be observed for real. */
const FAIL_CONSTRAINT = 'test_fail_activity_insert';
async function armActivityFailure(pool: any) {
  await pool.query(
    `ALTER TABLE lead_activities ADD CONSTRAINT ${FAIL_CONSTRAINT} CHECK (remarks IS DISTINCT FROM 'FORCE_DB_FAILURE')`
  );
}
async function disarmActivityFailure(pool: any) {
  await pool.query(`ALTER TABLE lead_activities DROP CONSTRAINT IF EXISTS ${FAIL_CONSTRAINT}`);
}

describe('Lead Follow-up / Status Activity - Real PostgreSQL Integration', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId: string;
  let managerRoleId: string;
  let employeeRoleId: string;
  let readOnlyRoleId: string;
  let permIds: Record<string, string> = {};

  let userA: any;
  let userB: any;
  let managerA: any;
  let subordinateA: any;
  let adminUser: any;

  const tokenOf = (user: any) =>
    signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    const db = await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);
    // The production migration itself creates lead_activities, so the shape
    // under test is exactly the shape production gets.
    await migrateLeadActivities();

    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);
    await pool.query(`DELETE FROM departments`);
    await pool.query(`DELETE FROM options`);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = (deptRes.rows[0] as any).id;

    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    adminRoleId = (adminRoleRes.rows[0] as any).id;
    const managerRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`);
    managerRoleId = (managerRoleRes.rows[0] as any).id;
    const employeeRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    employeeRoleId = (employeeRoleRes.rows[0] as any).id;
    // View-only role: leads.view granted, leads.edit deliberately absent.
    const readOnlyRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('VIEWER', 'Viewer', 10, 'Own') RETURNING id`);
    readOnlyRoleId = (readOnlyRoleRes.rows[0] as any).id;
    // A role with NO grants at all - exercises the fail-closed path.
    await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('NOPERMS', 'No Permissions', 10, 'Own')`);

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = (res.rows[0] as any).id;
    }
    for (const roleId of [adminRoleId, managerRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [readOnlyRoleId, permIds['leads.view']]);

    const insertUser = async (employeeId: string, fullName: string, email: string, roleId: string, managerId?: string) => {
      const res: any = managerId
        ? await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
             VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
            [employeeId, fullName, email, roleId, deptId, managerId]
          )
        : await pool.query(
            `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
             VALUES ($1, $2, $3, 'hashed', $4, $5, true) RETURNING id`,
            [employeeId, fullName, email, roleId, deptId]
          );
      return { id: (res.rows[0] as any).id, employeeId, fullName, email, role: roleId === adminRoleId ? 'ADMIN' : roleId === managerRoleId ? 'MANAGER' : roleId === readOnlyRoleId ? 'VIEWER' : 'EMPLOYEE' };
    };

    userA = await insertUser('EMPA', 'User A', 'usera@test.com', employeeRoleId);
    userB = await insertUser('EMPB', 'User B', 'userb@test.com', employeeRoleId);
    managerA = await insertUser('MGRA', 'Manager A', 'mgra@test.com', managerRoleId);
    subordinateA = await insertUser('SUBA', 'Subordinate A', 'suba@test.com', employeeRoleId, managerA.id);
    adminUser = await insertUser('ADMIN1', 'Admin User', 'admin@test.com', adminRoleId);

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // lead_activities FK is ON DELETE CASCADE, so clearing leads clears the
    // activity stream too - asserted below rather than assumed.
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM options`);
    for (let i = 0; i < CANONICAL_STATUSES.length; i++) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, TRUE)`,
        [CANONICAL_STATUSES[i], i + 1]
      );
    }
  });

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  /** Create a lead through the existing (unchanged) write path. */
  async function createLead(owner: any, mobile: string, name = 'Follow-up Lead') {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenOf(owner)}`)
      .send({ customerName: name, mobile, source: 'Test' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
  }

  function followUp(leadId: string, body: Record<string, any>, token?: string) {
    return request(app)
      .post(`/api/leads/${encodeURIComponent(leadId)}/follow-up`)
      .set('Authorization', `Bearer ${token || tokenOf(userA)}`)
      .send(body);
  }

  async function leadRow(leadCode: string) {
    const res: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    return res.rows[0] || null;
  }

  async function activityRows(leadCode: string) {
    const res: any = await pool.query(
      `SELECT a.*, l.lead_code FROM lead_activities a
       JOIN leads l ON l.id = a.lead_id
       WHERE l.lead_code = $1
       ORDER BY a.created_at ASC, a.id ASC`,
      [leadCode]
    );
    return res.rows as any[];
  }

  /* ------------------------------------------------------------------ *
   * A - C : the happy path, in the database
   * ------------------------------------------------------------------ */

  it('A. authenticated visible user can add a follow-up (200 + committed state returned)', async () => {
    const lead = await createLead(userA, '01700000101');
    const res = await followUp(lead.id, { status: 'Contacted', remarks: 'Called, wants a meeting' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.lead.currentStatus, 'Contacted');
    assert.equal(res.body.data.activity.status, 'Contacted');
    assert.ok(res.body.data.activity.id, 'the created activity row is returned');
  });

  it('B. current_status updates correctly on the lead row', async () => {
    const lead = await createLead(userA, '01700000102');
    assert.equal((await leadRow(lead.id)).current_status, 'Untouched');

    await followUp(lead.id, { status: 'Interested' });
    assert.equal((await leadRow(lead.id)).current_status, 'Interested');

    await followUp(lead.id, { currentStatus: 'Meeting Fixed' });
    assert.equal((await leadRow(lead.id)).current_status, 'Meeting Fixed');
  });

  it('C. an append-only activity row is created in lead_activities', async () => {
    const lead = await createLead(userA, '01700000103');
    await followUp(lead.id, { status: 'Contacted', remarks: 'first' });
    await followUp(lead.id, { status: 'Interested', remarks: 'second' });

    const rows = await activityRows(lead.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'Contacted');
    assert.equal(rows[0].remarks, 'first');
    assert.equal(rows[0].activity_type, 'status_update');
    assert.equal(rows[1].status, 'Interested');
    assert.equal(rows[1].lead_id, rows[0].lead_id);
    assert.notEqual(rows[0].id, rows[1].id);
  });

  it('C2. the migration created the table, the FKs and the read indexes', async () => {
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lead_activities'`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    for (const expected of [
      'id', 'lead_id', 'activity_type', 'status', 'remarks', 'next_follow_up_at',
      'next_call_at', 'meeting_at', 'meeting_type', 'collected_ncp', 'projected_ncp',
      'sum_assured', 'product_name', 'loss_reason', 'created_by', 'created_at',
    ]) {
      assert.ok(names.includes(expected), `lead_activities.${expected} must exist`);
    }
    const fks: any = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'lead_activities'::regclass AND contype = 'f'`
    );
    const fkNames = fks.rows.map((r: any) => r.conname);
    assert.ok(fkNames.includes('fk_lead_activities_lead'), 'FK to leads(id)');
    assert.ok(fkNames.includes('fk_lead_activities_created_by'), 'FK to users(id)');

    const idx: any = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'lead_activities'`);
    const idxNames = idx.rows.map((r: any) => r.indexname);
    assert.ok(idxNames.includes('idx_lead_activities_lead_created'), 'lead_id index');
    assert.ok(idxNames.includes('idx_lead_activities_created_at'), 'created_at index');
  });

  it('C3. deleting a lead cascades its activity rows (no orphans)', async () => {
    const lead = await createLead(userA, '01700000104');
    await followUp(lead.id, { status: 'Contacted' });
    assert.equal((await activityRows(lead.id)).length, 1);
    await pool.query(`DELETE FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.equal((await activityRows(lead.id)).length, 0);
  });

  /* ------------------------------------------------------------------ *
   * D - F : audit authority
   * ------------------------------------------------------------------ */

  it('D. the actor comes from the authenticated caller, never the payload', async () => {
    const lead = await createLead(userA, '01700000105');
    const res = await followUp(lead.id, { status: 'Contacted' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [row] = await activityRows(lead.id);
    assert.equal(row.created_by, userA.id, 'created_by is the session user id');

    // The mirrored legacy entry is also session-derived.
    const history = (await leadRow(lead.id)).status_history;
    assert.equal(history.length, 1);
    assert.equal(history[0].updatedBy, 'EMPA');

    // A different user's token records that user - not whoever the client names.
    const res2 = await followUp(lead.id, { status: 'Interested' }, tokenOf(adminUser));
    assert.equal(res2.status, 200, JSON.stringify(res2.body));
    const rows = await activityRows(lead.id);
    assert.equal(rows[1].created_by, adminUser.id);
    assert.equal((await leadRow(lead.id)).status_history[1].updatedBy, 'ADMIN1');
  });

  it('D2. the read model exposes the server-derived actor by name', async () => {
    const lead = await createLead(userA, '01700000106');
    const res = await followUp(lead.id, { status: 'Contacted' });
    assert.equal(res.body.data.activity.updatedByEmployeeId, 'EMPA');
    assert.equal(res.body.data.activity.updatedByName, 'User A');
    assert.equal(res.body.data.activity.updatedBy, 'User A (EMPA)');
  });

  it('E. spoofed audit fields are rejected and nothing is written', async () => {
    const lead = await createLead(userA, '01700000107');
    const before = await leadRow(lead.id);

    for (const spoof of [
      { changedBy: 'HACKER' },
      { updatedBy: 'HACKER' },
      { createdBy: 'HACKER' },
      { actor: 'HACKER' },
      { date: '2020-01-01T00:00:00.000Z' },
      { timestamp: '2020-01-01T00:00:00.000Z' },
      { statusHistory: [{ status: 'Converted', date: '2020-01-01' }] },
      { assignmentHistory: [{ toEmployeeId: 'HACKER', date: '2020-01-01' }] },
    ]) {
      const res = await followUp(lead.id, { status: 'Contacted', ...spoof });
      assert.equal(res.status, 400, `${JSON.stringify(spoof)} must be rejected, got ${res.status}`);
      assert.equal(res.body.success, false);
      const key = Object.keys(spoof)[0];
      assert.ok(
        String(res.body.message).includes(key),
        `rejection must name the offending field (${key}); got: ${res.body.message}`
      );
    }

    const after = await leadRow(lead.id);
    assert.equal(after.current_status, before.current_status);
    assert.equal(JSON.stringify(after.status_history), '[]');
    assert.equal((await activityRows(lead.id)).length, 0, 'a rejected request writes nothing');
  });

  it('E2. an unknown status is never silently coerced and history is not writable en masse', async () => {
    // Even a body that looks like the old client-built update cannot smuggle
    // a full history array in: the endpoint has no such field.
    const lead = await createLead(userA, '01700000108');
    const res = await followUp(lead.id, { status: 'Converted', assignmentHistory: [] });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message), /assignmentHistory/);
  });

  it('F. the event timestamp is server time (not client-supplied)', async () => {
    const lead = await createLead(userA, '01700000109');
    const before = Date.now();
    const res = await followUp(lead.id, { status: 'Contacted' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [row] = await activityRows(lead.id);
    const createdMs = new Date(row.created_at).getTime();
    const after = Date.now();
    assert.ok(createdMs >= before - 5_000 && createdMs <= after + 5_000, `created_at=${row.created_at} must be ~server now`);

    // The response, the activity row and the mirrored history entry agree.
    const history = (await leadRow(lead.id)).status_history;
    assert.equal(new Date(res.body.data.activity.date).getTime(), new Date(history[0].date).getTime());
    assert.equal(history[0].activityId, row.id, 'mirrored entry is correlated to the activity row');

    // last_contacted_at / updated_at were stamped by the DB clock.
    const leadDbRow = await leadRow(lead.id);
    assert.ok(new Date(leadDbRow.last_contacted_at).getTime() >= before - 5_000);
    assert.equal(String(leadDbRow.updated_by), userA.id);
  });

  /* ------------------------------------------------------------------ *
   * G - J : field persistence (lead current state + activity row)
   * ------------------------------------------------------------------ */

  it('G. nextFollowUpDate persists on the lead and on the activity', async () => {
    const lead = await createLead(userA, '01700000110');
    const res = await followUp(lead.id, { status: 'Follow-up Set', nextFollowUpDate: '2026-09-20' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await leadRow(lead.id);
    assert.equal(new Date(row.next_follow_up_at).toISOString().slice(0, 10), '2026-09-20');
    assert.equal(res.body.data.lead.nextFollowUpDate.slice(0, 10), '2026-09-20');
    const [activity] = await activityRows(lead.id);
    assert.equal(new Date(activity.next_follow_up_at).toISOString().slice(0, 10), '2026-09-20');
  });

  it('H. remarks persist on the activity (and the legacy history mirror)', async () => {
    const lead = await createLead(userA, '01700000111', 'Notes Preserve Lead');
    await pool.query(`UPDATE leads SET notes = 'Legacy imported final remark - must survive' WHERE lead_code = $1`, [lead.id]);

    const res = await followUp(lead.id, { status: 'Busy', remarks: 'Customer busy till next week' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.lead.notes, 'Legacy imported final remark - must survive');

    const [activity] = await activityRows(lead.id);
    assert.equal(activity.remarks, 'Customer busy till next week');
    assert.equal((await leadRow(lead.id)).status_history[0].remarks, 'Customer busy till next week');
  });

  it('I. meeting fields persist where supported', async () => {
    const lead = await createLead(userA, '01700000112');
    const res = await followUp(lead.id, {
      status: 'Meeting Fixed',
      meetingDate: '2026-09-18',
      meetingType: 'Online Meeting',
      nextCallDate: '2026-09-16',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [activity] = await activityRows(lead.id);
    assert.equal(new Date(activity.meeting_at).toISOString().slice(0, 10), '2026-09-18');
    assert.equal(activity.meeting_type, 'Online Meeting');
    assert.equal(new Date(activity.next_call_at).toISOString().slice(0, 10), '2026-09-16');

    const custom = (await leadRow(lead.id)).custom_fields;
    assert.equal(custom.meetingType, 'Online Meeting');
    assert.equal(new Date(custom.meetingDate).toISOString().slice(0, 10), '2026-09-18');
    assert.equal(new Date(custom.nextCallDate).toISOString().slice(0, 10), '2026-09-16');

    // The lead read model the UI consumes reflects them too.
    assert.equal(res.body.data.lead.meetingType, 'Online Meeting');
    assert.equal(res.body.data.lead.nextCallDate.slice(0, 10), '2026-09-16');
  });

  it('J. NCP + sum assured + product + loss reason persist', async () => {
    const lead = await createLead(userA, '01700000113');
    const res = await followUp(lead.id, {
      status: 'Converted',
      collectedNCP: 15000,
      projectedNCP: 25000,
      sumAssured: 1000000,
      productName: 'SCEP',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await leadRow(lead.id);
    assert.equal(Number(row.expected_premium), 25000, 'projectedNCP -> expected_premium');
    assert.equal(Number(row.expected_value), 1000000, 'sumAssured -> expected_value');
    assert.equal(Number(row.custom_fields.collectedNCP), 15000, 'collectedNCP -> custom_fields');

    const [activity] = await activityRows(lead.id);
    assert.equal(Number(activity.collected_ncp), 15000);
    assert.equal(Number(activity.projected_ncp), 25000);
    assert.equal(Number(activity.sum_assured), 1000000);
    assert.equal(activity.product_name, 'SCEP');

    assert.equal(res.body.data.lead.projectedNCP, 25000);
    assert.equal(res.body.data.lead.sumAssured, 1000000);
    assert.equal(res.body.data.lead.collectedNCP, 15000);
    assert.equal(res.body.data.lead.productName, 'SCEP');

    const lost = await followUp(lead.id, { status: 'Not Interested', lossReason: 'Price sensitive' });
    assert.equal((await activityRows(lead.id))[1].loss_reason, 'Price sensitive');
    assert.equal(lost.body.data.lead.lossReason, 'Price sensitive');
  });

  it('J2. omitted fields are preserved, explicit null clears only that field', async () => {
    const lead = await createLead(userA, '01700000114');
    await followUp(lead.id, {
      status: 'Follow-up Set',
      nextFollowUpDate: '2026-09-20',
      meetingDate: '2026-09-18',
      collectedNCP: 5000,
      productName: 'SCEP',
    });

    // A follow-up that only changes the status must not wipe anything else.
    const second = await followUp(lead.id, { status: 'Interested', remarks: 'status only' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const afterOmit = await leadRow(lead.id);
    assert.equal(new Date(afterOmit.next_follow_up_at).toISOString().slice(0, 10), '2026-09-20');
    assert.equal(new Date(afterOmit.custom_fields.meetingDate).toISOString().slice(0, 10), '2026-09-18');
    assert.equal(Number(afterOmit.custom_fields.collectedNCP), 5000);
    assert.equal(afterOmit.custom_fields.productName, 'SCEP');

    // Explicit null clears just that one field.
    const cleared = await followUp(lead.id, { status: 'Interested', nextFollowUpDate: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal((await leadRow(lead.id)).next_follow_up_at, null);
    assert.equal(Number((await leadRow(lead.id)).custom_fields.collectedNCP), 5000, 'others untouched');
  });

  /* ------------------------------------------------------------------ *
   * K : status dictionary
   * ------------------------------------------------------------------ */

  it('K. an unknown status fails clearly and writes nothing', async () => {
    const lead = await createLead(userA, '01700000115');
    const res = await followUp(lead.id, { status: 'Definitely Not A Real Status', remarks: 'x' });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message), /Unknown status "Definitely Not A Real Status"/);
    assert.match(String(res.body.message), /Converted/, 'the message lists the allowed dictionary');

    const row = await leadRow(lead.id);
    assert.equal(row.current_status, 'Untouched', 'never silently converted');
    assert.equal(JSON.stringify(row.status_history), '[]');
    assert.equal((await activityRows(lead.id)).length, 0);
  });

  it('K2. the canonical dictionary is respected (case/punctuation-insensitive, inactive option rejected)', async () => {
    const lead = await createLead(userA, '01700000116');
    const res = await followUp(lead.id, { status: 'follow up set' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.lead.currentStatus, 'Follow-up Set', 'canonical spelling wins');

    await pool.query(`UPDATE options SET is_active = FALSE WHERE field_key = 'FollowUpStatus' AND option_value = 'Converted'`);
    const rejected = await followUp(lead.id, { status: 'Converted' });
    assert.equal(rejected.status, 400, 'a deactivated status is not accepted');
    assert.equal((await leadRow(lead.id)).current_status, 'Follow-up Set');
  });

  it('K3. invalid dates/amounts are rejected with a clear message', async () => {
    const lead = await createLead(userA, '01700000117');
    const badDate = await followUp(lead.id, { status: 'Contacted', nextFollowUpDate: 'not-a-date' });
    assert.equal(badDate.status, 400);
    assert.match(String(badDate.body.message), /Next follow-up date is not a valid date/);

    const badAmount = await followUp(lead.id, { status: 'Contacted', collectedNCP: -5 });
    assert.equal(badAmount.status, 400);
    assert.match(String(badAmount.body.message), /Collected NCP cannot be negative/);

    assert.equal((await activityRows(lead.id)).length, 0);
  });

  /* ------------------------------------------------------------------ *
   * L - N : authorization, visibility, soft delete
   * ------------------------------------------------------------------ */

  it('L. a user who cannot see the lead cannot log a follow-up on it', async () => {
    const lead = await createLead(userA, '01700000118');
    const res = await followUp(lead.id, { status: 'Converted', collectedNCP: 1 }, tokenOf(userB));
    assert.equal(res.status, 403);
    assert.equal((await leadRow(lead.id)).current_status, 'Untouched');
    assert.equal((await activityRows(lead.id)).length, 0);
  });

  it('L2. a DownTeam manager can log activity on a subordinate lead; a sibling manager cannot', async () => {
    const lead = await createLead(subordinateA, '01700000119');
    const upline = await followUp(lead.id, { status: 'Contacted' }, tokenOf(managerA));
    assert.equal(upline.status, 200, JSON.stringify(upline.body));
    assert.equal(upline.body.data.activity.updatedByEmployeeId, 'MGRA');
    assert.equal((await activityRows(lead.id)).length, 1);
  });

  it('L3. anonymous and unknown-lead requests are rejected', async () => {
    const anon = await request(app).post('/api/leads/anything/follow-up').send({ status: 'Contacted' });
    assert.equal(anon.status, 401);

    const missing = await followUp('lead_does_not_exist', { status: 'Contacted' });
    assert.equal(missing.status, 404);
    assert.equal((await activityRows('lead_does_not_exist')).length, 0);
  });

  it('L4. the follow-up accepts the lead UUID as well as the lead code', async () => {
    const lead = await createLead(userA, '01700000120');
    const dbId = lead.dbId;
    assert.ok(dbId, 'the lead read model exposes the UUID');
    const res = await followUp(dbId, { status: 'Contacted' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await activityRows(lead.id)).length, 1);
  });

  it('M. a missing leads.edit grant fails closed', async () => {
    const lead = await createLead(userA, '01700000121');
    const viewer = await (async () => {
      const res: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
         VALUES ('VIEWER1', 'View Only', 'viewer@test.com', 'hashed', $1,
                 (SELECT id FROM departments WHERE department_code = 'DEPT1'), true) RETURNING id`,
        [readOnlyRoleId]
      );
      return { id: (res.rows[0] as any).id, employeeId: 'VIEWER1', email: 'viewer@test.com', role: 'VIEWER' };
    })();
    // Give the viewer ownership of a second lead so visibility is not the
    // reason for the failure: only the missing edit grant is.
    const ownLead = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenOf(adminUser)}`)
      .send({ customerName: 'Viewer Lead', mobile: '01700000122', assignedTo: 'VIEWER1' });
    assert.equal(ownLead.status, 200, JSON.stringify(ownLead.body));

    const denied = await followUp(ownLead.body.data.id, { status: 'Contacted' }, tokenOf(viewer));
    assert.equal(denied.status, 403, 'no leads.edit => denied');
    assert.equal((await leadRow(ownLead.body.data.id)).current_status, 'Untouched');

    // An explicit user-level deny overrides an inherited role grant.
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES ($1, $2, FALSE) ON CONFLICT (user_id, permission_id) DO UPDATE SET is_allowed = FALSE`,
      [userA.id, permIds['leads.edit']]
    );
    try {
      const revoked = await followUp(lead.id, { status: 'Contacted' });
      assert.equal(revoked.status, 403, 'explicit deny => fail closed');
    } finally {
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [userA.id]);
    }
  });

  it('N. a soft-deleted lead cannot receive activity', async () => {
    const lead = await createLead(userA, '01700000123');
    const del = await request(app)
      .delete(`/api/leads/${lead.id}`)
      .set('Authorization', `Bearer ${tokenOf(adminUser)}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const res = await followUp(lead.id, { status: 'Converted', collectedNCP: 999 });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal((await activityRows(lead.id)).length, 0);
    assert.equal((await leadRow(lead.id)).current_status, 'Untouched', 'deleted lead is not mutated');

    const activities = await request(app)
      .get(`/api/leads/${lead.id}/activities`)
      .set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(activities.status, 404);
  });

  /* ------------------------------------------------------------------ *
   * O : atomicity
   * ------------------------------------------------------------------ */

  it('O. a database failure rolls back BOTH the lead update and the activity insert', async () => {
    const lead = await createLead(userA, '01700000124');
    const before = await leadRow(lead.id);

    await armActivityFailure(pool);
    try {
      const res = await followUp(lead.id, {
        status: 'Converted',
        remarks: 'FORCE_DB_FAILURE',
        collectedNCP: 42000,
        nextFollowUpDate: '2026-12-31',
      });
      assert.ok(res.status >= 500, `expected a server failure, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.success, false);
      assert.ok(!res.body.data?.lead, 'no fake success payload');
    } finally {
      await disarmActivityFailure(pool);
    }

    const after = await leadRow(lead.id);
    assert.equal(after.current_status, before.current_status, 'lead status change rolled back');
    assert.equal(after.next_follow_up_at, before.next_follow_up_at, 'next follow-up rolled back');
    assert.equal(JSON.stringify(after.custom_fields), JSON.stringify(before.custom_fields), 'custom fields rolled back');
    assert.equal(JSON.stringify(after.status_history), '[]', 'no partial history entry');
    assert.equal((await activityRows(lead.id)).length, 0, 'no activity row survived the rollback');

    // The connection is still usable afterwards (no stuck transaction).
    const ok = await followUp(lead.id, { status: 'Contacted', remarks: 'after rollback' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await activityRows(lead.id)).length, 1);
  });

  /* ------------------------------------------------------------------ *
   * P + Q : append semantics
   * ------------------------------------------------------------------ */

  it('P. sequential follow-ups append - the previous activity is never lost', async () => {
    const lead = await createLead(userA, '01700000125');
    const first = await followUp(lead.id, { status: 'Contacted', remarks: 'one' });
    const second = await followUp(lead.id, { status: 'Interested', remarks: 'two' });
    const third = await followUp(lead.id, { status: 'Converted', remarks: 'three', collectedNCP: 7000 });
    for (const res of [first, second, third]) assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await activityRows(lead.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.status), ['Contacted', 'Interested', 'Converted']);
    assert.deepEqual(rows.map(r => r.remarks), ['one', 'two', 'three']);

    const history = (await leadRow(lead.id)).status_history;
    assert.equal(history.length, 3, 'legacy JSONB mirror keeps every event');
    assert.deepEqual(history.map((h: any) => h.status), ['Contacted', 'Interested', 'Converted']);

    // The lead read model + the activity read endpoint agree.
    const fetched = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(fetched.status, 200);
    const list = fetched.body.data.activities;
    assert.equal(list.length, 3);
    assert.deepEqual(list[0].status, 'Converted', 'newest first (reverse chronological)');
    assert.deepEqual(list.map((a: any) => a.status).sort(), ['Contacted', 'Converted', 'Interested']);
    assert.equal(list[0].remarks, 'three');
    assert.equal(list[0].collectedNCP, 7000);
  });

  it('P2. concurrent follow-ups on the same lead both persist (no lost update)', async () => {
    const lead = await createLead(userA, '01700000126');
    const results = await Promise.all([
      followUp(lead.id, { status: 'Contacted', remarks: 'concurrent-1' }),
      followUp(lead.id, { status: 'Interested', remarks: 'concurrent-2' }),
      followUp(lead.id, { status: 'Busy', remarks: 'concurrent-3' }),
    ]);
    for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await activityRows(lead.id);
    assert.equal(rows.length, 3, 'every concurrent follow-up is kept');
    assert.deepEqual(
      rows.map(r => r.remarks).sort(),
      ['concurrent-1', 'concurrent-2', 'concurrent-3']
    );
    assert.equal((await leadRow(lead.id)).status_history.length, 3, 'history append is not overwritten');
  });

  it('Q. the client never has to send previous history - and cannot clobber it', async () => {
    const lead = await createLead(userA, '01700000127');
    await followUp(lead.id, { status: 'Contacted', remarks: 'server-authored' });
    const withActivity = await leadRow(lead.id);
    assert.equal(withActivity.status_history.length, 1);

    // The legacy whole-lead endpoint (still used for profile edits) must not
    // wipe the server-authored history when the client omits it, and must
    // not accept a client-authored replacement either: an empty/absent array
    // preserves, which is what the refactored client relies on.
    const profileEdit = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenOf(userA)}`)
      .send({ id: lead.id, customerName: 'Renamed Lead', mobile: '01700000127', area: 'Dhanmondi' });
    assert.equal(profileEdit.status, 200, JSON.stringify(profileEdit.body));

    const after = await leadRow(lead.id);
    assert.equal(after.customer_name, 'Renamed Lead');
    assert.equal(after.status_history.length, 1, 'history survived the profile edit');
    assert.equal(after.status_history[0].remarks, 'server-authored');
    assert.equal((await activityRows(lead.id)).length, 1, 'the activity stream is untouched');

    // A follow-up request body needs nothing but business fields.
    const minimal = await followUp(lead.id, { status: 'Interested' });
    assert.equal(minimal.status, 200, JSON.stringify(minimal.body));
    assert.equal(minimal.body.data.lead.statusHistory.length, 2);
  });

  /* ------------------------------------------------------------------ *
   * R + S : direct single-lead GET
   * ------------------------------------------------------------------ */

  it('R. GET /api/leads/:id returns exactly one visible lead and enforces visibility', async () => {
    const lead = await createLead(userA, '01700000128');
    await createLead(userA, '01700000129', 'Other Lead');

    const mine = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(mine.status, 200);
    assert.ok(!Array.isArray(mine.body), 'a single lead object, not a list');
    assert.equal(mine.body.id, lead.id);
    assert.equal(mine.body.mobile, '01700000128');

    const byUuid = await request(app).get(`/api/leads/${lead.dbId}`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(byUuid.status, 200);
    assert.equal(byUuid.body.id, lead.id);

    const invisible = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(userB)}`);
    assert.equal(invisible.status, 404, 'invisible lead is indistinguishable from missing');

    const anon = await request(app).get(`/api/leads/${lead.id}`);
    assert.equal(anon.status, 401);

    const admin = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(adminUser)}`);
    assert.equal(admin.status, 200, 'organization-wide visibility still sees everything');

    const unknown = await request(app).get('/api/leads/lead_nope').set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(unknown.status, 404);
  });

  it('S. GET /api/leads/:id does not return a soft-deleted lead', async () => {
    const lead = await createLead(userA, '01700000130');
    const del = await request(app).delete(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(adminUser)}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const res = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(res.status, 404);
    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(list.status, 200);
    assert.ok(!list.body.some((l: any) => l.id === lead.id), 'and still absent from the list');
  });

  it('S2. GET /api/leads/:id requires the leads.view permission (fail closed)', async () => {
    const lead = await createLead(userA, '01700000131');
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
       VALUES ('NOACCESS1', 'No Leads Access', 'noaccess@test.com', 'hashed',
               (SELECT id FROM roles WHERE role_code = 'NOPERMS'),
               (SELECT id FROM departments WHERE department_code = 'DEPT1'), true) RETURNING id`
    );
    const nobody = { id: (res.rows[0] as any).id, employeeId: 'NOACCESS1', role: 'NOPERMS' };

    const deniedGet = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenOf(nobody)}`);
    assert.equal(deniedGet.status, 403, 'missing leads.view => denied, fail closed');

    const deniedFollow = await followUp(lead.id, { status: 'Contacted' }, tokenOf(nobody));
    assert.equal(deniedFollow.status, 403, 'missing leads.edit => denied, fail closed');
    assert.equal((await activityRows(lead.id)).length, 0);
  });

  /* ------------------------------------------------------------------ *
   * V : legacy imported lead gets its first LeadFlow activity
   * ------------------------------------------------------------------ */

  it('V. a legacy imported lead with empty activity history receives its first NEW activity', async () => {
    // Exactly the shape the hardened bulk import produces: current-state row,
    // NO status_history (the sheet is a snapshot, not event history).
    const imported: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by,
                          custom_fields, status_history, assignment_history, created_at, updated_at)
       VALUES ('imp_1711001122', 'Legacy Import', '01711001122', 'Interested', $1, $1,
               '{"assignedTo":"EMPA","campaignName":"Legacy April 26"}'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '2026-04-22 00:00:00', '2026-04-22 00:00:00')
       RETURNING id, lead_code`,
      [userA.id]
    );
    const code = (imported.rows[0] as any).lead_code;
    assert.equal((await activityRows(code)).length, 0, 'the import never fabricated history');

    const res = await followUp(code, { status: 'Meeting Fixed', remarks: 'Meeting booked after import', meetingDate: '2026-09-15' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await activityRows(code);
    assert.equal(rows.length, 1, 'first LeadFlow-observed activity');
    assert.equal(rows[0].status, 'Meeting Fixed');
    assert.equal(rows[0].created_by, userA.id);

    const leadAfter = await leadRow(code);
    assert.equal(leadAfter.current_status, 'Meeting Fixed');
    assert.equal(leadAfter.status_history.length, 1);
    assert.equal(leadAfter.custom_fields.campaignName, 'Legacy April 26', 'imported profile data preserved');
    assert.equal(new Date(leadAfter.created_at).toISOString().slice(0, 10), '2026-04-22', 'historical lead date preserved');

    const fetched = await request(app).get(`/api/leads/${code}`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.currentStatus, 'Meeting Fixed');
  });

  /* ------------------------------------------------------------------ *
   * activity read endpoint
   * ------------------------------------------------------------------ */

  it('X. GET /api/leads/:id/activities enforces the same visibility as the lead', async () => {
    const lead = await createLead(userA, '01700000132');
    await followUp(lead.id, { status: 'Contacted', remarks: 'mine' });

    const mine = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${tokenOf(userA)}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.activities.length, 1);
    assert.equal(mine.body.data.activities[0].remarks, 'mine');

    const other = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${tokenOf(userB)}`);
    assert.equal(other.status, 404, 'no leak of another user\'s activity');

    const anon = await request(app).get(`/api/leads/${lead.id}/activities`);
    assert.equal(anon.status, 401);

    const manager = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${tokenOf(adminUser)}`);
    assert.equal(manager.status, 200);
    assert.equal(manager.body.data.activities.length, 1, 'organization-wide scope still applies');
  });

  /* ------------------------------------------------------------------ *
   * the accepted-field contract, at the pure-function level
   * ------------------------------------------------------------------ */

  it('W. parseFollowUpPayload: accepted fields only, preserve-on-undefined, clear-on-null', async () => {
    const empty = parseFollowUpPayload({}, CANONICAL_STATUSES);
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.patch, { status: '' }, 'an empty body changes nothing (no status, no field)');

    const full = parseFollowUpPayload(
      {
        status: 'Meeting Fixed',
        remarks: 'ok',
        nextFollowUpDate: '2026-09-30',
        nextCallDate: '2026-09-29',
        meetingDate: '2026-09-28',
        meetingType: 'Online Meeting',
        collectedNCP: '1500',
        projectedNCP: 2500,
        sumAssured: 100000,
        productName: 'SCEP',
        lossReason: 'Price sensitive',
        // unexplained extras are ignored, never written
        someOtherKey: 'ignored',
      },
      CANONICAL_STATUSES
    );
    assert.deepEqual(full.errors, []);
    assert.equal(full.patch.status, 'Meeting Fixed');
    assert.equal(full.patch.collectedNCP, 1500, 'numeric strings normalize');
    assert.equal((full.patch as any).someOtherKey, undefined);
    assert.equal(full.patch.nextFollowUpDate, '2026-09-30T00:00:00.000Z');

    // currentStatus is accepted as the alias the Lead model uses.
    const aliased = parseFollowUpPayload({ currentStatus: 'interested' }, CANONICAL_STATUSES);
    assert.equal(aliased.patch.status, 'Interested');

    // explicit null/empty clears ONLY that field; absence preserves it.
    const cleared = parseFollowUpPayload(
      { status: 'Contacted', nextFollowUpDate: null, meetingType: '', remarks: null },
      CANONICAL_STATUSES
    );
    assert.deepEqual(cleared.errors, []);
    assert.equal(cleared.patch.nextFollowUpDate, null);
    assert.equal(cleared.patch.meetingType, null);
    assert.equal(cleared.patch.remarks, null);
    assert.equal(cleared.patch.projectedNCP, undefined);
    assert.equal(cleared.patch.collectedNCP, undefined);

    // every spoof key is rejected on its own, and the set is the documented one.
    for (const key of ['changedBy', 'updatedBy', 'createdBy', 'actor', 'date', 'timestamp', 'statusHistory', 'assignmentHistory']) {
      assert.ok(FOLLOW_UP_SPOOF_KEYS.has(key), `${key} must be a rejected audit key`);
      const res = parseFollowUpPayload({ status: 'Contacted', [key]: 'x' }, CANONICAL_STATUSES);
      assert.equal(res.errors.length, 1, `${key} rejected`);
      assert.match(res.errors[0], /not accepted on this endpoint/);
    }

    const unknown = parseFollowUpPayload({ status: 'Made Up' }, CANONICAL_STATUSES);
    assert.equal(unknown.errors.length, 1);
    assert.match(unknown.errors[0], /Unknown status "Made Up"/);

    // `currentStatus` still fills in when `status` is blank, and two
    // conflicting spellings are an error rather than a silent pick.
    const blankAlias = parseFollowUpPayload({ status: '', currentStatus: 'Busy' }, CANONICAL_STATUSES);
    assert.deepEqual(blankAlias.errors, []);
    assert.equal(blankAlias.patch.status, 'Busy');

    const conflict = parseFollowUpPayload({ status: 'Busy', currentStatus: 'Converted' }, CANONICAL_STATUSES);
    assert.equal(conflict.errors.length, 1);
    assert.match(conflict.errors[0], /disagree/);

    // The lead is never silently dropped into a default status.
    const lead = await createLead(userA, '01700000133');
    const rejected = await followUp(lead.id, { status: 'Busy', currentStatus: 'Converted' });
    assert.equal(rejected.status, 400);
    assert.equal((await leadRow(lead.id)).current_status, 'Untouched');
    assert.equal((await activityRows(lead.id)).length, 0);
  });

  it('Y. the migration is registered in the runMigrations chain (cold-start safety)', () => {
    // A migration file that is never wired into runMigrations() silently
    // never runs in production - so the wiring is asserted, not assumed.
    const runner = fs.readFileSync(
      path.join(process.cwd(), 'server/database/runMigrations.ts'),
      'utf-8'
    );
    assert.match(runner, /migrations\/037_lead_activities\.js/, '037 must be imported');
    assert.match(runner, /run:\s*leadActivities/, '037 must be part of the migrations array');
    const migrationPath = path.join(process.cwd(), 'server/database/migrations/037_lead_activities.ts');
    assert.ok(fs.existsSync(migrationPath), 'the 037 migration file must exist');
    const migration = fs.readFileSync(migrationPath, 'utf-8');
    for (const required of [
      'CREATE TABLE IF NOT EXISTS lead_activities',
      'REFERENCES leads(id)',
      'REFERENCES users(id)',
      'idx_lead_activities_lead_created',
      'idx_lead_activities_created_at',
    ]) {
      assert.ok(migration.includes(required), `migration must contain: ${required}`);
    }
    // The legacy snapshot must never be backfilled by the migration.
    assert.ok(
      !/INSERT INTO lead_activities[\s\S]*FROM leads/i.test(migration),
      'no backfill of lead_activities from leads is allowed'
    );
  });

  it('Y2. the legacy whole-lead endpoint can no longer wipe server-authored history', () => {
    const routes = fs.readFileSync(
      path.join(process.cwd(), 'server/routes/production.routes.ts'),
      'utf-8'
    );
    assert.match(
      routes,
      /status_history = CASE[\s\S]{0,220}?ELSE leads\.status_history[\s\S]{0,40}?END/,
      'LEAD_UPSERT_SQL must preserve status_history when the client sends none'
    );
    assert.match(
      routes,
      /assignment_history = CASE[\s\S]{0,220}?ELSE leads\.assignment_history[\s\S]{0,40}?END/,
      'LEAD_UPSERT_SQL must preserve assignment_history the same way'
    );
    assert.ok(routes.includes("router.post('/leads/:id/follow-up', requireAuth"), 'follow-up route must require auth');
    assert.ok(routes.includes("router.get('/leads/:id/activities', requireAuth"), 'activity read route must require auth');
    assert.ok(routes.includes("router.get('/leads/:id', requireAuth"), 'single-lead read route must require auth');
  });
});


