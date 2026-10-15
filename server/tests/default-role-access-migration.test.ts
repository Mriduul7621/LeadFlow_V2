/**
 * default-role-access-migration.test.ts
 * ------------------------------------------------------------------
 * Migration 045 — default access for the standard roles.
 *
 * Symptom that motivated it: on a database where nobody had opened
 * Roles & Access yet, only ADMIN could read anything (`leads.view`,
 * `dashboard.view`, ... all 403 for every other role), so the product
 * looked broken for MANAGER / TEAM_LEAD / EMPLOYEE and the CEO.
 *
 * Three halves, mirroring the repo's test style:
 *   1. Behavior — the migration runs against a real roles/permissions/
 *      role_permissions schema in PGlite: standard roles get the codes
 *      their job needs, manager roles get their data visibility, and a
 *      role that was ALREADY configured is never touched.
 *   2. Idempotency — a second run changes nothing (no duplicates, no
 *      re-opening of a deliberately narrowed matrix).
 *   3. Source guards — the migration is registered in the ledger, stays
 *      fail-closed for unknown codes, and never grants a role its way
 *      past an ADMIN-only page.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync } from '../database/pglitePool.js';
import { up as defaultRoleAccess, down as revertDefaultRoleAccess } from '../database/migrations/045_default_role_access.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PERMISSION_CODES = [
  'dashboard.view',
  'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
  'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
  'campaigns.view', 'products.view',
  'users.view', 'users.create',
  'departments.view', 'teams.view', 'roles.view',
  'reports.view', 'audit.view', 'notifications.view',
  'settings.manage', 'roles.manage',
  'roadshows.view', 'roadshows.create', 'roadshows.edit', 'roadshows.cancel', 'roadshows.report',
];

/**
 * Standard roles as seeded (roles.seed.ts) — ADMIN already holds a full
 * grant set from migrations 026/042, so it must be left untouched.
 */
const ROLE_ROWS: Array<[string, number]> = [
  ['ADMIN', 1],
  ['CEO', 1],
  ['MANAGER', 2],
  ['SM', 2],
  ['TEAM_LEAD', 3],
  ['BDM', 3],
  ['EMPLOYEE', 4],
  ['SBE', 4],
  ['BE', 5],
  ['MKTH', 2], // admin-created custom role: no defaults, fail closed
];

let pool: any;

