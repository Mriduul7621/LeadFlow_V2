/**
 * lead-quality-http-integration.test.ts — Lead Quality API wiring (PGlite)
 * ------------------------------------------------------------------
 * End-to-end over a real PostgreSQL-compatible database:
 * - GET /api/leads/:id/quality: full explanation, auth, visibility, 404s
 * - GET /api/leads: compact quality, qualityBand filter, quality sorts
 * - POST /api/leads and POST follow-up: fresh quality on mutation
 * - GET /api/scheduled-activities: parent-lead compact quality
 * - GET /api/dashboard: scope-consistent quality aggregate
 *
 * Fixture dates are relative to Date.now() with wide band margins —
 * no wall-clock flakes.
 */

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
function tokenFor(user: any): string {
  return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
}
function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

/** ISO instant N days from now (positive = future). */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

async function setupSchema(pool: any) {
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'Untouched', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT, next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255), collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2), product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')), title VARCHAR(255), scheduled_at TIMESTAMP NOT NULL, duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0), remarks TEXT, status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', meeting_type VARCHAR(255), location VARCHAR(255), created_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), completed_at TIMESTAMP, completed_by UUID REFERENCES users(id) ON DELETE SET NULL, completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
}

describe('Lead Quality API — HTTP integration (PGlite)', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let employeeA: any;
  let employeeB: any;
  let mobileSeq = 0;
  const nextMobile = () => `0179${String(100000 + (mobileSeq += 1))}`;

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

    const deptId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`)).rows[0].id;
    const adminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`)).rows[0].id;
    const employeeRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`)).rows[0].id;

    for (const code of [
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
      'dashboard.view',
    ]) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      for (const roleId of [adminRoleId, employeeRoleId]) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, res.rows[0].id]);
      }
    }

    const statuses = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, true) ON CONFLICT DO NOTHING`, [statuses[i], i + 1]);
    }

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'adminq@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: adminRes.rows[0].id, employeeId: 'ADMIN1', email: 'adminq@test.com', role: 'ADMIN' };
    const empARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'Employee A', 'empaq@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeA = { id: empARes.rows[0].id, employeeId: 'EMPA', email: 'empaq@test.com', role: 'EMPLOYEE' };
    const empBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPB', 'Employee B', 'empbq@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeB = { id: empBRes.rows[0].id, employeeId: 'EMPB', email: 'empbq@test.com', role: 'EMPLOYEE' };

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

  async function insertLead(opts: {
    code: string; name: string; assignedTo: string; status?: string;
    createdAt?: string | null; lastContactedAt?: string | null;
    nextFollowUpAt?: string | null; premium?: number | null;
  }): Promise<{ id: string; code: string }> {
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by,
          current_status, last_contacted_at, next_follow_up_at, expected_premium, created_at)
       VALUES ($1,$2,$3,$4,$4,$4,$5,$6::timestamp,$7::timestamp,$8,COALESCE($9::timestamp, NOW()))
       RETURNING id`,
      [
        opts.code, opts.name, nextMobile(), opts.assignedTo,
        opts.status || 'Untouched',
        opts.lastContactedAt || null,
        opts.nextFollowUpAt || null,
        opts.premium ?? null,
        opts.createdAt || null,
      ]
    );
    return { id: res.rows[0].id, code: opts.code };
  }

  async function insertActivity(leadId: string, status: string, createdAt: string, byUser: string) {
    await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, status, created_by, created_at)
       VALUES ($1, 'follow_up', $2, $3, $4::timestamp)`,
      [leadId, status, byUser, createdAt]
    );
  }

  /** A Hot lead by construction: 35 + 35 + 5 + 5 + 3 = 83. */
  async function seedHotLead(code: string, assignedTo: string) {
    return insertLead({
      code, name: `Hot ${code}`, assignedTo,
      status: 'Pipeline Locked',
      lastContactedAt: daysFromNow(0),
      nextFollowUpAt: daysFromNow(2),
      premium: 50000,
    });
  }

  function reconcileFromResponse(q: any): boolean {
    const factorTotal =
      (q.positiveFactors || []).reduce((a: number, f: any) => a + f.points, 0) +
      (q.negativeFactors || []).reduce((a: number, f: any) => a + f.points, 0);
    return Math.min(100, Math.max(0, 35 + factorTotal)) === q.score;
  }

  it('A. quality endpoint returns the full explanation and reconciles', async () => {
    const lead = await seedHotLead('q_hot_a', employeeA.id);
    const res = await request(app)
      .get(`/api/leads/${lead.id}/quality`)
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    const q = res.body.data;
    assert.equal(q.score, 83);
    assert.equal(q.band, 'Hot');
    assert.equal(q.isTerminal, false);
    assert.ok(Array.isArray(q.positiveFactors) && q.positiveFactors.length > 0);
    assert.ok(Array.isArray(q.negativeFactors));
    assert.ok(Array.isArray(q.attentionReasons));
    assert.ok(q.positiveFactors.some((f: any) => f.label === 'Pipeline locked' && f.points === 35));
    assert.ok(reconcileFromResponse(q), 'factors must explain the score end-to-end');
  });

  it('B. quality endpoint is deterministic across calls', async () => {
    const lead = await seedHotLead('q_hot_b', employeeA.id);
    const first = await request(app).get(`/api/leads/${lead.id}/quality`).set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    const second = await request(app).get(`/api/leads/${lead.id}/quality`).set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
  });

  it('C. quality endpoint requires auth and honors visibility', async () => {
    const own = await seedHotLead('q_hot_c1', employeeA.id);
    const other = await seedHotLead('q_hot_c2', employeeB.id);

    const anon = await request(app).get(`/api/leads/${own.id}/quality`);
    assert.equal(anon.status, 401);

    const missing = await request(app)
      .get('/api/leads/00000000-0000-0000-0000-000000000000/quality')
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(missing.status, 404);

    // Own-visibility employee cannot read another employee's lead quality.
    const cross = await request(app)
      .get(`/api/leads/${other.id}/quality`)
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(cross.status, 404);

    // Organization admin can read both.
    const adminOwn = await request(app)
      .get(`/api/leads/${own.id}/quality`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    assert.equal(adminOwn.status, 200);
    const adminOther = await request(app)
      .get(`/api/leads/${other.id}/quality`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    assert.equal(adminOther.status, 200);
  });

  it('D. lead list carries compact quality; band filter and sorts work', async () => {
    const hot = await seedHotLead('q_list_hot', employeeA.id);
    await insertLead({
      code: 'q_list_warm', name: 'Warm lead', assignedTo: employeeA.id,
      status: 'Meeting Completed', createdAt: daysFromNow(0),
    });
    const cold = await insertLead({
      code: 'q_list_cold', name: 'Cold lead', assignedTo: employeeA.id,
      status: 'No Response', createdAt: daysFromNow(-60),
    });
    for (const day of [-60, -59, -58]) {
      await insertActivity(cold.id, 'No Response', daysFromNow(day), employeeA.id);
    }

    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body), 'GET /api/leads returns a bare array');
    assert.equal(list.body.length, 3);
    for (const lead of list.body) {
      assert.ok(lead.leadQuality, 'every list item must carry compact quality');
      assert.equal(typeof lead.leadQuality.score, 'number');
      assert.equal(typeof lead.leadQuality.band, 'string');
      assert.deepEqual(Object.keys(lead.leadQuality).sort(), ['band', 'score']);
    }
    const hotItem = list.body.find((l: any) => l.customerName === `Hot ${hot.code}`);
    assert.equal(hotItem.leadQuality.score, 83);
    assert.equal(hotItem.leadQuality.band, 'Hot');

    const filtered = await request(app)
      .get('/api/leads').query({ qualityBand: 'Hot' })
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.length, 1);
    assert.equal(filtered.body[0].leadQuality.band, 'Hot');

    const desc = await request(app)
      .get('/api/leads').query({ sort: 'quality_desc' })
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.deepEqual(desc.body.map((l: any) => l.leadQuality.band), ['Hot', 'Warm', 'Cold']);

    const asc = await request(app)
      .get('/api/leads').query({ sort: 'quality_asc' })
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.deepEqual(asc.body.map((l: any) => l.leadQuality.band), ['Cold', 'Warm', 'Hot']);
  });

  it('E. lead detail embeds the full explanation', async () => {
    const lead = await seedHotLead('q_detail', employeeA.id);
    const res = await request(app)
      .get(`/api/leads/${lead.id}`)
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const payload = res.body.data || res.body;
    const detail = payload.lead || payload;
    assert.ok(detail.leadQuality, 'detail must embed leadQuality');
    assert.equal(detail.leadQuality.score, 83);
    assert.equal(detail.leadQuality.band, 'Hot');
    assert.ok(Array.isArray(detail.leadQuality.positiveFactors));
  });

  it('F. creating a lead returns fresh quality (no stale patch)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`)
      .send({ customerName: 'Fresh Lead', mobile: nextMobile(), source: 'Test' });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const q = res.body.data.leadQuality;
    assert.ok(q, 'create response must include leadQuality');
    // Brand-new Untouched lead touched today: 35 + 5 = 40 Developing.
    assert.equal(q.score, 40);
    assert.equal(q.band, 'Developing');
    assert.ok(Array.isArray(q.positiveFactors));
    assert.ok(Array.isArray(q.negativeFactors));
    assert.ok(Array.isArray(q.attentionReasons));
  });

  it('G. follow-up response carries fresh quality reflecting the move', async () => {
    const created = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`)
      .send({ customerName: 'Move Lead', mobile: nextMobile(), source: 'Test' });
    assert.equal(created.status, 200);
    const leadId = created.body.data.id;
    const res = await request(app)
      .post(`/api/leads/${leadId}/follow-up`)
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`)
      .send({ status: 'Interested', remarks: 'very interested' });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const q = res.body.data.lead.leadQuality;
    assert.ok(q, 'follow-up response lead must include fresh leadQuality');
    assert.ok(
      (q.positiveFactors || []).some((f: any) => f.label === 'Customer interested' && f.points === 15),
      'fresh score must reflect the Interested move'
    );
    assert.ok(reconcileFromResponse(q), 'fresh factors must explain the fresh score');
  });

  it('H. scheduled-activities list carries parent-lead compact quality', async () => {
    const lead = await seedHotLead('q_sched', employeeA.id);
    const created = await request(app)
      .post('/api/scheduled-activities')
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`)
      .send({ leadId: lead.id, activityType: 'call', scheduledAt: daysFromNow(1), title: 'Intro call' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const res = await request(app)
      .get('/api/scheduled-activities')
      .set('Authorization', `Bearer ${tokenFor(employeeA)}`);
    assert.equal(res.status, 200);
    const item = (res.body.data as any[]).find((r: any) => r.leadId === lead.id);
    assert.ok(item, 'scheduled item for the lead must be listed');
    assert.ok(item.leadQuality, 'scheduled item must carry parent-lead quality');
    assert.equal(item.leadQuality.band, 'Hot');
    assert.ok(item.leadQuality.score >= 80);
  });

  it('I. dashboard carries the scope-consistent quality aggregate', async () => {
    await seedHotLead('q_dash_hot', employeeA.id);
    await insertLead({
      code: 'q_dash_conv', name: 'Converted lead', assignedTo: employeeA.id, status: 'Converted',
    });
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const q = res.body.data.quality;
    assert.ok(q, 'dashboard must include the quality aggregate');
    // Terminal Converted lead excluded: only the Hot lead is scored.
    assert.equal(q.activeScored, 1);
    assert.equal(q.hot, 1);
    assert.equal(q.warm, 0);
    assert.equal(q.developing, 0);
    assert.equal(q.cold, 0);
    assert.equal(q.activeAverage, 83);
    assert.equal(q.needsAttention, 0);
  });
});
