import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds, classifyFollowUpBucket } from '../utils/businessTime.js';

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up_active ON leads (next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_assigned_next_follow_up_active ON leads (assigned_to, next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL`);
}

describe('Follow-up Queue — GET /api/leads/follow-ups (Step 4B)', () => {
  let pool: any;
  let app: express.Express;
  let adminRoleId: string;
  let managerRoleId: string;
  let employeeRoleId: string;
  let permIds: Record<string, string> = {};
  let adminUser: any;
  let managerUser: any;
  let employeeA: any;
  let employeeB: any;
  let subordinate: any;

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);
    await pool.query(`DELETE FROM departments`);
    await pool.query(`DELETE FROM options`);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    adminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`)).rows[0].id;
    managerRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`)).rows[0].id;
    employeeRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`)).rows[0].id;

    for (const code of ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export']) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [adminRoleId, managerRoleId, employeeRoleId]) {
      for (const code of Object.keys(permIds)) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }
    const statuses = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, true) ON CONFLICT DO NOTHING`, [statuses[i], i + 1]);
    }

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: adminRes.rows[0].id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };
    const mgrRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('MGRA', 'Manager A', 'mgra@test.com', 'hashed', $1, $2, true) RETURNING id`, [managerRoleId, deptId]);
    managerUser = { id: mgrRes.rows[0].id, employeeId: 'MGRA', email: 'mgra@test.com', role: 'MANAGER' };
    const empARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'Employee A', 'empaa@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeA = { id: empARes.rows[0].id, employeeId: 'EMPA', email: 'empaa@test.com', role: 'EMPLOYEE' };
    const empBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPB', 'Employee B', 'empb@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeB = { id: empBRes.rows[0].id, employeeId: 'EMPB', email: 'empb@test.com', role: 'EMPLOYEE' };
    const subRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('SUBA', 'Subordinate A', 'suba@test.com', 'hashed', $1, $2, $3, true) RETURNING id`, [employeeRoleId, deptId, managerUser.id]);
    subordinate = { id: subRes.rows[0].id, employeeId: 'SUBA', email: 'suba@test.com', role: 'EMPLOYEE' };

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
  });

  function token(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function insertLead(opts: {
    code: string;
    name: string;
    mobile: string;
    assignedTo: string;
    nextAt: string | null;
    status?: string;
    deleted?: boolean;
    custom?: Record<string, any>;
  }) {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by, current_status, next_follow_up_at, is_deleted, custom_fields, follow_up_count)
       VALUES ($1,$2,$3,$4,$4,$4,$5,$6,$7,$8::jsonb,0)`,
      [opts.code, opts.name, opts.mobile, opts.assignedTo, opts.status || 'Contacted', opts.nextAt, opts.deleted === true, JSON.stringify(opts.custom || { assignedTo: opts.assignedTo })]
    );
  }

  const bounds = () => getDhakaBusinessDayBounds(new Date());

  it('A. Own user sees only own due leads', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 3 * 3600000).toISOString();
    await insertLead({ code: 'own_a', name: 'Own A', mobile: '01710000001', assignedTo: employeeA.id, nextAt: today, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'own_b', name: 'Own B', mobile: '01710000002', assignedTo: employeeB.id, nextAt: today, custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = res.body.data.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'own_a');
  });

  it('B. DownTeam manager sees subordinate due leads', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 4 * 3600000).toISOString();
    await insertLead({ code: 'sub_due', name: 'Sub Due', mobile: '01710000003', assignedTo: subordinate.id, nextAt: today, custom: { assignedTo: 'SUBA' } });
    await insertLead({ code: 'b_due', name: 'B Due', mobile: '01710000004', assignedTo: employeeB.id, nextAt: today, custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(managerUser)}`);
    assert.equal(res.status, 200);
    const ids = res.body.data.items.map((i: any) => i.id);
    assert.ok(ids.includes('sub_due'));
    assert.ok(!ids.includes('b_due'));
  });

  it('C. Organization user sees all due leads', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'org_a', name: 'A', mobile: '01710000005', assignedTo: employeeA.id, nextAt: today, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'org_b', name: 'B', mobile: '01710000006', assignedTo: employeeB.id, nextAt: today, custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(adminUser)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 2);
  });

  it('D. unrelated user cannot see others leads', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'secret', name: 'Secret', mobile: '01710000007', assignedTo: employeeA.id, nextAt: today, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeB)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 0);
  });

  it('E. forged assignedTo query cannot widen scope', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'forge_a', name: 'A', mobile: '01710000008', assignedTo: employeeA.id, nextAt: today, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all&assignedTo=EMPA').set('Authorization', `Bearer ${token(employeeB)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 0);
  });

  it('F. soft-deleted lead is excluded', async () => {
    const b = bounds();
    const today = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'gone', name: 'Gone', mobile: '01710000009', assignedTo: employeeA.id, nextAt: today, deleted: true, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.length, 0);
  });

  it('G. overdue bucket classification is correct', async () => {
    const b = bounds();
    const overdueAt = new Date(b.todayStart.getTime() - 3600000).toISOString();
    await insertLead({ code: 'ovd', name: 'Overdue', mobile: '01710000010', assignedTo: employeeA.id, nextAt: overdueAt, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=overdue').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 1);
    assert.equal(res.body.data.items[0].dueState, 'overdue');
  });

  it('H. today bucket classification is correct', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 8 * 3600000).toISOString();
    await insertLead({ code: 'tdy', name: 'Today', mobile: '01710000011', assignedTo: employeeA.id, nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=today').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 1);
    assert.equal(res.body.data.items[0].dueState, 'today');
  });

  it('I. upcoming bucket classification is correct', async () => {
    const b = bounds();
    const upcomingAt = new Date(b.tomorrowStart.getTime() + 3600000).toISOString();
    await insertLead({ code: 'upc', name: 'Upcoming', mobile: '01710000012', assignedTo: employeeA.id, nextAt: upcomingAt, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=upcoming').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 1);
    assert.equal(res.body.data.items[0].dueState, 'upcoming');
  });

  it('J. Bangladesh business-date boundaries do not shift by UTC', async () => {
    const b = bounds();
    // Instant just after Dhaka midnight is still "yesterday" in UTC on most evenings
    const justAfterDhakaMidnight = new Date(b.todayStart.getTime() + 30 * 60000).toISOString();
    await insertLead({ code: 'tz', name: 'TZ', mobile: '01710000013', assignedTo: employeeA.id, nextAt: justAfterDhakaMidnight, custom: { assignedTo: 'EMPA' } });
    const classified = classifyFollowUpBucket(justAfterDhakaMidnight, b);
    assert.equal(classified, 'today');
    const res = await request(app).get('/api/leads/follow-ups?bucket=today').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.some((i: any) => i.id === 'tz'), true);
    const overdueRes = await request(app).get('/api/leads/follow-ups?bucket=overdue').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(overdueRes.body.data.items.some((i: any) => i.id === 'tz'), false);
    assert.equal(res.body.data.timezone, 'Asia/Dhaka');
  });

  it('K. terminal statuses excluded by default', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'conv', name: 'Converted', mobile: '01710000014', assignedTo: employeeA.id, nextAt: todayAt, status: 'Converted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'ni', name: 'NI', mobile: '01710000015', assignedTo: employeeA.id, nextAt: todayAt, status: 'Not Interested', custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.length, 0);
    const withTerm = await request(app).get('/api/leads/follow-ups?bucket=all&includeTerminal=true').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(withTerm.body.data.items.length, 2);
  });

  it('L. null next_follow_up_at excluded', async () => {
    await insertLead({ code: 'nullfu', name: 'No FU', mobile: '01710000016', assignedTo: employeeA.id, nextAt: null, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.length, 0);
  });

  it('M. status filter ANDs with visibility', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'busy_a', name: 'Busy A', mobile: '01710000017', assignedTo: employeeA.id, nextAt: todayAt, status: 'Busy', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'int_a', name: 'Int A', mobile: '01710000018', assignedTo: employeeA.id, nextAt: todayAt, status: 'Interested', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'busy_b', name: 'Busy B', mobile: '01710000019', assignedTo: employeeB.id, nextAt: todayAt, status: 'Busy', custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/leads/follow-ups?bucket=all&status=Busy').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.length, 1);
    assert.equal(res.body.data.items[0].id, 'busy_a');
  });

  it('N. pagination/limit is bounded', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    for (let i = 0; i < 5; i++) {
      await insertLead({ code: `page_${i}`, name: `P${i}`, mobile: `0171000002${i}`, assignedTo: employeeA.id, nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    }
    const res = await request(app).get('/api/leads/follow-ups?bucket=all&limit=2&offset=0').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.items.length, 2);
    assert.equal(res.body.data.pagination.limit, 2);
    assert.equal(res.body.data.pagination.total, 5);
    const huge = await request(app).get('/api/leads/follow-ups?bucket=all&limit=99999').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.ok(huge.body.data.pagination.limit <= 200);
  });

  it('O. latest activity join does not duplicate lead rows', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'dupact', name: 'Dup', mobile: '01710000030', assignedTo: employeeA.id, nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    const leadRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = 'dupact'`);
    const lid = leadRow.rows[0].id;
    await pool.query(`INSERT INTO lead_activities (lead_id, status, remarks, created_by) VALUES ($1,'Contacted','first',$2)`, [lid, employeeA.id]);
    await pool.query(`INSERT INTO lead_activities (lead_id, status, remarks, created_by) VALUES ($1,'Busy','second',$2)`, [lid, employeeA.id]);
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    const matches = res.body.data.items.filter((i: any) => i.id === 'dupact');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].latestActivity.remarks, 'second');
  });

  it('P. queue result updates after POST /api/leads/:id/follow-up', async () => {
    const leadRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token(employeeA)}`).send({
      customerName: 'Queue Mut',
      mobile: '01710000031',
    });
    assert.equal(leadRes.status, 200);
    const lead = leadRes.body.data;
    const before = await request(app).get('/api/leads/follow-ups?bucket=upcoming').set('Authorization', `Bearer ${token(employeeA)}`);
    const beforeCount = before.body.data.items.filter((i: any) => i.id === lead.id).length;
    const b = bounds();
    const future = new Date(b.tomorrowStart.getTime() + 5 * 3600000).toISOString();
    const fu = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token(employeeA)}`).send({
      status: 'Follow-up Set',
      remarks: 'queued',
      nextFollowUpDate: future,
    });
    assert.equal(fu.status, 200, JSON.stringify(fu.body));
    const after = await request(app).get('/api/leads/follow-ups?bucket=upcoming').set('Authorization', `Bearer ${token(employeeA)}`);
    const afterCount = after.body.data.items.filter((i: any) => i.id === lead.id).length;
    assert.equal(beforeCount, 0);
    assert.equal(afterCount, 1);
  });

  it('Q. no localStorage write fallback in queue route/page', async () => {
    const route = fs.readFileSync(path.join(process.cwd(), 'server/routes/production.routes.ts'), 'utf-8');
    const start = route.indexOf("router.get('/leads/follow-ups'");
    const end = route.indexOf("router.get('/leads/:id'", start);
    const body = route.slice(start, end);
    assert.ok(!body.includes('localStorage'));
    const page = fs.readFileSync(path.join(process.cwd(), 'src/modules/leads/pages/FollowUpStrategy.tsx'), 'utf-8');
    assert.ok(page.includes('getFollowUpQueue'));
    assert.ok(!page.includes('getLeads('));
    assert.ok(!page.includes('localStorage'));
    const svc = fs.readFileSync(path.join(process.cwd(), 'src/modules/leads/services/leadService.ts'), 'utf-8');
    const qStart = svc.indexOf('async getFollowUpQueue');
    const qBody = svc.slice(qStart, qStart + 1200);
    assert.ok(qBody.includes('/api/leads/follow-ups'));
  });

  it('route is registered before generic :id', async () => {
    const res = await request(app).get('/api/leads/follow-ups').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.data);
    assert.notEqual(res.body.message, 'Lead not found.');
  });

  it('requires auth and leads.view', async () => {
    const noAuth = await request(app).get('/api/leads/follow-ups');
    assert.equal(noAuth.status, 401);
  });
});
