import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrateRoadshows } from '../database/migrations/042_roadshows.js';

/**
 * Mahadi's three review decisions (2026-11-09), closing the organogram
 * review's flagged leftovers:
 *
 *   D1 — NO email notifications. Notifications are in-app + web push
 *        only; user-facing copy must not claim email alerts exist.
 *   D2 — An employee must NOT see another employee's leads. Per-person
 *        open-lead counts ride the roster / user / hierarchy-health
 *        payloads only for people inside the CALLER's data-visibility
 *        scope; out-of-scope counts arrive as null ("not loaded"),
 *        exactly like a caller who never loaded counts at all.
 *   D3 — A roadshow's assigned people are exactly its CREATOR plus the
 *        picked "assist" users. The creator is pinned server-side on
 *        create and on edit; assist picks must be ACTIVE (the PR #106
 *        rule, now also applied to scheduled-activity assignment).
 */

const JWT_SECRET = 'test-jwt-secret-key-for-local-integration-tests';

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
      is_active BOOLEAN DEFAULT TRUE,
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
      feature_permissions JSONB,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
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
      team_id UUID,
      manager_id UUID,
      designation VARCHAR(255),
      phone VARCHAR(50),
      profile_photo TEXT,
      account_status VARCHAR(30) DEFAULT 'ACTIVE',
      is_active BOOLEAN DEFAULT TRUE,
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      joining_date DATE,
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      permission_name VARCHAR(255),
      module_name VARCHAR(100) NOT NULL DEFAULT '',
      action_name VARCHAR(30) NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT NOW(),
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
      source VARCHAR(100),
      assigned_to UUID,
      assigned_by UUID,
      created_by UUID,
      updated_by UUID,
      current_status VARCHAR(255) DEFAULT 'New',
      next_follow_up_at TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL,
      activity_type VARCHAR(30) NOT NULL DEFAULT 'call',
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      duration_minutes INTEGER,
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
      meeting_type VARCHAR(255),
      location VARCHAR(255),
      created_by UUID,
      assigned_to UUID,
      updated_by UUID,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      completed_by UUID,
      completed_activity_id UUID
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

/* ================================================================== */
/*  D1 — copy truth (source guards)                                    */
/* ================================================================== */

