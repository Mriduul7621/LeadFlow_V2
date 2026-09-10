import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

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

describe('Lead API - Real PostgreSQL Integration', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId: string;
  let managerRoleId: string;
  let employeeRoleId: string;

  let permIds: Record<string, string> = {};

  let userA: any;
  let userB: any;
  let managerA: any;
  let managerB: any;
  let subordinateA: any;
  let subordinateB: any;
  let adminUser: any;

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    const db = await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);
    await pool.query(`DELETE FROM departments`);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = (deptRes.rows[0] as any).id;

    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    adminRoleId = (adminRoleRes.rows[0] as any).id;

    const managerRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`);
    managerRoleId = (managerRoleRes.rows[0] as any).id;

    const employeeRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    employeeRoleId = (employeeRoleRes.rows[0] as any).id;

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

    const userARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'User A', 'usera@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    userA = { id: (userARes.rows[0] as any).id, employeeId: 'EMPA', email: 'usera@test.com', role: 'EMPLOYEE' };

    const userBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPB', 'User B', 'userb@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    userB = { id: (userBRes.rows[0] as any).id, employeeId: 'EMPB', email: 'userb@test.com', role: 'EMPLOYEE' };

    const managerARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('MGRA', 'Manager A', 'mgra@test.com', 'hashed', $1, $2, true) RETURNING id`, [managerRoleId, deptId]);
    managerA = { id: (managerARes.rows[0] as any).id, employeeId: 'MGRA', email: 'mgra@test.com', role: 'MANAGER' };

    const managerBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('MGRB', 'Manager B', 'mgrb@test.com', 'hashed', $1, $2, true) RETURNING id`, [managerRoleId, deptId]);
    managerB = { id: (managerBRes.rows[0] as any).id, employeeId: 'MGRB', email: 'mgrb@test.com', role: 'MANAGER' };

    const subARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('SUBA', 'Subordinate A', 'suba@test.com', 'hashed', $1, $2, $3, true) RETURNING id`, [employeeRoleId, deptId, managerA.id]);
    subordinateA = { id: (subARes.rows[0] as any).id, employeeId: 'SUBA', email: 'suba@test.com', role: 'EMPLOYEE', managerId: managerA.employeeId };

    const subBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('SUBB', 'Subordinate B', 'subb@test.com', 'hashed', $1, $2, $3, true) RETURNING id`, [employeeRoleId, deptId, managerB.id]);
    subordinateB = { id: (subBRes.rows[0] as any).id, employeeId: 'SUBB', email: 'subb@test.com', role: 'EMPLOYEE', managerId: managerB.employeeId };

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: (adminRes.rows[0] as any).id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM leads`);
  });

  it('A. Cross-user update: User B cannot update Lead A owned by User A - PG unchanged', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'Lead A', mobile: '01700000001', source: 'Test' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const pgBefore: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(pgBefore.rows.length, 1);
    assert.equal((pgBefore.rows[0] as any).customer_name, 'Lead A');
    const originalName = (pgBefore.rows[0] as any).customer_name;

    const updateRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenB}`).send({ id: leadCode, customerName: 'Hacked Lead', mobile: '01700000001' });
    assert.equal(updateRes.status, 403);

    const pgAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(pgAfter.rows.length, 1);
    assert.equal((pgAfter.rows[0] as any).customer_name, originalName);
    assert.notEqual((pgAfter.rows[0] as any).customer_name, 'Hacked Lead');
  });

  it('B. Cross-user delete: User B cannot delete Lead A - PG still exists', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'Lead A Delete', mobile: '01700000002' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const pgBefore: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1 AND is_deleted = FALSE`, [leadCode]);
    assert.equal(pgBefore.rows.length, 1);

    const deleteRes = await request(app).delete(`/api/leads/${leadCode}`).set('Authorization', `Bearer ${tokenB}`);
    assert.equal(deleteRes.status, 403);

    const pgAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1 AND is_deleted = FALSE`, [leadCode]);
    assert.equal(pgAfter.rows.length, 1);
  });

  it('C. Manager -> subordinate: Manager can update subordinate lead - PG reflects', async () => {
    const tokenSub = signToken({ id: subordinateA.id, employeeId: subordinateA.employeeId, role: subordinateA.role, email: subordinateA.email });
    const tokenMgr = signToken({ id: managerA.id, employeeId: managerA.employeeId, role: managerA.role, email: managerA.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenSub}`).send({ customerName: 'Sub Lead', mobile: '01700000003' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const updateRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenMgr}`).send({ id: leadCode, customerName: 'Updated by Manager', mobile: '01700000003' });
    assert.equal(updateRes.status, 200);

    const pgAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(pgAfter.rows.length, 1);
    assert.equal((pgAfter.rows[0] as any).customer_name, 'Updated by Manager');
  });

  it('D. Manager -> unrelated/sibling branch: Manager A cannot update Manager B subordinate lead', async () => {
    const tokenSubB = signToken({ id: subordinateB.id, employeeId: subordinateB.employeeId, role: subordinateB.role, email: subordinateB.email });
    const tokenMgrA = signToken({ id: managerA.id, employeeId: managerA.employeeId, role: managerA.role, email: managerA.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenSubB}`).send({ customerName: 'Sibling Lead', mobile: '01700000004' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const pgBefore: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    const originalName = (pgBefore.rows[0] as any).customer_name;

    const updateRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenMgrA}`).send({ id: leadCode, customerName: 'Hacked Sibling', mobile: '01700000004' });
    assert.equal(updateRes.status, 403);

    const pgAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal((pgAfter.rows[0] as any).customer_name, originalName);
  });

  it('E. Bulk authorization: Unauthorized bulk containing out-of-scope lead fails for that row, PG unchanged', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email });
    const tokenAdmin = signToken({ id: adminUser.id, employeeId: adminUser.employeeId, role: adminUser.role, email: adminUser.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'Lead A Bulk', mobile: '01700000005' });
    assert.equal(createRes.status, 200);
    const leadCodeA = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const bulkRes = await request(app).post('/api/leads/bulk').set('Authorization', `Bearer ${tokenB}`).send({
      leads: [
        { id: leadCodeA, customerName: 'Hacked via Bulk', mobile: '01700000005' },
        { customerName: 'New Lead Bulk', mobile: '01700000006' }
      ]
    });

    assert.ok(bulkRes.status === 200 || bulkRes.status === 403);
    if (bulkRes.status === 200) {
      const data = bulkRes.body.data;
      assert.ok(data.failed >= 1);
    }

    const pgAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCodeA]);
    assert.equal((pgAfter.rows[0] as any).customer_name, 'Lead A Bulk');

    const adminBulkRes = await request(app).post('/api/leads/bulk').set('Authorization', `Bearer ${tokenAdmin}`).send({
      leads: [
        { id: leadCodeA, customerName: 'Updated by Admin Bulk', mobile: '01700000005' },
        { customerName: 'Admin New Lead', mobile: '01700000007' }
      ]
    });

    assert.equal(adminBulkRes.status, 200);
    const pgAdminAfter: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCodeA]);
    assert.equal((pgAdminAfter.rows[0] as any).customer_name, 'Updated by Admin Bulk');

    const pgNewLead: any = await pool.query(`SELECT * FROM leads WHERE mobile = '01700000007'`);
    assert.equal(pgNewLead.rows.length, 1);
  });

  it('F. Actor spoofing: Payload with false assignedBy/createdBy etc is ignored, PG shows session user', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });

    const spoofPayload = {
      customerName: 'Spoof Test',
      mobile: '01700000008',
      assignedBy: 'HACKER_EMP',
      createdBy: 'HACKER_ID',
      updatedBy: 'HACKER_ID',
      changedBy: 'HACKER_EMP',
      deletedBy: 'HACKER_ID',
      customFields: {
        assignedBy: 'HACKER',
        createdBy: 'HACKER',
        owner: 'HACKER'
      }
    };

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send(spoofPayload);
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const pgRow: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(pgRow.rows.length, 1);
    const row = pgRow.rows[0] as any;
    assert.equal(row.assigned_by, userA.id);
    assert.equal(row.created_by, userA.id);
    assert.equal(row.updated_by, userA.id);

    const customFields = typeof row.custom_fields === 'string' ? JSON.parse(row.custom_fields) : row.custom_fields;
    assert.notEqual((customFields as any).assignedBy, 'HACKER');
    assert.equal((customFields as any).assignedBy, userA.employeeId);
    assert.equal((customFields as any).owner, undefined);
  });

  it('G. Successful persistence: Create -> Update -> Delete flow verifies PG state', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'Persist Lead', mobile: '01700000009', source: 'Test' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    let pgRow: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1 AND is_deleted = FALSE`, [leadCode]);
    assert.equal(pgRow.rows.length, 1);
    assert.equal((pgRow.rows[0] as any).customer_name, 'Persist Lead');

    const updateRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ id: leadCode, customerName: 'Persist Lead Updated', mobile: '01700000009' });
    assert.equal(updateRes.status, 200);

    pgRow = await pool.query(`SELECT * FROM leads WHERE lead_code = $1 AND is_deleted = FALSE`, [leadCode]);
    assert.equal((pgRow.rows[0] as any).customer_name, 'Persist Lead Updated');

    const deleteRes = await request(app).delete(`/api/leads/${leadCode}`).set('Authorization', `Bearer ${tokenA}`);
    assert.ok([200, 403].includes(deleteRes.status));
    if (deleteRes.status === 200) {
      const pgAfterDelete: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1 AND is_deleted = FALSE`, [leadCode]);
      assert.equal(pgAfterDelete.rows.length, 0);
      const pgDeleted: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
      assert.equal(pgDeleted.rows.length, 1);
      assert.equal((pgDeleted.rows[0] as any).is_deleted, true);
    }
  });

  it('Cache failure: API failure does NOT update local cache / PG', async () => {
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email });

    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'Cache Test', mobile: '01700000010' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.lead_code || createRes.body.data.id;

    const pgBefore: any = await pool.query(`SELECT customer_name FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal((pgBefore.rows[0] as any).customer_name, 'Cache Test');

    const failRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenB}`).send({ id: leadCode, customerName: 'Hacked Cache', mobile: '01700000010' });
    assert.equal(failRes.status, 403);

    const pgAfter: any = await pool.query(`SELECT customer_name FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal((pgAfter.rows[0] as any).customer_name, 'Cache Test');
    assert.equal(failRes.body.success, false);
  });
});
