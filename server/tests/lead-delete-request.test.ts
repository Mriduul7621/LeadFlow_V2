/**
 * lead-delete-request.test.ts
 * ------------------------------------------------------------------
 * Lead delete requests (migration 062, owner decision 2026-11-18),
 * ported from PR #158 (work-team-mirror-lead-edit-delete.test.ts
 * §4 + §7) — the mirror homes and the lead edit are NOT ported
 * (superseded by #165 / live via #168); only the delete-request
 * flow is.
 *
 *   1. Migration 062 — registered between 060 and 063 (063 stays
 *      the tail), table created with the pending-unique index, up()
 *      idempotent (runs twice), excluded from legacy adoption so an
 *      adopted database still runs it once.
 *   2. Flow — 201 + active-admins-only notifications, lead NOT
 *      deleted while pending (counts + flags), duplicate 409,
 *      out-of-scope 404, no-permission 403, non-admin list/review
 *      403, request by lead code works, REJECT leaves the lead
 *      untouched, already-reviewed 409, re-request allowed after
 *      rejection, APPROVE soft-deletes (only now do counts move),
 *      final list order (pending first).
 *   3. Source guards — the endpoints + registration order, the
 *      review page + route + FeatureGate entry, the delete icon +
 *      request flow on LeadList and Lead360, notification routing
 *      to the review page.
 *
 * Fixture tables use the PRODUCTION column shapes — including the
 * permissions table (permission_code, module_name, action_name),
 * NOT the permission_name column the #158 fixture carried.
 *
 * NOTE (flagged to Mahadi as a decision point): the source has NO
 * "requester cannot approve own request" rule — an admin who files
 * a request can approve it themselves. This file deliberately does
 * NOT pin that behaviour either way.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { fileURLToPath } from 'node:url';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as migrate062 } from '../database/migrations/062_lead_delete_requests.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

describe('lead delete requests — server', () => {
  let pool: any;
  let app: express.Express;
  let headToken = '';
  let tlToken = '';
  let memToken = '';
  let outToken = '';
  let nogToken = '';
  let adminToken = '';
  let admin2Token = '';
  let memId = '';
  let adminId = '';
  let admin2Id = '';
  let inactiveAdminId = '';
  let leadIds: Record<string, string> = {};
  let leadCodes: Record<string, string> = {};
  let d1RequestId = '';
  let d2RequestId = '';

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(100),
        department_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(100) UNIQUE,
        role_name VARCHAR(255),
        hierarchy_level INT DEFAULT 0,
        data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB,
        actions JSONB,
        feature_permissions JSONB,
        permissions_snapshot JSONB
      );
    `);
    await pool.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        designation TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        reporting_chain JSONB DEFAULT '[]'::jsonb,
        subordinates JSONB DEFAULT '[]'::jsonb,
        hierarchy_level INT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // PRODUCTION permissions shape (migration 025): permission_code,
    // module_name, action_name — no permission_name column.
    await pool.query(`
      CREATE TABLE permissions (
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
      CREATE TABLE role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE user_permissions (
        user_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE audit_logs (
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
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50),
        customer_name VARCHAR(255),
        mobile VARCHAR(30),
        alternate_mobile VARCHAR(30),
        email VARCHAR(150),
        occupation VARCHAR(255),
        marital_status VARCHAR(50),
        address TEXT,
        area VARCHAR(255),
        district VARCHAR(100),
        division VARCHAR(100),
        source VARCHAR(100),
        priority VARCHAR(20),
        notes TEXT,
        current_status VARCHAR(255),
        assigned_to UUID REFERENCES users(id),
        assigned_by UUID REFERENCES users(id),
        assigned_at TIMESTAMP,
        created_by UUID REFERENCES users(id),
        expected_premium NUMERIC,
        expected_value NUMERIC,
        last_contacted_at TIMESTAMP,
        next_follow_up_at TIMESTAMP,
        status_history JSONB,
        assignment_history JSONB,
        documents JSONB,
        tags JSONB,
        custom_fields JSONB,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMP,
        deleted_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by UUID REFERENCES users(id)
      );
    `);
    // Notifications, production shape (migrations 010 + 035 + 040):
    // event_type + idempotency_key with the partial unique index the
    // insert's ON CONFLICT clause requires.
    await pool.query(`
      CREATE TABLE notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_key VARCHAR(255),
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        event_type VARCHAR(100),
        idempotency_key VARCHAR(500),
        lead_code VARCHAR(50),
        reference_type VARCHAR(100),
        reference_id UUID,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        read_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE UNIQUE INDEX idx_notifications_idempotency_key
        ON notifications(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    await pool.query(`
      CREATE TABLE options (
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
    // Minimal activity tables (production shapes) so the quality
    // signal queries run against real tables, not the catch path.
    await pool.query(`
      CREATE TABLE lead_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID REFERENCES leads(id),
        activity_type VARCHAR(50),
        status VARCHAR(255),
        remarks TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE scheduled_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID REFERENCES leads(id),
        scheduled_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'scheduled',
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // The REAL migration 062 — twice, to pin idempotency.
    await migrate062();
    await migrate062();

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const deptId = dept.rows[0].id;
    const mkRole = async (code: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      );
      return r.rows[0].id;
    };
    const headRole = await mkRole('BH', 2, 'DownTeam');
    const umRoleId = await mkRole('UM', 5, 'Own');
    const memRoleId = await mkRole('RO', 6, 'Own');
    const nogRole = await mkRole('NOG', 6, 'Own');
    const adminRole = await mkRole('ADMIN', 1, 'Organization');
    const mkUser = async (emp: string, roleId: string, managerId: string | null, active = true) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId, active]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('KHEAD', headRole, null);
    const tl = await mkUser('KTL', umRoleId, head.id);
    const mem = await mkUser('KMEM', memRoleId, tl.id);
    const out = await mkUser('KOUT', memRoleId, null);
    const nog = await mkUser('KNOG', nogRole, null);
    const admin = await mkUser('KADM', adminRole, null);
    const admin2 = await mkUser('KADM2', adminRole, null);
    const inactiveAdmin = await mkUser('KADMI', adminRole, null, false);
    memId = mem.id;
    adminId = admin.id;
    admin2Id = admin2.id;
    inactiveAdminId = inactiveAdmin.id;
    headToken = signToken({ ...head, role: 'BH' });
    tlToken = signToken({ ...tl, role: 'UM' });
    memToken = signToken({ ...mem, role: 'RO' });
    outToken = signToken({ ...out, role: 'RO' });
    nogToken = signToken({ ...nog, role: 'NOG' });
    adminToken = signToken({ ...admin, role: 'ADMIN' });
    admin2Token = signToken({ ...admin2, role: 'ADMIN' });

    const viewPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ('leads.view', 'Leads', 'VIEW') RETURNING id`
    );
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(headRole, viewPerm.rows[0].id);
    await grant(umRoleId, viewPerm.rows[0].id);
    await grant(memRoleId, viewPerm.rows[0].id);
    // NOG and ADMIN get no leads.view grant: NOG pins the 403, and
    // the admin review paths gate on the role, not the grant.

    const mkLead = async (name: string, assignedTo: string, status: string, deleted = false) => {
      const code = `LC-${name.replace(/[^A-Za-z0-9]/g, '')}`;
      const r: any = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, is_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING id`,
        [code, name, '01700000000', status, assignedTo, assignedTo, deleted]
      );
      leadIds[name] = r.rows[0].id;
      leadCodes[name] = code;
    };
    // MEM holds 11 non-deleted leads (4 delete targets + 7 others)
    // and 1 already-deleted one — the count tests pin 11 → 10.
    await mkLead('MEM Other 1', mem.id, 'Interested');
    await mkLead('MEM Other 2', mem.id, 'Interested');
    await mkLead('MEM Other 3', mem.id, 'Interested');
    await mkLead('MEM Other 4', mem.id, 'Interested');
    await mkLead('MEM Other 5', mem.id, 'Interested');
    await mkLead('MEM Other 6', mem.id, 'Interested');
    await mkLead('MEM Other 7', mem.id, 'Interested');
    await mkLead('MEM Deleted', mem.id, 'Interested', true);
    await mkLead('MEM Delete Target 1', mem.id, 'Interested');
    await mkLead('MEM Delete Target 2', mem.id, 'Interested');
    await mkLead('MEM Delete Target 3', mem.id, 'Interested');
    await mkLead('MEM Delete Target 4', mem.id, 'Interested');
    await mkLead('TL Lead', tl.id, 'New');
    await mkLead('OUT Lead', out.id, 'Interested');

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
  });

  const overview = (token: string) =>
    request(app).get('/api/team/overview').set('Authorization', `Bearer ${token}`);
  const listLeads = (token: string) =>
    request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
  const getLead = (token: string, id: string) =>
    request(app).get(`/api/leads/${id}`).set('Authorization', `Bearer ${token}`);
  const requestDelete = (token: string, id: string, reason?: string) =>
    request(app).post(`/api/leads/${id}/delete-request`).set('Authorization', `Bearer ${token}`).send(reason ? { reason } : {});
  const listRequests = (token: string, status?: string) =>
    request(app).get(`/api/leads/delete-requests${status ? `?status=${status}` : ''}`).set('Authorization', `Bearer ${token}`);
  const reviewRequest = (token: string, requestId: string, action: string, note?: string) =>
    request(app).post(`/api/leads/delete-requests/${requestId}/review`).set('Authorization', `Bearer ${token}`).send(note ? { action, note } : { action });

  /* ============================================================ */
  /* 1. Migration 062                                             */
  /* ============================================================ */

  it('migration 062 is registered between 060 and 063, and 063 stays the tail', () => {
    assert.ok(MIGRATION_IDS.includes('062_lead_delete_requests'), '062 is registered');
    const i060 = MIGRATION_IDS.indexOf('060_stage_rules_terminal');
    const i062 = MIGRATION_IDS.indexOf('062_lead_delete_requests');
    const i063 = MIGRATION_IDS.indexOf('063_users_add_employee');
    assert.ok(i060 !== -1 && i062 !== -1 && i063 !== -1, '060, 062 and 063 are all registered');
    assert.ok(i060 < i062 && i062 < i063, '062 sits between 060 and 063');
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '063_users_add_employee', '063 stays the migration tail');
    assert.ok(read('server/database/runMigrations.ts').includes('062_lead_delete_requests'), 'runner names migration 062');
  });

  it('migration 062 created lead_delete_requests with the pending-unique index (up ran twice)', async () => {
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lead_delete_requests' ORDER BY column_name`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    for (const col of ['id', 'lead_id', 'requested_by', 'reason', 'status', 'requested_at', 'reviewed_by', 'reviewed_at', 'review_note']) {
      assert.ok(names.includes(col), `lead_delete_requests carries ${col}`);
    }
    const idx: any = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'lead_delete_requests'`
    );
    const idxNames = idx.rows.map((r: any) => r.indexname);
    assert.ok(idxNames.includes('idx_lead_delete_requests_pending_unique'), 'the one-pending-request index exists');
    assert.ok(idxNames.includes('idx_lead_delete_requests_status'), 'the status index exists');
  });

  it('migration 062 is excluded from legacy adoption, and the runner skips ledger-recorded ids', () => {
    // The production skip: the runner only runs migrations whose id
    // is NOT in the schema_migrations ledger, and production's ledger
    // already records 062 (the #158 preview boot ran it there).
    const runner = read('server/database/runMigrations.ts');
    assert.ok(
      runner.includes('migrations.filter(m => !ledger.applied.has(m.id))'),
      'the pending pass is ledger-driven — a recorded id never re-runs'
    );
    assert.ok(
      runner.includes('id !== "062_lead_delete_requests"'),
      '062 is excluded from the adoption id list, so an adopted database still runs it once'
    );
    // Its DDL is IF NOT EXISTS throughout — a re-run would be a no-op.
    const mig = read('server/database/migrations/062_lead_delete_requests.ts');
    assert.ok(mig.includes('CREATE TABLE IF NOT EXISTS lead_delete_requests'), 'the table DDL is idempotent');
    assert.ok(mig.includes('CREATE UNIQUE INDEX IF NOT EXISTS'), 'the unique index DDL is idempotent');
  });

  /* ============================================================ */
  /* 2. Delete-request flow (order matters: later tests build on    */
  /*    the requests filed here)                                    */
  /* ============================================================ */

  it('delete request: 201 creates the request and notifies ACTIVE admins only', async () => {
    const res = await requestDelete(memToken, leadIds['MEM Delete Target 1'], 'Duplicate entry — same customer twice');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.request.status, 'pending');
    assert.equal(res.body.request.leadId, leadIds['MEM Delete Target 1']);
    d1RequestId = res.body.request.id;
    assert.ok(d1RequestId, 'the request id is returned');

    const rows: any = await pool.query(
      `SELECT user_id, title, message, event_type, idempotency_key FROM notifications
       WHERE event_type = 'lead-delete-request' ORDER BY created_at`
    );
    assert.equal(rows.rows.length, 2, 'exactly two notifications: one per ACTIVE admin');
    const recipients = rows.rows.map((r: any) => String(r.user_id)).sort();
    assert.deepEqual(recipients, [adminId, admin2Id].sort(), 'both active admins are notified');
    assert.ok(!recipients.includes(inactiveAdminId), 'an inactive admin is NOT notified');
    assert.ok(!recipients.includes(memId), 'the requester is not notified');
    for (const row of rows.rows) {
      assert.equal(row.title, 'Delete request: MEM Delete Target 1', 'the notification names the lead');
      assert.ok(row.message.includes('Name KMEM'), 'the notification names the requester');
      assert.ok(row.message.includes('(KMEM)'), 'the notification carries the requester\'s employee id');
      assert.ok(row.message.includes('LC-MEMDeleteTarget1'), 'the notification carries the lead code');
      assert.ok(row.message.includes('Duplicate entry'), 'the reason travels with the notification');
      assert.ok(row.idempotency_key, 'every notification carries an idempotency key');
    }
    const keys = rows.rows.map((r: any) => r.idempotency_key);
    assert.equal(new Set(keys).size, 2, 'each admin gets their own idempotency key');

    const audit: any = await pool.query(
      `SELECT action_code, entity_id, metadata FROM audit_logs WHERE action_code = 'leads.delete.request'`
    );
    assert.equal(audit.rows.length, 1, 'the request is audit-logged once');
    assert.equal(String(audit.rows[0].entity_id), leadIds['MEM Delete Target 1']);
    assert.equal(audit.rows[0].metadata.requestId, d1RequestId);
  });

  it('delete request: the lead is NOT deleted while pending — counts unchanged, flags set', async () => {
    const row: any = await pool.query(`SELECT is_deleted FROM leads WHERE id = $1`, [leadIds['MEM Delete Target 1']]);
    assert.equal(row.rows[0].is_deleted, false, 'is_deleted stays FALSE while the request is pending');

    const detail = await getLead(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(detail.status, 200, 'the lead still opens while pending');
    assert.ok(detail.body.deleteRequest, 'the detail carries the pending request');
    assert.equal(detail.body.deleteRequest.id, d1RequestId);
    assert.equal(detail.body.deleteRequest.requestedBy, memId);

    const list = await listLeads(memToken);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const rows = list.body as any[];
    assert.equal(rows.length, 11, 'the list count is unchanged while pending (11 non-deleted own leads)');
    const target = rows.find((l: any) => l.dbId === leadIds['MEM Delete Target 1']);
    assert.ok(target, 'the target is still listed');
    assert.equal(target.deleteRequested, true, 'the list row carries the pending marker');
    const other = rows.find((l: any) => l.dbId === leadIds['MEM Delete Target 2']);
    assert.equal(other.deleteRequested, false, 'a lead with no request carries no marker');

    const ov = await overview(memToken);
    const self = (ov.body.people as any[]).find((p: any) => p.employeeId === 'KMEM');
    assert.equal(self.totalLeads, 11, 'the overview total is unchanged while pending — counts move only on approval');
  });

  it('delete request: a second pending request for the same lead is refused (409)', async () => {
    const sameUser = await requestDelete(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(sameUser.status, 409, 'the same requester cannot file twice');
    const otherUser = await requestDelete(tlToken, leadIds['MEM Delete Target 1']);
    assert.equal(otherUser.status, 409, 'another in-scope user cannot file while one is pending either');
    const rows: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lead_delete_requests WHERE lead_id = $1 AND status = 'pending'`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(rows.rows[0].n, 1, 'exactly one pending request exists');
  });

  it('delete request: an out-of-scope lead is 404 (no existence leak), a lead without leads.view is 403', async () => {
    const outOfScope = await requestDelete(outToken, leadIds['MEM Delete Target 3']);
    assert.equal(outOfScope.status, 404, 'OUT cannot request for a lead they cannot see');
    const reverse = await requestDelete(headToken, leadIds['OUT Lead']);
    assert.equal(reverse.status, 404, 'the head cannot request for OUT\'s lead either');
    const noPerm = await requestDelete(nogToken, leadIds['MEM Delete Target 4']);
    assert.equal(noPerm.status, 403, 'a caller without leads.view cannot request at all');
    const missing = await requestDelete(memToken, '00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404, 'a missing lead is 404');
  });

  it('delete requests: the review list is admin-only; the admin sees the pending request', async () => {
    const forbidden = await listRequests(memToken);
    assert.equal(forbidden.status, 403, 'a non-admin cannot list requests');
    const forbiddenReview = await reviewRequest(memToken, d1RequestId, 'approve');
    assert.equal(forbiddenReview.status, 403, 'a non-admin cannot review either');

    const res = await listRequests(adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pending = res.body.requests.filter((r: any) => r.status === 'pending');
    assert.equal(pending.length, 1, 'exactly one pending request so far');
    const req1 = pending[0];
    assert.equal(req1.id, d1RequestId);
    assert.equal(req1.leadName, 'MEM Delete Target 1');
    assert.equal(req1.leadCode, 'LC-MEMDeleteTarget1');
    assert.equal(req1.requestedByName, 'Name KMEM');
    assert.equal(req1.requestedByEmployeeId, 'KMEM');
    assert.equal(req1.reason, 'Duplicate entry — same customer twice');
    assert.equal(req1.leadDeleted, false, 'the lead is not deleted while pending');

    const filtered = await listRequests(adminToken, 'approved');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.requests.length, 0, 'the status filter works');
    const badFilter = await listRequests(adminToken, 'bogus');
    assert.equal(badFilter.status, 400, 'an unknown status filter is 400');
  });

  it('delete request: a request filed by lead code works, and REJECT leaves the lead untouched', async () => {
    const res = await requestDelete(tlToken, leadCodes['MEM Delete Target 2'], 'Requested by the team lead');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    d2RequestId = res.body.request.id;

    const reviewed = await reviewRequest(admin2Token, d2RequestId, 'reject', 'Still an active prospect');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'rejected');
    assert.equal(reviewed.body.leadAlreadyDeleted, false);

    const row: any = await pool.query(`SELECT is_deleted FROM leads WHERE id = $1`, [leadIds['MEM Delete Target 2']]);
    assert.equal(row.rows[0].is_deleted, false, 'a rejected request leaves the lead untouched');
    const detail = await getLead(memToken, leadIds['MEM Delete Target 2']);
    assert.equal(detail.status, 200, 'the lead still opens after rejection');
    assert.equal(detail.body.deleteRequest, null, 'the pending marker is gone after rejection');

    const audit: any = await pool.query(
      `SELECT action_code FROM audit_logs WHERE action_code = 'leads.delete.reject' AND entity_id = $1`,
      [leadIds['MEM Delete Target 2']]
    );
    assert.equal(audit.rows.length, 1, 'the rejection is audit-logged');
  });

  it('delete request: an already-reviewed request cannot be reviewed again (409)', async () => {
    const again = await reviewRequest(adminToken, d2RequestId, 'approve');
    assert.equal(again.status, 409, 'a rejected request cannot be approved after the fact');
    const missing = await reviewRequest(adminToken, '00000000-0000-0000-0000-000000000000', 'approve');
    assert.equal(missing.status, 404, 'a missing request is 404');
    const badAction = await reviewRequest(adminToken, d1RequestId, 'maybe');
    assert.equal(badAction.status, 400, 'an unknown action is 400');
  });

  it('delete request: after a rejection a NEW request for the same lead is allowed', async () => {
    const res = await requestDelete(memToken, leadIds['MEM Delete Target 2']);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending');
    // Leave it pending: the final list test below counts it, and the
    // lead stays live (never approved).
    d2RequestId = res.body.request.id;
  });

  it('delete request: APPROVE soft-deletes the lead through the existing path — and only now do counts move', async () => {
    const reviewed = await reviewRequest(adminToken, d1RequestId, 'approve', 'Confirmed duplicate');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'approved');
    assert.equal(reviewed.body.leadAlreadyDeleted, false, 'the lead was live when approved');

    const row: any = await pool.query(
      `SELECT is_deleted, deleted_at, deleted_by FROM leads WHERE id = $1`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(row.rows[0].is_deleted, true, 'approve sets is_deleted');
    assert.ok(row.rows[0].deleted_at, 'deleted_at is stamped');
    assert.equal(String(row.rows[0].deleted_by), adminId, 'deleted_by is the approving admin');

    const detail = await getLead(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(detail.status, 404, 'the deleted lead no longer opens');
    const list = await listLeads(memToken);
    assert.equal((list.body as any[]).length, 10, 'the list count drops by one — only after approval');
    const ov = await overview(memToken);
    const self = (ov.body.people as any[]).find((p: any) => p.employeeId === 'KMEM');
    assert.equal(self.totalLeads, 10, 'the overview total drops by one — only after approval');

    const audit: any = await pool.query(
      `SELECT action_code, actor_user_id FROM audit_logs WHERE action_code = 'leads.delete.approve' AND entity_id = $1`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(audit.rows.length, 1, 'the approval is audit-logged');
    assert.equal(String(audit.rows[0].actor_user_id), adminId, 'the audit names the approver');

    const again = await reviewRequest(adminToken, d1RequestId, 'approve');
    assert.equal(again.status, 409, 'an approved request cannot be approved twice');
  });

  it('delete requests: the final list shows approved, rejected and pending in order', async () => {
    const res = await listRequests(adminToken);
    assert.equal(res.status, 200);
    const reqs = res.body.requests as any[];
    assert.equal(reqs.length, 3, 'three requests exist: D1 approved, D2 rejected, D2 re-requested pending');
    assert.equal(reqs[0].status, 'pending', 'pending requests come first');
    assert.equal(reqs[0].leadName, 'MEM Delete Target 2');
    const approved = reqs.find((r: any) => r.id === d1RequestId);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.leadDeleted, true, 'the approved row shows its lead as deleted');
    assert.equal(approved.reviewedByName, 'Name KADM');
    assert.equal(approved.reviewNote, 'Confirmed duplicate');
  });

  it('delete requests: a plain agent may request their own lead — the approval is the control', async () => {
    // MEM is a plain RO (no leads.delete, no team scope): the server
    // rule is leads.view + in-scope visibility, so the request
    // succeeds. Target 3 has no request yet.
    const res = await requestDelete(memToken, leadIds['MEM Delete Target 3']);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending');
  });
});

