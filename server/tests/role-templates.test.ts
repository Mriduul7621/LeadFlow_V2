/**
 * Phase F — role templates: one source of truth, and it is the ROLE.
 * ------------------------------------------------------------------
 * A "template" is the classic place where a permission layer quietly grows a
 * second copy of itself: a stored list of "what a manager can do" that starts
 * life identical to the Manager role and then drifts, month after month, until
 * the picker offers an entitlement set no role ever had. F16 §3.3 records that
 * failure mode; this suite exists to make it impossible.
 *
 * What is pinned here, on the real chain (001→047 + seeds):
 *
 *   1. a BASELINE template is DERIVED, never stored — it is byte-for-byte what
 *      the shipped role holds right now, so editing the role edits the baseline
 *   2. a SAVED template is a snapshot of what the role holds at save time, and
 *      it is read from the DATABASE — a client cannot post grants into existence
 *   3. **applying a template is a client-side fill of the role editor**: the
 *      template endpoints change NO role, NO grant and NO person. Nothing is
 *      granted until an administrator saves the role through the one existing
 *      write path
 *   4. the guards: roles.manage only, duplicate names refused, baselines
 *      cannot be deleted (there is no row to delete) — with a message that says
 *      so instead of a bare 404.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Phase F — role templates', () => {
  let pool: any;
  let app: express.Express;

  let adminId = '';
  let officerId = '';
  let managerRoleId = '';

  const adminT = () => signToken({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' });
  const officerT = () => signToken({ id: officerId, employeeId: 'OFFICER1', role: 'OFFICER', email: 'officer@test.com', name: 'Officer' });

  /** What the MANAGER role holds in the database right now. */
  async function managerGrantsFromDb(): Promise<string[]> {
    const res = await pool.query(
      `SELECT p.permission_code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND rp.is_allowed = TRUE
        ORDER BY p.permission_code ASC`,
      [managerRoleId]
    );
    return res.rows.map((r: any) => String(r.permission_code));
  }

  async function getTemplates(): Promise<any[]> {
    const res = await request(app).get('/api/role-templates').set('Authorization', `Bearer ${adminT()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.templates;
  }

  const find = (templates: any[], id: string) => {
    const found = templates.find(t => t.id === id || t.name === id);
    assert.ok(found, `template ${id} must be listed: ${templates.map(t => t.id).join(', ')}`);
    return found;
  };

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
    const { seedRoles } = await import('../database/seeds/roles.seed.js');
    const { applyDefaultRoleAccess } = await import('../database/roleAccessDefaults.js');
    await seedRoles();
    await applyDefaultRoleAccess();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    const managerRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'MANAGER' LIMIT 1`);
    managerRoleId = managerRole.rows[0].id;

    const officerRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active)
       VALUES ('OFFICER', 'Officer', 5, 'Own', TRUE) RETURNING id`
    );
    const officer = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('OFFICER1', 'Officer One', 'officer@test.com', 'x', $1, TRUE) RETURNING id`,
      [officerRole.rows[0].id]
    );
    officerId = officer.rows[0].id;

    const appMod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', appMod.default);
  });

  after(async () => {
    _resetPoolsForTest();
    await closePool();
  });

  it('a baseline template IS the role: derived live, nothing stored', async () => {
    const storedBefore = await pool.query(`SELECT COUNT(*)::int AS n FROM role_templates`);
    const templates = await getTemplates();

    const manager = find(templates, 'system:MANAGER');
    assert.deepEqual([...manager.grants].sort(), await managerGrantsFromDb(), 'baseline grants must equal the live role grants');
    assert.equal(manager.source, 'system');
    assert.equal(manager.roleCode, 'MANAGER');

    const roleRow = await pool.query(`SELECT data_visibility, menu_access FROM roles WHERE id = $1`, [managerRoleId]);
    assert.equal(manager.dataVisibility, roleRow.rows[0].data_visibility);
    assert.deepEqual(manager.menuAccess, roleRow.rows[0].menu_access || {});

    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM role_templates`)).rows[0].n,
      storedBefore.rows[0].n,
      'listing baselines must not write rows — a stored copy is exactly the drift this design rejects'
    );
  });

  it('ADMIN / SUPERADMIN are never offered as a starting point', async () => {
    const templates = await getTemplates();
    assert.equal(templates.some(t => String(t.roleCode || '').toUpperCase() === 'ADMIN'), false);
    assert.equal(templates.some(t => String(t.roleCode || '').toUpperCase() === 'SUPERADMIN'), false);
    assert.ok(templates.length > 0, 'every other shipped role is offered');
  });

  it('editing the role edits its baseline in the same breath (the drift fix)', async () => {
    const before = find(await getTemplates(), 'system:MANAGER');
    // leads.delete is a canonical code MANAGER does NOT hold by default (it can
    // clean its own list, not remove records) — so granting it MUST show up.
    assert.equal(before.grants.includes('leads.delete'), false, 'fixture assumption: MANAGER cannot delete leads by default');

    const granted = await request(app)
      .put('/api/roles/MANAGER/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.delete', allowed: true }] });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));

    const after = find(await getTemplates(), 'system:MANAGER');
    assert.equal(after.grants.includes('leads.delete'), true,
      'a baseline that does not follow the role is a second source of truth — the whole point of deriving it live');
    assert.deepEqual([...after.grants].sort(), await managerGrantsFromDb());

    // put it back so the snapshot test below snapshots the seeded shape
    await request(app)
      .put('/api/roles/MANAGER/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.delete', allowed: false }] });
  });

  it('a saved template snapshots the role from the DATABASE — a client cannot invent grants', async () => {
    const rolesBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM roles`)).rows[0].n;
    const permRowsBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM role_permissions`)).rows[0].n;

    const res = await request(app)
      .post('/api/role-templates')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({
        name: 'Manager baseline v1',
        description: 'What a manager held on the day this was saved',
        fromRole: 'MANAGER',
        // A hostile/naive client asking for powers it never had: the server
        // reads the ROLE, so none of this may reach the snapshot.
        grants: ['users.delete', 'roles.manage', 'permissions.manage'],
        dataVisibility: 'Organization',
        menuAccess: { '/administration': true, '/users': true },
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const saved = res.body.data;
    assert.equal(saved.source, 'saved');
    assert.deepEqual([...saved.grants].sort(), await managerGrantsFromDb(), 'the snapshot is the role, not the request body');
    const roleVisibility = (await pool.query(`SELECT data_visibility FROM roles WHERE id = $1`, [managerRoleId])).rows[0].data_visibility;
    assert.equal(saved.dataVisibility, roleVisibility, 'the snapshot takes the role’s data scope as well');
    assert.equal(saved.grants.includes('users.delete'), false, 'a posted grant must not exist in the snapshot');
    assert.deepEqual(
      saved.menuAccess,
      (await pool.query(`SELECT menu_access FROM roles WHERE id = $1`, [managerRoleId])).rows[0].menu_access || {},
      'page set comes from the role row as well'
    );

    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM roles`)).rows[0].n, rolesBefore, 'saving a template creates no role');
    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM role_permissions`)).rows[0].n,
      permRowsBefore,
      'saving a template grants nothing to anybody'
    );
  });

  it('a second template may not reuse a name (an ambiguous picker is a worse bug than a rejected save)', async () => {
    const dupe = await request(app)
      .post('/api/role-templates')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ name: 'manager baseline v1', fromRole: 'MANAGER' });
    assert.equal(dupe.status, 409);
    assert.match(String(dupe.body.message), /already exists/i);
  });

  it('a saved snapshot stays as it was taken, even when the role moves on', async () => {
    await request(app)
      .put('/api/roles/MANAGER/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.delete', allowed: true }] });

    const templates = await getTemplates();
    const saved = templates.find(t => t.name === 'Manager baseline v1');
    const baseline = find(templates, 'system:MANAGER');
    assert.equal(saved.grants.includes('leads.delete'), false, 'a snapshot is a point in time — that is what an administrator asked for');
    assert.equal(baseline.grants.includes('leads.delete'), true, 'the baseline follows the role immediately');

    await request(app)
      .put('/api/roles/MANAGER/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.delete', allowed: false }] });
  });

  it('guards: roles.manage is required, bad input is 400, unknown role is 400', async () => {
    const forbidden = await request(app).get('/api/role-templates').set('Authorization', `Bearer ${officerT()}`);
    assert.equal(forbidden.status, 403, 'templates are an administrative surface');

    const noName = await request(app)
      .post('/api/role-templates')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ fromRole: 'MANAGER' });
    assert.equal(noName.status, 400);

    const noRole = await request(app)
      .post('/api/role-templates')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ name: 'Orphan template' });
    assert.equal(noRole.status, 400);

    const unknown = await request(app)
      .post('/api/role-templates')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ name: 'Ghost template', fromRole: 'NOT_A_ROLE' });
    assert.equal(unknown.status, 400);
  });

  it('deleting: a saved template goes away, a baseline says why it cannot', async () => {
    const templates = await getTemplates();
    const saved = templates.find(t => t.name === 'Manager baseline v1');

    const baselineDelete = await request(app)
      .delete('/api/role-templates/system:MANAGER')
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(baselineDelete.status, 404);
    assert.match(String(baselineDelete.body.message), /derived/i, 'the message must explain that there is no stored row');

    const removed = await request(app)
      .delete(`/api/role-templates/${saved.id}`)
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(removed.status, 200);
    assert.equal((await getTemplates()).some(t => t.id === saved.id), false);

    const again = await request(app)
      .delete(`/api/role-templates/${saved.id}`)
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(again.status, 404, 'deleting twice must not report success');
  });

  it('applying a template is a CLIENT action: the editor fills, nothing is written', () => {
    const source = read('src/modules/users/pages/UserManagement.tsx');
    const start = source.indexOf('const handleUseTemplate = (template: RoleTemplate)');
    assert.ok(start > 0, 'UserManagement must keep handleUseTemplate — the one place a template becomes a role draft');
    const body = source.slice(start, source.indexOf('\n  const handleSaveAsTemplate', start));
    assert.equal(/adminService\.\w+\(/.test(body), false, 'loading a template must not call the API — it fills the form');
    assert.equal(/apiRequest\(/.test(body), false);
    assert.match(body, /setRoleFormActions\(actions\)/, 'it must fill the canonical action map the editor saves through');
    assert.match(body, /setShowRoleForm\(true\)/, 'it must open the editor so the administrator sees every toggle');
    assert.match(body, /ACTION_PERMISSION_GROUPS\.forEach/, 'every canonical code must land in the map — granted or not (no invisible grants)');

    assert.match(source, /import EnterpriseAccessPanel from '..\/components\/EnterpriseAccessPanel'/, 'the Effective-Access screen must be the panel that ships, not a new copy');
    assert.match(source, /<EnterpriseAccessPanel/, 'the panel must be mounted');
    assert.match(source, /adminService\.getRoleTemplates\(\)/, 'the picker reads the template catalogue from the API');
  });
});
