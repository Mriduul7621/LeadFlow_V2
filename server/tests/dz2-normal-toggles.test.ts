import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
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
let createAssignmentNotifications: any;
let createAssignmentNotificationsDemo: any;
let notifyMeetingInvites: any;
let notifyMeetingRsvp: any;
let runMeetingReminders: any;
let getOperationsSettings: any;
let setOperationsSettings: any;

async function loadServices() {
  if (getNotificationSettings) return;
  ({ fallbackStore } = await import('../fallbackStore.js'));
  ({ getNotificationSettings, getNotificationSettingsSyncFallback, setNotificationSettings } =
    await import('../services/NotificationSettingsService.js'));
  ({ createAssignmentNotifications, createAssignmentNotificationsDemo } =
    await import('../services/NotificationService.js'));
  ({ notifyMeetingInvites, notifyMeetingRsvp, runMeetingReminders } =
    await import('../services/MeetingNotificationService.js'));
  ({ getOperationsSettings, setOperationsSettings } =
    await import('../services/OperationsSettingsService.js'));
}

/**
 * DZ-2 — Notification & operations toggles in normal Settings.
 * ------------------------------------------------------------------
 * 1. L1 split: the DZ-1 combined `assignmentAlerts` toggle is now
 *    two real toggles (assigneeAlerts, uplineAlerts). Each half gates
 *    only its own recipients; a legacy combined row is honoured as
 *    the fallback for a half with no row of its own.
 * 2. L2: the meetingNotifications toggle gates every meeting fan-out
 *    (invites, RSVP, reminder runner).
 * 3. G1/G2/M1: the bulk-import row caps and the image upload cap are
 *    real bounded Settings values (code ceilings = the old hardcoded
 *    values); the enforcing code reads them at request time.
 * 4. Writes need settings.manage and are audit-logged old→new (Q7).
 */

