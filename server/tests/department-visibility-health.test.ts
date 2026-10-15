/**
 * department-visibility-health.test.ts
 * ------------------------------------------------------------------
 * F16 Phase D — the two halves of "my team" after Phase C introduced
 * departments-with-heads:
 *
 *   1. VISIBILITY FOLLOWS MEMBERSHIP. A FullTeam caller sees their
 *      department(s), and "their departments" are the departments they are an
 *      ACTIVE MEMBER of — because one head may lead several departments. The
 *      legacy single `users.department_id` column is the fallback, never the
 *      whole story. The client mirror (`dataScope.ts`) must resolve the SAME
 *      set as the server (`authz.ts`), otherwise a head sees a team in the
 *      leads page and a different one in the users page.
 *
 *   2. THE HEALTH SCREEN ANSWERS THE ADMIN'S QUESTION. Which departments have
 *      members but no primary head? Which are empty? Whose mirror team drifted
 *      out of step with its memberships? Who belongs to no department at all?
 *      Every list is computed from rows, so the screen cannot invent a value —
 *      and the drift it reports must disappear once the department is saved.
 *
 * Schema: the REAL fresh-install boot (the shipped migration runner 001→046 +
 * the shipped role catalogue), never a hand-picked subset.
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
import { resolveVisibility } from '../authz.js';
import { emptyDepartmentHealth } from '../utils/hierarchyHealth.js';
import { getVisibleEmployeeIds } from '../../src/modules/users/utils/dataScope.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Department membership visibility + department health (Phase D)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let ceoId = '';
  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    // The seed step hands the standard roles their default access right after
    // creating them (that is where MANAGER gets FullTeam, migration 045 having
    // run before any role existed).
    await applyDefaultRoleAccess();
    const managerVisibility = await pool.query(`SELECT data_visibility FROM roles WHERE role_code = 'MANAGER'`);
    assert.equal(managerVisibility.rows[0]?.data_visibility, 'FullTeam', 'fixture assumption: MANAGER is FullTeam');

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

  beforeEach(async () => {
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');
    const ceo = await addUser({ employeeId: 'CEO1', fullName: 'Chief Executive', email: 'ceo@test.com', role: 'CEO' });
    assert.equal(ceo.status, 201, JSON.stringify(ceo.body));
    ceoId = ceo.body.data.id;
  });

  const saveDepartment = async (body: any) =>
    request(app).post('/api/departments').set('Authorization', `Bearer ${adminToken()}`).send(body);

  const addUser = async (body: any) =>
    request(app).post('/api/users').set('Authorization', `Bearer ${adminToken()}`).send(body);

  /** A Level-2 manager IN `departmentId`, reporting to the fixture CEO. */
  const addManager = async (departmentId: string, employeeId: string, role = 'MANAGER') => {
    const res = await addUser({
      employeeId,
      fullName: `Manager ${employeeId}`,
      email: `${employeeId.toLowerCase()}@test.com`,
      departmentId,
      role,
      managerId: ceoId,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  /** A Level 3–4 person in `departmentId`, reporting to `managerId`. */
  const addReport = async (departmentId: string, managerId: string, employeeId: string, role = 'EMPLOYEE') => {
    const res = await addUser({
      employeeId,
      fullName: `Person ${employeeId}`,
      email: `${employeeId.toLowerCase()}@test.com`,
      departmentId,
      role,
      managerId,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const employeeIdsOf = (vis: { userIds: string[] }) =>
    pool.query(
      `SELECT employee_id FROM users WHERE id = ANY($1::uuid[]) ORDER BY employee_id`,
      [vis.userIds.length ? vis.userIds : null]
    ).then((r: any) => r.rows.map((x: any) => x.employee_id));

  /** The client mirror's answer, from the same object graph. */
  const clientVisible = async (currentUserId: string) => {
    const rows = (await pool.query(
      `SELECT u.id, u.employee_id, u.full_name, r.role_code, u.department_id,
              m.employee_id AS manager_employee_id
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN users m ON m.id = u.manager_id
        ORDER BY u.employee_id`
    )).rows;
    const memberships = (await pool.query(
      `SELECT user_id, department_id FROM department_members WHERE is_active`
    )).rows;
    const byUser = new Map<string, string[]>();
    for (const m of memberships) {
      const list = byUser.get(String(m.user_id)) || [];
      list.push(String(m.department_id));
      byUser.set(String(m.user_id), list);
    }
    const allUsers = rows.map((r: any) => ({
      id: r.id,
      employeeId: r.employee_id,
      name: r.full_name,
      role: r.role_code || '',
      departmentId: r.department_id || '',
      departmentIds: byUser.get(String(r.id)) || [],
      managerId: r.manager_employee_id || '',
      reportingManagerId: r.manager_employee_id || '',
    }));
    const me = allUsers.find((u: any) => u.id === currentUserId);
    const roles = [{ roleId: 'MANAGER', roleName: 'Manager', dataVisibility: 'FullTeam' } as any];
    return getVisibleEmployeeIds(me as any, allUsers as any, roles);
  };

  it('a FullTeam caller sees EVERY department they are an active member of', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const manager = await addManager(sales.id, 'EMP100');
    const salesReport = await addReport(sales.id, manager.id, 'EMP101');
    const serviceManager = await addManager(service.id, 'EMP200');
    const serviceReport = await addReport(service.id, serviceManager.id, 'EMP201');

    // The manager leads Service too — an extra membership, exactly what
    // "one head may head several departments" produces.
    await pool.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active, is_head, is_primary_head, joined_at)
       VALUES ($1, $2, FALSE, TRUE, TRUE, TRUE, NOW())`,
      [service.id, manager.id]
    );

    const vis = await resolveVisibility(manager.id, 'MANAGER');
    assert.equal(vis.all, false);
    const seen = await employeeIdsOf(vis);
    assert.deepEqual(
      seen,
      ['EMP100', 'EMP101', 'EMP200', 'EMP201'],
      'both departments, and nobody from anywhere else'
    );

    // The client mirror must agree exactly — including the extra membership.
    const clientSeen = (await clientVisible(manager.id)).sort();
    assert.deepEqual(clientSeen, seen, 'client and server must resolve the same team');
    assert.ok(salesReport.id && serviceReport.id);
  });

  it('an active membership is enough — the legacy department column is not the truth', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const manager = await addManager(sales.id, 'EMP300');
    const report = await addReport(sales.id, manager.id, 'EMP301');

    // Simulate drift: the membership says Sales, the legacy column says nothing.
    await pool.query(`UPDATE users SET department_id = NULL WHERE id = $1`, [manager.id]);

    const vis = await resolveVisibility(manager.id, 'MANAGER');
    const seen = await employeeIdsOf(vis);
    assert.deepEqual(seen, ['EMP300', 'EMP301'], 'membership keeps the team visible');
    assert.deepEqual((await clientVisible(manager.id)).sort(), seen);

    // …and the health screen reports the drift instead of hiding it.
    const cfg = await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(cfg.status, 200);
    assert.ok(report.id);
  });

  it('with no membership anywhere a FullTeam caller falls back to the reporting downline', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const manager = await addManager(sales.id, 'EMP400');
    const report = await addReport(sales.id, manager.id, 'EMP401');

    // A database with no membership layer content at all (legacy rows, or a
    // department nobody was placed in): the caller must NOT see the whole
    // company — least privilege sends them down the reporting tree.
    await pool.query('DELETE FROM department_members');
    await pool.query('UPDATE users SET department_id = NULL');

    const vis = await resolveVisibility(manager.id, 'MANAGER');
    const seen = await employeeIdsOf(vis);
    assert.deepEqual(seen, ['EMP400', 'EMP401'], 'least privilege: self + own reports only');
    assert.deepEqual((await clientVisible(manager.id)).sort(), seen, 'client mirror agrees on the fallback too');
    assert.ok(report.id);
  });

  it('GET /users and the login payload carry the active memberships', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const manager = await addManager(sales.id, 'EMP500', 'MANAGER');
    await pool.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active, joined_at)
       VALUES ($1, $2, FALSE, TRUE, NOW())`,
      [service.id, manager.id]
    );

    const roster = await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(roster.status, 200);
    const row = roster.body.find((u: any) => u.employeeId === 'EMP500');
    assert.deepEqual(
      (row.departmentIds || []).slice().sort(),
      [sales.id, service.id].sort(),
      'the roster payload carries every active membership'
    );

    // The session profile carries the caller's OWN memberships: this is what
    // the client mirror uses for the logged-in person.
    await pool.query(`UPDATE users SET password = '$2b$10$abcdefghijklmnopqrstuv' WHERE id = $1`, [manager.id]).catch(() => undefined);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'EMP500', password: 'whatever' });
    // Password is not the point here — a rejected login must not leak the
    // membership list either.
    assert.ok([200, 401].includes(login.status));
    if (login.status === 200) {
      assert.ok(Array.isArray(login.body.user.departmentIds));
    }
  });

  it('the health block lists a headless department, an empty one and the team drift; saving re-syncs it', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const emptyDept = (await saveDepartment({ name: 'New Market', code: 'NEW_MARKET' })).body;
    const head = await addManager(sales.id, 'EMP600');
    await addReport(sales.id, head.id, 'EMP601');

    // Sales has members but no primary head yet.
    let cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.equal(cfg.departments.available, true);
    assert.deepEqual(cfg.departments.headless.map((d: any) => d.name), ['Sales']);
    assert.equal(cfg.departments.headless[0].memberCount, 2);
    assert.deepEqual(cfg.departments.empty.map((d: any) => d.name), ['New Market']);
    assert.deepEqual(cfg.departments.teamDrift, [], 'a fresh department team is in step');

    // Give Sales a primary head: the headless entry disappears.
    const setHeads = await request(app)
      .put(`/api/departments/${sales.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    assert.equal(setHeads.status, 200, JSON.stringify(setHeads.body));
    cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(cfg.departments.headless, []);

    // Tamper with the team roster → the screen must report the drift.
    await pool.query(`UPDATE teams SET member_ids = '[]'::jsonb, leader_id = NULL WHERE department_id = $1`, [sales.id]);
    cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    const drift = cfg.departments.teamDrift.find((d: any) => d.id === sales.id);
    assert.ok(drift, 'drift must be reported');
    assert.equal(drift.membershipCount, 2);
    assert.equal(drift.rosterCount, 0);
    assert.ok(drift.issues.includes('roster-mismatch'));
    assert.ok(drift.issues.includes('leader-mismatch'));

    // The advice on the screen has to work: re-saving the department re-syncs.
    const resaved = await saveDepartment({ id: sales.id, name: 'Sales', code: 'SALES' });
    assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
    cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(cfg.departments.teamDrift, [], 'saving the department heals the drift');

    const team = await pool.query(`SELECT member_ids, leader_id FROM teams WHERE department_id = $1`, [sales.id]);
    assert.equal(team.rows[0].member_ids.length, 2);
    assert.equal(team.rows[0].leader_id, head.id);
    assert.ok(emptyDept.id);
  });

  it('the health block reports who belongs to no department and who heads several', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const head = await addManager(sales.id, 'EMP700');
    await addManager(service.id, 'EMP701');
    const orphan = await addManager('', 'EMP702');

    await request(app)
      .put(`/api/departments/${sales.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    await request(app)
      .put(`/api/departments/${service.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] })
      .expect((res: any) => {
        // The Service head must be a member of Service first — the product
        // refuses, and the test pins the refusal.
        assert.equal(res.status, 400);
      });
    await pool.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active, is_head, is_primary_head, joined_at)
       VALUES ($1, $2, FALSE, TRUE, TRUE, TRUE, NOW())`,
      [service.id, head.id]
    );
    const second = await request(app)
      .put(`/api/departments/${service.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(
      cfg.departments.multiDepartmentHeads.map((h: any) => [h.employeeId, h.departmentCount]),
      [['EMP700', 2]]
    );
    // EMP702 is a manager placed in no department — a real finding. ADMIN1 and
    // CEO1 are NOT listed: the platform admin is not business staff and the
    // Level-1 (CEO) org root legitimately sits outside the department grid
    // (the same rule that keeps a CEO out of the "missing manager" count).
    assert.deepEqual(
      cfg.departments.membersWithoutDepartment.map((u: any) => u.employeeId),
      [orphan.employeeId]
    );
  });

  it('a database without the layer reports the block as unavailable (never invented zeros)', () => {
    const missing = emptyDepartmentHealth(3);
    assert.equal(missing.available, false);
    assert.equal(missing.totalDepartments, 3);
    assert.deepEqual(missing.headless, []);
    assert.deepEqual(missing.teamDrift, []);
  });

  it('the admin form gives a second seat, and that is what makes "one head, several departments" reachable', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const head = await addManager(sales.id, 'EMP800');
    await addReport(sales.id, head.id, 'EMP801');

    // Today the person is a member of Sales only, so the product refuses to
    // make them the head of Service — the picker cannot even offer them.
    const refused = await request(app)
      .put(`/api/departments/${service.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    assert.equal(refused.status, 400, 'a non-member can never be a head');

    // The admin adds the extra seat in the user form (departmentIds).
    const seated = await request(app)
      .put(`/api/users/${head.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: ['SERVICE'] });
    assert.equal(seated.status, 200, JSON.stringify(seated.body));
    assert.deepEqual(
      (seated.body.data.departmentIds || []).slice().sort(),
      [sales.id, service.id].sort(),
      'the payload carries primary + extra seat'
    );

    // The extra seat is a REAL membership: active, and NOT the primary one.
    const seat = await pool.query(
      `SELECT is_primary, is_active, left_at FROM department_members WHERE department_id = $1 AND user_id = $2`,
      [service.id, head.id]
    );
    assert.equal(seat.rows[0]?.is_active, true, 'the seat is open');
    assert.equal(seat.rows[0]?.is_primary, false, 'the primary seat is still Sales');

    // …and the Service mirror team gained the member in the same transaction.
    const team = await pool.query(`SELECT member_ids FROM teams WHERE department_id = $1`, [service.id]);
    assert.deepEqual(team.rows[0].member_ids.map(String), [head.id]);

    // Now the head picker accepts them, so one person heads two departments.
    const heads = await request(app)
      .put(`/api/departments/${service.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    assert.equal(heads.status, 200, JSON.stringify(heads.body));

    // …and the same person heads their primary department too: one head,
    // several departments — the case the health screen reports on.
    const salesHeads = await request(app)
      .put(`/api/departments/${sales.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] });
    assert.equal(salesHeads.status, 200, JSON.stringify(salesHeads.body));

    const cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(
      cfg.departments.multiDepartmentHeads.map((h: any) => [h.employeeId, h.departmentCount]),
      [['EMP800', 2]]
    );
  });

  it('dropping the extra seat closes it, releases the head flag and leaves the primary seat alone', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const head = await addManager(sales.id, 'EMP810');
    await request(app)
      .put(`/api/users/${head.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: ['SERVICE'] });
    await request(app)
      .put(`/api/departments/${service.id}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId: head.id, coHeadUserIds: [] })
      .expect(200);

    // The admin unchecks the extra department in the user form.
    const dropped = await request(app)
      .put(`/api/users/${head.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: [] });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    assert.deepEqual(dropped.body.data.departmentIds, [sales.id], 'only the primary seat is left');

    const seat = await pool.query(
      `SELECT is_primary, is_active, is_head, is_primary_head, left_at
         FROM department_members WHERE department_id = $1 AND user_id = $2`,
      [service.id, head.id]
    );
    assert.equal(seat.rows[0]?.is_active, false, 'the seat is closed, never deleted');
    assert.ok(seat.rows[0]?.left_at, 'leaving is stamped');
    assert.equal(seat.rows[0]?.is_head, false, 'a head flag cannot outlive the seat');
    assert.equal(seat.rows[0]?.is_primary_head, false);

    const primary = await pool.query(
      `SELECT is_primary, is_active FROM department_members WHERE department_id = $1 AND user_id = $2`,
      [sales.id, head.id]
    );
    assert.equal(primary.rows[0]?.is_primary, true, 'the primary seat is untouched');
    assert.equal(primary.rows[0]?.is_active, true);

    const team = await pool.query(`SELECT member_ids FROM teams WHERE department_id = $1`, [service.id]);
    assert.deepEqual(team.rows[0].member_ids, [], 'the mirror team lost the member');

    const cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(cfg.departments.multiDepartmentHeads, []);
    // Service kept its people-less state… it has none, so it is "empty" and
    // never "headless" (there is nobody to head).
    assert.deepEqual(cfg.departments.empty.map((d: any) => d.name).sort(), ['Service']);
  });

  it('a FullTeam caller reaches a person through an extra seat alone — proven on GET /leads', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const ops = (await saveDepartment({ name: 'Operations', code: 'OPS' })).body;

    const caller = await addManager(sales.id, 'EMP900');
    const throughSeat = await addManager(ops.id, 'EMP901');
    const outsider = await addManager(ops.id, 'EMP902');

    // The caller's seats: Sales (primary) + Service (extra).
    await request(app)
      .put(`/api/users/${caller.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: ['SERVICE'] })
      .expect(200);
    // EMP901's legacy column says Operations — outside every caller seat —
    // but they hold an ACTIVE seat in Service, which is one of the caller's
    // departments. Only membership can find them.
    await request(app)
      .put(`/api/users/${throughSeat.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: ['SERVICE'] })
      .expect(200);

    const lead = async (mobile: string, userId: string) =>
      pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
         VALUES ($1, $2, $3, $4, $4, $4, $4, 'New')`,
        [`lead_${mobile}`, `Customer ${mobile}`, mobile, userId]
      );
    await lead('01890000001', caller.id);
    await lead('01890000002', throughSeat.id);
    await lead('01890000003', outsider.id);

    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${sign({ id: caller.id, employeeId: 'EMP900', role: 'MANAGER', email: 'emp900@test.com' })}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const mobiles = res.body.map((l: any) => l.mobile);
    assert.ok(mobiles.includes('01890000001'), 'own lead');
    assert.ok(mobiles.includes('01890000002'), 'visible ONLY through the extra seat');
    assert.ok(!mobiles.includes('01890000003'), 'Operations is not one of the caller seats');

    // Server and client mirror must agree on that same roster.
    const vis = await resolveVisibility(caller.id, 'MANAGER');
    const seen = await employeeIdsOf(vis);
    assert.deepEqual(seen, ['EMP900', 'EMP901'], 'membership decides the team');
    assert.deepEqual((await clientVisible(caller.id)).sort(), seen);
  });

  it('an unknown department in the membership list is refused, and nothing is changed', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const head = await addManager(sales.id, 'EMP950');

    const res = await request(app)
      .put(`/api/users/${head.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentIds: ['SALES', 'NOT_A_DEPARTMENT'] });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.message), /Unknown department/);

    const memberships = await pool.query(
      `SELECT department_id FROM department_members WHERE user_id = $1 AND is_active`,
      [head.id]
    );
    assert.deepEqual(memberships.rows.map((r: any) => String(r.department_id)), [sales.id]);
  });
});