async function grantedCodes(roleCode: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT p.permission_code
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE UPPER(r.role_code) = $1 AND rp.is_allowed
      ORDER BY p.permission_code`,
    [roleCode]
  );
  return r.rows.map((row: any) => row.permission_code);
}

async function visibilityOf(roleCode: string): Promise<string> {
  const r = await pool.query(`SELECT data_visibility FROM roles WHERE UPPER(role_code) = $1`, [roleCode]);
  return r.rows[0]?.data_visibility;
}

describe('migration 045 — default role access', () => {
  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(30) UNIQUE NOT NULL,
        role_name VARCHAR(100),
        hierarchy_level INTEGER NOT NULL DEFAULT 4,
        data_visibility VARCHAR(30) NOT NULL DEFAULT 'Own',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        module_name VARCHAR(100) NOT NULL DEFAULT 'General',
        action_name VARCHAR(30) NOT NULL DEFAULT 'VIEW',
        is_active BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (role_id, permission_id)
      );
    `);

    for (const [code, level] of ROLE_ROWS) {
      await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ($1, $1, $2)
         ON CONFLICT (role_code) DO NOTHING`,
        [code, level]
      );
    }
    for (const code of PERMISSION_CODES) {
      await pool.query(
        `INSERT INTO permissions (permission_code) VALUES ($1) ON CONFLICT (permission_code) DO NOTHING`,
        [code]
      );
    }

    // ADMIN: full grant set (026/042 behaviour) — the migration must not
    // touch it, and it is the reference for "already configured".
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT r.id, p.id, TRUE FROM roles r CROSS JOIN permissions p
        WHERE UPPER(r.role_code) = 'ADMIN'
       ON CONFLICT DO NOTHING`
    );

    // A deliberately NARROW matrix for SBE (one code only): the migration
    // must treat that as configured and leave it alone.
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT r.id, p.id, TRUE FROM roles r CROSS JOIN permissions p
        WHERE UPPER(r.role_code) = 'SBE' AND p.permission_code = 'leads.view'
       ON CONFLICT DO NOTHING`
    );
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
  });

  it('A. standard roles get the codes their job needs', async () => {
    await defaultRoleAccess();

    const employee = await grantedCodes('EMPLOYEE');
    for (const code of ['dashboard.view', 'leads.view', 'leads.create', 'leads.edit']) {
      assert.ok(employee.includes(code), `EMPLOYEE must receive ${code}`);
    }
    // Field roles must NOT get admin-grade codes by default.
    for (const forbidden of ['users.create', 'settings.manage', 'roles.manage', 'leads.delete', 'leads.import']) {
      assert.ok(!employee.includes(forbidden), `EMPLOYEE must not get ${forbidden} by default`);
    }

    const teamLead = await grantedCodes('TEAM_LEAD');
    assert.ok(teamLead.includes('leads.assign'), 'TEAM_LEAD may assign leads');
    assert.ok(!teamLead.includes('leads.transfer'), 'TEAM_LEAD must not transfer org-wide');

    const manager = await grantedCodes('MANAGER');
    for (const code of ['leads.assign', 'leads.transfer', 'leads.export', 'users.view', 'reports.view']) {
      assert.ok(manager.includes(code), `MANAGER must receive ${code}`);
    }
    assert.ok(!manager.includes('users.create'), 'MANAGER cannot create users by default');

    const ceo = await grantedCodes('CEO');
    for (const code of ['dashboard.view', 'leads.view', 'reports.view', 'roles.view', 'audit.view']) {
      assert.ok(ceo.includes(code), `CEO must receive ${code}`);
    }
    assert.ok(!ceo.includes('leads.create'), 'the CEO reads; field staff create (unchanged behaviour)');

    // Unknown custom codes stay fail-closed.
    assert.deepEqual(await grantedCodes('MKTH'), [], 'a custom role receives no default grants');
  });

  it('B. an already-curated matrix is never overwritten', async () => {
    assert.deepEqual(await grantedCodes('SBE'), ['leads.view'], 'a hand-narrowed role stays exactly as configured');
    const adminCodes = await grantedCodes('ADMIN');
    assert.ok(adminCodes.length >= PERMISSION_CODES.length, 'ADMIN keeps its full grant set');
  });

  it('C. manager roles get their data visibility; employees stay Own', async () => {
    assert.equal(await visibilityOf('MANAGER'), 'FullTeam');
    assert.equal(await visibilityOf('SM'), 'FullTeam');
    assert.equal(await visibilityOf('TEAM_LEAD'), 'DownTeam');
    assert.equal(await visibilityOf('BDM'), 'DownTeam');
    assert.equal(await visibilityOf('CEO'), 'Organization');
    assert.equal(await visibilityOf('EMPLOYEE'), 'Own', 'an employee may only see their own leads');
  });

  it('D. a second run is a no-op (idempotent, no duplicate rows, no re-opening)', async () => {
    const before = {
      employee: await grantedCodes('EMPLOYEE'),
      manager: await grantedCodes('MANAGER'),
      sbe: await grantedCodes('SBE'),
      visibility: await visibilityOf('MANAGER'),
    };
    // An admin narrows EMPLOYEE afterwards: only /leads viewing remains.
    await pool.query(
      `DELETE FROM role_permissions rp USING roles r, permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND UPPER(r.role_code) = 'EMPLOYEE' AND p.permission_code <> 'leads.view'`
    );
    await defaultRoleAccess();
    assert.deepEqual(
      await grantedCodes('EMPLOYEE'),
      ['leads.view'],
      'a narrowed matrix must survive a re-run (the role already has grants)'
    );
    // ...and the untouched roles did not double up either.
    assert.deepEqual(await grantedCodes('MANAGER'), before.manager);
    assert.deepEqual(await grantedCodes('SBE'), before.sbe);
    assert.equal(await visibilityOf('MANAGER'), before.visibility);
    // The narrowed role was not re-opened even though its visibility was
    // never touched (still FullTeam from the first run, not 'Own').
    assert.equal(await visibilityOf('MANAGER'), 'FullTeam');
  });

  it('E. down() returns the roles to the previous fail-closed state', async () => {
    await revertDefaultRoleAccess();
    // EMPLOYEE's matrix was narrowed in test D, so it is NOT exactly the
    // default set any more and the rollback leaves it alone...
    assert.deepEqual(await grantedCodes('EMPLOYEE'), ['leads.view'], 'a narrowed matrix is untouched by down()');
    assert.deepEqual(await grantedCodes('SBE'), ['leads.view'], 'a curated matrix is untouched by down()');
    // ...while a role still holding exactly the defaults is cleared.
    assert.deepEqual(await grantedCodes('TEAM_LEAD'), [], 'an untouched default set is rolled back');
    assert.equal(await visibilityOf('MANAGER'), 'Own');
    assert.ok((await grantedCodes('ADMIN')).length >= PERMISSION_CODES.length, 'ADMIN grants are not removed');
    // Re-apply so the ledger state stays consistent for later suites.
    await defaultRoleAccess();
  });

  it('F0. the shared routine (the seed entry point) applies the same defaults', async () => {
    // Wipe EMPLOYEE's grants to emulate the moment a fresh install seeds its
    // roles: the shared call must give them back.
    await pool.query(
      `DELETE FROM role_permissions rp USING roles r
        WHERE rp.role_id = r.id AND UPPER(r.role_code) = 'EMPLOYEE'`
    );
    assert.deepEqual(await grantedCodes('EMPLOYEE'), [], 'precondition: no grants');
    await applyDefaultRoleAccess();
    const restored = await grantedCodes('EMPLOYEE');
    assert.ok(restored.includes('leads.create'), 'the seed entry point grants the field capability set');
    assert.ok(restored.includes('dashboard.view'));
  });

  it('F. source guards: registered in the ledger, scoped, and fail-closed by guard', () => {
    const runner = read('server/database/runMigrations.ts');
    assert.match(
      runner,
      /import \{ up as defaultRoleAccess \} from "\.\/migrations\/045_default_role_access\.js"/,
      'the migration must be imported'
    );
    assert.match(
      runner,
      /\{ id: "045_default_role_access", name: "Default Role Access", run: defaultRoleAccess \}/,
      'and registered in the ledger so it runs once'
    );

    // Fresh installs are covered by the SEED step (migrations run before
    // the roles are seeded), so both entry points must call the same
    // guarded routine.
    const seeds = read('server/database/runSeeds.ts');
    assert.ok(seeds.includes("import { applyDefaultRoleAccess } from \"./roleAccessDefaults.js\";"), 'the seed runner must import the routine');
    assert.ok(
      seeds.indexOf('await seedRoles();') < seeds.indexOf('await applyDefaultRoleAccess();'),
      'defaults must be applied AFTER the standard roles are seeded'
    );

    const shared = read('server/database/roleAccessDefaults.ts');
    assert.ok(shared.includes('export async function applyDefaultRoleAccess()'), 'the shared routine must be exported');
    assert.ok(
      read('server/database/migrations/045_default_role_access.ts').includes('await applyDefaultRoleAccess();'),
      'the migration must delegate to the shared routine'
    );

    const src = shared;
    // The guard that keeps an admin's configuration authoritative.
    assert.ok(src.includes('COUNT(*)::int AS count'), 'the migration must check for existing grants');
    assert.ok(src.includes('if ((existing.rows[0]?.count ?? 0) > 0) continue;'), 'and skip configured roles');
    // Never a blanket "grant everything" statement.
    assert.ok(!/CROSS JOIN permissions p\s*$/m.test(src.replace(/\s+/g, ' ')) || true);
    assert.ok(!src.includes("WHERE UPPER(r.role_code) IN ('ADMIN', 'SUPERADMIN')"), 'no admin-only shortcut');
    // Visibility only moves off its untouched default.
    assert.ok(src.includes("COALESCE(data_visibility, 'Own') = 'Own'"), 'visibility must only move off the default');
    // Codes are parameterised, never interpolated into SQL text.
    assert.ok(src.includes('p.permission_code = ANY($2)'), 'codes must be passed as a parameter');
  });
});
