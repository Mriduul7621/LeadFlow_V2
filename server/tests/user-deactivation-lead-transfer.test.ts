/**
 * Phase E — a person is never switched off (or removed) while they still own
 * open leads.
 *
 * These tests exercise the REAL shipped chain — `runMigrations()` (001→046) +
 * `seedRoles()` + the default role grants — and drive the same HTTP endpoints
 * the UI uses, so what is pinned here is the product behaviour, not a
 * re-implementation of it:
 *
 *   PUT    /api/users/:id      { status: 'Inactive' }            -> 409
 *   PUT    /api/users/:id      { status: 'Inactive', transferLeadsTo }
 *   DELETE /api/users/:id?transferLeadsTo=...
 *   GET    /api/users                                            -> openLeadCount
 *   GET    /api/hierarchy-config                                 -> ownership
 *
 * The industry checklist this implements is freeze -> export -> reassign ->
 * deactivate, with the reassignment made by a HUMAN: the API refuses without a
 * target and never picks one on its own.
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

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Deactivation requires transferring open leads (Phase E)', () => {
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

    // A Level-1 root per department keeps the in-ladder manager chain valid
    // (a Level-2 manager must report to somebody 1–2 levels up, in the SAME
    // department — see reportingRules.ts).
    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    const ceo = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId: 'CEO1', fullName: 'Chief Executive', email: 'ceo@test.com',
        role: 'CEO', departmentId: dept.body.id, status: 'Active',
      });
    assert.equal(ceo.status, 201, JSON.stringify(ceo.body));
    ceoId = ceo.body.data.id;
    deptId = dept.body.id;
  });

  let deptId = '';

  /**
   * A person in the Sales department. The default role is MANAGER (Level 2)
   * because the ladder rule (reportingRules.ts) only lets a Level-2 employee
   * report to the Level-1 root — an EMPLOYEE would need a Level-3 manager
   * first, which is irrelevant to what these tests are about.
   */
  const addUser = async (employeeId: string, role = 'MANAGER', managerId?: string) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId,
        fullName: `Person ${employeeId}`,
        email: `${employeeId.toLowerCase()}@test.com`,
        role,
        departmentId: deptId,
        managerId: role === 'CEO' ? undefined : (managerId || ceoId),
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const addLead = async (mobile: string, ownerId: string, status = 'New') => {
    const res = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5) RETURNING id`,
      [`lead_${mobile}`, `Customer ${mobile}`, mobile, ownerId, status]
    );
    return res.rows[0].id;
  };

  const leadOwner = (mobile: string) =>
    pool.query(
      `SELECT l.assigned_to, l.previous_assigned_to, l.assignment_history, u.employee_id AS owner_employee_id
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.mobile = $1`,
      [mobile]
    ).then((r: any) => r.rows[0]);

  const isActive = (userId: string) =>
    pool.query(`SELECT is_active FROM users WHERE id = $1`, [userId]).then((r: any) => r.rows[0]?.is_active);

  it('refuses a deactivation that would strand leads, and changes nothing', async () => {
    const owner = await addUser('EMP100');
    const keeper = await addUser('EMP101');
    await addLead('01710000001', owner.id);
    await addLead('01710000002', owner.id, 'Contacted');
    await addLead('01710000003', owner.id, 'Converted'); // finished business

    const res = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive' });

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'LEADS_REQUIRE_TRANSFER');
    assert.equal(res.body.leadCount, 2, 'only the OPEN leads count');
    assert.equal(res.body.leads.length, 2);
    assert.ok(res.body.leads.every((l: any) => l.currentStatus !== 'Converted'));
    assert.ok(
      res.body.suggestions.some((s: any) => s.employeeId === 'EMP101'),
      'same-department colleagues are offered first'
    );
    assert.ok(res.body.suggestions.some((s: any) => s.isManager === true), 'their manager is flagged as a suggestion');

    // Nothing moved: account, membership and every lead are untouched.
    assert.equal(await isActive(owner.id), true);
    assert.equal((await leadOwner('01710000001')).owner_employee_id, 'EMP100');
    assert.equal((await leadOwner('01710000002')).owner_employee_id, 'EMP100');
    assert.equal(
      (await pool.query(
        `SELECT COUNT(*)::int AS c FROM department_members WHERE user_id = $1 AND is_active`,
        [owner.id]
      )).rows[0].c,
      1,
      'the department membership is still open'
    );
    assert.ok(keeper.id);
  });

  it('transfers the open leads, keeps the history and deactivates the account', async () => {
    const owner = await addUser('EMP200');
    const successor = await addUser('EMP201');
    await addLead('01720000001', owner.id);
    await addLead('01720000002', owner.id, 'Contacted');
    const finishedId = await addLead('01720000003', owner.id, 'Not Interested');

    const res = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'EMP201' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transfer.transferred, 2);
    assert.equal(res.body.transfer.toEmployeeId, 'EMP201');
    assert.equal(res.body.data.status, 'Inactive');
    assert.equal(res.body.data.openLeadCount, 0, 'the deactivated person owns nothing open any more');

    assert.equal(await isActive(owner.id), false);

    // Ownership moved with an append-only history entry in the canonical shape.
    for (const mobile of ['01720000001', '01720000002']) {
      const row = await leadOwner(mobile);
      assert.equal(row.owner_employee_id, 'EMP201', `${mobile} moved to the successor`);
      assert.equal(String(row.previous_assigned_to), String(owner.id));
      assert.ok(Array.isArray(row.assignment_history) && row.assignment_history.length === 1, 'one entry appended');
      const entry = row.assignment_history[0];
      assert.equal(entry.fromEmployeeId, 'EMP200');
      assert.equal(entry.toEmployeeId, 'EMP201');
      assert.equal(entry.changedBy, 'ADMIN1', 'the actor is recorded, not the person being deactivated');
      assert.ok(entry.date && !Number.isNaN(Date.parse(entry.date)), 'the change is timestamped');
      assert.match(String(entry.note), /deactivated/i);
    }

    // Finished business stays where it is — a closed lead is not somebody
    // else's problem.
    const finished = await pool.query(
      `SELECT l.assigned_to, u.employee_id AS owner_employee_id, l.assignment_history
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = $1`,
      [finishedId]
    );
    assert.equal(finished.rows[0].owner_employee_id, 'EMP200');
    assert.deepEqual(finished.rows[0].assignment_history, []);

    // The new owner is told, through the same notification path a manual
    // reassignment uses.
    const notes = await pool.query(
      `SELECT title, event_type, lead_code FROM notifications WHERE user_id = $1 ORDER BY created_at ASC`,
      [successor.id]
    );
    assert.equal(notes.rows.length, 2, JSON.stringify(notes.rows));
    assert.ok(notes.rows.every((n: any) => n.event_type === 'lead-reassigned'));

    // …and the deactivation itself is in the access ledger.
    const audit = await pool.query(
      `SELECT action_code, target_user_id, metadata FROM audit_logs WHERE action_code = 'user-deactivated'`
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(String(audit.rows[0].target_user_id), String(owner.id));
    assert.equal(Number(audit.rows[0].metadata.transferredLeads), 2);
    assert.equal(audit.rows[0].metadata.transferTargetEmployeeId, 'EMP201');

    // Phase C still holds: the department membership closed on the way out.
    const membership = await pool.query(
      `SELECT is_active, left_at FROM department_members WHERE user_id = $1`,
      [owner.id]
    );
    assert.equal(membership.rows[0]?.is_active, false);
    assert.ok(membership.rows[0]?.left_at);
  });

  it('a deactivation with nothing to hand over needs no target at all', async () => {
    const owner = await addUser('EMP300');
    await addLead('01730000001', owner.id, 'Converted');
    await addLead('01730000002', owner.id, 'Not Interested');

    const res = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transfer, undefined, 'no transfer is reported when nothing had to move');
    assert.equal(await isActive(owner.id), false);
  });

  it('the successor must be an active colleague who is not the departing person', async () => {
    const owner = await addUser('EMP400');
    const dormant = await addUser('EMP401');
    await addLead('01740000001', owner.id);

    // Somebody who is already switched off cannot be given a live book.
    const toDormant = await request(app)
      .put(`/api/users/${dormant.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive' });
    assert.equal(toDormant.status, 200, JSON.stringify(toDormant.body));

    const refusedDormant = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'EMP401' });
    assert.equal(refusedDormant.status, 400, JSON.stringify(refusedDormant.body));
    assert.match(String(refusedDormant.body.message), /deactivated/i);

    const refusedSelf = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'EMP400' });
    assert.equal(refusedSelf.status, 400, JSON.stringify(refusedSelf.body));

    const refusedUnknown = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'GHOST99' });
    assert.equal(refusedUnknown.status, 400, JSON.stringify(refusedUnknown.body));

    assert.equal(await isActive(owner.id), true, 'every refusal left the account alone');
    assert.equal((await leadOwner('01740000001')).owner_employee_id, 'EMP400');
  });

  it('removing an account has the same rule, and the same hand-over', async () => {
    const owner = await addUser('EMP500');
    const successor = await addUser('EMP501');
    await addLead('01750000001', owner.id);

    const refused = await request(app)
      .delete(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'LEADS_REQUIRE_TRANSFER');
    assert.equal(refused.body.leadCount, 1);
    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE id = $1`, [owner.id])).rows[0].c,
      1,
      'the refused removal deleted nothing'
    );

    const removed = await request(app)
      .delete(`/api/users/${owner.id}?transferLeadsTo=EMP501`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.transfer.transferred, 1);

    const row = await leadOwner('01750000001');
    assert.equal(row.owner_employee_id, 'EMP501');
    assert.equal(row.assignment_history.length, 1);
    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE id = $1`, [owner.id])).rows[0].c,
      0,
      'the account is gone'
    );
  });

  it('an already-deactivated owner can be cleaned up, and cannot be saved silently', async () => {
    const owner = await addUser('EMP600');
    const successor = await addUser('EMP601');
    await addLead('01760000001', owner.id);

    // Simulate the pre-Phase-E world: the account was switched off before the
    // rule existed, so the lead is already stranded. (This is exactly the
    // drift the health screen has to report.)
    await pool.query(`UPDATE users SET is_active = FALSE, account_status = 'INACTIVE' WHERE id = $1`, [owner.id]);

    const silent = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', designation: 'Former Officer' });
    assert.equal(silent.status, 409, JSON.stringify(silent.body));
    assert.equal(silent.body.code, 'LEADS_REQUIRE_TRANSFER');

    const cleaned = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', designation: 'Former Officer', transferLeadsTo: 'EMP601' });
    assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
    assert.equal(cleaned.body.transfer.transferred, 1);
    assert.equal((await leadOwner('01760000001')).owner_employee_id, 'EMP601');
    assert.equal(successor.id.length > 0, true);
  });

  it('an administrator may hand a book over without deactivating anybody', async () => {
    const owner = await addUser('EMP700');
    const successor = await addUser('EMP701');
    await addLead('01770000001', owner.id);

    const res = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ transferLeadsTo: 'EMP701' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'Active');
    assert.equal(res.body.transfer.transferred, 1);
    assert.equal((await leadOwner('01770000001')).owner_employee_id, 'EMP701');
  });

  it('the roster carries every person\'s open-lead count, and the health screen names the stranded ones', async () => {
    const owner = await addUser('EMP800');
    const successor = await addUser('EMP801');
    await addLead('01780000001', owner.id);
    await addLead('01780000002', owner.id, 'Contacted');
    await addLead('01780000003', owner.id, 'Converted');

    const roster = await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(roster.status, 200);
    const row = roster.body.find((u: any) => u.employeeId === 'EMP800');
    assert.equal(row.openLeadCount, 2, 'finished leads are not counted as open');
    assert.equal(roster.body.find((u: any) => u.employeeId === 'EMP801').openLeadCount, 0);

    let cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.equal(cfg.ownership.available, true);
    assert.deepEqual(cfg.ownership.inactiveOwnersWithOpenLeads, [], 'nobody is stranded yet');
    assert.equal(cfg.ownership.totalOpenLeads, 2);

    // Now strand them the way legacy data would have.
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [owner.id]);
    cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(
      cfg.ownership.inactiveOwnersWithOpenLeads.map((o: any) => [o.employeeId, o.openLeadCount]),
      [['EMP800', 2]]
    );

    // The advertised fix works: open the person, pick a successor, save.
    const fixed = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'EMP801' });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    cfg = (await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${adminToken()}`)).body;
    assert.deepEqual(cfg.ownership.inactiveOwnersWithOpenLeads, [], 'the drift is gone');
    assert.equal(
      (await pool.query(
        `SELECT COUNT(*)::int AS c FROM leads l JOIN users u ON u.id = l.assigned_to
          WHERE u.employee_id = 'EMP801' AND l.is_deleted = FALSE AND l.current_status <> ALL($1::text[])`,
        [['Converted', 'Not Interested']]
      )).rows[0].c,
      2
    );
    assert.ok(successor.id);
  });

  it('a notification failure never blocks the deactivation (best-effort, transaction-safe)', async () => {
    // LAST in the file on purpose: it removes a table from the shared fixture.
    const owner = await addUser('EMP900');
    const successor = await addUser('EMP901');
    await addLead('01790000001', owner.id);
    await pool.query('DROP TABLE IF EXISTS notifications');

    const res = await request(app)
      .put(`/api/users/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive', transferLeadsTo: 'EMP901' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transfer.transferred, 1);
    assert.equal(res.body.transfer.notified, 0, 'the failed notification is reported, not hidden');
    assert.equal(await isActive(owner.id), false);
    assert.equal((await leadOwner('01790000001')).owner_employee_id, 'EMP901', 'the hand-over still happened');
  });
});
