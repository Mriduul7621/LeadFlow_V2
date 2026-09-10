import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';

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
}

describe('Dashboard metrics — GET /api/dashboard (Step 5)', () => {
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
  let noPermUser: any;

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

    for (const code of [
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
      'dashboard.view',
    ]) {
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

    // User with no dashboard.view and no leads.view
    const bareRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('BARE', 'Bare', 10, 'Own') RETURNING id`);
    const bareRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('BARE1', 'Bare User', 'bare@test.com', 'hashed', $1, $2, true) RETURNING id`, [bareRole.rows[0].id, deptId]);
    noPermUser = { id: bareRes.rows[0].id, employeeId: 'BARE1', email: 'bare@test.com', role: 'BARE' };

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
    status?: string;
    deleted?: boolean;
    nextAt?: string | null;
    projected?: number | null;
    collected?: number | null;
    sumAssured?: number | null;
    area?: string;
    custom?: Record<string, any>;
    createdAt?: string | null;
  }) {
    const custom = {
      ...(opts.custom || { assignedTo: opts.assignedTo }),
      ...(opts.collected != null ? { collectedNCP: opts.collected } : {}),
    };
    await pool.query(
      `INSERT INTO leads (
         lead_code, customer_name, mobile, assigned_to, created_by, updated_by,
         current_status, next_follow_up_at, is_deleted, custom_fields,
         expected_premium, expected_value, area, created_at, follow_up_count
       ) VALUES (
         $1,$2,$3,$4,$4,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,COALESCE($12::timestamp, NOW()),0
       )`,
      [
        opts.code,
        opts.name,
        opts.mobile,
        opts.assignedTo,
        opts.status || 'Untouched',
        opts.nextAt ?? null,
        opts.deleted === true,
        JSON.stringify(custom),
        opts.projected ?? null,
        opts.sumAssured ?? null,
        opts.area || null,
        opts.createdAt ?? null,
      ]
    );
  }

  const bounds = () => getDhakaBusinessDayBounds(new Date());

  it('A. Own user sees only own dashboard lead counts', async () => {
    await insertLead({ code: 'a1', name: 'A1', mobile: '01720000001', assignedTo: employeeA.id, status: 'Untouched', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'a2', name: 'A2', mobile: '01720000002', assignedTo: employeeA.id, status: 'Contacted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'b1', name: 'B1', mobile: '01720000003', assignedTo: employeeB.id, status: 'Converted', custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.totalLeads, 2);
    assert.equal(res.body.data.statusCounts.Untouched, 1);
    assert.equal(res.body.data.statusCounts.Contacted, 1);
    assert.equal(res.body.data.statusCounts.Converted || 0, 0);
  });

  it('B. DownTeam manager sees subordinate metrics', async () => {
    await insertLead({ code: 'sub1', name: 'Sub', mobile: '01720000004', assignedTo: subordinate.id, status: 'Interested', custom: { assignedTo: 'SUBA' } });
    await insertLead({ code: 'b2', name: 'B', mobile: '01720000005', assignedTo: employeeB.id, status: 'Interested', custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(managerUser)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalLeads, 1);
    assert.equal(res.body.data.statusCounts.Interested, 1);
  });

  it('C. Organization user sees organization metrics', async () => {
    await insertLead({ code: 'o1', name: 'O1', mobile: '01720000006', assignedTo: employeeA.id, status: 'Untouched', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'o2', name: 'O2', mobile: '01720000007', assignedTo: employeeB.id, status: 'Converted', custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(adminUser)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalLeads, 2);
  });

  it('D. unrelated user data is excluded', async () => {
    await insertLead({ code: 'sec', name: 'Secret', mobile: '01720000008', assignedTo: employeeA.id, status: 'Pipeline Locked', custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeB)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalLeads, 0);
  });

  it('E. soft-deleted leads are excluded', async () => {
    await insertLead({ code: 'gone', name: 'Gone', mobile: '01720000009', assignedTo: employeeA.id, status: 'Contacted', deleted: true, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'live', name: 'Live', mobile: '01720000010', assignedTo: employeeA.id, status: 'Contacted', custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.totalLeads, 1);
  });

  it('F. terminal statuses counted correctly', async () => {
    await insertLead({ code: 'c1', name: 'C', mobile: '01720000011', assignedTo: employeeA.id, status: 'Converted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'n1', name: 'N', mobile: '01720000012', assignedTo: employeeA.id, status: 'Not Interested', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'p1', name: 'P', mobile: '01720000013', assignedTo: employeeA.id, status: 'Pipeline Locked', custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.statusCounts.Converted, 1);
    assert.equal(res.body.data.statusCounts['Not Interested'], 1);
    assert.equal(res.body.data.statusCounts['Pipeline Locked'], 1);
    assert.equal(res.body.data.converted, 1);
    assert.equal(res.body.data.notInterested, 1);
    assert.equal(res.body.data.activeLeads, 1); // only pipeline locked is active
  });

  it('G. converted count/rate is correct', async () => {
    await insertLead({ code: 'g1', name: 'G1', mobile: '01720000014', assignedTo: employeeA.id, status: 'Converted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'g2', name: 'G2', mobile: '01720000015', assignedTo: employeeA.id, status: 'Untouched', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'g3', name: 'G3', mobile: '01720000016', assignedTo: employeeA.id, status: 'Contacted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'g4', name: 'G4', mobile: '01720000017', assignedTo: employeeA.id, status: 'Converted', custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.converted, 2);
    assert.equal(res.body.data.totalLeads, 4);
    assert.equal(res.body.data.conversionRate, '50.0%');
    assert.equal(res.body.data.conversionRateValue, 50);
  });

  it('H. zero leads gives safe zero conversion rate', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalLeads, 0);
    assert.equal(res.body.data.conversionRate, '0.0%');
    assert.equal(res.body.data.conversionRateValue, 0);
  });

  it('I. overdue count matches Step 4B queue', async () => {
    const b = bounds();
    const overdueAt = new Date(b.todayStart.getTime() - 3600000).toISOString();
    await insertLead({ code: 'ovd', name: 'Ovd', mobile: '01720000018', assignedTo: employeeA.id, status: 'Interested', nextAt: overdueAt, custom: { assignedTo: 'EMPA' } });
    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    const queue = await request(app).get('/api/leads/follow-ups?bucket=overdue').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(dash.body.data.followUpCounts.overdue, queue.body.data.counts.overdue);
    assert.equal(dash.body.data.followUpCounts.overdue, 1);
  });

  it('J. today count matches Step 4B queue', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 5 * 3600000).toISOString();
    await insertLead({ code: 'tdy', name: 'Tdy', mobile: '01720000019', assignedTo: employeeA.id, status: 'Follow-up Set', nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    const queue = await request(app).get('/api/leads/follow-ups?bucket=today').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(dash.body.data.followUpCounts.today, queue.body.data.counts.today);
    assert.equal(dash.body.data.followUpCounts.today, 1);
  });

  it('K. upcoming count matches Step 4B queue', async () => {
    const b = bounds();
    const upcomingAt = new Date(b.tomorrowStart.getTime() + 3600000).toISOString();
    await insertLead({ code: 'upc', name: 'Upc', mobile: '01720000020', assignedTo: employeeA.id, status: 'Interested', nextAt: upcomingAt, custom: { assignedTo: 'EMPA' } });
    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    const queue = await request(app).get('/api/leads/follow-ups?bucket=upcoming').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(dash.body.data.followUpCounts.upcoming, queue.body.data.counts.upcoming);
    assert.equal(dash.body.data.followUpCounts.upcoming, 1);
  });

  it('L. Asia/Dhaka day boundaries remain correct', async () => {
    const b = bounds();
    const justAfterDhakaMidnight = new Date(b.todayStart.getTime() + 30 * 60000).toISOString();
    await insertLead({
      code: 'tz',
      name: 'TZ',
      mobile: '01720000021',
      assignedTo: employeeA.id,
      status: 'Busy',
      nextAt: justAfterDhakaMidnight,
      custom: { assignedTo: 'EMPA' },
    });
    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(dash.body.data.timezone, 'Asia/Dhaka');
    assert.equal(dash.body.data.followUpCounts.today, 1);
    assert.equal(dash.body.data.followUpCounts.overdue, 0);
    const queue = await request(app).get('/api/leads/follow-ups?bucket=today').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(queue.body.data.counts.today, dash.body.data.followUpCounts.today);
  });

  it('M. status breakdown equals actual visible rows', async () => {
    await insertLead({ code: 'm1', name: 'M1', mobile: '01720000022', assignedTo: employeeA.id, status: 'Untouched', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'm2', name: 'M2', mobile: '01720000023', assignedTo: employeeA.id, status: 'Contacted', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'm3', name: 'M3', mobile: '01720000024', assignedTo: employeeA.id, status: 'Interested', custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'm4', name: 'M4', mobile: '01720000025', assignedTo: employeeB.id, status: 'Interested', custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    const sc = res.body.data.statusCounts;
    const sum =
      (sc.Untouched || 0) +
      (sc.Contacted || 0) +
      (sc.Interested || 0) +
      (sc['No Response'] || 0) +
      (sc.Busy || 0) +
      (sc['Follow-up Set'] || 0) +
      (sc['Meeting Fixed'] || 0) +
      (sc['Meeting Completed'] || 0) +
      (sc['Pipeline Locked'] || 0) +
      (sc.Converted || 0) +
      (sc['Not Interested'] || 0);
    assert.equal(sum, res.body.data.totalLeads);
    assert.equal(sc.Untouched, 1);
    assert.equal(sc.Contacted, 1);
    assert.equal(sc.Interested, 1);
  });

  it('N. projected NCP aggregation is correct where supported', async () => {
    await insertLead({ code: 'p_a', name: 'PA', mobile: '01720000026', assignedTo: employeeA.id, status: 'Pipeline Locked', projected: 1000, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'p_b', name: 'PB', mobile: '01720000027', assignedTo: employeeA.id, status: 'Pipeline Locked', projected: 2500, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'p_c', name: 'PC', mobile: '01720000028', assignedTo: employeeB.id, status: 'Pipeline Locked', projected: 9999, custom: { assignedTo: 'EMPB' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.projected, 3500);
  });

  it('O. collected NCP aggregation is correct where supported', async () => {
    await insertLead({ code: 'c_a', name: 'CA', mobile: '01720000029', assignedTo: employeeA.id, status: 'Converted', collected: 400, custom: { assignedTo: 'EMPA', collectedNCP: 400 } });
    await insertLead({ code: 'c_b', name: 'CB', mobile: '01720000030', assignedTo: employeeA.id, status: 'Converted', collected: 600, custom: { assignedTo: 'EMPA', collectedNCP: 600 } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.collected, 1000);
  });

  it('P. sum assured aggregation is correct where supported', async () => {
    await insertLead({ code: 's_a', name: 'SA', mobile: '01720000031', assignedTo: employeeA.id, status: 'Pipeline Locked', sumAssured: 50000, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 's_b', name: 'SB', mobile: '01720000032', assignedTo: employeeA.id, status: 'Converted', sumAssured: 25000, custom: { assignedTo: 'EMPA' } });
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.body.data.sumAssured, 75000);
  });

  it('Q. forged role/employee/assignedTo params cannot widen dashboard', async () => {
    await insertLead({ code: 'forge', name: 'Forge', mobile: '01720000033', assignedTo: employeeA.id, status: 'Untouched', custom: { assignedTo: 'EMPA' } });
    const res = await request(app)
      .get('/api/dashboard?role=ADMIN&employeeId=EMPA&assignedTo=EMPA')
      .set('Authorization', `Bearer ${token(employeeB)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totalLeads, 0);
  });

  it('R. missing dashboard/view permission fails closed', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(noPermUser)}`);
    assert.equal(res.status, 403);
    const noAuth = await request(app).get('/api/dashboard');
    assert.equal(noAuth.status, 401);
  });

  it('S. dashboard client uses /api/dashboard', async () => {
    const svc = fs.readFileSync(path.join(process.cwd(), 'src/modules/dashboard/services/dashboardService.ts'), 'utf-8');
    assert.ok(svc.includes('/api/dashboard'));
    assert.ok(svc.includes('getDashboard'));
    assert.ok(!svc.includes('localStorage'));
    assert.ok(!svc.includes('localDb'));
    assert.ok(!svc.includes('getLeads'));
  });

  it('T. dashboard client/page does not derive authoritative totals from localStorage/localDb/getLeads()', async () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/modules/dashboard/pages/Dashboard.tsx'), 'utf-8');
    assert.ok(page.includes('dashboardService.getDashboard'));
    assert.ok(page.includes('Authoritative metrics from GET /api/dashboard') || page.includes('getDashboard'));
    // loadDashboardData must call dashboardService, not compute from getLeads first
    const loadStart = page.indexOf('const loadDashboardData');
    const loadEnd = page.indexOf('const formattedDateRange');
    const loadBody = page.slice(loadStart, loadEnd);
    assert.ok(loadBody.includes('dashboardService.getDashboard'));
    // Must not use getLeads for stats calculation
    assert.ok(!loadBody.includes('filteredLeads.filter'));
    assert.ok(!loadBody.includes('localStorage'));
    assert.ok(!loadBody.includes('localDb'));
  });

  it('terminal statuses do not pollute follow-up queue counts', async () => {
    const b = bounds();
    const todayAt = new Date(b.todayStart.getTime() + 2 * 3600000).toISOString();
    await insertLead({ code: 'term_c', name: 'TC', mobile: '01720000034', assignedTo: employeeA.id, status: 'Converted', nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'term_n', name: 'TN', mobile: '01720000035', assignedTo: employeeA.id, status: 'Not Interested', nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    await insertLead({ code: 'term_i', name: 'TI', mobile: '01720000036', assignedTo: employeeA.id, status: 'Interested', nextAt: todayAt, custom: { assignedTo: 'EMPA' } });
    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token(employeeA)}`);
    const queue = await request(app).get('/api/leads/follow-ups?bucket=all').set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(dash.body.data.followUpCounts.today, queue.body.data.counts.today);
    assert.equal(dash.body.data.followUpCounts.all, queue.body.data.counts.all);
    assert.equal(dash.body.data.followUpCounts.all, 1);
  });
});
