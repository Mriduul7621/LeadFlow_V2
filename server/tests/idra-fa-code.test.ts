import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import ExcelJS from 'exceljs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate064 } from '../database/migrations/064_users_idra_fa_code.js';
import {
  _setPolicyLookupReaderForTest,
  _resetPolicyLookupForTest,
} from '../services/PolicyLookupService.js';
import { isFaMismatch } from '../../src/modules/leads/utils/policyLookupFill.js';
import {
  parseUserImportFile,
  USER_TEMPLATE_HEADERS,
} from '../../src/modules/users/utils/userBulkImport.js';

/**
 * IDRA FA Code (migration 064, Mahadi 2026-11-21) — on PR #181's branch.
 * ------------------------------------------------------------------
 * DSF payroll staff carry TWO identifiers: the HR Employee ID and the
 * IDRA FA Code under which all of their policy sales are booked. Until
 * now LeadFlow stored only the Employee ID, so the conversion policy
 * lookup compared the sheet's FA Code against the assignee's Employee
 * ID and warned on every DSF conversion even when the sale was right.
 *
 *   1. Migration 064 — nullable `idra_fa_code VARCHAR(30)` + unique
 *      index on users; registered as the tail, excluded from legacy
 *      adoption (no sentinel, like 061/062).
 *   2. Login — the FA code is a third login identifier (Employee ID /
 *      email / FA code), same password check, same session.
 *   3. Create/update — POST /users, POST /users/employee and PUT
 *      /users/:id accept an optional `idraFaCode` (trim + uppercase);
 *      duplicates are a friendly 409.
 *   4. Bulk — the FA-code column maps under `Code` or `FA Code`
 *      (client header mapping), the manager column under UM/RM/BM/
 *      ASM/GM/AGM Code; createAndUpdate FILLS the code for existing
 *      users matched by Employee ID, and a blank cell keeps the
 *      stored code.
 *   5. Mismatch — the lookup endpoint resolves the assignee's stored
 *      FA code (assigneeFaCode); the warning compares policy FA code
 *      vs stored FA code, and stays silent when the assignee has
 *      none stored.
 *
 * Fixture note: the users table is created WITHOUT the column and the
 * REAL migration 064 runs against it (twice — idempotency pinned),
 * so the tests below prove the migration itself, not a hand-built
 * post-064 shape.
 */
const JWT_SECRET = ['pl', 'ook', 'up', '-', 'test', '-', 'key', '-', '2026'].join('');

const repoRoot = path.resolve(process.cwd());
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

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

// Node has File but no FileReader (Node 24): the client parser reads
// via FileReader, so the test supplies the smallest possible shim.
class TestFileReader {
  result: ArrayBuffer | null = null;
  onload: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  async readAsArrayBuffer(file: File) {
    try {
      this.result = await file.arrayBuffer();
      this.onload?.({ target: this });
    } catch {
      this.onerror?.({ target: this });
    }
  }
}
(globalThis as any).FileReader = TestFileReader;

async function workbookFile(headers: string[], rows: any[][], name = 'import.xlsx'): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* Due sheet fixture — the service matches by header name, never index. */
const DUE_HEADERS = [
  'Proposal No', 'Sum Assured', 'Policy No', 'Pay Mode', 'Plan Name',
  'FA Code', 'Premium', 'Term', 'Comm. Date', 'Policy Status',
];
const PR_HEADERS = [
  'POLICY NO', 'PR NO', 'PR DATE', 'POLICY OWMER', 'FA Code', 'PR TYPE',
  'TERM', 'PLAN', 'PAYMENT MODE', 'TOTAL PREM.', 'Product Name', 'New Premium',
];
const DUE_ROWS: string[][] = [
  DUE_HEADERS,
  // Policy 3 — sold under DSF001's FA code (the match case).
  ['Pro-4', '1,000,000', '3', 'Yearly', 'S3PP', '1101010116002', '42,000', '20', '2026-01-15', 'Inforce'],
  // Policy 8 — sold under a code nobody in the fixture holds (mismatch).
  ['Pro-9', '500000', '8', 'Half-Yearly', 'S4PP', '1101010116777', '30000', '15', '15-Jan-2026', 'Inforce'],
];
const PR_ROWS: string[][] = [
  ['SLI Retail Sales Dashboard — PR Database'],
  [''],
  PR_HEADERS,
];

