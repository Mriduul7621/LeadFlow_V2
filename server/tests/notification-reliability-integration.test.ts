/**
 * notification-reliability-integration.test.ts
 * ------------------------------------------------------------------
 * Behavioral proof for "reliability: move business notifications to
 * server-side idempotent delivery" (docs/NOTIFICATION_RELIABILITY.md).
 *
 * Covered guarantees:
 *   1.  lead assignment creates the assignee notification SERVER-SIDE
 *   2.  reassignment/transfer creates correct notifications server-side
 *   3.  the client does NOT need to POST /api/notifications after an
 *       assignment (the business route is the sole producer)
 *   4.  retrying the same assignment/business event does not duplicate
 *   5.  DB uniqueness (event_key partial unique index) rejects duplicate
 *       inserts; manual NULL keys are unrestricted
 *   6.  unauthorized callers cannot trigger notifications through the
 *       business route (403 before any side effect)
 *   7.  Data Visibility remains enforced on the notifying route
 *   8.  notification insert failure follows the documented ATOMIC
 *       semantics: the whole transaction rolls back (business-critical
 *       transactional notification)
 *   9.  failed attempt + retry: exactly one notification per recipient,
 *       no partial assignment/history state survives
 *   10. generic POST /notifications is NOT an arbitrary cross-user
 *       bypass (guards from PR #40 remain)
 *   11. self-directed generic notification remains self-service
 *   12. lead-scoped notification history still requires leads.view +
 *       actual lead visibility
 *   13. out-of-scope lead notification history remains 404 (no existence
 *       leak)
 *   14. upline recipients are resolved SERVER-SIDE from users.manager_id
 *       (client-supplied recipient lists are ignored)
 *   15. recipient traversal dedupes users
 *   16. hierarchy cycles cannot loop forever (bounded traversal)
 *   17. inactive managers stop the fan-out (preserved client semantics);
 *       inactive upline users are not notified
 *   18. scheduled-activity path is audited as out-of-scope (no invented
 *       notifications)
 *   19. follow-up scheduling is audited as out-of-scope (no invented
 *       notifications)
 *   20. Pipeline Locked / Converted moves behave exactly as before
 *   21. no client fire-and-forget system-notification path remains for
 *       migrated events (source guard across the whole client tree)
 *   22. notification local cache writes stay inside the user-scoped
 *       localDb helper (source guard; behavioral suite lives in
 *       local-cache-cross-user-isolation.test.ts)
 *   +   migration 040 runs on the legacy notifications shape, is
 *       idempotent, keeps old rows readable, and adds no NOT NULL
 *       constraints on existing data.
 *
 * Real PostgreSQL semantics are exercised in-process via PGlite, exactly
 * like the rbac-* / lead-* suites.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const REPO_ROOT = path.resolve(process.cwd());

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Notification reliability — server-side idempotent business delivery', () => {
  let pool: any;
  let app: express.Express;

  // --- identities (ids/keys resolved in before()) ---
  const ids: Record<string, string> = {};
  let leadOneId = '';     // lead created under FAE1 (shared fixture)
  let leadOneCode = '';

  /**
   * Tokens are signed per employee key; authorization is resolved from the
   * DATABASE role of the user (exactly like requireAuth + getCallerDbInfo do),
   * so the embedded `role` claim is cosmetic here.
   */
  const tokFor = (emp: string) =>
    signToken({ id: ids[emp], employeeId: emp, role: 'X', email: `${emp.toLowerCase()}@test.com`, name: emp });
  const opsT = () => tokFor('OPS1');
  const trfT = () => tokFor('TRF1');
  const ownT = () => tokFor('OWNEDIT');
  const faeT = () => tokFor('FAE1');

  let permIds: Record<string, string> = {};
  let roleIds: Record<string, string> = {};

  async function mkUser(emp: string, full: string, roleCode: string, managerId: string | null, deptId: string | null, isActive = true) {
    const r = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active, account_status)
       VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, $8)
       RETURNING id`,
      [emp, full, `${emp.toLowerCase()}@test.com`, roleIds[roleCode], deptId, managerId, isActive, isActive ? 'ACTIVE' : 'INACTIVE']
    );
    ids[emp] = r.rows[0].id;
    return r.rows[0].id;
  }

  let leadCounter = 0;
  function nextLeadCode() {
    leadCounter += 1;
    return `lead_nr_${String(leadCounter).padStart(4, '0')}`;
  }

  async function notificationsFor(empKey: string): Promise<any[]> {
    const res = await pool.query(
      `SELECT n.*, u.employee_id AS user_employee_id
       FROM notifications n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.recipient_key = $1 OR u.employee_id = $1
       ORDER BY n.created_at`,
      [empKey]
    );
    return res.rows;
  }

  async function notificationsForLead(leadCode: string): Promise<any[]> {
    const res = await pool.query(
      `SELECT n.*, u.employee_id AS user_employee_id
       FROM notifications n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.lead_code = $1 ORDER BY n.created_at`,
      [leadCode]
    );
    return res.rows;
  }

  async function createLeadViaApi(token: string, assignedTo: string, opts?: { leadCode?: string; prospect?: string }) {
    const leadCode = opts?.leadCode || nextLeadCode();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${token}`)
      .send({ leadCode, customerName: opts?.prospect || `Rel Prospect ${leadCode}`, mobile: `017${leadCounter.toString().padStart(8, '0')}`, assignedTo });
    return { res, leadCode };
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const appMod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', appMod.default);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(30) UNIQUE,
        department_name VARCHAR(150),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
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
        password VARCHAR(255) NOT NULL DEFAULT '',
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        designation VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        account_status VARCHAR(30) DEFAULT 'ACTIVE',
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
        module_name VARCHAR(100) NOT NULL,
        action_name VARCHAR(30) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
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
        lead_id UUID,
        activity_type VARCHAR(50),
        status VARCHAR(50),
        remarks TEXT,
        next_follow_up_at TIMESTAMP,
        next_call_at TIMESTAMP,
        meeting_at TIMESTAMP,
        meeting_type VARCHAR(100),
        collected_ncp NUMERIC(14,2),
        projected_ncp NUMERIC(14,2),
        sum_assured NUMERIC(14,2),
        product_name VARCHAR(255),
        loss_reason VARCHAR(255),
        created_by UUID,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID,
        activity_type VARCHAR(50),
        title VARCHAR(255),
        scheduled_at TIMESTAMP,
        duration_minutes INT,
        remarks TEXT,
        status VARCHAR(30) DEFAULT 'scheduled',
        priority VARCHAR(20) DEFAULT 'NORMAL',
        meeting_type VARCHAR(100),
        location VARCHAR(255),
        created_by UUID,
        assigned_to UUID,
        updated_by UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
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
    // LEGACY notifications shape (pre-040): NO event_key / event_type.
    // Migration 040 runs below and must add them backward-compatibly.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        recipient_key VARCHAR(100),
        lead_code VARCHAR(50),
        reference_id UUID,
        title VARCHAR(255),
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        type VARCHAR(30) DEFAULT 'info',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        read_at TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id UUID,
        target_user_id UUID,
        action_code VARCHAR(100),
        entity_type VARCHAR(50),
        entity_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ---- migration under test: run twice (idempotent replay) ----
    const { up: migrate040 } = await import('../database/migrations/040_notification_idempotency.js');
    await migrate040();
    await migrate040();
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notifications' AND column_name IN ('event_key','event_type')`
    );
    assert.equal(cols.rows.length, 2, '040 (idempotent replay) must add event_key + event_type');
    const idx: any = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_notifications_event_key'`
    );
    assert.ok(idx.rows[0], '040 must create the unique partial event_key index');
    assert.match(String(idx.rows[0].indexdef), /UNIQUE/i);
    assert.match(String(idx.rows[0].indexdef), /event_key IS NOT NULL/i);

    // ---- permissions catalog + roles ----
    const permDefs: Array<[string, string, string]> = [
      ['leads.view', 'Leads', 'VIEW'],
      ['leads.create', 'Leads', 'CREATE'],
      ['leads.edit', 'Leads', 'EDIT'],
      ['leads.assign', 'Leads', 'ASSIGN'],
      ['leads.transfer', 'Leads', 'TRANSFER'],
      ['leads.import', 'Leads', 'IMPORT'],
      ['leads.delete', 'Leads', 'DELETE'],
      ['users.view', 'Users', 'VIEW'],
    ];
    for (const [code, mod, act] of permDefs) {
      const r = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1,$2,$3)
         ON CONFLICT (permission_code) DO UPDATE SET module_name = EXCLUDED.module_name, action_name = EXCLUDED.action_name
         RETURNING id`,
        [code, mod, act]
      );
      permIds[code] = r.rows[0].id;
    }
    const mkRole = async (code: string, vis: string, grants: string[]) => {
      const r = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active)
         VALUES ($1, $2, 99, $3, TRUE) RETURNING id`,
        [code, `Role ${code}`, vis]
      );
      const rid = r.rows[0].id;
      roleIds[code] = rid;
      for (const g of grants) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1,$2,TRUE) ON CONFLICT DO NOTHING`,
          [rid, permIds[g]]
        );
      }
      return rid;
    };
    await mkRole('ADMIN', 'Organization', []);
    await mkRole('OPS', 'Organization', ['leads.view', 'leads.create', 'leads.edit', 'leads.assign', 'leads.transfer', 'leads.import']);
    await mkRole('TRFONLY', 'Organization', ['leads.view', 'leads.edit', 'leads.transfer']);
    await mkRole('STAFF', 'Own', ['leads.view', 'leads.edit']);
    await mkRole('VIEWX', 'Own', ['leads.view']);
    await mkRole('OWNASSIGN', 'Own', ['leads.view', 'leads.create', 'leads.edit', 'leads.assign']);
    await mkRole('NONE', 'Own', []);

    const dept = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('SALES','Sales') RETURNING id`);
    const deptId = dept.rows[0].id;

    // Reporting tree:  CEO1 ← MGR1 ← FAE1;  CEO1 ← INACT(inactive) ← FAE2;
    //                 MGR1 ← FAE3;  CYCA <-> CYCB cycle; SELF1 → SELF1.
    await mkUser('ADMINX', 'Admin X', 'ADMIN', null, deptId);
    const ceo = await mkUser('CEO1', 'Ceo One', 'STAFF', null, deptId);
    const mgr = await mkUser('MGR1', 'Mgr One', 'STAFF', ceo, deptId);
    await mkUser('FAE1', 'Fae One', 'STAFF', mgr, deptId);
    await mkUser('FAE3', 'Fae Three', 'STAFF', mgr, deptId);
    const inact = await mkUser('INACT', 'Inact Manager', 'STAFF', ceo, deptId, false);
    await mkUser('FAE2', 'Fae Two', 'STAFF', inact, deptId);
    const cycB = await mkUser('CYCB', 'Cyc Bee', 'STAFF', null, deptId);
    const cycA = await mkUser('CYCA', 'Cyc Aye', 'STAFF', cycB, deptId);
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [cycA, cycB]); // cycle closed
    await mkUser('OPS1', 'Ops One', 'OPS', null, deptId);
    await mkUser('TRF1', 'Trf One', 'TRFONLY', null, deptId);
    await mkUser('VIEWX', 'View X', 'VIEWX', null, deptId);
    const ownEdit = await mkUser('OWNEDIT', 'Own Edit', 'OWNASSIGN', null, deptId);
    // TWO-PARTY cycle: OWNEDIT <-> SELF1 (SELF1's only role grant is none).
    const self1 = await mkUser('SELF1', 'Self Loop', 'NONE', ownEdit, deptId);
    await pool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [self1, ownEdit]);
    // A user with NO permission grants at all (for the leads.view 403 case).
    await mkUser('NGR1', 'No Grants', 'NONE', null, deptId);

    // A shared fixture lead assigned to FAE1 (created directly in DB).
    leadOneCode = nextLeadCode();
    const lead = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, 'Shared Prospect', '01700000001', $2, $2, $2, $2, 'Untouched') RETURNING id`,
      [leadOneCode, ids.FAE1]
    );
    leadOneId = lead.rows[0].id;

    // Canonical status dictionary for follow-up validation.
    for (const s of ['Untouched', 'Contacted', 'Interested', 'Pipeline Locked', 'Converted', 'Lost']) {
      await pool.query(`INSERT INTO options (field_key, option_value, option_label) VALUES ('FollowUpStatus', $1, $1) ON CONFLICT DO NOTHING`, [s]);
    }
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
  });

  /* ================================================================== */
  /* 1-3. SERVER-SIDE OWNERSHIP                                         */
  /* ================================================================== */

  it('1. lead assignment via POST /api/leads creates the assignee notification server-side (no client POST /notifications involved)', async () => {
    const { res, leadCode } = await createLeadViaApi(opsT(), 'FAE1');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await notificationsFor('FAE1');
    const mine = rows.filter(r => r.lead_code === leadCode);
    assert.equal(mine.length, 1, 'assignee must have exactly one notification for the event');
    assert.equal(mine[0].title, 'New Lead Assigned');
    assert.equal(mine[0].message, `Lead 'Rel Prospect ${leadCode}' has been assigned to you by Ops One.`);
    assert.equal(mine[0].event_type, 'lead-assigned', 'event_type stamped by the server');
    assert.ok(mine[0].event_key, 'system rows carry a stable idempotency key');
    // The create event had an empty assignment history, so its event sequence
    // is 0 — deterministic and re-derived identically on any retry.
    assert.equal(String(mine[0].event_key), `lead-assigned:${leadCode}:0:FAE1`);
    assert.equal(mine[0].is_read, false);
  });

  it('2. upline fan-out is resolved server-side from users.manager_id with preserved wording and per-hop names', async () => {
    const { res, leadCode } = await createLeadViaApi(opsT(), 'FAE1');
    assert.equal(res.status, 200);
    const mgrRows = (await notificationsFor('MGR1')).filter(r => r.lead_code === leadCode);
    const ceoRows = (await notificationsFor('CEO1')).filter(r => r.lead_code === leadCode);
    assert.equal(mgrRows.length, 1);
    assert.equal(ceoRows.length, 1);
    assert.equal(mgrRows[0].title, 'Team Lead Assigned Upline Alert');
    assert.equal(mgrRows[0].message, `Lead 'Rel Prospect ${leadCode}' under your team tracking has been routed to assignee: FAE1 (Fae One) by Ops One.`);
    // CEO1 sits above MGR1: the per-hop subordinate name is MGR1 — exactly the
    // message semantics of the removed client loop.
    assert.equal(ceoRows[0].message, `Lead 'Rel Prospect ${leadCode}' under your team tracking has been routed to assignee: FAE1 (Mgr One) by Ops One.`);
  });

  it('3. reassignment creates notifications for the NEW chain only; unassignment never notifies (current behavior preserved)', async () => {
    const leadCode = nextLeadCode();
    const created = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
      .send({ leadCode, customerName: 'Rel Reassign Target', mobile: '01711110001', assignedTo: 'FAE1' });
    assert.equal(created.status, 200);

    // Reassign FAE1 -> FAE3 (transfer-capable actor). Both users share MGR1 as
    // their manager, but this is ONE new event — MGR1 must not be notified
    // twice for it and FAE1's original notification must remain untouched.
    const re = await request(app).post('/api/leads').set('Authorization', `Bearer ${trfT()}`)
      .send({ leadCode, id: created.body.data.id, customerName: 'Rel Reassign Target', mobile: '01711110001', assignedTo: 'FAE3' });
    assert.equal(re.status, 200, JSON.stringify(re.body));

    const beforeRows = await notificationsForLead(leadCode);
    const fae1Initial = beforeRows.filter(r => r.recipient_key === 'FAE1');
    const fae3Rows = beforeRows.filter(r => r.recipient_key === 'FAE3');
    assert.equal(fae1Initial.length, 1, 'original assignee keeps exactly their one create notification');
    assert.equal(fae3Rows.length, 1, 'new assignee is notified exactly once');
    assert.ok(String(fae3Rows[0].event_key).endsWith(':FAE3'), 'keyed per recipient');

    const rows = await notificationsForLead(leadCode);
    const seqs = new Set(rows.map(r => String(r.event_key).split(':')[2]));
    assert.equal(seqs.size, 2, 'create event and reassignment event carry distinct sequence numbers');

    // Unassignment: allowed by the API, intentionally silent (matches the
    // pre-migration client rule `if (fields.assignedTo && ...)`).
    const before = (await notificationsForLead(leadCode)).length;
    const un = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
      .send({ leadCode, id: re.body.data.id, customerName: 'Rel Reassign Target', mobile: '01711110001', assignedTo: '' });
    assert.equal(un.status, 200);
    const after = await notificationsForLead(leadCode);
    assert.equal(after.length, before, 'unassignment does not invent a notification');
  });

  it('4. retrying the same assignment business event does not duplicate (committed event replays as a no-op)', async () => {
    const { res, leadCode } = await createLeadViaApi(opsT(), 'FAE1');
    assert.equal(res.status, 200);
    const first = await notificationsForLead(leadCode);

    // Same business event replayed (simulates a client retrying the exact
    // request after a lost response): the lead is already assigned to FAE1,
    // so NO assignment change is detected server-side and NOTHING is created.
    const retry = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
      .send({ leadCode, customerName: `Rel Prospect ${leadCode}`, mobile: '017' + leadCode.replace(/\D/g, '').padStart(8, '0').slice(-8), assignedTo: 'FAE1' });
    assert.equal(retry.status, 200);
    const second = await notificationsForLead(leadCode);
    assert.equal(second.length, first.length, 'replayed assignment must not duplicate notifications');
    const hist: any = await pool.query(`SELECT assignment_history FROM leads WHERE lead_code = $1`, [leadCode]);
    assert.equal(hist.rows[0].assignment_history.length, 0, 'replay must not append duplicate history either');
  });

  it('5. DB uniqueness protects duplicate inserts; NULL event keys (manual rows) stay unrestricted', async () => {
    const key = `lead-assigned:${nextLeadCode()}:1:FAE1`;
    await pool.query(
      `INSERT INTO notifications (user_id, recipient_key, title, message, lead_code, is_read, type, event_key, event_type)
       VALUES ($1,'FAE1','t','m',$2,FALSE,'info',$3,'lead-assigned')`,
      [ids.FAE1, key.split(':')[1], key]
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO notifications (user_id, recipient_key, title, message, lead_code, is_read, type, event_key, event_type)
         VALUES ($1,'FAE1','t','m',$2,FALSE,'info',$3,'lead-assigned')`,
        [ids.FAE1, key.split(':')[1], key]
      ),
      (err: any) => String(err.code) === '23505'
    );
    const skip = await pool.query(
      `INSERT INTO notifications (user_id, recipient_key, title, message, lead_code, is_read, type, event_key, event_type)
       VALUES ($1,'FAE1','t','m',$2,FALSE,'info',$3,'lead-assigned')
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [ids.FAE1, key.split(':')[1], key]
    );
    assert.equal(skip.rowCount, 0, 'the delivery path ON CONFLICT variant must insert nothing on a retry');
    // Manual/self-service rows (NULL event_key) are never blocked.
    await pool.query(`INSERT INTO notifications (user_id, recipient_key, title, message, is_read, type) VALUES ($1,'FAE1','manual a','m',FALSE,'info')`, [ids.FAE1]);
    await pool.query(`INSERT INTO notifications (user_id, recipient_key, title, message, is_read, type) VALUES ($1,'FAE1','manual b','m',FALSE,'info')`, [ids.FAE1]);
  });

  /* ================================================================== */
  /* 6-9. AUTHORIZATION + FAILURE SEMANTICS                             */
  /* ================================================================== */

  it('6. a caller without the underlying business permission cannot trigger notifications through the business route', async () => {
    const before = (await notificationsFor('FAE3')).length;
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${tokFor('VIEWX')}`)
      .send({ leadCode: leadOneId, customerName: 'Shared Prospect', mobile: '01700000001', assignedTo: 'FAE3' });
    assert.equal(res.status, 403, 'view-only user cannot edit/assign a lead');
    const after = (await notificationsFor('FAE3')).length;
    assert.equal(after, before, 'a denied business mutation must not produce notifications');
  });

  it('7. Data Visibility stays enforced on the notifying route (grants do not bypass scope)', async () => {
    // OWNEDIT has leads.edit + leads.assign but Own visibility: the shared
    // lead belongs to FAE1, so the mutation is refused BEFORE any
    // notification is produced.
    const before = await notificationsForLead(leadOneCode);
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${ownT()}`)
      .send({ leadCode: leadOneCode, customerName: 'Shared Prospect', mobile: '01700000001', assignedTo: 'FAE3' });
    assert.equal(res.status, 403);
    const after = await notificationsForLead(leadOneCode);
    assert.equal(after.length, before.length);
    assert.ok(!(await notificationsFor('FAE3')).some(r => String(r.message).includes('Shared Prospect')));
  });

  it('8-9. notification insert failure rolls the WHOLE assignment transaction back; retry after the fix delivers exactly once', async () => {
    const { res, leadCode } = await createLeadViaApi(opsT(), 'FAE3');
    assert.equal(res.status, 200);
    const leadRowId = (await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [leadCode])).rows[0].id;
    const beforeNotifs = await notificationsForLead(leadCode);
    const historyBefore: any = await pool.query(`SELECT assignment_history, assigned_to FROM leads WHERE id = $1`, [leadRowId]);

    // Failure injection: a BEFORE INSERT trigger on notifications raises.
    // (exec() = simple protocol, which tolerates the dollar-quoted body.)
    const inst = await getPGliteInstanceAsync();
    await inst.exec(`CREATE FUNCTION lf_fail_notif() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected notification persistence failure'; END;
    $$ LANGUAGE plpgsql`);
    await inst.exec(`CREATE TRIGGER lf_fail_notif BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION lf_fail_notif()`);

    let poisoned: request.Response;
    try {
      poisoned = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
        .send({ leadCode, customerName: `Rel Prospect ${leadCode}`, mobile: '017' + leadCode.replace(/\D/g, '').padStart(8, '0').slice(-8), assignedTo: 'FAE1' });
    } finally {
      await inst.exec(`DROP TRIGGER IF EXISTS lf_fail_notif ON notifications`);
      await inst.exec(`DROP FUNCTION IF EXISTS lf_fail_notif()`);
    }
    assert.ok([500, 503].includes(poisoned.status), `documented semantics: the whole save fails (got ${poisoned.status})`);

    const historyAfter: any = await pool.query(`SELECT assignment_history, assigned_to, current_status FROM leads WHERE id = $1`, [leadRowId]);
    assert.equal(String(historyAfter.rows[0].assigned_to), String(historyBefore.rows[0].assigned_to), 'no partial lead state committed');
    assert.deepEqual(historyAfter.rows[0].assignment_history, historyBefore.rows[0].assignment_history, 'no partial assignment history committed');
    const failedNotifs = await notificationsForLead(leadCode);
    assert.equal(failedNotifs.length, beforeNotifs.length, 'no orphan notification rows');

    // Repair + retry: same business event must now deliver exactly once.
    const retry = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
      .send({ leadCode, customerName: `Rel Prospect ${leadCode}`, mobile: '017' + leadCode.replace(/\D/g, '').padStart(8, '0').slice(-8), assignedTo: 'FAE1' });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const afterNotifs = await notificationsForLead(leadCode);
    // FAE1's chain is FAE1 -> MGR1 -> CEO1: three recipients, each exactly
    // once — the rolled-back attempt contributed nothing to duplicate.
    assert.equal(afterNotifs.length, beforeNotifs.length + 3, 'assignee + upline chain — exactly once per recipient');
    const fae1Rows = afterNotifs.filter(r => r.recipient_key === 'FAE1');
    assert.equal(fae1Rows.length, 1, 'the rolled-back attempt left nothing to duplicate against');
  });

  /* ================================================================== */
  /* 10-11. GENERIC ENDPOINT POLICY                                     */
  /* ================================================================== */

  it('10-11. generic POST /api/notifications: cross-user stays gated, self-service remains', async () => {
    // Cross-user without routing grants -> 403 (PR #40 guard, still holds).
    const before = (await notificationsFor('CEO1')).length;
    const denied = await request(app).post('/api/notifications').set('Authorization', `Bearer ${tokFor('VIEWX')}`)
      .send({ userId: 'CEO1', title: 'bypass attempt', message: 'should not land' });
    assert.equal(denied.status, 403);
    assert.equal((await notificationsFor('CEO1')).length, before);

    // Self-service stays available to ANY authenticated user and never
    // carries an event key (manual rows are outside the idempotency identity).
    const self = await request(app).post('/api/notifications').set('Authorization', `Bearer ${tokFor('VIEWX')}`)
      .send({ userId: 'VIEWX', title: 'my own note', message: 'self-directed' });
    assert.equal(self.status, 201);
    assert.equal(self.body.data.userId, 'VIEWX');
    const manual: any = await pool.query(`SELECT event_key FROM notifications WHERE id = $1`, [self.body.data.id]);
    assert.equal(manual.rows[0].event_key, null, 'manual notifications keep NULL event_key');
  });

  it('3b. the business route alone satisfies the full flow for a grants-only actor (no separate notification call, no generic cross-user grant needed)', async () => {
    // OWNEDIT: Own visibility + leads.assign. Assigning to SELF is enough to
    // produce the notification (no client-side POST /api/notifications, and
    // no generic cross-user grant involved). The upline alert lands on SELF1,
    // whose manager edge loops back to OWNEDIT — deduped by the traversal.
    const leadCode = nextLeadCode();
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${ownT()}`)
      .send({ leadCode, customerName: `Rel Self ${leadCode}`, mobile: '017' + leadCode.replace(/\D/g, '').padStart(8, '0').slice(-8), assignedTo: 'OWNEDIT' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await notificationsForLead(leadCode);
    const assigneeRow = rows.find(r => r.recipient_key === 'OWNEDIT');
    const uplineRow = rows.find(r => r.recipient_key === 'SELF1');
    assert.ok(assigneeRow, 'assignee notified by the business route alone');
    assert.equal(assigneeRow.title, 'New Lead Assigned');
    assert.ok(uplineRow, 'the manager on the actual graph is notified without any client fan-out');
    assert.equal(uplineRow.title, 'Team Lead Assigned Upline Alert');
    assert.equal(rows.length, 2, 'exactly one row per recipient for this event');

    // SELF1 can SEE it through the normal user-scoped read (display path) —
    // the producer was purely server-side.
    const read = await request(app).get('/api/notifications/users/SELF1').set('Authorization', `Bearer ${tokFor('SELF1')}`);
    assert.equal(read.status, 200);
    assert.ok(read.body.some((n: any) => n.title === 'Team Lead Assigned Upline Alert' && n.leadId === leadCode));
  });

  /* ================================================================== */
  /* 12-13. READ BOUNDARIES (PR #40) ON SERVER-GENERATED ROWS           */
  /* ================================================================== */

  it('12-13. lead-scoped notification history still requires leads.view + actual visibility; out-of-scope stays 404', async () => {
    const { leadCode } = await createLeadViaApi(opsT(), 'FAE1');

    // FAE1: leads.view + owner -> sees the server-generated history.
    const ok = await request(app).get(`/api/notifications/leads/${leadCode}`).set('Authorization', `Bearer ${faeT()}`);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.length >= 1, 'server-generated rows surface in lead history');

    // VIEWX (has leads.view) but lead is outside Own scope -> 404 (no leak).
    const miss = await request(app).get(`/api/notifications/leads/${leadCode}`).set('Authorization', `Bearer ${tokFor('VIEWX')}`);
    assert.equal(miss.status, 404);

    // A user WITHOUT leads.view gets 403 (established boundary).
    const forb = await request(app).get(`/api/notifications/leads/${leadCode}`).set('Authorization', `Bearer ${tokFor('NGR1')}`);
    assert.equal(forb.status, 403);
  });

  /* ================================================================== */
  /* 14-17. RECIPIENT RESOLUTION RULES                                  */
  /* ================================================================== */

  it('14. client-supplied recipient lists are IGNORED for system events — resolution is server-side only', async () => {
    const leadCode = nextLeadCode();
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${opsT()}`)
      .send({
        leadCode,
        customerName: `Rel Spoof ${leadCode}`,
        mobile: '017' + leadCode.replace(/\D/g, '').padStart(8, '0').slice(-8),
        assignedTo: 'FAE2',
        // spoofed fan-out data: must not widen or shift recipients
        recipients: ['CEO1'],
        notifyUpToLevel: 99,
        upline: ['ADMINX'],
      });
    assert.equal(res.status, 200);
    const rows = await notificationsForLead(leadCode);
    const recipients = new Set(rows.map(r => r.recipient_key));
    assert.deepEqual([...recipients].sort(), ['FAE2'], 'only the actual resolved chain participates; CEO1 is beyond the inactive stop and must NOT be notified');
    for (const extra of ['CEO1', 'ADMINX']) {
      assert.ok(!(await notificationsFor(extra)).some(n => n.lead_code === leadCode), `${extra} must not be notified from payload-suggested recipients`);
    }
  });

  it('15-16. cycle cannot loop forever and recipients are deduped (A<->B: exactly two rows, one each)', async () => {
    const started = Date.now();
    const { leadCode } = await createLeadViaApi(opsT(), 'CYCA');
    // The bound proves TERMINATION with generous headroom for CI machines;
    // the meaningful assertion is "returns at all, with exact rows".
    assert.ok(Date.now() - started < 15000, 'traversal must terminate even on a cyclic graph');
    const rows = await notificationsForLead(leadCode);
    const byRecipient = new Map<string, number>();
    for (const r of rows) byRecipient.set(String(r.recipient_key), (byRecipient.get(String(r.recipient_key)) || 0) + 1);
    assert.equal(byRecipient.get('CYCA'), 1, 'assignee notified once');
    assert.equal(byRecipient.get('CYCB'), 1, 'cyclic manager notified once as upline');
    assert.equal(rows.length, 2, 'no duplicate recipients, no runaway fan-out');
  });

  it('17. traversal stops at the first INACTIVE manager — inactive users are not notified and the chain above them is not widened', async () => {
    // FAE2 -> INACT (inactive) -> CEO1. Current (client-era) semantics:
    // the loop BREAKS at the inactive manager: FAE2 alone is notified.
    const { leadCode } = await createLeadViaApi(opsT(), 'FAE2');
    const rows = await notificationsForLead(leadCode);
    const recipients = new Set(rows.map(r => r.recipient_key));
    assert.deepEqual([...recipients], ['FAE2']);
    assert.ok(!(await notificationsFor('INACT')).some(r => r.lead_code === leadCode), 'inactive manager is never notified');
    assert.ok(!(await notificationsFor('CEO1')).some(r => r.lead_code === leadCode), 'fan-out does not continue past the inactive boundary');
  });

  /* ================================================================== */
  /* 18-20. AUDITED-OUT-OF-SCOPE PATHS (must stay silent, not invented) */
  /* ================================================================== */

  it('18-19. scheduled activity creation + follow-up scheduling do NOT invent notifications (audited out of scope)', async () => {
    const { leadCode } = await createLeadViaApi(opsT(), 'FAE1');
    const leadId = (await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [leadCode])).rows[0].id;

    const base = (await notificationsForLead(leadCode)).length;

    const scheduled = await request(app).post('/api/scheduled-activities').set('Authorization', `Bearer ${opsT()}`)
      .send({ leadId, activityType: 'meeting', scheduledAt: new Date(Date.now() + 86400000).toISOString(), title: 'Rel meeting' });
    assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));

    const followUp = await request(app).post(`/api/leads/${leadId}/follow-up`).set('Authorization', `Bearer ${opsT()}`)
      .send({ status: 'Interested', remarks: 'reliability check', nextFollowUpDate: new Date(Date.now() + 2 * 86400000).toISOString() });
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));

    assert.equal((await notificationsForLead(leadCode)).length, base, 'scheduled/follow-up paths remain notification-free (no new business notification types)');
  });

  it('20. Pipeline Locked / Converted moves still behave exactly as before (and stay notification-free)', async () => {
    const { leadCode } = await createLeadViaApi(opsT(), 'FAE1');
    const leadId = (await pool.query(`SELECT id FROM leads WHERE lead_code = $1`, [leadCode])).rows[0].id;
    const base = (await notificationsForLead(leadCode)).length;

    const locked = await request(app).post(`/api/leads/${leadId}/follow-up`).set('Authorization', `Bearer ${opsT()}`)
      .send({ status: 'Pipeline Locked', remarks: 'locked via reliability suite' });
    assert.equal(locked.status, 200);
    assert.equal(locked.body.data.lead.currentStatus, 'Pipeline Locked');

    const converted = await request(app).post(`/api/leads/${leadId}/follow-up`).set('Authorization', `Bearer ${opsT()}`)
      .send({ status: 'Converted', collectedNCP: 1500 });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.data.lead.currentStatus, 'Converted');

    assert.equal((await notificationsForLead(leadCode)).length, base, 'status moves keep the established notification-free behavior');
  });

  it('20b. bulk import with Assigned To stays intentionally notification-free (documented decision — not invented)', async () => {
    const code = `nr_bulk_${Date.now() % 1000000}`;
    const res = await request(app).post('/api/leads/bulk').set('Authorization', `Bearer ${opsT()}`)
      .send({
        leads: [
          { 'Lead Code': `${code}_a`, 'Customer Name': 'Bulk Silent A', 'Mobile': '01755500011', 'Assigned To': 'FAE1' },
          { 'Lead Code': `${code}_b`, 'Customer Name': 'Bulk Silent B', 'Mobile': '01755500012', 'Assigned To': 'FAE3' },
        ],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inserted, 2);
    assert.equal((await notificationsForLead(`${code}_a`)).length, 0);
    assert.equal((await notificationsForLead(`${code}_b`)).length, 0);
    // No per-row fan-out queries are issued from the bulk route either —
    // the established zero-notification bulk semantics is preserved as-is.
  });

  /* ================================================================== */
  /* 21-22. CLIENT-SIDE AUTHORITY REMOVED (source guards)               */
  /* ================================================================== */

  it('21. no client fire-and-forget system-notification path remains for migrated events', () => {
    const leadSvc = fs.readFileSync(path.join(REPO_ROOT, 'src/modules/leads/services/leadService.ts'), 'utf8');
    assert.ok(!leadSvc.includes('sendHierarchyNotifications'), 'client must not own the assignment fan-out anymore');
    assert.ok(!leadSvc.includes('notificationService'), 'client lead service must not import/produce notifications');
    assert.ok(!leadSvc.includes('/api/notifications'), 'client lead service must not call the notification API');
    assert.ok(!/void\s+\w*[Nn]otif/i.test(leadSvc), 'no void-style fire-and-forget notification call');

    // Whole-tree scan: the ONLY client file that may reference the
    // notification API is the notifications module itself (reads,
    // mark-read, clear, self-directed create). Business pages must not.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const rel = path.relative(REPO_ROOT, full);
        if (rel.includes('modules/notifications/services/notificationService.ts')) continue;
        // legacy root shim re-exporting the module is also fine
        if (rel.includes('services/notificationService.ts')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (src.includes("'POST'") && /api\/notifications/.test(src)) offenders.push(rel);
        if (/apiRequest[\s\S]{0,80}\/api\/notifications/.test(src) && /method:\s*'POST'/.test(src)) offenders.push(rel);
        if (/localDb\.createNotification\(/.test(src)) offenders.push(rel);
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    assert.deepEqual([...new Set(offenders)], [], 'no client file may POST notifications for business events; only the read/cache policy in the notifications module remains');
  });

  it('22. notification cache writes stay inside the user-scoped localDb helper (PR #40 policy preserved)', () => {
    const notifSvc = fs.readFileSync(path.join(REPO_ROOT, 'src/modules/notifications/services/notificationService.ts'), 'utf8');
    assert.ok(notifSvc.includes('localDb.getNotifications(userId)'), 'cache reads go through the user-scoped helper');
    assert.ok(notifSvc.includes('syncCacheForUser'), 'cache writes flow through the user-scoped sync helper');
    assert.ok(!/localStorage\.(set|remove)Item\(\s*['"`](?!lf_|leadflow-)[^'"`]*notif/i.test(notifSvc), 'no raw global localStorage notification writes');
    // createNotification (the retained self-service channel) still writes
    // cache ONLY after the server confirmed persistence.
    const createBody = notifSvc.slice(notifSvc.indexOf('async createNotification'), notifSvc.indexOf('async markNotificationAsRead'));
    assert.ok(createBody.indexOf("apiRequest<SystemNotification>('/api/notifications'") >= 0, 'self-service create is API-first');
    assert.ok(createBody.indexOf('localDb') > createBody.indexOf('await apiRequest'), 'cache write happens only after server confirmation');
  });

  it('23-29 note. legacy rows remain fully readable after 040 (backward-compatible migration)', async () => {
    // A manual row without event data predates the migration in this fixture
    // (the migration ran against the LEGACY table shape in before()).
    await pool.query(
      `INSERT INTO notifications (user_id, recipient_key, title, message, is_read, created_at, updated_at)
       VALUES ($1,'FAE1','Legacy row','created before 040',FALSE, NOW(), NOW())`,
      [ids.FAE1]
    );
    const res = await request(app).get('/api/notifications/users/FAE1').set('Authorization', `Bearer ${faeT()}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((n: any) => n.title === 'Legacy row'), 'pre-existing rows keep their exact read shape');
    assert.ok(res.body.some((n: any) => n.title === 'New Lead Assigned'), 'server-generated rows read through the same mapper');
  });
});
