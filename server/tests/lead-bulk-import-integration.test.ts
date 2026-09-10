import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

/**
 * Bulk Lead Import — Real PostgreSQL (PGlite) integration tests.
 *
 * Covers the hardened POST /api/leads/bulk contract for the real
 * historical/current-state lead spreadsheet:
 *  - exact real headers accepted (incl. "Assigned To")
 *  - authoritative assignee resolution (active users only)
 *  - status/date/remarks preservation (never silently "Untouched")
 *  - deterministic duplicate handling (phone primary, email secondary)
 *  - server-side audit actor (spoof-proof)
 *  - transaction commits / failure never fakes success
 *  - authentication + existing visibility & single-lead behavior intact
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
}

/** The exact real spreadsheet row from the business (Ranjon Tng example). */
function realSheetRow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    'Assigned Date': '23-Apr-2026',
    'Lead Date': '22-Apr-2026',
    'Name': 'Ranjon Tng',
    'Phone': '8801557586634',
    'E-mail': 'ranjanchakama@gmail.com',
    'Area': 'CTG',
    'Interested amount of investment': 500000,
    'Source': 'Social media',
    'Product': 'SCEP',
    'Other Info': 'Prefers evening calls',
    'Campaign Name': "Child Education April`26",
    'Assigned To': 'Monsoor_CTG',
    'Previously Assigned': '',
    'TAT': 1,
    '1st Call date': '23-Apr-2026',
    'Initial Status': 'No response',
    'Initial Remarks': 'First call no answer',
    'Follow up date': '29-Apr-2026',
    'Follow up': 'Interested',
    'Final Remarks': 'The customer is currently busy as he works in a factory. He asked to be called at 8 PM.',
    ...overrides,
  };
}

