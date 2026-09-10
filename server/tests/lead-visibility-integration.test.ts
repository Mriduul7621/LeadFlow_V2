import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

/**
 * STEP 2 — Lead Visibility / Ownership: server-side lead LIST visibility.
 * ------------------------------------------------------------------
 * These tests exercise GET /api/leads against a real (PGlite) PostgreSQL
 * instance and prove that server/authz.ts (resolveVisibility) is the
 * authoritative filter applied to the SQL query itself — not a
 * client-controllable filter, and not something the client can widen
 * by supplying employeeId/userId/role/department/assignedTo query params.
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
}

describe('GET /api/leads — server-side visibility enforcement', () => {
  let pool: any;
  let app: express.Express;

  let deptSalesId: string;
  let deptOpsId: string;

  let adminRoleId: string;
  let fullTeamRoleId: string;
  let downTeamRoleId: string;
  let employeeRoleId: string;

  const permIds: Record<string, string> = {};

  // Users:
  //   admin           -> Organization visibility
  //   ceo              -> DownTeam, root of reporting tree (Sales dept)
  //     managerA        -> DownTeam, reports to ceo (Sales dept)
  //       subA1          -> Own, reports to managerA (Sales dept)
  //       subA2          -> Own, reports to subA1 (Sales dept, indirect report of managerA)
  //     managerB        -> DownTeam, reports to ceo (Sales dept) -- sibling of managerA
  //       subB1          -> Own, reports to managerB (Sales dept)
  //   fullTeamUser     -> FullTeam, Sales dept (no reporting relation to managerA/managerB)
  //   opsUser          -> Own, Ops dept (different department)
  //   userA / userB    -> Own, Sales dept, no manager relation (peers)
  let admin: any, ceo: any, managerA: any, managerB: any, subA1: any, subA2: any, subB1: any;
  let fullTeamUser: any, opsUser: any, userA: any, userB: any;

  async function createUser(opts: {
    employeeId: string;
    roleId: string;
    departmentId: string;
    managerId?: string | null;
    role: string;
  }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
      [
        opts.employeeId,
        `User ${opts.employeeId}`,
        `${opts.employeeId.toLowerCase()}@test.com`,
        opts.roleId,
        opts.departmentId,
        opts.managerId || null,
      ]
    );
    return {
      id: res.rows[0].id,
      employeeId: opts.employeeId,
      email: `${opts.employeeId.toLowerCase()}@test.com`,
      role: opts.role,
    };
  }

  async function createLead(mobile: string, name: string, assignedToUserId: string, createdByUserId?: string) {
    const leadCode = `lead_${mobile}`;
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'Untouched')`,
      [leadCode, name, mobile, assignedToUserId, createdByUserId || assignedToUserId, createdByUserId || assignedToUserId]
    );
    return leadCode;
  }

  function tokenFor(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
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

    const deptSalesRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    );
    deptSalesId = deptSalesRes.rows[0].id;
    const deptOpsRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('OPS', 'Operations') RETURNING id`
    );
    deptOpsId = deptOpsRes.rows[0].id;

    const adminRoleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`
    );
    adminRoleId = adminRoleRes.rows[0].id;

    const downTeamRoleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`
    );
    downTeamRoleId = downTeamRoleRes.rows[0].id;

    const fullTeamRoleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('SM', 'Senior Manager', 60, 'FullTeam') RETURNING id`
    );
    fullTeamRoleId = fullTeamRoleRes.rows[0].id;

    const employeeRoleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
    );
    employeeRoleId = employeeRoleRes.rows[0].id;

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [adminRoleId, downTeamRoleId, fullTeamRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }

    admin = await createUser({ employeeId: 'ADMIN1', roleId: adminRoleId, departmentId: deptSalesId, role: 'ADMIN' });
    ceo = await createUser({ employeeId: 'CEO1', roleId: downTeamRoleId, departmentId: deptSalesId, role: 'MANAGER' });
    managerA = await createUser({ employeeId: 'MGRA', roleId: downTeamRoleId, departmentId: deptSalesId, managerId: ceo.id, role: 'MANAGER' });
    managerB = await createUser({ employeeId: 'MGRB', roleId: downTeamRoleId, departmentId: deptSalesId, managerId: ceo.id, role: 'MANAGER' });
    subA1 = await createUser({ employeeId: 'SUBA1', roleId: employeeRoleId, departmentId: deptSalesId, managerId: managerA.id, role: 'EMPLOYEE' });
    subA2 = await createUser({ employeeId: 'SUBA2', roleId: employeeRoleId, departmentId: deptSalesId, managerId: subA1.id, role: 'EMPLOYEE' });
    subB1 = await createUser({ employeeId: 'SUBB1', roleId: employeeRoleId, departmentId: deptSalesId, managerId: managerB.id, role: 'EMPLOYEE' });
    fullTeamUser = await createUser({ employeeId: 'FULLTM', roleId: fullTeamRoleId, departmentId: deptSalesId, role: 'SM' });
    opsUser = await createUser({ employeeId: 'OPS1', roleId: employeeRoleId, departmentId: deptOpsId, role: 'EMPLOYEE' });
    userA = await createUser({ employeeId: 'EMPA', roleId: employeeRoleId, departmentId: deptSalesId, role: 'EMPLOYEE' });
    userB = await createUser({ employeeId: 'EMPB', roleId: employeeRoleId, departmentId: deptSalesId, role: 'EMPLOYEE' });

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

  it('A. Own: User A sees own leads but not User B leads', async () => {
    await createLead('01710000001', 'Lead Owned By A', userA.id);
    await createLead('01710000002', 'Lead Owned By B', userB.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(userA)}`);
    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(mobiles.includes('01710000001'), 'User A must see own lead');
    assert.ok(!mobiles.includes('01710000002'), 'User A must NOT see User B lead');
  });

  it('B. DownTeam: Manager sees own + direct + indirect subordinate leads, not sibling/unrelated leads', async () => {
    await createLead('01710000010', 'MgrA Own Lead', managerA.id);
    await createLead('01710000011', 'Direct Report Lead', subA1.id);
    await createLead('01710000012', 'Indirect Report Lead', subA2.id);
    await createLead('01710000013', 'Sibling Manager Lead', managerB.id);
    await createLead('01710000014', 'Sibling Subordinate Lead', subB1.id);
    await createLead('01710000015', 'Unrelated User Lead', userA.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(managerA)}`);
    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);

    assert.ok(mobiles.includes('01710000010'), 'Manager must see own lead');
    assert.ok(mobiles.includes('01710000011'), 'Manager must see direct subordinate lead');
    assert.ok(mobiles.includes('01710000012'), 'Manager must see indirect subordinate lead');

    assert.ok(!mobiles.includes('01710000013'), 'Manager must NOT see sibling manager lead');
    assert.ok(!mobiles.includes('01710000014'), 'Manager must NOT see sibling subordinate lead');
    assert.ok(!mobiles.includes('01710000015'), 'Manager must NOT see unrelated user lead');
  });

  it('C. FullTeam: sees leads owned by same-department users, not other-department leads', async () => {
    await createLead('01710000020', 'Sales Dept Lead (userA)', userA.id);
    await createLead('01710000021', 'Sales Dept Lead (managerA)', managerA.id);
    await createLead('01710000022', 'Ops Dept Lead', opsUser.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(fullTeamUser)}`);
    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);

    assert.ok(mobiles.includes('01710000020'), 'FullTeam user must see same-department lead (userA)');
    assert.ok(mobiles.includes('01710000021'), 'FullTeam user must see same-department lead (managerA)');
    assert.ok(!mobiles.includes('01710000022'), 'FullTeam user must NOT see other-department lead');
  });

  it('D. Organization: Admin sees leads across departments', async () => {
    await createLead('01710000030', 'Sales Dept Lead', userA.id);
    await createLead('01710000031', 'Ops Dept Lead', opsUser.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(admin)}`);
    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(mobiles.includes('01710000030'), 'Admin must see Sales dept lead');
    assert.ok(mobiles.includes('01710000031'), 'Admin must see Ops dept lead');
  });

  it('E. Query bypass protection: client-supplied assignedTo/employeeId/role/department cannot widen scope', async () => {
    await createLead('01710000040', 'User A Own Lead', userA.id);
    await createLead('01710000041', 'User B Lead (target of attack)', userB.id);

    // User A attempts to read User B's leads by forging query params.
    const res = await request(app)
      .get('/api/leads')
      .query({
        assignedTo: 'EMPB',
        employeeId: 'EMPB',
        userId: userB.id,
        role: 'ADMIN',
        roleCode: 'ADMIN',
        department: 'ALL',
        departmentId: 'ALL',
        visibility: 'Organization',
        scope: 'Organization',
      })
      .set('Authorization', `Bearer ${tokenFor(userA)}`);

    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(!mobiles.includes('01710000041'), 'User A must NOT be able to see User B lead via forged query params');
    // The assignedTo filter, intersected with caller scope, yields nothing for EMPB — not an error, not a bypass.
    assert.ok(!mobiles.includes('01710000040'), 'assignedTo=EMPB filter intersected with Own scope excludes A\'s own lead too');
  });

  it('F. No fail-open: a role with an unrecognized/malformed data_visibility value degrades to Own, never organization-wide', async () => {
    // A role whose data_visibility column holds a value outside the known
    // enum ('Own' | 'DownTeam' | 'FullTeam' | 'Organization'). resolveDataVisibility()
    // must degrade this to the least-privilege 'Own' scope rather than throwing
    // or silently granting broader access.
    const bogusRoleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('BOGUS_ROLE', 'Bogus', 20, 'NOT_A_REAL_SCOPE') RETURNING id`
    );
    const bogusRoleId = bogusRoleRes.rows[0].id;
    for (const code of ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export']) {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [bogusRoleId, permIds[code]]);
    }
    const bogusRoleUser = await createUser({
      employeeId: 'BOGUSU',
      roleId: bogusRoleId,
      departmentId: deptSalesId,
      role: 'BOGUS_ROLE',
    });

    await createLead('01710000050', 'Bogus Role Own Lead', bogusRoleUser.id);
    await createLead('01710000051', 'Other User Lead', userA.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(bogusRoleUser)}`);
    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(mobiles.includes('01710000050'), 'Unrecognized-visibility-scope user must still see own lead (Own is least privilege, not zero)');
    assert.ok(!mobiles.includes('01710000051'), 'Unrecognized-visibility-scope user must NOT fail open to organization-wide visibility');
  });

  it('F2. No fail-open: caller record lookup failure (missing/unlinked role) fails closed, not organization-wide', async () => {
    // A user whose role_id is NULL (e.g. deleted/unlinked role). The permission
    // layer must fail CLOSED (deny), which is strictly safer than "Own" and
    // must never be treated as, or degrade into, organization-wide access.
    const noRoleUser = await createUser({
      employeeId: 'NOROLEU',
      roleId: employeeRoleId,
      departmentId: deptSalesId,
      role: 'EMPLOYEE',
    });
    await pool.query(`UPDATE users SET role_id = NULL WHERE id = $1`, [noRoleUser.id]);

    await createLead('01710000052', 'No-role User Own Lead', noRoleUser.id);
    await createLead('01710000053', 'Other User Lead 2', userA.id);

    const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(noRoleUser)}`);
    // Fail-closed: either explicitly denied, or scoped to nothing/only-self — never all leads.
    if (res.status === 200) {
      const mobiles = res.body.map((l: any) => l.mobile);
      assert.ok(!mobiles.includes('01710000053'), 'No-role user must never see another user\'s lead (no fail-open)');
    } else {
      assert.ok([401, 403].includes(res.status), 'No-role user must be denied, not served organization-wide data');
    }
  });

  it('G. Existing filters compose with visibility (AND, not OR): status filter narrows within scope', async () => {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ('lead_status1', 'Manager Lead Untouched', '01710000060', $1, $1, $1, $1, 'Untouched')`,
      [managerA.id]
    );
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ('lead_status2', 'Manager Lead Converted', '01710000061', $1, $1, $1, $1, 'Converted')`,
      [managerA.id]
    );
    // Out-of-scope lead with the same status, must never appear regardless of filter.
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ('lead_status3', 'Sibling Lead Untouched', '01710000062', $1, $1, $1, $1, 'Untouched')`,
      [managerB.id]
    );

    const res = await request(app)
      .get('/api/leads')
      .query({ status: 'Untouched' })
      .set('Authorization', `Bearer ${tokenFor(managerA)}`);

    assert.equal(res.status, 200);
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(mobiles.includes('01710000060'), 'Status filter + visibility must include in-scope matching lead');
    assert.ok(!mobiles.includes('01710000061'), 'Status filter must exclude in-scope non-matching lead');
    assert.ok(!mobiles.includes('01710000062'), 'Visibility must exclude out-of-scope lead even though status matches');
  });

  it('H. Deleted leads remain hidden regardless of visibility scope (soft-delete preserved)', async () => {
    await createLead('01710000070', 'Active Lead', userA.id);
    const deletedCode = await createLead('01710000071', 'Deleted Lead', userA.id);
    await pool.query(`UPDATE leads SET is_deleted = TRUE, deleted_at = NOW() WHERE lead_code = $1`, [deletedCode]);

    const resOwn = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(userA)}`);
    assert.equal(resOwn.status, 200);
    const ownMobiles = resOwn.body.map((l: any) => l.mobile);
    assert.ok(ownMobiles.includes('01710000070'));
    assert.ok(!ownMobiles.includes('01710000071'), 'Owner must not see own soft-deleted lead');

    const resAdmin = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(admin)}`);
    assert.equal(resAdmin.status, 200);
    const adminMobiles = resAdmin.body.map((l: any) => l.mobile);
    assert.ok(!adminMobiles.includes('01710000071'), 'Admin (Organization scope) must not see soft-deleted lead either');
  });
});
