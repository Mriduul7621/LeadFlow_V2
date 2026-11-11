/**
 * Hierarchy fixes — CEO edit deadlock + managers via additional departments.
 *
 * Fix A (the bug Mahadi hit live, 2026-11-09): a Level-1 (CEO) user whose
 * stored `manager_id` is stale (set before promotion / legacy data) could
 * NEVER be edited. The Edit Employee form loads the stale manager into its
 * state, replaces the manager picker with static text for Level-1 ("reports
 * to no one"), never clears the stale value (the auto-clear effect only runs
 * when manager options exist, and for Level-1 they are always []), and then
 * aborts the save with "A Level-1 (CEO) employee cannot have a reporting
 * manager." Even the server PUT would 400: the echoed stale manager runs
 * into validateReportingLink's (correct, unchanged) Level-1 rule. The fix
 * normalises the manager to null whenever the target role is Level 1 — in
 * the client form state/payload AND in the server create/update handlers —
 * so a stale link self-heals on any save (the update's chain recompute then
 * removes the ghost from derived data).
 *
 * Fix B (organogram-review leftover): a Head can head MULTIPLE departments
 * (one primary + additional seats in `department_members`), but a manager
 * candidate only counted as "same department" via their PRIMARY department —
 * so staff in a Head's additional department could not pick him. A candidate
 * is now in the employee's department when that department is the
 * candidate's primary department OR one of their additional (active
 * membership) departments. Level window (1–2 up), active-only, no-self,
 * cycle and the Level-1 cross-department exception are unchanged.
 *
 * Pinned here on the REAL chain (runMigrations + seedRoles + default
 * grants, real HTTP endpoints) plus pure-function pins for the bulk-import
 * validator and the hierarchy health computation.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
import {
  normalizeUserBulkRow,
  buildReferenceMaps,
  validateBulkRows,
} from '../routes/userBulkImport.js';
import { computeHierarchyHealth } from '../utils/hierarchyHealth.js';
// Sign with the server's own secret constant (captured by shared.ts at
// import time) so the token always matches what requireAuth verifies with.
import { JWT_SECRET } from '../routes/production/shared.js';

const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Hierarchy: CEO edit deadlock + additional-department managers', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let deptA = '';
  let deptB = '';
  let deptC = '';
  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://integration-test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    await applyDefaultRoleAccess();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  const makeDept = async (name: string, code: string) => {
    const res = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name, code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id as string;
  };

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');

    deptA = await makeDept('Sales', 'SALES');
    deptB = await makeDept('Retail', 'RETAIL');
    deptC = await makeDept('Corporate', 'CORPORATE');
  });

  const addUserRaw = (body: Record<string, any>) =>
    request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(body);

  const addUser = async (
    employeeId: string,
    role: string,
    opts: { departmentId?: string; departmentIds?: string[]; managerId?: string } = {}
  ) => {
    const res = await addUserRaw({
      employeeId,
      fullName: `Person ${employeeId}`,
      email: `${employeeId.toLowerCase()}@test.com`,
      role,
      departmentId: opts.departmentId ?? deptA,
      ...(opts.departmentIds ? { departmentIds: opts.departmentIds } : {}),
      ...(opts.managerId ? { managerId: opts.managerId } : {}),
      status: 'Active',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const userRow = (id: string) =>
    pool.query(
      `SELECT id, employee_id, manager_id, department_id, reporting_chain, subordinates FROM users WHERE id = $1`,
      [id]
    ).then((r: any) => r.rows[0]);

  /** Guarantee the extra membership seat exists (primary + additional). */
  const ensureSeat = async (userId: string, departmentId: string, isPrimary: boolean) => {
    await pool.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (department_id, user_id) DO UPDATE SET is_active = TRUE`,
      [departmentId, userId, isPrimary]
    );
  };

  /* ------------------------------------------------------------ */
  /*  Fix A — Level-1 edit deadlock                                */
  /* ------------------------------------------------------------ */

  it('A1. editing a CEO with a stale stored manager succeeds, clears the link and recomputes the ghost away', async () => {
    const ceo = await addUser('CEO1', 'CEO', { departmentId: deptA });
    const mgr = await addUser('MGR1', 'MANAGER', { departmentId: deptA, managerId: ceo.id });

    // Legacy dirt: the CEO row carries a manager link from before the
    // ladder rules existed (exactly the state migration 053 deliberately
    // did NOT rewrite — it only repairs derived columns).
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [mgr.id, ceo.id]);
    assert.equal((await userRow(ceo.id)).manager_id, mgr.id);

    // The real client echoes the stale value in the save payload (the form
    // loads it from the record and offers no picker to clear it).
    const res = await request(app)
      .put(`/api/users/${ceo.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId: 'CEO1',
        fullName: 'Person CEO1',
        name: 'Person CEO1',
        email: 'ceo1@test.com',
        role: 'CEO',
        departmentId: deptB,
        departmentIds: [deptB],
        status: 'Active',
        managerId: 'MGR1',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await userRow(ceo.id);
    assert.equal(row.manager_id, null, 'stale manager link must be cleared for a Level-1 user');
    assert.equal(row.department_id, deptB, 'the actual edit (department move) must land');
    assert.deepEqual(row.reporting_chain ?? [], [], 'CEO chain stays empty');

    // The recompute that already runs on update removes the ghost: the
    // stale manager no longer lists the CEO among their subordinates.
    const mgrRow = await userRow(mgr.id);
    assert.ok(!(mgrRow.subordinates || []).includes('CEO1'), 'CEO must drop out of the stale manager\'s subordinates');
  });

  it('A2. creating a CEO with a stray manager value normalises it to nobody', async () => {
    const ceo = await addUser('CEO1', 'CEO', { departmentId: deptA });
    const mgr = await addUser('MGR1', 'MANAGER', { departmentId: deptA, managerId: ceo.id });

    const res = await addUserRaw({
      employeeId: 'CEO2',
      fullName: 'Second Chief',
      email: 'ceo2@test.com',
      role: 'CEO',
      departmentId: deptA,
      managerId: mgr.employeeId ?? 'MGR1',
      status: 'Active',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await userRow(res.body.data.id);
    assert.equal(row.manager_id, null);
  });

  it('A3. normalisation is Level-1 only: a Level 3 employee still cannot be saved without a manager', async () => {
    const ceo = await addUser('CEO1', 'CEO', { departmentId: deptA });
    const mgr = await addUser('MGR1', 'MANAGER', { departmentId: deptA, managerId: ceo.id });
    const tl = await addUser('TL1', 'TEAM_LEAD', { departmentId: deptA, managerId: mgr.id });

    const res = await request(app)
      .put(`/api/users/${tl.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId: 'TL1',
        fullName: 'Person TL1',
        email: 'tl1@test.com',
        role: 'TEAM_LEAD',
        departmentId: deptA,
        status: 'Active',
        managerId: '',
      });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.message || ''), /reporting manager is required/i);
    // Rolled back: the stored manager survives.
    assert.equal((await userRow(tl.id)).manager_id, mgr.id);
  });

  /* ------------------------------------------------------------ */
  /*  Fix B — manager eligibility via additional departments       */
  /* ------------------------------------------------------------ */

  const buildMultiDeptHead = async () => {
    const ceo = await addUser('CEO1', 'CEO', { departmentId: deptA });
    // Head: primary seat in Sales (A), additional seat in Retail (B).
    const head = await addUser('HEAD1', 'MANAGER', {
      departmentId: deptA,
      departmentIds: [deptA, deptB],
      managerId: ceo.id,
    });
    await ensureSeat(head.id, deptA, true);
    await ensureSeat(head.id, deptB, false);
    return { ceo, head };
  };

  it('B1. an employee in the Head\'s additional department can report to him', async () => {
    const { head } = await buildMultiDeptHead();
    const tl = await addUser('TLB1', 'TEAM_LEAD', { departmentId: deptB, managerId: head.id });
    assert.equal((await userRow(tl.id)).manager_id, head.id);
  });

  it('B2. reporting-options for the additional department include the multi-department Head', async () => {
    const { head } = await buildMultiDeptHead();
    const res = await request(app)
      .get('/api/users/reporting-options')
      .query({ role: 'TEAM_LEAD', departmentId: deptB })
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = (res.body as any[]).map((o: any) => o.employeeId);
    assert.ok(ids.includes('HEAD1'), `expected HEAD1 in options, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(head.employeeId ?? 'HEAD1'));
  });

  it('B3. a department the Head holds NO seat in is accepted since UM-1 (warning, not a block)', async () => {
    const { head } = await buildMultiDeptHead();
    // Before UM-1 this was a 400 ("same department"). The cross-
    // department link now saves; hierarchy health flags it as a warning.
    const res = await addUserRaw({
      employeeId: 'TLC1',
      fullName: 'Person TLC1',
      email: 'tlc1@test.com',
      role: 'TEAM_LEAD',
      departmentId: deptC,
      managerId: head.id,
      status: 'Active',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await userRow(res.body.data.id);
    assert.equal(row.manager_id, head.id);
  });

  it('B4. a DOWN-the-ladder manager is accepted since UM-1 (warning, not a block)', async () => {
    const { head } = await buildMultiDeptHead();
    const tl = await addUser('TLB1', 'TEAM_LEAD', { departmentId: deptB, managerId: head.id });
    const be = await addUser('BE1', 'BE', { departmentId: deptB, managerId: tl.id });
    // EMPLOYEE (L4) -> BE (L5) is DOWN the ladder. Before UM-1: rejected
    // by the 1–2 level window. Now: accepted (health warning only).
    const res = await addUserRaw({
      employeeId: 'EMPB1',
      fullName: 'Person EMPB1',
      email: 'empb1@test.com',
      role: 'EMPLOYEE',
      departmentId: deptB,
      managerId: be.id,
      status: 'Active',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('B5. bulk import: additional-department manager validates; a no-seat department is a warning since UM-1', () => {
    const maps = buildReferenceMaps({
      roles: [
        { id: 'r-ceo', role_code: 'CEO', role_name: 'Chief Executive Officer', hierarchy_level: 1 },
        { id: 'r-mgr', role_code: 'MANAGER', role_name: 'Manager', hierarchy_level: 2 },
        { id: 'r-tl', role_code: 'TEAM_LEAD', role_name: 'Team Lead', hierarchy_level: 3 },
      ],
      departments: [
        { id: 'dept-a', department_code: 'SALES', department_name: 'Sales' },
        { id: 'dept-b', department_code: 'RETAIL', department_name: 'Retail' },
        { id: 'dept-c', department_code: 'CORP', department_name: 'Corporate' },
      ],
      teams: [],
      existingUsers: [
        {
          id: 'u-head',
          employee_id: 'HEAD1',
          email: 'head1@test.com',
          role_id: 'r-mgr',
          department_id: 'dept-a',
          team_id: null,
          manager_id: null,
          is_active: true,
          role_code: 'MANAGER',
          hierarchy_level: 2,
          // The Head's additional seat in Retail — the loader attaches the
          // active memberships exactly like this.
          department_ids: ['dept-b'],
        } as any,
      ],
      allUsers: [{ id: 'u-head', employee_id: 'HEAD1', manager_id: null }],
    });

    const rowInB = normalizeUserBulkRow({
      rowNumber: 1,
      employeeId: 'NEWB1',
      fullName: 'New In B',
      email: 'newb1@test.com',
      department: 'Retail',
      role: 'TEAM_LEAD',
      reportingManagerEmployeeId: 'HEAD1',
      status: 'Active',
    });
    const okRes = validateBulkRows({ rows: [rowInB], maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: true } });
    assert.equal(okRes.rows[0].isValid, true, JSON.stringify(okRes.rows[0].errors));

    const rowInC = normalizeUserBulkRow({
      rowNumber: 1,
      employeeId: 'NEWC1',
      fullName: 'New In C',
      email: 'newc1@test.com',
      department: 'Corporate',
      role: 'TEAM_LEAD',
      reportingManagerEmployeeId: 'HEAD1',
      status: 'Active',
    });
    const badRes = validateBulkRows({ rows: [rowInC], maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: true } });
    // UM-1: the cross-department link no longer fails the row — it
    // imports with a warning the admin sees in the validate report.
    assert.equal(badRes.rows[0].isValid, true, JSON.stringify(badRes.rows[0].errors));
    assert.match(badRes.rows[0].warnings.join(' '), /different department/i);
  });

  it('B6. hierarchy health: an additional-department link is NOT flagged as a wrong-department problem', () => {
    const health = computeHierarchyHealth(
      [
        {
          id: 'u-ceo',
          employee_id: 'CEO1',
          full_name: 'Chief',
          manager_id: null,
          department_id: 'dept-a',
          is_active: true,
          role_code: 'CEO',
        },
        {
          id: 'u-head',
          employee_id: 'HEAD1',
          full_name: 'Head One',
          manager_id: 'u-ceo',
          department_id: 'dept-a',
          department_ids: ['dept-a', 'dept-b'],
          is_active: true,
          role_code: 'MANAGER',
        },
        {
          id: 'u-tl',
          employee_id: 'TLB1',
          full_name: 'Lead In B',
          manager_id: 'u-head',
          department_id: 'dept-b',
          is_active: true,
          role_code: 'TEAM_LEAD',
        },
      ] as any,
      new Map([
        ['CEO', 1],
        ['MANAGER', 2],
        ['TEAM_LEAD', 3],
      ])
    );
    assert.deepEqual(health.invalidLinks, [], JSON.stringify(health.invalidLinks));
    // A seat-backed link is not even a warning: the manager's additional
    // department seat makes it a same-department link (UM-1 warnings
    // respect seats exactly like the old hard rule did).
    assert.deepEqual(health.warnings, [], JSON.stringify(health.warnings));
    assert.equal(health.usersWithoutManager, 0);
  });
});