describe('Bulk Lead Import - Real PostgreSQL Integration', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId: string;
  let employeeRoleId: string;

  let adminUser: any;
  let monsoor: any;
  let inactiveUser: any;
  let employeeA: any;

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    const db = await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM options`);
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

    const employeeRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    employeeRoleId = (employeeRoleRes.rows[0] as any).id;

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = (res.rows[0] as any).id;
    }
    for (const roleId of [adminRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: (adminRes.rows[0] as any).id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };

    const monsoorRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('Monsoor_CTG', 'Monsoor CTG', 'monsoor@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    monsoor = { id: (monsoorRes.rows[0] as any).id, employeeId: 'Monsoor_CTG', email: 'monsoor@test.com', role: 'EMPLOYEE' };

    const inactiveRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('GONE_EMP', 'Gone Employee', 'gone@test.com', 'hashed', $1, $2, FALSE) RETURNING id`, [employeeRoleId, deptId]);
    inactiveUser = { id: (inactiveRes.rows[0] as any).id, employeeId: 'GONE_EMP', email: 'gone@test.com', role: 'EMPLOYEE' };

    const empARes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('EMPA', 'User A', 'usera@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    employeeA = { id: (empARes.rows[0] as any).id, employeeId: 'EMPA', email: 'usera@test.com', role: 'EMPLOYEE' };

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
    await pool.query(`DELETE FROM options`);
    // Canonical status dictionary (as the metadata engine would seed it)
    const statuses = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, TRUE)`,
        [statuses[i], i + 1]
      );
    }
  });

  const adminToken = () => signToken({ id: adminUser.id, employeeId: adminUser.employeeId, role: adminUser.role, email: adminUser.email });

  async function importRows(rows: any[], token?: string) {
    return request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${token || adminToken()}`)
      .send({ leads: rows });
  }

  async function leadByMobile(mobile: string) {
    const res: any = await pool.query(`SELECT * FROM leads WHERE mobile = $1 AND is_deleted = FALSE`, [mobile]);
    return res.rows[0] || null;
  }

  it('A. Exact real spreadsheet headers are accepted', async () => {
    const res = await importRows([realSheetRow()]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.total, 1);
    assert.equal(data.inserted, 1, JSON.stringify(data.errors));
    assert.equal(data.failed, 0);
    const row = await leadByMobile('8801557586634');
    assert.ok(row, 'lead row must exist in PostgreSQL');
    assert.equal(row.customer_name, 'Ranjon Tng');
  });

  it('B. Assigned To resolves to the correct authoritative user', async () => {
    const res = await importRows([realSheetRow()]);
    assert.equal(res.status, 200);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.assigned_to, monsoor.id, 'assigned_to must be the resolved users.id of Monsoor_CTG');
    assert.equal(row.custom_fields.assignedTo, 'Monsoor_CTG');
    assert.equal(row.assigned_by, adminUser.id, 'assigned_by is the authenticated importer');
  });

  it('C. Unknown Assigned To produces a row-level error and no fake assignment', async () => {
    const res = await importRows([realSheetRow({ 'Assigned To': 'Ghost_User_404' })]);
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.inserted, 0);
    assert.equal(data.failed, 1);
    assert.match(data.errors[0].message, /Ghost_User_404/);
    assert.match(data.errors[0].message, /Assigned To/);
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0, 'no lead may be created for an unresolvable assignee');
  });

  it('C2. Inactive user as Assigned To is rejected (active users only)', async () => {
    const res = await importRows([realSheetRow({ 'Assigned To': 'GONE_EMP' })]);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.failed, 1);
    assert.match(res.body.data.errors[0].message, /active user/);
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0);
  });

  it('C3. Blank Assigned To leaves the lead unassigned (no fake self-assignment)', async () => {
    const res = await importRows([realSheetRow({ 'Assigned To': '' })]);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.inserted, 1);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.assigned_to, null, 'blank spreadsheet assignment stays unassigned');
  });

  it('D. Initial Status is preserved and NOT replaced by Untouched', async () => {
    const res = await importRows([realSheetRow({ 'Follow up': '', 'Follow up date': '' })]);
    assert.equal(res.status, 200);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.current_status, 'No Response', 'Initial Status must win when no Follow up exists (case-insensitive match)');
    assert.equal(row.custom_fields.initialStatus, 'No Response');
    assert.notEqual(row.current_status, 'Untouched');
  });

  it('E. Follow up value is preserved according to the existing status model', async () => {
    const res = await importRows([realSheetRow()]);
    assert.equal(res.status, 200);
    const row = await leadByMobile('8801557586634');
    // "Follow up" is the latest known state -> current_status
    assert.equal(row.current_status, 'Interested');
    // Initial status is still preserved alongside
    assert.equal(row.custom_fields.initialStatus, 'No Response');
    assert.equal(row.custom_fields.followUpStatus, 'Interested');
    assert.ok(Array.isArray(row.status_history) && row.status_history.length === 0, 'no fabricated history events');
  });

  it('E2. Unknown status is a row-level error, not a silent Untouched', async () => {
    const res = await importRows([realSheetRow({ 'Initial Status': 'Totally Made Up Status' })]);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.failed, 1);
    assert.match(res.body.data.errors[0].message, /Totally Made Up Status/);
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0);
  });

  it('F. Follow up date is preserved', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.ok(row.next_follow_up_at instanceof Date);
    assert.equal(row.next_follow_up_at.toISOString().slice(0, 10), '2026-04-29');
  });

  it('G. Initial Remarks are preserved', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.custom_fields.initialRemarks, 'First call no answer');
  });

  it('H. Final Remarks are preserved (notes column)', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.notes, 'The customer is currently busy as he works in a factory. He asked to be called at 8 PM.');
  });

  it('I. Other Info is preserved', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.custom_fields.otherInfo, 'Prefers evening calls');
  });

  it('J. 1st Call date is preserved', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.ok(row.last_contacted_at instanceof Date);
    assert.equal(row.last_contacted_at.toISOString().slice(0, 10), '2026-04-23');
  });

  it('K. Assigned Date and Lead Date are preserved (historical, not now)', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.ok(row.assigned_at instanceof Date);
    assert.equal(row.assigned_at.toISOString().slice(0, 10), '2026-04-23');
    assert.ok(row.created_at instanceof Date);
    assert.equal(row.created_at.toISOString().slice(0, 10), '2026-04-22', 'Lead Date must become created_at, not import time');
    const now = new Date();
    assert.ok(now.getTime() - row.created_at.getTime() > 24 * 3600 * 1000, 'created_at must not be the current timestamp');
  });

  it('L. Interested amount of investment is preserved (expected_premium)', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.equal(Number(row.expected_premium), 500000);
  });

  it('M. TAT is preserved', async () => {
    await importRows([realSheetRow()]);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.custom_fields.tat, 1);
  });

  it('N. Previously Assigned is preserved where supported', async () => {
    // Resolvable -> previous_assigned_to FK + text preserved
    const res = await importRows([realSheetRow({ 'Previously Assigned': 'Monsoor_CTG' })]);
    assert.equal(res.status, 200);
    let row = await leadByMobile('8801557586634');
    assert.equal(row.previous_assigned_to, monsoor.id);
    assert.equal(row.custom_fields.previouslyAssigned, 'Monsoor_CTG');

    // Unresolvable -> row still imports, text preserved with a warning
    await pool.query(`DELETE FROM leads`);
    const res2 = await importRows([realSheetRow({ 'Previously Assigned': 'Left The Company' })]);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.data.inserted, 1);
    row = await leadByMobile('8801557586634');
    assert.equal(row.custom_fields.previouslyAssigned, 'Left The Company');
    assert.equal(row.previous_assigned_to, null);
  });

  it('O. Server-side authenticated actor is used for audit fields; spoofing cannot override', async () => {
    const res = await importRows([
      realSheetRow({
        'Assigned To': 'Monsoor_CTG',
        createdBy: 'HACKER',
        updatedBy: 'HACKER',
        assignedBy: 'HACKER',
        changedBy: 'HACKER',
        actor: 'HACKER',
        userId: adminUser.id, // try to impersonate via id field too
      }),
    ]);
    assert.equal(res.status, 200);
    const row = await leadByMobile('8801557586634');
    assert.equal(row.created_by, adminUser.id, 'created_by must be the authenticated caller');
    assert.equal(row.updated_by, adminUser.id, 'updated_by must be the authenticated caller');
    assert.equal(row.assigned_by, adminUser.id, 'assigned_by must be the authenticated caller');
    assert.equal(row.custom_fields.createdBy, undefined, 'spoofed actor fields must never reach custom_fields');
    assert.equal(row.custom_fields.assignedBy, 'ADMIN1');
  });

  it('P. Duplicate handling is deterministic (phone primary, email secondary)', async () => {
    // 1. First import inserts
    const first = await importRows([realSheetRow()]);
    assert.equal(first.body.data.inserted, 1);

    // 2. Re-import same phone with changed data -> deterministic UPDATE, not a second lead
    const second = await importRows([realSheetRow({ 'Final Remarks': 'Updated after second call' })]);
    const d2 = second.body.data;
    assert.equal(d2.inserted, 0, JSON.stringify(d2));
    assert.equal(d2.updated, 1, 'existing phone must update, not duplicate');
    assert.equal(d2.failed, 0);
    let count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 1);
    let row = await leadByMobile('8801557586634');
    assert.equal(row.notes, 'Updated after second call');
    assert.equal(row.current_status, 'Interested', 'status preserved on update');

    // 3. Blank cells on update must NOT wipe existing data (preserve-on-blank)
    const third = await importRows([realSheetRow({ 'E-mail': '', 'Final Remarks': '' })]);
    assert.equal(third.body.data.updated, 1);
    row = await leadByMobile('8801557586634');
    assert.equal(row.email, 'ranjanchakama@gmail.com', 'blank email must not erase existing email');
    assert.equal(row.notes, 'Updated after second call', 'blank remarks must not erase existing notes');

    // 4. Exact duplicate within the same upload -> skipped, reported
    await pool.query(`DELETE FROM leads`);
    const fourth = await importRows([realSheetRow(), realSheetRow()]);
    const d4 = fourth.body.data;
    assert.equal(d4.inserted, 1);
    assert.equal(d4.skipped, 1);
    assert.equal(d4.updated, 0);
    assert.equal(d4.failed, 0);
    count = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 1);

    // 5. Email as additional candidate: existing lead matched by email when phone differs
    await pool.query(`DELETE FROM leads`);
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, email, current_status) VALUES ('seed_email_case', 'Email Seed', '01998877766', 'ranjanchakama@gmail.com', 'Contacted')`
    );
    const fifth = await importRows([realSheetRow()]);
    const d5 = fifth.body.data;
    assert.equal(d5.updated, 1, JSON.stringify(d5));
    assert.equal(d5.inserted, 0);
    count = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 1, 'email candidate updates the existing lead instead of duplicating');

    // 6. Ambiguous: two existing leads share the same phone -> row error, no overwrite
    await pool.query(`DELETE FROM leads`);
    await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile) VALUES ('amb_1', 'Amb One', '01557586634')`);
    await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile) VALUES ('amb_2', 'Amb Two', '8801557586634')`);
    const sixth = await importRows([realSheetRow()]);
    assert.equal(sixth.body.data.failed, 1);
    assert.match(sixth.body.data.errors[0].message, /ambiguous/i);
    count = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 2, 'nothing overwritten on ambiguity');
  });

  it('Q. Invalid rows are reported with useful row-level errors', async () => {
    const res = await importRows([
      realSheetRow({ 'Name': '' }),
      realSheetRow({ 'Phone': '' }),
      realSheetRow({ 'E-mail': 'not-an-email' }),
      realSheetRow({ 'Assigned Date': 'sometime next week' }),
      realSheetRow({ 'Initial Status': 'Not A Real Status' }),
    ]);
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.total, 5);
    assert.equal(data.failed, 5);
    assert.equal(data.inserted, 0);
    const messages = data.errors.map((e: any) => e.message).join(' | ');
    assert.match(messages, /Name is required/);
    assert.match(messages, /Phone is required/);
    assert.match(messages, /not a valid email/);
    assert.match(messages, /not a recognizable date/);
    assert.match(messages, /not a valid status/);
    for (const err of data.errors) {
      assert.equal(typeof err.index, 'number');
      assert.ok(err.message.length > 5);
    }
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0);
  });

  it('R. Actual PostgreSQL transaction commits imported data', async () => {
    const rows = [
      realSheetRow(),
      realSheetRow({ 'Name': 'Lead Two', 'Phone': '01711122233', 'E-mail': 'two@test.com', 'Assigned To': 'EMPA' }),
      realSheetRow({ 'Name': 'Lead Three', 'Phone': '88017144455566'.slice(0, 13), 'E-mail': '', 'Campaign Name': 'Brand New Campaign X' }),
    ];
    const res = await importRows(rows);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.inserted, 3, JSON.stringify(data.errors));
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 3);
    // Campaign auto-registration happened deterministically, once
    const camps: any = await pool.query(`SELECT * FROM options WHERE field_key = 'Campaign'`);
    const campNames = camps.rows.map((r: any) => r.option_value).sort();
    assert.ok(campNames.includes("Child Education April`26"));
    assert.ok(campNames.includes('Brand New Campaign X'));
    assert.equal(campNames.length, 2);

    // Re-import: campaign must NOT be duplicated
    await importRows(rows);
    const camps2: any = await pool.query(`SELECT COUNT(*)::int AS c FROM options WHERE field_key = 'Campaign'`);
    assert.equal(camps2.rows[0].c, 2, 'no duplicate campaign records on re-import');
  });

  it('S. Database failure cannot result in local/fake success', async () => {
    // Reads (auth/permission/visibility/lookup) keep working, but every
    // WRITE (BEGIN/INSERT/UPDATE/COMMIT) fails - simulating a DB failure
    // mid-import. The endpoint must report failure and write nothing.
    const WRITE_RE = /BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|INSERT\s+INTO|UPDATE\s+/i;
    const failing = (inner: any) => async (sql: string, params?: any[]) => {
      if (WRITE_RE.test(sql)) throw new Error('Simulated write failure');
      return inner(sql, params);
    };
    const brokenPool = {
      query: failing((sql: string, params?: any[]) => pool.query(sql, params)),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: failing((sql: string, params?: any[]) => client.query(sql, params)),
          release: () => client.release(),
        };
      },
    };
    const { _setTestPoolForTest } = await import('../database/connection.js');
    _setTestPoolForTest(brokenPool as any);
    try {
      const res = await importRows([realSheetRow()]);
      assert.equal(res.status, 500);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /failed|Simulated/i);
      assert.equal(res.body.data.inserted, 0);
    } finally {
      _setTestPoolForTest(pool);
    }
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0, 'no data written, nothing reported as imported');
    const camps: any = await pool.query(`SELECT COUNT(*)::int AS c FROM options`);
    assert.equal(camps.rows[0].c, 11, 'status seed rows only - no campaign side effects survived');
  });

  it('T. Endpoint requires authentication', async () => {
    const res = await request(app).post('/api/leads/bulk').send({ leads: [realSheetRow()] });
    assert.equal(res.status, 401);
    const resNoBody = await request(app).post('/api/leads/bulk').set('Authorization', `Bearer ${adminToken()}`).send({ leads: [] });
    assert.equal(resNoBody.status, 400);
  });

  it('U. Existing lead visibility/authorization behavior remains intact (out-of-scope import rejected per row)', async () => {
    // employeeA creates a lead (own scope)
    const tokenA = signToken({ id: employeeA.id, employeeId: employeeA.employeeId, role: employeeA.role, email: employeeA.email });
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokenA}`).send({ customerName: 'A Owned Lead', mobile: '01799999999' });
    assert.equal(createRes.status, 200);
    const leadCode = createRes.body.data.leadCode || createRes.body.data.id;

    // A different employee tries to update it via bulk -> row rejected, PG unchanged
    const tokenB = signToken({ id: monsoor.id, employeeId: monsoor.employeeId, role: monsoor.role, email: monsoor.email });
    const bulkRes = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ leads: [{ id: leadCode, customerName: 'Hacked via bulk', mobile: '01799999999' }] });
    assert.ok(bulkRes.status === 200 || bulkRes.status === 403, `got ${bulkRes.status}`);
    if (bulkRes.status === 200) {
      assert.ok(bulkRes.body.data.failed >= 1);
    }
    const pg: any = await pool.query(`SELECT customer_name FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(pg.rows[0].customer_name, 'A Owned Lead');
  });

  it('V. Existing single-lead create/update behavior remains intact', async () => {
    const token = adminToken();
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`).send({
      customerName: 'Single Create',
      mobile: '01600000001',
      source: 'Test',
      currentStatus: 'Contacted',
    });
    assert.equal(createRes.status, 200);
    const lead = createRes.body.data;
    assert.equal(lead.currentStatus, 'Contacted');
    assert.equal(lead.assignedTo, 'ADMIN1', 'single-lead create still self-assigns to the caller');
    const dbRow: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [lead.leadCode || lead.id]);
    assert.equal(dbRow.rows[0].current_status, 'Contacted');

    // Update by mobile (existing rule) still works and preserves created_at
    const before: any = await pool.query(`SELECT created_at FROM leads WHERE lead_code = $1`, [lead.leadCode || lead.id]);
    const updateRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`).send({
      id: lead.leadCode || lead.id,
      customerName: 'Single Updated',
      mobile: '01600000001',
      currentStatus: 'Interested',
    });
    assert.equal(updateRes.status, 200);
    const after: any = await pool.query(`SELECT created_at, current_status, customer_name FROM leads WHERE lead_code = $1`, [lead.leadCode || lead.id]);
    assert.equal(after.rows[0].customer_name, 'Single Updated');
    assert.equal(after.rows[0].current_status, 'Interested');
    assert.equal(new Date(after.rows[0].created_at).getTime(), new Date(before.rows[0].created_at).getTime(), 'created_at must not change on update');
  });

  it('W. Dry run performs full validation without writing anything', async () => {
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [realSheetRow(), realSheetRow({ 'Assigned To': 'Ghost_User_404' })], dryRun: true });
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.dryRun, true);
    assert.equal(data.total, 2);
    assert.equal(data.inserted, 1, 'dry run reports what WOULD happen');
    assert.equal(data.failed, 1);
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0, 'dry run must not write');
    const camps: any = await pool.query(`SELECT COUNT(*)::int AS c FROM options WHERE field_key = 'Campaign'`);
    assert.equal(camps.rows[0].c, 0, 'dry run must not register campaigns');
  });

  it('X. Legacy API payload shape keeps working (backwards compatible)', async () => {
    const res = await importRows([
      { customerName: 'Legacy Shape', mobileNumber: '01500011122', email: 'legacy@test.com', campaignName: 'Legacy Campaign', assignedTo: 'Monsoor_CTG', currentStatus: 'Busy' },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inserted, 1);
    const row = await leadByMobile('01500011122');
    assert.equal(row.customer_name, 'Legacy Shape');
    assert.equal(row.assigned_to, monsoor.id);
    assert.equal(row.current_status, 'Busy');
    assert.equal(row.custom_fields.campaignName, 'Legacy Campaign');
    const camps: any = await pool.query(`SELECT COUNT(*)::int AS c FROM options WHERE field_key = 'Campaign' AND option_value = 'Legacy Campaign'`);
    assert.equal(camps.rows[0].c, 1);
  });
});