describe('lead delete requests — nav, route and page', () => {
  it('only ADMIN/SUPERADMIN open /leads/delete-requests at the route level', async () => {
    const { resolveFeatureRouteAccess } = await import('../../src/layouts/featureRouteAccess.js');
    assert.equal(resolveFeatureRouteAccess('/leads/delete-requests', 'ADMIN', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/leads/delete-requests', 'SUPERADMIN', undefined), true);
    for (const role of ['MANAGER', 'TEAM_LEAD', 'RM', 'RO', 'EMPLOYEE', 'CEO']) {
      assert.equal(resolveFeatureRouteAccess('/leads/delete-requests', role, undefined), false, `${role} must not open /leads/delete-requests`);
    }
  });

  it('the enterprise heading resolves for /leads/delete-requests', async () => {
    const { enterpriseHeadingForPath } = await import('../../src/layouts/enterpriseNav.js');
    const heading = enterpriseHeadingForPath('admin', '/leads/delete-requests');
    assert.equal(heading.title, 'Delete Requests');
    assert.ok(heading.sub.length > 0, 'the heading carries a non-empty subtitle');
  });

  it('the route is registered in App.tsx behind AdminRoute + FeatureGate, before /leads/:id', () => {
    const app = read('src/App.tsx');
    assert.ok(
      app.includes("const DeleteRequests = lazy(() => import('./modules/leads/pages/DeleteRequests'))"),
      'the page is lazy-loaded'
    );
    assert.ok(app.includes("path: '/leads/delete-requests'"), 'the route is registered');
    assert.ok(
      app.includes('<FeatureGate route="/leads/delete-requests"><LazyPage page={<AdminRoute><DeleteRequests /></AdminRoute>}'),
      'the route sits behind FeatureGate + AdminRoute'
    );
    const listIdx = app.indexOf("path: '/leads/delete-requests'");
    const detailIdx = app.indexOf("path: '/leads/:id'");
    assert.ok(listIdx !== -1 && detailIdx !== -1 && listIdx < detailIdx, 'the review route precedes the detail route');
  });
});

describe('lead delete requests — source guards', () => {
  it('LeadList carries the delete icon beside the row actions, with the request flow and pending marker', () => {
    const page = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(page.includes('Trash2'), 'the trash icon is imported');
    assert.ok(page.includes('RequestDeleteDialog'), 'the list opens the shared request dialog');
    assert.ok(page.includes('Delete requested'), 'a pending lead shows its marker');
    assert.ok(page.includes('deleteRequested'), 'the pending flag drives the icon state');
  });

  it('the shared request dialog says the lead is not deleted at once', () => {
    const dialog = read('src/modules/leads/components/RequestDeleteDialog.tsx');
    assert.ok(dialog.includes('requestDelete'), 'the dialog files the request through leadService');
    assert.ok(dialog.includes('delete the lead right away'), 'the confirm copy says the lead is not deleted at once');
    assert.ok(dialog.includes('only their approval deletes the lead'), 'the confirm copy says only approval deletes');
    assert.ok(dialog.includes('409'), 'a duplicate pending request is handled, not errored');
  });

  it('Lead360 shows the pending marker and a Request delete button next to Edit', () => {
    const page = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(page.includes('deleteRequest'), 'Lead360 reads the pending request');
    assert.ok(page.includes('Delete requested'), 'Lead360 shows the pending banner');
    assert.ok(page.includes('RequestDeleteDialog'), 'Lead360 opens the shared request dialog');
    assert.ok(page.includes('Request deletion'), 'Lead360 carries a Request deletion button');
  });

  it('the admin review page exists, reads the review list, and can approve or reject', () => {
    const page = read('src/modules/leads/pages/DeleteRequests.tsx');
    assert.ok(page.includes("path=\"/leads/delete-requests\""), 'the page uses the enterprise header for its own path');
    assert.ok(page.includes("'/api/leads/delete-requests'"), 'the page reads the review list');
    assert.ok(page.includes("'approve'"), 'the page can approve');
    assert.ok(page.includes("'reject'"), 'the page can reject');
    assert.ok(page.includes("timeZone: 'Asia/Dhaka'"), 'times render in Asia/Dhaka');
  });

  it('delete-request notifications route to the review page, not to a lead', () => {
    // The notifications inbox lives in MorePages.tsx (the More →
    // Notifications page), and the bell dropdown in AppLayout.
    const inbox = read('src/modules/navigation/pages/MorePages.tsx');
    assert.ok(inbox.includes("'lead-delete-request'"), 'the inbox recognises the delete-request event');
    assert.ok(inbox.includes("'/leads/delete-requests'"), 'the inbox routes it to the review page');
    assert.ok(inbox.includes('Delete Requests'), 'the Administration directory lists the review page');
    const layout = read('src/layouts/AppLayout.tsx');
    assert.ok(layout.includes('lead-delete-request'), 'the bell dropdown recognises the event too');
    assert.ok(layout.includes("'/leads/delete-requests'"), 'the bell dropdown routes it to the review page');
  });

  it('the delete-request endpoints live in leads.routes.ts with the 062 guard', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(routes.includes("router.post('/leads/:id/delete-request'"), 'the request endpoint exists');
    assert.ok(routes.includes("router.get('/leads/delete-requests'"), 'the review-list endpoint exists');
    assert.ok(routes.includes("router.post('/leads/delete-requests/:requestId/review'"), 'the review endpoint exists');
    assert.ok(routes.includes("DELETE_REQUEST_EVENT = 'lead-delete-request'"), 'the event name is one constant');
    assert.ok(routes.includes("'leads.delete.request'"), 'the request is audit-logged');
    assert.ok(routes.includes("'leads.delete.approve'"), 'the approval is audit-logged');
    assert.ok(routes.includes("'leads.delete.reject'"), 'the rejection is audit-logged');
    // The review list is registered BEFORE the detail route, or
    // "delete-requests" would be captured as a lead id.
    const listIdx = routes.indexOf("router.get('/leads/delete-requests'");
    const detailIdx = routes.indexOf("router.get('/leads/:id'");
    assert.ok(listIdx !== -1 && detailIdx !== -1 && listIdx < detailIdx, 'the review list precedes /leads/:id');
  });

  it('the notification mapper carries eventType to the client', () => {
    const routes = read('server/routes/production/notifications.routes.ts');
    assert.ok(routes.includes('eventType: row.event_type'), 'mapNotificationRow returns the event type');
  });
});
