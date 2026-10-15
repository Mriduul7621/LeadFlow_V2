/**
 * Phase F — the Effective-Access screen tells the truth.
 * ------------------------------------------------------------------
 * The screen exists to answer ONE question for an administrator ("what can
 * this person actually do?") while FOUR implementations can each answer it
 * differently:
 *
 *   1. `hasPermissionCode()`            — the security boundary (what happens)
 *   2. `GET /users/:id/effective-access` — the screen's payload (what is shown)
 *   3. `buildPermissionSheet()`         — the client's own self-check
 *   4. the retired EnterpriseAccessPanel — read `is_allowed` alone and ignored
 *                                           the person override entirely, which
 *                                           is the drift class F16 §3.1 records
 *
 * This suite boots the REAL chain (`runMigrations()` 001→047 + `seedRoles()` +
 * `applyDefaultRoleAccess()`), drives the real endpoints over supertest, and
 * asserts that for every combination of {no grant row, grant false, grant true}
 * × {no override, override false, override true} the screen's verdict is
 * IDENTICAL to what the boundary will do — including the two answers that are
 * easy to get wrong: a person-level DENY beats a role allow, and an allow with
 * NO row anywhere stays denied.
 *
 * A screen that disagrees with the boundary is worse than no screen: it hands
 * the administrator a false assurance during an access review.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { hasPermissionCode } from '../routes/production.routes.js';
import { resolveEffectivePermissions } from '../utils/effectiveAccess.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const CODE = 'leads.view';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Phase F — Effective Access parity with the enforcement path', () => {
  let pool: any;
  let app: express.Express;

  let adminId = '';
  let officerRoleId = '';
  let bobId = '';
  let permId = '';

  const adminT = () => signToken({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' });
  const bobT = () => signToken({ id: bobId, employeeId: 'BOB', role: 'OFFICER', email: 'bob@test.com', name: 'Bob' });
  const bobCaller = () => ({ id: bobId, role_id: officerRoleId, role_code: 'OFFICER', department_id: null } as any);

  /** Set the ROLE layer for the canonical code: absent / false / true. */
  async function setRoleGrant(state: 'absent' | 'false' | 'true'): Promise<void> {
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [officerRoleId, permId]);
    if (state === 'absent') return;
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, $3)`,
      [officerRoleId, permId, state === 'true']
    );
  }

  /** Set the PERSON layer: absent (no row) / false / true. */
  async function setOverride(state: 'absent' | 'false' | 'true'): Promise<void> {
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1 AND permission_id = $2`, [bobId, permId]);
    if (state === 'absent') return;
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason) VALUES ($1, $2, $3, 'phase F test')`,
      [bobId, permId, state === 'true']
    );
  }

  async function fetchScreen(): Promise<any> {
    const res = await request(app)
      .get(`/api/users/${bobId}/effective-access`)
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(res.status, 200, `effective-access must succeed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

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

    const officer = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active)
       VALUES ('OFFICER', 'Officer', 5, 'Own', TRUE) RETURNING id`
    );
    officerRoleId = officer.rows[0].id;
    const bob = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('BOB', 'Bob Officer', 'bob@test.com', 'x', $1, TRUE) RETURNING id`,
      [officerRoleId]
    );
    bobId = bob.rows[0].id;
    const perm = await pool.query(`SELECT id FROM permissions WHERE permission_code = $1 LIMIT 1`, [CODE]);
    assert.ok(perm.rows[0], `the ${CODE} permission must exist after seeding`);
    permId = perm.rows[0].id;

    const appMod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', appMod.default);
  });

  after(async () => {
    _resetPoolsForTest();
    await closePool();
  });

  it('every layer combination: the screen agrees with hasPermissionCode()', async () => {
    const seen: string[] = [];
    for (const role of ['absent', 'false', 'true'] as const) {
      for (const override of ['absent', 'false', 'true'] as const) {
        await setRoleGrant(role);
        await setOverride(override);

        // The boundary answers first — this is the truth the screen must report.
        const enforced = await hasPermissionCode(bobCaller(), CODE);
        const data = await fetchScreen();
        const row = (data.permissions || []).find((p: any) => p.code === CODE);
        assert.ok(row, `the screen must carry a row for ${CODE}`);

        seen.push(`role=${role} override=${override} -> ${enforced}`);
        assert.equal(
          row.allowed,
          enforced,
          `role=${role} override=${override}: the screen said ${row.allowed}, the boundary answers ${enforced}`
        );

        // The layer attribution has to be right, or the administrator "fixes"
        // the wrong thing: a person override always wins, and only a missing
        // role row is a default deny.
        if (override !== 'absent') {
          assert.equal(row.source, 'user-override', 'a person override decides, whatever the role says');
          assert.equal(row.overrideAllowed, override === 'true');
          assert.equal(row.roleAllowed, role === 'absent' ? null : role === 'true');
        } else if (role !== 'absent') {
          assert.equal(row.source, 'role-grant', 'a role row decides when nobody overrode it');
          assert.equal(row.roleAllowed, role === 'true');
          assert.equal(row.overrideAllowed, null, 'no override row must read as "follow the role", not as deny');
        } else {
          assert.equal(row.source, 'deny-default', 'nothing anywhere => denied by default (fail closed)');
          assert.equal(row.allowed, false);
        }
      }
    }
    assert.equal(seen.length, 9, 'the full 3x3 matrix must be exercised');

    // Leave the fixture in the state the later tests expect.
    await setRoleGrant('true');
    await setOverride('absent');
  });

  it('a person deny over a role allow is reported as the sharpest finding', async () => {
    await setRoleGrant('true');
    await setOverride('false');

    const enforced = await hasPermissionCode(bobCaller(), CODE);
    assert.equal(enforced, false, 'deny beats allow at the boundary');

    const data = await fetchScreen();
    const row = (data.permissions || []).find((p: any) => p.code === CODE);
    assert.equal(row.allowed, false);
    assert.equal(row.deniedOverAllow === true || data.warnings.join(' ').includes(CODE), true,
      'the screen must call out a deny-over-allow (it is the finding an access review exists to surface)');
    assert.ok(
      data.warnings.some((w: string) => w.includes(CODE)),
      `a deny-over-allow must appear in the warnings: ${JSON.stringify(data.warnings)}`
    );

    await setOverride('absent');
  });

  it('a no-op override is reported, not silently tolerated', async () => {
    await setRoleGrant('true');
    await setOverride('true');

    const data = await fetchScreen();
    const row = (data.permissions || []).find((p: any) => p.code === CODE);
    assert.equal(row.overrideIsNoop, true, 'an override that repeats the role changes nothing today');
    assert.ok(
      data.warnings.some((w: string) => w.includes('change nothing today')),
      'the screen must warn about overrides that only look meaningful'
    );

    await setOverride('absent');
  });

  it('the summary is arithmetic on the same rows the table shows', async () => {
    const data = await fetchScreen();
    const rows = data.permissions || [];
    assert.equal(data.summary.total, rows.length);
    assert.equal(data.summary.allowed, rows.filter((r: any) => r.allowed).length);
    assert.equal(data.summary.denied, rows.filter((r: any) => !r.allowed).length);
    assert.equal(data.summary.roleGrants, rows.filter((r: any) => r.roleAllowed === true).length);
    assert.equal(data.summary.overridesAllow, rows.filter((r: any) => r.overrideAllowed === true).length);
    assert.equal(data.summary.overridesDeny, rows.filter((r: any) => r.overrideAllowed === false).length);
    assert.ok(
      (data.permissions || []).some((r: any) => r.code === CODE && r.allowed === true),
      'the officer role must still hold the one grant this suite configured'
    );
  });

  it('the pages and the data scope shown are the role’s, not a guess', async () => {
    await pool.query(
      `UPDATE roles SET menu_access = $2::jsonb, data_visibility = 'DownTeam' WHERE id = $1`,
      [officerRoleId, JSON.stringify({ '/leads': true, '/more': true, '/administration': false })]
    );
    const data = await fetchScreen();
    assert.equal(data.role.dataVisibility, 'DownTeam');
    assert.deepEqual(
      data.pages,
      [
        { path: '/administration', allowed: false },
        { path: '/leads', allowed: true },
        { path: '/more', allowed: true },
      ].sort((a: any, b: any) => a.path.localeCompare(b.path))
    );
  });

  it('an admin bypass is stated plainly instead of faked as a permission list', async () => {
    const adminRow = await pool.query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE UPPER(r.role_code) = 'ADMIN' LIMIT 1`
    );
    const res = await request(app)
      .get(`/api/users/${adminRow.rows[0].id}/effective-access`)
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role.isAdminBypass, true);
    assert.equal(res.body.data.role.dataVisibility, 'Organization', 'admin visibility is organization-wide, whatever the role row says');
    assert.ok(
      res.body.data.warnings.some((w: string) => w.includes('bypasses the permission matrix')),
      'the screen must say that ADMIN does not go through the matrix at all'
    );
  });

  it('the review is admin-only and unknown people are 404, never an empty allow', async () => {
    const forbidden = await request(app)
      .get(`/api/users/${bobId}/effective-access`)
      .set('Authorization', `Bearer ${bobT()}`);
    assert.equal(forbidden.status, 403, 'a person must not read the full access review');

    const anon = await request(app).get(`/api/users/${bobId}/effective-access`);
    assert.equal(anon.status, 401);

    const missing = await request(app)
      .get(`/api/users/00000000-0000-0000-0000-000000000000/effective-access`)
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(missing.status, 404);
  });

  it('an ADMIN role reports EVERY canonical action as allowed, and a deny cannot be stored on it', async () => {
    // ADMIN bypasses the matrix (first branch of hasPermissionCode), so a screen
    // built from the stored rows would draw unchecked boxes describing the
    // opposite of what happens. The read derives the truth instead.
    const before = await request(app)
      .get('/api/roles/ADMIN/permissions')
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.adminBypass, true, 'the payload says why everything is allowed');
    assert.ok(before.body.data.length > 20, 'the full canonical matrix is listed');
    assert.equal(
      before.body.data.every((r: any) => r.allowed === true),
      true,
      'every action of a bypassing role is allowed'
    );

    // Try to store a deny on ADMIN — the write must coerce it to the truth.
    const wrote = await request(app)
      .put('/api/roles/ADMIN/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.view', allowed: false }] });
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
    assert.equal(wrote.body.adminBypass, true);

    const after = await request(app)
      .get('/api/roles/ADMIN/permissions')
      .set('Authorization', `Bearer ${adminT()}`);
    const leadsView = after.body.data.find((r: any) => r.code === 'leads.view');
    assert.equal(leadsView.allowed, true, 'a deny on a bypassing role can never be the stored answer');

    // and the boundary agrees — an ADMIN really can still read leads
    const adminUser = await pool.query(`SELECT id, role_id FROM users WHERE UPPER(employee_id) = 'ADMIN1' LIMIT 1`);
    const can = await hasPermissionCode(
      { id: adminUser.rows[0].id, role_id: adminUser.rows[0].role_id, role_code: 'ADMIN', department_id: null } as any,
      'leads.view'
    );
    assert.equal(can, true, 'hasPermissionCode allows a bypassing role before any grant row is read');

    // a NON-bypassing role is untouched by the coercion
    const officerWrite = await request(app)
      .put('/api/roles/OFFICER/permissions')
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: [{ code: 'leads.view', allowed: false }] });
    assert.equal(officerWrite.status, 200);
    assert.equal(officerWrite.body.adminBypass, false);
    const officerRead = await request(app)
      .get('/api/roles/OFFICER/permissions')
      .set('Authorization', `Bearer ${adminT()}`);
    assert.equal(
      officerRead.body.data.find((r: any) => r.code === 'leads.view').allowed,
      false,
      'a normal role keeps its real deny'
    );
  });

  it('the resolver is pure: it never invents a code and never trusts a malformed row', () => {
    const empty = resolveEffectivePermissions([]);
    assert.deepEqual(empty.permissions, []);
    assert.equal(empty.summary.total, 0);

    const junk = resolveEffectivePermissions([
      { permission_code: '', is_allowed: true },
      { is_allowed: true } as any,
      null as any,
      { permission_code: 'leads.view', is_allowed: true, has_role_grant: false },
      { permission_code: 'leads.delete', is_allowed: true, has_role_grant: true },
    ]);
    assert.deepEqual(junk.permissions.map(p => p.code), ['leads.view', 'leads.delete']);
    assert.equal(junk.permissions[0].allowed, false, 'a row with no grant row anywhere stays denied');
    assert.equal(junk.permissions[0].source, 'deny-default');
    assert.equal(junk.permissions[1].allowed, true);
    assert.equal(junk.permissions[1].source, 'role-grant');
  });
});
