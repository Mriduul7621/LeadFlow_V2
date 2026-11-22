/**
 * bulk-lead-actions.test.ts
 * ------------------------------------------------------------------
 * Bulk lead reassign + bulk lead delete (Mahadi, 2026-11-22): users
 * who have access to lead delete and reassign can mark (select) one
 * or more leads and reassign or delete them in bulk, from the lead
 * list only (NOT the workbench queue, NOT Lead360).
 *
 *   1. Server — POST /api/leads/bulk-reassign {leadIds,
 *      toEmployeeId}: the reassign permission (leads.assign, or
 *      leads.transfer for an existing-owner move) + team scope +
 *      target-in-scope are enforced upfront, exactly like the
 *      single reassign through POST /leads; each lead is then
 *      authorised server-side (found, not deleted, in scope, not
 *      already with the target) and moved in its own transaction
 *      with an assignment-history entry + a lead-reassigned
 *      notification. POST /api/leads/bulk-delete {leadIds,
 *      reason?}: an ADMIN direct-deletes each selected lead (the
 *      POST /leads/:id/delete rule: ADMIN/SUPERADMIN DB role,
 *      soft-delete, leads.delete.direct audit per lead); anyone
 *      else files one delete request per lead (the migration 062
 *      rule: leads.view + in-scope, one reason for all, admin
 *      notified per request). Both endpoints answer per-lead
 *      results {reassigned|deleted|requested, failed} — a bad lead
 *      never fails the good ones — and 503 in demo mode.
 *   2. Source guards — the endpoints are registered, DELETE
 *      /leads/:id is untouched, leadService posts to the new
 *      endpoints, LeadList carries the checkboxes + the gated bulk
 *      bar, the mobile checkbox never opens Lead360, and the
 *      workbench queue carries no bulk UI at all.
 *
 * Fixture tables use the PRODUCTION column shapes — including the
 * permissions table (permission_code, module_name, action_name)
 * and the users table's idra_fa_code column (migration 064).
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
import { up as migrate062 } from '../database/migrations/062_lead_delete_requests.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

describe('bulk lead actions — server', () => {
  let pool: any;
  let app: express.Express;
  let adminToken = '';
  let tlToken = '';
  let tl2Token = '';
  let mem1Token = '';
  let plainToken = '';
  let adminId = '';
  let tlId = '';
  let tl2Id = '';
  let mem1Id = '';
  let mem2Id = '';
  let leadIds: Record<string, string> = {};
  let leadCodes: Record<string, string> = {};

  before(async () => {
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
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
        idra_fa_code VARCHAR(30) UNIQUE,
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
    // The REAL migration 062 — the bulk request tests need the
    // lead_delete_requests table.
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
    const adminRoleId = await mkRole('ADMIN', 1, 'Organization');
    const umRoleId = await mkRole('UM', 5, 'DownTeam');
    const um2RoleId = await mkRole('UM2', 5, 'DownTeam');
    const roRoleId = await mkRole('RO', 6, 'Own');
    const outRoleId = await mkRole('OUT', 6, 'Own');
    const mkUser = async (emp: string, roleId: string, managerId: string | null, active = true) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId, active]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const admin = await mkUser('BADM', adminRoleId, null);
    const tl = await mkUser('BTL', umRoleId, null);
    const tl2 = await mkUser('BTL2', um2RoleId, null);
    const mem1 = await mkUser('BM1', roRoleId, tl.id);
    const mem2 = await mkUser('BM2', roRoleId, tl.id);
    const mem3 = await mkUser('BM3', roRoleId, tl2.id);
    const plain = await mkUser('BPL', roRoleId, null);
    const outsider = await mkUser('BOUT', outRoleId, null);
    await mkUser('BIN', roRoleId, tl.id, false);
    adminId = admin.id;
    tlId = tl.id;
    tl2Id = tl2.id;
    mem1Id = mem1.id;
    mem2Id = mem2.id;
    adminToken = signToken({ ...admin, role: 'ADMIN' });
    tlToken = signToken({ ...tl, role: 'UM' });
    tl2Token = signToken({ ...tl2, role: 'UM2' });
    mem1Token = signToken({ ...mem1, role: 'RO' });
    plainToken = signToken({ ...plain, role: 'RO' });

    const mkPerm = async (code: string, module: string, action: string) => {
      const r: any = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, $2, $3) RETURNING id`,
        [code, module, action]
      );
      return r.rows[0].id;
    };
    const viewPerm = await mkPerm('leads.view', 'Leads', 'VIEW');
    const assignPerm = await mkPerm('leads.assign', 'Leads', 'ASSIGN');
    const transferPerm = await mkPerm('leads.transfer', 'Leads', 'TRANSFER');
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(umRoleId, viewPerm);
    await grant(um2RoleId, viewPerm);
    await grant(roRoleId, viewPerm);
    await grant(outRoleId, viewPerm);
    await grant(umRoleId, assignPerm);
    // UM2 holds ONLY leads.transfer — the transfer arm of the
    // reassign rule is tested through tl2.
    await grant(um2RoleId, transferPerm);
    // ADMIN gets NO grants at all: the direct path gates on the
    // role, not on any grant.

    const mkLead = async (name: string, assignedTo: string | null, createdBy: string, deleted = false) => {
      const code = `LD-${name.replace(/[^A-Za-z0-9]/g, '')}`;
      const r: any = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, is_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING id`,
        [code, name, '01700000000', 'Interested', assignedTo, createdBy, deleted]
      );
      leadIds[name] = r.rows[0].id;
      leadCodes[name] = code;
    };
    await mkLead('Del A', mem1.id, mem1.id);
    await mkLead('Del B', mem1.id, mem1.id);
    await mkLead('Del C', mem1.id, mem1.id);
    await mkLead('Req A', mem1.id, mem1.id);
    await mkLead('Req B', mem1.id, mem1.id);
    await mkLead('Req C', mem1.id, mem1.id);
    await mkLead('Req D', mem1.id, mem1.id);
    await mkLead('Re A', mem1.id, mem1.id);
    await mkLead('Re B', mem1.id, mem1.id);
    await mkLead('Re C', mem1.id, mem1.id);
    await mkLead('Re D', mem1.id, mem1.id);
    await mkLead('Re E', mem1.id, mem1.id);
    await mkLead('Re F', mem1.id, mem1.id);
    await mkLead('Part A', mem1.id, mem1.id);
    await mkLead('Dup A', mem1.id, mem1.id);
    await mkLead('Dup B', mem1.id, mem1.id);
    await mkLead('Code One', mem1.id, mem1.id);
    await mkLead('Out Scope', outsider.id, outsider.id);
    await mkLead('Unassigned One', null, mem1.id);
    await mkLead('Already Deleted', mem1.id, mem1.id, true);
    await mkLead('Pending One', mem1.id, mem1.id);
    await mkLead('Already With Mem2', mem2.id, mem1.id);
    await mkLead('T2 Owned', mem3.id, mem3.id);
    await mkLead('T2 Unassigned', null, mem3.id);
    // One pending request already on file, so the bulk request
    // test can prove a duplicate is reported, never double-filed.
    await pool.query(
      `INSERT INTO lead_delete_requests (lead_id, requested_by, reason) VALUES ($1, $2, $3)`,
      [leadIds['Pending One'], mem1.id, 'already asked']
    );

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

  const bulkReassign = (token: string | null, body: any) => {
    const req = request(app).post('/api/leads/bulk-reassign').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const bulkDelete = (token: string | null, body: any) => {
    const req = request(app).post('/api/leads/bulk-delete').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const leadRow = async (id: string) => {
    const r: any = await pool.query(
      `SELECT id, lead_code, assigned_to, assignment_history, custom_fields, is_deleted, deleted_by FROM leads WHERE id = $1`,
      [id]
    );
    return r.rows[0];
  };
  const requestRows = async (ids: string[]) => {
    const r: any = await pool.query(
      `SELECT lead_id, status, reason FROM lead_delete_requests WHERE lead_id = ANY($1::uuid[]) ORDER BY lead_id`,
      [ids]
    );
    return r.rows;
  };

  it('admin bulk-delete: 200, all 3 leads soft-deleted, one leads.delete.direct audit row per lead', async () => {
    const ids = [leadIds['Del A'], leadIds['Del B'], leadIds['Del C']];
    const res = await bulkDelete(adminToken, { leadIds: ids });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual([...res.body.deleted].sort(), [...ids].sort(), 'all three ids come back deleted');
    assert.deepEqual(res.body.failed, []);
    for (const id of ids) {
      const row = await leadRow(id);
      assert.equal(row.is_deleted, true, 'the lead is soft-deleted');
      assert.equal(String(row.deleted_by), adminId, 'deleted_by is the admin');
    }
    const audit: any = await pool.query(
      `SELECT entity_id FROM audit_logs WHERE action_code = 'leads.delete.direct' AND entity_id = ANY($1::uuid[])`,
      [ids]
    );
    assert.equal(audit.rows.length, 3, 'exactly one direct-delete audit row per lead');
  });

  it('non-admin bulk-delete: 3 requests are filed, nothing is deleted, the reason lands on each request', async () => {
    const ids = [leadIds['Req A'], leadIds['Req B'], leadIds['Req C']];
    const res = await bulkDelete(mem1Token, { leadIds: ids, reason: 'wrong number' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual([...res.body.requested].sort(), [...ids].sort(), 'all three ids come back requested');
    assert.deepEqual(res.body.failed, []);
    assert.equal(res.body.deleted, undefined, 'a non-admin never gets a deleted list');
    for (const id of ids) {
      const row = await leadRow(id);
      assert.equal(row.is_deleted, false, 'the lead is NOT deleted by a request');
    }
    const rows = await requestRows(ids);
    assert.equal(rows.length, 3, 'three request rows');
    for (const r of rows) {
      assert.equal(r.status, 'pending');
      assert.equal(r.reason, 'wrong number', 'the one reason applies to every request');
    }
    // One admin notification per request (the fixture has one admin).
    const notes: any = await pool.query(
      `SELECT COUNT(*) AS n FROM notifications WHERE event_type = 'lead-delete-request' AND user_id = $1`,
      [adminId]
    );
    assert.equal(Number(notes.rows[0].n), 3, 'the admin is notified once per request');
  });

  it('bulk reassign: a team lead with leads.assign moves 3 leads, with history + a notification each', async () => {
    const ids = [leadIds['Re A'], leadIds['Re B'], leadIds['Re C']];
    const res = await bulkReassign(tlToken, { leadIds: ids, toEmployeeId: 'BM2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.deepEqual([...res.body.reassigned].sort(), [...ids].sort());
    assert.deepEqual(res.body.failed, []);
    for (const id of ids) {
      const row = await leadRow(id);
      assert.equal(String(row.assigned_to), mem2Id, 'the lead now belongs to mem2');
      const history = Array.isArray(row.assignment_history) ? row.assignment_history : [];
      assert.equal(history.length, 1, 'one assignment-history entry');
      assert.equal(history[0].toEmployeeId, 'BM2');
      assert.equal(history[0].fromEmployeeId, 'BM1');
      assert.equal(history[0].note, 'Reassigned via bulk action');
      assert.equal(row.custom_fields.assignedTo, 'BM2', 'the custom owner shadow follows the canonical owner');
    }
    const notes: any = await pool.query(
      `SELECT COUNT(*) AS n FROM notifications WHERE event_type = 'lead-reassigned' AND user_id = $1`,
      [mem2Id]
    );
    assert.equal(Number(notes.rows[0].n), 3, 'the new owner is notified once per lead');
  });

  it('bulk reassign: a plain agent with no reassign access gets 403 and nothing moves', async () => {
    const before = await leadRow(leadIds['Re F']);
    const res = await bulkReassign(plainToken, { leadIds: [leadIds['Re F']], toEmployeeId: 'BM2' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const after = await leadRow(leadIds['Re F']);
    assert.equal(String(after.assigned_to), String(before.assigned_to), 'the lead did not move');
  });

  it('bulk reassign: leads.transfer authorises an existing-owner move but NOT an unassigned lead', async () => {
    // tl2 holds ONLY leads.transfer (no leads.assign).
    const owned = await bulkReassign(tl2Token, { leadIds: [leadIds['T2 Owned']], toEmployeeId: 'BTL2' });
    assert.equal(owned.status, 200, JSON.stringify(owned.body));
    assert.deepEqual(owned.body.reassigned, [leadIds['T2 Owned']], 'the transfer arm moves an owned lead');
    const row = await leadRow(leadIds['T2 Owned']);
    assert.equal(String(row.assigned_to), tl2Id, 'the lead moved to tl2');
    const unassigned = await bulkReassign(tl2Token, { leadIds: [leadIds['T2 Unassigned']], toEmployeeId: 'BTL2' });
    assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body));
    assert.deepEqual(unassigned.body.reassigned, [], 'an unassigned lead is never moved on the transfer arm');
    assert.equal(unassigned.body.failed.length, 1);
    assert.match(unassigned.body.failed[0].reason, /leads\.assign/, 'the failure names the missing grant');
    const still = await leadRow(leadIds['T2 Unassigned']);
    assert.equal(still.assigned_to, null, 'the unassigned lead stays unassigned');
  });

  it('bulk reassign: one out-of-scope lead fails, the in-scope ones still move', async () => {
    const ids = [leadIds['Part A'], leadIds['Out Scope']];
    const res = await bulkReassign(tlToken, { leadIds: ids, toEmployeeId: 'BM2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.reassigned, [leadIds['Part A']], 'the in-scope lead moved');
    assert.equal(res.body.failed.length, 1, 'the out-of-scope lead failed');
    assert.equal(res.body.failed[0].id, leadIds['Out Scope']);
    assert.match(res.body.failed[0].reason, /not in your scope/, 'no existence leak beyond the scope note');
    const out = await leadRow(leadIds['Out Scope']);
    assert.notEqual(String(out.assigned_to), mem2Id, 'the out-of-scope lead did not move');
  });

  it('bulk reassign by lead code works, and duplicate ids are handled once', async () => {
    const byCode = await bulkReassign(tlToken, { leadIds: [leadCodes['Code One']], toEmployeeId: 'BM2' });
    assert.equal(byCode.status, 200, JSON.stringify(byCode.body));
    assert.deepEqual(byCode.body.reassigned, [leadCodes['Code One']], 'the requested identifier echoes back');
    const dup = await bulkReassign(tlToken, {
      leadIds: [leadIds['Dup A'], leadIds['Dup A'], leadIds['Dup B']],
      toEmployeeId: 'BM2',
    });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.deepEqual([...dup.body.reassigned].sort(), [leadIds['Dup A'], leadIds['Dup B']].sort(), 'each lead moves once');
    assert.deepEqual(dup.body.failed, []);
    const row = await leadRow(leadIds['Dup A']);
    const history = Array.isArray(row.assignment_history) ? row.assignment_history : [];
    assert.equal(history.length, 1, 'no double history entry for the duplicated id');
  });

  it('bulk reassign: a lead already with the target fails, it is not a silent no-op', async () => {
    const res = await bulkReassign(tlToken, { leadIds: [leadIds['Already With Mem2']], toEmployeeId: 'BM2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.reassigned, []);
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].reason, /already assigned/);
  });

  it('bulk reassign: an unknown id is a failed entry, not a 500; an inactive target is 400; an out-of-team target is 403', async () => {
    const unknown = await bulkReassign(tlToken, { leadIds: ['00000000-0000-0000-0000-000000000000'], toEmployeeId: 'BM2' });
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.deepEqual(unknown.body.reassigned, []);
    assert.equal(unknown.body.failed.length, 1);
    assert.match(unknown.body.failed[0].reason, /not found/);
    const inactive = await bulkReassign(tlToken, { leadIds: [leadIds['Re D']], toEmployeeId: 'BIN' });
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
    assert.match(inactive.body.message, /inactive/);
    const outside = await bulkReassign(tlToken, { leadIds: [leadIds['Re E']], toEmployeeId: 'BOUT' });
    assert.equal(outside.status, 403, JSON.stringify(outside.body));
    const still = await leadRow(leadIds['Re E']);
    assert.equal(String(still.assigned_to), mem1Id, 'the lead did not move to the outsider');
  });

  it('bulk delete: an already-pending request is reported, never double-filed; an unknown id fails; an already-deleted lead fails', async () => {
    const res = await bulkDelete(mem1Token, {
      leadIds: [leadIds['Pending One'], leadIds['Req D'], '00000000-0000-0000-0000-000000000000', leadIds['Already Deleted']],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.requested, [leadIds['Req D']], 'only the fresh lead gets a request');
    assert.equal(res.body.failed.length, 3, 'pending + unknown + already-deleted all fail');
    const byId = new Map(res.body.failed.map((f: any) => [f.id, f.reason]));
    assert.match(String(byId.get(leadIds['Pending One'])), /already pending/);
    assert.match(String(byId.get('00000000-0000-0000-0000-000000000000')), /not found/);
    // A soft-deleted lead is indistinguishable from an unknown one:
    // findLeadByIdRaw excludes is_deleted rows, so the bulk call
    // reports 'not found' — exactly like the single delete-request
    // flow, and it never confirms the lead existed.
    assert.match(String(byId.get(leadIds['Already Deleted'])), /not found/);
    const pendingRows = await requestRows([leadIds['Pending One']]);
    assert.equal(pendingRows.length, 1, 'still exactly one pending request for that lead');
  });

  it('bulk endpoints: an empty lead list is 400, and unauthenticated is 401', async () => {
    const emptyReassign = await bulkReassign(tlToken, { leadIds: [], toEmployeeId: 'BM2' });
    assert.equal(emptyReassign.status, 400, JSON.stringify(emptyReassign.body));
    const emptyDelete = await bulkDelete(adminToken, { leadIds: [] });
    assert.equal(emptyDelete.status, 400, JSON.stringify(emptyDelete.body));
    const missingReassign = await bulkReassign(tlToken, { toEmployeeId: 'BM2' });
    assert.equal(missingReassign.status, 400, JSON.stringify(missingReassign.body));
    const noAuthReassign = await bulkReassign(null, { leadIds: [leadIds['Re F']], toEmployeeId: 'BM2' });
    assert.equal(noAuthReassign.status, 401, JSON.stringify(noAuthReassign.body));
    const noAuthDelete = await bulkDelete(null, { leadIds: [leadIds['Re F']] });
    assert.equal(noAuthDelete.status, 401, JSON.stringify(noAuthDelete.body));
  });
});

describe('bulk lead actions — demo mode', () => {
  let app: express.Express;
  let token = '';

  before(async () => {
    // No database at all: useDb() reads the connection string from
    // the environment at call time, so deleting it here (after the
    // DB describe above has finished and closed its pool) puts the
    // already-loaded routes into demo mode for this block.
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_PRISMA_URL;
    process.env.NODE_ENV = 'test';
    _resetPoolsForTest();
    token = signToken({ id: 'demo-user', employeeId: 'DEMO', email: 'demo@test.com', role: 'ADMIN' });
    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  after(async () => {
    await closePool().catch(() => {});
    _resetPoolsForTest();
    resetPGlite();
  });

  it('bulk reassign and bulk delete answer 503 without a database', async () => {
    const reassign = await request(app).post('/api/leads/bulk-reassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ leadIds: ['LD-1'], toEmployeeId: 'BM2' });
    assert.equal(reassign.status, 503, JSON.stringify(reassign.body));
    const del = await request(app).post('/api/leads/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ leadIds: ['LD-1'] });
    assert.equal(del.status, 503, JSON.stringify(del.body));
  });
});

describe('bulk lead actions — source guards', () => {
  it('the bulk endpoints are registered and demo-gated; DELETE /leads/:id is untouched', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(routes.includes("router.post('/leads/bulk-reassign'"), 'bulk-reassign is registered');
    assert.ok(routes.includes("router.post('/leads/bulk-delete'"), 'bulk-delete is registered');
    assert.ok(routes.includes("router.delete('/leads/:id'"), 'DELETE /leads/:id still exists — the manager/grant path is pinned, never touched by this feature');
    assert.ok(routes.includes('Bulk reassign requires the database.'), 'bulk-reassign 503s in demo mode');
    assert.ok(routes.includes('Bulk delete requires the database.'), 'bulk-delete 503s in demo mode');
    assert.ok(routes.includes("actionCode: 'leads.delete.direct'"), 'the bulk admin path audits like the direct delete');
    assert.ok(routes.includes("'Reassigned via bulk action'"), 'the bulk reassign writes its own history note');
  });

  it('leadService posts bulk actions to the new endpoints and returns per-lead results', () => {
    const svc = read('src/modules/leads/services/leadService.ts');
    assert.ok(svc.includes('async bulkReassign('), 'bulkReassign exists');
    assert.ok(svc.includes("apiRequest('/api/leads/bulk-reassign'") || svc.includes("apiRequest<BulkReassignResult"), 'bulkReassign posts to the bulk endpoint');
    assert.ok(svc.includes('async bulkDelete('), 'bulkDelete exists');
    assert.ok(svc.includes("apiRequest('/api/leads/bulk-delete'") || svc.includes("apiRequest<BulkDeleteResult"), 'bulkDelete posts to the bulk endpoint');
    assert.ok(svc.includes('interface BulkReassignResult'), 'the reassign result type is exported');
    assert.ok(svc.includes('interface BulkDeleteResult'), 'the delete result type is exported');
  });

  it('LeadList carries the selection checkboxes and the bulk bar', () => {
    const list = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(list.includes('selectedLeadIds'), 'selection state exists');
    assert.ok(list.includes('toggleLeadSelected'), 'a toggle handler exists');
    assert.ok(list.includes('aria-label="Select all visible leads"'), 'the desktop header checkbox selects the visible rows');
    assert.ok(list.includes('{selectedCount} selected'), 'the bulk bar shows the count');
    assert.ok(list.includes('BulkReassignDialog'), 'the bulk reassign dialog is mounted');
    assert.ok(list.includes('BulkDeleteDialog'), 'the bulk delete dialog is mounted');
    assert.ok(list.includes('setBulkReassignOpen') || list.includes('bulkReassignOpen'), 'the bulk reassign dialog opens from the bar');
    assert.ok(list.includes('setBulkDeleteOpen') || list.includes('bulkDeleteOpen'), 'the bulk delete dialog opens from the bar');
  });

  it('the bulk Reassign button is gated by the same check as the single Reassign button', () => {
    const list = read('src/modules/leads/pages/LeadList.tsx');
    // The bar sits between its marker and the table card — bound
    // the slice so the single-button gate below cannot stand in
    // for the bar's own gate.
    const bar = list.slice(list.indexOf('lf-bulk-bar'), list.indexOf('ep-tablecard'));
    assert.ok(bar.includes('canReassign'), 'the bulk bar shows Reassign only when useCanReassign() allows it');
    assert.ok(bar.includes('setBulkReassignOpen(true)'), 'the gated button opens the bulk reassign dialog');
    // The single Reassign button (desktop table) is gated the same way.
    assert.ok(list.includes('{canReassign && ('), 'the single Reassign gate is unchanged');
  });

  it('the mobile checkbox never opens Lead 360 — the row tap and the arrow still do', () => {
    const list = read('src/modules/leads/pages/LeadList.tsx');
    const mobile = list.slice(list.indexOf('lf-mobile-lead-list'), list.indexOf('lf-desktop-lead-table'));
    assert.ok(mobile.includes('type="checkbox"'), 'the mobile row carries a checkbox');
    const check = mobile.slice(mobile.indexOf('type="checkbox"'));
    assert.ok(check.includes('stopPropagation'), 'tapping the checkbox stops propagation — it must not open Lead 360');
    assert.ok(mobile.includes("navigate('/leads/' + lead.id)"), 'the row tap still opens Lead 360');
    assert.ok(mobile.includes('ChevronRight'), 'the arrow still opens Lead 360');
  });

  it('the workbench queue carries no bulk UI at all', () => {
    const w = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(!w.includes('BulkReassignDialog'), 'no bulk reassign in the workbench');
    assert.ok(!w.includes('BulkDeleteDialog'), 'no bulk delete in the workbench');
    assert.ok(!w.includes('selectedLeadIds'), 'no lead selection in the workbench');
    assert.ok(!w.includes('lf-bulk-bar'), 'no bulk bar in the workbench');
  });

  it('Lead360 is untouched by this feature — no bulk UI there', () => {
    const l360 = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(!l360.includes('BulkReassignDialog'), 'no bulk reassign on Lead 360');
    assert.ok(!l360.includes('BulkDeleteDialog'), 'no bulk delete on Lead 360');
    assert.ok(!l360.includes('selectedLeadIds'), 'no lead selection on Lead 360');
  });

  it('the bulk dialogs carry the per-role wording', () => {
    const del = read('src/modules/leads/components/BulkDeleteDialog.tsx');
    assert.ok(del.includes('right away'), 'the admin wording says the delete is immediate');
    assert.ok(del.includes('does <span'), 'the non-admin wording says the delete is NOT immediate');
    assert.ok(del.includes('Reason (optional'), 'the non-admin dialog takes one reason for all leads');
    assert.ok(del.includes('Confirm delete'), 'the admin confirm button matches DirectDeleteDialog');
    const re = read('src/modules/leads/components/BulkReassignDialog.tsx');
    assert.ok(re.includes('Reassign {leads.length}'), 'the reassign dialog names the count');
    assert.ok(re.includes('bulkReassign'), 'the reassign dialog calls the bulk service');
  });
});
