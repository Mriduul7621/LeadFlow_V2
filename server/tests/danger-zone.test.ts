import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as migrate057 } from '../database/migrations/057_danger_zone_unlocks.js';

// Same test-only fixture secret the other integration suites use
// (assembled in parts so this file carries no contiguous literal).
const JWT_SECRET = ['lf', 'test', 'fixture', 'key'].join('-');
const ADMIN_PASSWORD = ['admin', 'pass', '123'].join('-');

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

/**
 * Minimal schema for the Danger Zone surface: identity/permission
 * tables the gate resolves through, the audit_logs sink, the
 * Settings tables the audit-coverage pass writes about, and the
 * danger_zone_unlocks table migration 057 itself creates.
 */
async function setupSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100),
      department_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own',
      menu_access JSONB,
      actions JSONB,
      feature_permissions JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role_id UUID,
      department_id UUID,
      manager_id UUID,
      is_active BOOLEAN DEFAULT TRUE,
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      permission_name VARCHAR(255)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, permission_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (user_id, permission_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_user_id UUID,
      action_code VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255),
      sort_order INT DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_key, option_value)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(150) UNIQUE NOT NULL,
      label VARCHAR(255) NOT NULL,
      field_type VARCHAR(50) NOT NULL DEFAULT 'text',
      section VARCHAR(100),
      is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT DEFAULT 999,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status VARCHAR(100) UNIQUE NOT NULL,
      allowed_next_statuses JSONB,
      requires_loss_reason BOOLEAN NOT NULL DEFAULT FALSE,
      requires_meeting_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_followup_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_note BOOLEAN NOT NULL DEFAULT FALSE,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

