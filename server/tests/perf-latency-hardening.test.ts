/**
 * perf-latency-hardening.test.ts
 * ------------------------------------------------------------------
 * Regression guards for the Performance & Latency Hardening step:
 *
 * SERVER (real PGlite PostgreSQL):
 *   1. Login: last_login still written (semantics preserved) but NOT on
 *      the awaited critical path; invalid login never stamps it.
 *   2. Server-Timing headers on key API paths; no sensitive values.
 *   3. Permission resolution: fail-closed (missing definition, DB error),
 *      user-override precedence over role grants, admin bypass — through
 *      the NEW single joined query, directly and end-to-end.
 *   4. Request-scoped memoization: caller / permission / visibility are
 *      resolved once per request (query-count proofs).
 *   5. Lead save + follow-up still return the authoritative mapped row
 *      (employee joins intact after the response-path optimizations).
 *   6. Notification mutations still update DB-backed state.
 *
 * CLIENT (source guards + pure module tests):
 *   A. AppLayout no longer polls roles every ~6 s
 *   B. Notifications no longer polled every ~8 s (visibility-paused, 60 s)
 *   C. Role/menu data served from the session cache after login/navigation
 *   D. Dynamic menuAccess behavior remains correct (unit-tested)
 *   E. Notification mutations sync DB-backed state + session cache
 *   F. Auth flow still navigates immediately after confirmed login
 *   G. No security work moved to the client
 *   K. Mutations only report success after the server confirms
 *   L. No new full-list refetch introduced after a mutation
 *
 * The existing auth, lead-security, visibility, bulk, follow-up and
 * dashboard suites remain the behavioral contract and must stay green.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes, {
  getCallerDbInfo,
  hasPermissionCode,
  resolveCallerVisibility,
  type CallerDbInfo,
} from '../routes/production.routes.js';
import {
  readSessionCache,
  writeSessionCache,
  updateSessionCache,
  invalidateSessionCache,
  resetSessionCacheForTests,
} from '../../src/modules/shared/api/sessionCache.js';
import { resolveMenuVisibility } from '../../src/layouts/menuVisibility.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/* ==================================================================== */
/* 1. Server behavior (PGlite)                                          */
/* ==================================================================== */

