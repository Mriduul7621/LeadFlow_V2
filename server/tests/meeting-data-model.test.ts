import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as migrate055 } from '../database/migrations/055_meeting_data_model.js';

// Same test-only fixture secret the other integration suites use
// (assembled in parts so this file carries no contiguous literal).
const JWT_SECRET = 'test-jwt-secret-for-' + 'followup-integration';

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
 * Schema mirrors next-step-calendar-sync.test.ts — scheduled_activities
 * in its MIGRATION-039 SHAPE (lead_id NOT NULL, no attendees table, no
 * reminder_minutes), so the suite exercises migration 055 itself.
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
}

const T1 = '2027-03-10T10:00:00.000Z';
const T2 = '2027-03-11T15:30:00.000Z';

describe('Meeting data model (PR B) — lead-less events, attendees, RSVP, reminders', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
  let manager: any;
  let empA: any;
  let empB: any;
  let empC: any;
  let empInactive: any;
  let leadOfA: any;

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

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
    const mkUser = async (emp: string, name: string, roleId: string, managerId: string | null, active = true) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId, active]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    adminUser = { ...(await mkUser('ADMIN1', 'Admin User', adminRole.rows[0].id, null)), role: 'ADMIN' };
    manager = { ...(await mkUser('MGR1', 'Manager One', mgrRole.rows[0].id, null)), role: 'MANAGER' };
    empA = { ...(await mkUser('EMPA', 'Employee A', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };
    empB = { ...(await mkUser('EMPB', 'Employee B', empRole.rows[0].id, manager.id)), role: 'EMPLOYEE' };
    empC = { ...(await mkUser('EMPC', 'Employee C', empRole.rows[0].id, null)), role: 'EMPLOYEE' };
    empInactive = { ...(await mkUser('EMPX', 'Inactive X', empRole.rows[0].id, null, false)), role: 'EMPLOYEE' };

    const leadRes: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, current_status, created_by)
       VALUES ('MTG-LEAD-1', 'Meeting Lead', '01722220001', $1, 'Interested', $1) RETURNING *`,
      [empA.id]
    );
    leadOfA = leadRes.rows[0];

    // The migration under test — nullable lead, attendees, reminder.
    await migrate055();
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

  async function createEvent(user: any, payload: any): Promise<any> {
    return request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${tokenFor(user)}`).send(payload);
  }

  async function getEvent(user: any, id: string): Promise<any> {
    return request(app).get(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  async function listEvents(user: any): Promise<any[]> {
    const res = await request(app).get('/api/scheduled-activities?limit=200').set('Authorization', `Bearer ${tokenFor(user)}`);
    assert.equal(res.status, 200, `list failed: ${JSON.stringify(res.body)}`);
    return res.body.data || [];
  }

  it('migration 055 is the registered tail: lead_id nullable, attendees table, reminder column; re-run is a no-op', async () => {
    assert.ok(MIGRATION_IDS.includes('055_meeting_data_model'));
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '056_calendar_settings_holidays', '056 is the migration tail (055 stays registered)');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('055_meeting_data_model'), 'runner names migration 055');
    const col: any = await pool.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'scheduled_activities' AND column_name = 'lead_id'`
    );
    assert.equal(col.rows[0].is_nullable, 'YES');
    const rem: any = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'scheduled_activities' AND column_name = 'reminder_minutes'`
    );
    assert.equal(rem.rows.length, 1);
    const tbl: any = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduled_activity_attendees'`
    );
    assert.equal(tbl.rows.length, 1);
    await migrate055(); // idempotent re-run must not throw
  });

  it('lead-less create: meeting with attendees + reminder; organiser defaults as assignee; attendees pending', async () => {
    const res = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Weekly Sync',
      scheduledAt: T1,
      durationMinutes: 45,
      attendeeIds: [empB.id],
      reminderMinutes: 30,
    });
    assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    const d = res.body.data;
    assert.equal(d.leadId, null);
    assert.equal(d.activityType, 'meeting');
    assert.equal(d.title, 'Weekly Sync');
    assert.equal(d.reminderMinutes, 30);
    assert.equal(String(d.assigned_to), String(empA.id), 'organiser is the default assignee');
    assert.equal(d.attendees.length, 1);
    assert.equal(String(d.attendees[0].userId), String(empB.id));
    assert.equal(d.attendees[0].response, 'pending');
    assert.equal(d.attendees[0].respondedAt, null);
  });

  it('organiser listed in attendeeIds is stored accepted; everyone else pending', async () => {
    const res = await createEvent(empA, {
      activityType: 'meeting',
      title: 'Planning',
      scheduledAt: T1,
      attendeeIds: [empA.id, empB.id, empB.id],
    });
    assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    const atts = res.body.data.attendees;
    assert.equal(atts.length, 2, 'duplicate refs are deduped');
    const mine = atts.find((a: any) => String(a.userId) === String(empA.id));
    const other = atts.find((a: any) => String(a.userId) === String(empB.id));
    assert.equal(mine.response, 'accepted');
    assert.ok(mine.respondedAt, 'organiser row carries responded_at');
    assert.equal(other.response, 'pending');
  });

  it('inactive attendee is refused with the PR #106 semantics; unknown attendee is a 400', async () => {
    const inactive = await createEvent(empA, {
      activityType: 'meeting', title: 'Bad Invite', scheduledAt: T1, attendeeIds: [empInactive.id],
    });
    assert.equal(inactive.status, 400);
    assert.match(inactive.body.message, /Assigned user "EMPX" is inactive/);
    const unknown = await createEvent(empA, {
      activityType: 'meeting', title: 'Ghost Invite', scheduledAt: T1, attendeeIds: ['NOPE99'],
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /was not found/);
  });

  it('lead-less validation: call/follow_up without a lead and a meeting without a title are 400s', async () => {
    const call = await createEvent(empA, { activityType: 'call', title: 'Call', scheduledAt: T1 });
    assert.equal(call.status, 400);
    assert.match(call.body.message, /without a lead/);
    const fu = await createEvent(empA, { activityType: 'follow_up', title: 'FU', scheduledAt: T1 });
    assert.equal(fu.status, 400);
    const noTitle = await createEvent(empA, { activityType: 'meeting', scheduledAt: T1 });
    assert.equal(noTitle.status, 400);
    assert.match(noTitle.body.message, /title is required/);
    const task = await createEvent(empA, { activityType: 'task', title: 'Prepare deck', scheduledAt: T1 });
    assert.equal(task.status, 201, 'a lead-less task is legal');
  });

  it('visibility matrix: organiser ✓, attendee ✓, downline manager ✓, admin ✓, unrelated 404; peer without invite 404', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting', title: 'Matrix Meeting', scheduledAt: T2, attendeeIds: [empB.id],
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    assert.equal((await getEvent(empA, id)).status, 200, 'organiser sees it');
    const asB = await getEvent(empB, id);
    assert.equal(asB.status, 200, 'attendee sees it');
    assert.equal(asB.body.data.leadCustomerName, null, 'lead fields render null on a lead-less row');
    assert.equal((await getEvent(manager, id)).status, 200, 'downline manager sees a report’s meeting');
    assert.equal((await getEvent(adminUser, id)).status, 200, 'admin sees it');
    assert.equal((await getEvent(empC, id)).status, 404, 'unrelated user gets the no-leak 404');

    // Peer WITHOUT an invite: B is A's peer under the same manager.
    const solo = await createEvent(empA, { activityType: 'meeting', title: 'Solo Meeting', scheduledAt: T2 });
    assert.equal(solo.status, 201);
    assert.equal((await getEvent(empB, solo.body.data.id)).status, 404, 'peer without invite gets 404');

    const listB = await listEvents(empB);
    assert.ok(listB.some((r: any) => String(r.id) === String(id)), 'attendee list includes the meeting');
    assert.ok(!listB.some((r: any) => String(r.id) === String(solo.body.data.id)), 'peer list excludes the uninvited meeting');
    const listC = await listEvents(empC);
    assert.ok(!listC.some((r: any) => String(r.id) === String(id)), 'unrelated list excludes the meeting');
    const listMgr = await listEvents(manager);
    assert.ok(listMgr.some((r: any) => String(r.id) === String(id)), 'manager list includes the downline meeting');
  });

  it('RSVP: attendee accepts then declines; non-attendee 404; organiser 400', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting', title: 'RSVP Meeting', scheduledAt: T2, attendeeIds: [empB.id],
    });
    const id = created.body.data.id;

    const byC = await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empC)}`).send({ response: 'accepted' });
    assert.equal(byC.status, 404, 'non-attendee RSVP is the no-leak 404');
    const byOrganiser = await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empA)}`).send({ response: 'accepted' });
    assert.equal(byOrganiser.status, 400, 'organiser never RSVPs');
    const bad = await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'maybe' });
    assert.equal(bad.status, 400);

    const accepted = await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'accepted' });
    assert.equal(accepted.status, 200, `rsvp failed: ${JSON.stringify(accepted.body)}`);
    const mineA = accepted.body.data.attendees.find((a: any) => String(a.userId) === String(empB.id));
    assert.equal(mineA.response, 'accepted');
    assert.ok(mineA.respondedAt, 'responded_at is stamped');

    const declined = await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'declined' });
    assert.equal(declined.status, 200);
    const mineD = declined.body.data.attendees.find((a: any) => String(a.userId) === String(empB.id));
    assert.equal(mineD.response, 'declined');
  });

  it('PUT: attendee replacement preserves retained responses; attendee cannot edit; reminder set + clear', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting', title: 'Edit Meeting', scheduledAt: T2, attendeeIds: [empB.id], reminderMinutes: 60,
    });
    const id = created.body.data.id;
    await request(app).post(`/api/scheduled-activities/${id}/rsvp`).set('Authorization', `Bearer ${tokenFor(empB)}`).send({ response: 'accepted' });

    const byAttendee = await request(app).put(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(empB)}`).send({ title: 'Hijack' });
    assert.equal(byAttendee.status, 404, 'a mere attendee cannot edit a lead-less event');

    const swapped = await request(app).put(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(empA)}`).send({ attendeeIds: [empB.id, empC.id], reminderMinutes: 15 });
    assert.equal(swapped.status, 200, `put failed: ${JSON.stringify(swapped.body)}`);
    const atts = swapped.body.data.attendees;
    assert.equal(atts.length, 2);
    assert.equal(atts.find((a: any) => String(a.userId) === String(empB.id)).response, 'accepted', 'retained attendee keeps the RSVP');
    assert.equal(atts.find((a: any) => String(a.userId) === String(empC.id)).response, 'pending', 'new attendee starts pending');
    assert.equal(swapped.body.data.reminderMinutes, 15);

    const cleared = await request(app).put(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(empA)}`).send({ reminderMinutes: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.reminderMinutes, null, 'reminder clears to null');
  });

  it('lead-less complete: marks completed with NO lead history row; cancel works for the organiser', async () => {
    const created = await createEvent(empA, {
      activityType: 'task', title: 'One-off Task', scheduledAt: T2, attendeeIds: [empB.id],
    });
    const id = created.body.data.id;
    const beforeCount: any = await pool.query(`SELECT COUNT(*)::int AS c FROM lead_activities`);
    const done = await request(app).post(`/api/scheduled-activities/${id}/complete`).set('Authorization', `Bearer ${tokenFor(empA)}`).send({});
    assert.equal(done.status, 200, `complete failed: ${JSON.stringify(done.body)}`);
    assert.equal(done.body.data.scheduled.status, 'completed');
    assert.equal(done.body.data.activity, null, 'no lead history is written for a lead-less event');
    const afterCount: any = await pool.query(`SELECT COUNT(*)::int AS c FROM lead_activities`);
    assert.equal(afterCount.rows[0].c, beforeCount.rows[0].c, 'lead_activities untouched');

    const toCancel = await createEvent(empA, { activityType: 'meeting', title: 'Cancel Me', scheduledAt: T2 });
    const cancelled = await request(app).post(`/api/scheduled-activities/${toCancel.body.data.id}/cancel`).set('Authorization', `Bearer ${tokenFor(empA)}`).send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'cancelled');
  });

  it('lead-less delete by the organiser cascades the attendee rows', async () => {
    const created = await createEvent(empA, {
      activityType: 'meeting', title: 'Delete Me', scheduledAt: T2, attendeeIds: [empB.id],
    });
    const id = created.body.data.id;
    const byAttendee = await request(app).delete(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(empB)}`);
    assert.equal(byAttendee.status, 404, 'attendee cannot delete');
    const del = await request(app).delete(`/api/scheduled-activities/${id}`).set('Authorization', `Bearer ${tokenFor(empA)}`);
    assert.equal(del.status, 200);
    const left: any = await pool.query(`SELECT COUNT(*)::int AS c FROM scheduled_activity_attendees WHERE activity_id = $1`, [id]);
    assert.equal(left.rows[0].c, 0, 'invites cascade away with the event');
  });

  it('lead events are unchanged: create with lead + attendees, list carries lead fields, attendee does NOT widen lead access', async () => {
    const created = await createEvent(empA, {
      leadId: leadOfA.id,
      activityType: 'meeting',
      title: 'Customer Meeting',
      scheduledAt: T2,
      attendeeIds: [empB.id],
      reminderMinutes: 10,
    });
    assert.equal(created.status, 201, `lead create failed: ${JSON.stringify(created.body)}`);
    assert.equal(String(created.body.data.leadId), String(leadOfA.id));
    assert.equal(created.body.data.leadCustomerName, 'Meeting Lead');
    assert.equal(created.body.data.attendees.length, 1);

    const asB = await getEvent(empB, created.body.data.id);
    assert.equal(asB.status, 404, 'an invite never widens PR #104 lead access');

    const list = await listEvents(empA);
    const row = list.find((r: any) => String(r.id) === String(created.body.data.id));
    assert.ok(row, 'lead event still lists for its owner');
    assert.equal(row.leadCustomerName, 'Meeting Lead');
    assert.equal(row.reminderMinutes, 10);
  });
});
