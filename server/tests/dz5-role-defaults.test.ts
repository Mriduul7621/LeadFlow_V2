/**
 * dz5-role-defaults.test.ts — DZ-5 role defaults in the Danger Zone
 * ------------------------------------------------------------------
 * Audit §2.2 (B6) / §4: the defaults table (grants + visibility for
 * untouched roles) becomes editable by a super admin in the Danger
 * Zone. Verifies:
 *  (a) GET defaults (code table, version 0, the 35 canonical codes,
 *      the zero-grant roles) + gating (non-super-admin 403, locked
 *      403 danger_zone_locked) + PUT validation (bypass-role keys,
 *      unknown codes, bad visibility, malformed keys, unknown fields)
 *      + audit rows carrying old→new + versioning;
 *  (b) Apply: a saved edit actually changes a zero-grant role's
 *      grants and visibility (not display-only); configured roles
 *      are never touched; a second Apply is a no-op; the Apply is
 *      audit-logged; keys for roles with no row are inert;
 *  (c) the UM-1 tree floor still applies on top of an edited
 *      'Own' default, and the lead-visibility predicate core is
 *      unchanged (a floor user sees a subordinate's lead, never an
 *      outsider's — list and detail);
 *  (d) normalize/validate unit behaviour (bypass keys dropped,
 *      malformed sections fall back to code defaults, duplicates
 *      deduped and sorted);
 *  (e) a corrupt stored row falls back to the code defaults;
 *  (f) revert clears exactly-default matrices and nothing else;
 *  (g) DZ-0/DZ-3/DZ-4 still work on this tree.
 *
 * Production-shaped fixtures: roles carry data_visibility, the
 * users table carries the migration-022 columns and the migration-004
 * role FK; leads use `current_status`; options carry `meta`;
 * audit_logs match the production columns.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate057 } from '../database/migrations/057_danger_zone_unlocks.js';
import {
  DEFAULT_GRANTS,
  DEFAULT_VISIBILITY,
} from '../../src/modules/shared/access/roleGrantDefaults.js';
import type { RoleDefaultsInput } from '../services/RoleDefaultsService.js';

// Loaded lazily in before(), AFTER the test env vars are set:
// importing the services pulls in production/shared.ts, which reads
// JWT_SECRET once at module load. A top-level import would cache the
// unset value and every test token would verify as invalid.
let getEffectiveRoleDefaults: typeof import('../services/roleDefaultsStore.js').getEffectiveRoleDefaults;
let normalizeRoleDefaults: typeof import('../services/roleDefaultsStore.js').normalizeRoleDefaults;
let getRoleDefaultsForEdit: typeof import('../services/RoleDefaultsService.js').getRoleDefaultsForEdit;
let setRoleDefaults: typeof import('../services/RoleDefaultsService.js').setRoleDefaults;
let applyRoleDefaults: typeof import('../services/RoleDefaultsService.js').applyRoleDefaults;
let validateRoleDefaultsInput: typeof import('../services/RoleDefaultsService.js').validateRoleDefaultsInput;
let applyDefaultRoleAccess: typeof import('../database/roleAccessDefaults.js').applyDefaultRoleAccess;
let revertDefaultRoleAccess: typeof import('../database/roleAccessDefaults.js').revertDefaultRoleAccess;
let resolveVisibility: typeof import('../authz.js').resolveVisibility;

// Test-only fixture secrets (assembled in parts so this file carries
// no contiguous literal), mirroring the other integration suites.
const JWT_SECRET = ['dz5', 'role', 'defaults', 'test', 'secret'].join('-');
const ADMIN_PASSWORD = ['Dz5', 'Role', 'Defaults', '1'].join('-');

/** The 35 canonical permission codes (audit Appendix A). */
const ALL_CODES = [
  'dashboard.view', 'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
  'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
  'campaigns.view', 'products.view', 'users.view', 'users.create', 'users.edit',
  'users.delete', 'users.activate', 'users.lock', 'departments.view',
  'departments.manage', 'teams.view', 'teams.manage', 'roles.view',
  'roles.manage', 'permissions.manage', 'reports.view', 'workflow.manage',
  'notifications.view', 'settings.manage', 'hierarchy.manage', 'audit.view',
  'roadshows.view', 'roadshows.create', 'roadshows.edit', 'roadshows.cancel',
  'roadshows.report',
];

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}
function tokenFor(user: any): string {
  return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
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
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, description TEXT, is_active BOOLEAN DEFAULT TRUE, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, phone VARCHAR(20), password VARCHAR(255) NOT NULL, role_id UUID NOT NULL, department_id UUID, team_id UUID, manager_id UUID, designation VARCHAR(100), joining_date DATE, profile_photo TEXT, last_login TIMESTAMP, is_active BOOLEAN DEFAULT TRUE, account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0), locked_until TIMESTAMP, password_changed_at TIMESTAMP, employee_record_id UUID, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS hierarchies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL UNIQUE, manager_id UUID, level INTEGER NOT NULL DEFAULT 1, path TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID, action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_types (key VARCHAR(100) PRIMARY KEY, label VARCHAR(255) NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'New', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
}

