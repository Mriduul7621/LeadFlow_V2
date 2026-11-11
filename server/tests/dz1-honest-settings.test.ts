import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
// NOTE: the service modules are imported lazily inside before()
// (after the fixture env is set) — they transitively load shared.ts,
// which reads process.env at module load; importing them at the top
// of this file would snapshot an empty JWT_SECRET and every HTTP
// call below would 401.
let fallbackStore: any;
let getNotificationSettings: any;
let getNotificationSettingsSyncFallback: any;
let setNotificationSettings: any;
let parseEnabledMeta: any;
let createAssignmentNotifications: any;
let createAssignmentNotificationsDemo: any;
let runDailyPushReminders: any;

async function loadServices() {
  if (getNotificationSettings) return;
  ({ fallbackStore } = await import('../fallbackStore.js'));
  ({ getNotificationSettings, getNotificationSettingsSyncFallback, setNotificationSettings, parseEnabledMeta } =
    await import('../services/NotificationSettingsService.js'));
  ({ createAssignmentNotifications, createAssignmentNotificationsDemo } =
    await import('../services/NotificationService.js'));
  ({ runDailyPushReminders } = await import('../services/PushReminderService.js'));
}

/**
 * DZ-1 — Honest Settings.
 * ------------------------------------------------------------------
 * 1. The Push Intelligence toggles are REAL: persisted in the
 *    Metadata Engine ('Notifications' group), read by the services
 *    that produce the behaviour, defaulting ON (= pre-DZ-1 behaviour)
 *    whenever unset. OFF stops assignment notifications (DB + demo)
 *    and the daily push digest; ON restores them.
 * 2. The settings API: reads open to any signed-in user; writes need
 *    the settings.manage permission code and are audit-logged with
 *    old→new values.
 * 3. Form Builder mutations (audit item I1) are gated by
 *    settings.manage instead of the old requireAdmin role claim: a
 *    non-admin settings manager can use them; a user with neither the
 *    grant nor the ADMIN role is refused.
 */

// Test-only fixture secret (assembled in parts, like the other suites).
const JWT_SECRET = ['lf', 'test', 'fixture', 'key'].join('-');

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
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT TRUE,
      must_change_password BOOLEAN DEFAULT FALSE,
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
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      recipient_key VARCHAR(100),
      title VARCHAR(255),
      message TEXT,
      event_type VARCHAR(100),
      idempotency_key VARCHAR(255),
      lead_code VARCHAR(100),
      reference_id VARCHAR(255),
      reference_type VARCHAR(100),
      is_read BOOLEAN DEFAULT FALSE,
      type VARCHAR(50) DEFAULT 'info',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem_idx ON notifications (idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      endpoint TEXT,
      keys JSONB DEFAULT '{}'::jsonb,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) UNIQUE NOT NULL,
      label VARCHAR(255) NOT NULL,
      field_type VARCHAR(50) NOT NULL DEFAULT 'text',
      section VARCHAR(100) DEFAULT '',
      is_mandatory BOOLEAN DEFAULT FALSE,
      is_visible BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