const ROOT = process.cwd();
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Decision 1 — no email notifications (copy truth)', () => {
  it('the Settings notifications section no longer claims manager emails', () => {
    const settings = readSrc('src/modules/settings/pages/Settings.tsx');
    assert.ok(!/Upline Team Tracking Emails/.test(settings), 'the email row must be removed');
    assert.ok(!/Emails to Managers/.test(settings), 'no email-alert claim may remain');
    assert.ok(/In-App Assignment Alerts/.test(settings), 'the truthful in-app row stays');
    assert.ok(/Daily Push Summary/.test(settings), 'the real (daily) push behaviour is documented');
  });

  it('no user-facing source file claims email notifications/alerts anywhere', () => {
    const claimPatterns = [
      /emails? to managers/i,
      /email notifications?/i,
      /email alerts?/i,
      /notified by email/i,
      /notify .* via email/i,
      /send .* alerts? .* email/i,
    ];
    const offenders: string[] = [];
    for (const file of walkSrc(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const pattern of claimPatterns) {
        if (pattern.test(text)) offenders.push(`${path.relative(ROOT, file)} :: ${pattern}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

/* ================================================================== */
/*  D2 + D3 — HTTP behaviour on a real (PGlite) PostgreSQL             */
/* ================================================================== */

describe('Decisions 2+3 — peer lead visibility & roadshow creator/assist', () => {
  let pool: any;
  let app: express.Express;
  let deptId: string;

  //   admin (ADMIN — bypass)      ceo (CEO role, Organization)
  //                                  mgrA (MANAGER, DownTeam)
  //                                    subA1 (EMPLOYEE, Own)   subA2 (EMPLOYEE, Own, under subA1)
  //                                    inactA (EMPLOYEE, Own, INACTIVE, under mgrA)
  //                                  mgrB (MANAGER, DownTeam)
  //                                    subB1 (EMPLOYEE, Own)
  let admin: any, ceo: any, mgrA: any, mgrB: any, subA1: any, subA2: any, subB1: any, inactA: any;
  const roleIds: Record<string, string> = {};

  async function createUser(opts: {
    employeeId: string; roleCode: string; managerId?: string | null; isActive?: boolean;
  }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7) RETURNING id`,
      [opts.employeeId, `User ${opts.employeeId}`, `${opts.employeeId.toLowerCase()}@test.com`,
       roleIds[opts.roleCode], deptId, opts.managerId || null, opts.isActive !== false]
    );
    return { id: res.rows[0].id, employeeId: opts.employeeId, email: `${opts.employeeId.toLowerCase()}@test.com`, role: opts.roleCode };
  }

  async function createLead(mobile: string, assignedTo: string, status = 'New') {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, current_status)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [`lead_${mobile}`, `Lead ${mobile}`, mobile, assignedTo, status]
    );
  }

  const tokenFor = (user: any) => signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  const as = (user: any) => ({ Authorization: `Bearer ${tokenFor(user)}` });

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite.test/review-decisions';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);
    await migrateRoadshows();

    deptId = (await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    )).rows[0].id;

    for (const [code, level, vis] of [
      ['ADMIN', 99, 'Organization'],
      ['CEO', 1, 'Organization'],
      ['MANAGER', 50, 'DownTeam'],
      ['EMPLOYEE', 10, 'Own'],
    ] as const) {
      roleIds[code] = (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      )).rows[0].id;
    }

    const permCodes = [
      'roadshows.view', 'roadshows.create', 'roadshows.edit', 'roadshows.cancel', 'roadshows.report',
      'leads.view', 'leads.create', 'leads.edit', 'leads.assign',
    ];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      // Migration 042 already seeds the roadshows.* permission rows.
      await pool.query(
        `INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) ON CONFLICT (permission_code) DO NOTHING`,
        [code, code]
      );
      permIds[code] = (await pool.query(
        `SELECT id FROM permissions WHERE permission_code = $1`, [code]
      )).rows[0].id;
    }
    for (const roleCode of ['MANAGER', 'EMPLOYEE', 'CEO']) {
      for (const code of permCodes) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
          [roleIds[roleCode], permIds[code]]
        );
      }
    }

    admin = await createUser({ employeeId: 'ADMIN1', roleCode: 'ADMIN' });
    ceo = await createUser({ employeeId: 'CEO1', roleCode: 'CEO' });
    mgrA = await createUser({ employeeId: 'MGRA', roleCode: 'MANAGER', managerId: ceo.id });
    mgrB = await createUser({ employeeId: 'MGRB', roleCode: 'MANAGER', managerId: ceo.id });
    subA1 = await createUser({ employeeId: 'SUBA1', roleCode: 'EMPLOYEE', managerId: mgrA.id });
    subA2 = await createUser({ employeeId: 'SUBA2', roleCode: 'EMPLOYEE', managerId: subA1.id });
    subB1 = await createUser({ employeeId: 'SUBB1', roleCode: 'EMPLOYEE', managerId: mgrB.id });
    inactA = await createUser({ employeeId: 'INACTA', roleCode: 'EMPLOYEE', managerId: mgrA.id, isActive: false });

    await createLead('01710000001', subA1.id);
    await createLead('01710000002', subA1.id, 'Contacted');
    await createLead('01710000003', subA2.id);
    await createLead('01710000004', mgrA.id);
    await createLead('01710000005', subB1.id);
    await createLead('01710000006', subB1.id);
    await createLead('01710000007', subB1.id);
    await createLead('01710000008', inactA.id);

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM roadshow_assignees`);
    await pool.query(`DELETE FROM roadshows`);
    await pool.query(`DELETE FROM roadshow_code_counters`);
  });

  const rosterRow = (body: any[], employeeId: string) => body.find((u: any) => u.employeeId === employeeId);

  /* ---------------- D2: roster counts ---------------- */

  it('D2 roster: an Own-scope employee sees own count + their subtree (UM-1 floor); peers stay hidden', async () => {
    const res = await request(app).get('/api/users').set(as(subA1));
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    // The roster itself (names/structure) still arrives — pickers and the
    // org chart depend on it. Only the lead COUNTS are peer-hidden.
    assert.equal(rosterRow(res.body, 'SUBA1').openLeadCount, 2);
    // UM-1: SUBA2 reports to SUBA1, so SUBA1 is a team lead by tree and
    // their visibility floor (DownTeam over the subtree) legitimately
    // includes SUBA2's count — the same set their lead list shows.
    assert.equal(rosterRow(res.body, 'SUBA2').openLeadCount, 1);
    for (const other of ['MGRA', 'MGRB', 'SUBB1', 'CEO1', 'INACTA', 'ADMIN1']) {
      assert.equal(rosterRow(res.body, other).openLeadCount, null, `${other}'s count must be hidden from an Own-scope peer`);
    }
  });

  it('D2 roster: a DownTeam manager sees their downline counts — and NOT a sibling team', async () => {
    const res = await request(app).get('/api/users').set(as(mgrA));
    assert.equal(res.status, 200);
    assert.equal(rosterRow(res.body, 'MGRA').openLeadCount, 1);
    assert.equal(rosterRow(res.body, 'SUBA1').openLeadCount, 2);
    assert.equal(rosterRow(res.body, 'SUBA2').openLeadCount, 1);
    assert.equal(rosterRow(res.body, 'INACTA').openLeadCount, 1);
    assert.equal(rosterRow(res.body, 'MGRB').openLeadCount, null, 'sibling manager hidden');
    assert.equal(rosterRow(res.body, 'SUBB1').openLeadCount, null, 'sibling team member hidden');
    assert.equal(rosterRow(res.body, 'CEO1').openLeadCount, null, 'upline is outside DownTeam scope');
  });

  it('D2 roster: Organization (CEO) and ADMIN keep every count', async () => {
    for (const caller of [ceo, admin]) {
      const res = await request(app).get('/api/users').set(as(caller));
      assert.equal(res.status, 200);
      assert.equal(rosterRow(res.body, 'SUBA1').openLeadCount, 2);
      assert.equal(rosterRow(res.body, 'SUBB1').openLeadCount, 3);
      assert.equal(rosterRow(res.body, 'MGRB').openLeadCount, 0, 'in-scope person with no leads shows 0, not null');
    }
  });

  it('D2 user detail: another person\'s count follows the same scope rule', async () => {
    const peer = await request(app).get(`/api/users/${subB1.id}`).set(as(subA1));
    assert.equal(peer.status, 200);
    assert.equal(peer.body.openLeadCount, null);

    const own = await request(app).get(`/api/users/${subA1.id}`).set(as(subA1));
    assert.equal(own.body.openLeadCount, 2);

    const sibling = await request(app).get(`/api/users/${subB1.id}`).set(as(mgrA));
    assert.equal(sibling.body.openLeadCount, null);

    const downline = await request(app).get(`/api/users/${subA2.id}`).set(as(mgrA));
    assert.equal(downline.body.openLeadCount, 1);

    const org = await request(app).get(`/api/users/${subB1.id}`).set(as(ceo));
    assert.equal(org.body.openLeadCount, 3);
  });

  it('D2 hierarchy health: the stranded-owner list is scope-filtered per caller', async () => {
    const asMgrA = await request(app).get('/api/hierarchy-config').set(as(mgrA));
    assert.equal(asMgrA.status, 200, JSON.stringify(asMgrA.body).slice(0, 300));
    assert.deepEqual(
      asMgrA.body.ownership.inactiveOwnersWithOpenLeads.map((o: any) => [o.employeeId, o.openLeadCount]),
      [['INACTA', 1]],
      'the manager sees the stranded owner inside their downline'
    );

    const asSub = await request(app).get('/api/hierarchy-config').set(as(subA1));
    assert.deepEqual(asSub.body.ownership.inactiveOwnersWithOpenLeads, [], 'Own scope hides every other person');

    const asMgrB = await request(app).get('/api/hierarchy-config').set(as(mgrB));
    assert.deepEqual(asMgrB.body.ownership.inactiveOwnersWithOpenLeads, [], 'sibling manager sees none of team A');

    const asCeo = await request(app).get('/api/hierarchy-config').set(as(ceo));
    assert.deepEqual(
      asCeo.body.ownership.inactiveOwnersWithOpenLeads.map((o: any) => [o.employeeId, o.openLeadCount]),
      [['INACTA', 1]],
      'Organization scope keeps the full cleanup list'
    );
  });

  /* ---------------- D3: roadshow creator + assist ---------------- */

  const roadshowInput = (assignedUserIds: string[]) => ({
    organization: 'Bright Future',
    location: 'Dhaka',
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    assignedUserIds,
  });
  const assigneeIds = (row: any) => row.assignedUsers.map((u: any) => u.id).sort();

  it('D3 create: assigned set is exactly creator + assist picks — a non-picked teammate is NOT assigned', async () => {
    const created = await request(app).post('/api/roadshows').set(as(mgrA)).send(roadshowInput([subA1.id]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(assigneeIds(created.body.data), [mgrA.id, subA1.id].sort());

    const subA2Mine = await request(app).get('/api/roadshows?mine=true').set(as(subA2));
    assert.deepEqual(subA2Mine.body.data, [], 'the non-picked teammate has no roadshow in My Work');
    const subA1Mine = await request(app).get('/api/roadshows?mine=true').set(as(subA1));
    assert.deepEqual(subA1Mine.body.data.map((r: any) => r.id), [created.body.data.id]);
    const creatorMine = await request(app).get('/api/roadshows?mine=true').set(as(mgrA));
    assert.deepEqual(creatorMine.body.data.map((r: any) => r.id), [created.body.data.id], 'the creator is an assignee of their own roadshow');
  });

  it('D3 create: zero assist picks still assigns the creator alone', async () => {
    const created = await request(app).post('/api/roadshows').set(as(mgrA)).send(roadshowInput([]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(assigneeIds(created.body.data), [mgrA.id]);
  });

  it('D3 create: an inactive assist pick is rejected and nothing is created', async () => {
    const rejected = await request(app).post('/api/roadshows').set(as(mgrA)).send(roadshowInput([subA1.id, inactA.id]));
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.message, /INACTA.*inactive/i);
    const list = await request(app).get('/api/roadshows').set(as(mgrA));
    assert.deepEqual(list.body.data, [], 'the refused create left no roadshow behind');
  });

  it('D3 edit: assists can be replaced or cleared, the creator stays pinned', async () => {
    const created = await request(app).post('/api/roadshows').set(as(mgrA)).send(roadshowInput([subA1.id]));
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    const swapped = await request(app).put(`/api/roadshows/${id}`).set(as(mgrA)).send({ assignedUserIds: [subB1.id] });
    assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
    assert.deepEqual(assigneeIds(swapped.body.data), [mgrA.id, subB1.id].sort());

    const cleared = await request(app).put(`/api/roadshows/${id}`).set(as(mgrA)).send({ assignedUserIds: [] });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(assigneeIds(cleared.body.data), [mgrA.id], 'clearing assists leaves exactly the creator');

    const inactive = await request(app).put(`/api/roadshows/${id}`).set(as(mgrA)).send({ assignedUserIds: [inactA.id] });
    assert.equal(inactive.status, 400);
    assert.match(inactive.body.message, /inactive/i);
  });

  it('D3 scheduled activities: an explicit inactive assignee is rejected (PR #106 gap closed)', async () => {
    const leadRes: any = await pool.query(`SELECT id FROM leads WHERE lead_code = 'lead_01710000001'`);
    const leadId = leadRes.rows[0].id;
    const base = {
      leadId,
      activityType: 'call',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const rejected = await request(app).post('/api/scheduled-activities').set(as(mgrA)).send({ ...base, assignedTo: 'INACTA' });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.message, /INACTA.*inactive/i);

    const accepted = await request(app).post('/api/scheduled-activities').set(as(mgrA)).send({ ...base, assignedTo: 'SUBA1' });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  });
});
