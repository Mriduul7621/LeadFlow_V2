import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { isLeadAccessible } from '../routes/production/shared.js';

/**
 * Organogram Fix 2 — ONE lead-visibility predicate everywhere.
 * ------------------------------------------------------------------
 * The organogram review found a lead CREATED by someone in your team
 * but ASSIGNED to another team showed in your list and dashboard
 * counts, yet opening it returned "Lead not found": the SQL surfaces
 * (list / follow-up queue / dashboard / scheduled-activities list)
 * scope by (assignee ∈ visibility OR creator ∈ visibility), while
 * the row-level checker behind detail/mutation endpoints only
 * honoured the assignee chain (plus creator == caller exactly).
 *
 * These tests pin the unified rule on a real (PGlite) PostgreSQL:
 *   accessible ⇔ assignee ∈ caller visibility OR creator ∈ caller visibility
 * — list, counts, detail, quality, activities, scheduled activities,
 * notifications, follow-up, upsert, bulk and delete all agree, and a
 * lead in NEITHER chain stays invisible everywhere (404, no leak).
 */

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

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
      follow_up_count INT DEFAULT 0,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by UUID
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
      activity_type VARCHAR(30) NOT NULL DEFAULT 'call',
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL DEFAULT NOW(),
      duration_minutes INTEGER,
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
      priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
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
}