describe('DZ-1 Honest Settings — DB mode', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let privileged: any;
  let plain: any;
  let assignee: any;
  let manager: any;

  before(async () => {
    process.env.DATABASE_URL = ['postgres:/', 'fixture:fixture', '@localhost:5432', '/fixture'].join('');
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await loadServices();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    const adminRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);
    const permRes: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRole.rows[0].id, permRes.rows[0].id]);

    const mkUser = async (emp: string, name: string, roleId: string, chain: string[] = []) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, reporting_chain)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6::jsonb) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@test.com`, roleId, deptId, JSON.stringify(chain)]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    adminUser = { ...(await mkUser('ADMIN1', 'Admin User', adminRole.rows[0].id)), role: 'ADMIN' };
    privileged = { ...(await mkUser('EMPP', 'Privileged Employee', empRole.rows[0].id)), role: 'EMPLOYEE' };
    plain = { ...(await mkUser('EMPU', 'Plain Employee', plainRole.rows[0].id)), role: 'EMPLOYEE' };
    manager = { ...(await mkUser('MGR1', 'Manager One', empRole.rows[0].id)), role: 'EMPLOYEE' };
    assignee = { ...(await mkUser('ASN1', 'Assignee One', plainRole.rows[0].id, ['MGR1'])), role: 'EMPLOYEE' };

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

  it('parseEnabledMeta: only an explicit boolean false turns a toggle off', () => {
    assert.equal(parseEnabledMeta({ enabled: false }), false);
    assert.equal(parseEnabledMeta({ enabled: true }), true);
    assert.equal(parseEnabledMeta({}), true);
    assert.equal(parseEnabledMeta(null), true);
    assert.equal(parseEnabledMeta('nope'), true);
    assert.equal(parseEnabledMeta({ enabled: 'false' }), true);
  });

  it('settings default to ON when nothing is stored', async () => {
    assert.deepEqual(await getNotificationSettings(), { assignmentAlerts: true, dailyPushSummary: true });
    const res = await request(app).get('/api/notifications/settings').set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { assignmentAlerts: true, dailyPushSummary: true });
  });

  it('PUT requires settings.manage: plain user refused, settings manager allowed, change is audit-logged old→new', async () => {
    const denied = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send({ assignmentAlerts: false });
    assert.equal(denied.status, 403);

    const saved = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ assignmentAlerts: false });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data, { assignmentAlerts: false, dailyPushSummary: true });

    const audit: any = await pool.query(`SELECT metadata FROM audit_logs WHERE action_code = 'notification_settings.save' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].metadata.changes.assignmentAlerts, { oldValue: true, newValue: false });

    // Restore for the following tests.
    await setNotificationSettings({ assignmentAlerts: true });
    assert.equal((await getNotificationSettings()).assignmentAlerts, true);
  });

  it('PUT rejects non-boolean and empty patches', async () => {
    const bad = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ assignmentAlerts: 'no' });
    assert.equal(bad.status, 400);
    const empty = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({});
    assert.equal(empty.status, 400);
  });

  it('assignment notifications: OFF creates nothing, ON creates assignee + upline rows', async () => {
    const base = {
      leadId: '00000000-0000-4000-8000-0000000000aa',
      leadCode: 'LD-1',
      prospectName: 'Prospect One',
      assignedToUserId: assignee.id,
      assignedToEmployeeId: 'ASN1',
      changedByEmployeeId: 'ADMIN1',
      eventType: 'lead-assigned',
    };
    await setNotificationSettings({ assignmentAlerts: false });
    const off = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'hist-off-1' });
    assert.equal(off.created, 0);
    let count: any = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications`);
    assert.equal(count.rows[0].n, 0);

    await setNotificationSettings({ assignmentAlerts: true });
    const on = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'hist-on-1' });
    assert.ok(on.created >= 2, `expected assignee + upline notifications, got ${on.created}`);
    count = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications`);
    assert.ok(count.rows[0].n >= 2);
  });

  it('daily push summary: OFF short-circuits the digest (enabled stays false even with push configured)', async () => {
    process.env.VAPID_PUBLIC_KEY = ['TEST', 'KEY'].join('-');
    process.env.VAPID_PRIVATE_KEY = 'test-private';
    try {
      await setNotificationSettings({ dailyPushSummary: false });
      const offRun = await runDailyPushReminders(new Date());
      assert.equal(offRun.enabled, false);
      assert.equal(offRun.sent, 0);
      assert.equal(offRun.usersTargeted, 0);

      await setNotificationSettings({ dailyPushSummary: true });
      const onRun = await runDailyPushReminders(new Date());
      // Push is "configured" in this test (isPushConfigured only checks
      // the env pair) — with the toggle ON the run proceeds past the
      // gate, which flips enabled true even with zero subscriptions.
      assert.equal(onRun.enabled, true);
      assert.equal(onRun.sent, 0);
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    }
  });

  it('form-fields gate (I1): settings manager (non-admin) can save/delete/reorder; plain user cannot; admin still can', async () => {
    const payload = { fieldKey: 'dz1_test_field', label: 'DZ1 Test Field', fieldType: 'text', section: 'Identity' };

    const denied = await request(app).post('/api/form-fields')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send(payload);
    assert.equal(denied.status, 403);

    const saved = await request(app).post('/api/form-fields')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send(payload);
    assert.equal(saved.status, 200);
    const fieldId = saved.body.id;
    assert.ok(fieldId);

    const reorder = await request(app).post('/api/form-fields/reorder')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ orderedIds: [fieldId] });
    assert.equal(reorder.status, 200);

    const deniedDelete = await request(app).delete(`/api/form-fields/${fieldId}`)
      .set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(deniedDelete.status, 403);

    const adminSaved = await request(app).post('/api/form-fields')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ ...payload, fieldKey: 'dz1_admin_field', label: 'DZ1 Admin Field' });
    assert.equal(adminSaved.status, 200);

    const removed = await request(app).delete(`/api/form-fields/${fieldId}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`);
    assert.equal(removed.status, 200);
  });
});

describe('DZ-1 Honest Settings — demo (fallback) mode', () => {
  before(async () => {
    await loadServices();
    delete process.env.DATABASE_URL;
    (fallbackStore as any).options = ((fallbackStore as any).options || []).filter(
      (o: any) => o.type !== 'Notifications'
    );
    (fallbackStore as any).notifications = [];
  });

  it('fallback settings default ON; OFF suppresses demo assignment notifications; ON restores them', async () => {
    assert.deepEqual(getNotificationSettingsSyncFallback(), { assignmentAlerts: true, dailyPushSummary: true });

    const users = (fallbackStore as any).users as any[];
    const assignee = { id: 'demo-user-asn', employeeId: 'DEMOASN', fullName: 'Demo Assignee' };
    if (!users.find((u: any) => u.employeeId === 'DEMOASN')) users.push(assignee);

    const base = {
      leadId: 'demo-lead-1',
      leadCode: 'LD-D1',
      prospectName: 'Demo Prospect',
      assignedToUserId: 'demo-user-asn',
      assignedToEmployeeId: 'DEMOASN',
      changedByEmployeeId: 'DEMOADMIN',
      eventType: 'lead-assigned',
    };

    await setNotificationSettings({ assignmentAlerts: false });
    assert.equal(getNotificationSettingsSyncFallback().assignmentAlerts, false);
    const off = createAssignmentNotificationsDemo({ ...base, assignmentHistoryId: 'demo-hist-off' });
    assert.equal(off.created, 0);

    await setNotificationSettings({ assignmentAlerts: true });
    const on = createAssignmentNotificationsDemo({ ...base, assignmentHistoryId: 'demo-hist-on' });
    assert.ok(on.created >= 1, `expected at least the assignee notification, got ${on.created}`);
  });
});
