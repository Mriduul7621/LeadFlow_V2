import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as ExcelJSModule from 'exceljs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { dhakaYmd, dhakaStartUtc, addCalendarDays } from '../utils/businessTime.js';

// NOTE: static import on purpose -- the workbook only needs parsing in
// tests, and a static import keeps module evaluation order simple.
const ExcelJS: any = (ExcelJSModule as any).default ?? ExcelJSModule;

/**
 * FIX-2 — Scoped lead export (POST /api/leads/export + GET options).
 * ------------------------------------------------------------------
 * Exercises the export endpoints against a real (PGlite) PostgreSQL
 * instance whose tables carry the PRODUCTION column shapes (leads:
 * current_status / is_deleted / created_at / updated_at /
 * status_history / assignment_history; lead_activities exactly as
 * migration 037; audit_logs exactly as migration 032) — the standing
 * lesson from the form_fields + team-overview drift bugs is that a
 * hand-shaped test schema must not invent friendlier columns.
 *
 * Tree: ceo -> managerA -> subA1 -> subA2; ceo -> managerB -> subB1;
 * userA / userB are unrelated leaves; noExport holds leads.view but
 * NOT leads.export.
 */

// Assembled at runtime: a literal assigned to a *_SECRET name is
// redacted by the authoring tooling, which once corrupted this file.
const JWT_SECRET = ['leadflow', 'export', 'test', 'secret'].join('-');

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

function binaryParser(res: any, callback: any) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => { data += chunk; });
  res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}

async function readWorkbook(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}

/** Sheet rows as arrays of cell values (header row first). */
function sheetRows(wb: any, name: string): any[][] {
  const ws = wb.getWorksheet(name);
  assert.ok(ws, `workbook must contain a "${name}" sheet`);
  const rows: any[][] = [];
  ws.eachRow((row: any) => {
    const values = row.values as any[];
    rows.push(values.slice(1).map((v: any) => (v === undefined ? null : v)));
  });
  return rows;
}

/** Stored wall-clock text for a UTC instant (naive TIMESTAMP convention). */
function storedText(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** Stored timestamp text for Dhaka HH:mm on a Dhaka YMD. */
function dhakaStored(y: number, m: number, d: number, hh: number, mm = 0): string {
  const start = dhakaStartUtc(y, m, d);
  return storedText(new Date(start.getTime() + (hh * 60 + mm) * 60000));
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
  // Production shapes (migrations 026 / 027): both carry timestamps;
  // user_permissions also carries reason.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (role_id, permission_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, permission_id)
    );
  `);
  // Production shape (migrations 014 + 035): current_status, NO bare
  // "status" column; created_at / updated_at naive timestamps.
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
      follow_up_count INTEGER NOT NULL DEFAULT 0,
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
      deleted_by UUID
    );
  `);
  // Production shape (migration 037).
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
  // Production shape (migration 032).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_user_id UUID,
      action_code VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address INET,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