function fixtureReader(range: string): Promise<string[][]> {
  if (range.includes('Due and Lapse')) return Promise.resolve(DUE_ROWS);
  if (range.includes('PR Database')) return Promise.resolve(PR_ROWS);
  throw new Error(`unexpected range ${range}`);
}

async function setupSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100) UNIQUE,
      department_name VARCHAR(255) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own',
      is_active BOOLEAN DEFAULT TRUE,
      menu_access JSONB,
      actions JSONB,
      feature_permissions JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_code VARCHAR(30) UNIQUE,
      team_name VARCHAR(150),
      department_id UUID,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  // PRE-064 shape on purpose — migration 064 runs against this below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(30),
      password VARCHAR(255) NOT NULL DEFAULT '',
      role_id UUID,
      department_id UUID,
      team_id UUID,
      manager_id UUID,
      designation VARCHAR(100),
      profile_photo TEXT,
      last_login TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      account_status VARCHAR(30) DEFAULT 'ACTIVE',
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMP,
      password_changed_at TIMESTAMP,
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hierarchies (
      user_id UUID PRIMARY KEY,
      manager_id UUID,
      level INT,
      path JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      module_name VARCHAR(100),
      action_name VARCHAR(100)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, permission_id)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, permission_id)
    );`);
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
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255),
      sort_order INT DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_key, option_value)
    );`);
}

const SEED_EMPLOYEES = ['ADMIN001', 'MGR001', '2026010', '2026011', '2026012', 'EXIST001', 'EXIST002'];

