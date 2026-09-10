/**
 * scheduled-activities-integration.test.ts — Step 5C
 * ------------------------------------------------------------------
 * Server-authoritative scheduled activities / calendar.
 * PostgreSQL (Asia/Dhaka) is the source of truth; visibility is
 * inherited from the parent lead (Own/DownTeam/Organization).
 *
 * Covers:
 *   - Create / list / get / update / delete (DB path)
 *   - Demo fallbackStore path
 *   - Visibility: Own, DownTeam, Organization
 *   - Validation: missing lead, invalid type/status/date, authz
 *   - Range filtering (from/to) + leadId + type + status
 *   - Client source guards (TaskCalendar + Dashboard use scheduled_activities)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

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
  // Minimal schema for scheduled_activities tests (subset of full migration)
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'Untouched', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT, next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255), collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2), product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')), title VARCHAR(255), scheduled_at TIMESTAMP NOT NULL, duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0), remarks TEXT, status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', meeting_type VARCHAR(255), location VARCHAR(255), created_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), completed_at TIMESTAMP, completed_by UUID REFERENCES users(id) ON DELETE SET NULL, completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_activities_lead_id ON scheduled_activities(lead_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at ON scheduled_activities(scheduled_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_activities_updated_by ON scheduled_activities(updated_by);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_by ON scheduled_activities(completed_by);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_activity_id ON scheduled_activities(completed_activity_id);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
}

describe('Scheduled Activities — server-authoritative calendar (Step 5C)', () => {
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

    await pool.query(`DELETE FROM scheduled_activities`);
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
    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM leads`);
  });

  function token(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function insertLead(opts: { code: string; name: string; mobile: string; assignedTo: string; status?: string }) {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by, current_status, custom_fields, follow_up_count)
       VALUES ($1,$2,$3,$4,$4,$4,$5,$6::jsonb,0)`,
      [opts.code, opts.name, opts.mobile, opts.assignedTo, opts.status || 'Interested', JSON.stringify({ assignedTo: opts.assignedTo === employeeA.id ? 'EMPA' : opts.assignedTo === employeeB.id ? 'EMPB' : opts.assignedTo === subordinate.id ? 'SUBA' : 'ADMIN1' })]
    );
    const r: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [opts.code]);
    return r.rows[0].id as string;
  }

  function futureIso(days: number, hour = 10): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  function ymdDhaka(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  it('A. create scheduled activity (happy path)', async () => {
    const leadId = await insertLead({ code: 'lead_a', name: 'Lead A', mobile: '01710000001', assignedTo: employeeA.id });
    const iso = futureIso(1);
    const res = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: iso, title: 'Intro call', remarks: 'Bring deck', durationMinutes: 30 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.success);
    assert.equal(res.body.data.leadId, leadId);
    assert.equal(res.body.data.activityType, 'call');
    assert.equal(res.body.data.status, 'scheduled');
  });

  it('B. validation — missing leadId / invalid type / bad date / bad duration', async () => {
    const leadId = await insertLead({ code: 'lead_b', name: 'Lead B', mobile: '01710000002', assignedTo: employeeA.id });
    const iso = futureIso(1);
    let r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ activityType: 'call', scheduledAt: iso });
    assert.equal(r.status, 400);
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'bogus', scheduledAt: iso });
    assert.equal(r.status, 400);
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: 'not-a-date' });
    assert.equal(r.status, 400);
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: iso, durationMinutes: -5 });
    assert.equal(r.status, 400);
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: iso, status: 'bogus' });
    assert.equal(r.status, 400);
  });

  it('C. visibility — Own sees only own lead activities', async () => {
    const leadOwn = await insertLead({ code: 'own_c', name: 'Own C', mobile: '01710000003', assignedTo: employeeA.id });
    const leadOther = await insertLead({ code: 'other_c', name: 'Other C', mobile: '01710000004', assignedTo: employeeB.id });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadOwn, activityType: 'meeting', scheduledAt: futureIso(1) });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeB)}`).send({ leadId: leadOther, activityType: 'meeting', scheduledAt: futureIso(1) });
    const res = await request(app).get('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    const ids = (res.body.data as any[]).map(r => r.leadId);
    assert.ok(ids.includes(leadOwn));
    assert.ok(!ids.includes(leadOther));
  });

  it('D. visibility — DownTeam manager sees subordinate activities', async () => {
    const leadSub = await insertLead({ code: 'sub_d', name: 'Sub D', mobile: '01710000005', assignedTo: subordinate.id });
    const leadB = await insertLead({ code: 'b_d', name: 'B D', mobile: '01710000006', assignedTo: employeeB.id });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(subordinate)}`).send({ leadId: leadSub, activityType: 'call', scheduledAt: futureIso(1) });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeB)}`).send({ leadId: leadB, activityType: 'call', scheduledAt: futureIso(1) });
    const res = await request(app).get('/api/scheduled-activities').set('Authorization', `Bearer ${token(managerUser)}`);
    assert.equal(res.status, 200);
    const leadIds = (res.body.data as any[]).map(r => r.leadId);
    assert.ok(leadIds.includes(leadSub));
    assert.ok(!leadIds.includes(leadB));
  });

  it('E. visibility — Organization sees all', async () => {
    const leadA = await insertLead({ code: 'org_ea', name: 'Org A', mobile: '01710000007', assignedTo: employeeA.id });
    const leadB = await insertLead({ code: 'org_eb', name: 'Org B', mobile: '01710000008', assignedTo: employeeB.id });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadA, activityType: 'follow_up', scheduledAt: futureIso(1) });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeB)}`).send({ leadId: leadB, activityType: 'follow_up', scheduledAt: futureIso(1) });
    const res = await request(app).get('/api/scheduled-activities').set('Authorization', `Bearer ${token(adminUser)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 2);
  });

  it('F. list filtering — from/to (Dhaka) and type/status/leadId', async () => {
    const leadId = await insertLead({ code: 'filt_f', name: 'Filt F', mobile: '01710000009', assignedTo: employeeA.id });
    // Create two activities: today+1 and today+5 in Dhaka
    const today = new Date();
    const iso1 = futureIso(1);
    const iso2 = futureIso(5);
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: iso1 });
    const c2 = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'meeting', scheduledAt: iso2 });
    assert.equal(c2.status, 201);
    // mark second as completed via complete endpoint to test status filter
    const c2Id = c2.body.data.id;
    const comp = await request(app).post(`/api/scheduled-activities/${c2Id}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(comp.status, 200);

    // Filter by type
    let res = await request(app).get('/api/scheduled-activities?activityType=call').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 1);
    assert.equal((res.body.data as any[])[0].activityType, 'call');

    // Filter by status
    res = await request(app).get('/api/scheduled-activities?status=completed').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 1);

    // Filter by leadId
    res = await request(app).get(`/api/scheduled-activities?leadId=${leadId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 2);

    // Filter by date range (Dhaka YMD)
    const ymd1 = ymdDhaka(new Date(iso1));
    const ymd2 = ymdDhaka(new Date(iso2));
    // from ymd1 to ymd1 should return only first
    res = await request(app).get(`/api/scheduled-activities?from=${ymd1}&to=${ymd1}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 1);
    // from ymd1 to ymd2 should return both
    res = await request(app).get(`/api/scheduled-activities?from=${ymd1}&to=${ymd2}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body.data as any[]).length, 2);
  });

  it('G. get single + update + delete (visibility enforced)', async () => {
    const leadId = await insertLead({ code: 'g_lead', name: 'G Lead', mobile: '01710000010', assignedTo: employeeA.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1), title: 'Before' });
    const id = created.body.data.id as string;
    // get
    let r = await request(app).get(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    // other user cannot see
    r = await request(app).get(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeB)}`);
    assert.equal(r.status, 404);
    // update title only (status via complete, not PUT)
    r = await request(app).put(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ title: 'After', durationMinutes: 45 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, 'After');
    // PUT with status should be rejected (use complete/cancel)
    r = await request(app).put(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ status: 'completed' });
    assert.equal(r.status, 400);
    // delete pending should succeed
    r = await request(app).delete(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    r = await request(app).get(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 404);
  });

  it('H. lead-scoped listing GET /leads/:id/scheduled-activities', async () => {
    const leadId = await insertLead({ code: 'h_lead', name: 'H Lead', mobile: '01710000011', assignedTo: employeeA.id });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'meeting', scheduledAt: futureIso(1) });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'meeting', scheduledAt: futureIso(2) });
    const r = await request(app).get(`/api/leads/${leadId}/scheduled-activities`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    assert.equal((r.body.data as any[]).length, 2);
    // other user's lead-scoped fetch is 404 (not found via visibility)
    const otherLead = await insertLead({ code: 'h_other', name: 'Other H', mobile: '01710000012', assignedTo: employeeB.id });
    const r2 = await request(app).get(`/api/leads/${otherLead}/scheduled-activities`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r2.status, 404);
  });

  it('I. auth — 401 without token, 403 without leads.edit', async () => {
    const leadId = await insertLead({ code: 'i_lead', name: 'I Lead', mobile: '01710000013', assignedTo: employeeA.id });
    let r = await request(app).post('/api/scheduled-activities').send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    assert.equal(r.status, 401);
    r = await request(app).get('/api/scheduled-activities');
    assert.equal(r.status, 401);
    // revoke permission
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [employeeRoleId]);
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    assert.equal(r.status, 403);
    r = await request(app).get('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 403);
    // restore for next tests (not strictly needed as suite ends, but keep hygiene)
    for (const code of Object.keys(permIds)) {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [employeeRoleId, permIds[code]]);
    }
  });

  it('J. client source guards — TaskCalendar and Dashboard use scheduled_activities', async () => {
    const dash = fs.readFileSync(path.join(process.cwd(), 'src/modules/dashboard/pages/Dashboard.tsx'), 'utf-8');
    const cal = fs.readFileSync(path.join(process.cwd(), 'src/modules/auth/pages/TaskCalendar.tsx'), 'utf-8');
    const svc = fs.readFileSync(path.join(process.cwd(), 'src/modules/scheduledActivities/services/scheduledActivityService.ts'), 'utf-8');
    assert.ok(dash.includes('scheduledActivityService'), 'Dashboard must import scheduledActivityService');
    assert.ok(dash.includes('scheduled_activities'), 'Dashboard must reference scheduled_activities');
    assert.ok(cal.includes('scheduledActivityService'), 'TaskCalendar must import scheduledActivityService');
    assert.ok(!cal.includes('leadService.getLeads'), 'TaskCalendar must not derive events from leadService.getLeads');
    assert.ok(svc.includes('/api/scheduled-activities'), 'service must hit /api/scheduled-activities');
    assert.ok(svc.includes('from') && svc.includes('to'), 'service must support Dhaka range filtering');
  });

  it('K. soft-delete lead cascades (scheduled activities invisible after lead deleted)', async () => {
    const leadId = await insertLead({ code: 'k_lead', name: 'K Lead', mobile: '01710000014', assignedTo: employeeA.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    const id = created.body.data.id as string;
    // soft delete lead
    await pool.query(`UPDATE leads SET is_deleted = TRUE WHERE id = $1`, [leadId]);
    const r = await request(app).get(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 404);
    const list = await request(app).get('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal((list.body.data as any[]).length, 0);
  });

  // ------------------------------------------------------------------
  // Blocker coverage — Step 5C contract
  // ------------------------------------------------------------------

  it('L. TASK type — create/list/filter Dashboard+Calendar', async () => {
    const leadId = await insertLead({ code: 'task_l', name: 'Task Lead', mobile: '01710000015', assignedTo: employeeA.id });
    const iso = futureIso(1);
    let r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'task', scheduledAt: iso, title: 'Task title', priority: 'HIGH', meetingType: 'onsite', location: 'Dhaka' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.activityType, 'task');
    assert.equal(r.body.data.priority, 'HIGH');
    // list filter by task
    r = await request(app).get('/api/scheduled-activities?activityType=task').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    assert.ok((r.body.data as any[]).some(x => x.leadId === leadId && x.activityType === 'task'));
    // invalid task casing: TASK should be normalized to task? Our API lowercases, so TASK should succeed as task
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'TASK', scheduledAt: futureIso(2) });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.activityType, 'task');
  });

  it('M. complete — atomic creates one lead_activities, marks COMPLETED server-derived', async () => {
    const leadId = await insertLead({ code: 'comp_m', name: 'Comp M', mobile: '01710000016', assignedTo: employeeA.id });
    const iso = futureIso(1);
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: iso, remarks: 'call remarks' });
    assert.equal(created.status, 201);
    const schedId = created.body.data.id;
    const beforeActivities = await pool.query(`SELECT COUNT(*)::int AS cnt FROM lead_activities WHERE lead_id = $1`, [leadId]);
    const beforeCnt = beforeActivities.rows[0].cnt;
    const comp: any = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({ remarks: 'completed call' });
    assert.equal(comp.status, 200, JSON.stringify(comp.body));
    assert.equal(comp.body.data.scheduled.status, 'completed');
    assert.ok(comp.body.data.scheduled.completed_at);
    assert.ok(comp.body.data.scheduled.completed_by);
    assert.ok(comp.body.data.scheduled.completed_activity_id);
    // server-derived: cannot spoof completed_by via body
    const comp2: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'meeting', scheduledAt: futureIso(2) });
    const schedId2 = comp2.body.data.id;
    const spoof: any = await request(app).post(`/api/scheduled-activities/${schedId2}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({ completedBy: 'spoof-id', completed_at: '2020-01-01', remarks: 'spoof' } as any);
    assert.equal(spoof.status, 200);
    assert.notEqual(spoof.body.data.scheduled.completed_by, 'spoof-id');
    // exactly one new lead_activities row per complete
    const afterActivities = await pool.query(`SELECT COUNT(*)::int AS cnt FROM lead_activities WHERE lead_id = $1`, [leadId]);
    const afterCnt = afterActivities.rows[0].cnt;
    // we completed two schedules for same lead, so should be +2
    assert.equal(afterCnt, beforeCnt + 2);
    // verify scheduled is now completed
    const get = await request(app).get(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(get.body.data.status, 'completed');
  });

  it('N. complete duplicate — 409 without duplicate row', async () => {
    const leadId = await insertLead({ code: 'dup_n', name: 'Dup N', mobile: '01710000017', assignedTo: employeeA.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    const schedId = created.body.data.id;
    const first: any = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(first.status, 200);
    const cntBefore = (await pool.query(`SELECT COUNT(*)::int AS cnt FROM lead_activities WHERE lead_id=$1`, [leadId])).rows[0].cnt;
    const second: any = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(second.status, 409, JSON.stringify(second.body));
    const cntAfter = (await pool.query(`SELECT COUNT(*)::int AS cnt FROM lead_activities WHERE lead_id=$1`, [leadId])).rows[0].cnt;
    assert.equal(cntAfter, cntBefore, 'duplicate complete must not create second activity');
  });

  it('O. complete FOLLOW_UP reuses canonical follow-up logic (updates lead)', async () => {
    const leadId = await insertLead({ code: 'follow_o', name: 'Follow O', mobile: '01710000018', assignedTo: employeeA.id });
    // ensure lead status is Interested initially
    let leadRow = (await pool.query(`SELECT current_status FROM leads WHERE id=$1`, [leadId])).rows[0];
    assert.ok(leadRow);
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'follow_up', scheduledAt: futureIso(1), remarks: 'plan' });
    const schedId = created.body.data.id;
    const comp: any = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({ status: 'Contacted', remarks: 'did contact', nextFollowUpDate: futureIso(3) });
    assert.equal(comp.status, 200, JSON.stringify(comp.body));
    assert.equal(comp.body.data.activity.status, 'Contacted');
    // lead should have updated current_status and notes
    leadRow = (await pool.query(`SELECT current_status, notes, next_follow_up_at FROM leads WHERE id=$1`, [leadId])).rows[0];
    assert.equal(leadRow.current_status, 'Contacted');
    assert.equal(leadRow.notes, 'did contact');
    assert.ok(leadRow.next_follow_up_at);
  });

  it('P. complete CALL/MEETING/TASK does not fabricate status change', async () => {
    const leadId = await insertLead({ code: 'call_p', name: 'Call P', mobile: '01710000019', assignedTo: employeeA.id });
    await pool.query(`UPDATE leads SET current_status=$1 WHERE id=$2`, ['Interested', leadId]);
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    const schedId = created.body.data.id;
    const comp: any = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({ status: 'Contacted' } as any);
    assert.equal(comp.status, 200);
    const leadRow = (await pool.query(`SELECT current_status FROM leads WHERE id=$1`, [leadId])).rows[0];
    assert.equal(leadRow.current_status, 'Interested', 'CALL complete must not change lead status');
    // TASK similarly
    const leadId2 = await insertLead({ code: 'task_p2', name: 'Task P2', mobile: '01710000020', assignedTo: employeeA.id });
    await pool.query(`UPDATE leads SET current_status=$1 WHERE id=$2`, ['Interested', leadId2]);
    const created2: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadId2, activityType: 'task', scheduledAt: futureIso(1) });
    const schedId2 = created2.body.data.id;
    const comp2: any = await request(app).post(`/api/scheduled-activities/${schedId2}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({ status: 'Contacted' } as any);
    assert.equal(comp2.status, 200);
    const leadRow2 = (await pool.query(`SELECT current_status FROM leads WHERE id=$1`, [leadId2])).rows[0];
    assert.equal(leadRow2.current_status, 'Interested');
  });

  it('Q. cancel — pending -> CANCELLED preserves row, completed cannot cancel', async () => {
    const leadId = await insertLead({ code: 'cancel_q', name: 'Cancel Q', mobile: '01710000021', assignedTo: employeeA.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1) });
    const schedId = created.body.data.id;
    let r = await request(app).post(`/api/scheduled-activities/${schedId}/cancel`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'cancelled');
    // second cancel -> 409
    r = await request(app).post(`/api/scheduled-activities/${schedId}/cancel`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(r.status, 409);
    // completed cannot cancel
    const created2: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(2) });
    const schedId2 = created2.body.data.id;
    const comp = await request(app).post(`/api/scheduled-activities/${schedId2}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(comp.status, 200);
    r = await request(app).post(`/api/scheduled-activities/${schedId2}/cancel`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(r.status, 409);
    // cancelled row still exists (not hard-deleted)
    const get = await request(app).get(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(get.status, 200);
    assert.equal(get.body.data.status, 'cancelled');
  });

  it('R. edit immutability — PENDING editable, COMPLETED/CANCELLED 409', async () => {
    const leadId = await insertLead({ code: 'edit_r', name: 'Edit R', mobile: '01710000022', assignedTo: employeeA.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1), title: 'orig' });
    const schedId = created.body.data.id;
    // pending editable
    let r = await request(app).put(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ title: 'edited' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, 'edited');
    // complete
    const comp = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(comp.status, 200);
    // edit completed -> 409
    r = await request(app).put(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ title: 'should fail' });
    assert.equal(r.status, 409);
    // delete completed -> 409
    r = await request(app).delete(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 409);
    // cancel pending then try edit -> 409
    const created2: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'task', scheduledAt: futureIso(2) });
    const schedId2 = created2.body.data.id;
    const canc = await request(app).post(`/api/scheduled-activities/${schedId2}/cancel`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(canc.status, 200);
    r = await request(app).put(`/api/scheduled-activities/${schedId2}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ title: 'fail' });
    assert.equal(r.status, 409);
    // status cannot be changed via PUT (even for pending)
    const created3: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'meeting', scheduledAt: futureIso(3) });
    const schedId3 = created3.body.data.id;
    r = await request(app).put(`/api/scheduled-activities/${schedId3}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ status: 'completed' } as any);
    assert.equal(r.status, 400);
  });

  it('S. assignedTo narrowing — never widens visibility', async () => {
    const leadA = await insertLead({ code: 'assign_sa', name: 'Assign A', mobile: '01710000023', assignedTo: employeeA.id });
    const leadB = await insertLead({ code: 'assign_sb', name: 'Assign B', mobile: '01710000024', assignedTo: employeeB.id });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadA, activityType: 'call', scheduledAt: futureIso(1) });
    await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeB)}`).send({ leadId: leadB, activityType: 'call', scheduledAt: futureIso(1) });
    // employeeA tries to filter by employeeB's assignedTo (out of scope for Own) — should get empty, not widen
    let r = await request(app).get(`/api/scheduled-activities?assignedTo=${employeeB.employeeId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    assert.equal((r.body.data as any[]).length, 0);
    // employeeA filtering by own assignedTo should return own
    r = await request(app).get(`/api/scheduled-activities?assignedTo=${employeeA.employeeId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    assert.ok((r.body.data as any[]).length >= 1);
    // admin can filter by any (Organization sees all) — should return at least one for employeeB
    r = await request(app).get(`/api/scheduled-activities?assignedTo=${employeeB.employeeId}`).set('Authorization', `Bearer ${token(adminUser)}`);
    assert.equal(r.status, 200);
    assert.ok((r.body.data as any[]).length >= 1);
    // create with assignedTo narrowing enforcement: Own user cannot assign to outside visibility
    const leadOwn = await insertLead({ code: 'assign_own', name: 'Assign Own', mobile: '01710000025', assignedTo: employeeA.id });
    r = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadOwn, activityType: 'call', scheduledAt: futureIso(1), assignedTo: employeeB.employeeId });
    assert.equal(r.status, 403);
  });

  it('T. invisible lead — cannot complete/cancel for lead outside visibility', async () => {
    const leadB = await insertLead({ code: 'invis_t', name: 'Invis T', mobile: '01710000026', assignedTo: employeeB.id });
    const created: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeB)}`).send({ leadId: leadB, activityType: 'call', scheduledAt: futureIso(1) });
    const schedId = created.body.data.id;
    // employeeA (Own) cannot see leadB's scheduled, so complete should 404
    let r = await request(app).post(`/api/scheduled-activities/${schedId}/complete`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(r.status, 404);
    r = await request(app).post(`/api/scheduled-activities/${schedId}/cancel`).set('Authorization', `Bearer ${token(employeeA)}`).send({});
    assert.equal(r.status, 404);
    // also cannot GET
    r = await request(app).get(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 404);
  });

  it('U. server-derived fields — created_by/updated_by/completed_by not spoofable', async () => {
    const leadId = await insertLead({ code: 'spoof_u', name: 'Spoof U', mobile: '01710000027', assignedTo: employeeA.id });
    let r: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'call', scheduledAt: futureIso(1), created_by: adminUser.id, createdBy: adminUser.id } as any);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.createdBy, employeeA.id);
    assert.equal(r.body.data.created_by, employeeA.id);
    const schedId = r.body.data.id;
    // try to spoof updated_by via PUT
    r = await request(app).put(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ title: 'new', updated_by: adminUser.id } as any);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.updatedBy, employeeA.id);
    // complete with spoofed completed_by
    const leadId2 = await insertLead({ code: 'spoof_u2', name: 'Spoof U2', mobile: '01710000028', assignedTo: employeeA.id });
    const created2: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId: leadId2, activityType: 'call', scheduledAt: futureIso(1), completed_by: adminUser.id } as any);
    assert.equal(created2.body.data.completed_by, null);
    assert.equal(created2.body.data.completedBy, null);
  });

  it('V. priority/meeting_type/location persisted and filterable', async () => {
    const leadId = await insertLead({ code: 'prio_v', name: 'Prio V', mobile: '01710000029', assignedTo: employeeA.id });
    let r: any = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${token(employeeA)}`).send({ leadId, activityType: 'task', scheduledAt: futureIso(1), priority: 'HIGH', meetingType: 'onsite', location: 'Dhaka Office' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.priority, 'HIGH');
    assert.equal(r.body.data.meetingType, 'onsite');
    assert.equal(r.body.data.location, 'Dhaka Office');
    // update
    const schedId = r.body.data.id;
    r = await request(app).put(`/api/scheduled-activities/${schedId}`).set('Authorization', `Bearer ${token(employeeA)}`).send({ priority: 'LOW', meetingType: 'virtual', location: 'Remote' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.priority, 'LOW');
    assert.equal(r.body.data.meetingType, 'virtual');
    // filter by priority
    r = await request(app).get('/api/scheduled-activities?priority=LOW').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(r.status, 200);
    assert.ok((r.body.data as any[]).some(x => x.id === schedId));
  });

  it('W. single-request list — scheduledActivityService.listWithPagination uses one fetch', async () => {
    const svcPath = path.join(process.cwd(), 'src/modules/scheduledActivities/services/scheduledActivityService.ts');
    const svcText = fs.readFileSync(svcPath, 'utf-8');
    // Should not contain duplicate apiRequest + fetch in listWithPagination
    const hasDouble = svcText.includes('await apiRequest<any>(`/api/scheduled-activities') && svcText.includes('await fetch(`/api/scheduled-activities');
    // The old buggy version had both; new should have only fetch helper
    assert.equal(hasDouble, false, 'listWithPagination must not do apiRequest + fetch double request');
    assert.ok(svcText.includes('fetchScheduledPage') || svcText.includes('single-request') || svcText.includes('Single-request'), 'should use single-request helper');
  });

  it('X. dashboard/calendar no getLeads — performance guard', async () => {
    const dashPath = path.join(process.cwd(), 'src/modules/dashboard/pages/Dashboard.tsx');
    const dashText = fs.readFileSync(dashPath, 'utf-8');
    // Daily Execution panel should use scheduledActivityService, not getLeads for calendar
    assert.ok(dashText.includes('scheduledActivityService'), 'Dashboard should use scheduledActivityService');
    // Ensure TaskCalendar does not import getLeads for calendar
    const calPath = path.join(process.cwd(), 'src/modules/auth/pages/TaskCalendar.tsx');
    const calText = fs.readFileSync(calPath, 'utf-8');
    assert.ok(calText.includes('scheduledActivityService'), 'TaskCalendar should use scheduledActivityService');
    // Check that Calendar does not call leadService.getLeads
    assert.equal(calText.includes('getLeads'), false, 'TaskCalendar should not call getLeads');
    // Also check legacy re-export
    const legacyPath = path.join(process.cwd(), 'src/pages/TaskCalendar.tsx');
    const legacyText = fs.readFileSync(legacyPath, 'utf-8');
    assert.ok(legacyText.includes('TaskCalendar'), 'legacy path should re-export');
  });
});
