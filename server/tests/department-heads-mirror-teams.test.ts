/**
 * department-heads-mirror-teams.test.ts
 * ------------------------------------------------------------------
 * F16 Phase C — the locked user-management model (design note §6):
 *
 *   one department = one MIRROR TEAM, auto-created and auto-renamed;
 *   membership follows the person's department, and MOVING someone closes
 *   the old membership instead of deleting it (history survives);
 *   at most ONE active primary head per department (enforced by a partial
 *   unique index, not by application discipline), plus any number of
 *   co-heads; the primary head leads the mirror team.
 *
 * The schema is the REAL fresh-install boot: the shipped migration runner
 * (001 → 046) followed by the shipped role catalogue. Hand-picked subsets
 * are how fixture drift happens — a suite that replayed five migrations
 * looked schema-correct while `users.account_status` (022/035) was missing,
 * and every write answered 500. ~3s on PGlite, so the whole chain runs.
 *
 * The same reasoning drives the ladder in `beforeEach`: with the REAL role
 * catalogue an in-ladder Level ≥ 2 employee cannot be created without a
 * manager one or two levels up in the same department, so every test starts
 * from the org root (a Level-1 CEO who reports to nobody and may sit across
 * departments) and builds downward from there.
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

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Department heads + mirror teams', () => {
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

    // 1) the shipped migration chain, through the shipped runner;
    // 2) the shipped role catalogue (fresh installs seed roles AFTER the
    //    migrations — migration 002 only creates the table).
    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();

    // users.role_id is NOT NULL, so the caller needs a real role row. The
    // JWT carries the role for this suite, so no grant rows are required:
    // ADMIN is the documented bypass in hasPermissionCode().
    const adminRole = await pool.query(
      `SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`
    );
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
    // The org root: Level 1, reports to nobody, may sit across departments.
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

  const setHeads = async (departmentId: string, primaryUserId: string | null, coHeadUserIds: string[] = []) =>
    request(app)
      .put(`/api/departments/${departmentId}/heads`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ primaryUserId, coHeadUserIds });

  const mirrorTeam = async (departmentId: string) =>
    (await pool.query(
      'SELECT * FROM teams WHERE department_id = $1 AND is_department_mirror LIMIT 1',
      [departmentId]
    )).rows[0];

  const membership = async (departmentId: string, userId: string) =>
    (await pool.query(
      'SELECT * FROM department_members WHERE department_id = $1 AND user_id = $2',
      [departmentId, userId]
    )).rows[0];

  const sorted = (ids: string[]) => [...ids].sort();

  it('creating a department creates its mirror team', async () => {
    const res = await saveDepartment({ name: 'Dhaka North', code: 'DHAKA_NORTH' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const departmentId = res.body.id;
    assert.ok(res.body.mirrorTeamId, 'the response must name the mirror team');

    const team = await mirrorTeam(departmentId);
    assert.ok(team, 'a mirror team must exist');
    assert.equal(team.team_name, 'Dhaka North', 'the mirror team carries the department name');
    assert.equal(team.member_ids.length, 0);
  });

  it('renaming a department renames its mirror team', async () => {
    const created = await saveDepartment({ name: 'Dhaka North', code: 'DHAKA_NORTH' });
    const renamed = await saveDepartment({ id: created.body.id, name: 'Dhaka North-West', code: 'DHAKA_NORTH' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

    const team = await mirrorTeam(created.body.id);
    assert.equal(team.team_name, 'Dhaka North-West');
    const count = await pool.query(
      'SELECT COUNT(*)::int AS n FROM teams WHERE department_id = $1 AND is_department_mirror',
      [created.body.id]
    );
    assert.equal(count.rows[0].n, 1, 'renaming must not spawn a second mirror team');
  });

  it('adding people to a department puts them on that department\'s team', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const manager = await addManager(dept.id, 'EMP100');
    const user = await addReport(dept.id, manager.id, 'EMP101');

    const member = await membership(dept.id, user.id);
    assert.ok(member, 'a primary membership must exist');
    assert.equal(member.is_primary, true);
    assert.equal(member.is_active, true);

    // The roster follows memberships, and the department's own manager is a
    // member of it too — the team a department head leads is the whole
    // department, not "everybody except the manager".
    const team = await mirrorTeam(dept.id);
    assert.deepEqual(sorted(team.member_ids), sorted([manager.id, user.id]));
  });

  it('moving a person between departments CLOSES the old membership and opens the new one', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    // A Level-2 manager reports to the Level-1 CEO, who is the one
    // cross-department link in the ladder — so a manager can be moved
    // between departments without breaking anybody's reporting line.
    const manager = await addManager(sales.id, 'EMP200');

    const moved = await request(app)
      .put(`/api/users/${manager.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentId: service.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const oldRow = await membership(sales.id, manager.id);
    assert.equal(oldRow.is_active, false, 'the previous membership must be closed');
    assert.ok(oldRow.left_at, 'and stamped with left_at (history preserved)');

    const newRow = await membership(service.id, manager.id);
    assert.equal(newRow.is_active, true);
    assert.equal(newRow.is_primary, true);

    assert.deepEqual((await mirrorTeam(sales.id)).member_ids, [], 'the old team loses the member');
    assert.deepEqual((await mirrorTeam(service.id)).member_ids, [manager.id], 'the new team gains them');
  });

  it('the primary head leads the mirror team; co-heads are heads but not leaders', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const head = await addManager(dept.id, 'EMP300');
    const coHead = await addReport(dept.id, head.id, 'EMP301', 'TEAM_LEAD');

    const res = await setHeads(dept.id, head.id, [coHead.id]);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const headRow = await membership(dept.id, head.id);
    assert.equal(headRow.is_head, true);
    assert.equal(headRow.is_primary_head, true);
    const coRow = await membership(dept.id, coHead.id);
    assert.equal(coRow.is_head, true);
    assert.equal(coRow.is_primary_head, false);

    const team = await mirrorTeam(dept.id);
    assert.equal(team.leader_id, head.id, 'the mirror team is led by the primary head');
  });

  it('the DATABASE refuses a second active primary head', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const a = await addManager(dept.id, 'EMP400');
    const b = await addManager(dept.id, 'EMP401');

    await setHeads(dept.id, a.id, []);

    await assert.rejects(
      () => pool.query(
        `UPDATE department_members SET is_primary_head = TRUE WHERE department_id = $1 AND user_id = $2`,
        [dept.id, b.id]
      ),
      /uq_department_primary_head|duplicate key/i,
      'the partial unique index must make two primary heads impossible'
    );
  });

  it('a head must be an active member of the department (no cross-department heads)', async () => {
    const sales = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const service = (await saveDepartment({ name: 'Service', code: 'SERVICE' })).body;
    const outsider = await addManager(service.id, 'EMP500');

    const res = await setHeads(sales.id, outsider.id, []);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body?.message || ''), /member of the department/i);
  });

  it('clearing the heads leaves the department headless without touching membership', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const head = await addManager(dept.id, 'EMP600');
    await setHeads(dept.id, head.id, []);

    const cleared = await setHeads(dept.id, null, []);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

    const row = await membership(dept.id, head.id);
    assert.equal(row.is_head, false);
    assert.equal(row.is_active, true, 'a former head stays a member');
    assert.equal((await mirrorTeam(dept.id)).leader_id, null, 'nobody leads the mirror team now');
  });

  it('deactivating a person closes their memberships and frees the team leadership', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const head = await addManager(dept.id, 'EMP700');
    await setHeads(dept.id, head.id, []);

    const off = await request(app)
      .put(`/api/users/${head.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive' });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    const row = await membership(dept.id, head.id);
    assert.equal(row.is_active, false);
    assert.ok(row.left_at, 'the departure is stamped, not erased');
    assert.equal((await mirrorTeam(dept.id)).leader_id, null, 'the mirror team must not keep an inactive leader');
    assert.deepEqual((await mirrorTeam(dept.id)).member_ids, [], 'and its roster must be empty');
  });

  it('the mirror team is a visible team but not an editable one', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    await addManager(dept.id, 'EMP900');
    const mirror = await mirrorTeam(dept.id);

    // GET /api/teams lists it (transparency: the team a department head
    // leads is a real team) and flags it as department-managed.
    const list = await request(app).get('/api/teams').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const row = list.body.find((team: any) => team.id === mirror.id);
    assert.ok(row, 'the mirror team must be listed');
    assert.equal(row.isDepartmentMirror, true);

    // …but the generic team endpoints refuse to touch it: the department (and
    // its rename) is the single source of truth for that team.
    const renamed = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ id: mirror.id, name: 'Hacked', code: 'HACKED', departmentId: dept.id });
    assert.equal(renamed.status, 400, JSON.stringify(renamed.body));
    assert.match(String(renamed.body?.message || ''), /managed by its department/i);

    const deleted = await request(app)
      .delete(`/api/teams/${mirror.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(deleted.status, 400, JSON.stringify(deleted.body));

    const still = await pool.query('SELECT team_name FROM teams WHERE id = $1', [mirror.id]);
    assert.equal(still.rows[0]?.team_name, 'Sales', 'the mirror team survives both attempts');
  });

  it('GET /departments reports the heads, the counts and the mirror team', async () => {
    const dept = (await saveDepartment({ name: 'Sales', code: 'SALES' })).body;
    const head = await addManager(dept.id, 'EMP800');
    await addReport(dept.id, head.id, 'EMP801');
    await setHeads(dept.id, head.id, []);

    const list = await request(app).get('/api/departments').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(list.status, 200);
    const row = list.body.find((d: any) => d.id === dept.id);
    assert.ok(row, 'the department must be listed');
    assert.equal(row.primaryHead?.id, head.id);
    assert.equal(row.primaryHead?.employeeId, 'EMP800');
    assert.equal(row.headCount, 1);
    assert.equal(row.memberCount, 2, 'both the head and the member count');
    assert.ok(row.mirrorTeamId, 'the mirror team id is reported');
  });
});