describe('IDRA FA Code (migration 064)', () => {
  let pool: any;
  let app: express.Express;
  let salesDeptId: string;
  let adminRoleId: string;
  let mgrRoleId: string;
  let beRoleId: string;
  let adminUserId: string;
  let mgrUserId: string;
  let dsf1Id: string;
  let dsf2Id: string;
  let nofaId: string;
  let exist1Id: string;
  let exist2Id: string;

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN001', role: 'ADMIN', email: 'admin@test.com' });

  async function validateRows(rows: any[], mode: 'createOnly' | 'createAndUpdate' = 'createOnly') {
    return request(app)
      .post('/api/users/bulk/validate')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ rows, mode, fileName: 'test.xlsx' });
  }

  async function commitRows(rows: any[], mode: 'createOnly' | 'createAndUpdate' = 'createOnly') {
    return request(app)
      .post('/api/users/bulk/commit')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ rows, mode, fileName: 'test.xlsx' });
  }

  function makeUserRow(overrides: any = {}) {
    const empId = overrides.employeeId || 'EMP001';
    const base: any = {
      rowNumber: 1,
      employeeId: empId,
      idraFaCode: '',
      fullName: 'Test User',
      email: `${String(empId).toLowerCase()}@example.com`,
      phone: '01700000001',
      designation: 'Business Executive',
      department: 'Sales',
      role: 'BE',
      reportingManagerEmployeeId: 'MGR001',
      team: '',
      temporaryPassword: '',
      mustChangePassword: 'Yes',
      status: 'Active',
    };
    return { ...base, ...overrides };
  }

  async function faCodeOf(employeeId: string): Promise<string | null> {
    const r: any = await pool.query(
      `SELECT idra_fa_code FROM users WHERE employee_id = $1`,
      [employeeId],
    );
    return r.rows[0]?.idra_fa_code ?? null;
  }

  before(async () => {
    process.env.DATABASE_URL = ['postgres', '://', 'test', ':test', '@localhost', '/test'].join('');
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    // The REAL migration 064 — twice, to pin idempotency.
    await migrate064();
    await migrate064();

    const dept: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`,
    );
    salesDeptId = dept.rows[0].id;

    const mkRole = async (code: string, name: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
        [code, name, level, vis],
      );
      return r.rows[0].id;
    };
    adminRoleId = await mkRole('ADMIN', 'Administrator', 1, 'Organization');
    mgrRoleId = await mkRole('MANAGER', 'Manager', 2, 'FullTeam');
    beRoleId = await mkRole('BE', 'Business Executive', 3, 'Own');

    const permIds: Record<string, string> = {};
    for (const code of ['users.create', 'users.edit', 'users.add_employee', 'leads.view', 'leads.edit']) {
      const res: any = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, 'test', 'test') RETURNING id`,
        [code],
      );
      permIds[code] = res.rows[0].id;
    }
    for (const code of Object.keys(permIds)) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`,
        [adminRoleId, permIds[code]],
      );
    }

    const pwHash = await bcrypt.hash('TestPass123!', 8);
    const mkUser = async (
      emp: string, roleId: string, managerId: string | null,
      faCode: string | null, password: string,
    ) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, idra_fa_code, full_name, email, password, role_id, department_id, manager_id, is_active, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE) RETURNING id`,
        [emp, faCode, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, password, roleId, salesDeptId, managerId],
      );
      return r.rows[0].id;
    };
    adminUserId = await mkUser('ADMIN001', adminRoleId, null, null, 'hashed');
    mgrUserId = await mkUser('MGR001', mgrRoleId, adminUserId, null, 'hashed');
    // DSF001: the live case — Employee ID 2026010, FA code 1101010116002.
    dsf1Id = await mkUser('2026010', beRoleId, mgrUserId, '1101010116002', pwHash);
    // DSF002: mixed-case code, for the case-insensitivity checks.
    dsf2Id = await mkUser('2026011', beRoleId, mgrUserId, 'FA-ABC123', pwHash);
    nofaId = await mkUser('2026012', beRoleId, mgrUserId, null, 'hashed');
    exist1Id = await mkUser('EXIST001', beRoleId, mgrUserId, null, 'hashed');
    exist2Id = await mkUser('EXIST002', beRoleId, mgrUserId, '1101010116888', 'hashed');

    app = await createTestApp();
  });

  after(async () => {
    _resetPolicyLookupForTest();
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM users WHERE employee_id NOT IN (${SEED_EMPLOYEES.map(e => `'${e}'`).join(', ')})`);
    await pool.query(`DELETE FROM audit_logs`);
    // Restore the seeded FA codes (bulk/update tests mutate them).
    await pool.query(`UPDATE users SET idra_fa_code = NULL WHERE employee_id IN ('2026012', 'EXIST001')`);
    await pool.query(`UPDATE users SET idra_fa_code = '1101010116888' WHERE employee_id = 'EXIST002'`);
    await pool.query(`UPDATE users SET idra_fa_code = '1101010116002' WHERE employee_id = '2026010'`);
    await pool.query(`UPDATE users SET idra_fa_code = 'FA-ABC123' WHERE employee_id = '2026011'`);
    await pool.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE employee_id IN ('2026010', '2026011')`);
    _resetPolicyLookupForTest();
  });

  /* ================================================================ */
  /* 1. Migration 064                                                 */
  /* ================================================================ */

  it('064 is registered, after 063, and excluded from legacy adoption (065 is now the tail)', async () => {
    const { MIGRATION_IDS } = await import('../database/runMigrations.js');
    assert.ok(MIGRATION_IDS.includes('064_users_idra_fa_code'), '064 is registered');
    assert.ok(
      MIGRATION_IDS.indexOf('064_users_idra_fa_code') > MIGRATION_IDS.indexOf('063_users_add_employee'),
      '064 runs after 063',
    );
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '065_leads_corporate_client', '065 is the migration tail');
    const runner = read('server/database/runMigrations.ts');
    assert.ok(runner.includes('064_users_idra_fa_code'), 'runner names migration 064');
    assert.ok(
      runner.includes('id !== "064_users_idra_fa_code"'),
      '064 is excluded from the legacy-adoption id list (no sentinel, like 061/062)',
    );
  });

  it('up() added a nullable idra_fa_code column + the unique index', async () => {
    const cols: any = await pool.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'idra_fa_code'`,
    );
    assert.equal(cols.rows.length, 1, 'idra_fa_code exists');
    assert.equal(cols.rows[0].data_type, 'character varying');
    assert.equal(cols.rows[0].character_maximum_length, 30);
    assert.equal(cols.rows[0].is_nullable, 'YES', 'the column is optional (nullable)');
    const idx: any = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_idra_fa_code'`,
    );
    assert.equal(idx.rows.length, 1, 'the unique index exists');
  });

  it('two users may both have NULL; a duplicate code is rejected by the index', async () => {
    // Two NULLs already coexist among the seeds (ADMIN001, MGR001,
    // 2026012, EXIST001) — prove two more NULL inserts succeed too.
    await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
       VALUES ('NULLA01', 'Null A', 'nulla01@test.com', 'hashed', $1, $2)`,
      [beRoleId, salesDeptId],
    );
    await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
       VALUES ('NULLB01', 'Null B', 'nullb01@test.com', 'hashed', $1, $2)`,
      [beRoleId, salesDeptId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO users (employee_id, idra_fa_code, full_name, email, password, role_id, department_id)
         VALUES ('DUPFA01', '1101010116002', 'Dup FA', 'dupfa01@test.com', 'hashed', $1, $2)`,
        [beRoleId, salesDeptId],
      ),
      /duplicate key|unique/i,
      'the unique index must reject a second user with DSF001\'s code',
    );
  });

  it('up() is idempotent — running it again changes nothing', async () => {
    await migrate064();
    assert.equal(await faCodeOf('2026010'), '1101010116002', 'the stored code survives a re-run');
    const cols: any = await pool.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'idra_fa_code'`,
    );
    assert.equal(cols.rows[0].c, 1, 'exactly one idra_fa_code column');
  });

  /* ================================================================ */
  /* 2. Login by FA code                                              */
  /* ================================================================ */

  it('login by FA code succeeds and returns the employee identity', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: '1101010116002', password: 'TestPass123!' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(typeof res.body.token === 'string' && res.body.token.length > 20, 'a token is issued');
    assert.equal(res.body.user.employeeId, '2026010', 'the FA code resolves to DSF001');
    assert.equal(res.body.user.idraFaCode, '1101010116002', 'the session user carries the FA code');
  });

  it('login by FA code is case-insensitive', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'fa-abc123', password: 'TestPass123!' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.employeeId, '2026011');
  });

  it('login by FA code with the wrong password still fails', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: '1101010116002', password: 'WrongPass999!' });
    assert.equal(res.status, 401);
    assert.match(String(res.body.message || ''), /Invalid credentials/);
    assert.equal(res.body.token, undefined, 'no token on a failed login');
  });

  it('login with an unknown FA code fails', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: '1101010199999', password: 'TestPass123!' });
    assert.equal(res.status, 401);
  });

  it('login by Employee ID still works (regression)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: '2026010', password: 'TestPass123!' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.employeeId, '2026010');
  });

  /* ================================================================ */
  /* 3. Create / update                                               */
  /* ================================================================ */

  function createPayload(overrides: any = {}) {
    return {
      fullName: 'New Person',
      employeeId: 'NEW001',
      email: 'new001@test.com',
      role: 'BE',
      departmentId: salesDeptId,
      managerId: 'MGR001',
      status: 'Active',
      ...overrides,
    };
  }

  it('create with a new FA code stores it (trimmed + uppercased)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(createPayload({ idraFaCode: '  fa-xyz789  ' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await faCodeOf('NEW001'), 'FA-XYZ789', 'stored trimmed and uppercased');
  });

  it('create with a duplicate FA code is rejected (409)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(createPayload({ idraFaCode: '1101010116002' }));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body.message || ''), /IDRA FA Code.*already in use/);
  });

  it('create with a duplicate FA code in different case is rejected (409)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(createPayload({ idraFaCode: 'fa-abc123' }));
    assert.equal(res.status, 409, JSON.stringify(res.body));
  });

  it('create with a malformed FA code is rejected (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(createPayload({ idraFaCode: 'bad code!' }));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.message || ''), /IDRA FA Code may only contain/);
  });

  it('create without a FA code stores NULL', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(createPayload());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await faCodeOf('NEW001'), null);
  });

  it('TL employee-add accepts a FA code', async () => {
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Team Person',
        employeeId: 'EMP001',
        email: 'emp001@test.com',
        password: 'TempPass123!',
        mustChangePassword: true,
        idraFaCode: '1101010116555',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await faCodeOf('EMP001'), '1101010116555');
  });

  it('update sets a FA code on a user without one', async () => {
    const res = await request(app)
      .put(`/api/users/${exist1Id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Name EXIST001', employeeId: 'EXIST001', email: 'exist001@test.com',
        role: 'BE', departmentId: salesDeptId, managerId: 'MGR001', status: 'Active',
        idraFaCode: '1101010116111',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await faCodeOf('EXIST001'), '1101010116111');
  });

  it('update with another user\'s FA code is rejected (409)', async () => {
    const res = await request(app)
      .put(`/api/users/${exist1Id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Name EXIST001', employeeId: 'EXIST001', email: 'exist001@test.com',
        role: 'BE', departmentId: salesDeptId, managerId: 'MGR001', status: 'Active',
        idraFaCode: '1101010116002',
      });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body.message || ''), /IDRA FA Code.*already in use/);
    assert.equal(await faCodeOf('EXIST001'), null, 'the failed update changed nothing');
  });

  it('update with an empty FA code clears the stored code', async () => {
    assert.equal(await faCodeOf('EXIST002'), '1101010116888', 'precondition: a code is stored');
    const res = await request(app)
      .put(`/api/users/${exist2Id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Name EXIST002', employeeId: 'EXIST002', email: 'exist002@test.com',
        role: 'BE', departmentId: salesDeptId, managerId: 'MGR001', status: 'Active',
        idraFaCode: '',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await faCodeOf('EXIST002'), null);
  });

  it('update without a FA code keeps the stored code', async () => {
    const res = await request(app)
      .put(`/api/users/${exist2Id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Name EXIST002', employeeId: 'EXIST002', email: 'exist002@test.com',
        role: 'BE', departmentId: salesDeptId, managerId: 'MGR001', status: 'Active',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await faCodeOf('EXIST002'), '1101010116888', 'absent field = keep');
  });

  /* ================================================================ */
  /* 4. Bulk import                                                   */
  /* ================================================================ */

  it('bulk validate accepts a new user with a FA code (Create, normalized)', async () => {
    const res = await validateRows([makeUserRow({ employeeId: 'BULK01', idraFaCode: '1101010116222' })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.errorRows, 0, JSON.stringify(res.body.data.rows[0]?.errors));
    assert.equal(res.body.data.rows[0].action, 'Create');
    assert.equal(res.body.data.rows[0].normalized.idraFaCode, '1101010116222');
  });

  it('bulk commit fills the FA code for an EXISTING user matched by Employee ID', async () => {
    assert.equal(await faCodeOf('EXIST001'), null, 'precondition: no code stored');
    const rows = [makeUserRow({
      employeeId: 'EXIST001',
      email: 'exist001@test.com',
      fullName: 'Name EXIST001',
      idraFaCode: '1101010116999',
    })];
    const validateRes = await validateRows(rows, 'createAndUpdate');
    assert.equal(validateRes.status, 200, JSON.stringify(validateRes.body));
    assert.equal(validateRes.body.data.errorRows, 0, JSON.stringify(validateRes.body.data.rows[0]?.errors));
    assert.equal(validateRes.body.data.rows[0].action, 'Update');
    const commitRes = await commitRows(rows, 'createAndUpdate');
    assert.equal(commitRes.status, 200, JSON.stringify(commitRes.body));
    assert.equal(await faCodeOf('EXIST001'), '1101010116999', 'the existing user now has the code');
  });

  it('bulk commit creates a NEW user with a FA code', async () => {
    const rows = [makeUserRow({ employeeId: 'BULK02', idraFaCode: '1101010116333' })];
    const commitRes = await commitRows(rows, 'createOnly');
    assert.equal(commitRes.status, 200, JSON.stringify(commitRes.body));
    assert.equal(await faCodeOf('BULK02'), '1101010116333');
  });

  it('bulk commit keeps the stored code when the update cell is blank', async () => {
    const rows = [makeUserRow({
      employeeId: 'EXIST002',
      email: 'exist002@test.com',
      fullName: 'Name EXIST002',
      idraFaCode: '',
    })];
    const commitRes = await commitRows(rows, 'createAndUpdate');
    assert.equal(commitRes.status, 200, JSON.stringify(commitRes.body));
    assert.equal(await faCodeOf('EXIST002'), '1101010116888', 'a blank cell never wipes the code');
  });

  it('bulk validate rejects a within-file duplicate FA code', async () => {
    const rows = [
      makeUserRow({ rowNumber: 1, employeeId: 'BULK03', idraFaCode: '1101010116444' }),
      makeUserRow({ rowNumber: 2, employeeId: 'BULK04', idraFaCode: '1101010116444' }),
    ];
    const res = await validateRows(rows);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.errorRows, 2, 'both rows carrying the duplicate error');
    assert.match(res.body.data.rows[0].errors.join(' '), /Duplicate IDRA FA Code/);
  });

  it('bulk validate rejects a FA code belonging to another user', async () => {
    const rows = [makeUserRow({ employeeId: 'BULK05', idraFaCode: '1101010116002' })];
    const res = await validateRows(rows);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.errorRows, 1);
    assert.match(res.body.data.rows[0].errors.join(' '), /IDRA FA Code.*already belongs to another user/);
  });

  it('bulk validate allows an update row re-stating its OWN FA code', async () => {
    const rows = [makeUserRow({
      employeeId: '2026010',
      email: '2026010@test.com',
      fullName: 'Name 2026010',
      idraFaCode: '1101010116002',
    })];
    const res = await validateRows(rows, 'createAndUpdate');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.errorRows, 0, JSON.stringify(res.body.data.rows[0]?.errors));
    assert.equal(res.body.data.rows[0].action, 'Update');
  });

  it('bulk validate rejects a malformed FA code', async () => {
    const rows = [makeUserRow({ employeeId: 'BULK06', idraFaCode: 'bad code!' })];
    const res = await validateRows(rows);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.errorRows, 1);
    assert.match(res.body.data.rows[0].errors.join(' '), /IDRA FA Code.*is invalid/);
  });

  /* ================================================================ */
  /* 5. Client header mapping (the roster-sheet column names)         */
  /* ================================================================ */

  it('the template headers include IDRA FA Code, right after Employee ID', () => {
    assert.ok(USER_TEMPLATE_HEADERS.includes('IDRA FA Code' as any), 'template carries the column');
    assert.equal(
      (USER_TEMPLATE_HEADERS as readonly string[]).indexOf('IDRA FA Code'),
      (USER_TEMPLATE_HEADERS as readonly string[]).indexOf('Employee ID') + 1,
    );
  });

  it('client parse maps the "Code" header to the FA code and "UM Code" to the manager', async () => {
    const file = await workbookFile(
      ['Employee ID', 'Code', 'Full Name', 'Email', 'Department', 'Role', 'UM Code', 'Status'],
      [['2026999', '1101010116777', 'Roster Person', 'r@test.com', 'Sales', 'BE', 'MGR001', 'Active']],
    );
    const { rows } = await parseUserImportFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employeeId, '2026999');
    assert.equal(rows[0].idraFaCode, '1101010116777', '"Code" maps to idraFaCode');
    assert.equal(rows[0].reportingManagerEmployeeId, 'MGR001', '"UM Code" maps to the manager');
    assert.deepEqual(rows[0].issues, []);
  });

  it('client parse maps the "FA Code" header and the "GM Code" manager header', async () => {
    const file = await workbookFile(
      ['Employee ID', 'FA Code', 'Full Name', 'Email', 'Department', 'Role', 'GM Code', 'Status'],
      [['2026998', '1101010116778', 'Roster Person', 'r@test.com', 'Sales', 'BE', 'MGR001', 'Active']],
    );
    const { rows } = await parseUserImportFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idraFaCode, '1101010116778', '"FA Code" maps to idraFaCode');
    assert.equal(rows[0].reportingManagerEmployeeId, 'MGR001', '"GM Code" maps to the manager');
  });

  it('client parse maps the canonical "IDRA FA Code" header and "ASM Code"', async () => {
    const file = await workbookFile(
      ['Employee ID', 'IDRA FA Code', 'Full Name', 'Email', 'Department', 'Role', 'ASM Code', 'Status'],
      [['2026997', '1101010116779', 'Roster Person', 'r@test.com', 'Sales', 'BE', 'MGR001', 'Active']],
    );
    const { rows } = await parseUserImportFile(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idraFaCode, '1101010116779', '"IDRA FA Code" maps to idraFaCode');
    assert.equal(rows[0].reportingManagerEmployeeId, 'MGR001', '"ASM Code" maps to the manager');
  });

  /* ================================================================ */
  /* 6. Mismatch verdict                                              */
  /* ================================================================ */

  it('isFaMismatch compares stored FA codes, not employee IDs', () => {
    assert.equal(isFaMismatch('1101010116002', '1101010116002'), false, 'same code: silent');
    assert.equal(isFaMismatch('1101010116002', '1101010116777'), true, 'different codes: warn');
    assert.equal(isFaMismatch('1101010116002', null), false, 'assignee has no code: silent');
    assert.equal(isFaMismatch('1101010116002', ''), false, 'assignee code blank: silent');
    assert.equal(isFaMismatch(null, '1101010116002'), false, 'policy has no code: silent');
    assert.equal(isFaMismatch('FA-ABC123', 'fa-abc123'), false, 'comparison is case-insensitive');
    // The old bug: the policy FA code vs the assignee's EMPLOYEE ID
    // would have warned here — the two identifiers simply differ.
    assert.equal(isFaMismatch('1101010116002', '2026010'), true, 'FA code vs employee ID still differs (which is why the verdict must use the stored FA code)');
  });

  it('lookup returns the assignee\'s stored FA code; no warning when it matches', async () => {
    _setPolicyLookupReaderForTest(fixtureReader);
    const res = await request(app)
      .post('/api/leads/policy-lookup')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: '3', assigneeEmployeeId: '2026010' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.faCode, '1101010116002', 'the policy\'s FA code');
    assert.equal(res.body.data.assigneeFaCode, '1101010116002', 'the assignee\'s stored FA code');
    assert.equal(isFaMismatch(res.body.data.faCode, res.body.data.assigneeFaCode), false);
  });

  it('lookup returns the assignee\'s FA code; the warning fires when it differs', async () => {
    _setPolicyLookupReaderForTest(fixtureReader);
    const res = await request(app)
      .post('/api/leads/policy-lookup')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: '8', assigneeEmployeeId: '2026010' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.faCode, '1101010116777');
    assert.equal(res.body.data.assigneeFaCode, '1101010116002');
    assert.equal(isFaMismatch(res.body.data.faCode, res.body.data.assigneeFaCode), true);
  });

  it('lookup returns null when the assignee has no FA code — no warning', async () => {
    _setPolicyLookupReaderForTest(fixtureReader);
    const res = await request(app)
      .post('/api/leads/policy-lookup')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: '3', assigneeEmployeeId: '2026012' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.assigneeFaCode, null);
    assert.equal(isFaMismatch(res.body.data.faCode, res.body.data.assigneeFaCode), false);
  });

  it('lookup returns null without an assignee, and for an unknown assignee', async () => {
    _setPolicyLookupReaderForTest(fixtureReader);
    const noAssignee = await request(app)
      .post('/api/leads/policy-lookup')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: '3' });
    assert.equal(noAssignee.status, 200, JSON.stringify(noAssignee.body));
    assert.equal(noAssignee.body.data.assigneeFaCode, null);

    const unknown = await request(app)
      .post('/api/leads/policy-lookup')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ key: '3', assigneeEmployeeId: 'NOPE999' });
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.equal(unknown.body.data.assigneeFaCode, null, 'an unknown assignee is not an error');
  });
});
