import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { resolveAssignedTo } from '../routes/production/shared.js';
import { fallbackStore } from '../fallbackStore.js';

/**
 * Cleanup PR — manual assignment must refuse INACTIVE users.
 * ------------------------------------------------------------------
 * The bulk-import path has always enforced the rule: an "Assigned To"
 * that does not resolve to an ACTIVE users row is a row error
 * (`Assigned To "…" does not match an active user`, activity read from
 * users.is_active). The MANUAL path (POST /leads upsert — create with
 * an assignee, reassign, transfer; the same endpoint the client's
 * single, inline and bulk-routing actions all call) resolved the user
 * but never checked activity, so a deactivated colleague could keep
 * receiving leads by hand.
 *
 * These tests pin, on a real (PGlite) PostgreSQL:
 *   - create / reassign TO an inactive user -> 400 "inactive", no write;
 *   - create / reassign to an ACTIVE user still succeeds;
 *   - unassigning (blank assignee) still succeeds;
 *   - re-saving a lead whose CURRENT owner has since been deactivated,
 *     with the payload still naming that same owner, is NOT a new
 *     assignment and stays allowed (the deactivation flow owns moving
 *     those leads); a _preserveAssignment edit likewise;
 *   - the import reference rule side by side (row error, same wording
 *     family);
 *   - demo-mode parity at the shared resolver (resolveAssignedTo
 *     reports isActive from the demo user's status text).
 *
 * Auto-assignment needs no new pin here: its candidate loaders already
 * exclude inactive users and lead-auto-assignment.test.ts proves it
 * (demo builder + DB loader after is_active = FALSE).
 */

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

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
      follow_up_count INT DEFAULT 0,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by UUID
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
      activity_type VARCHAR(30) NOT NULL DEFAULT 'call',
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      duration_minutes INTEGER,
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
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
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      recipient_key VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      message TEXT,
      type VARCHAR(50) DEFAULT 'info',
      event_type VARCHAR(100),
      idempotency_key VARCHAR(500),
      reference_type VARCHAR(100),
      reference_id UUID,
      lead_code VARCHAR(50),
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Migration 040: NotificationService inserts with
  // ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL,
  // which needs this partial unique index to exist.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_key
      ON notifications (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
}

