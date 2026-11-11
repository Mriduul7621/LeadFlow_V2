import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { resolveVisibility } from '../authz.js';
import { validateBulkRows, normalizeUserBulkRow, buildReferenceMaps } from '../routes/userBulkImport.js';
import { up as designationBackfill } from '../database/migrations/058_user_designation_backfill.js';

/**
 * UM-1 — User Management role-model fix (owner-approved 2026-11-11).
 * ------------------------------------------------------------------
 * Pins the three behaviour changes of the PR:
 *   1. Manager assignment is UNBLOCKED: any active user may be the
 *      line manager (self / cycle / CEO-with-manager still refused);
 *      unusual shapes (gap > 2, cross-department) are hierarchy-health
 *      WARNINGS, never save-time blocks — in create, update AND bulk
 *      import validation.
 *   2. Team-lead visibility comes from the TREE: a role whose scope is
 *      Own but who has >= 1 person in their reporting subtree gets
 *      DownTeam (subtree) lead visibility — list, detail and dashboard
 *      counts agree; a peer's leads stay invisible.
 *   3. Designation is its own field: creating a user without one
 *      defaults it from the ACCESS ROLE's display name, an explicit
 *      designation is stored as given, and migration 058 backfills
 *      existing NULL/empty designations from the role name.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'um1-suite-signing-key';

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
      description TEXT,
      business_code VARCHAR(100),
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
      menu_access JSONB,
      actions JSONB,
      feature_permissions JSONB,
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
      password VARCHAR(255) NOT NULL DEFAULT 'hashed',
      role_id UUID,
      department_id UUID,
      manager_id UUID,
      designation VARCHAR(255),
      profile_photo TEXT,
      account_status VARCHAR(20) DEFAULT 'ACTIVE',
      phone VARCHAR(50),
      join_date DATE,
      team_id VARCHAR(100),
      territory VARCHAR(255),
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
    CREATE TABLE IF NOT EXISTS department_members (
      department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_primary BOOLEAN NOT NULL DEFAULT TRUE,
      is_head BOOLEAN NOT NULL DEFAULT FALSE,
      is_primary_head BOOLEAN NOT NULL DEFAULT FALSE,
      joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
      left_at TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (department_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_code VARCHAR(30) UNIQUE,
      team_name VARCHAR(150),
      name VARCHAR(255),
      department_id UUID,
      description TEXT,
      leader_id UUID,
      is_department_mirror BOOLEAN DEFAULT FALSE,
      leader_employee_id VARCHAR(30),
      business_code VARCHAR(100),
      member_ids JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT TRUE,
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
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      user_employee_id VARCHAR(50),
      user_name VARCHAR(150),
      action VARCHAR(100),
      entity_type VARCHAR(100),
      entity_id VARCHAR(100),
      details TEXT,
      previous_value TEXT,
      new_value TEXT,
      ip_address VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
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
      current_status VARCHAR(255) DEFAULT 'New',
      status_history JSONB DEFAULT '[]'::jsonb,
      assignment_history JSONB DEFAULT '[]'::jsonb,
      documents JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '{}'::jsonb,
      tags JSONB DEFAULT '[]'::jsonb,
      follow_up_count INT DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL DEFAULT 'call',
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      duration_minutes INTEGER,
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
      meeting_type VARCHAR(255),
      location VARCHAR(255),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      completed_activity_id UUID
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      recipient_key VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      message TEXT,
      type VARCHAR(50) DEFAULT 'info',
      event_type VARCHAR(100),
      idempotency_key VARCHAR(500),
      reference_type VARCHAR(100),
      reference_id UUID,
      lead_code VARCHAR(50),
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

describe('UM-1 — manager unblocked, tree visibility floor, designation separated', () => {
  let pool: any;
  let app: express.Express;

  let deptA: string; // Sales
  let deptB: string; // Retail
  let adminRoleId: string;
  let ceoRoleId: string;
  let managerRoleId: string;
  let roRoleId: string;

  // Tree (all RO = role scope Own — the team-lead case):
  //   ceo (CEO, Organization)
  //     tl  (RO)          <- team lead by TREE, not by role
  //       sub1 (RO)
  //         sub2 (RO)
  //     solo (RO)         <- no reports: stays Own
  //     outsider (RO)     <- sibling branch: invisible to tl
  //     mgr (MANAGER, DownTeam)
  //       mgrSub (RO)
  let admin: any, ceo: any, tl: any, sub1: any, sub2: any, solo: any, outsider: any, mgr: any, mgrSub: any;

  const tokenFor = (user: any) => signToken({ id: user.id, employeeId: user.employeeId, role: user.roleCode, email: user.email });
  const asAdmin = () => ({ Authorization: `Bearer ${tokenFor(admin)}` });
  const asTl = () => ({ Authorization: `Bearer ${tokenFor(tl)}` });
  const asSolo = () => ({ Authorization: `Bearer ${tokenFor(solo)}` });

  async function insertUser(opts: {
    employeeId: string;
    roleId: string;
    roleCode: string;
    managerId?: string | null;
    departmentId?: string;
    designation?: string | null;
  }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, designation, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, true) RETURNING id`,
      [
        opts.employeeId,
        `User ${opts.employeeId}`,
        `${opts.employeeId.toLowerCase()}@test.com`,
        opts.roleId,
        opts.departmentId || deptA,
        opts.managerId || null,
        opts.designation === undefined ? 'Relationship Officer' : opts.designation,
      ]
    );
    return {
      id: res.rows[0].id,
      employeeId: opts.employeeId,
      email: `${opts.employeeId.toLowerCase()}@test.com`,
      roleCode: opts.roleCode,
    };
  }

  async function insertLead(mobile: string, owner: any) {
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 'New') RETURNING id`,
      [`lead_${mobile}`, `Lead ${mobile}`, mobile, owner.id]
    );
    return res.rows[0].id as string;
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    deptA = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`)).rows[0].id;
    deptB = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('RETAIL', 'Retail') RETURNING id`)).rows[0].id;

    const mkRole = async (code: string, name: string, level: number, vis: string) =>
      (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis]
      )).rows[0].id;
    adminRoleId = await mkRole('ADMIN', 'Administrator', 1, 'Organization');
    ceoRoleId = await mkRole('CEO', 'Chief Executive Officer', 1, 'Organization');
    managerRoleId = await mkRole('MANAGER', 'Manager', 2, 'DownTeam');
    roRoleId = await mkRole('RO', 'Relationship Officer', 4, 'Own');

    const permCodes = [
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'users.view', 'users.create', 'users.edit', 'dashboard.view',
    ];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      permIds[code] = (await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`, [code])).rows[0].id;
    }
    const grant = async (roleId: string, codes: string[]) => {
      for (const code of codes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    };
    await grant(adminRoleId, permCodes);
    await grant(ceoRoleId, permCodes);
    await grant(managerRoleId, ['leads.view', 'dashboard.view']);
    await grant(roRoleId, ['leads.view', 'dashboard.view']);

    admin = await insertUser({ employeeId: 'ADMIN1', roleId: adminRoleId, roleCode: 'ADMIN' });
    ceo = await insertUser({ employeeId: 'CEO001', roleId: ceoRoleId, roleCode: 'CEO' });
    tl = await insertUser({ employeeId: 'TL001', roleId: roRoleId, roleCode: 'RO', managerId: ceo.id });
    sub1 = await insertUser({ employeeId: 'SUB001', roleId: roRoleId, roleCode: 'RO', managerId: tl.id });
    sub2 = await insertUser({ employeeId: 'SUB002', roleId: roRoleId, roleCode: 'RO', managerId: sub1.id });
    solo = await insertUser({ employeeId: 'SOLO001', roleId: roRoleId, roleCode: 'RO', managerId: ceo.id });
    outsider = await insertUser({ employeeId: 'OUT001', roleId: roRoleId, roleCode: 'RO', managerId: ceo.id });
    mgr = await insertUser({ employeeId: 'MGR001', roleId: managerRoleId, roleCode: 'MANAGER', managerId: ceo.id });
    mgrSub = await insertUser({ employeeId: 'MSUB001', roleId: roRoleId, roleCode: 'RO', managerId: mgr.id });

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

  /* ---------------------------------------------------------- */
  /*  2. The visibility floor (resolveVisibility)                */
  /* ---------------------------------------------------------- */

  it('floor: an Own-scope user WITH subordinates resolves to their subtree (DownTeam in effect)', async () => {
    const vis = await resolveVisibility(tl.id, 'RO');
    assert.equal(vis.all, false);
    assert.ok(vis.userIds.includes(tl.id));
    assert.ok(vis.userIds.includes(sub1.id), 'direct report in scope');
    assert.ok(vis.userIds.includes(sub2.id), 'deeper subtree member in scope');
    assert.ok(!vis.userIds.includes(outsider.id), 'sibling branch stays out');
    assert.ok(!vis.userIds.includes(solo.id), 'unrelated peer stays out');
  });

  it('floor: an Own-scope user WITHOUT subordinates stays Own (unchanged)', async () => {
    const vis = await resolveVisibility(solo.id, 'RO');
    assert.equal(vis.all, false);
    assert.deepEqual(vis.userIds, [solo.id]);
  });

  it('floor: DownTeam and Organization role scopes are untouched', async () => {
    const mgrVis = await resolveVisibility(mgr.id, 'MANAGER');
    assert.equal(mgrVis.all, false);
    assert.ok(mgrVis.userIds.includes(mgrSub.id));
    assert.ok(!mgrVis.userIds.includes(sub1.id), 'other teams stay out of a manager scope');

    const ceoVis = await resolveVisibility(ceo.id, 'CEO');
    assert.equal(ceoVis.all, true, 'Organization scope still resolves to all');
  });

  /* ---------------------------------------------------------- */
  /*  2. The floor end-to-end: list = detail = dashboard         */
  /* ---------------------------------------------------------- */

  it('team lead (RO role) sees own + subtree leads in list, detail and dashboard counts', async () => {
    const leadSub = await insertLead('01731000001', sub1);
    const leadSub2 = await insertLead('01731000002', sub2);
    await insertLead('01731000003', tl);
    const leadOut = await insertLead('01731000004', outsider);
    await insertLead('01731000005', mgrSub);

    const list = await request(app).get('/api/leads').set(asTl());
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
    const listRows = Array.isArray(list.body) ? list.body : list.body.data || [];
    const listMobiles = listRows.map((l: any) => l.mobile);
    assert.ok(listMobiles.includes('01731000001'), 'subordinate lead in list');
    assert.ok(listMobiles.includes('01731000002'), 'deeper subtree lead in list');
    assert.ok(listMobiles.includes('01731000003'), 'own lead in list');
    assert.ok(!listMobiles.includes('01731000004'), 'unrelated lead NOT in list');
    assert.ok(!listMobiles.includes('01731000005'), 'another team\'s lead NOT in list');

    const detail = await request(app).get(`/api/leads/${leadSub}`).set(asTl());
    assert.equal(detail.status, 200, 'subordinate lead opens');
    const detailOut = await request(app).get(`/api/leads/${leadOut}`).set(asTl());
    assert.equal(detailOut.status, 404, 'unrelated lead stays 404 — no existence leak');

    const dash = await request(app).get('/api/dashboard').set(asTl());
    assert.equal(dash.status, 200, JSON.stringify(dash.body).slice(0, 200));
    assert.equal(dash.body.data.totalLeads, 3, 'dashboard counts own + subtree only');
  });

  it('RO without subordinates is unchanged: own leads only', async () => {
    await insertLead('01731000006', solo);
    const leadSub = await insertLead('01731000007', sub1);

    const list = await request(app).get('/api/leads').set(asSolo());
    assert.equal(list.status, 200);
    const soloRows = Array.isArray(list.body) ? list.body : list.body.data || [];
    const listMobiles = soloRows.map((l: any) => l.mobile);
    assert.deepEqual(listMobiles, ['01731000006']);

    const detail = await request(app).get(`/api/leads/${leadSub}`).set(asSolo());
    assert.equal(detail.status, 404);
  });

  /* ---------------------------------------------------------- */
  /*  1. Manager assignment unblocked                            */
  /* ---------------------------------------------------------- */

  it('create: a cross-department manager is accepted and lands in health WARNINGS, not invalid links', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(asAdmin())
      .send({
        fullName: 'Cross Dept', employeeId: 'XDEPT1', email: 'xdept1@test.com',
        role: 'RO', departmentId: deptB, managerId: 'TL001', status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const cfg = await request(app).get('/api/hierarchy-config').set(asAdmin());
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body).slice(0, 200));
    const warnings = cfg.body.setup.warnings || [];
    const invalid = cfg.body.setup.invalidLinks || [];
    assert.ok(
      warnings.some((w: any) => w.employeeId === 'XDEPT1' && /different department/.test(w.reason)),
      `expected a cross-department warning, got ${JSON.stringify(warnings)}`
    );
    assert.ok(!invalid.some((w: any) => w.employeeId === 'XDEPT1'), 'a warning must not be an invalid link');
  });

  it('create: a gap-3 manager (RO reporting to the CEO) is accepted', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(asAdmin())
      .send({
        fullName: 'Gap Three', employeeId: 'GAP3', email: 'gap3@test.com',
        role: 'RO', departmentId: deptA, managerId: 'CEO001', status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row: any = await pool.query(
      `SELECT m.employee_id AS mgr FROM users u JOIN users m ON m.id = u.manager_id WHERE u.employee_id = 'GAP3'`
    );
    assert.equal(row.rows[0].mgr, 'CEO001');
  });

  it('create: a Level-1 (CEO) user with a manager named still saves with NO manager (self-heal)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(asAdmin())
      .send({
        fullName: 'Second Ceo', employeeId: 'CEO002', email: 'ceo002@test.com',
        role: 'CEO', departmentId: deptA, managerId: 'TL001', status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row: any = await pool.query(`SELECT manager_id FROM users WHERE employee_id = 'CEO002'`);
    assert.equal(row.rows[0].manager_id, null);
  });

  it('update: self-manager and cycle are still refused', async () => {
    const selfRes = await request(app)
      .put(`/api/users/${sub1.id}`)
      .set(asAdmin())
      .send({ fullName: 'User SUB001', managerId: 'SUB001' });
    assert.equal(selfRes.status, 400, JSON.stringify(selfRes.body));
    assert.match(String(selfRes.body.message || ''), /themselves/i);

    // sub2 sits UNDER sub1: pointing sub1 at sub2 closes a cycle.
    const cycleRes = await request(app)
      .put(`/api/users/${sub1.id}`)
      .set(asAdmin())
      .send({ fullName: 'User SUB001', managerId: 'SUB002' });
    assert.equal(cycleRes.status, 400, JSON.stringify(cycleRes.body));
    assert.match(String(cycleRes.body.message || ''), /circular/i);
  });

  it('bulk import: a gap-3 manager is a row WARNING, not a row error', () => {
    const maps: any = buildReferenceMaps({
      roles: [
        { id: 'r-ceo', role_code: 'CEO', role_name: 'Chief Executive Officer', hierarchy_level: 1 },
        { id: 'r-ro', role_code: 'RO', role_name: 'Relationship Officer', hierarchy_level: 4 },
      ],
      departments: [{ id: 'dept-a', department_code: 'SALES', department_name: 'Sales' }],
      teams: [],
      existingUsers: [
        {
          id: 'u-ceo', employee_id: 'CEO001', email: 'ceo001@test.com', role_id: 'r-ceo',
          department_id: 'dept-a', team_id: null, manager_id: null, is_active: true,
          role_code: 'CEO', hierarchy_level: 1,
        },
      ],
      allUsers: [{ id: 'u-ceo', employee_id: 'CEO001', manager_id: null }],
    });
    const row = normalizeUserBulkRow({
      rowNumber: 1,
      employeeId: 'NEWRO1',
      fullName: 'New Ro',
      email: 'newro1@test.com',
      department: 'Sales',
      role: 'RO',
      reportingManagerEmployeeId: 'CEO001',
      status: 'Active',
    });
    const res = validateBulkRows({ rows: [row], maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: true } });
    assert.equal(res.rows[0].isValid, true, JSON.stringify(res.rows[0].errors));
    assert.match(res.rows[0].warnings.join(' '), /3 levels above/);
  });

  /* ---------------------------------------------------------- */
  /*  3. Designation separated from the access role              */
  /* ---------------------------------------------------------- */

  it('designation: create without one defaults from the access role name; an explicit one is kept; both show in the list', async () => {
    const noDesig = await request(app)
      .post('/api/users')
      .set(asAdmin())
      .send({
        fullName: 'No Desig', employeeId: 'NODESIG', email: 'nodesig@test.com',
        role: 'RO', departmentId: deptA, managerId: 'CEO001', status: 'Active',
      });
    assert.equal(noDesig.status, 201, JSON.stringify(noDesig.body));

    const withDesig = await request(app)
      .post('/api/users')
      .set(asAdmin())
      .send({
        fullName: 'Field Person', employeeId: 'FIELDP', email: 'fieldp@test.com',
        role: 'RO', departmentId: deptA, managerId: 'CEO001', status: 'Active',
        designation: 'Field Officer',
      });
    assert.equal(withDesig.status, 201, JSON.stringify(withDesig.body));

    const list = await request(app).get('/api/users').set(asAdmin());
    assert.equal(list.status, 200);
    const listUsers = Array.isArray(list.body) ? list.body : list.body.data || [];
    const byEmp = new Map<string, any>(listUsers.map((u: any) => [u.employeeId, u]));
    assert.equal(byEmp.get('NODESIG')?.designation, 'Relationship Officer', 'default = role display name');
    assert.equal(byEmp.get('FIELDP')?.designation, 'Field Officer', 'explicit designation stored and listed');
  });

  it('migration 058: backfills NULL/empty designations from the role name, keeps real titles, idempotent', async () => {
    // The migration runs through the shared connection helper (the
    // test pool), against this suite's own users/roles tables.
    const roleRow: any = await pool.query(`SELECT id FROM roles WHERE role_code = 'RO'`);
    const roId = roleRow.rows[0].id;
    await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, designation, is_active)
       VALUES ('MIG001', 'Mig Null', 'mig001@test.com', 'hashed', $1, NULL, true),
              ('MIG002', 'Mig Empty', 'mig002@test.com', 'hashed', $1, '', true),
              ('MIG003', 'Mig Title', 'mig003@test.com', 'hashed', $1, 'Senior Field Officer', true)`,
      [roId]
    );

    await designationBackfill();
    let rows: any = await pool.query(
      `SELECT employee_id, designation FROM users WHERE employee_id IN ('MIG001', 'MIG002', 'MIG003') ORDER BY employee_id`
    );
    assert.equal(rows.rows[0].designation, 'Relationship Officer', 'NULL backfilled from role name');
    assert.equal(rows.rows[1].designation, 'Relationship Officer', 'empty backfilled from role name');
    assert.equal(rows.rows[2].designation, 'Senior Field Officer', 'real title untouched');

    await designationBackfill();
    rows = await pool.query(
      `SELECT employee_id, designation FROM users WHERE employee_id IN ('MIG001', 'MIG002', 'MIG003') ORDER BY employee_id`
    );
    assert.equal(rows.rows[0].designation, 'Relationship Officer', 'second run is a no-op');
  });
});
