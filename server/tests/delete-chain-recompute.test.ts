/**
 * Organogram fix 3 of 3 — deleting a user must maintain the reporting
 * chain exactly the way editing one does.
 *
 * The bug (organogram review): PUT /api/users/:id recomputes
 * reporting_chain / subordinates server-side after every write, but
 * DELETE /api/users/:id did not — it relied on the manager_id foreign
 * key (ON DELETE SET NULL) and left everything derived behind:
 *
 *   - the deleted person's direct reports became manager-less
 *     (manager_id NULLed by the FK, nobody re-pointed them);
 *   - their stored reporting_chain kept naming the deleted employee
 *     (a ghost), and because resolveUplineRecipients PREFERS the
 *     stored chain, SLA escalation silently skipped the dead level;
 *   - the deleted employee kept appearing in their former manager's
 *     subordinates (the downline source for visibility).
 *
 * What is pinned here, on the REAL chain (runMigrations 001→053 +
 * seedRoles + default grants, real HTTP endpoints):
 *
 *   A. Deleting a middle manager re-points their reports to the
 *      deleted user's own manager (skip-level), recomputes every
 *      derived chain, and writes the move into the delete's audit row.
 *   B. A delete blocked by the existing lead guard changes NOTHING.
 *   C. Deleting a leaf user leaves the rest of the chain intact
 *      (apart from the leaf dropping out of subordinates).
 *   D. Deleting the top of the chain leaves the next level cleanly
 *      top-level (manager NULL, empty chain).
 *   E. Migration 053 repairs already-stale derived chains in place
 *      (ghost employee ids derived from manager_id reality) and is
 *      idempotent; it never rewrites source manager_id links.
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
import { resolveUplineRecipients } from '../services/NotificationService.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as repair053 } from '../database/migrations/053_delete_chain_repair.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('User delete recomputes the reporting chain (organogram fix 3)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let deptId = '';
  let ceo: any;
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

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');

    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    deptId = dept.body.id;

    ceo = await addUser('CEO1', 'CEO');
  });

  const addUser = async (employeeId: string, role: string, managerId?: string) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId,
        fullName: `Person ${employeeId}`,
        email: `${employeeId.toLowerCase()}@test.com`,
        role,
        departmentId: deptId,
        managerId: role === 'CEO' ? undefined : managerId,
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  /** CEO1 -> MGR1 -> (TL1 -> EMP1, TL2). The chain the review used. */
  const buildChain = async () => {
    const mgr = await addUser('MGR1', 'MANAGER', ceo.id);
    const tl1 = await addUser('TL1', 'TEAM_LEAD', mgr.id);
    const tl2 = await addUser('TL2', 'TEAM_LEAD', mgr.id);
    const emp = await addUser('EMP1', 'EMPLOYEE', tl1.id);
    return { mgr, tl1, tl2, emp };
  };

  const userRow = (id: string) =>
    pool.query(
      `SELECT id, employee_id, manager_id, reporting_chain, subordinates FROM users WHERE id = $1`,
      [id]
    ).then((r: any) => r.rows[0]);

  const chainOf = async (id: string) => (await userRow(id))?.reporting_chain ?? null;
  const subsOf = async (id: string) => (await userRow(id))?.subordinates ?? null;

  const ghostMentions = async (employeeId: string) => {
    const rows = await pool.query(
      `SELECT employee_id, reporting_chain, subordinates FROM users WHERE employee_id <> $1`,
      [employeeId]
    );
    let mentions = 0;
    for (const row of rows.rows) {
      if ((row.reporting_chain || []).includes(employeeId)) mentions++;
      if ((row.subordinates || []).includes(employeeId)) mentions++;
    }
    const hier = await pool.query(`SELECT COUNT(*)::int AS n FROM hierarchies WHERE path LIKE $1`, [`%${employeeId}%`]);
    return mentions + (hier.rows[0]?.n ?? 0);
  };

  /* ---------------------------------------------------------------- */
  it('A. deleting a middle manager re-points reports skip-level and recomputes every derived chain', async () => {
    const { mgr, tl1, tl2, emp } = await buildChain();

    // Fixture sanity: the derived chains the create path produced.
    assert.deepEqual(await chainOf(tl1.id), ['MGR1', 'CEO1']);
    assert.deepEqual(await chainOf(emp.id), ['TL1', 'MGR1', 'CEO1']);

    const res = await request(app)
      .delete(`/api/users/${mgr.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The user is gone.
    assert.equal(await userRow(mgr.id), undefined);

    // Reports inherit the deleted user's own manager — nobody is
    // left manager-less while a manager exists above.
    assert.equal((await userRow(tl1.id)).manager_id, ceo.id);
    assert.equal((await userRow(tl2.id)).manager_id, ceo.id);

    // Every derived chain reflects reality — no ghost anywhere.
    assert.deepEqual(await chainOf(tl1.id), ['CEO1']);
    assert.deepEqual(await chainOf(tl2.id), ['CEO1']);
    assert.deepEqual(await chainOf(emp.id), ['TL1', 'CEO1']);
    assert.equal(await ghostMentions('MGR1'), 0, 'no chain/subordinates/hierarchy path may still name the deleted user');

    // The former manager's downline (the visibility source) now runs
    // through the re-pointed reports, not through the ghost.
    const ceoSubs = await subsOf(ceo.id);
    assert.ok(ceoSubs.includes('TL1') && ceoSubs.includes('TL2') && ceoSubs.includes('EMP1'));
    assert.ok(!ceoSubs.includes('MGR1'));

    // SLA escalation consumer: the stored chain is authoritative, so
    // EMP1's upline must resolve live people, direct manager first.
    const recipients = await resolveUplineRecipients(pool, emp.id, 'EMP1');
    assert.deepEqual(recipients.map(r => r.employeeId), ['TL1', 'CEO1']);

    // The delete's audit row records the re-pointing.
    const audit = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action_code = 'user-deleted' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(audit.rows.length, 1, 'a delete that re-points reports writes a user-deleted audit row');
    assert.equal(audit.rows[0].metadata.employeeId, 'MGR1');
    assert.equal(audit.rows[0].metadata.reportsRepointed, 2);
    assert.equal(audit.rows[0].metadata.reportsNewManagerEmployeeId, 'CEO1');
  });

  /* ---------------------------------------------------------------- */
  it('B. a delete blocked by the lead guard re-points nothing and recomputes nothing', async () => {
    const { mgr, tl1 } = await buildChain();
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ('lead_mgr1', 'Mgr Customer', '01710000901', $1, $1, $1, $1, 'New')`,
      [mgr.id]
    );

    const res = await request(app)
      .delete(`/api/users/${mgr.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'LEADS_REQUIRE_TRANSFER');

    // Everything is exactly as it was.
    assert.ok(await userRow(mgr.id), 'the blocked delete must not remove the user');
    assert.equal((await userRow(tl1.id)).manager_id, mgr.id);
    assert.deepEqual(await chainOf(tl1.id), ['MGR1', 'CEO1']);
  });

  /* ---------------------------------------------------------------- */
  it('C. deleting a leaf user leaves the rest of the chain intact', async () => {
    const { mgr, tl1, tl2, emp } = await buildChain();

    const res = await request(app)
      .delete(`/api/users/${tl2.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(await userRow(tl2.id), undefined);
    assert.equal((await userRow(tl1.id)).manager_id, mgr.id);
    assert.deepEqual(await chainOf(tl1.id), ['MGR1', 'CEO1']);
    assert.deepEqual(await chainOf(emp.id), ['TL1', 'MGR1', 'CEO1']);
    const mgrSubs = await subsOf(mgr.id);
    assert.ok(mgrSubs.includes('TL1') && mgrSubs.includes('EMP1'));
    assert.ok(!mgrSubs.includes('TL2'), 'the leaf drops out of subordinates');
    assert.equal(await ghostMentions('TL2'), 0);

    // No transfer and no re-pointing happened, so the delete keeps
    // its previous audit footprint (no user-deleted row).
    const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action_code = 'user-deleted'`);
    assert.equal(audit.rows[0].n, 0);
  });

  /* ---------------------------------------------------------------- */
  it('D. deleting the top of the chain leaves the next level cleanly top-level', async () => {
    const { mgr, tl1, emp } = await buildChain();

    const res = await request(app)
      .delete(`/api/users/${ceo.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const mgrRow = await userRow(mgr.id);
    assert.equal(mgrRow.manager_id, null, 'reports of a deleted top-level user become top-level');
    assert.deepEqual(mgrRow.reporting_chain, []);
    assert.deepEqual(await chainOf(tl1.id), ['MGR1']);
    assert.deepEqual(await chainOf(emp.id), ['TL1', 'MGR1']);
    assert.equal(await ghostMentions('CEO1'), 0);
  });

  /* ---------------------------------------------------------------- */
  it('E. migration 053 repairs already-stale derived chains and is idempotent', async () => {
    assert.equal(
      MIGRATION_IDS[MIGRATION_IDS.length - 1],
      '053_delete_chain_repair',
      'migration 053 is registered as the tail'
    );
    const { mgr, tl1, emp } = await buildChain();

    // Simulate production staleness left by pre-fix deletes: derived
    // columns naming an employee who no longer exists. The SOURCE
    // manager_id links are correct and must not be rewritten.
    await pool.query(`UPDATE users SET reporting_chain = '["GHOST9","MGR1","CEO1"]' WHERE id = $1`, [tl1.id]);
    await pool.query(`UPDATE users SET reporting_chain = '["TL1","GHOST9","CEO1"]' WHERE id = $1`, [emp.id]);
    await pool.query(`UPDATE users SET subordinates = '["GHOST9"]' WHERE id = $1`, [ceo.id]);

    await repair053();
    assert.deepEqual(await chainOf(tl1.id), ['MGR1', 'CEO1']);
    assert.deepEqual(await chainOf(emp.id), ['TL1', 'MGR1', 'CEO1']);
    const ceoSubs = await subsOf(ceo.id);
    assert.ok(!ceoSubs.includes('GHOST9'));
    assert.ok(ceoSubs.includes('MGR1') && ceoSubs.includes('TL1') && ceoSubs.includes('EMP1'));
    assert.equal((await userRow(tl1.id)).manager_id, mgr.id, 'the repair derives from manager_id, never rewrites it');
    assert.equal(await ghostMentions('GHOST9'), 0);

    // Idempotent: a second run changes nothing.
    const snapshot = async () =>
      (await pool.query(`SELECT employee_id, manager_id, reporting_chain, subordinates FROM users ORDER BY employee_id`)).rows;
    const before = await snapshot();
    await repair053();
    assert.deepEqual(await snapshot(), before);
  });
});