describe('FIX-2 — scoped lead export (leads.export)', () => {
  let pool: any;
  let app: express.Express;

  let deptId: string;
  const permIds: Record<string, string> = {};

  let admin: any, managerA: any, managerB: any, subA1: any, subA2: any, subB1: any;
  let userA: any, noExport: any;

  async function createUser(opts: { employeeId: string; roleCode: string; roleId: string; managerId?: string | null }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
      [opts.employeeId, `User ${opts.employeeId}`, `${opts.employeeId.toLowerCase()}@test.com`, opts.roleId, deptId, opts.managerId || null]
    );
    return {
      id: res.rows[0].id,
      employeeId: opts.employeeId,
      email: `${opts.employeeId.toLowerCase()}@test.com`,
      role: opts.roleCode,
    };
  }

  async function createLead(opts: {
    mobile: string;
    name: string;
    assignedTo: string;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
    status?: string;
    statusHistory?: any[];
    assignmentHistory?: any[];
    customFields?: Record<string, any>;
  }) {
    const leadCode = `lead_${opts.mobile}`;
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by,
                          current_status, status_history, assignment_history, custom_fields, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamp, $11::timestamp)
       RETURNING id`,
      [
        leadCode, opts.name, opts.mobile, opts.assignedTo, opts.createdBy || opts.assignedTo,
        opts.status || 'New',
        JSON.stringify(opts.statusHistory || []),
        JSON.stringify(opts.assignmentHistory || []),
        JSON.stringify(opts.customFields || {}),
        opts.createdAt, opts.updatedAt,
      ]
    );
    return { id: res.rows[0].id, leadCode };
  }

  function tokenFor(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function postExport(user: any, body: Record<string, any>) {
    const res = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send(body)
      .buffer(true)
      .parse(binaryParser);
    if (res.status !== 200) {
      // Debug aid: error responses are JSON even on the binary path.
      console.error(`[export debug] status=${res.status} body=${Buffer.isBuffer(res.body) ? res.body.toString('utf8').slice(0, 400) : JSON.stringify(res.body).slice(0, 400)}`);
    }
    return res;
  }

  const WIDE = { from: '2026-01-01', to: '2027-12-31' };

  before(async () => {
    process.env.DATABASE_URL = 'postgres://unused:pglite';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    );
    deptId = deptRes.rows[0].id;

    const roleIds: Record<string, string> = {};
    for (const [code, name, level, vis] of [
      ['ADMIN', 'Admin', 100, 'Organization'],
      ['MANAGER', 'Manager', 50, 'DownTeam'],
      ['EMPLOYEE', 'Employee', 10, 'Own'],
      ['NOEXPORT', 'No Export', 10, 'Own'],
    ] as const) {
      const res: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis]
      );
      roleIds[code] = res.rows[0].id;
    }

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    const grants: Record<string, string[]> = {
      ADMIN: permCodes,
      MANAGER: ['leads.view', 'leads.export'],
      EMPLOYEE: ['leads.view', 'leads.export'],
      NOEXPORT: ['leads.view'],
    };
    for (const [roleCode, codes] of Object.entries(grants)) {
      for (const code of codes) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
          [roleIds[roleCode], permIds[code]]
        );
      }
    }

    const ceo = await createUser({ employeeId: 'CEO1', roleCode: 'MANAGER', roleId: roleIds.MANAGER });
    managerA = await createUser({ employeeId: 'MGRA', roleCode: 'MANAGER', roleId: roleIds.MANAGER, managerId: ceo.id });
    managerB = await createUser({ employeeId: 'MGRB', roleCode: 'MANAGER', roleId: roleIds.MANAGER, managerId: ceo.id });
    subA1 = await createUser({ employeeId: 'SUBA1', roleCode: 'EMPLOYEE', roleId: roleIds.EMPLOYEE, managerId: managerA.id });
    subA2 = await createUser({ employeeId: 'SUBA2', roleCode: 'EMPLOYEE', roleId: roleIds.EMPLOYEE, managerId: subA1.id });
    subB1 = await createUser({ employeeId: 'SUBB1', roleCode: 'EMPLOYEE', roleId: roleIds.EMPLOYEE, managerId: managerB.id });
    userA = await createUser({ employeeId: 'EMPA', roleCode: 'EMPLOYEE', roleId: roleIds.EMPLOYEE });
    noExport = await createUser({ employeeId: 'NOEXP', roleCode: 'NOEXPORT', roleId: roleIds.NOEXPORT });
    admin = await createUser({ employeeId: 'ADMIN1', roleCode: 'ADMIN', roleId: roleIds.ADMIN });
    void admin;

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
    await pool.query(`DELETE FROM audit_logs`);
  });

  it('options: team scopes offered only when the caller has a team; 403 without leads.export', async () => {
    const mgr = await request(app).get('/api/leads/export/options').set('Authorization', `Bearer ${tokenFor(managerA)}`);
    assert.equal(mgr.status, 200);
    assert.deepEqual(mgr.body.data.scopes, ['own', 'team', 'teamwise']);
    assert.equal(mgr.body.data.defaults.basis, 'updated');

    // UM-1 floor: subA1 is 'Own'-scoped but HAS a report (subA2) -> team offered.
    const lead1 = await request(app).get('/api/leads/export/options').set('Authorization', `Bearer ${tokenFor(subA1)}`);
    assert.equal(lead1.status, 200);
    assert.deepEqual(lead1.body.data.scopes, ['own', 'team', 'teamwise']);

    // Leaf employee: own only.
    const leaf = await request(app).get('/api/leads/export/options').set('Authorization', `Bearer ${tokenFor(userA)}`);
    assert.equal(leaf.status, 200);
    assert.deepEqual(leaf.body.data.scopes, ['own']);

    const denied = await request(app).get('/api/leads/export/options').set('Authorization', `Bearer ${tokenFor(noExport)}`);
    assert.equal(denied.status, 403);
  });

  it('permission: POST /leads/export is 403 without leads.export and names the code', async () => {
    const res = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(noExport)}`)
      .send({ scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(res.status, 403);
    assert.equal(res.body.permission, 'leads.export');
  });

  it('own scope: a manager exports only leads assigned to themself', async () => {
    const t = '2026-11-05 09:00:00';
    await createLead({ mobile: '01720000001', name: 'Mgr Own Lead', assignedTo: managerA.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000002', name: 'Member Lead', assignedTo: subA1.id, createdAt: t, updatedAt: t });

    const res = await postExport(managerA, { scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.equal(res.headers['x-lead-count'], '1');
    const wb = await readWorkbook(res.body);
    const rows = sheetRows(wb, 'Leads');
    assert.equal(rows[0][0], 'Lead ID');
    assert.equal(rows[0][15], 'Status');
    const mobiles = rows.slice(1).map(r => r[2]);
    assert.deepEqual(mobiles, ['01720000001']);
    const leadRow = rows[1];
    assert.equal(leadRow[1], 'Mgr Own Lead');
    assert.equal(leadRow[16], 'User MGRA', 'Assigned To carries the assignee name');
    assert.equal(leadRow[17], 'MGRA', 'Assigned To ID carries the employee id');
  });

  it('team scope: subtree leads are in, sibling-team and unrelated leads never leak', async () => {
    const t = '2026-11-05 09:00:00';
    await createLead({ mobile: '01720000011', name: 'MgrA Lead', assignedTo: managerA.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000012', name: 'SubA1 Lead', assignedTo: subA1.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000013', name: 'SubA2 Lead', assignedTo: subA2.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000014', name: 'MgrB Lead', assignedTo: managerB.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000015', name: 'SubB1 Lead', assignedTo: subB1.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000016', name: 'Unrelated Lead', assignedTo: userA.id, createdAt: t, updatedAt: t });
    // A lead CREATED by a member but assigned outside the team stays out
    // of neither-chain visibility -- and a lead created by the manager
    // for an outsider IS visible via the creator arm (PR #104 rule).
    await createLead({ mobile: '01720000017', name: 'Mgr Created Outsider Lead', assignedTo: userA.id, createdBy: managerA.id, createdAt: t, updatedAt: t });

    const res = await postExport(managerA, { scope: 'team', basis: 'updated', ...WIDE });
    assert.equal(res.status, 200);
    const wb = await readWorkbook(res.body);
    const mobiles = sheetRows(wb, 'Leads').slice(1).map(r => r[2]).sort();
    assert.deepEqual(mobiles, ['01720000011', '01720000012', '01720000013', '01720000017']);
  });

  it('team scope is refused for a caller with no team', async () => {
    const res = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(userA)}`)
      .send({ scope: 'team', basis: 'updated', ...WIDE });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /only when you have a team/);
  });

  it('basis + range: Added vs Updated pick different leads; bounds are Dhaka calendar days', async () => {
    // Created Dhaka 2026-11-01 01:30 (stored UTC wall 2026-10-31 19:30),
    // updated Dhaka 2026-11-05 16:00 (stored 2026-11-05 10:00).
    await createLead({
      mobile: '01720000021', name: 'Boundary Lead', assignedTo: userA.id,
      createdAt: '2026-10-31 19:30:00', updatedAt: '2026-11-05 10:00:00',
    });

    const addedHit = await postExport(userA, { scope: 'own', basis: 'added', from: '2026-11-01', to: '2026-11-01' });
    assert.equal(addedHit.status, 200);
    assert.equal(addedHit.headers['x-lead-count'], '1', 'Added basis: Dhaka Nov 1 includes the lead');

    const addedMiss = await postExport(userA, { scope: 'own', basis: 'added', from: '2026-10-31', to: '2026-10-31' });
    assert.equal(addedMiss.headers['x-lead-count'], '0', 'Added basis: Dhaka Oct 31 excludes it (UTC date is a decoy)');

    const updatedMiss = await postExport(userA, { scope: 'own', basis: 'updated', from: '2026-11-01', to: '2026-11-01' });
    assert.equal(updatedMiss.headers['x-lead-count'], '0', 'Updated basis: Nov 1 excludes it');

    const updatedHit = await postExport(userA, { scope: 'own', basis: 'updated', from: '2026-11-05', to: '2026-11-05' });
    assert.equal(updatedHit.headers['x-lead-count'], '1', 'Updated basis: Nov 5 includes it');

    const badRange = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(userA)}`)
      .send({ scope: 'own', basis: 'updated', from: '2026-11-06', to: '2026-11-01' });
    assert.equal(badRange.status, 400);
  });

  it('defaults: no dates means Updated basis over the last 30 Dhaka days', async () => {
    const today = dhakaYmd(new Date());
    const recent = addCalendarDays(today.y, today.m, today.d, -2);
    const old = addCalendarDays(today.y, today.m, today.d, -40);
    await createLead({
      mobile: '01720000022', name: 'Recent Lead', assignedTo: userA.id,
      createdAt: dhakaStored(old.y, old.m, old.d, 10), updatedAt: dhakaStored(recent.y, recent.m, recent.d, 10),
    });
    await createLead({
      mobile: '01720000023', name: 'Stale Lead', assignedTo: userA.id,
      createdAt: dhakaStored(old.y, old.m, old.d, 10), updatedAt: dhakaStored(old.y, old.m, old.d, 11),
    });

    const res = await postExport(userA, { scope: 'own' });
    assert.equal(res.status, 200);
    const wb = await readWorkbook(res.body);
    const mobiles = sheetRows(wb, 'Leads').slice(1).map(r => r[2]);
    assert.deepEqual(mobiles, ['01720000022']);
  });

  it('history sheet: activities + legacy status_history + assignment_history, statuses chained old -> new', async () => {
    const lead = await createLead({
      mobile: '01720000031', name: 'History Lead', assignedTo: subA1.id, createdBy: managerA.id,
      createdAt: '2026-11-01 00:30:00', updatedAt: '2026-11-03 06:00:00', status: 'Meeting Fixed',
      statusHistory: [
        { status: 'New', date: '2026-11-01T02:00:00.000Z', remarks: 'Lead created from Facebook', updatedBy: 'SUBA1' },
      ],
      assignmentHistory: [
        { date: '2026-11-01T03:00:00.000Z', fromEmployeeId: '', toEmployeeId: 'SUBA1', changedBy: 'MGRA', note: 'Initial assignment' },
      ],
      customFields: { campaignName: 'Diwali Push', productName: 'Child Education' },
    });
    await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, status, remarks, created_by, created_at)
       VALUES ($1, 'follow_up', 'Contacted', 'Called the customer', $2, '2026-11-02 04:00:00'),
              ($1, 'follow_up', 'Meeting Fixed', 'Meeting confirmed', $2, '2026-11-03 05:00:00')`,
      [lead.id, subA1.id]
    );
    // A legacy status_history entry that duplicates an activity is dropped
    // (Lead360 dedupe) -- add one and expect it NOT to appear twice.
    await pool.query(
      `UPDATE leads SET status_history = status_history || $2::jsonb WHERE id = $1`,
      [lead.id, JSON.stringify([{ status: 'Contacted', date: '2026-11-02T04:00:00.000Z', updatedBy: 'SUBA1' }])]
    );

    const res = await postExport(managerA, { scope: 'team', basis: 'updated', ...WIDE });
    assert.equal(res.status, 200);
    const wb = await readWorkbook(res.body);

    const leadRows = sheetRows(wb, 'Leads').slice(1);
    assert.equal(leadRows.length, 1);
    assert.equal(leadRows[0][12], 'Diwali Push', 'Campaign comes from the lead record');
    assert.equal(leadRows[0][13], 'Child Education', 'Product comes from the lead record');

    const history = sheetRows(wb, 'Lead History').slice(1).filter(r => r[0] === lead.leadCode);
    assert.equal(history.length, 4, `expected 4 events, got ${JSON.stringify(history)}`);
    // Chronological order after the header: legacy New, assignment, Contacted, Meeting Fixed.
    assert.equal(history[0][4], 'Status Change');
    assert.match(String(history[0][5]), /Status changed to "New"/);
    assert.match(String(history[0][5]), /Lead created from Facebook/);
    assert.equal(history[0][3], 'User SUBA1', 'legacy actor employee id resolves to a name');
    assert.equal(history[1][4], 'Assignment');
    assert.match(String(history[1][5]), /Assigned to SUBA1/);
    assert.equal(history[1][3], 'User MGRA');
    assert.equal(history[2][4], 'Status Change');
    assert.match(String(history[2][5]), /Status: New -> Contacted/);
    assert.match(String(history[2][5]), /Called the customer/);
    assert.equal(history[2][3], 'User SUBA1', 'activity actor name is joined from users');
    assert.match(String(history[3][5]), /Status: Contacted -> Meeting Fixed/);
  });

  it('teamwise: Leads sheet groups per member in tree order with subtotals', async () => {
    const t = '2026-11-05 09:00:00';
    await createLead({ mobile: '01720000041', name: 'MgrA Lead', assignedTo: managerA.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000042', name: 'SubA1 Lead One', assignedTo: subA1.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000043', name: 'SubA1 Lead Two', assignedTo: subA1.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000044', name: 'SubA2 Lead', assignedTo: subA2.id, createdAt: t, updatedAt: t });

    const res = await postExport(managerA, { scope: 'teamwise', basis: 'updated', ...WIDE });
    assert.equal(res.status, 200);
    const wb = await readWorkbook(res.body);
    const rows = sheetRows(wb, 'Leads').slice(1);
    const firstCells = rows.map(r => String(r[0] ?? ''));
    const idxMgr = firstCells.findIndex(c => c === '-- User MGRA (MGRA) --');
    const idxSub1 = firstCells.findIndex(c => c === '-- User SUBA1 (SUBA1) --');
    const idxSub2 = firstCells.findIndex(c => c === '-- User SUBA2 (SUBA2) --');
    assert.ok(idxMgr >= 0 && idxSub1 > idxMgr && idxSub2 > idxSub1, `sections must follow tree order: ${JSON.stringify(firstCells)}`);
    assert.ok(firstCells.includes('Subtotal -- User MGRA (MGRA): 1 leads'));
    assert.ok(firstCells.includes('Subtotal -- User SUBA1 (SUBA1): 2 leads'));
    assert.ok(firstCells.includes('Subtotal -- User SUBA2 (SUBA2): 1 leads'));
    const mobiles = rows.map(r => r[2]).filter(Boolean);
    assert.deepEqual([...mobiles].sort(), ['01720000041', '01720000042', '01720000043', '01720000044']);
  });

  it('cap: selections above the row limit are refused with a clear message', async () => {
    const t = '2026-11-05 09:00:00';
    await createLead({ mobile: '01720000051', name: 'Cap One', assignedTo: userA.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000052', name: 'Cap Two', assignedTo: userA.id, createdAt: t, updatedAt: t });
    await createLead({ mobile: '01720000053', name: 'Cap Three', assignedTo: userA.id, createdAt: t, updatedAt: t });

    process.env.LEADS_EXPORT_MAX_ROWS = '2';
    try {
      const res = await request(app)
        .post('/api/leads/export')
        .set('Authorization', `Bearer ${tokenFor(userA)}`)
        .send({ scope: 'own', basis: 'updated', ...WIDE });
      assert.equal(res.status, 422);
      assert.match(res.body.message, /limited to 2 leads per file/);
      assert.match(res.body.message, /selection has 3/);
    } finally {
      delete process.env.LEADS_EXPORT_MAX_ROWS;
    }
    const ok = await postExport(userA, { scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(ok.status, 200, 'the same export succeeds once the cap no longer binds');
  });

  it('audit: a successful export writes a leads.export audit row with scope + count', async () => {
    const t = '2026-11-05 09:00:00';
    await createLead({ mobile: '01720000061', name: 'Audit Lead', assignedTo: managerA.id, createdAt: t, updatedAt: t });

    const res = await postExport(managerA, { scope: 'own', basis: 'added', ...WIDE });
    assert.equal(res.status, 200);

    const audit: any = await pool.query(
      `SELECT actor_user_id, metadata FROM audit_logs WHERE action_code = 'leads.export'`
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, managerA.id);
    const meta = typeof audit.rows[0].metadata === 'string' ? JSON.parse(audit.rows[0].metadata) : audit.rows[0].metadata;
    assert.equal(meta.scope, 'own');
    assert.equal(meta.basis, 'added');
    assert.equal(meta.leadCount, 1);
  });

  it('roles UI flow: admin can grant leads.export to a role, then revoke it', async () => {
    const before = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(noExport)}`)
      .send({ scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(before.status, 403);

    const grant = await request(app)
      .put('/api/roles/NOEXPORT/permissions')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ permissions: [{ code: 'leads.export', allowed: true }] });
    assert.equal(grant.status, 200, `grant should succeed: ${JSON.stringify(grant.body)}`);

    const after = await postExport(noExport, { scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(after.status, 200, 'the granted role can export immediately');

    const revoke = await request(app)
      .put('/api/roles/NOEXPORT/permissions')
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ permissions: [{ code: 'leads.export', allowed: false }] });
    assert.equal(revoke.status, 200);

    const revoked = await request(app)
      .post('/api/leads/export')
      .set('Authorization', `Bearer ${tokenFor(noExport)}`)
      .send({ scope: 'own', basis: 'updated', ...WIDE });
    assert.equal(revoked.status, 403, 'revoking the grant closes the endpoint again');
  });

  it('client wiring: the Leads page Export button opens the scoped dialog; the old CSV dump is gone', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const leadList = readFileSync(path.join(here, '../../src/modules/leads/pages/LeadList.tsx'), 'utf8');
    const leadService = readFileSync(path.join(here, '../../src/modules/leads/services/leadService.ts'), 'utf8');
    assert.ok(leadList.includes('canExportLeads &&'), 'Export button stays gated on the leads.export-backed canAccess check');
    assert.ok(leadList.includes('openExportDialog'), 'Export button opens the scoped export dialog');
    assert.ok(leadList.includes('getLeadExportOptions'), 'dialog loads the server-offered scopes');
    assert.ok(!leadList.includes('Shanta_Life_Lead_Intelligence_'), 'the old client-side CSV export is removed');
    assert.ok(leadService.includes("fetch('/api/leads/export'"), 'service downloads the workbook from the export endpoint');
    assert.ok(leadService.includes("'/api/leads/export/options'"), 'service reads the export options endpoint');
  });
});