// Test-only fixture secret (assembled in parts, like the other suites).
const JWT_SECRET = ['dz2', 'test', 'secret', 'key'].join('-');

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
      failed_login_attempts INT DEFAULT 0,
      locked_until TIMESTAMP,
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
  // Minimal production-shaped tables for the meeting-reminder scan.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_name VARCHAR(255),
      current_status VARCHAR(100) DEFAULT 'New',
      is_deleted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID,
      activity_type VARCHAR(30) NOT NULL DEFAULT 'meeting',
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL,
      reminder_minutes INTEGER,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      created_by UUID,
      assigned_to UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_activity_attendees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      activity_id UUID NOT NULL,
      user_id UUID NOT NULL,
      response VARCHAR(30) DEFAULT 'pending',
      responded_at TIMESTAMP
    );
  `);
}

describe('DZ-2 Normal Toggles — DB mode', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let privileged: any;
  let plain: any;
  let assignee: any;
  let manager: any;

  before(async () => {
    process.env.DATABASE_URL = ['postgres:/', 'test:test', '@localhost:5432', '/test'].join('');
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

  async function notificationCount(): Promise<number> {
    const r: any = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications`);
    return r.rows[0].n;
  }

  async function clearNotificationSettingsRows(): Promise<void> {
    await pool.query(`DELETE FROM options WHERE field_key = 'Notifications'`);
  }

  it('defaults: all five notification toggles ON, operations limits at their ceilings', async () => {
    // The server-side ceiling constant and the service ceiling are
    // one value (operationsLimits.ts) — pin them equal so they cannot
    // drift apart unnoticed.
    const { USER_BULK_MAX_ROWS } = await import('../routes/userBulkImport.js');
    const { USER_BULK_IMPORT_MAX_ROWS_CEILING } = await import('../services/operationsLimits.js');
    assert.equal(USER_BULK_MAX_ROWS, USER_BULK_IMPORT_MAX_ROWS_CEILING);
    await clearNotificationSettingsRows();
    const settings = await getNotificationSettings();
    assert.deepEqual(settings, {
      assigneeAlerts: true,
      uplineAlerts: true,
      assignmentAlerts: true,
      dailyPushSummary: true,
      meetingNotifications: true,
    });
    const res = await request(app).get('/api/notifications/settings').set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, settings);

    const ops = await getOperationsSettings();
    assert.deepEqual(ops, { leadBulkImportMaxRows: 5000, userBulkImportMaxRows: 1000, imageUploadMaxMb: 1.5 });
    const opsRes = await request(app).get('/api/settings/operations').set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(opsRes.status, 200);
    assert.deepEqual(opsRes.body.data, ops);
  });

  it('PUT /notifications/settings: split toggles persist, change is audit-logged old→new, plain user refused', async () => {
    const denied = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send({ assigneeAlerts: false });
    assert.equal(denied.status, 403);

    const saved = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ assigneeAlerts: false, meetingNotifications: false });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.assigneeAlerts, false);
    assert.equal(saved.body.data.uplineAlerts, true);
    assert.equal(saved.body.data.assignmentAlerts, false);
    assert.equal(saved.body.data.meetingNotifications, false);

    const audit: any = await pool.query(`SELECT metadata FROM audit_logs WHERE action_code = 'notification_settings.save' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].metadata.changes.assigneeAlerts, { oldValue: true, newValue: false });
    assert.deepEqual(audit.rows[0].metadata.changes.meetingNotifications, { oldValue: true, newValue: false });

    // Restore for the following tests.
    await setNotificationSettings({ assigneeAlerts: true, meetingNotifications: true });
  });

  it('PUT /notifications/settings: legacy assignmentAlerts alias sets both halves', async () => {
    const saved = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ assignmentAlerts: false });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.assigneeAlerts, false);
    assert.equal(saved.body.data.uplineAlerts, false);
    assert.equal(saved.body.data.assignmentAlerts, false);

    const restored = await request(app).put('/api/notifications/settings')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ assignmentAlerts: true });
    assert.equal(restored.body.data.assigneeAlerts, true);
    assert.equal(restored.body.data.uplineAlerts, true);
  });

  it('legacy fallback: a lone DZ-1 assignmentAlerts=false row keeps both halves OFF until a split key is written', async () => {
    await clearNotificationSettingsRows();
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
       VALUES ('Notifications', 'assignmentAlerts', 'In-App Assignment Alerts', 1, FALSE, TRUE, $1::jsonb)`,
      [JSON.stringify({ enabled: false })]
    );
    let settings = await getNotificationSettings();
    assert.equal(settings.assigneeAlerts, false);
    assert.equal(settings.uplineAlerts, false);
    assert.equal(settings.assignmentAlerts, false);

    await setNotificationSettings({ assigneeAlerts: true });
    settings = await getNotificationSettings();
    assert.equal(settings.assigneeAlerts, true);
    assert.equal(settings.uplineAlerts, false);
    assert.equal(settings.assignmentAlerts, false);
    // The legacy row is kept in sync (derived assignee && upline).
    const legacy: any = await pool.query(`SELECT meta FROM options WHERE field_key = 'Notifications' AND option_value = 'assignmentAlerts'`);
    assert.equal(legacy.rows[0].meta.enabled, false);

    await setNotificationSettings({ uplineAlerts: true });
    settings = await getNotificationSettings();
    assert.equal(settings.assignmentAlerts, true);
  });

  it('L1 split behaviour: each half gates only its own recipients', async () => {
    const base = {
      leadId: '00000000-0000-4000-8000-0000000000bb',
      leadCode: 'LD-2',
      prospectName: 'Prospect Two',
      assignedToUserId: assignee.id,
      assignedToEmployeeId: 'ASN1',
      changedByEmployeeId: 'ADMIN1',
      eventType: 'lead-assigned',
    };
    await setNotificationSettings({ assigneeAlerts: false, uplineAlerts: true });
    const uplineOnly = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'dz2-hist-upline' });
    assert.equal(uplineOnly.created, 1);
    let rows: any = await pool.query(`SELECT recipient_key FROM notifications WHERE idempotency_key LIKE '%dz2-hist-upline%'`);
    assert.deepEqual(rows.rows.map((r: any) => r.recipient_key), ['MGR1']);

    await setNotificationSettings({ assigneeAlerts: true, uplineAlerts: false });
    const assigneeOnly = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'dz2-hist-assignee' });
    assert.equal(assigneeOnly.created, 1);
    rows = await pool.query(`SELECT recipient_key FROM notifications WHERE idempotency_key LIKE '%dz2-hist-assignee%'`);
    assert.deepEqual(rows.rows.map((r: any) => r.recipient_key), ['ASN1']);

    await setNotificationSettings({ assigneeAlerts: false, uplineAlerts: false });
    const none = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'dz2-hist-none' });
    assert.equal(none.created, 0);

    await setNotificationSettings({ assigneeAlerts: true, uplineAlerts: true });
    const both = await createAssignmentNotifications(pool, { ...base, assignmentHistoryId: 'dz2-hist-both' });
    assert.ok(both.created >= 2, `expected assignee + upline, got ${both.created}`);
  });

  it('L2 meeting toggle: invites and RSVP create nothing when OFF, work when ON', async () => {
    const activity = {
      id: 'dz2-invite-activity',
      title: 'DZ2 Review Call',
      scheduledAt: '2027-03-10T10:00:00.000Z',
      createdBy: adminUser.id,
    };
    const before = await notificationCount();
    await setNotificationSettings({ meetingNotifications: false });
    const offInvites = await notifyMeetingInvites({
      activity,
      organiserId: adminUser.id,
      attendees: [{ userId: assignee.id, employeeId: 'ASN1' }],
    });
    assert.equal(offInvites.created, 0);
    assert.equal(await notificationCount(), before);

    await setNotificationSettings({ meetingNotifications: true });
    const onInvites = await notifyMeetingInvites({
      activity,
      organiserId: adminUser.id,
      attendees: [{ userId: assignee.id, employeeId: 'ASN1' }],
    });
    assert.equal(onInvites.created, 1);
    assert.equal(await notificationCount(), before + 1);

    await setNotificationSettings({ meetingNotifications: false });
    const offRsvp = await notifyMeetingRsvp({
      activity,
      responder: { userId: assignee.id, name: 'Assignee One' },
      response: 'accepted',
    });
    assert.equal(offRsvp.created, 0);
    assert.equal(await notificationCount(), before + 1);

    await setNotificationSettings({ meetingNotifications: true });
    const onRsvp = await notifyMeetingRsvp({
      activity,
      responder: { userId: assignee.id, name: 'Assignee One' },
      response: 'accepted',
    });
    assert.equal(onRsvp.created, 1);
    assert.equal(await notificationCount(), before + 2);
  });

  it('L2 reminder runner: OFF returns an empty run even with a due activity; ON notifies', async () => {
    const leadRes: any = await pool.query(`INSERT INTO leads (customer_name) VALUES ('Reminder Lead') RETURNING id`);
    const leadId = leadRes.rows[0].id;
    const now = new Date();
    const start = new Date(now.getTime() + 15 * 60 * 1000);
    const actRes: any = await pool.query(
      `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, reminder_minutes, status, created_by, assigned_to)
       VALUES ($1, 'meeting', 'DZ2 Reminder', $2, 30, 'scheduled', $3, $4) RETURNING id`,
      [leadId, start.toISOString(), adminUser.id, assignee.id]
    );
    const activityId = actRes.rows[0].id;
    await pool.query(
      `INSERT INTO scheduled_activity_attendees (activity_id, user_id, response) VALUES ($1, $2, 'accepted')`,
      [activityId, assignee.id]
    );

    await setNotificationSettings({ meetingNotifications: false });
    const offRun = await runMeetingReminders(now);
    assert.equal(offRun.scanned, 0);
    assert.equal(offRun.notified, 0);

    await setNotificationSettings({ meetingNotifications: true });
    const onRun = await runMeetingReminders(now);
    assert.equal(onRun.scanned, 1);
    assert.equal(onRun.notified, 2);
    assert.equal(onRun.recipients, 2);

    // Idempotency: a second ON run in the same window notifies nobody new.
    const again = await runMeetingReminders(now);
    assert.equal(again.notified, 0);
  });

  it('PUT /settings/operations: valid values persist, change is audit-logged old→new, plain user refused', async () => {
    const denied = await request(app).put('/api/settings/operations')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send({ leadBulkImportMaxRows: 100 });
    assert.equal(denied.status, 403);

    const saved = await request(app).put('/api/settings/operations')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ leadBulkImportMaxRows: 250, imageUploadMaxMb: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.leadBulkImportMaxRows, 250);
    assert.equal(saved.body.data.userBulkImportMaxRows, 1000);
    assert.equal(saved.body.data.imageUploadMaxMb, 1);

    const audit: any = await pool.query(`SELECT metadata FROM audit_logs WHERE action_code = 'operations_settings.save' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].metadata.changes.leadBulkImportMaxRows, { oldValue: 5000, newValue: 250 });
    assert.deepEqual(audit.rows[0].metadata.changes.imageUploadMaxMb, { oldValue: 1.5, newValue: 1 });

    // Restore defaults for the following tests.
    const restored = await request(app).put('/api/settings/operations')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ leadBulkImportMaxRows: 5000, userBulkImportMaxRows: 1000, imageUploadMaxMb: 1.5 });
    assert.equal(restored.status, 200);
  });

  it('PUT /settings/operations: out-of-range and non-numeric values are refused', async () => {
    for (const bad of [
      { leadBulkImportMaxRows: 5001 },
      { leadBulkImportMaxRows: 99 },
      { leadBulkImportMaxRows: 10.5 },
      { userBulkImportMaxRows: 1001 },
      { userBulkImportMaxRows: 9 },
      { imageUploadMaxMb: 1.6 },
      { imageUploadMaxMb: 0.4 },
      { imageUploadMaxMb: 'big' },
      {},
    ]) {
      const res = await request(app).put('/api/settings/operations')
        .set('Authorization', `Bearer ${tokenFor(privileged)}`)
        .send(bad);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${res.status}`);
    }
    // Nothing above changed the stored values.
    assert.deepEqual(await getOperationsSettings(), { leadBulkImportMaxRows: 5000, userBulkImportMaxRows: 1000, imageUploadMaxMb: 1.5 });
  });

  it('operations reads fail back to defaults on malformed rows and clamp over-ceiling rows', async () => {
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
       VALUES ('Operations', 'leadBulkImportMaxRows', 'Lead Bulk Import Max Rows', 1, FALSE, TRUE, $1::jsonb)
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`,
      [JSON.stringify({ rows: 'not-a-number' })]
    );
    assert.equal((await getOperationsSettings()).leadBulkImportMaxRows, 5000);

    await pool.query(
      `UPDATE options SET meta = $1::jsonb WHERE field_key = 'Operations' AND option_value = 'leadBulkImportMaxRows'`,
      [JSON.stringify({ rows: 99999 })]
    );
    assert.equal((await getOperationsSettings()).leadBulkImportMaxRows, 5000);

    await pool.query(`DELETE FROM options WHERE field_key = 'Operations' AND option_value = 'leadBulkImportMaxRows'`);
    assert.equal((await getOperationsSettings()).leadBulkImportMaxRows, 5000);
  });

  it('G1 lead bulk cap: a lowered limit is enforced at request time', async () => {
    await setOperationsSettings({ leadBulkImportMaxRows: 100 });
    const rows101 = Array.from({ length: 101 }, (_, i) => ({ customerName: `Bulk ${i}`, mobile: '01700000001' }));
    const over = await request(app).post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ leads: rows101, dryRun: true });
    assert.equal(over.status, 413);
    assert.match(over.body.message, /100 rows/);

    // Exactly at the limit the cap does not trip (the request then
    // reaches the permission check, which this caller fails).
    const rows100 = Array.from({ length: 100 }, (_, i) => ({ customerName: `Bulk ${i}`, mobile: '01700000001' }));
    const atLimit = await request(app).post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ leads: rows100, dryRun: true });
    assert.notEqual(atLimit.status, 413);

    await setOperationsSettings({ leadBulkImportMaxRows: 5000 });
  });

  it('G2 user bulk cap: a lowered limit is enforced on validate', async () => {
    await setOperationsSettings({ userBulkImportMaxRows: 10 });
    const rows11 = Array.from({ length: 11 }, (_, i) => ({ rowNumber: i + 1, employeeId: `CAP${i}`, fullName: `Cap ${i}` }));
    const over = await request(app).post('/api/users/bulk/validate')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ rows: rows11, mode: 'createOnly' });
    assert.equal(over.status, 400);
    assert.match(over.body.message, /exceeds maximum 10/);

    const rows10 = Array.from({ length: 10 }, (_, i) => ({ rowNumber: i + 1, employeeId: `CAP${i}`, fullName: `Cap ${i}` }));
    const atLimit = await request(app).post('/api/users/bulk/validate')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ rows: rows10, mode: 'createOnly' });
    assert.notEqual(atLimit.status, 400);
    assert.notEqual(atLimit.body.message, undefined);

    await setOperationsSettings({ userBulkImportMaxRows: 1000 });
  });

  it('client wiring: Push Intelligence shows the split toggles + meeting toggle; Operations section and effective caps are wired', () => {
    const settingsSrc = fs.readFileSync(new URL('../../src/modules/settings/pages/Settings.tsx', import.meta.url), 'utf8');
    for (const key of ['assigneeAlerts', 'uplineAlerts', 'meetingNotifications', 'dailyPushSummary']) {
      assert.ok(settingsSrc.includes(`key: '${key}'`), `Settings.tsx should render a '${key}' toggle row`);
    }
    assert.ok(!settingsSrc.includes(`key: 'assignmentAlerts'`), 'the old combined assignmentAlerts row must be gone from the UI');
    assert.ok(settingsSrc.includes('Operations & Limits'), 'Settings.tsx should have the Operations & Limits section');
    assert.ok(settingsSrc.includes('operationsSettingsService'), 'Settings.tsx should load the operations settings');
    assert.ok(settingsSrc.includes('opsSettings.imageUploadMaxMb'), 'the image upload cap must use the effective Settings value');
    assert.ok(settingsSrc.includes(`key: 'leadBulkImportMaxRows'`), 'Operations section should edit the lead bulk cap');
    assert.ok(settingsSrc.includes(`key: 'userBulkImportMaxRows'`), 'Operations section should edit the user bulk cap');

    const modalSrc = fs.readFileSync(new URL('../../src/modules/users/components/UserBulkImportModal.tsx', import.meta.url), 'utf8');
    assert.ok(modalSrc.includes('operationsSettingsService'), 'the user bulk-import modal should read the effective cap');
    assert.ok(modalSrc.includes('userCap'), 'the user bulk-import modal should enforce the effective cap');
  });
});

describe('DZ-2 Normal Toggles — demo (fallback) mode', () => {
  before(async () => {
    await loadServices();
    delete process.env.DATABASE_URL;
    (fallbackStore as any).options = ((fallbackStore as any).options || []).filter(
      (o: any) => o.type !== 'Notifications' && o.type !== 'Operations'
    );
    (fallbackStore as any).notifications = [];
  });

  it('fallback split: each half gates only its own demo recipients', async () => {
    assert.deepEqual(getNotificationSettingsSyncFallback(), {
      assigneeAlerts: true,
      uplineAlerts: true,
      assignmentAlerts: true,
      dailyPushSummary: true,
      meetingNotifications: true,
    });

    const users = (fallbackStore as any).users as any[];
    const manager = { id: 'demo-user-mgr', employeeId: 'DEMOMGR', fullName: 'Demo Manager' };
    const assignee = { id: 'demo-user-asn', employeeId: 'DEMOASN', fullName: 'Demo Assignee', managerId: 'DEMOMGR' };
    if (!users.find((u: any) => u.employeeId === 'DEMOMGR')) users.push(manager);
    if (!users.find((u: any) => u.employeeId === 'DEMOASN')) users.push(assignee);

    const base = {
      leadId: 'demo-lead-2',
      leadCode: 'LD-D2',
      prospectName: 'Demo Prospect',
      assignedToUserId: 'demo-user-asn',
      assignedToEmployeeId: 'DEMOASN',
      changedByEmployeeId: 'DEMOADMIN',
      eventType: 'lead-assigned',
    };

    await setNotificationSettings({ assigneeAlerts: false, uplineAlerts: true });
    const uplineOnly = createAssignmentNotificationsDemo({ ...base, assignmentHistoryId: 'dz2-demo-upline' });
    assert.equal(uplineOnly.created, 1);
    assert.ok((fallbackStore as any).notifications.some((n: any) => n.userId === 'demo-user-mgr'));

    await setNotificationSettings({ assigneeAlerts: true, uplineAlerts: false });
    const assigneeOnly = createAssignmentNotificationsDemo({ ...base, assignmentHistoryId: 'dz2-demo-assignee' });
    assert.equal(assigneeOnly.created, 1);
    assert.ok((fallbackStore as any).notifications.some((n: any) => n.userId === 'demo-user-asn'));

    await setNotificationSettings({ assigneeAlerts: true, uplineAlerts: true });
    const both = createAssignmentNotificationsDemo({ ...base, assignmentHistoryId: 'dz2-demo-both' });
    assert.ok(both.created >= 2, `expected assignee + upline, got ${both.created}`);
  });

  it('fallback operations settings: defaults, persist, and range refusal', async () => {
    assert.deepEqual(await getOperationsSettings(), { leadBulkImportMaxRows: 5000, userBulkImportMaxRows: 1000, imageUploadMaxMb: 1.5 });
    const saved = await setOperationsSettings({ leadBulkImportMaxRows: 200 });
    assert.equal(saved.leadBulkImportMaxRows, 200);
    await assert.rejects(setOperationsSettings({ leadBulkImportMaxRows: 6000 }), /between 100 and 5000/);
    assert.equal((await getOperationsSettings()).leadBulkImportMaxRows, 200);
  });
});
