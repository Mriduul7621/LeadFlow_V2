/**
 * Phase 3 PR #3 — first-contact SLA tracking + breach alerts.
 *
 * What is pinned here is the shipped behaviour, end to end:
 *
 *   - the pure rule (computeLeadSla): clock = leads.assigned_at
 *     (created_at fallback), first contact = last_contacted_at at or
 *     after the clock start, wall-clock window, due_soon at <= 25%
 *     remaining, terminal + unassigned excluded;
 *   - the switch: Metadata options group 'LeadSla' ('enabled' +
 *     'firstContactHours' in meta.hours), seeded OFF/24h by
 *     migration 051. OFF (or missing) = zero behaviour change;
 *   - GET /leads/follow-ups carries an `sla` object per item only
 *     when ON;
 *   - breach detection rides the morning push run: exactly ONE
 *     assignee alert + ONE direct-manager escalation per assignment
 *     episode (notification idempotency keys carry the episode's
 *     assigned_at), re-runs create nothing, reassignment opens a
 *     new episode that can alert again;
 *   - the push payload gains the breach sentence only for users
 *     with breaches; everyone else's body is byte-identical.
 *
 * The HTTP suite drives the real chain — runMigrations() (001→051) +
 * seedRoles() + default role grants — against PGlite, mirroring
 * lead-auto-assignment.test.ts.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
import { fallbackStore } from '../fallbackStore.js';
import {
  computeLeadSla,
  getLeadSlaConfig,
  normalizeSlaHours,
  runLeadSlaBreachAlerts,
  SLA_BREACH_EVENT,
  SLA_ESCALATION_EVENT,
  type LeadSlaInput,
} from '../services/LeadSlaService.js';
import {
  buildDailyReminderPayload,
  runDailyPushReminders,
  _setPushSenderForTest,
} from '../services/PushReminderService.js';

const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

const H = 60 * 60 * 1000;
const NOW = new Date('2026-06-15T06:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();

const slaInput = (over: Partial<LeadSlaInput> = {}): LeadSlaInput => ({
  assignedTo: 'user-1',
  assignedAt: iso(NOW.getTime() - 1 * H),
  createdAt: iso(NOW.getTime() - 2 * H),
  lastContactedAt: null,
  currentStatus: 'New',
  ...over,
});

/* ====================================================================
   1. Pure computation
==================================================================== */