describe('Cleanup — manual lead assignment refuses inactive users', () => {
  let pool: any;
  let app: express.Express;

  let deptSalesId: string;
  let managerRoleId: string;
  let employeeRoleId: string;
  const permIds: Record<string, string> = {};

  //   ceo (MANAGER)
  //     managerA (MANAGER, DownTeam)   <- the caller
  //       subA1 (EMPLOYEE, active)
  //       subA2 (EMPLOYEE, active)
  //       inact1 (EMPLOYEE, is_active = FALSE — deactivated report)
  let ceo: any, managerA: any, subA1: any, subA2: any, inact1: any;

  async function createUser(opts: {
    employeeId: string;
    roleId: string;
    managerId?: string | null;
    role: string;
    isActive?: boolean;
  }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7) RETURNING id`,
      [opts.employeeId, `User ${opts.employeeId}`, `${opts.employeeId.toLowerCase()}@test.com`, opts.roleId, deptSalesId, opts.managerId || null, opts.isActive !== false]
    );
    return { id: res.rows[0].id, employeeId: opts.employeeId, email: `${opts.employeeId.toLowerCase()}@test.com`, role: opts.role };
  }

  async function createLead(opts: { mobile: string; name: string; assignedTo: string | null; createdBy: string }) {
    const leadCode = `lead_${opts.mobile}`;
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $5, $5, $5, 'New') RETURNING id`,
      [leadCode, opts.name, opts.mobile, opts.assignedTo, opts.createdBy]
    );
    return { id: res.rows[0].id, code: leadCode, mobile: opts.mobile };
  }

  function tokenFor(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }
  const asMgrA = () => ({ Authorization: `Bearer ${tokenFor(managerA)}` });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    );
    deptSalesId = deptRes.rows[0].id;

    const mgrRole: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`
    );
    managerRoleId = mgrRole.rows[0].id;
    const empRole: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
    );
    employeeRoleId = empRole.rows[0].id;

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [managerRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }

    ceo = await createUser({ employeeId: 'CEO1', roleId: managerRoleId, role: 'MANAGER' });
    managerA = await createUser({ employeeId: 'MGRA', roleId: managerRoleId, managerId: ceo.id, role: 'MANAGER' });
    subA1 = await createUser({ employeeId: 'SUBA1', roleId: employeeRoleId, managerId: managerA.id, role: 'EMPLOYEE' });
    subA2 = await createUser({ employeeId: 'SUBA2', roleId: employeeRoleId, managerId: managerA.id, role: 'EMPLOYEE' });
    inact1 = await createUser({ employeeId: 'INACT1', roleId: employeeRoleId, managerId: managerA.id, role: 'EMPLOYEE', isActive: false });

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
  });

  it('1. Create with an INACTIVE assignee is refused (400, names the inactivity, nothing written)', async () => {
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      customerName: 'Prospect For Inactive', mobile: '01730000001', assignedTo: 'INACT1',
    });
    assert.equal(res.status, 400, JSON.stringify(res.body).slice(0, 300));
    assert.match(res.body.message, /inactive/i);
    const stored: any = await pool.query(`SELECT COUNT(*)::int AS n FROM leads WHERE mobile = '01730000001'`);
    assert.equal(stored.rows[0].n, 0, 'no lead may be written for a refused assignment');
  });

  it('2. Create with an ACTIVE assignee still succeeds', async () => {
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      customerName: 'Prospect For Active', mobile: '01730000002', assignedTo: 'SUBA1',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const stored: any = await pool.query(`SELECT assigned_to FROM leads WHERE mobile = '01730000002'`);
    assert.equal(stored.rows[0].assigned_to, subA1.id);
  });

  it('3. Reassigning an existing lead TO an inactive user is refused; ownership unchanged', async () => {
    const lead = await createLead({ mobile: '01730000003', name: 'Owned By SubA1', assignedTo: subA1.id, createdBy: subA1.id });
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: lead.code, customerName: 'Owned By SubA1', mobile: lead.mobile, assignedTo: 'INACT1',
    });
    assert.equal(res.status, 400, JSON.stringify(res.body).slice(0, 300));
    assert.match(res.body.message, /inactive/i);
    const stored: any = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(stored.rows[0].assigned_to, subA1.id);
  });

  it('4. Reassigning to another ACTIVE user still succeeds', async () => {
    const lead = await createLead({ mobile: '01730000004', name: 'Move Me', assignedTo: subA1.id, createdBy: subA1.id });
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: lead.code, customerName: 'Move Me', mobile: lead.mobile, assignedTo: 'SUBA2',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const stored: any = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(stored.rows[0].assigned_to, subA2.id);
  });

  it('5. Unassigning (explicit blank assignee) still succeeds', async () => {
    const lead = await createLead({ mobile: '01730000005', name: 'Unassign Me', assignedTo: subA1.id, createdBy: subA1.id });
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: lead.code, customerName: 'Unassign Me', mobile: lead.mobile, assignedTo: '',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const stored: any = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(stored.rows[0].assigned_to, null);
  });

  it('6. Re-saving a lead whose CURRENT owner is now inactive (payload names the same owner) is not a new assignment — allowed', async () => {
    const lead = await createLead({ mobile: '01730000006', name: 'Legacy Owned', assignedTo: inact1.id, createdBy: inact1.id });
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: lead.code, customerName: 'Legacy Owned Renamed', mobile: lead.mobile, assignedTo: 'INACT1',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const stored: any = await pool.query(`SELECT customer_name, assigned_to FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(stored.rows[0].customer_name, 'Legacy Owned Renamed');
    assert.equal(stored.rows[0].assigned_to, inact1.id);
  });

  it('7. A _preserveAssignment edit of an inactive-owned lead stays allowed', async () => {
    const lead = await createLead({ mobile: '01730000007', name: 'Preserve Owned', assignedTo: inact1.id, createdBy: inact1.id });
    const res = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: lead.code, customerName: 'Preserve Owned Renamed', mobile: lead.mobile, _preserveAssignment: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const stored: any = await pool.query(`SELECT customer_name, assigned_to FROM leads WHERE id = $1`, [lead.id]);
    assert.equal(stored.rows[0].customer_name, 'Preserve Owned Renamed');
    assert.equal(stored.rows[0].assigned_to, inact1.id);
  });

  it('8. Reference rule, side by side: bulk import still rejects the same inactive assignee per-row', async () => {
    const bad = await request(app).post('/api/leads/bulk').set(asMgrA()).send({
      leads: [{ 'Name': 'Import To Inactive', 'Phone': '01730000008', 'Assigned To': 'INACT1', 'Initial Status': 'No response' }],
    });
    assert.equal(bad.status, 200, JSON.stringify(bad.body).slice(0, 300));
    assert.equal(bad.body.data.failed, 1, JSON.stringify(bad.body.data).slice(0, 300));
    assert.match(JSON.stringify(bad.body), /does not match an active user/i);

    const good = await request(app).post('/api/leads/bulk').set(asMgrA()).send({
      leads: [{ 'Name': 'Import To Active', 'Phone': '01730000009', 'Assigned To': 'SUBA1', 'Initial Status': 'No response' }],
    });
    assert.equal(good.status, 200, JSON.stringify(good.body).slice(0, 300));
    assert.equal(good.body.data.failed, 0, JSON.stringify(good.body.data).slice(0, 300));
  });
});

describe('Cleanup — resolveAssignedTo demo-mode parity', () => {
  const savedUsers = [...fallbackStore.users];
  const savedDbUrl = process.env.DATABASE_URL;

  before(() => {
    delete process.env.DATABASE_URL;
    (fallbackStore as any).users = [
      { id: 'demo-act-1', employeeId: 'DEMO_ACT', fullName: 'Demo Active', email: 'dact@test.com', status: 'Active', isActive: true },
      { id: 'demo-inact-1', employeeId: 'DEMO_INACT', fullName: 'Demo Inactive', email: 'dinact@test.com', status: 'Inactive', isActive: false },
    ];
  });

  after(() => {
    (fallbackStore as any).users = savedUsers;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it('the shared resolver reports activity from the demo user record', async () => {
    const active = await resolveAssignedTo('DEMO_ACT');
    assert.ok(active, 'active demo user resolves');
    assert.equal(active!.isActive, true);

    const inactive = await resolveAssignedTo('DEMO_INACT');
    assert.ok(inactive, 'inactive demo user still resolves (the endpoint decides)');
    assert.equal(inactive!.isActive, false);
  });
});