describe('Organogram Fix 2 — unified lead visibility (list = detail = counts)', () => {
  let pool: any;
  let app: express.Express;

  let deptSalesId: string;
  let managerRoleId: string;
  let employeeRoleId: string;
  const permIds: Record<string, string> = {};

  //   ceo (DownTeam, root)
  //     managerA (DownTeam)          <- the caller in most tests
  //       subA1 (Own)                <- creator of the cross-team lead
  //       subA2 (Own)
  //     managerB (DownTeam)          <- sibling team
  //       subB1 (Own)                <- assignee of the cross-team lead
  let ceo: any, managerA: any, managerB: any, subA1: any, subA2: any, subB1: any;

  async function createUser(opts: {
    employeeId: string;
    roleId: string;
    managerId?: string | null;
    role: string;
  }) {
    const res: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
      [opts.employeeId, `User ${opts.employeeId}`, `${opts.employeeId.toLowerCase()}@test.com`, opts.roleId, deptSalesId, opts.managerId || null]
    );
    return { id: res.rows[0].id, employeeId: opts.employeeId, email: `${opts.employeeId.toLowerCase()}@test.com`, role: opts.role };
  }

  async function createLead(opts: {
    mobile: string;
    name: string;
    assignedTo: string | null;
    createdBy: string;
    nextFollowUpAt?: string | null;
  }) {
    const leadCode = `lead_${opts.mobile}`;
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status, next_follow_up_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5, 'New', $6) RETURNING id`,
      [leadCode, opts.name, opts.mobile, opts.assignedTo, opts.createdBy, opts.nextFollowUpAt || null]
    );
    return { id: res.rows[0].id, code: leadCode, mobile: opts.mobile };
  }

  /** The shared fixture, rebuilt per test (beforeEach wipes leads). */
  async function seedFixture() {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    return {
      // THE review scenario: created by managerA's report, assigned OUT.
      cross: await createLead({ mobile: '01720000001', name: 'Cross Team Lead', assignedTo: subB1.id, createdBy: subA1.id, nextFollowUpAt: tomorrow }),
      // Control: assigned INTO managerA's team, created outside it.
      reverse: await createLead({ mobile: '01720000002', name: 'Reverse Cross Lead', assignedTo: subA1.id, createdBy: subB1.id }),
      // Neither chain: invisible to managerA everywhere.
      neither: await createLead({ mobile: '01720000003', name: 'Neither Chain Lead', assignedTo: managerB.id, createdBy: subB1.id, nextFollowUpAt: tomorrow }),
      // Creator chain only, unassigned.
      unassigned: await createLead({ mobile: '01720000004', name: 'Unassigned By Report', assignedTo: null, createdBy: subA2.id }),
      // Plain own-team lead.
      own: await createLead({ mobile: '01720000005', name: 'Own Team Lead', assignedTo: subA1.id, createdBy: subA1.id }),
    };
  }

  function tokenFor(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }
  const asMgrA = () => ({ Authorization: `Bearer ${tokenFor(managerA)}` });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    );
    deptSalesId = deptRes.rows[0].id;

    const mgrRole: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('MANAGER', 'Manager', 50, 'DownTeam') RETURNING id`
    );
    managerRoleId = mgrRole.rows[0].id;
    const empRole: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
    );
    employeeRoleId = empRole.rows[0].id;

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export'];
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [managerRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }

    ceo = await createUser({ employeeId: 'CEO1', roleId: managerRoleId, role: 'MANAGER' });
    managerA = await createUser({ employeeId: 'MGRA', roleId: managerRoleId, managerId: ceo.id, role: 'MANAGER' });
    managerB = await createUser({ employeeId: 'MGRB', roleId: managerRoleId, managerId: ceo.id, role: 'MANAGER' });
    subA1 = await createUser({ employeeId: 'SUBA1', roleId: employeeRoleId, managerId: managerA.id, role: 'EMPLOYEE' });
    subA2 = await createUser({ employeeId: 'SUBA2', roleId: employeeRoleId, managerId: subA1.id, role: 'EMPLOYEE' });
    subB1 = await createUser({ employeeId: 'SUBB1', roleId: employeeRoleId, managerId: managerB.id, role: 'EMPLOYEE' });

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
  });

  it('1. List: managerA sees creator-chain + assignee-chain leads, never neither-chain', async () => {
    const fx = await seedFixture();
    const res = await request(app).get('/api/leads').set(asMgrA());
    assert.equal(res.status, 200);
    const mobiles = (res.body as any[]).map((l: any) => l.mobile);
    assert.ok(mobiles.includes(fx.cross.mobile), 'creator-chain lead must be listed');
    assert.ok(mobiles.includes(fx.reverse.mobile), 'assignee-chain lead must be listed');
    assert.ok(mobiles.includes(fx.unassigned.mobile), 'unassigned creator-chain lead must be listed');
    assert.ok(mobiles.includes(fx.own.mobile));
    assert.ok(!mobiles.includes(fx.neither.mobile), 'neither-chain lead must NOT be listed');
  });

  it('2. Detail: every lead the list shows opens — the review scenario no longer 404s', async () => {
    const fx = await seedFixture();
    for (const lead of [fx.cross, fx.reverse, fx.unassigned, fx.own]) {
      const res = await request(app).get(`/api/leads/${lead.code}`).set(asMgrA());
      assert.equal(res.status, 200, `detail for ${lead.code} must open`);
    }
    const hidden = await request(app).get(`/api/leads/${fx.neither.code}`).set(asMgrA());
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.message, 'Lead not found.');
  });

  it('3. Quality, activities, scheduled-activities and notifications agree with detail', async () => {
    const fx = await seedFixture();
    const saRes: any = await pool.query(
      `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, created_by, assigned_to)
       VALUES ($1, 'call', 'Intro call', NOW(), $2, $3) RETURNING id`,
      [fx.cross.id, subA1.id, subB1.id]
    );
    const saId = saRes.rows[0].id;
    const saNeither: any = await pool.query(
      `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, created_by, assigned_to)
       VALUES ($1, 'call', 'Other team call', NOW(), $2, $3) RETURNING id`,
      [fx.neither.id, subB1.id, managerB.id]
    );

    for (const path of [
      `/api/leads/${fx.cross.code}/quality`,
      `/api/leads/${fx.cross.code}/activities`,
      `/api/leads/${fx.cross.code}/scheduled-activities`,
      `/api/notifications/leads/${fx.cross.code}`,
      `/api/scheduled-activities/${saId}`,
    ]) {
      const res = await request(app).get(path).set(asMgrA());
      assert.equal(res.status, 200, `${path} must be reachable for the creator-chain lead`);
    }
    for (const path of [
      `/api/leads/${fx.neither.code}/quality`,
      `/api/leads/${fx.neither.code}/activities`,
      `/api/leads/${fx.neither.code}/scheduled-activities`,
      `/api/notifications/leads/${fx.neither.code}`,
      `/api/scheduled-activities/${saNeither.rows[0].id}`,
    ]) {
      const res = await request(app).get(path).set(asMgrA());
      assert.equal(res.status, 404, `${path} must stay hidden for the neither-chain lead`);
    }
  });

  it('4. Dashboard counts include exactly the unified scope', async () => {
    await seedFixture();
    const res = await request(app).get('/api/dashboard').set(asMgrA());
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.equal(res.body.data.totalLeads, 4, 'cross + reverse + unassigned + own = 4; neither-chain excluded');
  });

  it('5. Follow-up queue counts include the creator-chain lead, exclude neither-chain', async () => {
    await seedFixture();
    const res = await request(app).get('/api/leads/follow-ups?bucket=all').set(asMgrA());
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    // Only cross + neither carry a next_follow_up_at; the unified scope
    // admits cross and excludes neither.
    assert.equal(res.body.data.counts.all, 1);
    const itemCodes = (res.body.data.items || []).map((i: any) => i.leadCode || i.lead_code);
    assert.ok(itemCodes.length === 1);
  });

  it('6. Follow-up write: allowed on creator-chain lead, rejected on neither-chain', async () => {
    const fx = await seedFixture();
    const ok = await request(app).post(`/api/leads/${fx.cross.code}/follow-up`).set(asMgrA()).send({ remarks: 'Manager called the prospect' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
    const denied = await request(app).post(`/api/leads/${fx.neither.code}/follow-up`).set(asMgrA()).send({ remarks: 'Should not land' });
    assert.equal(denied.status, 403);
    assert.match(denied.body.message, /do not have permission to update this lead/i);
  });

  it('7. Upsert update: creator-chain lead editable, neither-chain lead refused', async () => {
    const fx = await seedFixture();
    const ok = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: fx.cross.code, customerName: 'Cross Team Lead Renamed', mobile: '01720000001', _preserveAssignment: true,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
    const stored: any = await pool.query(`SELECT customer_name FROM leads WHERE id = $1`, [fx.cross.id]);
    assert.equal(stored.rows[0].customer_name, 'Cross Team Lead Renamed');

    const denied = await request(app).post('/api/leads').set(asMgrA()).send({
      leadCode: fx.neither.code, customerName: 'Hijack Attempt', mobile: '01720000003', _preserveAssignment: true,
    });
    assert.equal(denied.status, 403);
    assert.match(denied.body.message, /outside your authorized scope/i);
    const untouched: any = await pool.query(`SELECT customer_name FROM leads WHERE id = $1`, [fx.neither.id]);
    assert.equal(untouched.rows[0].customer_name, 'Neither Chain Lead');
  });

  it('8. Bulk import update: same guard — creator-chain row lands, neither-chain row rejected', async () => {
    const fx = await seedFixture();
    const rowFor = (mobile: string, name: string) => ({
      'Name': name, 'Phone': mobile, 'Source': 'Social media', 'Initial Status': 'No response',
    });
    const ok = await request(app).post('/api/leads/bulk').set(asMgrA()).send({ leads: [rowFor('01720000001', 'Cross Team Lead Bulk Renamed')] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
    assert.equal(ok.body.data.failed, 0, JSON.stringify(ok.body.data).slice(0, 300));
    const stored: any = await pool.query(`SELECT customer_name FROM leads WHERE id = $1`, [fx.cross.id]);
    assert.equal(stored.rows[0].customer_name, 'Cross Team Lead Bulk Renamed');

    const denied = await request(app).post('/api/leads/bulk').set(asMgrA()).send({ leads: [rowFor('01720000003', 'Neither Chain Bulk Hijack')] });
    assert.equal(denied.status, 200, JSON.stringify(denied.body).slice(0, 300));
    assert.equal(denied.body.data.failed, 1);
    const untouched: any = await pool.query(`SELECT customer_name FROM leads WHERE id = $1`, [fx.neither.id]);
    assert.equal(untouched.rows[0].customer_name, 'Neither Chain Lead');
  });

  it('9. Delete: creator-chain lead deletable by the manager, neither-chain refused', async () => {
    const fx = await seedFixture();
    const denied = await request(app).delete(`/api/leads/${fx.neither.code}`).set(asMgrA());
    assert.equal(denied.status, 403);
    assert.match(denied.body.message, /outside your authorized scope/i);

    const ok = await request(app).delete(`/api/leads/${fx.cross.code}`).set(asMgrA());
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
    const stored: any = await pool.query(`SELECT is_deleted FROM leads WHERE id = $1`, [fx.cross.id]);
    assert.equal(stored.rows[0].is_deleted, true);
  });

  it('10. Sibling manager symmetry: managerB cannot open the cross lead (creator AND assignee both outside B... assignee is B-side)', async () => {
    // managerB's scope contains subB1 (the assignee) — so managerB CAN
    // open the cross lead via the assignee chain; the neither-chain for
    // B is the reverse lead's mirror: create one more lead fully in A.
    const fx = await seedFixture();
    const asMgrB = { Authorization: `Bearer ${tokenFor(managerB)}` };
    const crossForB = await request(app).get(`/api/leads/${fx.cross.code}`).set(asMgrB);
    assert.equal(crossForB.status, 200, 'managerB reaches the cross lead via the assignee chain');
    const ownForB = await request(app).get(`/api/leads/${fx.own.code}`).set(asMgrB);
    assert.equal(ownForB.status, 404, 'a lead fully inside team A stays invisible to managerB');
    const unassignedForB = await request(app).get(`/api/leads/${fx.unassigned.code}`).set(asMgrB);
    assert.equal(unassignedForB.status, 404);
  });
});

describe('Organogram Fix 2 — isLeadAccessible unit pins (DB row shape)', () => {
  const caller: any = { id: 'mgr-1', employee_id: 'MGR001', role_code: 'MANAGER' };
  const visibility = { all: false, userIds: ['mgr-1', 'sub-1', 'sub-2'], employeeIds: ['MGR001', 'SUB001', 'SUB002'] };

  it('creator in scope, assignee out of scope -> accessible (the fix)', () => {
    assert.equal(isLeadAccessible({ assigned_to: 'other-9', created_by: 'sub-1', custom_fields: {} }, visibility, caller), true);
  });

  it('assignee in scope, creator out of scope -> accessible (unchanged)', () => {
    assert.equal(isLeadAccessible({ assigned_to: 'sub-2', created_by: 'other-9', custom_fields: {} }, visibility, caller), true);
  });

  it('neither chain -> inaccessible', () => {
    assert.equal(isLeadAccessible({ assigned_to: 'other-9', created_by: 'other-8', custom_fields: {} }, visibility, caller), false);
  });

  it('unassigned, creator in scope -> accessible (matches the SQL list)', () => {
    assert.equal(isLeadAccessible({ assigned_to: null, created_by: 'sub-1', custom_fields: {} }, visibility, caller), true);
  });

  it('unassigned, creator out of scope -> inaccessible', () => {
    assert.equal(isLeadAccessible({ assigned_to: null, created_by: 'other-9', custom_fields: {} }, visibility, caller), false);
  });

  it('a stale custom_fields owner never resurrects access on a DB row', () => {
    assert.equal(
      isLeadAccessible({ assigned_to: 'other-9', created_by: 'other-8', custom_fields: { assignedTo: 'SUB001' } }, visibility, caller),
      false
    );
  });
});