describe('First-contact SLA — pure computation', () => {
  it('within: plenty of window left', () => {
    const r = computeLeadSla(slaInput(), 24, NOW);
    assert.equal(r?.state, 'within');
    assert.equal(r?.remainingMs, 23 * H);
    assert.equal(r?.overdueMs, 0);
    assert.equal(r?.deadlineAt, iso(NOW.getTime() + 23 * H));
  });

  it('due_soon begins exactly at 25% of the window left', () => {
    const at = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 18 * H) }), 24, NOW);
    assert.equal(at?.state, 'due_soon');
    assert.equal(at?.remainingMs, 6 * H);
    const above = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 17.9 * H) }), 24, NOW);
    assert.equal(above?.state, 'within');
  });

  it('exactly at the deadline with no contact is breached', () => {
    const r = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 24 * H) }), 24, NOW);
    assert.equal(r?.state, 'breached');
    assert.equal(r?.overdueMs, 0);
    const after = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 24 * H - 1000) }), 24, NOW);
    assert.equal(after?.state, 'breached');
    assert.equal(after?.overdueMs, 1000);
  });

  it('just before the deadline is due_soon, not breached', () => {
    const r = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 24 * H + 60_000) }), 24, NOW);
    assert.equal(r?.state, 'due_soon');
  });

  it('met: first contact inside the window (incl. exactly at assignment)', () => {
    const start = NOW.getTime() - 10 * H;
    const inTime = computeLeadSla(
      slaInput({ assignedAt: iso(start), lastContactedAt: iso(start + 2 * H) }), 24, NOW);
    assert.equal(inTime?.state, 'met');
    assert.equal(inTime?.firstContactAt, iso(start + 2 * H));
    const atStart = computeLeadSla(
      slaInput({ assignedAt: iso(start), lastContactedAt: iso(start) }), 24, NOW);
    assert.equal(atStart?.state, 'met');
  });

  it('a contact from a PREVIOUS assignment episode does not count', () => {
    // Reassigned 1h ago; the only contact stamp predates this episode.
    const r = computeLeadSla(
      slaInput({ assignedAt: iso(NOW.getTime() - 1 * H), lastContactedAt: iso(NOW.getTime() - 30 * H) }),
      24, NOW);
    assert.equal(r?.state, 'within');
    assert.equal(r?.firstContactAt, null);
    // Same, but the new episode has also run out of window.
    const breached = computeLeadSla(
      slaInput({ assignedAt: iso(NOW.getTime() - 30 * H), lastContactedAt: iso(NOW.getTime() - 40 * H) }),
      24, NOW);
    assert.equal(breached?.state, 'breached');
  });

  it('terminal statuses and unassigned leads are excluded', () => {
    assert.equal(computeLeadSla(slaInput({ currentStatus: 'Converted', assignedAt: iso(NOW.getTime() - 90 * H) }), 24, NOW), null);
    assert.equal(computeLeadSla(slaInput({ currentStatus: 'Not Interested', assignedAt: iso(NOW.getTime() - 90 * H) }), 24, NOW), null);
    assert.equal(computeLeadSla(slaInput({ assignedTo: null }), 24, NOW), null);
    assert.equal(computeLeadSla(slaInput({ assignedTo: '' }), 24, NOW), null);
  });

  it('legacy rows fall back to created_at when assigned_at is null', () => {
    const r = computeLeadSla(
      slaInput({ assignedAt: null, createdAt: iso(NOW.getTime() - 30 * H) }), 24, NOW);
    assert.equal(r?.state, 'breached');
    assert.equal(r?.clockStartAt, iso(NOW.getTime() - 30 * H));
    assert.equal(computeLeadSla(slaInput({ assignedAt: null, createdAt: null }), 24, NOW), null);
  });

  it('the window is configurable (4h window breaches sooner)', () => {
    const r = computeLeadSla(slaInput({ assignedAt: iso(NOW.getTime() - 5 * H) }), 4, NOW);
    assert.equal(r?.state, 'breached');
    assert.equal(r?.overdueMs, 1 * H);
  });

  it('normalizeSlaHours clamps and defaults', () => {
    assert.equal(normalizeSlaHours(24), 24);
    assert.equal(normalizeSlaHours('48'), 48);
    assert.equal(normalizeSlaHours(12.6), 13);
    assert.equal(normalizeSlaHours(0), 1);
    assert.equal(normalizeSlaHours(9999), 720);
    assert.equal(normalizeSlaHours('abc'), 24);
    assert.equal(normalizeSlaHours(null), 24);
    assert.equal(normalizeSlaHours(undefined), 24);
  });
});

/* ====================================================================
   2. Push payload composition (pure)
==================================================================== */

describe('First-contact SLA — push payload composition', () => {
  it('no breaches: body is byte-identical to the pre-SLA wording', () => {
    assert.equal(
      buildDailyReminderPayload({ dueToday: 2, overdue: 1 }).body,
      'আজ 2টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।'
    );
    assert.equal(
      buildDailyReminderPayload({ dueToday: 2, overdue: 1, slaBreaches: 0 }).body,
      'আজ 2টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।'
    );
  });

  it('breaches append their own sentence after the counts', () => {
    assert.equal(
      buildDailyReminderPayload({ dueToday: 2, overdue: 1, slaBreaches: 3 }).body,
      'আজ 2টি follow-up due, 1টি overdue আছে। 3টি lead-এর first-contact SLA পার হয়ে গেছে। Workbench-এ দেখে নিন।'
    );
  });

  it('breaches alone still compose a complete body', () => {
    assert.equal(
      buildDailyReminderPayload({ dueToday: 0, overdue: 0, slaBreaches: 2 }).body,
      '2টি lead-এর first-contact SLA পার হয়ে গেছে। Workbench-এ দেখে নিন।'
    );
  });
});

/* ====================================================================
   3. Demo mode (fallbackStore, no database)
==================================================================== */

