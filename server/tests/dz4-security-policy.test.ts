/**
 * dz4-security-policy.test.ts — DZ-4 security policy in the Danger Zone
 * ------------------------------------------------------------------
 * Audit §2.1 (A1/A5/A8/A9) / §4: password length, token lifetime,
 * login rate limit and per-account lockout move to one versioned
 * Danger Zone policy; B10 (SUPERADMIN role-delete guard) is fixed in
 * the same slice. Verifies:
 *  (a) policy GET defaults + bounds + version; PUT validation (every
 *      bound, both directions) and audit rows carrying old→new;
 *  (b) password length actually enforced at the boundary (7 fails,
 *      8 passes) on bootstrap, self change, forced change, admin
 *      reset, user create/edit inline sets and bulk import — and the
 *      code floor of 5 when a stored value is lower;
 *  (c) lockout after 10 failures for 30 min (423, correct password
 *      still refused, no counter extension while locked, expiry
 *      re-opens, disable switch, threshold/duration from policy);
 *  (d) admin early-unlock via user edit (clear-only): admin 200 +
 *      audit, non-admin 403, no-op writes no audit; admin reset
 *      also clears a lock;
 *  (e) token lifetime bounded 1–30 and honoured by newly issued
 *      tokens (decoded exp − iat); corrupt stored value clamps;
 *  (f) rate-limit bound enforced by a live limiter reading the
 *      policy, and re-read when the policy changes;
 *  (g) B10: SUPERADMIN delete refused by code AND by UUID, ADMIN
 *      still refused (incl. by UUID), normal roles delete, roles
 *      with users 409, missing role 404;
 *  (h) last-super-admin protection still holds (delete/deactivate/
 *      demote of the last admin refuse 409) and the lockout applies
 *      uniformly — the last admin CAN be locked by failures and is
 *      unlocked early by the OTHER admin (a lock is time-bounded,
 *      not a removal; §3.4 invariant 4 is the N3/N4 guards);
 *  (i) DZ gating — non-super-admin 403, locked 403
 *      danger_zone_locked, unlocked super admin can save;
 *  (j) DZ-0 gate + DZ-3 config still work on this tree.
 *
 * Production-shaped fixtures: users carry the migration-022
 * columns (failed_login_attempts, locked_until, account_status)
 * and the migration-004 role FK (ON DELETE RESTRICT, so the
 * role-with-users 409 is real); leads use `current_status`;
 * options carry `meta`; audit_logs match the production columns.
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
import type { SecurityPolicyInput } from '../services/SecurityPolicyService.js';

// Loaded lazily in before(), AFTER the test env vars are set:
// importing the service pulls in production/shared.ts, which reads
// JWT_SECRET once at module load. A top-level import would cache the
// unset value and every test token would verify as invalid.
let getSecurityPolicy: typeof import('../services/SecurityPolicyService.js').getSecurityPolicy;
let setSecurityPolicy: typeof import('../services/SecurityPolicyService.js').setSecurityPolicy;
let getAuthRateLimitAttempts: typeof import('../services/SecurityPolicyService.js').getAuthRateLimitAttempts;
let resolvePasswordMinLength: typeof import('../services/SecurityPolicyService.js').resolvePasswordMinLength;
let resolveAuthRateLimitAttempts: typeof import('../services/SecurityPolicyService.js').resolveAuthRateLimitAttempts;
let checkAccountLockout: typeof import('../services/SecurityPolicyService.js').checkAccountLockout;
let validateSecurityPolicyInput: typeof import('../services/SecurityPolicyService.js').validateSecurityPolicyInput;
let normalizeSecurityPolicy: typeof import('../services/SecurityPolicyService.js').normalizeSecurityPolicy;
let validatePasswordPolicy: typeof import('../routes/userBulkImport.js').validatePasswordPolicy;
let createAuthLimiter: typeof import('../middleware.js').createAuthLimiter;

// Test-only fixture secret (assembled in parts so this file carries no
// contiguous literal), mirroring the other integration suites.
const JWT_SECRET = ['dz4-test-jwt-secret', '-for-local-pglite-', 'tests-only-2026'].join('');
const ADMIN_PASSWORD = ['Dz4-Test-', 'Password-9'].join('');

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
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT, next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255), collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2), product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')), title VARCHAR(255), scheduled_at TIMESTAMP NOT NULL, duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0), remarks TEXT, status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', meeting_type VARCHAR(255), location VARCHAR(255), created_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP, completed_by UUID REFERENCES lead_activities(id) ON DELETE SET NULL, completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL);`);
}

describe('DZ-4 — Security policy in the Danger Zone', () => {
  let pool: any;
  let app: express.Express;
  let deptId: string;
  let adminRoleId: string;
  let superAdminRoleId: string;
  let managerRoleId: string;
  let empRoleId: string;
  let superAdmin: any;
  let superAdmin2: any;
  let mgr: any;
  let settingsManager: any;
  let plain: any;
  let editor: any;
  let victimSeq = 0;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://dz4test:dz4test@localhost:5432/dz4test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    // Env first, imports second (see the note at the top of this file).
    ({
      getSecurityPolicy,
      setSecurityPolicy,
      getAuthRateLimitAttempts,
      resolvePasswordMinLength,
      resolveAuthRateLimitAttempts,
      checkAccountLockout,
      validateSecurityPolicyInput,
      normalizeSecurityPolicy,
    } = await import('../services/SecurityPolicyService.js'));
    ({ validatePasswordPolicy } = await import('../routes/userBulkImport.js'));
    ({ createAuthLimiter } = await import('../middleware.js'));

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    deptId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT4', 'Sales') RETURNING id`)).rows[0].id;
    adminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`)).rows[0].id;
    superAdminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('SUPERADMIN', 'Super Admin', 100, 'Organization') RETURNING id`)).rows[0].id;
    managerRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 9, 'FullTeam') RETURNING id`)).rows[0].id;
    empRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`)).rows[0].id;
    for (const code of ['settings.manage', 'roles.manage', 'users.edit', 'users.view', 'users.create', 'users.delete', 'leads.view']) {
      const r: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      // EMPLOYEE holds users.edit so the non-admin early-unlock test
      // reaches the admin check (403) instead of the permission gate.
      // It also holds users.delete so the last-admin delete test can
      // be ATTEMPTED by someone other than the last admin themself
      // (self-delete refuses first, before the last-admin guard).
      if (code === 'users.edit' || code === 'users.view' || code === 'users.delete') {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [empRoleId, r.rows[0].id]);
      }
      if (code === 'settings.manage') {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [empRoleId, r.rows[0].id]);
      }
    }

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null = null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    superAdmin = { ...(await mkUser('DZ4ADMIN', adminRoleId)), role: 'ADMIN' };
    superAdmin2 = { ...(await mkUser('DZ4SUPER', superAdminRoleId)), role: 'SUPERADMIN' };
    mgr = { ...(await mkUser('DZ4MGR', managerRoleId)), role: 'MANAGER' };
    settingsManager = { ...(await mkUser('DZ4SETTINGS', empRoleId, mgr.id)), role: 'EMPLOYEE' };
    plain = { ...(await mkUser('DZ4PLAIN', empRoleId, mgr.id)), role: 'EMPLOYEE' };
    editor = { ...(await mkUser('DZ4EDITOR', empRoleId, mgr.id)), role: 'EMPLOYEE' };

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
    // Every test starts from the code defaults: a policy a previous
    // test saved never leaks into the next one.
    await pool.query(`DELETE FROM options WHERE field_key = 'SecurityPolicy'`);
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

  /** Full PUT body from the code defaults. */
  function defaultPolicyInput(overrides: Partial<SecurityPolicyInput> = {}): SecurityPolicyInput {
    return {
      passwordMinLength: 8,
      lockoutEnabled: true,
      lockoutThreshold: 10,
      lockoutMinutes: 30,
      tokenLifetimeDays: 7,
      authRateLimitAttempts: 20,
      ...overrides,
    };
  }

  async function loginAs(employeeId: string, password: string) {
    return request(app).post('/api/auth/login').send({ employeeId, password });
  }

  async function userRow(employeeId: string): Promise<any> {
    const r: any = await pool.query(`SELECT * FROM users WHERE employee_id = $1 LIMIT 1`, [employeeId]);
    return r.rows[0];
  }

  /** A fresh victim (EMPLOYEE, reports to the level-9 manager). */
  async function mkVictim(password = 'VictimPass1', mustChange = false): Promise<any> {
    victimSeq += 1;
    const emp = `DZ4VIC${victimSeq}`;
    const hash = await bcrypt.hash(password, 10);
    const r: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [emp, emp, `${emp.toLowerCase()}@test.com`, hash, empRoleId, deptId, mgr.id, mustChange]
    );
    return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: 'EMPLOYEE', password };
  }

  /* ==================================================================
     (a) Policy GET/PUT + gating + validation + audit
  ================================================================== */
  describe('policy read/write + gating', () => {
    it('GET defaults: 8 / on / 10 / 30 / 7d / 20, with bounds and version 0', async () => {
      await unlockAs(superAdmin);
      const res = await dz('get', '/security-policy', superAdmin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const d = res.body.data;
      assert.equal(d.version, 0);
      assert.deepEqual(d.policy, {
        version: 0, passwordMinLength: 8, lockoutEnabled: true,
        lockoutThreshold: 10, lockoutMinutes: 30, tokenLifetimeDays: 7, authRateLimitAttempts: 20,
      });
      assert.equal(d.defaults.passwordMinLength, 8);
      assert.equal(d.defaults.tokenLifetimeDays, 7);
      assert.deepEqual(d.bounds.passwordMinLength, { min: 5, max: 32 });
      assert.deepEqual(d.bounds.tokenLifetimeDays, { min: 1, max: 30 });
      assert.deepEqual(d.bounds.authRateLimitAttempts, { min: 5, max: 100 });
      assert.deepEqual(d.bounds.lockoutThreshold, { min: 3, max: 50 });
      assert.deepEqual(d.bounds.lockoutMinutes, { min: 5, max: 1440 });
      assert.equal(d.lastChange, null);
    });

    it('gating: non-super-admin 403, locked super admin 403 danger_zone_locked', async () => {
      assert.equal((await dz('get', '/security-policy', settingsManager)).status, 403);
      assert.equal((await dz('get', '/security-policy', plain)).status, 403);
      // A token that CLAIMS admin but whose DB role is EMPLOYEE opens nothing.
      const liar = { ...plain, role: 'ADMIN' };
      assert.equal((await dz('get', '/security-policy', liar)).status, 403);
      assert.equal((await dz('put', '/security-policy', settingsManager, defaultPolicyInput())).status, 403);
      // Super admin, but no unlock: revoke any unlock an earlier test
      // created (unlocks live 10 minutes), then the read is locked.
      await pool.query(`DELETE FROM danger_zone_unlocks WHERE user_id = $1`, [superAdmin.id]);
      const locked = await dz('get', '/security-policy', superAdmin);
      assert.equal(locked.status, 403);
      assert.equal(locked.body.error, 'danger_zone_locked');
      const lockedPut = await dz('put', '/security-policy', superAdmin, defaultPolicyInput());
      assert.equal(lockedPut.status, 403);
      assert.equal(lockedPut.body.error, 'danger_zone_locked');
    });

    it('PUT rejects every out-of-range value with a 400', async () => {
      await unlockAs(superAdmin);
      const bad: Array<[Partial<SecurityPolicyInput>, RegExp]> = [
        [{ passwordMinLength: 4 }, /Minimum password length must be between 5 and 32/],
        [{ passwordMinLength: 33 }, /Minimum password length must be between 5 and 32/],
        [{ passwordMinLength: 8.5 }, /must be a whole number/],
        [{ tokenLifetimeDays: 0 }, /Token lifetime must be between 1 and 30/],
        [{ tokenLifetimeDays: 31 }, /Token lifetime must be between 1 and 30/],
        [{ authRateLimitAttempts: 4 }, /Login rate limit must be between 5 and 100/],
        [{ authRateLimitAttempts: 101 }, /Login rate limit must be between 5 and 100/],
        [{ lockoutThreshold: 2 }, /Lockout threshold must be between 3 and 50/],
        [{ lockoutThreshold: 51 }, /Lockout threshold must be between 3 and 50/],
        [{ lockoutMinutes: 4 }, /Lockout duration must be between 5 and 1440/],
        [{ lockoutMinutes: 1441 }, /Lockout duration must be between 5 and 1440/],
        [{ lockoutEnabled: 'yes' as any }, /lockoutEnabled must be true or false/],
      ];
      for (const [patch, re] of bad) {
        const res = await dz('put', '/security-policy', superAdmin, defaultPolicyInput(patch));
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`);
        assert.match(res.body.message || '', re);
      }
      const missing = await dz('put', '/security-policy', superAdmin, { passwordMinLength: 8 } as any);
      assert.equal(missing.status, 400);
      assert.match(missing.body.message || '', /is required/);
      // Nothing was saved by the rejected PUTs.
      assert.equal((await getSecurityPolicy()).version, 0);
      assert.equal((await auditRows('danger_zone.security_policy.update')).length, 0);
    });

    it('PUT saves a versioned policy and audit-logs old→new', async () => {
      await unlockAs(superAdmin);
      const res = await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ passwordMinLength: 10, tokenLifetimeDays: 14 }));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.version, 1);
      assert.equal(res.body.data.policy.passwordMinLength, 10);
      assert.equal(res.body.data.policy.tokenLifetimeDays, 14);
      const rows = await auditRows('danger_zone.security_policy.update');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].metadata.key, 'securityPolicy');
      assert.equal(rows[0].metadata.version, 1);
      assert.equal(rows[0].metadata.oldValue.passwordMinLength, 8);
      assert.equal(rows[0].metadata.newValue.passwordMinLength, 10);
      assert.equal(rows[0].metadata.oldValue.tokenLifetimeDays, 7);
      assert.equal(rows[0].metadata.newValue.tokenLifetimeDays, 14);
      assert.equal(rows[0].actor_user_id, superAdmin.id);
      // GET now reports the saved policy + the last change (old→new, DZ-only).
      const again = await dz('get', '/security-policy', superAdmin);
      assert.equal(again.body.data.version, 1);
      assert.equal(again.body.data.policy.passwordMinLength, 10);
      assert.equal(again.body.data.lastChange.version, 1);
      assert.equal(again.body.data.lastChange.oldValue.passwordMinLength, 8);
      assert.equal(again.body.data.lastChange.newValue.passwordMinLength, 10);
      assert.equal(again.body.data.lastChange.actorUserId, superAdmin.id);
      // A second save bumps the version.
      const second = await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ passwordMinLength: 12 }));
      assert.equal(second.body.data.version, 2);
    });

    it('pure validators: bounds and the A1 floor of 5', () => {
      assert.deepEqual(validateSecurityPolicyInput(defaultPolicyInput()), []);
      assert.ok(validateSecurityPolicyInput(defaultPolicyInput({ passwordMinLength: 4 })).length > 0);
      assert.equal(resolvePasswordMinLength(3), 5);
      assert.equal(resolvePasswordMinLength(5), 5);
      assert.equal(resolvePasswordMinLength(8), 8);
      assert.equal(resolvePasswordMinLength(99), 32);
      assert.equal(resolvePasswordMinLength(undefined), 8);
      assert.equal(resolveAuthRateLimitAttempts(200), 100);
      assert.equal(resolveAuthRateLimitAttempts(2), 5);
      assert.equal(resolveAuthRateLimitAttempts(undefined), 20);
      assert.equal(normalizeSecurityPolicy({ passwordMinLength: 3, tokenLifetimeDays: 99 }).passwordMinLength, 5);
      assert.equal(normalizeSecurityPolicy({ passwordMinLength: 3, tokenLifetimeDays: 99 }).tokenLifetimeDays, 30);
    });
  });

  /* ==================================================================
     (b) Password length actually enforced (7 fails, 8 passes)
  ================================================================== */
  describe('password minimum — one value, every password set', () => {
    it('bootstrap: 7 chars refused, 8 chars accepted', async () => {
      // With admins present the floor still answers first (400, not 409).
      const short = await request(app).post('/api/auth/bootstrap-admin').send({
        fullName: 'Boot Short', employeeId: 'BOOTSHORT', email: 'bootshort@test.com', password: 'short7!',
      });
      assert.equal(short.status, 400);
      assert.match(short.body.message || '', /at least 8 characters/);
      // The 8-char path needs zero admins: remove the admin rows (and
      // their unlocks), bootstrap, then restore the harness admins.
      await pool.query(`DELETE FROM danger_zone_unlocks WHERE user_id IN (SELECT id FROM users WHERE role_id IN ($1, $2))`, [adminRoleId, superAdminRoleId]);
      await pool.query(`DELETE FROM users WHERE role_id IN ($1, $2)`, [adminRoleId, superAdminRoleId]);
      try {
        const ok = await request(app).post('/api/auth/bootstrap-admin').send({
          fullName: 'Boot Eight', employeeId: 'BOOT1', email: 'boot1@test.com', password: 'eight888',
        });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        assert.ok(ok.body.token);
      } finally {
        await pool.query(`DELETE FROM users WHERE employee_id = 'BOOT1'`);
        const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        for (const [emp, roleId] of [[superAdmin.employeeId, adminRoleId], [superAdmin2.employeeId, superAdminRoleId]] as const) {
          const existing = await pool.query(`SELECT id FROM users WHERE employee_id = $1`, [emp]);
          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO users (id, employee_id, full_name, email, password, role_id, department_id, is_active, account_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'ACTIVE')`,
              [emp === superAdmin.employeeId ? superAdmin.id : superAdmin2.id, emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleId, deptId]
            );
          }
        }
      }
      // The restored admins still sign in.
      assert.equal((await loginAs('DZ4ADMIN', ADMIN_PASSWORD)).status, 200);
    });

    it('self change: 7 fails, 8 passes and signs in', async () => {
      const victim = await mkVictim();
      const login = await loginAs(victim.employeeId, victim.password);
      assert.equal(login.status, 200);
      const token = login.body.token;
      const short = await request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: victim.id, currentPassword: victim.password, newPassword: 'short7!' });
      assert.equal(short.status, 400);
      assert.match(short.body.message || '', /at least 8 characters/);
      const ok = await request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: victim.id, currentPassword: victim.password, newPassword: 'eight888' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await loginAs(victim.employeeId, 'eight888')).status, 200);
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 401);
    });

    it('forced change: 7 fails, 8 passes and clears the flag', async () => {
      const victim = await mkVictim('TempPass1', true);
      const login = await loginAs(victim.employeeId, victim.password);
      assert.equal(login.status, 200);
      const token = login.body.token;
      const short = await request(app).post('/api/auth/change-required-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'short7!' });
      assert.equal(short.status, 400);
      assert.match(short.body.message || '', /at least 8 characters/);
      const ok = await request(app).post('/api/auth/change-required-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'eight888' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await userRow(victim.employeeId)).must_change_password, false);
      assert.equal((await loginAs(victim.employeeId, 'eight888')).status, 200);
    });

    it('admin reset: 7 fails, 8 passes and signs in', async () => {
      const victim = await mkVictim();
      const short = await request(app).post(`/api/users/${victim.id}/reset-password`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ password: 'short7!' });
      assert.equal(short.status, 400);
      assert.match(short.body.message || '', /at least 8 characters/);
      const ok = await request(app).post(`/api/users/${victim.id}/reset-password`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ password: 'ResetPass1' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await loginAs(victim.employeeId, 'ResetPass1')).status, 200);
    });

    it('user create/edit inline sets follow the same floor', async () => {
      const short = await request(app).post('/api/users')
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({
          fullName: 'Create Short', employeeId: 'DZ4NEW1', email: 'dz4new1@test.com',
          role: 'EMPLOYEE', departmentId: deptId, managerId: mgr.employeeId, password: 'short7!',
        });
      assert.equal(short.status, 400);
      assert.match(short.body.message || '', /at least 8 characters/);
      const created = await request(app).post('/api/users')
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({
          fullName: 'Create Eight', employeeId: 'DZ4NEW1', email: 'dz4new1@test.com',
          role: 'EMPLOYEE', departmentId: deptId, managerId: mgr.employeeId, password: 'CreatePass1',
        });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const victim = await mkVictim();
      const editShort = await request(app).put(`/api/users/${victim.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ password: 'short7!' });
      assert.equal(editShort.status, 400);
      assert.match(editShort.body.message || '', /at least 8 characters/);
      const editOk = await request(app).put(`/api/users/${victim.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ password: 'EditPass12' });
      assert.equal(editOk.status, 200, JSON.stringify(editOk.body));
      assert.equal((await loginAs(victim.employeeId, 'EditPass12')).status, 200);
    });

    it('bulk import temporary passwords follow the floor (pure + wired)', async () => {
      assert.match(validatePasswordPolicy('short7!', 8) || '', /at least 8 characters/);
      assert.equal(validatePasswordPolicy('eight888', 8), null);
      assert.equal(validatePasswordPolicy('', 8), null);
      // The live value, not the default: a policy of 12 refuses 8.
      assert.match(validatePasswordPolicy('eight888', 12) || '', /at least 12 characters/);
    });

    it('code floor of 5: a stored value below 5 still enforces 5', async () => {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
         VALUES ('SecurityPolicy', 'config', 'Security Policy Config', 1, FALSE, TRUE, $1::jsonb)
         ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`,
        [JSON.stringify({ passwordMinLength: 3 })]
      );
      assert.equal((await getSecurityPolicy()).passwordMinLength, 5);
      const victim = await mkVictim();
      const login = await loginAs(victim.employeeId, victim.password);
      const token = login.body.token;
      const four = await request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: victim.id, currentPassword: victim.password, newPassword: 'four' });
      assert.equal(four.status, 400);
      assert.match(four.body.message || '', /at least 5 characters/);
      const five = await request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: victim.id, currentPassword: victim.password, newPassword: 'five5' });
      assert.equal(five.status, 200, JSON.stringify(five.body));
    });
  });

  /* ==================================================================
     (c) Per-account lockout (A9)
  ================================================================== */
  describe('per-account lockout', () => {
    it('9 failures leave the account open; the 10th locks it (423)', async () => {
      const victim = await mkVictim();
      for (let i = 0; i < 9; i++) {
        assert.equal((await loginAs(victim.employeeId, 'wrong-password')).status, 401);
      }
      assert.equal((await userRow(victim.employeeId)).failed_login_attempts, 9);
      // Still open on the 9th failure: the right password works.
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 200);
      assert.equal((await userRow(victim.employeeId)).failed_login_attempts, 0);
      for (let i = 0; i < 9; i++) {
        assert.equal((await loginAs(victim.employeeId, 'wrong-password')).status, 401);
      }
      const tenth = await loginAs(victim.employeeId, 'wrong-password');
      assert.equal(tenth.status, 423);
      assert.equal(tenth.body.error, 'account_locked');
      assert.ok(tenth.body.lockedUntil);
      const row = await userRow(victim.employeeId);
      assert.equal(row.failed_login_attempts, 10);
      assert.ok(row.locked_until);
      const mins = (new Date(row.locked_until).getTime() - Date.now()) / 60000;
      assert.ok(mins > 29 && mins <= 30, `lock should last ~30 min, got ${mins}`);
      assert.equal(checkAccountLockout(row).locked, true);
    });

    it('a locked account refuses the right password and does not extend the lock', async () => {
      const victim = await mkVictim();
      for (let i = 0; i < 10; i++) await loginAs(victim.employeeId, 'wrong-password');
      const before = await userRow(victim.employeeId);
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 423);
      assert.equal((await loginAs(victim.employeeId, 'another-wrong')).status, 423);
      const after = await userRow(victim.employeeId);
      assert.equal(after.failed_login_attempts, 10);
      assert.equal(new Date(after.locked_until).getTime(), new Date(before.locked_until).getTime());
    });

    it('expiry re-opens the account and a good login resets the counter', async () => {
      const victim = await mkVictim();
      for (let i = 0; i < 10; i++) await loginAs(victim.employeeId, 'wrong-password');
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 423);
      // TZ-proof expiry: store the UTC wall-clock string (see
      // recordFailedLoginAttempt) — NOW() - interval would store a
      // session-timezone wall time that reads back shifted.
      const pastUtc = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ');
      await pool.query(`UPDATE users SET locked_until = $1::timestamp WHERE id = $2`, [pastUtc, victim.id]);
      assert.equal(checkAccountLockout(await userRow(victim.employeeId)).locked, false);
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 200);
      const row = await userRow(victim.employeeId);
      assert.equal(row.failed_login_attempts, 0);
      assert.equal(row.locked_until, null);
    });

    it('disabled lockout never locks, however many failures', async () => {
      await unlockAs(superAdmin);
      const saved = await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ lockoutEnabled: false }));
      assert.equal(saved.status, 200);
      const victim = await mkVictim();
      for (let i = 0; i < 12; i++) {
        assert.equal((await loginAs(victim.employeeId, 'wrong-password')).status, 401);
      }
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 200);
      const row = await userRow(victim.employeeId);
      assert.equal(row.failed_login_attempts, 0);
      assert.equal(row.locked_until, null);
    });

    it('threshold and duration come from the policy (3 failures → 5 min)', async () => {
      await unlockAs(superAdmin);
      const saved = await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ lockoutThreshold: 3, lockoutMinutes: 5 }));
      assert.equal(saved.status, 200);
      const victim = await mkVictim();
      assert.equal((await loginAs(victim.employeeId, 'wrong-password')).status, 401);
      assert.equal((await loginAs(victim.employeeId, 'wrong-password')).status, 401);
      const third = await loginAs(victim.employeeId, 'wrong-password');
      assert.equal(third.status, 423);
      const mins = (new Date((await userRow(victim.employeeId)).locked_until).getTime() - Date.now()) / 60000;
      assert.ok(mins > 4 && mins <= 5, `lock should last ~5 min, got ${mins}`);
    });

    it('an unknown employee id never locks and never leaks (401, no row)', async () => {
      for (let i = 0; i < 12; i++) {
        assert.equal((await loginAs('DZ4GHOST', 'wrong-password')).status, 401);
      }
      assert.equal(await userRow('DZ4GHOST'), undefined);
    });
  });

  /* ==================================================================
     (d) Admin early-unlock via user edit (clear-only)
  ================================================================== */
  describe('admin early-unlock via user edit', () => {
    async function lockVictim(victim: any): Promise<void> {
      for (let i = 0; i < 10; i++) await loginAs(victim.employeeId, 'wrong-password');
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 423);
    }

    it('admin unlock clears the lock and the login works again, audited', async () => {
      const victim = await mkVictim();
      await lockVictim(victim);
      const before = await auditRows('user-unlocked');
      const res = await request(app).put(`/api/users/${victim.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ clearLockout: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.failedLoginAttempts, 0);
      assert.equal(res.body.data.lockedUntil, null);
      const row = await userRow(victim.employeeId);
      assert.equal(row.failed_login_attempts, 0);
      assert.equal(row.locked_until, null);
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 200);
      const after = await auditRows('user-unlocked');
      assert.equal(after.length, before.length + 1);
      assert.equal(after[after.length - 1].target_user_id, victim.id);
      assert.equal(after[after.length - 1].metadata.employeeId, victim.employeeId);
    });

    it('a non-admin users.edit holder cannot unlock (403)', async () => {
      const victim = await mkVictim();
      await lockVictim(victim);
      const res = await request(app).put(`/api/users/${victim.id}`)
        .set('Authorization', `Bearer ${tokenFor(editor)}`)
        .send({ clearLockout: true });
      assert.equal(res.status, 403);
      assert.match(res.body.message || '', /Only administrators can unlock/);
      assert.equal((await loginAs(victim.employeeId, victim.password)).status, 423);
    });

    it('unlocking an unlocked account is a 200 no-op and writes no audit row', async () => {
      const victim = await mkVictim();
      const before = await auditRows('user-unlocked');
      const res = await request(app).put(`/api/users/${victim.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ clearLockout: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await auditRows('user-unlocked')).length, before.length);
    });

    it('admin password reset also clears a lock', async () => {
      const victim = await mkVictim();
      await lockVictim(victim);
      const res = await request(app).post(`/api/users/${victim.id}/reset-password`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ password: 'ResetPass1' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await loginAs(victim.employeeId, 'ResetPass1')).status, 200);
    });
  });

  /* ==================================================================
     (e) Token lifetime (A5)
  ================================================================== */
  describe('token lifetime', () => {
    function tokenDays(token: string): number {
      const decoded = jwt.decode(token) as { iat: number; exp: number } | null;
      assert.ok(decoded && decoded.iat && decoded.exp, 'token must carry iat/exp');
      return (decoded.exp - decoded.iat) / 86400;
    }

    it('newly issued tokens honour the policy (1 day, 30 days, default 7)', async () => {
      const victim = await mkVictim();
      await unlockAs(superAdmin);
      await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ tokenLifetimeDays: 1 }));
      const one = await loginAs(victim.employeeId, victim.password);
      assert.equal(one.status, 200);
      assert.ok(Math.abs(tokenDays(one.body.token) - 1) < 0.001, `expected 1 day, got ${tokenDays(one.body.token)}`);
      await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ tokenLifetimeDays: 30 }));
      const thirty = await loginAs(victim.employeeId, victim.password);
      assert.equal(thirty.status, 200);
      assert.ok(Math.abs(tokenDays(thirty.body.token) - 30) < 0.001, `expected 30 days, got ${tokenDays(thirty.body.token)}`);
      // Back to defaults (beforeEach also resets, this pins the value).
      await dz('put', '/security-policy', superAdmin, defaultPolicyInput({}));
      const seven = await loginAs(victim.employeeId, victim.password);
      assert.ok(Math.abs(tokenDays(seven.body.token) - 7) < 0.001, `expected 7 days, got ${tokenDays(seven.body.token)}`);
    });

    it('a corrupt stored lifetime clamps to 30 days', async () => {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
         VALUES ('SecurityPolicy', 'config', 'Security Policy Config', 1, FALSE, TRUE, $1::jsonb)
         ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`,
        [JSON.stringify({ tokenLifetimeDays: 99 })]
      );
      assert.equal((await getSecurityPolicy()).tokenLifetimeDays, 30);
      const victim = await mkVictim();
      const login = await loginAs(victim.employeeId, victim.password);
      assert.equal(login.status, 200);
      assert.ok(Math.abs(tokenDays(login.body.token) - 30) < 0.001);
    });
  });

  /* ==================================================================
     (f) Login rate limit (A8) — a live limiter reading the policy
  ================================================================== */
  describe('login rate limit', () => {
    it('pure resolver: stored 5 → 5, 200 → 100, 2 → 5, missing → 20', async () => {
      assert.equal(await getAuthRateLimitAttempts(), 20);
      assert.equal(resolveAuthRateLimitAttempts(5), 5);
      assert.equal(resolveAuthRateLimitAttempts(200), 100);
      assert.equal(resolveAuthRateLimitAttempts(2), 5);
      assert.equal(resolveAuthRateLimitAttempts('x'), 20);
    });

    it('a live limiter enforces the policy value and re-reads it', async () => {
      await unlockAs(superAdmin);
      const putRes = await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ authRateLimitAttempts: 5 }));
      assert.equal(putRes.status, 200);
      assert.equal(await getAuthRateLimitAttempts(), 5);

      // An isolated limiter (own store) on a dummy 401 endpoint, so
      // failed attempts count exactly like failed logins.
      const probe = express();
      probe.use(express.json());
      probe.use(createAuthLimiter());
      probe.post('/probe', (_req, res) => res.status(401).json({ success: false }));
      for (let i = 0; i < 5; i++) {
        const r = await request(probe).post('/probe').send({});
        assert.equal(r.status, 401, `attempt ${i + 1} should pass, got ${r.status}`);
      }
      assert.equal((await request(probe).post('/probe').send({})).status, 429);

      // Raising the policy to 7 re-opens the very next attempt: the
      // limiter reads the live value per request (hits 7, max 7 —
      // the count is incremented before the comparison, so 6 would
      // still refuse). The attempt after that refuses again.
      await dz('put', '/security-policy', superAdmin, defaultPolicyInput({ authRateLimitAttempts: 7 }));
      assert.equal((await request(probe).post('/probe').send({})).status, 401);
      assert.equal((await request(probe).post('/probe').send({})).status, 429);

      // Restore the default before any other test unlocks anything.
      await dz('put', '/security-policy', superAdmin, defaultPolicyInput({}));
      assert.equal(await getAuthRateLimitAttempts(), 20);
    });
  });

  /* ==================================================================
     (g) B10 — SUPERADMIN role-delete guard
  ================================================================== */
  describe('role-delete guard (B10)', () => {
    const delRole = (id: string) =>
      request(app).delete(`/api/roles/${encodeURIComponent(id)}`).set('Authorization', `Bearer ${tokenFor(superAdmin)}`);

    it('SUPERADMIN refused by code and by UUID; ADMIN still refused both ways', async () => {
      assert.equal((await delRole('SUPERADMIN')).status, 400);
      assert.equal((await delRole(superAdminRoleId)).status, 400);
      assert.equal((await delRole('ADMIN')).status, 400);
      assert.equal((await delRole(adminRoleId)).status, 400);
      const body = await delRole('superadmin');
      assert.equal(body.status, 400);
      assert.match(body.body.message || '', /cannot be deleted/);
      // Both system roles still exist.
      const rows: any = await pool.query(`SELECT role_code FROM roles WHERE UPPER(role_code) IN ('ADMIN','SUPERADMIN')`);
      assert.equal(rows.rows.length, 2);
    });

    it('a normal role deletes; a role with users 409s; a missing role 404s', async () => {
      const temp = (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ('DZ4TEMP', 'Temp', 50) RETURNING id`
      )).rows[0].id;
      const ok = await delRole(temp);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await pool.query(`SELECT 1 FROM roles WHERE id = $1`, [temp])).rows.length, 0);
      // EMPLOYEE still holds users (victims, manager chain) — the FK refuses.
      const held = await delRole('EMPLOYEE');
      assert.equal(held.status, 409);
      assert.match(held.body.message || '', /assigned to existing users/);
      assert.equal((await delRole('NOPE')).status, 404);
      // The role-delete audit row exists for the successful delete.
      const rows = await auditRows('role-delete');
      assert.ok(rows.some(r => r.entity_id === temp));
    });
  });

  /* ==================================================================
     (h) Last-super-admin protection still holds (N3/N4) — and the
         lockout applies uniformly (a lock is time-bounded, not a
         removal, so it is not an N3/N4 removal)
     Run LAST: the demote step below removes the second admin.
  ================================================================== */
  describe('last-super-admin protection (runs last)', () => {
    it('the last admin CAN be locked by failures — and the OTHER admin unlocks them', async () => {
      for (let i = 0; i < 10; i++) await loginAs(superAdmin.employeeId, 'wrong-password');
      assert.equal((await loginAs(superAdmin.employeeId, ADMIN_PASSWORD)).status, 423);
      const res = await request(app).put(`/api/users/${superAdmin.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin2)}`)
        .send({ clearLockout: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await loginAs(superAdmin.employeeId, ADMIN_PASSWORD)).status, 200);
    });

    it('demoting the second admin works while two exist; then the last admin cannot be demoted, deactivated or deleted', async () => {
      const demoteSecond = await request(app).put(`/api/users/${superAdmin2.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ role: 'EMPLOYEE', managerId: mgr.employeeId });
      assert.equal(demoteSecond.status, 200, JSON.stringify(demoteSecond.body));
      assert.equal(demoteSecond.body.data.roleCode, 'EMPLOYEE');

      // Now superAdmin is the ONLY active admin: every removal refuses.
      const demoteLast = await request(app).put(`/api/users/${superAdmin.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ role: 'EMPLOYEE', managerId: mgr.employeeId });
      assert.equal(demoteLast.status, 409);
      assert.match(demoteLast.body.message || '', /last active administrator/);
      const deactivateLast = await request(app).put(`/api/users/${superAdmin.id}`)
        .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
        .send({ status: 'Inactive' });
      assert.equal(deactivateLast.status, 409);
      // Delete of the last admin must be ATTEMPTED by someone else:
      // self-delete refuses first (400), before the last-admin guard.
      const deleteLast = await request(app).delete(`/api/users/${superAdmin.id}`)
        .set('Authorization', `Bearer ${tokenFor(editor)}`);
      assert.equal(deleteLast.status, 409);
      assert.match(deleteLast.body.message || '', /last active administrator/);
      // And the last admin is still there, still an admin, still able to sign in.
      const row = await userRow(superAdmin.employeeId);
      assert.equal(row.is_active, true);
      assert.equal((await loginAs(superAdmin.employeeId, ADMIN_PASSWORD)).status, 200);
    });
  });

  /* ==================================================================
     (i) DZ-0 gate + DZ-3 config still work on this tree
  ================================================================== */
  describe('no regression — DZ-0 gate + DZ-3 config', () => {
    it('unlock + overview still work; DZ-3 config still serves defaults', async () => {
      await unlockAs(superAdmin);
      const overview = await dz('get', '/overview', superAdmin);
      assert.equal(overview.status, 200, JSON.stringify(overview.body));
      assert.ok(Array.isArray(overview.body.data.cards));
      assert.ok(overview.body.data.cards.length > 0);
      assert.ok(Array.isArray(overview.body.data.invariants));
      const quality = await dz('get', '/lead-quality', superAdmin);
      assert.equal(quality.status, 200, JSON.stringify(quality.body));
      assert.equal(quality.body.data.config.baseScore, 35);
      assert.equal(quality.body.data.defaults.baseScore, 35);
      const status = await dz('get', '/status', superAdmin);
      assert.equal(status.status, 200);
      assert.equal(status.body.unlocked, true);
      assert.equal(status.body.unlockLifetimeMinutes, 10);
    });
  });
});