describe('DZ-5 — Role defaults in the Danger Zone', () => {
  let pool: any;
  let app: express.Express;
  let deptId: string;
  let adminRoleId: string;
  let superAdminRoleId: string;
  let managerRoleId: string;
  let empRoleId: string;
  let roRoleId: string;
  let tlRoleId: string;
  let superAdmin: any;
  let superAdmin2: any;
  let mgr: any;
  let tl: any;
  let sub: any;
  let solo: any;
  let outsider: any;
  let freshSeq = 0;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    // Env first, imports second (see the note at the top of this file).
    ({
      getEffectiveRoleDefaults,
      normalizeRoleDefaults,
    } = await import('../services/roleDefaultsStore.js'));
    ({
      getRoleDefaultsForEdit,
      setRoleDefaults,
      applyRoleDefaults,
      validateRoleDefaultsInput,
    } = await import('../services/RoleDefaultsService.js'));
    ({ applyDefaultRoleAccess, revertDefaultRoleAccess } = await import('../database/roleAccessDefaults.js'));
    ({ resolveVisibility } = await import('../authz.js'));

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    deptId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT5', 'Sales') RETURNING id`)).rows[0].id;
    const mkRole = async (code: string, name: string, level: number, vis: string) =>
      (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis]
      )).rows[0].id;
    adminRoleId = await mkRole('ADMIN', 'Admin', 100, 'Organization');
    superAdminRoleId = await mkRole('SUPERADMIN', 'Super Admin', 100, 'Organization');
    managerRoleId = await mkRole('MANAGER', 'Manager', 2, 'FullTeam');
    empRoleId = await mkRole('EMPLOYEE', 'Employee', 4, 'Own');
    roRoleId = await mkRole('RO', 'Relationship Officer', 4, 'Own');
    // TEAM_LEAD holds 'Own' here on purpose: it models a role created
    // through Roles & Access (which defaults a new row to 'Own') that
    // never received defaults — the visibility move only fires while
    // the row still holds 'Own' (the guarded rule in
    // roleAccessDefaults.ts). A seeded production TEAM_LEAD already
    // holds 'DownTeam' from the seed-time apply.
    tlRoleId = await mkRole('TEAM_LEAD', 'Team Lead', 3, 'Own');

    const permIds: Record<string, string> = {};
    for (const code of ALL_CODES) {
      permIds[code] = (await pool.query(
        `INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`,
        [code]
      )).rows[0].id;
    }
    const grant = async (roleId: string, codes: string[]) => {
      for (const code of codes) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
          [roleId, permIds[code]]
        );
      }
    };
    // MANAGER and EMPLOYEE are CONFIGURED roles (hold grants): Apply must
    // never touch them. RO and TEAM_LEAD hold zero grants: unconfigured.
    await grant(adminRoleId, ALL_CODES);
    await grant(managerRoleId, ['leads.view']);
    await grant(empRoleId, ['users.view']);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleId: string, roleCode: string, managerId: string | null = null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: roleCode };
    };
    superAdmin = await mkUser('DZ5ADMIN', adminRoleId, 'ADMIN');
    superAdmin2 = await mkUser('DZ5SUPER', superAdminRoleId, 'SUPERADMIN');
    mgr = await mkUser('DZ5MGR', managerRoleId, 'MANAGER');
    tl = await mkUser('DZ5TL', roRoleId, 'RO', mgr.id);
    sub = await mkUser('DZ5SUB', roRoleId, 'RO', tl.id);
    solo = await mkUser('DZ5SOLO', roRoleId, 'RO', mgr.id);
    outsider = await mkUser('DZ5OUT', roRoleId, 'RO', mgr.id);

    await migrate057();
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // Every test starts from the code defaults and from unconfigured
    // RO / TEAM_LEAD roles: a saved table or an Apply from a previous
    // test never leaks into the next one.
    await pool.query(`DELETE FROM options WHERE field_key = 'RoleDefaults'`);
    await pool.query(`DELETE FROM role_permissions WHERE role_id IN ($1, $2)`, [roRoleId, tlRoleId]);
    await pool.query(`UPDATE roles SET data_visibility = 'Own' WHERE id = $1`, [roRoleId]);
    await pool.query(`UPDATE roles SET data_visibility = 'Own' WHERE id = $1`, [tlRoleId]);
    await pool.query(`DELETE FROM leads`);
  });

  const dz = (method: 'get' | 'put' | 'post', path: string, user: any, body?: any) => {
    const req = request(app)[method](`/api/danger-zone${path}`).set('Authorization', `Bearer ${tokenFor(user)}`);
    return body === undefined ? req : req.send(body);
  };

  const unlockAs = async (user: any) => {
    const res = await dz('post', '/unlock', user, { password: ADMIN_PASSWORD });
    assert.equal(res.status, 200, `unlock failed: ${JSON.stringify(res.body)}`);
    return res;
  };

  async function auditRows(actionCode: string): Promise<any[]> {
    const r: any = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = $1 ORDER BY created_at ASC`,
      [actionCode]
    );
    return r.rows;
  }

  /** Full PUT body from the code defaults, with optional edits. */
  function defaultTableInput(overrides: Partial<RoleDefaultsInput> = {}): RoleDefaultsInput {
    const grants: Record<string, string[]> = {};
    for (const [code, codes] of Object.entries(DEFAULT_GRANTS)) grants[code] = [...codes];
    return {
      grants,
      visibility: { ...DEFAULT_VISIBILITY },
      ...overrides,
    };
  }

  async function roleGrants(roleId: string): Promise<string[]> {
    const r: any = await pool.query(
      `SELECT p.permission_code FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND rp.is_allowed ORDER BY p.permission_code`,
      [roleId]
    );
    return r.rows.map((row: any) => row.permission_code);
  }

  async function roleVisibility(roleId: string): Promise<string | null> {
    const r: any = await pool.query(`SELECT data_visibility FROM roles WHERE id = $1 LIMIT 1`, [roleId]);
    return r.rows[0]?.data_visibility ?? null;
  }

  async function mkFreshRole(vis = 'Own'): Promise<{ id: string; code: string }> {
    freshSeq += 1;
    const code = `DZ5R${freshSeq}`;
    const id = (await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, 4, $3) RETURNING id`,
      [code, `Fresh ${freshSeq}`, vis]
    )).rows[0].id;
    return { id, code };
  }

  async function insertLead(mobile: string, owner: any) {
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 'New') RETURNING id`,
      [`lead_${mobile}`, `Lead ${mobile}`, mobile, owner.id]
    );
    return res.rows[0].id as string;
  }

  /* ==================================================================
     (a) GET / PUT + gating + validation + audit
  ================================================================== */
  describe('defaults read/write + gating', () => {
    it('GET defaults: version 0, code table, all 35 codes, zero-grant roles listed', async () => {
      await unlockAs(superAdmin);
      const res = await dz('get', '/role-defaults', superAdmin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = res.body.data;
      assert.equal(data.version, 0);
      assert.deepEqual([...data.defaults.grants.RO].sort(), [...DEFAULT_GRANTS.RO].sort());
      assert.deepEqual([...data.defaults.grants.MANAGER].sort(), [...DEFAULT_GRANTS.MANAGER].sort());
      assert.equal(data.defaults.visibility.MANAGER, 'FullTeam');
      assert.equal(data.defaults.visibility.RM, 'DownTeam');
      assert.equal(data.defaults.visibility.RO, undefined, 'RO has no visibility entry (stays Own)');
      assert.deepEqual(data.codeDefaults.grants.RO, data.defaults.grants.RO);
      assert.equal(data.permissionCodes.length, 35, 'all canonical codes listed');
      assert.ok(data.permissionCodes.some((c: any) => c.code === 'leads.export'));
      assert.ok(data.permissionCodes.some((c: any) => c.code === 'users.lock'));
      const unconfigured = data.unconfiguredRoles.map((r: any) => r.roleCode);
      assert.ok(unconfigured.includes('RO'), 'zero-grant RO listed');
      assert.ok(unconfigured.includes('TEAM_LEAD'), 'zero-grant TEAM_LEAD listed');
      assert.ok(!unconfigured.includes('MANAGER'), 'configured MANAGER not listed');
      assert.ok(!unconfigured.includes('EMPLOYEE'), 'configured EMPLOYEE not listed');
      assert.ok(!unconfigured.includes('ADMIN'), 'ADMIN never listed');
      assert.equal(data.lastChange, null);
    });

    it('GET without unlock: 403 danger_zone_locked (never 401)', async () => {
      const res = await dz('get', '/role-defaults', superAdmin2);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error, 'danger_zone_locked');
    });

    it('GET as a non-super-admin: 403', async () => {
      const res = await dz('get', '/role-defaults', mgr);
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    it('PUT as a non-super-admin: 403 even with a valid body', async () => {
      const res = await dz('put', '/role-defaults', mgr, defaultTableInput());
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    it('PUT validation: ADMIN / SUPERADMIN keys refused', async () => {
      await unlockAs(superAdmin);
      for (const bad of ['ADMIN', 'SUPERADMIN']) {
        const input = defaultTableInput();
        input.grants[bad] = ['leads.view'];
        const res = await dz('put', '/role-defaults', superAdmin, input);
        assert.equal(res.status, 400, `${bad} must be refused: ${JSON.stringify(res.body)}`);
        assert.match(res.body.message, /never be a defaults entry/);
      }
    });

    it('PUT validation: unknown permission code, bad visibility, malformed role key, unknown field', async () => {
      await unlockAs(superAdmin);
      const cases: Array<{ input: RoleDefaultsInput; match: RegExp }> = [
        {
          input: defaultTableInput({ grants: { ...defaultTableInput().grants, RO: ['leads.view', 'leads.nope'] } }),
          match: /unknown permission code "leads\.nope"/,
        },
        {
          input: defaultTableInput({ visibility: { ...DEFAULT_VISIBILITY, RO: 'Everywhere' } }),
          match: /must be one of Own, DownTeam, FullTeam, Organization/,
        },
        {
          input: defaultTableInput({ grants: { ...defaultTableInput().grants, ro: ['leads.view'] } }),
          match: /not a valid role code/,
        },
        {
          input: { ...defaultTableInput(), surprise: true } as unknown as RoleDefaultsInput,
          match: /Unknown field: surprise/,
        },
      ];
      for (const { input, match } of cases) {
        const res = await dz('put', '/role-defaults', superAdmin, input);
        assert.equal(res.status, 400, `${JSON.stringify(input).slice(0, 120)} must be refused: ${JSON.stringify(res.body)}`);
        assert.match(res.body.message, match);
      }
    });

    it('PUT saves a versioned table and audit-logs old→new', async () => {
      await unlockAs(superAdmin);
      const input = defaultTableInput();
      input.grants.RO = [...DEFAULT_GRANTS.RO, 'leads.export'];
      input.visibility.TEAM_LEAD = 'FullTeam';
      const res = await dz('put', '/role-defaults', superAdmin, input);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.version, 1);
      assert.ok(res.body.data.defaults.grants.RO.includes('leads.export'));
      assert.equal(res.body.data.defaults.visibility.TEAM_LEAD, 'FullTeam');

      const rows = await auditRows('danger_zone.role_defaults.update');
      assert.equal(rows.length, 1);
      const meta = rows[0].metadata as any;
      assert.equal(meta.version, 1);
      assert.deepEqual([...meta.oldValue.grants.RO].sort(), [...DEFAULT_GRANTS.RO].sort());
      assert.ok(meta.newValue.grants.RO.includes('leads.export'));
      assert.equal(meta.oldValue.visibility.TEAM_LEAD, 'DownTeam');
      assert.equal(meta.newValue.visibility.TEAM_LEAD, 'FullTeam');

      const again = await dz('get', '/role-defaults', superAdmin);
      assert.equal(again.body.data.version, 1);
      assert.equal(again.body.data.lastChange.version, 1);
      assert.equal(again.body.data.lastChange.oldValue.visibility.TEAM_LEAD, 'DownTeam');
      assert.equal(again.body.data.lastChange.newValue.visibility.TEAM_LEAD, 'FullTeam');

      // A second save versions up again.
      const res2 = await dz('put', '/role-defaults', superAdmin, input);
      assert.equal(res2.body.data.version, 2);
    });

    it('saving alone changes no role (the table is not applied on PUT)', async () => {
      await unlockAs(superAdmin);
      const input = defaultTableInput();
      input.grants.RO = [...DEFAULT_GRANTS.RO, 'leads.export'];
      await dz('put', '/role-defaults', superAdmin, input);
      assert.deepEqual(await roleGrants(roRoleId), [], 'RO still holds zero grants after a save');
      assert.equal(await roleVisibility(roRoleId), 'Own');
    });
  });

  /* ==================================================================
     (b) Apply — the edit becomes real, and only where it may
  ================================================================== */
  describe('apply', () => {
    it('Apply gives a zero-grant role the edited grants + visibility; configured roles untouched', async () => {
      await unlockAs(superAdmin);
      const input = defaultTableInput();
      input.grants.RO = [...DEFAULT_GRANTS.RO, 'leads.export'];
      input.visibility.TEAM_LEAD = 'FullTeam';
      await dz('put', '/role-defaults', superAdmin, input);

      const res = await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const report = res.body.data.report;
      const roEntry = report.applied.find((e: any) => e.roleCode === 'RO');
      assert.ok(roEntry, 'RO applied');
      assert.ok(roEntry.grantsAdded.includes('leads.export'), 'edited grant landed');
      assert.equal(roEntry.visibilityChanged, false, 'RO has no visibility entry — stays Own');
      const tlEntry = report.applied.find((e: any) => e.roleCode === 'TEAM_LEAD');
      assert.ok(tlEntry, 'TEAM_LEAD applied');
      assert.equal(tlEntry.visibilityChanged, true);
      assert.equal(tlEntry.visibilityFrom, 'Own');
      assert.equal(tlEntry.visibilityTo, 'FullTeam');
      assert.ok(!report.applied.some((e: any) => e.roleCode === 'CEO'), 'no row for CEO — inert, not reported');
      assert.ok(report.skipped.includes('MANAGER'), 'configured MANAGER skipped');

      assert.deepEqual((await roleGrants(roRoleId)).sort(), [...DEFAULT_GRANTS.RO, 'leads.export'].sort());
      assert.equal(await roleVisibility(roRoleId), 'Own');
      assert.equal(await roleVisibility(tlRoleId), 'FullTeam');
      // Configured roles are byte-identical to before the Apply.
      assert.deepEqual(await roleGrants(managerRoleId), ['leads.view']);
      assert.equal(await roleVisibility(managerRoleId), 'FullTeam');

      const rows = await auditRows('danger_zone.role_defaults.apply');
      assert.equal(rows.length, 1);
      assert.ok((rows[0].metadata.applied as any[]).some((e: any) => e.roleCode === 'RO'));
    });

    it('Apply is idempotent: a second Apply changes nothing', async () => {
      await unlockAs(superAdmin);
      await dz('put', '/role-defaults', superAdmin, defaultTableInput());
      const first = await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(first.status, 200);
      assert.ok(first.body.data.report.applied.length > 0, 'first Apply did work');
      const second = await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.deepEqual(second.body.data.report.applied, [], 'second Apply is a no-op');
      assert.ok(second.body.data.report.skipped.includes('RO'), 'RO now counts as configured');
    });

    it('Apply with no saved table applies the code defaults', async () => {
      await unlockAs(superAdmin);
      const res = await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual((await roleGrants(roRoleId)).sort(), [...DEFAULT_GRANTS.RO].sort());
      assert.equal(res.body.data.version, 0, 'nothing saved yet');
    });

    it('Apply without unlock: 403 danger_zone_locked; as non-super-admin: 403', async () => {
      const locked = await dz('post', '/role-defaults/apply', superAdmin2, {});
      assert.equal(locked.status, 403);
      assert.equal(locked.body.error, 'danger_zone_locked');
      await unlockAs(superAdmin);
      const nonAdmin = await dz('post', '/role-defaults/apply', mgr, {});
      assert.equal(nonAdmin.status, 403, JSON.stringify(nonAdmin.body));
    });

    it('a fresh role code added to the table gets defaults on Apply', async () => {
      await unlockAs(superAdmin);
      const fresh = await mkFreshRole('Own');
      const input = defaultTableInput();
      input.grants[fresh.code] = ['leads.view', 'dashboard.view'];
      input.visibility[fresh.code] = 'DownTeam';
      await dz('put', '/role-defaults', superAdmin, input);
      const res = await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual((await roleGrants(fresh.id)).sort(), ['dashboard.view', 'leads.view']);
      assert.equal(await roleVisibility(fresh.id), 'DownTeam');
    });
  });

  /* ==================================================================
     (c) UM-1 floor + predicate core, under an edited table
  ================================================================== */
  describe('UM-1 floor and predicate core under edited defaults', () => {
    it('an Own-scope role with reports still resolves to its subtree after Apply', async () => {
      await unlockAs(superAdmin);
      // The edited table keeps RO on 'Own' (no visibility entry).
      await dz('put', '/role-defaults', superAdmin, defaultTableInput());
      await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.equal(await roleVisibility(roRoleId), 'Own');

      const vis = await resolveVisibility(tl.id, 'RO');
      assert.equal(vis.all, false);
      assert.ok(vis.userIds.includes(tl.id));
      assert.ok(vis.userIds.includes(sub.id), 'direct report in scope (floor)');
      assert.ok(!vis.userIds.includes(outsider.id), 'sibling branch stays out');
      assert.ok(!vis.userIds.includes(solo.id), 'unrelated peer stays out');

      const soloVis = await resolveVisibility(solo.id, 'RO');
      assert.deepEqual(soloVis.userIds, [solo.id], 'no reports: stays Own');
    });

    it('floor end-to-end: the team lead sees a subordinate lead, never an outsider lead', async () => {
      await unlockAs(superAdmin);
      await dz('put', '/role-defaults', superAdmin, defaultTableInput());
      await dz('post', '/role-defaults/apply', superAdmin, {});
      const leadSub = await insertLead('01731000001', sub);
      const leadOut = await insertLead('01731000002', outsider);
      await insertLead('01731000003', tl);

      const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(tl)}`);
      assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
      const rows = Array.isArray(list.body) ? list.body : list.body.data || [];
      const mobiles = rows.map((l: any) => l.mobile);
      assert.ok(mobiles.includes('01731000001'), 'subordinate lead in list');
      assert.ok(mobiles.includes('01731000003'), 'own lead in list');
      assert.ok(!mobiles.includes('01731000002'), 'outsider lead NOT in list');

      const detail = await request(app).get(`/api/leads/${leadSub}`).set('Authorization', `Bearer ${tokenFor(tl)}`);
      assert.equal(detail.status, 200, 'subordinate lead opens');
      const detailOut = await request(app).get(`/api/leads/${leadOut}`).set('Authorization', `Bearer ${tokenFor(tl)}`);
      assert.equal(detailOut.status, 404, 'outsider lead is a 404 — predicate core unchanged');
    });
  });

  /* ==================================================================
     (d) normalize / validate unit behaviour
  ================================================================== */
  describe('normalize + validate', () => {
    it('normalize drops bypass-role keys and bad visibility, dedupes and sorts codes', () => {
      const out = normalizeRoleDefaults({
        version: 3,
        grants: {
          ADMIN: ['leads.view'],
          SUPERADMIN: ['leads.view'],
          RO: ['leads.view', 'leads.view', 'dashboard.view'],
          'bad-code': ['leads.view'],
        },
        visibility: { RO: 'Everywhere', MANAGER: 'FullTeam', ADMIN: 'Organization' },
      });
      assert.equal(out.version, 3);
      assert.equal(out.grants.ADMIN, undefined);
      assert.equal(out.grants.SUPERADMIN, undefined);
      assert.deepEqual(out.grants.RO, ['dashboard.view', 'leads.view']);
      assert.equal(out.grants['bad-code'], undefined);
      assert.equal(out.visibility.RO, undefined);
      assert.equal(out.visibility.MANAGER, 'FullTeam');
      assert.equal(out.visibility.ADMIN, undefined);
    });

    it('normalize falls back per-section to the code table on malformed input', () => {
      const out = normalizeRoleDefaults({ version: 1, grants: 'nope', visibility: { RO: 'Own' } });
      assert.deepEqual(out.grants, normalizeRoleDefaults({}).grants, 'malformed grants → code grants');
      assert.deepEqual(out.visibility, { RO: 'Own' }, 'well-formed visibility kept');
      const out2 = normalizeRoleDefaults('not an object at all');
      assert.deepEqual(out2.grants.RO, [...DEFAULT_GRANTS.RO].sort());
      assert.equal(out2.visibility.MANAGER, 'FullTeam');
    });

    it('validate accepts the code table and rejects an empty known-codes list', () => {
      assert.deepEqual(validateRoleDefaultsInput(defaultTableInput(), ALL_CODES), []);
      const problems = validateRoleDefaultsInput(defaultTableInput(), []);
      assert.ok(problems.length > 0, 'no codes known → every grant refused (fail closed)');
      assert.match(problems[0], /unknown permission code/);
    });

    it('getEffectiveRoleDefaults returns the code table when nothing is saved', async () => {
      const effective = await getEffectiveRoleDefaults();
      assert.equal(effective.version, 0);
      assert.deepEqual([...effective.grants.RO].sort(), [...DEFAULT_GRANTS.RO].sort());
      assert.equal(effective.visibility.RM, 'DownTeam');
    });
  });

  /* ==================================================================
     (e) corrupt stored row + (f) revert + (g) sibling slices
  ================================================================== */
  describe('corrupt stored row, revert, sibling slices', () => {
    it('a corrupt stored row falls back to the code defaults', async () => {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
         VALUES ('RoleDefaults', 'config', 'Role Defaults Config', 1, FALSE, TRUE, '"just a string"'::jsonb)
         ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`
      );
      const effective = await getEffectiveRoleDefaults();
      assert.deepEqual([...effective.grants.RO].sort(), [...DEFAULT_GRANTS.RO].sort());
      assert.equal(effective.visibility.MANAGER, 'FullTeam');

      await unlockAs(superAdmin);
      const res = await dz('get', '/role-defaults', superAdmin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.version, 0);
      assert.deepEqual([...res.body.data.defaults.grants.RO].sort(), [...DEFAULT_GRANTS.RO].sort());
    });

    it('revert clears exactly-default matrices and nothing else', async () => {
      await unlockAs(superAdmin);
      const input = defaultTableInput();
      input.grants.RO = [...DEFAULT_GRANTS.RO, 'leads.export'];
      await dz('put', '/role-defaults', superAdmin, input);
      await dz('post', '/role-defaults/apply', superAdmin, {});
      assert.ok((await roleGrants(roRoleId)).includes('leads.export'));

      // A configured role with a DIFFERENT matrix must survive revert.
      const beforeMgr = await roleGrants(managerRoleId);
      await revertDefaultRoleAccess();
      assert.deepEqual(await roleGrants(roRoleId), [], 'RO back to zero grants');
      assert.equal(await roleVisibility(tlRoleId), 'Own', 'TEAM_LEAD visibility reverts to Own (it still held the applied default)');
      assert.deepEqual(await roleGrants(managerRoleId), beforeMgr, 'configured MANAGER untouched by revert');
    });

    it('DZ-3 and DZ-4 still answer on this tree', async () => {
      await unlockAs(superAdmin);
      const lq = await dz('get', '/lead-quality', superAdmin);
      assert.equal(lq.status, 200, JSON.stringify(lq.body).slice(0, 200));
      const sp = await dz('get', '/security-policy', superAdmin);
      assert.equal(sp.status, 200, JSON.stringify(sp.body).slice(0, 200));
      assert.equal(sp.body.data.policy.passwordMinLength, 8);
    });
  });
});
