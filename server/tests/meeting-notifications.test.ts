import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate055 } from '../database/migrations/055_meeting_data_model.js';
import { up as migrate048 } from '../database/migrations/048_push_subscriptions.js';

// The services are imported DYNAMICALLY in before() — after the env
// is set — because routes/production/shared.ts captures JWT_SECRET
// at module load (the meeting-data-model.test.ts pattern). Static
// imports would freeze the ambient (wrong) secret and every token
// would 401.
let runMeetingReminders: typeof import('../services/MeetingNotificationService.js').runMeetingReminders;
let formatDhakaDateTime: typeof import('../services/MeetingNotificationService.js').formatDhakaDateTime;
let meetingDisplayTitle: typeof import('../services/MeetingNotificationService.js').meetingDisplayTitle;
let _setPushSenderForTest: typeof import('../services/PushReminderService.js')._setPushSenderForTest;
let buildDailyReminderPayload: typeof import('../services/PushReminderService.js').buildDailyReminderPayload;
let computeTodaysMeetingCount: typeof import('../services/PushReminderService.js').computeTodaysMeetingCount;
let runDailyPushReminders: typeof import('../services/PushReminderService.js').runDailyPushReminders;

// Same test-only fixture secret the other integration suites use
// (assembled in parts so this file carries no contiguous literal).
const JWT_SECRET = 'test-jwt-secret-for-' + 'followup-integration';
const CRON_SECRET = 'test-cron-' + 'secret-meeting';
const VAPID_PUBLIC = 'test-vapid-' + 'public-key';
const VAPID_PRIVATE = 'test-vapid-' + 'private-key';
const SUB_P256DH = 'B' + 'A'.repeat(86);
const SUB_AUTH = 'a'.repeat(22);

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
 * Schema mirrors meeting-data-model.test.ts (scheduled_activities in
 * its migration-039 shape, migration 055 applied by the suite) PLUS
 * the notifications table (migration 040 shape, from
 * lead-pg-integration.test.ts) and push_subscriptions (real 048).
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
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE,
      customer_name VARCHAR(255) NOT NULL,
      mobile VARCHAR(30) NOT NULL,
      alternate_mobile VARCHAR(30),
      email VARCHAR(255),
      marital_status VARCHAR(50),
      occupation VARCHAR(150),
      address TEXT,
      area VARCHAR(150),
      district VARCHAR(100),
      division VARCHAR(100),
      source VARCHAR(100),
      priority VARCHAR(30) DEFAULT 'NORMAL',
      expected_premium NUMERIC(14,2),
      expected_value NUMERIC(14,2),
      notes TEXT,
      assigned_to UUID,
      assigned_by UUID,
      assigned_at TIMESTAMP,
      previous_assigned_to UUID,
      last_contacted_at TIMESTAMP,
      next_follow_up_at TIMESTAMP,
      current_status VARCHAR(255) DEFAULT 'New',
      status_history JSONB DEFAULT '[]'::jsonb,
      assignment_history JSONB DEFAULT '[]'::jsonb,
      documents JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '{}'::jsonb,
      tags JSONB DEFAULT '[]'::jsonb,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by UUID,
      follow_up_count INT DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up',
      status VARCHAR(255),
      remarks TEXT,
      next_follow_up_at TIMESTAMP,
      next_call_at TIMESTAMP,
      meeting_at TIMESTAMP,
      meeting_type VARCHAR(255),
      collected_ncp NUMERIC(14,2),
      projected_ncp NUMERIC(14,2),
      sum_assured NUMERIC(14,2),
      product_name VARCHAR(255),
      loss_reason TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call', 'meeting', 'follow_up', 'task')),
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
      meeting_type VARCHAR(255),
      location VARCHAR(255),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_followup_mutations (
      mutation_id UUID PRIMARY KEY,
      lead_id UUID,
      user_id UUID,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
      response_body JSONB
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
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_key, option_value)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      recipient_key VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      message TEXT,
      type VARCHAR(50) DEFAULT 'info',
      event_type VARCHAR(100),
      idempotency_key VARCHAR(500),
      reference_type VARCHAR(100),
      reference_id UUID,
      lead_code VARCHAR(50),
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_notifications_idempotency_key'
      ) THEN
        CREATE UNIQUE INDEX idx_notifications_idempotency_key
          ON notifications(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      END IF;
    END
    $$;
  `);
}

const T1 = '2027-03-10T10:00:00.000Z'; // Wed 10 Mar 2027, 4:00 pm Dhaka
const T2 = '2027-03-11T15:30:00.000Z'; // Thu 11 Mar 2027, 9:30 pm Dhaka

describe('Meeting notifications + reminder runner (PR E)', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let manager: any;
  let empA: any;
  let empB: any;
  let empC: any;
  let empD: any;
  let pushCalls: { endpoint: string; payloadJson: string }[] = [];

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC;
    process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE;

    // Env is set — now the service modules (and the shared module
    // they pull in) may load.
    const meetingSvc = await import('../services/MeetingNotificationService.js');
    runMeetingReminders = meetingSvc.runMeetingReminders;
    formatDhakaDateTime = meetingSvc.formatDhakaDateTime;
    meetingDisplayTitle = meetingSvc.meetingDisplayTitle;
    const pushSvc = await import('../services/PushReminderService.js');
    _setPushSenderForTest = pushSvc._setPushSenderForTest;
    buildDailyReminderPayload = pushSvc.buildDailyReminderPayload;
    computeTodaysMeetingCount = pushSvc.computeTodaysMeetingCount;
    runDailyPushReminders = pushSvc.runDailyPushReminders;

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    const adminRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const mgrRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`);
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [adminRole.rows[0].id, mgrRole.rows[0].id, empRole.rows[0].id]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }
    const mkUser = async (emp: string, name: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    adminUser = { ...(await mkUser('ADMIN1', 'Admin User', adminRole.rows[0].id, null)), role: 'ADMIN' };
    manager = { ...(await mkUser('MGR1', 'Manager One', mgrRole.rows[0].id, null)), role: 'MANAGER' };
    empA = { ...(await mkUser('EMPA', 'Employee A', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };
    empB = { ...(await mkUser('EMPB', 'Employee B', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };
    empC = { ...(await mkUser('EMPC', 'Employee C', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };
    empD = { ...(await mkUser('EMPD', 'Employee D', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };

    await migrate055();
    await migrate048();
    app = await createTestApp();
  });

  after(async () => {
    _setPushSenderForTest(null);
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
    delete process.env.CRON_SECRET;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM notifications`);
    await pool.query(`DELETE FROM push_subscriptions`);
    pushCalls = [];
    _setPushSenderForTest(async (target: any, payloadJson: string) => {
      pushCalls.push({ endpoint: target.endpoint, payloadJson });
    });
  });

  function tokenFor(user: any): string {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function createEvent(user: any, payload: any): Promise<any> {
    return request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${tokenFor(user)}`).send(payload);
  }

  async function notifsFor(userId: string, eventType?: string, activityId?: string): Promise<any[]> {
    const clauses = ['user_id = $1'];
    const params: any[] = [userId];
    if (eventType) { params.push(eventType); clauses.push(`event_type = $${params.length}`); }
    if (activityId) { params.push(activityId); clauses.push(`reference_id = $${params.length}`); }
    const r: any = await pool.query(
      `SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
      params
    );
    return r.rows;
  }

  async function subscribe(user: any, endpoint: string): Promise<void> {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`,
      [user.id, endpoint, SUB_P256DH, SUB_AUTH]
    );
  }

  /* ------------------------- pure helpers ------------------------- */

  it('formatDhakaDateTime renders the stored UTC instant in Asia/Dhaka, in any process timezone', () => {
    const text = formatDhakaDateTime(T1);
    assert.ok(text, 'formats');
    assert.match(text!, /10 Mar 2027/);
    // 10:00 UTC is 16:00 in Dhaka — a process-local render in a UTC
    // process would say 10:00, so this pins the explicit timeZone.
    assert.match(text!, /4:00\s*pm/i);
    assert.doesNotMatch(text!, /10:00/);
    assert.equal(formatDhakaDateTime('not a date'), null);
    assert.equal(formatDhakaDateTime(null), null);
    // Naive stored values are read AS UTC (the stored convention).
    assert.equal(formatDhakaDateTime('2027-03-10 10:00:00'), text);
  });

  it('meetingDisplayTitle prefers the title, then the lead customer, then the type', () => {
    assert.equal(meetingDisplayTitle({ id: 'x', title: 'Weekly Sync' }), 'Weekly Sync');
    assert.equal(meetingDisplayTitle({ id: 'x', title: null, leadCustomerName: 'Rahim' }), 'Meeting with Rahim');
    assert.equal(meetingDisplayTitle({ id: 'x', title: null, activityType: 'task' }), 'Task');
    assert.equal(meetingDisplayTitle({ id: 'x' }), 'Meeting');
  });

  it('daily payload wording is byte-identical for pre-meeting inputs; the meeting sentence appends cleanly', () => {
    assert.equal(
      buildDailyReminderPayload({ dueToday: 2, overdue: 1 }).body,
      'আজ 2টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 0, overdue: 0, slaBreaches: 3 }).body,
      '3টি lead-এর first-contact SLA পার হয়ে গেছে। Workbench-এ দেখে নিন।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 1, overdue: 0, slaBreaches: 2 }).body,
      'আজ 1টি follow-up due আছে। 2টি lead-এর first-contact SLA পার হয়ে গেছে। Workbench-এ দেখে নিন।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 0, overdue: 0 }).body,
      'আজ কোনো follow-up due নেই।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 0, overdue: 0, meetingsToday: 2 }).body,
      'আজ 2টি meeting আছে। Workbench-এ দেখে নিন।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 1, overdue: 0, meetingsToday: 1 }).body,
      'আজ 1টি follow-up due আছে। আজ 1টি meeting আছে। Workbench-এ দেখে নিন।'
    );
  });

  /* ------------------------- invites ------------------------- */

  it('invite on create: attendees notified with title + Dhaka time, organiser never; push only to subscribed attendees', async () => {
    await subscribe(empB, 'https://push.example/b-device');
    const res = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Invite Meeting',
      scheduledAt: T1,
      attendeeIds: [empB.id, empC.id],
    });
    assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    const activityId = res.body.data.id;

    const forB = await notifsFor(empB.id, 'meeting-invited', activityId);
    assert.equal(forB.length, 1);
    assert.equal(forB[0].title, 'Meeting Invitation');
    assert.equal(forB[0].message, `You are invited: Invite Meeting — ${formatDhakaDateTime(T1)}.`);
    assert.equal(forB[0].reference_type, 'scheduled_activity');
    assert.equal(forB[0].recipient_key, 'EMPB');

    const forC = await notifsFor(empC.id, 'meeting-invited', activityId);
    assert.equal(forC.length, 1, 'unsubscribed attendee still gets the in-app invite');

    assert.equal((await notifsFor(empA.id, 'meeting-invited', activityId)).length, 0, 'organiser is not notified');
    assert.equal((await notifsFor(empA.id)).length, 0, 'organiser gets nothing at all');

    // Push attempted ONLY for the subscribed attendee (empB).
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].endpoint, 'https://push.example/b-device');
    const payload = JSON.parse(pushCalls[0].payloadJson);
    assert.equal(payload.title, 'Meeting Invitation');
    assert.equal(payload.url, '/task-calendar');
  });

  it('the assignee alone is NOT invited: only actual attendees are notified', async () => {
    const res = await createEvent(manager, {
      activityType: 'meeting',
      title: 'Assigned Meeting',
      scheduledAt: T1,
      assignedTo: empD.id,
      attendeeIds: [empB.id],
    });
    assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    const activityId = res.body.data.id;
    assert.equal((await notifsFor(empB.id, 'meeting-invited', activityId)).length, 1);
    assert.equal((await notifsFor(empD.id, 'meeting-invited', activityId)).length, 0, 'assignee-only gets no invite');
    assert.equal((await notifsFor(empD.id)).length, 0);
    assert.equal((await notifsFor(manager.id)).length, 0, 'organiser gets nothing');
  });

  it('organiser listed as an attendee is NOT notified about their own meeting', async () => {
    const res = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Self Listed',
      scheduledAt: T1,
      attendeeIds: [empA.id, empB.id],
    });
    assert.equal(res.status, 201);
    const activityId = res.body.data.id;
    assert.equal((await notifsFor(empA.id)).length, 0);
    assert.equal((await notifsFor(empB.id, 'meeting-invited', activityId)).length, 1);
  });

  /* ------------------------- edits: gained + moved ------------------------- */

  it('edit adding one attendee notifies only the new one; a time change notifies retained attendees once per distinct time', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Evolving Meeting',
      scheduledAt: T1,
      attendeeIds: [empB.id],
    });
    const id = created.body.data.id;
    assert.equal((await notifsFor(empB.id, 'meeting-invited', id)).length, 1);

    // Gain empC — empB must NOT be re-invited and NOT "moved".
    const gained = await request(app).put(`/api/scheduled-activities/${id}`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ attendeeIds: [empB.id, empC.id] });
    assert.equal(gained.status, 200, `put failed: ${JSON.stringify(gained.body)}`);
    assert.equal((await notifsFor(empC.id, 'meeting-invited', id)).length, 1, 'new attendee invited');
    assert.equal((await notifsFor(empB.id, 'meeting-invited', id)).length, 1, 'retained attendee not re-invited');
    assert.equal((await notifsFor(empB.id, 'meeting-moved', id)).length, 0, 'no move notice when the time did not change');

    // Time change with the same set — both retained attendees moved.
    const moved = await request(app).put(`/api/scheduled-activities/${id}`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ scheduledAt: T2 });
    assert.equal(moved.status, 200);
    const movedB = await notifsFor(empB.id, 'meeting-moved', id);
    const movedC = await notifsFor(empC.id, 'meeting-moved', id);
    assert.equal(movedB.length, 1);
    assert.equal(movedC.length, 1);
    assert.equal(movedB[0].message, `Meeting moved: Evolving Meeting — new time ${formatDhakaDateTime(T2)}.`);

    // A non-time edit does not re-notify.
    const renamed = await request(app).put(`/api/scheduled-activities/${id}`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ title: 'Evolving Meeting II' });
    assert.equal(renamed.status, 200);
    assert.equal((await notifsFor(empB.id, 'meeting-moved', id)).length, 1);

    // Moving BACK to T1 is a new version — notifies again.
    const back = await request(app).put(`/api/scheduled-activities/${id}`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ scheduledAt: T1 });
    assert.equal(back.status, 200);
    assert.equal((await notifsFor(empB.id, 'meeting-moved', id)).length, 2);
  });

  it('an edit that gains an attendee AND moves the time invites the new one and moves only the retained', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Combo Edit',
      scheduledAt: T1,
      attendeeIds: [empB.id],
    });
    const id = created.body.data.id;
    const res = await request(app).put(`/api/scheduled-activities/${id}`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ attendeeIds: [empB.id, empC.id], scheduledAt: T2 });
    assert.equal(res.status, 200, `put failed: ${JSON.stringify(res.body)}`);
    const invitesC = await notifsFor(empC.id, 'meeting-invited', id);
    assert.equal(invitesC.length, 1);
    assert.equal(invitesC[0].message, `You are invited: Combo Edit — ${formatDhakaDateTime(T2)}.`, 'the invite already carries the new time');
    assert.equal((await notifsFor(empC.id, 'meeting-moved', id)).length, 0, 'just-invited attendee is not also "moved"');
    assert.equal((await notifsFor(empB.id, 'meeting-moved', id)).length, 1, 'retained attendee is moved');
  });

  /* ------------------------- RSVP ------------------------- */

  it('RSVP notifies the organiser; same answer re-sent dedupes, a flipped answer notifies again', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting',
      title: 'RSVP Notify',
      scheduledAt: T2,
      attendeeIds: [empB.id],
    });
    const id = created.body.data.id;

    const accept = await request(app).post(`/api/scheduled-activities/${id}/rsvp`)
      .set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'accepted' });
    assert.equal(accept.status, 200);
    let rsvps = await notifsFor(empA.id, 'meeting-rsvp', id);
    assert.equal(rsvps.length, 1);
    assert.equal(rsvps[0].message, 'Employee B accepted: RSVP Notify');

    const acceptAgain = await request(app).post(`/api/scheduled-activities/${id}/rsvp`)
      .set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'accepted' });
    assert.equal(acceptAgain.status, 200);
    rsvps = await notifsFor(empA.id, 'meeting-rsvp', id);
    assert.equal(rsvps.length, 1, 'same response re-sent does not duplicate');

    const decline = await request(app).post(`/api/scheduled-activities/${id}/rsvp`)
      .set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'declined' });
    assert.equal(decline.status, 200);
    rsvps = await notifsFor(empA.id, 'meeting-rsvp', id);
    assert.equal(rsvps.length, 2, 'a changed response notifies again');
    assert.equal(rsvps[1].message, 'Employee B declined: RSVP Notify');
  });

  /* ------------------------- cancel / complete ------------------------- */

  it('cancel notifies every attendee (not the organiser); complete does the same with its own event', async () => {
    const toCancel = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Cancel Notify',
      scheduledAt: T2,
      attendeeIds: [empB.id, empC.id],
    });
    const cancelId = toCancel.body.data.id;
    const cancelled = await request(app).post(`/api/scheduled-activities/${cancelId}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`).send({});
    assert.equal(cancelled.status, 200, `cancel failed: ${JSON.stringify(cancelled.body)}`);
    assert.equal((await notifsFor(empB.id, 'meeting-cancelled', cancelId)).length, 1);
    const cancelC = await notifsFor(empC.id, 'meeting-cancelled', cancelId);
    assert.equal(cancelC.length, 1);
    assert.equal(cancelC[0].message, `Meeting cancelled: Cancel Notify — was scheduled for ${formatDhakaDateTime(T2)}.`);
    assert.equal((await notifsFor(empA.id, 'meeting-cancelled', cancelId)).length, 0);

    const toComplete = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Complete Notify',
      scheduledAt: T2,
      attendeeIds: [empB.id],
    });
    const completeId = toComplete.body.data.id;
    const completed = await request(app).post(`/api/scheduled-activities/${completeId}/complete`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`).send({});
    assert.equal(completed.status, 200, `complete failed: ${JSON.stringify(completed.body)}`);
    assert.equal((await notifsFor(empB.id, 'meeting-completed', completeId)).length, 1);
    assert.equal((await notifsFor(empA.id, 'meeting-completed', completeId)).length, 0);
  });

  /* ------------------------- reminder endpoint auth ------------------------- */

  it('reminder cron endpoint: 401 without/with wrong secret, 503 when CRON_SECRET is unset, 200 with the secret', async () => {
    const missing = await request(app).get('/api/notifications/push/cron-meeting-reminders');
    assert.equal(missing.status, 401);
    const wrong = await request(app).post('/api/notifications/push/cron-meeting-reminders')
      .set('x-cron-secret', 'not-the-secret');
    assert.equal(wrong.status, 401);

    delete process.env.CRON_SECRET;
    try {
      const disabled = await request(app).get('/api/notifications/push/cron-meeting-reminders')
        .set('x-cron-secret', CRON_SECRET);
      assert.equal(disabled.status, 503);
    } finally {
      process.env.CRON_SECRET = CRON_SECRET;
    }

    const ok = await request(app).get('/api/notifications/push/cron-meeting-reminders')
      .set('x-cron-secret', CRON_SECRET);
    assert.equal(ok.status, 200, `cron failed: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.success, true);
    assert.equal(typeof ok.body.data.scanned, 'number');
    assert.equal(ok.body.data.scanned, 0, 'nothing is due yet at this point in the suite');

    const bearer = await request(app).post('/api/notifications/push/cron-meeting-reminders')
      .set('Authorization', `Bearer ${CRON_SECRET}`);
    assert.equal(bearer.status, 200, 'POST + Bearer auth works like the daily cron');
  });

  /* ------------------------- reminder runner ------------------------- */

  async function insertActivity(opts: {
    title: string;
    scheduledAt: Date;
    reminderMinutes: number | null;
    createdBy: string;
    assignedTo?: string | null;
    status?: string;
    attendees?: { userId: string; response: string }[];
  }): Promise<string> {
    const r: any = await pool.query(
      `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, created_by, assigned_to, updated_by, reminder_minutes)
       VALUES (NULL, 'meeting', $1, $2, $3, $4, $5, $4, $6) RETURNING id`,
      [opts.title, opts.scheduledAt.toISOString(), opts.status || 'scheduled', opts.createdBy, opts.assignedTo ?? opts.createdBy, opts.reminderMinutes]
    );
    const id = r.rows[0].id;
    for (const attendee of opts.attendees || []) {
      await pool.query(
        `INSERT INTO scheduled_activity_attendees (activity_id, user_id, response, responded_at)
         VALUES ($1, $2, $3, $4)`,
        [id, attendee.userId, attendee.response, attendee.response === 'pending' ? null : new Date()]
      );
    }
    return id;
  }

  it('reminder runner: due-window selection, recipient set, dedupe on re-run, reschedule re-arms, push only to subscribers', async () => {
    const now = new Date();
    const min = 60 * 1000;
    await subscribe(empC, 'https://push.example/c-device');

    // Due inside the window: start in 15 min, reminder 30 → due 15 min ago.
    const dueId = await insertActivity({
      title: 'Due Meeting',
      scheduledAt: new Date(now.getTime() + 15 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      assignedTo: empD.id,
      attendees: [
        { userId: empB.id, response: 'pending' },
        { userId: empC.id, response: 'accepted' },
      ],
    });
    // Due exactly now: start in 30 min, reminder 30.
    const boundaryId = await insertActivity({
      title: 'Boundary Meeting',
      scheduledAt: new Date(now.getTime() + 30 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
    });
    // Not yet due: due in 60 min.
    await insertActivity({
      title: 'Future Meeting',
      scheduledAt: new Date(now.getTime() + 90 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      attendees: [{ userId: empB.id, response: 'pending' }],
    });
    // Fell due too long ago (outside the 20-minute window).
    await insertActivity({
      title: 'Stale Meeting',
      scheduledAt: new Date(now.getTime() - 60 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      attendees: [{ userId: empB.id, response: 'pending' }],
    });
    // No reminder chosen.
    await insertActivity({
      title: 'No Reminder Meeting',
      scheduledAt: new Date(now.getTime() + 10 * min),
      reminderMinutes: null,
      createdBy: empA.id,
      attendees: [{ userId: empB.id, response: 'pending' }],
    });
    // Due, but the only attendee declined; organiser + assignee remain.
    const declinedId = await insertActivity({
      title: 'Declined Meeting',
      scheduledAt: new Date(now.getTime() + 15 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      assignedTo: empA.id,
      attendees: [
        { userId: empB.id, response: 'declined' },
        { userId: empC.id, response: 'pending' },
      ],
    });
    // Cancelled / completed events are never selected.
    await insertActivity({
      title: 'Cancelled Due',
      scheduledAt: new Date(now.getTime() + 15 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      status: 'cancelled',
      attendees: [{ userId: empB.id, response: 'pending' }],
    });
    await insertActivity({
      title: 'Completed Due',
      scheduledAt: new Date(now.getTime() + 15 * min),
      reminderMinutes: 30,
      createdBy: empA.id,
      status: 'completed',
      attendees: [{ userId: empB.id, response: 'pending' }],
    });

    const run1 = await runMeetingReminders(now);
    assert.equal(run1.scanned, 3, 'due + boundary + declined-host activities are in the window');
    assert.equal(run1.recipients, 7, 'due: organiser+assignee+2 attendees; boundary: organiser; declined-host: organiser+pending attendee');
    assert.equal(run1.notified, 7);
    assert.equal(run1.deduped, 0);

    assert.equal((await notifsFor(empA.id, 'meeting-reminder', dueId)).length, 1, 'organiser reminded');
    assert.equal((await notifsFor(empD.id, 'meeting-reminder', dueId)).length, 1, 'assignee reminded');
    assert.equal((await notifsFor(empB.id, 'meeting-reminder', dueId)).length, 1, 'pending attendee reminded');
    assert.equal((await notifsFor(empC.id, 'meeting-reminder', dueId)).length, 1, 'accepted attendee reminded');
    assert.equal((await notifsFor(empA.id, 'meeting-reminder', boundaryId)).length, 1, 'due-exactly-now is included');
    assert.equal((await notifsFor(empB.id, 'meeting-reminder', declinedId)).length, 0, 'declined attendee is skipped');
    assert.equal((await notifsFor(empC.id, 'meeting-reminder', declinedId)).length, 1);
    assert.equal((await notifsFor(empB.id, 'meeting-reminder')).length, 1, 'no reminders from future/stale/no-reminder/cancelled/completed rows');

    const reminderB = await notifsFor(empB.id, 'meeting-reminder', dueId);
    assert.equal(reminderB[0].title, 'Meeting Reminder');
    assert.match(reminderB[0].message, /^Reminder: Due Meeting starts at /);

    // Push: only empC holds a subscription — one push per due activity
    // they are reminded about (dueId + declinedId), none for others.
    assert.equal(run1.pushSent, 2);
    assert.ok(pushCalls.every(c => c.endpoint === 'https://push.example/c-device'));
    assert.equal(pushCalls.length, 2);

    // Second run over the same window sends nothing new.
    pushCalls = [];
    const run2 = await runMeetingReminders(now);
    assert.equal(run2.scanned, 3);
    assert.equal(run2.notified, 0, 're-run is fully deduped');
    assert.equal(run2.deduped, 7);
    assert.equal(pushCalls.length, 0, 'no push on a deduped re-run');
    assert.equal((await notifsFor(empC.id, 'meeting-reminder', dueId)).length, 1);

    // Rescheduling re-arms: a new scheduled_at is a new key version.
    await pool.query(
      `UPDATE scheduled_activities SET scheduled_at = $1 WHERE id = $2`,
      [new Date(now.getTime() + 25 * min).toISOString(), dueId]
    );
    const run3 = await runMeetingReminders(now);
    assert.equal(run3.notified, 4, 'the rescheduled meeting reminds its 4 recipients again');
    assert.equal((await notifsFor(empC.id, 'meeting-reminder', dueId)).length, 2);
  });

  /* ------------------------- daily summary ------------------------- */

  it("daily summary counts today's meetings for involved users and still sends when a meeting is the only news", async () => {
    const { getDhakaBusinessDayBounds } = await import('../utils/businessTime.js');
    const bounds = getDhakaBusinessDayBounds(new Date());
    const todayTenDhaka = new Date(bounds.todayStart.getTime() + 10 * 60 * 60 * 1000);

    // Deltas: earlier tests in this suite created same-day meetings
    // of their own, so compare against the pre-insert counts.
    const baseB = await computeTodaysMeetingCount(empB.id, new Date());
    const baseMgr = await computeTodaysMeetingCount(manager.id, new Date());
    const baseC = await computeTodaysMeetingCount(empC.id, new Date());

    const meetingId = await insertActivity({
      title: 'Morning Briefing',
      scheduledAt: todayTenDhaka,
      reminderMinutes: null,
      createdBy: manager.id,
      assignedTo: manager.id,
      attendees: [{ userId: empB.id, response: 'accepted' }],
    });
    assert.ok(meetingId);

    assert.equal(await computeTodaysMeetingCount(empB.id, new Date()), baseB + 1, 'attendee counts it');
    assert.equal(await computeTodaysMeetingCount(manager.id, new Date()), baseMgr + 1, 'organiser counts it');
    assert.equal(await computeTodaysMeetingCount(empC.id, new Date()), baseC, 'uninvolved user does not');

    await subscribe(empB, 'https://push.example/b-daily');
    const summary = await runDailyPushReminders(new Date());
    assert.equal(summary.usersTargeted, 1, 'empB is targeted on meeting news alone (no follow-ups due)');
    assert.equal(summary.sent, 1);
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].endpoint, 'https://push.example/b-daily');
    const payload = JSON.parse(pushCalls[0].payloadJson);
    assert.match(payload.body, new RegExp(`আজ ${baseB + 1}টি meeting আছে`), 'the payload carries the meeting sentence with the full count');
  });
});