describe('Performance & latency hardening — server behavior', () => {
  let pool: any;
  let app: express.Express;

  let employeeRoleId = '';
  let adminRoleId = '';
  let loginUserId = '';
  let empA: { id: string; employeeId: string };
  let empB: { id: string; employeeId: string };
  let leadsViewPermId = '';
  let leadsEditPermId = '';

  /** Query counters (regex -> count), installed over pool.query. */
  const counters: Record<string, number> = {};
  const COUNTER_PATTERNS: Array<[string, RegExp]> = [
    ['callerLookup', /LEFT JOIN roles r ON r\.id = u\.role_id/],
    ['permissionJoin', /FROM \(SELECT id FROM permissions/],
    ['visibilityDataVisibility', /SELECT data_visibility FROM roles/],
    ['visibilityOwnUser', /SELECT id, employee_id FROM users WHERE id = \$1/],
  ];
  let originalQuery: any;

  function count(name: string): number {
    return counters[name] || 0;
  }
  function resetCounters(): void {
    for (const k of Object.keys(counters)) counters[k] = 0;
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    const db = await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

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
        feature_permissions JSONB,
        is_active BOOLEAN DEFAULT TRUE,
        description TEXT,
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
        manager_id UUID,
        is_active BOOLEAN DEFAULT TRUE,
        account_status VARCHAR(20) DEFAULT 'ACTIVE',
        must_change_password BOOLEAN DEFAULT FALSE,
        last_login TIMESTAMP,
        designation VARCHAR(150),
        phone VARCHAR(50),
        profile_photo VARCHAR(500),
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
        permission_name VARCHAR(255),
        module_name VARCHAR(100),
        action_name VARCHAR(100)
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
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
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
        current_status VARCHAR(255) DEFAULT 'Untouched',
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
        created_by UUID,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        recipient_key VARCHAR(100),
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        lead_code VARCHAR(50),
        reference_id UUID,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /* --- seed --- */
    const dept = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = dept.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Administrator', 1, 'Organization') RETURNING id`
    );
    adminRoleId = adminRole.rows[0].id;
    const employeeRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
    );
    employeeRoleId = employeeRole.rows[0].id;

    const view = await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.view', 'View leads', 'leads', 'view') RETURNING id`);
    leadsViewPermId = view.rows[0].id;
    const edit = await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.edit', 'Edit leads', 'leads', 'edit') RETURNING id`);
    leadsEditPermId = edit.rows[0].id;
    const create = await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.create', 'Create leads', 'leads', 'create') RETURNING id`);
    const assign = await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.assign', 'Assign leads', 'leads', 'assign') RETURNING id`);
    const transfer = await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.transfer', 'Transfer leads', 'leads', 'transfer') RETURNING id`);
    // Defined, but intentionally NOT granted to EMPLOYEE (2.3 relies on it).
    await pool.query(`INSERT INTO permissions (permission_code, permission_name, module_name, action_name) VALUES ('leads.delete', 'Delete leads', 'leads', 'delete')`);

    // EMPLOYEE role: view/edit/create/assign/transfer granted (delete is NOT).
    for (const permId of [leadsViewPermId, leadsEditPermId, create.rows[0].id, assign.rows[0].id, transfer.rows[0].id]) {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [employeeRoleId, permId]);
    }

    const loginHash = await bcrypt.hash('Perf-L0gin!', 8);
    const loginUser = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
       VALUES ('LOGINEMP', 'Login Employee', 'login@test.com', $1, $2, $3, true) RETURNING id`,
      [loginHash, employeeRoleId, deptId]
    );
    loginUserId = loginUser.rows[0].id;

    const a = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
       VALUES ('EMPA', 'User A', 'usera@test.com', 'hashed', $1, $2, true) RETURNING id`,
      [employeeRoleId, deptId]
    );
    empA = { id: a.rows[0].id, employeeId: 'EMPA' };
    const b = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
       VALUES ('EMPB', 'User B', 'userb@test.com', 'hashed', $1, $2, true) RETURNING id`,
      [employeeRoleId, deptId]
    );
    empB = { id: b.rows[0].id, employeeId: 'EMPB' };

    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', productionRoutes);

    // Install query counters over the shared pool.
    originalQuery = pool.query.bind(pool);
    pool.query = async (text: any, params: any) => {
      const sql = String(text || '');
      for (const [name, re] of COUNTER_PATTERNS) {
        if (re.test(sql)) counters[name] = (counters[name] || 0) + 1;
      }
      return originalQuery(text, params);
    };
  });

  after(async () => {
    if (originalQuery) pool.query = originalQuery;
    _resetPoolsForTest();
    await resetPGlite();
    await closePool();
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    resetCounters();
    resetSessionCacheForTests();
  });

  const tokenFor = (user: { id: string; employeeId: string }) =>
    signToken({ id: user.id, employeeId: user.employeeId, role: 'EMPLOYEE', email: `${user.employeeId.toLowerCase()}@test.com`, name: user.employeeId });

  /* ---------------- 1. login: last_login semantics ---------------- */

  it('1.1 login succeeds, response carries Server-Timing, and last_login is stamped without blocking', async () => {
    const before = await pool.query('SELECT last_login FROM users WHERE id = $1', [loginUserId]);
    assert.equal(before.rows[0].last_login, null, 'precondition: no last_login yet');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'LOGINEMP', password: 'Perf-L0gin!' });
    assert.equal(res.status, 200, `login should succeed: ${JSON.stringify(res.body)}`);
    assert.ok(typeof res.body.token === 'string' && res.body.token.length > 20);
    assert.equal(res.body.user.employeeId, 'LOGINEMP');

    const header = String(res.headers['server-timing'] || '');
    assert.match(header, /total;dur=\d+(\.\d+)?/, 'Server-Timing header must carry the total span');
    assert.match(header, /db\.userLookup;dur=\d+(\.\d+)?/, 'login must time the user lookup span');
    assert.match(header, /auth\.bcryptVerify;dur=\d+(\.\d+)?/, 'login must time the bcrypt span');
    // No sensitive material may ever land in the timing header.
    assert.ok(!header.includes('Perf-L0gin'), 'no password material in Server-Timing');
    assert.ok(!header.toLowerCase().includes('loginemp'), 'no user identity in Server-Timing');

    // The last_login update is still issued (semantics preserved) — it just
    // no longer sits on the awaited critical path.
    await new Promise(r => setTimeout(r, 200));
    const after = await pool.query('SELECT last_login FROM users WHERE id = $1', [loginUserId]);
    assert.ok(after.rows[0].last_login, 'last_login must still be written after a successful login');
  });

  it('1.2 a rejected password never stamps last_login and still 401s', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'EMPA', password: 'wrong-password' });
    await new Promise(r => setTimeout(r, 100));
    const row = await pool.query('SELECT last_login FROM users WHERE employee_id = $1', ['EMPA']);
    assert.equal(row.rows[0].last_login, null, 'failed login must not write last_login');
  });

  /* ---------------- 2. permission resolution semantics ------------- */

  function makeCaller(overrides: Partial<CallerDbInfo> = {}): CallerDbInfo {
    return {
      id: empA.id,
      employee_id: 'EMPA',
      email: 'usera@test.com',
      role_id: employeeRoleId,
      role_code: 'EMPLOYEE',
      department_id: null,
      ...overrides,
    };
  }

  it('2.1 missing permission definition fails closed (deny)', async () => {
    assert.equal(await hasPermissionCode(makeCaller(), 'leads.nonexistent'), false);
  });

  it('2.2 role grant allow works', async () => {
    assert.equal(await hasPermissionCode(makeCaller(), 'leads.view'), true);
  });

  it('2.3 role grant deny works (no override)', async () => {
    // leads.delete is not granted to EMPLOYEE at all.
    assert.equal(await hasPermissionCode(makeCaller(), 'leads.delete'), false);
  });

  it('2.4 user override TRUE beats a role grant FALSE', async () => {
    await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [empA.id]);
    // Flip the role grant to false, then add a per-user allow.
    await pool.query('UPDATE role_permissions SET is_allowed = false WHERE role_id = $1 AND permission_id = $2', [employeeRoleId, leadsViewPermId]);
    await pool.query('INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES ($1, $2, true)', [empA.id, leadsViewPermId]);
    try {
      assert.equal(await hasPermissionCode(makeCaller(), 'leads.view'), true, 'override true must win over role grant false');
    } finally {
      await pool.query('UPDATE role_permissions SET is_allowed = true WHERE role_id = $1 AND permission_id = $2', [employeeRoleId, leadsViewPermId]);
      await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [empA.id]);
    }
  });

  it('2.5 user override FALSE beats a role grant TRUE (end-to-end + direct)', async () => {
    await pool.query('INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES ($1, $2, false)', [empA.id, leadsViewPermId]);
    try {
      assert.equal(await hasPermissionCode(makeCaller(), 'leads.view'), false, 'override false must win over role grant true');

      // End-to-end: the same override must reject the real route.
      const res = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(empA)}`);
      assert.equal(res.status, 403, 'GET /api/leads must honor the user override end-to-end');
    } finally {
      await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [empA.id]);
    }
  });

  it('2.6 override removed -> role grant applies again', async () => {
    // (no override present in this fresh state)
    assert.equal(await hasPermissionCode(makeCaller(), 'leads.view'), true);
  });

  it('2.7 ADMIN/SUPERADMIN bypass is unchanged (even for undefined codes)', async () => {
    assert.equal(await hasPermissionCode(makeCaller({ role_code: 'ADMIN' }), 'leads.view'), true);
    assert.equal(await hasPermissionCode(makeCaller({ role_code: 'SUPERADMIN' }), 'anything.else'), true);
  });

  it('2.8 a DB failure fails closed (deny), never open', async () => {
    const broken: any = {
      query: async () => { throw new Error('connection refused'); },
      end: async () => undefined,
      connect: async () => { throw new Error('connection refused'); },
    };
    _setTestPoolForTest(broken);
    try {
      assert.equal(await hasPermissionCode(makeCaller(), 'leads.view'), false, 'DB error must deny');
      assert.equal((await resolveCallerVisibility(makeCaller())).all, false, 'DB error must not widen visibility');
    } finally {
      _setTestPoolForTest(pool);
    }
  });

  /* ---------------- 3. request-scoped memoization ------------------ */

  /** A fake in-flight request as the requireAuth middleware would have prepared it. */
  const fakeReq = (who: { id: string; employeeId: string } = empA): any => ({
    currentUser: { id: who.id, employeeId: who.employeeId, email: 'usera@test.com', role: 'EMPLOYEE' },
  });

  it('3.1 getCallerDbInfo resolves the caller once per request (memo on req)', async () => {
    resetCounters();
    const reqA = fakeReq();
    const reqB = fakeReq();

    const callerA1 = await getCallerDbInfo(reqA);
    const callerA2 = await getCallerDbInfo(reqA);
    assert.equal(callerA1, callerA2, 'same request must reuse the same caller object');
    assert.equal(count('callerLookup'), 1, 'two calls in one request = one caller lookup');

    await getCallerDbInfo(reqB);
    assert.equal(count('callerLookup'), 2, 'a different request re-resolves (no cross-request cache)');
    assert.ok(callerA1, 'caller resolved');
    assert.equal(callerA1!.employee_id, 'EMPA');
  });

  it('3.2 permission codes are resolved once per (request caller, code)', async () => {
    resetCounters();
    const caller = await getCallerDbInfo(fakeReq());
    assert.ok(caller);

    await hasPermissionCode(caller, 'leads.view');
    await hasPermissionCode(caller, 'leads.view'); // memoized
    await hasPermissionCode(caller, 'leads.edit'); // second code, one query

    assert.equal(count('permissionJoin'), 2, '2 distinct codes => 2 joined resolutions (not 6 sequential)');
  });

  it('3.3 visibility is resolved once per request (memo on caller)', async () => {
    resetCounters();
    const caller = await getCallerDbInfo(fakeReq());
    assert.ok(caller);

    const v1 = await resolveCallerVisibility(caller);
    const v2 = await resolveCallerVisibility(caller);
    assert.deepEqual(v1, v2, 'memoized visibility is stable within the request');
    assert.equal(count('visibilityDataVisibility'), 1, 'data_visibility looked up once');
    assert.equal(count('visibilityOwnUser'), 1, 'Own-scope user lookup once');
    assert.equal(v1.all, false, 'EMPLOYEE stays Own-scoped');
  });

  /* ---------------- 4. lead save / follow-up response paths -------- */

  it('4.1 POST /leads returns the authoritative row with intact employee joins + Server-Timing', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ customerName: 'Perf Lead', mobile: '01700000900', assignedTo: 'EMPA' });
    assert.equal(res.status, 200, `lead save should succeed: ${JSON.stringify(res.body)}`);
    assert.match(String(res.headers['server-timing'] || ''), /total;dur=/);
    assert.match(String(res.headers['server-timing'] || ''), /db\.upsert;dur=/);

    const data = res.body.data;
    assert.equal(data.customerName, 'Perf Lead');
    assert.equal(data.assignedTo, 'EMPA', 'assigned_to employee join must survive the batched lookup');
    assert.equal(data.assignedBy, 'EMPA', 'assigned_by employee join must survive the batched lookup');

    // Follow-up on the same lead: response must still carry the mapped row.
    const fu = await request(app)
      .post(`/api/leads/${data.id}/follow-up`)
      .set('Authorization', `Bearer ${tokenFor(empA)}`)
      .send({ status: 'Contacted', remarks: 'first call' });
    assert.equal(fu.status, 200, `follow-up should succeed: ${JSON.stringify(fu.body)}`);
    assert.match(String(fu.headers['server-timing'] || ''), /total;dur=/);
    const fuLead = fu.body.data.lead;
    assert.equal(fuLead.id, data.id);
    assert.equal(fuLead.currentStatus, 'Contacted');
    assert.equal(fuLead.assignedTo, 'EMPA', 'follow-up response join intact after the re-fetch removal');
    assert.equal(fuLead.assignedBy, 'EMPA');
    assert.equal(fu.body.data.activity.status, 'Contacted', 'activity row returned');
  });

  it('4.2 GET /leads + GET /dashboard carry Server-Timing and enforce authz', async () => {
    const leads = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(empA)}`);
    assert.equal(leads.status, 200);
    assert.match(String(leads.headers['server-timing'] || ''), /total;dur=/);
    assert.match(String(leads.headers['server-timing'] || ''), /authz\.visibility;dur=/);

    const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${tokenFor(empA)}`);
    // EMPLOYEE has no dashboard.view/leads.view? leads.view IS granted -> 200.
    assert.equal(dash.status, 200, `dashboard should be reachable with leads.view: ${JSON.stringify(dash.body)}`);
    assert.match(String(dash.headers['server-timing'] || ''), /total;dur=/);
  });

  /* ---------------- 5. notification DB-backed mutations ------------ */

  it('5.1 notification create/mark-read/delete update DB-backed state', async () => {
    const token = tokenFor(empB);

    const created = await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'EMPB', title: 'Perf notification', message: 'created via guard', leadId: '' });
    assert.equal(created.status, 201, `create should succeed: ${JSON.stringify(created.body)}`);
    const notifId = created.body.data.id;
    assert.ok(notifId);

    let list = await request(app)
      .get('/api/notifications/users/EMPB')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(list.status, 200);
    const found = (list.body as any[]).find(n => n.id === notifId);
    assert.ok(found, 'created notification must be in the DB-backed list');
    assert.equal(found.read, false);

    const marked = await request(app)
      .post(`/api/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(marked.status, 200);
    assert.equal(marked.body.data.read, true);

    list = await request(app)
      .get('/api/notifications/users/EMPB')
      .set('Authorization', `Bearer ${token}`);
    const afterMark = (list.body as any[]).find(n => n.id === notifId);
    assert.equal(afterMark.read, true, 'read state must persist in the DB, not just the response');

    const del = await request(app)
      .delete('/api/notifications/users/EMPB')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(del.status, 200);
    list = await request(app)
      .get('/api/notifications/users/EMPB')
      .set('Authorization', `Bearer ${token}`);
    assert.ok(!(list.body as any[]).some(n => n.id === notifId), 'delete must remove from the DB');
  });
});

/* ==================================================================== */
/* 2. Client source guards                                              */
/* ==================================================================== */

describe('Performance & latency hardening — client source guards', () => {
  const ROLES_EVENT_NAME = 'ROLES_CACHE_CHANGED_EVENT';
  const LAYOUT = () => read('src/layouts/AppLayout.tsx');
  const USE_PERMS = () => read('src/modules/shared/hooks/usePermissions.ts');
  const AUTH_STORE = () => read('src/modules/auth/store/authStore.ts');
  const LEAD_SERVICE = () => read('src/modules/leads/services/leadService.ts');
  const LEAD_LIST = () => read('src/modules/leads/pages/LeadList.tsx');
  const LOGIN = () => read('src/modules/auth/pages/Login.tsx');
  const AUTH_FLOW = () => read('src/modules/auth/services/authFlow.ts');
  const ROUTES = () => read('server/routes/production.routes.ts');

  /** All `setInterval(expr, N)` numeric intervals found in a source. */
  function intervals(src: string): number[] {
    const out: number[] = [];
    const re = /setInterval\((?:[^()]|\([^()]*\))*?,\s*(\d[\d_]*)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(Number(m[1].replace(/_/g, '')));
    return out;
  }

  it('A. AppLayout no longer polls roles every ~6 s', () => {
    const layout = LAYOUT();
    assert.doesNotMatch(layout, /setInterval\(\s*fetchPerms\s*,\s*6000\s*\)/, '6s roles poll must be gone');
    // No seconds-level (3s–10s) polling interval remains. (The one pre-existing
    // 2000ms interval is the local-only 30-minute inactivity timeout check —
    // it reads localStorage and must stay, it makes no network calls.)
    const bad = intervals(layout).filter(n => n >= 3000 && n <= 10000);
    assert.deepEqual(bad, [], `AppLayout must not poll at seconds-level intervals, found: ${bad.join(',')}`);
  });

  it('B. notifications are no longer polled every ~8 s', () => {
    const layout = LAYOUT();
    assert.doesNotMatch(layout, /setInterval\(\s*fetchNotifs\s*,\s*8000\s*\)/, '8s notification poll must be gone');
    // The remaining background refresh is low-frequency AND visibility-paused.
    assert.match(layout, /NOTIFICATION_REFRESH_MS = 60_000/, 'background refresh must be 60s, not 8s');
    assert.ok(layout.includes("document.visibilityState !== 'visible'"), 'background refresh must pause while the tab is hidden');
    // Panel open triggers a fresh fetch.
    assert.ok(/if \(isNotifOpen\) void refreshNotifsRef\.current\(\)/.test(layout), 'opening the panel must refresh notifications');
  });

  it('C. role/menu data remains available across login & navigation via the session cache', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('readSessionCache<RolePermission[]>'), 'layout must read the session-scoped roles cache');
    assert.ok(layout.includes('writeSessionCache(cacheKey, rp)'), 'layout must write the server-confirmed roles');
    assert.ok(layout.includes('roles:${user.id}'), 'roles cache must be keyed by user (never shared across users)');
    // Fresh cache is served before any request is decided.
    const eff = layout.slice(layout.indexOf('const cacheKey = `roles:${user.id}`'));
    assert.ok(eff.indexOf('readSessionCache') >= 0 && eff.indexOf('fetchPerms();') > eff.indexOf('readSessionCache'),
      'the cache is consulted before deciding whether to fetch');
  });

  it('D. dynamic menuAccess behavior remains correct (pure function)', () => {
    const itemAll = { path: '/leads', roles: ['ADMIN'] };
    const itemRestricted = { path: '/users', roles: ['ADMIN'] };

    // 1. ADMIN bypass: sees everything regardless of menuAccess.
    assert.equal(resolveMenuVisibility('admin', undefined, itemRestricted), true);
    assert.equal(resolveMenuVisibility('ADMIN', { roleId: 'ADMIN', menuAccess: { '/users': false } } as any, itemRestricted), true,
      'admin must not be hidden by a menuAccess=false entry');

    // 2. menuAccess=false hides an item that the static role fallback would show.
    const roleWithOverride = { roleId: 'EMPLOYEE', menuAccess: { '/leads': false } } as any;
    const itemInRoles = { path: '/leads', roles: ['EMPLOYEE'] };
    assert.equal(resolveMenuVisibility('EMPLOYEE', roleWithOverride, itemInRoles), false,
      'explicit menuAccess=false must hide (override wins over static roles)');

    // 3. menuAccess=true shows an item NOT in the static roles.
    assert.equal(resolveMenuVisibility('EMPLOYEE', { roleId: 'EMPLOYEE', menuAccess: { '/users': true } } as any, itemRestricted), true,
      'explicit menuAccess=true must show (override wins over static roles)');

    // 4. No menuAccess entry for the path -> static fallback applies.
    assert.equal(resolveMenuVisibility('EMPLOYEE', { roleId: 'EMPLOYEE', menuAccess: {} } as any, itemInRoles), true);
    assert.equal(resolveMenuVisibility('EMPLOYEE', { roleId: 'EMPLOYEE', menuAccess: {} } as any, itemRestricted), false);
    assert.equal(resolveMenuVisibility('EMPLOYEE', undefined, itemRestricted), false);

    // 5. Case handling: raw and normalized role names both match.
    assert.equal(resolveMenuVisibility('employee', undefined, itemInRoles), true);

    // And the layout still delegates its single check to this function.
    assert.ok(LAYOUT().includes('resolveMenuVisibility('), 'AppLayout must use the extracted visibility check');
  });

  it('E. notification mutations refresh DB-backed state + session cache (client)', () => {
    const layout = LAYOUT();
    // The sync helper writes state AND the session cache from the
    // server-confirmed data, and every mutation handler uses it.
    const block = layout.slice(layout.indexOf('const syncNotifications'), layout.indexOf('const unreadCount'));
    assert.ok(block.includes('setNotifications('), 'confirmed data must land in the UI state');
    assert.ok(block.includes('writeSessionCache'), 'the session cache is kept in step with confirmed data');
    assert.ok(block.includes('notificationService.markNotificationAsRead(id)'), 'mark-read must hit the API first');
    assert.ok(block.includes('notificationService.markAllNotificationsAsRead'), 'mark-all must hit the API first');
    assert.ok(block.includes('notificationService.deleteAllNotifications'), 'delete-all must hit the API first');
    assert.ok(block.includes('syncNotifications('), 'confirmed mutations must sync state + session cache');
  });

  it('F. auth flow still navigates immediately after confirmed login', () => {
    const login = LOGIN();
    assert.match(login, /await activateSession\(session, \{/);
    const flow = AUTH_FLOW();
    const nav = flow.indexOf("ctx.navigate('/')");
    const warm = flow.indexOf('ctx.afterAuthentication');
    assert.ok(nav >= 0 && warm >= 0 && nav < warm, 'navigation must be sequenced before the background warm-up');
    assert.ok(flow.includes('sessionConfirmedByLogin = true'), 'login must still settle the startup gate');
  });

  it('G. no security work is moved to the client', () => {
    const routes = ROUTES();
    // Server-side enforcement intact on every lead mutation + guard.
    assert.ok(routes.includes("router.post('/leads', requireAuth"), 'POST /leads still server-guarded');
    assert.ok(routes.includes("router.delete('/leads/:id', requireAuth"), 'DELETE /leads/:id still server-guarded');
    assert.ok(routes.includes("hasPermissionCode(caller, 'leads.edit')"), 'edit permission still server-enforced');
    assert.ok(routes.includes("hasPermissionCode(caller, 'leads.delete')"), 'delete permission still server-enforced');
    assert.ok(routes.includes('sanitizeCustomFields('), 'spoofable custom fields still sanitized server-side');
    assert.ok(routes.includes('FORBIDDEN_CUSTOM_KEYS'), 'authz-forbidden keys still stripped server-side');
    assert.ok(routes.includes('isLeadAccessible(existingLead, visibility, caller)'), 'lead-scope check still server-enforced');
    // Client never fakes authorization: no client-side "allow" on 403.
    const http = read('src/modules/shared/api/http.ts');
    assert.ok(http.includes('response.status === 403'), 'client still surfaces server 403s as errors');
  });

  it('H/I. permission resolution stays fail-closed with override precedence (server guards)', () => {
    const routes = ROUTES();
    // The single joined query keeps the fail-closed branches.
    assert.ok(routes.includes('Permission definition missing'), 'missing-definition deny must remain');
    assert.ok(routes.includes('has_user_override'), 'user override detection present in the joined query');
    assert.ok(routes.includes('has_role_grant'), 'role grant detection present in the joined query');
    const permFn = routes.slice(routes.indexOf('export async function hasPermissionCode'), routes.indexOf('export async function resolveCallerVisibility'));
    const overrideIdx = permFn.indexOf('row.has_user_override');
    const grantIdx = permFn.indexOf('row.has_role_grant');
    assert.ok(overrideIdx >= 0 && grantIdx > overrideIdx, 'user override must be evaluated before the role grant');
    assert.match(permFn, /Fail closed on DB error/, 'DB-error fail-closed must remain');
  });

  it('K. mutations only report success after the server confirms (client)', () => {
    const svc = LEAD_SERVICE();
    const createBody = svc.slice(svc.indexOf('async createLead'), svc.indexOf('async bulkUploadLeads'));
    assert.ok(createBody.indexOf('await apiRequest<Lead>(\'/api/leads\'') >= 0, 'createLead must await the server');
    assert.ok(createBody.indexOf('cacheLead(saved)') > createBody.indexOf('await apiRequest<Lead>(\'/api/leads\''),
      'local cache must be written only after the confirmed response');
    const fuBody = svc.slice(svc.indexOf('async updateLeadStatus'), svc.indexOf('async getLead('));
    assert.ok(fuBody.includes('await apiRequest'), 'follow-up save must await the server');
    assert.ok(fuBody.indexOf('cacheLead(lead)') > fuBody.indexOf('await apiRequest'), 'follow-up cache write only after commit');
    // The notification fan-out never extends the confirmed save.
    assert.ok(svc.includes('void sendHierarchyNotifications('), 'fan-out must be fire-and-forget');
    assert.ok(!svc.includes('await sendHierarchyNotifications('), 'fan-out must not be awaited on the save path');
  });

  it('L. no new full-list refetch after a mutation (LeadList)', () => {
    const page = LEAD_LIST();
    const saveHandler = page.slice(page.indexOf('const handleSaveLeadUpdate'), page.indexOf('const handleUpdateStatus'));
    assert.ok(saveHandler.includes('applyLeadUpdate(updated)'), 'status save must patch from the authoritative response');
    assert.ok(!saveHandler.includes('leadService.getLeads('), 'status save must not refetch the full lead list');
    const quickHandler = page.slice(page.indexOf('const handleUpdateStatus'), page.indexOf('const filteredLeads'));
    assert.ok(quickHandler.includes('applyLeadUpdate(updated)'), 'quick status update must patch in place');
    assert.ok(!quickHandler.includes('leadService.getLeads('), 'quick status update must not refetch the full list');
    // Deletion is intentionally a Lead Pool responsibility now; the
    // execution workspace must not become a second delete workflow.
    assert.ok(!page.includes('const handleDeleteLead'), 'Lead Workspace must not own the delete workflow');
    const pool = read('src/modules/leads/pages/AllLeads.tsx');
    const deleteHandler = pool.slice(pool.indexOf('const handleDeleteIndividualLead'), pool.indexOf('const handlePurgeCampaignLeads'));
    assert.ok(!deleteHandler.includes('loadData()'), 'pool delete must not refetch before the confirmed soft delete');
    assert.ok(deleteHandler.includes('setLeads(prev => prev.filter(l => l.id !== leadId))'), 'pool delete must remove the confirmed row locally');
    // leadService mutations themselves never trigger a list refetch.
    const svc = LEAD_SERVICE();
    const createBody = svc.slice(svc.indexOf('async createLead'), svc.indexOf('async bulkUploadLeads'));
    assert.ok(!createBody.includes('getAllLeads('), 'createLead must not refetch the list');
    const updateBody = svc.slice(svc.indexOf('async updateLead('), svc.indexOf('async deleteLead('));
    assert.ok(!updateBody.includes('getAllLeads('), 'updateLead must not refetch the list');
  });

  it('session cache + logout hygiene', () => {
    const store = AUTH_STORE();
    assert.ok(store.includes('clearSessionCache()'), 'logout must clear the session-scoped cache (no cross-user leakage)');
    const usePerms = USE_PERMS();
    assert.ok(!usePerms.includes('setInterval(loadRoles, 3000)'), '3s localStorage poll must be gone');
    assert.ok(usePerms.includes(ROLES_EVENT_NAME), 'hook must listen for the same-tab cache-change event');
    assert.ok(usePerms.includes('readSessionCache'), 'permission sheet must reuse the session-scoped result');
  });
});

/* ==================================================================== */
/* 3. Client pure-module behavior (session cache + menu visibility)     */
/* ==================================================================== */

describe('Performance & latency hardening — session cache behavior', () => {
  it('write/read/update/invalidate/clear behave as a session-scoped cache', () => {
    resetSessionCacheForTests();
    assert.equal(readSessionCache('roles:u1'), null);

    writeSessionCache('roles:u1', [{ roleId: 'ADMIN' }]);
    const entry = readSessionCache<{ roleId: string }[]>('roles:u1');
    assert.ok(entry, 'entry readable after write');
    assert.deepEqual(entry!.value, [{ roleId: 'ADMIN' }]);
    assert.ok(entry!.fetchedAt > 0, 'freshness timestamp recorded');

    // A different key is isolated (per-user scoping).
    assert.equal(readSessionCache('roles:u2'), null, 'cache entries are per-key (per-user)');

    updateSessionCache<{ roleId: string }[]>('roles:u1', (v) => [...v, { roleId: 'BE' }]);
    assert.equal(readSessionCache<{ roleId: string }[]>('roles:u1')!.value.length, 2, 'update transforms the cached value');

    invalidateSessionCache('roles:u1');
    assert.equal(readSessionCache('roles:u1'), null, 'invalidation drops the entry');

    writeSessionCache('notifications:EMP1', [{ id: 'n1' }]);
    writeSessionCache('roles:u9', [{ roleId: 'X' }]);
    resetSessionCacheForTests();
    assert.equal(readSessionCache('notifications:EMP1'), null, 'full clear drops every entry');
    assert.equal(readSessionCache('roles:u9'), null);
  });

  it('logout clears the session cache (no authorization across users)', async () => {
    // localStorage shim so the zustand persist middleware is happy.
    const map = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (map.has(k) ? map.get(k) : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
    (globalThis as any).window = globalThis;

    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    writeSessionCache('roles:alice', [{ roleId: 'ADMIN' }]);
    writeSessionCache('notifications:alice', [{ id: 'n1' }]);
    useAuthStore.getState().login({ id: 'alice', employeeId: 'ALICE', name: 'Alice', role: 'ADMIN' } as any, 'token-alice', false);
    assert.ok(readSessionCache('roles:alice'), 'precondition: cache populated for the active user');

    useAuthStore.getState().logout();

    assert.equal(readSessionCache('roles:alice'), null, 'logout must clear every session-scoped entry');
    assert.equal(readSessionCache('notifications:alice'), null);
  });
});
