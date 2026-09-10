import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import http from 'node:http';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrateLeadActivities } from '../database/migrations/037_lead_activities.js';

process.env.TZ = 'UTC';

/**
 * STEP 4A (client half) — the REAL browser services are driven against the
 * REAL mounted router over real HTTP + real PostgreSQL (PGlite).
 *
 * Nothing here mocks the API layer, because the point is the client's wire
 * behaviour and its cache discipline:
 *
 *   T  getLead() uses GET /api/leads/:id and no longer fetches the whole
 *      /api/leads list
 *   Q  updateLeadStatus() sends only the follow-up business fields - never
 *      statusHistory/assignmentHistory, never an actor, never a client
 *      timestamp as audit data
 *   U  a database failure can never look like a local write success: the
 *      call rejects and the localStorage cache is left untouched
 *   +  the cache is only written after the server reports the commit, and
 *      the activity stream is read from the authoritative endpoint
 */

const JWT_SECRET = 'leadflow-follow-up-client-test-secret';

function createStorageShim() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

type Recorded = { method: string; path: string; body: any };

describe('Lead follow-up activity - real client services against real PostgreSQL', () => {
  let pool: any;
  let server: http.Server;
  let baseUrl = '';
  let token = '';
  let recorded: Recorded[] = [];
  const realFetch = globalThis.fetch;

  let leadService: typeof import('../../src/modules/leads/services/leadService').leadService;
  let localDb: typeof import('../../src/services/localDb').localDb;

  let userAId = '';
  let empAId = '';

  async function seedBase() {
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
      CREATE TABLE IF NOT EXISTS options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_key VARCHAR(100) NOT NULL,
        option_value VARCHAR(255) NOT NULL,
        option_label VARCHAR(255) NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT uq_field_option_client UNIQUE(field_key, option_value)
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
        deleted_by UUID
      );
    `);
    // The production migration creates the activity table (same as prod).
    await migrateLeadActivities();

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') ON CONFLICT DO NOTHING RETURNING id`);
    const deptId = (deptRes.rows[0] as any).id;
    const roleRes: any = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') ON CONFLICT (role_code) DO UPDATE SET data_visibility = 'Own' RETURNING id`
    );
    const employeeRoleId = (roleRes.rows[0] as any).id;
    for (const code of ['leads.view', 'leads.create', 'leads.edit', 'leads.import']) {
      await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [code]);
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
         VALUES ($1, (SELECT id FROM permissions WHERE permission_code = $2), TRUE) ON CONFLICT DO NOTHING`,
        [employeeRoleId, code]
      );
    }
    const hash = await bcrypt.hash('pass-123', 10);
    const userRes: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
       VALUES ('EMPA', 'User A', 'usera@test.com', $1, $2, $3, true)
       ON CONFLICT (employee_id) DO UPDATE SET is_active = TRUE RETURNING id`,
      [hash, employeeRoleId, deptId]
    );
    userAId = (userRes.rows[0] as any).id;
    empAId = 'EMPA';

    const statuses = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, TRUE) ON CONFLICT DO NOTHING`,
        [statuses[i], i + 1]
      );
    }
  }

  /** Insert a lead the way the hardened bulk import leaves it: current-state
   *  snapshot, empty history, no activity rows. */
  async function seedLead(leadCode: string, mobile: string) {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by,
                          custom_fields, status_history, assignment_history)
       VALUES ($1, 'Client Lead', $2, 'Untouched', $3, $3,
               '{"assignedTo":"EMPA","productName":"SCEP","collectedNCP":0}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [leadCode, mobile, userAId]
    );
  }

  async function leadRow(leadCode: string) {
    const res: any = await pool.query(`SELECT * FROM leads WHERE lead_code = $1`, [leadCode]);
    return res.rows[0] || null;
  }
  async function activityCount(leadCode: string) {
    const res: any = await pool.query(
      `SELECT COUNT(*)::int AS c FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE l.lead_code = $1`,
      [leadCode]
    );
    return (res.rows[0] as any).c as number;
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await seedBase();

    const router = (await import('../routes/production.routes.js')).default;
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', router);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as any;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Browser-ish globals for the real client modules.
    (globalThis as any).localStorage = createStorageShim();
    (globalThis as any).window = globalThis;

    token = jwt.sign({ id: userAId, employeeId: empAId, role: 'EMPLOYEE', email: 'usera@test.com' }, JWT_SECRET, { expiresIn: '1h' });

    // A fetch shim that (a) resolves the app's relative /api urls against the
    // test server and (b) records exactly what the client put on the wire.
    const base = baseUrl;
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      const absolute = url.startsWith('http') ? url : base + url;
      const path = absolute.replace(base, '');
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null;
      recorded.push({ method: String(init.method || 'GET').toUpperCase(), path, body });
      return realFetch(absolute, init);
    }) as typeof fetch;

    const { installAuthenticatedFetch } = await import('../../src/lib/apiClient');
    installAuthenticatedFetch();
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore');
    useAuthStore.getState().login(
      { id: userAId, employeeId: empAId, name: 'User A', fullName: 'User A', email: 'usera@test.com', role: 'EMPLOYEE', status: 'Active', createdDate: new Date().toISOString() } as any,
      token
    );

    ({ leadService } = await import('../../src/modules/leads/services/leadService'));
    ({ localDb } = await import('../../src/services/localDb'));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    recorded = [];
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
    (globalThis as any).localStorage.clear();
  });

  const calls = (method: string, matcher: (path: string) => boolean) =>
    recorded.filter(r => r.method === method && matcher(r.path));

  it('T. getLead() uses GET /api/leads/:id - the full /api/leads list is never fetched', async () => {
    await seedLead('fu_get_1', '01700000201');

    const lead = await leadService.getLead('fu_get_1');
    assert.ok(lead, 'the lead is returned');
    assert.equal(lead!.id, 'fu_get_1');
    assert.equal(lead!.prospectName, 'Client Lead');

    assert.equal(
      calls('GET', p => p === '/api/leads/fu_get_1').length,
      1,
      'exactly one direct single-lead request'
    );
    assert.equal(
      calls('GET', p => p === '/api/leads' || p.startsWith('/api/leads?')).length,
      0,
      'the client must never fetch the whole lead list to find one lead'
    );
    // and the successful read also refreshes the offline cache
    assert.equal(localDb.getLead('fu_get_1')?.currentStatus, 'Untouched');
  });

  it('T2. getLead() maps a server 404 to null without resurrecting the cached copy', async () => {
    await seedLead('fu_get_2', '01700000202');
    await leadService.getLead('fu_get_2'); // populate the cache
    assert.ok(localDb.getLead('fu_get_2'));

    await pool.query(`UPDATE leads SET is_deleted = TRUE, deleted_at = NOW() WHERE lead_code = 'fu_get_2'`);
    const gone = await leadService.getLead('fu_get_2');
    assert.equal(gone, null, 'a lead the server no longer returns is not fabricated from cache');
  });

  it('Q. updateLeadStatus() sends only business fields - no history arrays, actor or client timestamp', async () => {
    await seedLead('fu_post_1', '01700000203');

    const saved = await leadService.updateLeadStatus(
      'fu_post_1',
      'Follow-up Set',
      12000,
      'Spoke to the customer, meeting next week',
      '2026-09-25',
      'User A (EMPA)', // the legacy "updatedBy" argument - must NOT be sent
      '2026-09-22',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Online Meeting'
    );
    assert.ok(saved);
    assert.equal(saved!.currentStatus, 'Follow-up Set');

    const posts = calls('POST', p => p === '/api/leads/fu_post_1/follow-up');
    assert.equal(posts.length, 1, 'the dedicated follow-up endpoint is called exactly once');
    assert.ok(!calls('POST', p => p === '/api/leads').length, 'the whole-lead POST round-trip is gone');

    const body = posts[0].body;
    assert.deepEqual(Object.keys(body).sort(), [
      'collectedNCP', 'meetingType', 'nextCallDate', 'nextFollowUpDate', 'remarks', 'status',
    ]);
    assert.equal(body.status, 'Follow-up Set');
    assert.equal(body.remarks, 'Spoke to the customer, meeting next week');
    for (const forbidden of [
      'statusHistory', 'assignmentHistory', 'updatedBy', 'changedBy', 'createdBy', 'actor',
      'date', 'timestamp',
    ]) {
      assert.ok(!(forbidden in body), `the client must never send ${forbidden}`);
    }

    // Server derived everything the client used to author.
    const row = await leadRow('fu_post_1');
    assert.equal(row.current_status, 'Follow-up Set');
    assert.equal(row.expected_premium, null, 'unrelated current state preserved');
    assert.equal(new Date(row.next_follow_up_at).toISOString().slice(0, 10), '2026-09-25');
    assert.equal(row.status_history.length, 1, 'the legacy JSONB history got exactly one server-authored entry');
    const entry = row.status_history[0];
    assert.equal(entry.updatedBy, empAId, 'actor is the session user, not the client string');
    assert.equal(entry.remarks, 'Spoke to the customer, meeting next week');
    assert.ok(entry.activityId, 'mirrored entry is correlated with the activity row');
    assert.equal(await activityCount('fu_post_1'), 1);

    // Cache updated only from the server response.
    assert.equal(localDb.getLead('fu_post_1')?.currentStatus, 'Follow-up Set');
    assert.equal(localDb.getLead('fu_post_1')?.nextFollowUpDate?.slice(0, 10), '2026-09-25');
  });

  it('Q2. updateLead() (profile edit) never round-trips the authoritative history arrays', async () => {
    await seedLead('fu_put_1', '01700000204');
    await leadService.updateLeadStatus('fu_put_1', 'Contacted', undefined, 'first touch');
    const before = await leadRow('fu_put_1');
    assert.equal(before.status_history.length, 1);

    recorded = [];
    await leadService.updateLead('fu_put_1', { area: 'Dhanmondi' } as any, 'User A');
    const posts = calls('POST', p => p === '/api/leads');
    assert.equal(posts.length, 1);
    for (const forbidden of ['statusHistory', 'assignmentHistory', 'updatedBy', 'createdBy', 'timestamp']) {
      assert.ok(!(forbidden in posts[0].body), `profile edits must not send ${forbidden}`);
    }
    assert.equal(posts[0].body.area, 'Dhanmondi');

    const after = await leadRow('fu_put_1');
    assert.equal(after.status_history.length, 1, 'history survived the profile edit');
    assert.equal(after.status_history[0].remarks, 'first touch');
  });

  it('R. the activity stream is read from GET /api/leads/:id/activities', async () => {
    await seedLead('fu_act_1', '01700000205');
    await leadService.updateLeadStatus('fu_act_1', 'Contacted', undefined, 'one');
    await leadService.updateLeadStatus('fu_act_1', 'Interested', undefined, 'two');

    recorded = [];
    const activities = await leadService.getLeadActivities('fu_act_1');
    assert.equal(calls('GET', p => p === '/api/leads/fu_act_1/activities').length, 1);
    assert.equal(calls('GET', p => p === '/api/leads' || p.startsWith('/api/leads?')).length, 0);

    assert.equal(activities.length, 2);
    assert.equal(activities[0].status, 'Interested', 'newest first');
    assert.equal(activities[0].remarks, 'two');
    assert.equal(activities[0].updatedByEmployeeId, empAId);
    assert.equal(activities[0].updatedBy, 'User A (EMPA)', 'server-derived actor, display ready');
    assert.ok(activities.every(a => a.activityType === 'status_update'));
    assert.ok(!('statusHistory' in (activities[0] as any)));
  });

  it('R2. a legacy imported lead has an EMPTY activity stream (no fabricated history)', async () => {
    await seedLead('fu_act_2', '01700000206');
    const activities = await leadService.getLeadActivities('fu_act_2');
    assert.deepEqual(activities, [], 'nothing is invented for the imported snapshot');
    assert.equal(await activityCount('fu_act_2'), 0);

    // ...and its first LeadFlow activity then lands as exactly one row.
    await leadService.updateLeadStatus('fu_act_2', 'Meeting Fixed', undefined, 'first real activity');
    const after = await leadService.getLeadActivities('fu_act_2');
    assert.equal(after.length, 1);
    assert.equal(after[0].status, 'Meeting Fixed');
  });

  it('U. a database failure never becomes a local write success', async () => {
    await seedLead('fu_fail_1', '01700000207');
    await leadService.getLead('fu_fail_1'); // warm the cache deliberately

    const cacheBefore = JSON.stringify(localDb.getLead('fu_fail_1'));
    const rowBefore = await leadRow('fu_fail_1');

    await pool.query(
      `ALTER TABLE lead_activities ADD CONSTRAINT test_fail_activity_insert_client CHECK (remarks IS DISTINCT FROM 'FORCE_DB_FAILURE')`
    );
    let threw: any = null;
    try {
      await leadService.updateLeadStatus('fu_fail_1', 'Converted', 999999, 'FORCE_DB_FAILURE');
    } catch (error) {
      threw = error;
    } finally {
      await pool.query(`ALTER TABLE lead_activities DROP CONSTRAINT IF EXISTS test_fail_activity_insert_client`);
    }

    assert.ok(threw, 'the client must reject - never resolve - when PostgreSQL rolled back');
    assert.equal((threw as any).status, 500);
    assert.equal(JSON.stringify(localDb.getLead('fu_fail_1')), cacheBefore, 'the localStorage cache is untouched by a failed write');

    const rowAfter = await leadRow('fu_fail_1');
    assert.equal(rowAfter.current_status, rowBefore.current_status, 'nothing was committed either');
    assert.equal(JSON.stringify(rowAfter.status_history), '[]');
    assert.equal(await activityCount('fu_fail_1'), 0);

    // Recovery: the same call succeeds once the database is healthy again.
    const ok = await leadService.updateLeadStatus('fu_fail_1', 'Contacted', undefined, 'retry after outage');
    assert.equal(ok!.currentStatus, 'Contacted');
    assert.equal(await activityCount('fu_fail_1'), 1);
    assert.equal(localDb.getLead('fu_fail_1')?.currentStatus, 'Contacted');
  });

  it('U2. a rejected status (400) surfaces the server reason and writes nothing', async () => {
    await seedLead('fu_fail_2', '01700000208');
    await leadService.getLead('fu_fail_2');
    const cacheBefore = JSON.stringify(localDb.getLead('fu_fail_2'));

    await assert.rejects(
      () => leadService.updateLeadStatus('fu_fail_2', 'Totally Made Up Status' as any),
      (error: any) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Unknown status/);
        return true;
      }
    );
    assert.equal(JSON.stringify(localDb.getLead('fu_fail_2')), cacheBefore);
    assert.equal((await leadRow('fu_fail_2')).current_status, 'Untouched');
    assert.equal(await activityCount('fu_fail_2'), 0);
  });

  it('U3. a lost connection is a rejection, never an offline success', async () => {
    await seedLead('fu_fail_3', '01700000209');
    await leadService.getLead('fu_fail_3');
    const cacheBefore = JSON.stringify(localDb.getLead('fu_fail_3'));

    const workingFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => leadService.updateLeadStatus('fu_fail_3', 'Converted', 5, 'offline attempt'),
        /Unable to reach the server/
      );
      assert.equal(JSON.stringify(localDb.getLead('fu_fail_3')), cacheBefore, 'no local write was reported as success');
      assert.equal((await leadRow('fu_fail_3')).current_status, 'Untouched');
      assert.equal(await activityCount('fu_fail_3'), 0);

      // Reads may serve the cache, but must not be presented as fresh writes.
      const cached = await leadService.getLead('fu_fail_3');
      assert.ok(cached);
      assert.equal(cached!.currentStatus, 'Untouched');
    } finally {
      globalThis.fetch = workingFetch;
    }
  });
});