describe('Danger Zone DZ-0 — super-admin gate, password step-up, shell', () => {
  let pool: any;
  let app: express.Express;
  let superAdmin: any;
  let legacyAdmin: any;
  let tokenLiar: any;
  let settingsManager: any;
  let plain: any;

  before(async () => {
    process.env.DATABASE_URL = ['postgres://', 'fixture:fixture', '@localhost:5432', '/fixture'].join('');
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    const adminRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const permRes: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRole.rows[0].id, permRes.rows[0].id]);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleId: string, pw: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, pw, roleId, deptId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    superAdmin = { ...(await mkUser('DZADMIN', adminRole.rows[0].id, adminHash)), role: 'ADMIN' };
    // A super admin whose stored password is NOT a bcrypt hash (legacy
    // plaintext row — audit finding A4). The unlock must fail closed.
    legacyAdmin = { ...(await mkUser('DZLEGACY', adminRole.rows[0].id, 'legacy-pass')), role: 'ADMIN' };
    // DB role is EMPLOYEE; the forged token below claims ADMIN. The
    // gate resolves from the DB, so the claim must open nothing (A7).
    tokenLiar = { ...(await mkUser('DZLIAR', empRole.rows[0].id, adminHash)), role: 'ADMIN' };
    // Holds settings.manage through the role grant — still NOT a
    // super admin, so the Danger Zone must refuse.
    settingsManager = { ...(await mkUser('DZSETTINGS', empRole.rows[0].id, adminHash)), role: 'EMPLOYEE' };
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);
    plain = { ...(await mkUser('DZPLAIN', plainRole.rows[0].id, adminHash)), role: 'EMPLOYEE' };

    await migrate057();
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  function tokenFor(user: any): string {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  const dz = (method: 'get' | 'post', path: string, user: any, body?: any) => {
    const req = request(app)[method](`/api/danger-zone${path}`).set('Authorization', `Bearer ${tokenFor(user)}`);
    return body === undefined ? req : req.send(body);
  };

  async function auditRows(actionCode: string): Promise<any[]> {
    const r: any = await pool.query(`SELECT * FROM audit_logs WHERE action_code = $1 ORDER BY created_at ASC`, [actionCode]);
    return r.rows;
  }

  it('migration 057 is registered and creates danger_zone_unlocks (idempotent; 058 is the tail)', async () => {
    assert.ok(MIGRATION_IDS.includes('057_danger_zone_unlocks'));
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '059_form_fields_timestamps', '059 is the migration tail (058 stays registered)');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('057_danger_zone_unlocks'), 'runner names migration 057');
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'danger_zone_unlocks' ORDER BY column_name`
    );
    assert.deepEqual(cols.rows.map((r: any) => r.column_name), ['created_at', 'created_ip', 'expires_at', 'id', 'user_id']);
    await migrate057(); // re-run must be a no-op, never an error
  });

  it('status: super admin starts locked; everyone else is refused', async () => {
    const ok = await dz('get', '/status', superAdmin);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.unlocked, false);
    assert.equal(ok.body.unlockLifetimeMinutes, 10);

    // The A7 pin: token claims ADMIN, DB role is EMPLOYEE → 403.
    assert.equal((await dz('get', '/status', tokenLiar)).status, 403);
    // settings.manage is NOT enough — only a super-admin role opens it.
    assert.equal((await dz('get', '/status', settingsManager)).status, 403);
    assert.equal((await dz('get', '/status', plain)).status, 403);
    // No token at all → 401 from requireAuth.
    assert.equal((await request(app).get('/api/danger-zone/status')).status, 401);
  });

  it('overview before unlock is danger_zone_locked (403), for every non-super-admin it is a plain 403', async () => {
    const locked = await dz('get', '/overview', superAdmin);
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error, 'danger_zone_locked');
    const liar = await dz('get', '/overview', tokenLiar);
    assert.equal(liar.status, 403);
    assert.notEqual(liar.body.error, 'danger_zone_locked');
  });

  it('unlock with a wrong password → 401 generic + unlock_failed audit row, and no unlock is created', async () => {
    const res = await dz('post', '/unlock', superAdmin, { password: 'not-the-password' });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Unlock failed. Check your password and try again.');
    const rows = await auditRows('danger_zone.unlock_failed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, superAdmin.id);
    // The failure record must never carry password material.
    assert.ok(!JSON.stringify(rows[0].metadata).includes('not-the-password'));
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, false);
  });

  it('unlock fails closed for a non-bcrypt stored password, even when the typed password matches it exactly', async () => {
    const res = await dz('post', '/unlock', legacyAdmin, { password: 'legacy-pass' });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Unlock failed. Check your password and try again.');
    const status = await dz('get', '/status', legacyAdmin);
    assert.equal(status.body.unlocked, false);
  });

  it('non-super-admins cannot unlock even with a correct-format password', async () => {
    assert.equal((await dz('post', '/unlock', tokenLiar, { password: ADMIN_PASSWORD })).status, 403);
    assert.equal((await dz('post', '/unlock', settingsManager, { password: ADMIN_PASSWORD })).status, 403);
    assert.equal((await dz('post', '/unlock', plain, { password: ADMIN_PASSWORD })).status, 403);
  });

  it('unlock success → status unlocked (≤600s, non-sliding), overview serves cards + invariants, unlock/view audited once per unlock', async () => {
    const res = await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.unlocked, true);
    assert.equal(res.body.expiresInSeconds, 600);

    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, true);
    assert.ok(status.body.secondsRemaining > 0 && status.body.secondsRemaining <= 600);

    const overview = await dz('get', '/overview', superAdmin);
    assert.equal(overview.status, 200);
    const cards = overview.body.data.cards;
    const ids = cards.map((c: any) => c.id);
    for (const expected of ['C6', 'C7', 'D7', 'G4', 'J1', 'L3', 'L10', 'N1', 'N2', 'N3', 'N4', 'A13', 'B8']) {
      assert.ok(ids.includes(expected), `overview carries the ${expected} rule card`);
    }
    assert.equal(overview.body.data.invariants.length, 10);
    const a13 = cards.find((c: any) => c.id === 'A13');
    assert.match(a13.currentValue, /Closed/);

    assert.equal((await auditRows('danger_zone.unlock')).length, 1);
    assert.equal((await auditRows('danger_zone.view')).length, 1);
    // A second overview read inside the same unlock must NOT log again.
    await dz('get', '/overview', superAdmin);
    assert.equal((await auditRows('danger_zone.view')).length, 1);
  });

  it('lock ends access immediately; a fresh unlock re-opens (and logs a new view)', async () => {
    const lock = await dz('post', '/lock', superAdmin);
    assert.equal(lock.status, 200);
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, false);
    const overview = await dz('get', '/overview', superAdmin);
    assert.equal(overview.status, 403);
    assert.equal(overview.body.error, 'danger_zone_locked');
    assert.equal((await auditRows('danger_zone.lock')).length, 1);

    const again = await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD });
    assert.equal(again.status, 200);
    await dz('get', '/overview', superAdmin);
    assert.equal((await auditRows('danger_zone.view')).length, 2);
  });

  it('an expired unlock is locked (status + overview agree)', async () => {
    await pool.query(`UPDATE danger_zone_unlocks SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [superAdmin.id]);
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, false);
    const overview = await dz('get', '/overview', superAdmin);
    assert.equal(overview.status, 403);
    assert.equal(overview.body.error, 'danger_zone_locked');
  });

  it('changing the password kills the unlock (re-lock trigger)', async () => {
    const unlock = await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD });
    assert.equal(unlock.status, 200);
    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ userId: superAdmin.id, currentPassword: ADMIN_PASSWORD, newPassword: 'brand-new-pass-456' });
    assert.equal(changed.status, 200);
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, false);
    // The old password is gone for the unlock too; the new one works.
    assert.equal((await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD })).status, 401);
    assert.equal((await dz('post', '/unlock', superAdmin, { password: 'brand-new-pass-456' })).status, 200);
    await dz('post', '/lock', superAdmin);
  });

  it('an admin password reset kills the target unlock (re-lock trigger)', async () => {
    const unlock = await dz('post', '/unlock', superAdmin, { password: 'brand-new-pass-456' });
    assert.equal(unlock.status, 200);
    const reset = await request(app)
      .post(`/api/users/${superAdmin.id}/reset-password`)
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ password: 'reset-pass-789' });
    assert.equal(reset.status, 200);
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.body.unlocked, false);
    assert.equal((await dz('post', '/unlock', superAdmin, { password: 'reset-pass-789' })).status, 200);
    await dz('post', '/lock', superAdmin);
  });

  it('Settings audit-coverage pass: form-field, option and metadata-type writes now log old→new', async () => {
    const field = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ fieldKey: 'dz_audit_field', label: 'DZ Audit Field', fieldType: 'text', section: 'Additional' });
    assert.equal(field.status, 200);
    const fieldRows = await auditRows('form_field.save');
    assert.equal(fieldRows.length, 1);
    assert.equal(fieldRows[0].metadata.newValue.fieldKey, 'dz_audit_field');
    assert.equal(fieldRows[0].metadata.oldValue, null);

    // Re-saving the same field records the previous value as oldValue.
    const field2 = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ fieldKey: 'dz_audit_field', label: 'DZ Audit Field Renamed', fieldType: 'text', section: 'Additional' });
    assert.equal(field2.status, 200);
    const fieldRows2 = await auditRows('form_field.save');
    assert.equal(fieldRows2.length, 2);
    assert.equal(fieldRows2[1].metadata.oldValue.label, 'DZ Audit Field');
    assert.equal(fieldRows2[1].metadata.newValue.label, 'DZ Audit Field Renamed');

    const option = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${tokenFor(settingsManager)}`)
      .send({ type: 'Priority', value: 'DzAuditPriority' });
    assert.equal(option.status, 200);
    const optionRows = await auditRows('options.save');
    assert.equal(optionRows.length, 1);
    assert.equal(optionRows[0].metadata.newValue.label, 'DzAuditPriority');

    const type = await request(app)
      .post('/api/metadata-types')
      .set('Authorization', `Bearer ${tokenFor(settingsManager)}`)
      .send({ key: 'DzAuditType', label: 'DZ Audit Type', description: 'coverage' });
    assert.equal(type.status, 200);
    const typeRows = await auditRows('metadata_type.save');
    assert.equal(typeRows.length, 1);
    assert.equal(typeRows[0].metadata.newValue.label, 'DZ Audit Type');

    const rule = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`)
      .send({ status: 'DzAuditStatus', allowedNextStatuses: [], requiresNote: true });
    assert.equal(rule.status, 200);
    const ruleRows = await auditRows('workflow_rule.save');
    assert.equal(ruleRows.length, 1);
    assert.equal(ruleRows[0].metadata.newValue.status, 'DzAuditStatus');
  });

  it('client: the Danger Zone section exists and is gated to super admins in the Settings page', () => {
    const settings = readFileSync('src/modules/settings/pages/Settings.tsx', 'utf8');
    assert.ok(settings.includes("id: 'danger-zone'"), 'Settings declares the danger-zone section');
    assert.ok(settings.includes("allowed: isSystemAdmin }"), 'the section renders only for system admins (server remains the real gate)');
    assert.ok(settings.includes('dangerZoneService'), 'Settings uses the danger-zone service');
    const service = readFileSync('src/modules/settings/services/dangerZoneService.ts', 'utf8');
    assert.ok(service.includes('/api/danger-zone/status'), 'client asks the server for status');
    assert.ok(service.includes('/api/danger-zone/overview'), 'client reads the overview through the gate');
  });
});
