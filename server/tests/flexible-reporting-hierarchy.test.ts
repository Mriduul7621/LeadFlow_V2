import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import {
  UNASSIGNED_LEVEL,
  resolveRoleLevel,
  allowedManagerLevels,
  validateReportingManagerCandidate,
} from '../utils/reportingRules.js';
import { validateReportingLink, recomputeReportingChains } from '../routes/production.routes.js';
import { resolveVisibility, getDownlineIds } from '../authz.js';

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
      department_code VARCHAR(100) UNIQUE,
      department_name VARCHAR(255) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_code VARCHAR(30) UNIQUE,
      team_name VARCHAR(150),
      department_id UUID,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
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
      is_active BOOLEAN DEFAULT TRUE,
      account_status VARCHAR(30) DEFAULT 'ACTIVE',
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hierarchies (
      user_id UUID PRIMARY KEY,
      manager_id UUID,
      level INT,
      path JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      module_name VARCHAR(100),
      action_name VARCHAR(100)
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
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_user_id UUID,
      action_code VARCHAR(100),
      entity_type VARCHAR(100),
      entity_id UUID,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

describe('Flexible Skip-Level Reporting Hierarchy', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId: string;
  let ceoRoleId: string;
  let managerRoleId: string;
  let teamLeadRoleId: string;
  let sbeRoleId: string;
  let beRoleId: string;
  let officerRoleId: string;

  let salesDeptId: string;
  let hrDeptId: string;

  let adminUserId: string;
  let ceoSalesId: string;
  let ceoHrId: string;
  let mgrSalesId: string;
  let mgrHrId: string;
  let tlSalesId: string;
  let sbeSalesId: string;
  let beSalesId: string;

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    // Departments
    const salesRes: any = await pool.query(`INSERT INTO departments (department_code, department_name, is_active) VALUES ('SALES', 'Sales', TRUE) RETURNING id`);
    salesDeptId = salesRes.rows[0].id;
    const hrRes: any = await pool.query(`INSERT INTO departments (department_code, department_name, is_active) VALUES ('HR', 'HR', TRUE) RETURNING id`);
    hrDeptId = hrRes.rows[0].id;

    // Roles: full ladder + one off-ladder (99) role
    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('ADMIN', 'Administrator', 1, 'Organization', TRUE) RETURNING id`);
    adminRoleId = adminRoleRes.rows[0].id;
    const ceoRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('CEO', 'Chief Executive Officer', 1, 'Organization', TRUE) RETURNING id`);
    ceoRoleId = ceoRoleRes.rows[0].id;
    const managerRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('MANAGER', 'Manager', 2, 'DownTeam', TRUE) RETURNING id`);
    managerRoleId = managerRoleRes.rows[0].id;
    const teamLeadRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('TEAM_LEAD', 'Team Lead', 3, 'DownTeam', TRUE) RETURNING id`);
    teamLeadRoleId = teamLeadRoleRes.rows[0].id;
    const sbeRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('SBE', 'Senior Business Executive', 4, 'Own', TRUE) RETURNING id`);
    sbeRoleId = sbeRoleRes.rows[0].id;
    const beRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('BE', 'Business Executive', 5, 'Own', TRUE) RETURNING id`);
    beRoleId = beRoleRes.rows[0].id;
    const officerRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ('OFFICER', 'Officer', 99, 'Own', TRUE) RETURNING id`);
    officerRoleId = officerRoleRes.rows[0].id;

    // Permissions (admin bypass via role_code ADMIN)
    const permCodes = ['users.create', 'users.edit', 'users.delete'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, 'test', 'test') RETURNING id`, [code]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`, [adminRoleId, res.rows[0].id]);
    }

    // Users: admin, two CEOs, managers (Sales + HR), team lead, SBE, BE
    const adminRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN001', 'Admin One', 'admin@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [adminRoleId, salesDeptId]
    );
    adminUserId = adminRes.rows[0].id;

    const ceoSalesRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('CEO001', 'CEO Sales', 'ceo@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [ceoRoleId, salesDeptId]
    );
    ceoSalesId = ceoSalesRes.rows[0].id;

    const ceoHrRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('CEO002', 'CEO HR', 'ceohr@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [ceoRoleId, hrDeptId]
    );
    ceoHrId = ceoHrRes.rows[0].id;

    const mgrSalesRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('MGR001', 'Sales Manager', 'mgr@test.com', 'hashed', $1, $2, $3, TRUE) RETURNING id`,
      [managerRoleId, salesDeptId, ceoSalesId]
    );
    mgrSalesId = mgrSalesRes.rows[0].id;

    const mgrHrRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('MGR002', 'HR Manager', 'mgrhr@test.com', 'hashed', $1, $2, $3, TRUE) RETURNING id`,
      [managerRoleId, hrDeptId, ceoHrId]
    );
    mgrHrId = mgrHrRes.rows[0].id;

    const tlSalesRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('TL001', 'Sales Team Lead', 'tl@test.com', 'hashed', $1, $2, $3, TRUE) RETURNING id`,
      [teamLeadRoleId, salesDeptId, mgrSalesId]
    );
    tlSalesId = tlSalesRes.rows[0].id;

    const sbeSalesRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('SBE001', 'Senior BE', 'sbe@test.com', 'hashed', $1, $2, $3, TRUE) RETURNING id`,
      [sbeRoleId, salesDeptId, tlSalesId]
    );
    sbeSalesId = sbeSalesRes.rows[0].id;

    const beSalesRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active) VALUES ('BE001', 'Business Exec', 'be@test.com', 'hashed', $1, $2, $3, TRUE) RETURNING id`,
      [beRoleId, salesDeptId, sbeSalesId]
    );
    beSalesId = beSalesRes.rows[0].id;

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // Restore the seeded ladder: remove any user created by tests and put
    // SBE001 back under its original manager (some tests skip-level it).
    await pool.query(`DELETE FROM users WHERE employee_id NOT IN ('ADMIN001','CEO001','CEO002','MGR001','MGR002','TL001','SBE001','BE001')`);
    await pool.query(`DELETE FROM hierarchies`);
    await pool.query(`UPDATE users SET manager_id = (SELECT id FROM users WHERE employee_id = 'TL001') WHERE employee_id = 'SBE001'`);
  });

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN001', role: 'ADMIN', email: 'admin@test.com' });

  /* ------------------------------------------------------------------ */
  /*  PURE RULE — level gap matrix                                       */
  /* ------------------------------------------------------------------ */

  it('Level 4 → Level 3 allowed (gap 1)', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: 3, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' }), null);
  });

  it('Level 4 → Level 2 allowed (gap 2)', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: 2, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' }), null);
  });

  it('Level 4 → Level 1 rejected (gap 3 > 2)', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: 1, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' });
    assert.ok(err);
    assert.match(err!, /Level 3 or 2/);
  });

  it('Level 3 → Level 2 allowed', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 3, managerLevel: 2, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' }), null);
  });

  it('Level 3 → Level 1 allowed (gap 2)', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 3, managerLevel: 1, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' }), null);
  });

  it('Level 2 → Level 1 allowed', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 2, managerLevel: 1, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' }), null);
  });

  it('same-level manager rejected (gap 0)', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: 4, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' });
    assert.ok(err);
  });

  it('lower-level manager rejected (negative gap)', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 2, managerLevel: 3, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' });
    assert.ok(err);
  });

  it('Level 1 employee cannot have any manager', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 1, managerLevel: 1, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' });
    assert.ok(err);
    assert.match(err!, /Level-1 \(CEO\) employee cannot report/);
  });

  it('off-ladder (level 99) employee is exempt from the gap rule', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: UNASSIGNED_LEVEL, managerLevel: 3, employeeDepartmentId: 'd1', managerDepartmentId: 'd2' }), null);
  });

  it('off-ladder (level 99) manager cannot manage an in-ladder employee', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: UNASSIGNED_LEVEL, employeeDepartmentId: 'd1', managerDepartmentId: 'd1' });
    assert.ok(err);
  });

  it('same-department enforced for non-Level-1 managers', () => {
    const err = validateReportingManagerCandidate({ employeeLevel: 4, managerLevel: 2, employeeDepartmentId: 'd1', managerDepartmentId: 'd2' });
    assert.ok(err);
    assert.match(err!, /same department/);
  });

  it('Level-1 manager crosses departments', () => {
    assert.equal(validateReportingManagerCandidate({ employeeLevel: 3, managerLevel: 1, employeeDepartmentId: 'd1', managerDepartmentId: 'd2' }), null);
  });

  it('allowedManagerLevels returns the correct one-or-two-up levels', () => {
    assert.deepEqual(allowedManagerLevels(4), [3, 2]);
    assert.deepEqual(allowedManagerLevels(3), [2, 1]);
    assert.deepEqual(allowedManagerLevels(2), [1]);
    assert.deepEqual(allowedManagerLevels(1), []);
    assert.deepEqual(allowedManagerLevels(UNASSIGNED_LEVEL), []);
  });

  it('resolveRoleLevel maps 0/negative/undefined to unassigned', () => {
    assert.equal(resolveRoleLevel(3), 3);
    assert.equal(resolveRoleLevel(0), UNASSIGNED_LEVEL);
    assert.equal(resolveRoleLevel(-1), UNASSIGNED_LEVEL);
    assert.equal(resolveRoleLevel(undefined), UNASSIGNED_LEVEL);
    assert.equal(resolveRoleLevel(null), UNASSIGNED_LEVEL);
  });

  /* ------------------------------------------------------------------ */
  /*  SERVER VALIDATION (validateReportingLink)                          */
  /* ------------------------------------------------------------------ */

  it('manual link validation accepts a two-level-up manager', async () => {
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: mgrSalesId, managerIsRequired: true,
    });
    assert.equal(err, null);
  });

  it('manual link validation rejects a three-level-up manager', async () => {
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: ceoSalesId, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /Level 3 or 2/);
  });

  it('Level 1 employee cannot have a manager', async () => {
    const err = await validateReportingLink(pool, {
      selfId: ceoSalesId, roleId: ceoRoleId, departmentId: salesDeptId, managerId: mgrSalesId, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /Level-1 \(CEO\)/);
  });

  it('Level 2+ employee requires a manager when managerIsRequired', async () => {
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: null, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /reporting manager is required/);
  });

  it('off-ladder (level 99) employee may omit the manager', async () => {
    const officerUserRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('OFFICER001', 'Officer One', 'officer@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [officerRoleId, salesDeptId]
    );
    const err = await validateReportingLink(pool, {
      selfId: officerUserRes.rows[0].id, roleId: officerRoleId, departmentId: salesDeptId, managerId: null, managerIsRequired: true,
    });
    assert.equal(err, null);
  });

  it('self-manager rejected', async () => {
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: sbeSalesId, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /report to themselves/);
  });

  it('direct child cannot become the manager (descendant guard)', async () => {
    // SBE currently manages BE001 (child). Attempting SBE -> BE001 must fail
    // because BE001's up-chain contains SBE (cycle).
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: beSalesId, managerIsRequired: true,
    });
    assert.ok(err);
  });

  it('deeper descendant cannot become the manager', async () => {
    // Make BE001 the manager of SBE's child... create a chain CEO -> MGR -> TL -> SBE -> BE,
    // then try TL -> BE (BE is a deeper descendant of TL).
    const err = await validateReportingLink(pool, {
      selfId: tlSalesId, roleId: teamLeadRoleId, departmentId: salesDeptId, managerId: beSalesId, managerIsRequired: true,
    });
    assert.ok(err);
  });

  it('cycle detection still works (A → B → A)', async () => {
    // A is a Manager (level 2), B is a CEO (level 1) so the level gap is
    // valid (gap 1) and only the cycle guard can reject the link.
    const aRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('CYCA', 'Cycle A', 'cyca@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [managerRoleId, salesDeptId]
    );
    const bRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('CYCB', 'Cycle B', 'cycb@test.com', 'hashed', $1, $2, TRUE) RETURNING id`,
      [ceoRoleId, salesDeptId]
    );
    const aId = aRes.rows[0].id;
    const bId = bRes.rows[0].id;
    // Stored graph: a -> b and b -> a (pre-existing cycle).
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [bId, aId]);
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [aId, bId]);
    // Re-linking a to b must be caught by the cycle guard.
    const err = await validateReportingLink(pool, {
      selfId: aId, roleId: managerRoleId, departmentId: salesDeptId, managerId: bId, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /circular/);
  });

  it('inactive manager rejected', async () => {
    const inactiveRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('INACTMGR', 'Inactive Mgr', 'inactmgr@test.com', 'hashed', $1, $2, FALSE) RETURNING id`,
      [managerRoleId, salesDeptId]
    );
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: inactiveRes.rows[0].id, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /active employee/);
  });

  it('cross-department non-Level-1 manager rejected', async () => {
    const err = await validateReportingLink(pool, {
      selfId: sbeSalesId, roleId: sbeRoleId, departmentId: salesDeptId, managerId: mgrHrId, managerIsRequired: true,
    });
    assert.ok(err);
    assert.match(err!, /same department/);
  });

  it('Level-1 cross-department manager preserved', async () => {
    // TL (level 3) reporting to HR CEO (level 1) — gap 2, Level-1 crosses depts.
    const err = await validateReportingLink(pool, {
      selfId: tlSalesId, roleId: teamLeadRoleId, departmentId: salesDeptId, managerId: ceoHrId, managerIsRequired: true,
    });
    assert.equal(err, null);
  });

  /* ------------------------------------------------------------------ */
  /*  REPORTING CHAIN — actual manager graph, no fabricated level        */
  /* ------------------------------------------------------------------ */

  it('reporting_chain follows the actual manager path without a fabricated level', async () => {
    // Skip-level: SBE (4) reports directly to MGR (2), whose manager is CEO (1).
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [mgrSalesId, sbeSalesId]);
    await recomputeReportingChains(pool);

    const res: any = await pool.query(`SELECT reporting_chain FROM users WHERE id = $1`, [sbeSalesId]);
    const chain = Array.isArray(res.rows[0].reporting_chain) ? res.rows[0].reporting_chain : JSON.parse(res.rows[0].reporting_chain || '[]');
    // Actual path: SBE -> MGR -> CEO. No fabricated Team Lead node.
    assert.deepEqual(chain, ['MGR001', 'CEO001']);
  });

  it('one-level reporting still recomputes correctly', async () => {
    await recomputeReportingChains(pool);
    const res: any = await pool.query(`SELECT reporting_chain FROM users WHERE id = $1`, [tlSalesId]);
    const chain = Array.isArray(res.rows[0].reporting_chain) ? res.rows[0].reporting_chain : JSON.parse(res.rows[0].reporting_chain || '[]');
    assert.deepEqual(chain, ['MGR001', 'CEO001']);
  });

  /* ------------------------------------------------------------------ */
  /*  DOWNTEAM / DATA VISIBILITY — recursive manager_id                 */
  /* ------------------------------------------------------------------ */

  it('DownTeam visibility includes a skip-level direct report', async () => {
    // SBE (4) now reports directly to MGR (2).
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [mgrSalesId, sbeSalesId]);
    await recomputeReportingChains(pool);

    const downline = await getDownlineIds(mgrSalesId);
    assert.ok(downline.includes(sbeSalesId), 'skip-level direct report must be in the downline');
  });

  it('recursive manager visibility includes deeper descendants', async () => {
    await recomputeReportingChains(pool);
    const ceoVisibility = await resolveVisibility(ceoSalesId, 'CEO', salesDeptId);
    // CEO has Organization visibility by role, so `all` is true; assert instead on the downline.
    const downline = await getDownlineIds(ceoSalesId);
    for (const id of [mgrSalesId, tlSalesId, sbeSalesId, beSalesId]) {
      assert.ok(downline.includes(id), 'every descendant must be reachable from the root');
    }
  });

  it('DownTeam scope resolves only the actual subtree', async () => {
    const visibility = await resolveVisibility(mgrSalesId, 'MANAGER', salesDeptId);
    assert.equal(visibility.all, false);
    assert.ok(visibility.userIds.includes(sbeSalesId));
    assert.ok(visibility.userIds.includes(tlSalesId));
    assert.ok(!visibility.userIds.includes(mgrHrId), 'HR manager is not in the Sales manager subtree');
  });

  /* ------------------------------------------------------------------ */
  /*  MANUAL CREATE / EDIT + REPORTING OPTIONS (API)                     */
  /* ------------------------------------------------------------------ */

  it('manual user create accepts a valid two-level-up manager', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Skip Report', employeeId: 'SKIP001', email: 'skip001@test.com',
        role: 'SBE', departmentId: salesDeptId, managerId: 'MGR001', status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    const dbRes: any = await pool.query(`SELECT m.employee_id AS mgr_emp FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.employee_id = 'SKIP001'`);
    assert.equal(dbRes.rows[0].mgr_emp, 'MGR001');
  });

  it('manual user edit accepts a valid two-level-up manager', async () => {
    const res = await request(app)
      .put('/api/users/SBE001')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ managerId: 'MGR001', departmentId: salesDeptId, role: 'SBE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const dbRes: any = await pool.query(`SELECT m.employee_id AS mgr_emp FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.employee_id = 'SBE001'`);
    assert.equal(dbRes.rows[0].mgr_emp, 'MGR001');
  });

  it('manual user create rejects a >2-level manager', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Too Far', employeeId: 'FAR001', email: 'far001@test.com',
        role: 'SBE', departmentId: salesDeptId, managerId: 'CEO001', status: 'Active',
      });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /Level 3 or 2/);
  });

  it('reporting-options include +2-level managers and exclude same/lower/>2', async () => {
    const res = await request(app)
      .get(`/api/users/reporting-options?role=SBE&departmentId=${salesDeptId}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200);
    const employeeIds = res.body.map((o: any) => o.employeeId);
    assert.ok(employeeIds.includes('MGR001'), 'level 2 manager must be offered');
    assert.ok(employeeIds.includes('TL001'), 'level 3 manager must be offered');
    assert.ok(!employeeIds.includes('CEO001'), 'level 1 is >2 levels up for SBE');
    assert.ok(!employeeIds.includes('SBE001'), 'same level must be excluded');
    assert.ok(!employeeIds.includes('BE001'), 'lower level must be excluded');
  });

  it('reporting-options for Level 3 include Level 1 candidates across departments', async () => {
    const res = await request(app)
      .get(`/api/users/reporting-options?role=TEAM_LEAD&departmentId=${salesDeptId}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200);
    const employeeIds = res.body.map((o: any) => o.employeeId);
    assert.ok(employeeIds.includes('MGR001'), 'level 2 same-dept manager');
    assert.ok(employeeIds.includes('CEO001'), 'level 1 same-dept CEO');
    assert.ok(employeeIds.includes('CEO002'), 'level 1 cross-dept CEO is allowed');
    assert.ok(!employeeIds.includes('MGR002'), 'level 2 cross-dept manager must be excluded');
  });

  it('reporting-options are empty for Level 1 and off-ladder roles', async () => {
    const ceoRes = await request(app)
      .get(`/api/users/reporting-options?role=CEO&departmentId=${salesDeptId}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(ceoRes.status, 200);
    assert.deepEqual(ceoRes.body, []);

    const officerRes = await request(app)
      .get(`/api/users/reporting-options?role=OFFICER&departmentId=${salesDeptId}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(officerRes.status, 200);
    assert.deepEqual(officerRes.body, []);
  });

  /* ------------------------------------------------------------------ */
  /*  ORGANOGRAM + NO-SCHEMA-CHANGE GUARDS                               */
  /* ------------------------------------------------------------------ */

  it('organogram reflects the actual manager_id graph (skip-level renders beneath its direct manager)', async () => {
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [mgrSalesId, sbeSalesId]);
    await recomputeReportingChains(pool);

    const res = await request(app).get('/api/organogram').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200);
    const sbe = res.body.nodes.find((n: any) => n.employeeId === 'SBE001');
    assert.ok(sbe);
    assert.equal(sbe.managerEmployeeId, 'MGR001', 'skip-level direct report points at its real manager');
  });

  it('no new schema column or table was introduced', async () => {
    const colRes: any = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('skip_level_manager_id', 'secondary_manager_id')`
    );
    assert.equal(colRes.rows.length, 0, 'no skip-level manager column may exist');
    const tableRes: any = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name IN ('skip_level_reporting', 'reporting_exceptions')`
    );
    assert.equal(tableRes.rows.length, 0, 'no reporting exception table may exist');
  });
});
