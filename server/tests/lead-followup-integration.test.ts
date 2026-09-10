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
  // Add indexes as миграции would
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON lead_activities(lead_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON lead_activities(created_at DESC);`);
}

describe('Lead Follow-up / Activity History — Server-authoritative (Step 4A)', () => {
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

    // Clean
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
    const deptId = (deptRes.rows[0] as any).id;

    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    adminRoleId = (adminRoleRes.rows[0] as any).id;
    const managerRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`);
    managerRoleId = (managerRoleRes.rows[0] as any).id;
    const empRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    employeeRoleId = (empRoleRes.rows[0] as any).id;

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

    // Seed FollowUpStatus dictionary (canonical)
    const statuses = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, true) ON CONFLICT DO NOTHING`, [statuses[i], i + 1]);
    }

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: (adminRes.rows[0] as any).id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };
    const mgrRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('MGRA', 'Manager A', 'mgra@test.com', 'hashed', $1, $2, true) RETURNING id`, [managerRoleId, deptId]);
    managerUser = { id: (mgrRes.rows[0] as any).id, employeeId: 'MGRA', email: 'mgra@test.com', role: 'MANAGER' };
    const empARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'Employee A', 'empaa@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeA = { id: (empARes.rows[0] as any).id, employeeId: 'EMPA', email: 'empaa@test.com', role: 'EMPLOYEE' };
    const empBRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPB', 'Employee B', 'empb@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeB = { id: (empBRes.rows[0] as any).id, employeeId: 'EMPB', email: 'empb@test.com', role: 'EMPLOYEE' };
    const subRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('SUBA', 'Subordinate A', 'suba@test.com', 'hashed', $1, $2, $3, true) RETURNING id`, [employeeRoleId, deptId, managerUser.id]);
    subordinate = { id: (subRes.rows[0] as any).id, employeeId: 'SUBA', email: 'suba@test.com', role: 'EMPLOYEE' };

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    try { await pool.query(`DELETE FROM lead_activities`); } catch {}
    try { await pool.query(`DELETE FROM leads`); } catch {}
  });

  // Helper to create a lead via API as a given user
  async function createLeadAs(user: any, overrides: any = {}): Promise<any> {
    const token = signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`).send({
      customerName: overrides.customerName || 'Test Prospect',
      mobile: overrides.mobile || `0170000${Math.floor(1000 + Math.random() * 9000)}`,
      ...overrides,
    });
    assert.equal(res.status, 200, `createLead failed: ${JSON.stringify(res.body)}`);
    const lead = res.body.data || res.body;
    // lead may be wrapped with success envelope unwrapped? Actually apiRequest unwraps but supertest gets raw JSON { success:true, data: lead }
    const actualLead = (lead && lead.lead) ? lead.lead : (lead && lead.id ? lead : (res.body.data || res.body));
    // Simpler: if res.body.data contains id, it's the lead
    const leadObj = res.body.data;
    assert.ok(leadObj && leadObj.id, 'lead creation must return lead with id');
    return leadObj;
  }

  it('A. authenticated visible user can add a follow-up', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001001', customerName: 'FollowUp A' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({
      status: 'Contacted',
      remarks: 'Called, left voicemail',
    });
    assert.equal(res.status, 200, `follow-up should succeed: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.success);
    assert.ok(res.body.data.lead);
    assert.ok(res.body.data.activity);
  });

  it('B. current_status updates correctly', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001002' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Interested', remarks: 'very interested' });
    assert.equal(res.status, 200);
    const returnedLead = res.body.data.lead;
    assert.equal(returnedLead.currentStatus, 'Interested');
    // Verify PG
    const pgRow: any = await pool.query(`SELECT current_status FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.equal(pgRow.rows[0].current_status, 'Interested');
  });

  it('C. activity row is created', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001003' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Busy', remarks: 'busy' });
    const leadRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [lead.id]);
    const dbId = leadRow.rows[0].id;
    const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [dbId]);
    assert.equal(acts.rows.length, 1);
    assert.equal(acts.rows[0].status, 'Busy');
    assert.equal(acts.rows[0].remarks, 'busy');
  });

  it('D. actor comes from authenticated caller', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001004' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'hi' });
    assert.equal(res.status, 200);
    const activity = res.body.data.activity;
    // created_by should be employeeA's uuid, not spoofed
    const pgAct: any = await pool.query(`SELECT created_by FROM lead_activities WHERE id = $1`, [activity.id]);
    assert.equal(pgAct.rows[0].created_by, employeeA.id);
    // Also statusHistory entry updatedBy should be employeeA employeeId
    const pgLead: any = await pool.query(`SELECT status_history FROM leads WHERE lead_code = $1`, [lead.id]);
    const hist = typeof pgLead.rows[0].status_history === 'string' ? JSON.parse(pgLead.rows[0].status_history) : pgLead.rows[0].status_history;
    const last = hist[hist.length - 1];
    assert.equal(last.updatedBy, employeeA.employeeId);
  });

  it('E. spoofed changedBy/updatedBy/date/statusHistory are ignored or rejected', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001005' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const before: any = await pool.query(`SELECT status_history FROM leads WHERE lead_code = $1`, [lead.id]);
    const beforeLen = (typeof before.rows[0].status_history === 'string' ? JSON.parse(before.rows[0].status_history) : before.rows[0].status_history).length;

    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({
      status: 'Contacted',
      remarks: 'spoof test',
      changedBy: 'HACKER',
      updatedBy: 'HACKER',
      createdBy: 'HACKER',
      actor: 'HACKER',
      date: '2000-01-01T00:00:00.000Z',
      timestamp: '2000-01-01T00:00:00.000Z',
      statusHistory: [{ status: 'HACKED', date: '2000-01-01', remarks: 'hacked' }],
      assignmentHistory: [{ toEmployeeId: 'HACKER', changedBy: 'HACKER' }],
    });
    assert.equal(res.status, 200);
    const after: any = await pool.query(`SELECT status_history, created_by FROM leads WHERE lead_code = $1`, [lead.id]);
    const hist = typeof after.rows[0].status_history === 'string' ? JSON.parse(after.rows[0].status_history) : after.rows[0].status_history;
    // Should have exactly one new entry, not the spoofed HACKED entry alone
    assert.equal(hist.length, beforeLen + 1);
    const newEntry = hist[hist.length - 1];
    assert.notEqual(newEntry.updatedBy, 'HACKER');
    assert.equal(newEntry.updatedBy, employeeA.employeeId);
    assert.notEqual(newEntry.status, 'HACKED');
    // activity created_by should not be HACKER
    const leadIdRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [lead.id]);
    const acts: any = await pool.query(`SELECT created_by, status FROM lead_activities WHERE lead_id = $1`, [leadIdRow.rows[0].id]);
    assert.equal(acts.rows[0].created_by, employeeA.id);
    assert.notEqual(acts.rows[0].status, 'HACKED');
  });

  it('F. server timestamp is used', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001006' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const before = Date.now();
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'time test', date: '2000-01-01T00:00:00.000Z' });
    const after = Date.now();
    assert.equal(res.status, 200);
    const activity = res.body.data.activity;
    const createdAt = new Date(activity.createdAt || activity.created_at).getTime();
    assert.ok(createdAt >= before - 2000 && createdAt <= after + 2000, `server timestamp should be near now, got ${activity.createdAt}`);
    assert.notEqual(new Date(activity.createdAt || activity.created_at).toISOString().slice(0, 10), '2000-01-01');
    // Also history date is server time
    const pgLead: any = await pool.query(`SELECT status_history FROM leads WHERE lead_code = $1`, [lead.id]);
    const hist = typeof pgLead.rows[0].status_history === 'string' ? JSON.parse(pgLead.rows[0].status_history) : pgLead.rows[0].status_history;
    const histDate = new Date(hist[hist.length - 1].date).getTime();
    assert.ok(histDate >= before - 2000 && histDate <= after + 2000);
  });

  it('G. nextFollowUpDate persists', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001007' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const nfd = new Date(Date.now() + 86400000 * 2).toISOString();
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Follow-up Set', remarks: 'follow', nextFollowUpDate: nfd });
    assert.equal(res.status, 200);
    assert.equal(new Date(res.body.data.lead.nextFollowUpDate).toISOString(), new Date(nfd).toISOString());
    const pgLead: any = await pool.query(`SELECT next_follow_up_at FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.ok(pgLead.rows[0].next_follow_up_at);
    assert.equal(new Date(pgLead.rows[0].next_follow_up_at).toISOString(), new Date(nfd).toISOString());
    const pgAct: any = await pool.query(`SELECT next_follow_up_at FROM lead_activities WHERE status = 'Follow-up Set' ORDER BY created_at DESC LIMIT 1`);
    assert.ok(pgAct.rows[0].next_follow_up_at);
  });

  it('H. remarks persist', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001008' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'UniqueRemark123' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.activity.remarks, 'UniqueRemark123');
    const pgLead: any = await pool.query(`SELECT notes FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.equal(pgLead.rows[0].notes, 'UniqueRemark123');
  });

  it('I. meeting fields persist where supported', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001009' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const meetingDate = new Date(Date.now() + 86400000 * 5).toISOString();
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Meeting Fixed', remarks: 'meeting', meetingDate, meetingType: 'In-Person' });
    assert.equal(res.status, 200);
    // Check lead custom_fields
    const pgLead: any = await pool.query(`SELECT custom_fields FROM leads WHERE lead_code = $1`, [lead.id]);
    const cf = typeof pgLead.rows[0].custom_fields === 'string' ? JSON.parse(pgLead.rows[0].custom_fields) : pgLead.rows[0].custom_fields;
    assert.equal(cf.meetingType, 'In-Person');
    // Check activity
    const activity = res.body.data.activity;
    assert.equal(activity.meetingType, 'In-Person');
    assert.ok(activity.meetingAt || activity.meetingDate);
    // Also nextCallDate? test separate
    const nextCallDate = new Date(Date.now() + 86400000).toISOString();
    const res2 = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'call', nextCallDate });
    assert.equal(res2.status, 200);
    const pgLead2: any = await pool.query(`SELECT custom_fields FROM leads WHERE lead_code = $1`, [lead.id]);
    const cf2 = typeof pgLead2.rows[0].custom_fields === 'string' ? JSON.parse(pgLead2.rows[0].custom_fields) : pgLead2.rows[0].custom_fields;
    assert.ok(cf2.nextCallDate);
  });

  it('J. NCP fields persist where supported', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001010' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Interested', remarks: 'ncp', collectedNCP: 1234, projectedNCP: 5678, sumAssured: 99999, productName: 'TestProduct' });
    assert.equal(res.status, 200);
    const pgLead: any = await pool.query(`SELECT expected_premium, expected_value, custom_fields FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.equal(Number(pgLead.rows[0].expected_premium), 5678);
    assert.equal(Number(pgLead.rows[0].expected_value), 99999);
    const cf = typeof pgLead.rows[0].custom_fields === 'string' ? JSON.parse(pgLead.rows[0].custom_fields) : pgLead.rows[0].custom_fields;
    assert.equal(cf.collectedNCP ?? cf.collected_ncp, 1234);
    assert.equal(cf.productName ?? cf.product_name, 'TestProduct');
    const activity = res.body.data.activity;
    assert.equal(activity.collectedNCP ?? activity.collected_ncp, 1234);
    assert.equal(activity.projectedNCP ?? activity.projected_ncp, 5678);
    assert.equal(activity.sumAssured ?? activity.sum_assured, 99999);
  });

  it('K. unknown status fails', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001011' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'UNKNOWN_FAKE_STATUS_123', remarks: 'bad' });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message), /Unknown status/);
    // Verify no activity created, lead unchanged
    const leadRow: any = await pool.query(`SELECT id, current_status FROM leads WHERE lead_code = $1`, [lead.id]);
    const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [leadRow.rows[0].id]);
    assert.equal(acts.rows.length, 0);
  });

  it('L. unauthorized/invisible user cannot update', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001012' });
    const tokenB = signToken({ id: employeeB.id, employeeId: employeeB.employeeId, role: employeeB.role, email: employeeB.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${tokenB}`).send({ status: 'Contacted', remarks: 'hacker' });
    // Should be forbidden (403) or not found (404) — both indicate invisible
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 got ${res.status} ${JSON.stringify(res.body)}`);
    const pgLead: any = await pool.query(`SELECT current_status FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.notEqual(pgLead.rows[0].current_status, 'Contacted');
    const leadIdRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [lead.id]);
    const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [leadIdRow.rows[0].id]);
    assert.equal(acts.rows.length, 0);
  });

  it('M. missing edit permission fails closed', async () => {
    // Remove leads.edit from employeeA's role
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [employeeRoleId, permIds['leads.edit']]);
    const lead = await createLeadAs(adminUser, { mobile: '01700001013', customerName: 'Perm Lead' });
    // Re-assign lead to employeeA so it's visible but permission denied
    // For simplicity, create lead as admin but assignedTo employeeA via bulk? Instead just have admin update to reassign visibility not needed; we need a lead visible to employeeA
    // Create lead as employeeA via admin token but assignedTo employeeA
    // Simpler: create lead as employeeB then try as employeeA with no edit perm? But employeeA has no edit perm now.
    // Let's have employeeA try to update a lead they own (created via admin directly inserted as employeeA visible)
    const leadRowInsert: any = await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by, current_status) VALUES ($1, $2, $3, $4, $4, $4, 'Untouched') RETURNING lead_code`, [`perm_${Date.now()}`, 'Perm Test', '01700001014', employeeA.id]);
    const leadCode = leadRowInsert.rows[0].lead_code;
    const tokenA = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${leadCode}/follow-up`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'Contacted', remarks: 'perm test' });
    assert.equal(res.status, 403, `expected 403 for missing permission got ${res.status} ${JSON.stringify(res.body)}`);
    // Restore permission for subsequent tests
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [employeeRoleId, permIds['leads.edit']]);
    const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = (SELECT id FROM leads WHERE lead_code = $1)`, [leadCode]);
    assert.equal(acts.rows.length, 0);
  });

  it('N. soft-deleted lead cannot receive activity', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001015' });
    const tokenAdmin = signToken({ id: adminUser.id, employeeId: adminUser.employeeId, role: adminUser.role, email: adminUser.email });
    // Soft delete via admin delete endpoint
    await request(app).delete(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
    const tokenA = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'Contacted', remarks: 'deleted' });
    assert.equal(res.status, 404);
    // Verify no activity
    const leadIdRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [lead.id]);
    if (leadIdRow.rows[0]) {
      const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [leadIdRow.rows[0].id]);
      assert.equal(acts.rows.length, 0);
    }
  });

  it('O. database failure rolls back both lead update and activity insert', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001016' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    // Simulate DB failure by dropping the activities table
    await pool.query(`DROP TABLE lead_activities`);
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'should rollback' });
    // Should be 500 error
    assert.ok(res.status === 500 || res.status === 503, `expected DB failure 500 got ${res.status}`);
    // Verify lead was NOT updated (rollback)
    const pgLead: any = await pool.query(`SELECT current_status, notes FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.notEqual(pgLead.rows[0].current_status, 'Contacted');
    // Recreate table for subsequent tests
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
  });

  it('P. concurrent/sequential follow-ups append; previous activity is not lost', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001017' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res1 = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'first' });
    assert.equal(res1.status, 200);
    const res2 = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Interested', remarks: 'second' });
    assert.equal(res2.status, 200);

    const leadRow: any = await pool.query(`SELECT id, status_history FROM leads WHERE lead_code = $1`, [lead.id]);
    const dbId = leadRow.rows[0].id;
    const acts: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at ASC`, [dbId]);
    assert.equal(acts.rows.length, 2);
    assert.equal(acts.rows[0].remarks, 'first');
    assert.equal(acts.rows[1].remarks, 'second');
    // status_history should have both
    const hist = typeof leadRow.rows[0].status_history === 'string' ? JSON.parse(leadRow.rows[0].status_history) : leadRow.rows[0].status_history;
    // At least 2 entries from follow-ups (may have more if other tests)
    const followUps = hist.filter((h: any) => h.remarks === 'first' || h.remarks === 'second');
    assert.equal(followUps.length, 2);
  });

  it('Q. client does not need to send previous history', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001018' });
    // Also add a first follow-up to have history
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'first without history' });
    // Second follow-up without sending any history array (just business fields)
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Interested', remarks: 'second without history' });
    assert.equal(res.status, 200);
    // Should succeed and have 2 activities total
    const leadRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [lead.id]);
    const acts: any = await pool.query(`SELECT count(*)::int AS cnt FROM lead_activities WHERE lead_id = $1`, [leadRow.rows[0].id]);
    assert.equal(acts.rows[0].cnt, 2);
  });

  it('R. GET /api/leads/:id respects visibility', async () => {
    const leadA = await createLeadAs(employeeA, { mobile: '01700001019' });
    const tokenB = signToken({ id: employeeB.id, employeeId: employeeB.employeeId, role: employeeB.role, email: employeeB.email });
    const res = await request(app).get(`/api/leads/${leadA.id}`).set('Authorization', `Bearer ${tokenB}`);
    assert.equal(res.status, 404, `invisible lead should be 404 not ${res.status}`);
    const tokenA = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res2 = await request(app).get(`/api/leads/${leadA.id}`).set('Authorization', `Bearer ${tokenA}`);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.id, leadA.id);
  });

  it('S. GET /api/leads/:id does not return soft-deleted lead', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001020' });
    const tokenAdmin = signToken({ id: adminUser.id, employeeId: adminUser.employeeId, role: adminUser.role, email: adminUser.email });
    await request(app).delete(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
    const tokenA = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenA}`);
    assert.equal(res.status, 404);
    // Also admin should get 404
    const resAdmin = await request(app).get(`/api/leads/${lead.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(resAdmin.status, 404);
  });

  it('T. getLead frontend service no longer fetches full /api/leads list', async () => {
    const filePath = path.join(process.cwd(), 'src/modules/leads/services/leadService.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    // Isolate getLead body: from 'async getLead(' to next 'async ' (or 'async getLeadActivities')
    const getLeadStart = content.indexOf('async getLead(');
    assert.ok(getLeadStart >= 0, 'getLead function not found');
    const nextAsync = content.indexOf('async getLeadActivities', getLeadStart);
    const getLeadBody = nextAsync >= 0 ? content.slice(getLeadStart, nextAsync) : content.slice(getLeadStart, getLeadStart + 5000);
    // It should call /api/leads/${  (single lead)
    assert.ok(getLeadBody.includes("/api/leads/${"), 'getLead should fetch /api/leads/:id');
    // Ensure it does NOT contain the old pattern fetching full list
    const hasFullListFetch = getLeadBody.includes("apiRequest<Lead[]>('/api/leads')") || getLeadBody.includes('apiRequest<Lead[]>("/api/leads")');
    assert.equal(hasFullListFetch, false, 'getLead should not fetch full /api/leads list');
    // Also ensure updateLeadStatus does not construct history arrays or spoofable fields
    const updStart = content.indexOf('async updateLeadStatus(');
    assert.ok(updStart >= 0, 'updateLeadStatus not found');
    const updEnd = content.indexOf('async getLead(', updStart);
    const updateBody = updEnd >= 0 ? content.slice(updStart, updEnd) : content.slice(updStart, updStart + 5000);
    assert.ok(!updateBody.includes('statusHistory'), 'updateLeadStatus must not send statusHistory array');
    assert.ok(!updateBody.includes('assignmentHistory'), 'updateLeadStatus must not send assignmentHistory');
    // changedBy should not be sent as client payload (server derives)
    // Allow changedBy in comments, but not as payload key
    const payloadChangedBy = updateBody.includes("'changedBy'") || updateBody.includes('"changedBy"') || updateBody.includes('changedBy:');
    // The payload should not contain changedBy key; we check that the function does not send it in JSON
    // Instead just verify it doesn't explicitly set changedBy in payload
    assert.ok(!payloadChangedBy || updateBody.includes('changedBy is intentionally'), 'updateLeadStatus must not send changedBy');
    assert.ok(updateBody.includes('/follow-up'), 'updateLeadStatus should call dedicated follow-up endpoint');
  });

  it('U. DB failure never falls back to local write success', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001021' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    // Cause DB failure again by dropping table
    await pool.query(`DROP TABLE lead_activities`);
    const res = await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'db fail local fallback test' });
    assert.ok(res.status >= 500, `expected 500 on DB failure got ${res.status}`);
    assert.equal(res.body.success, false);
    // Verify no success was reported and lead not updated
    const pgLead: any = await pool.query(`SELECT current_status FROM leads WHERE lead_code = $1`, [lead.id]);
    assert.notEqual(pgLead.rows[0].current_status, 'Contacted');
    // Recreate
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
  });

  it('V. legacy imported lead with empty activity history can receive its first NEW LeadFlow activity successfully', async () => {
    // Simulate legacy import: insert lead directly with current_status but no activities
    const leadCode = `legacy_${Date.now()}`;
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by, current_status, status_history, is_deleted) VALUES ($1, $2, $3, $4, $4, $4, $5, '[]'::jsonb, false)`,
      [leadCode, 'Legacy Prospect', '01700001022', employeeA.id, 'Untouched']
    );
    // Verify no activities
    const leadRow: any = await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [leadCode]);
    const beforeActs: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [leadRow.rows[0].id]);
    assert.equal(beforeActs.rows.length, 0);

    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const res = await request(app).post(`/api/leads/${leadCode}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'first new activity after legacy import' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lead.currentStatus, 'Contacted');
    const afterActs: any = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [leadRow.rows[0].id]);
    assert.equal(afterActs.rows.length, 1);
    assert.equal(afterActs.rows[0].remarks, 'first new activity after legacy import');
    // Also GET activities should return it
    const getActs = await request(app).get(`/api/leads/${leadCode}/activities`).set('Authorization', `Bearer ${token}`);
    assert.equal(getActs.status, 200);
    assert.equal(getActs.body.length, 1);
  });

  it('GET /api/leads/:id/activities chronological consistency & empty legacy', async () => {
    const lead = await createLeadAs(employeeA, { mobile: '01700001023' });
    const token = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    // Initially no activities
    const emptyRes = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${token}`);
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.length, 0);

    await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Contacted', remarks: 'act1' });
    await new Promise(r => setTimeout(r, 10));
    await request(app).post(`/api/leads/${lead.id}/follow-up`).set('Authorization', `Bearer ${token}`).send({ status: 'Interested', remarks: 'act2' });

    const actsRes = await request(app).get(`/api/leads/${lead.id}/activities`).set('Authorization', `Bearer ${token}`);
    assert.equal(actsRes.status, 200);
    assert.equal(actsRes.body.length, 2);
    // Most recent first (DESC)
    const first = new Date(actsRes.body[0].createdAt || actsRes.body[0].created_at).getTime();
    const second = new Date(actsRes.body[1].createdAt || actsRes.body[1].created_at).getTime();
    assert.ok(first >= second, 'activities should be reverse chronological');
  });
});