describe('First-contact SLA — demo mode', () => {
  const savedUsers = [...fallbackStore.users];
  const savedLeads = [...fallbackStore.leads];
  const savedOptions = [...(fallbackStore.options as any[])];
  const savedNotifications = [...((fallbackStore as any).notifications || [])];
  const savedDbUrl = process.env.DATABASE_URL;

  const assignedLongAgo = iso(Date.now() - 30 * H);

  before(() => {
    delete process.env.DATABASE_URL;
    (fallbackStore as any).users = [
      { id: 'demo-mgr-1', employeeId: 'MGR_D1', fullName: 'Demo Manager', email: 'mgr@test.com', role: 'TEAM_LEAD', roleCode: 'TEAM_LEAD', status: 'Active', isActive: true },
      { id: 'demo-agent-1', employeeId: 'EMP_D1', fullName: 'Demo Agent', email: 'agent@test.com', role: 'EMPLOYEE', roleCode: 'EMPLOYEE', status: 'Active', isActive: true, managerId: 'MGR_D1' },
    ];
    (fallbackStore as any).leads = [
      {
        id: 'demo-sla-breach', customerName: 'Breached Demo', mobile: '01710000011',
        assignedTo: 'EMP_D1', assignedDate: assignedLongAgo, timestamp: assignedLongAgo,
        currentStatus: 'New', lastFollowUpDate: null, nextFollowUpDate: iso(Date.now() + 26 * H),
      },
      {
        id: 'demo-sla-met', customerName: 'Met Demo', mobile: '01710000012',
        assignedTo: 'EMP_D1', assignedDate: assignedLongAgo, timestamp: assignedLongAgo,
        currentStatus: 'Contacted', lastFollowUpDate: iso(Date.now() - 29 * H), nextFollowUpDate: iso(Date.now() + 26 * H),
      },
    ];
    (fallbackStore as any).notifications = [];
  });

  after(() => {
    (fallbackStore as any).users = savedUsers;
    (fallbackStore as any).leads = savedLeads;
    (fallbackStore as any).options = savedOptions;
    (fallbackStore as any).notifications = savedNotifications;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  beforeEach(() => {
    (fallbackStore as any).options = [
      { id: 'opt-sla-on', type: 'LeadSla', value: 'enabled', label: 'First-contact SLA tracking', status: 'Active', meta: { featureFlag: true } },
      { id: 'opt-sla-hours', type: 'LeadSla', value: 'firstContactHours', label: 'First-contact window (hours)', status: 'Active', meta: { hours: 24 } },
    ];
    (fallbackStore as any).notifications = [];
  });

  it('config reads the demo options mirror', async () => {
    assert.deepEqual(await getLeadSlaConfig(), { enabled: true, firstContactHours: 24 });
    (fallbackStore as any).options = [
      { id: 'opt-sla-off', type: 'LeadSla', value: 'enabled', label: 'x', status: 'Inactive', meta: {} },
    ];
    assert.deepEqual(await getLeadSlaConfig(), { enabled: false, firstContactHours: 24 });
  });

  it('alerts the assignee + direct manager exactly once per episode', async () => {
    const first = await runLeadSlaBreachAlerts(new Date());
    assert.equal(first.enabled, true);
    assert.equal(first.breached, 1, 'only the un-contacted lead breaches (the met lead is excluded)');
    assert.equal(first.alerted, 1);
    assert.equal(first.escalated, 1);
    assert.equal(first.breachesByAssignee.get('demo-agent-1'), 1);

    const notifs = ((fallbackStore as any).notifications as any[])
      .filter(n => n.eventType === SLA_BREACH_EVENT || n.eventType === SLA_ESCALATION_EVENT);
    assert.equal(notifs.length, 2);
    assert.equal(notifs.find(n => n.eventType === SLA_BREACH_EVENT)?.userId, 'demo-agent-1');
    assert.equal(notifs.find(n => n.eventType === SLA_ESCALATION_EVENT)?.userId, 'demo-mgr-1');

    const second = await runLeadSlaBreachAlerts(new Date());
    assert.equal(second.alerted, 0);
    assert.equal(second.escalated, 0);
    assert.equal(second.deduped, 2);
    assert.equal(((fallbackStore as any).notifications as any[]).length, 2);
  });

  it('switch OFF: no scan, no notifications', async () => {
    (fallbackStore as any).options = [
      { id: 'opt-sla-off', type: 'LeadSla', value: 'enabled', label: 'x', status: 'Inactive', meta: {} },
      { id: 'opt-sla-hours', type: 'LeadSla', value: 'firstContactHours', label: 'x', status: 'Active', meta: { hours: 24 } },
    ];
    const run = await runLeadSlaBreachAlerts(new Date());
    assert.equal(run.enabled, false);
    assert.equal(run.breached, 0);
    assert.equal(((fallbackStore as any).notifications as any[]).length, 0);
  });
});

/* ====================================================================
   4. HTTP + cron (PGlite, real migrations)
==================================================================== */

describe('First-contact SLA — HTTP + cron (PGlite, real migrations)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let deptId = '';
  let ceo: any;
  let tl: any;
  let e1: any;
  let e2: any;

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) => sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

  async function setSla(on: boolean, hours = 24) {
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('LeadSla', 'enabled', 'First-contact SLA tracking', 1, FALSE, $1, '{"featureFlag":true}'::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [on]
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('LeadSla', 'firstContactHours', 'First-contact window (hours)', 2, FALSE, TRUE, $1::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`,
      [JSON.stringify({ hours })]
    );
  }

  const addUser = async (employeeId: string, role: string, managerId?: string) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId,
        fullName: `Person ${employeeId}`,
        email: `${employeeId.toLowerCase()}@test.com`,
        role,
        departmentId: deptId,
        managerId: role === 'CEO' ? undefined : (managerId || ceo.id),
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const addLead = async (opts: {
    mobile: string;
    ownerId: string;
    assignedAt: string;
    lastContactedAt?: string | null;
    status?: string;
    nextFollowUpAt?: string | null;
  }) => {
    const res = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by,
                          current_status, assigned_at, last_contacted_at, next_follow_up_at)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, $6, $7, $8) RETURNING id`,
      [
        `lead_${opts.mobile}`, `Customer ${opts.mobile}`, opts.mobile, opts.ownerId,
        opts.status || 'New', opts.assignedAt, opts.lastContactedAt ?? null,
        opts.nextFollowUpAt === undefined ? new Date(Date.now() + 26 * H).toISOString() : opts.nextFollowUpAt,
      ]
    );
    return res.rows[0].id as string;
  };

  const notifCount = async (eventType: string, userId?: string) => {
    const res = userId
      ? await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE event_type = $1 AND user_id = $2`, [eventType, userId])
      : await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE event_type = $1`, [eventType]);
    return res.rows[0].n as number;
  };

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.JWT_SECRET = 'lead-sla-tracking-secret';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    await applyDefaultRoleAccess();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);
  });

  after(async () => {
    _setPushSenderForTest(null);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM push_subscriptions');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');
    await pool.query(`DELETE FROM options WHERE field_key = 'LeadSla'`);

    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    deptId = dept.body.id;

    ceo = await addUser('CEO1', 'CEO');
    tl = await addUser('TL001', 'TEAM_LEAD');
    e1 = await addUser('EMP001', 'EMPLOYEE', tl.id);
    e2 = await addUser('EMP002', 'EMPLOYEE', tl.id);
  });

  it('migration 051 is registered as the tail and seeds OFF + 24h, idempotently', async () => {
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '051_lead_sla_config');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('051_lead_sla_config'));

    // Seeded state straight after runMigrations: switch OFF, 24h.
    assert.deepEqual(await getLeadSlaConfig(), { enabled: false, firstContactHours: 24 });

    // An admin change survives a re-run of the migration.
    await setSla(true, 48);
    const { up } = await import('../database/migrations/051_lead_sla_config.js');
    await up();
    await up();
    assert.deepEqual(await getLeadSlaConfig(), { enabled: true, firstContactHours: 48 });
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'LeadSla'`);
    assert.equal(rows.rows[0].n, 2);
  });

  it('queue: flag OFF → items carry no sla field at all', async () => {
    await setSla(false);
    await addLead({ mobile: '01720000001', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });
    const res = await request(app)
      .get('/api/leads/follow-ups?bucket=all')
      .set('Authorization', `Bearer ${tokenFor(e1, 'EMPLOYEE')}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = res.body.data.items as any[];
    assert.equal(items.length, 1);
    assert.ok(!('sla' in items[0]), 'sla must be absent when the switch is off');
  });

  it('queue: flag ON → breached / met / within states ride the items', async () => {
    await setSla(true, 24);
    const now = Date.now();
    await addLead({ mobile: '01720000002', ownerId: e1.id, assignedAt: iso(now - 30 * H) });
    await addLead({
      mobile: '01720000003', ownerId: e1.id, assignedAt: iso(now - 30 * H),
      lastContactedAt: iso(now - 29 * H), status: 'Contacted',
    });
    await addLead({ mobile: '01720000004', ownerId: e1.id, assignedAt: iso(now - 2 * H) });

    const res = await request(app)
      .get('/api/leads/follow-ups?bucket=all')
      .set('Authorization', `Bearer ${tokenFor(e1, 'EMPLOYEE')}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byMobile = new Map((res.body.data.items as any[]).map(i => [i.mobile, i]));
    assert.equal(byMobile.size, 3);

    const breached = byMobile.get('01720000002');
    assert.equal(breached.sla.state, 'breached');
    assert.ok(breached.sla.overdueMs > 5 * H && breached.sla.overdueMs < 7 * H,
      `overdueMs ${breached.sla.overdueMs} should be ~6h`);
    assert.equal(breached.sla.firstContactAt, null);

    const met = byMobile.get('01720000003');
    assert.equal(met.sla.state, 'met');
    assert.ok(met.sla.firstContactAt);

    const within = byMobile.get('01720000004');
    assert.equal(within.sla.state, 'within');
    assert.ok(within.sla.remainingMs > 21 * H);
  });

  it('cron alerts: exactly one assignee + one manager notification, deduped on re-run', async () => {
    await setSla(true, 24);
    await addLead({ mobile: '01720000005', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });

    const first = await runLeadSlaBreachAlerts(new Date());
    assert.equal(first.enabled, true);
    assert.equal(first.breached, 1);
    assert.equal(first.alerted, 1);
    assert.equal(first.escalated, 1);
    assert.equal(await notifCount(SLA_BREACH_EVENT, e1.id), 1);
    assert.equal(await notifCount(SLA_ESCALATION_EVENT, tl.id), 1);

    const second = await runLeadSlaBreachAlerts(new Date());
    assert.equal(second.alerted, 0);
    assert.equal(second.escalated, 0);
    assert.equal(second.deduped, 2);
    assert.equal(await notifCount(SLA_BREACH_EVENT), 1);
    assert.equal(await notifCount(SLA_ESCALATION_EVENT), 1);
  });

  it('cron alerts: flag OFF creates nothing', async () => {
    await setSla(false, 24);
    await addLead({ mobile: '01720000006', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });
    const run = await runLeadSlaBreachAlerts(new Date());
    assert.equal(run.enabled, false);
    assert.equal(await notifCount(SLA_BREACH_EVENT), 0);
    assert.equal(await notifCount(SLA_ESCALATION_EVENT), 0);
  });

  it('reassignment resets the clock and the alert episode', async () => {
    await setSla(true, 24);
    const leadId = await addLead({ mobile: '01720000007', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });
    const first = await runLeadSlaBreachAlerts(new Date());
    assert.equal(first.alerted, 1);
    assert.equal(await notifCount(SLA_BREACH_EVENT, e1.id), 1);

    // Reassign to e2 with a fresh clock: no breach, no alerts.
    await pool.query(
      `UPDATE leads SET assigned_to = $1, assigned_at = NOW() WHERE id = $2`,
      [e2.id, leadId]
    );
    const fresh = await runLeadSlaBreachAlerts(new Date());
    assert.equal(fresh.breached, 0);
    assert.equal(fresh.alerted, 0);

    // Age the NEW episode past the window: a new alert episode fires
    // for the new assignee (+ their manager), the old one stays single.
    await pool.query(
      `UPDATE leads SET assigned_at = $1 WHERE id = $2`,
      [iso(Date.now() - 30 * H), leadId]
    );
    const aged = await runLeadSlaBreachAlerts(new Date());
    assert.equal(aged.alerted, 1);
    assert.equal(await notifCount(SLA_BREACH_EVENT, e2.id), 1);
    assert.equal(await notifCount(SLA_BREACH_EVENT, e1.id), 1, 'previous episode stays exactly one');
    assert.equal(await notifCount(SLA_ESCALATION_EVENT, tl.id), 2, 'one escalation per episode');
  });

  it('morning push run: breach count reaches only the affected user', async () => {
    await setSla(true, 24);
    // e1: breached lead, but NO due/overdue follow-ups (next follow-up
    // is tomorrow) — before SLA this user received no push at all.
    await addLead({ mobile: '01720000008', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });
    // e2: nothing due, nothing breached.
    await addLead({ mobile: '01720000009', ownerId: e2.id, assignedAt: iso(Date.now() - 1 * H) });

    process.env.VAPID_PUBLIC_KEY =
      'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM';
    process.env.VAPID_PRIVATE_KEY = 'tKbBZatMgMVAR1mkB5TSIJZr2RSjdyBuk87V4MwIZQo';
    try {
      const sub = (user: any, endpoint: string) =>
        request(app)
          .post('/api/notifications/push/subscribe')
          .set('Authorization', `Bearer ${tokenFor(user, 'EMPLOYEE')}`)
          .send({
            endpoint,
            keys: {
              p256dh: 'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM',
              auth: 'testauthsecret123456',
            },
          });
      assert.equal((await sub(e1, 'https://fcm.googleapis.com/fcm/send/sla-device-1')).status, 200);
      assert.equal((await sub(e2, 'https://fcm.googleapis.com/fcm/send/sla-device-2')).status, 200);

      const sent: Array<{ endpoint: string; payload: any }> = [];
      _setPushSenderForTest(async (target, payloadJson) => {
        sent.push({ endpoint: target.endpoint, payload: JSON.parse(payloadJson) });
      });

      const summary = await runDailyPushReminders(new Date());
      assert.equal(summary.sla.enabled, true);
      assert.equal(summary.sla.breached, 1);
      assert.equal(summary.sla.alerted, 1);
      assert.equal(summary.sent, 1, 'only the affected user is pushed');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].endpoint, 'https://fcm.googleapis.com/fcm/send/sla-device-1');
      assert.equal(
        sent[0].payload.body,
        '1টি lead-এর first-contact SLA পার হয়ে গেছে। Workbench-এ দেখে নিন।'
      );
      // The same run also wrote the in-app alerts.
      assert.equal(await notifCount(SLA_BREACH_EVENT, e1.id), 1);
      assert.equal(await notifCount(SLA_ESCALATION_EVENT, tl.id), 1);
    } finally {
      _setPushSenderForTest(null);
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    }
  });

  it('morning push run: SLA off → no breach line, no alerts, baseline behaviour', async () => {
    await setSla(false, 24);
    await addLead({ mobile: '01720000010', ownerId: e1.id, assignedAt: iso(Date.now() - 30 * H) });
    process.env.VAPID_PUBLIC_KEY =
      'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM';
    process.env.VAPID_PRIVATE_KEY = 'tKbBZatMgMVAR1mkB5TSIJZr2RSjdyBuk87V4MwIZQo';
    try {
      const res = await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', `Bearer ${tokenFor(e1, 'EMPLOYEE')}`)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/sla-device-off',
          keys: {
            p256dh: 'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM',
            auth: 'testauthsecret123456',
          },
        });
      assert.equal(res.status, 200);
      _setPushSenderForTest(async () => {});
      const summary = await runDailyPushReminders(new Date());
      assert.equal(summary.sla.enabled, false);
      assert.equal(summary.sent, 0, 'nothing due and SLA off → no push');
      assert.equal(await notifCount(SLA_BREACH_EVENT), 0);
    } finally {
      _setPushSenderForTest(null);
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    }
  });
});

/* ====================================================================
   5. Wiring guards (source)
==================================================================== */

describe('First-contact SLA — wiring guards', () => {
  it('the chip renders only breached / due_soon and uses the brief wording', () => {
    const chip = readFileSync('src/modules/leads/components/LeadSlaChip.tsx', 'utf8');
    assert.ok(chip.includes('SLA পার হয়ে গেছে'));
    assert.ok(chip.includes("sla.state === 'breached'"));
    assert.ok(chip.includes("sla.state === 'due_soon'"));
  });

  it('queue handler computes sla from the service, gated on the config', () => {
    const leads = readFileSync('server/routes/production/leads.routes.ts', 'utf8');
    assert.ok(leads.includes("from '../../services/LeadSlaService.js'"));
    assert.ok(leads.includes('getLeadSlaConfig()'));
    assert.ok(leads.includes('computeLeadSla('));
    assert.ok(leads.includes('l.assigned_at, l.assigned_to'));
  });

  it('the morning run invokes SLA detection before the push fan-out', () => {
    const push = readFileSync('server/services/PushReminderService.ts', 'utf8');
    const runnerAt = push.indexOf('export async function runDailyPushReminders');
    assert.ok(runnerAt > -1);
    const slaAt = push.indexOf('runLeadSlaBreachAlerts(now)', runnerAt);
    const fanOutAt = push.indexOf('listPushSubscriptions()', runnerAt);
    assert.ok(slaAt > -1 && fanOutAt > -1 && slaAt < fanOutAt);
  });

  it('Settings carries the SLA toggle card next to auto-assignment', () => {
    const settings = readFileSync('src/modules/settings/pages/Settings.tsx', 'utf8');
    assert.ok(settings.includes('First-Contact SLA'));
    assert.ok(settings.includes("metadataService.getAllValues('LeadSla')"));
    assert.ok(settings.indexOf('Lead Auto-Assignment') < settings.indexOf('First-Contact SLA'));
  });
});
