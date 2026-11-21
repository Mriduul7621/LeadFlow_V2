/**
 * admin-direct-delete.test.ts
 * ------------------------------------------------------------------
 * Admin direct delete (Mahadi, 2026-11-21): when an ADMIN deletes a
 * lead, NO approval is needed — only a confirm click. Non-admins
 * keep the request → admin-approval flow (migration 062) unchanged.
 *
 *   1. Server — POST /leads/:id/delete is ADMIN/SUPERADMIN-only
 *      (requireAdmin on the token claim AND the DB role): admin
 *      deletes with 200 + soft-delete + a leads.delete.direct
 *      audit row, with NO leads.delete grant; a non-admin gets 403
 *      even WITH the leads.delete grant (the direct path is
 *      role-gated, not grant-gated); unauthenticated is 401;
 *      missing / already-deleted leads are 404; delete by lead
 *      code works; the request flow still works alongside it; a
 *      direct-deleted lead with a pending request stays reviewable
 *      (approve answers leadAlreadyDeleted).
 *   2. Source guards — the endpoint registration + double gate,
 *      DELETE /leads/:id untouched (the manager/grant path still
 *      exists), LeadList + Lead360 mount the direct dialog for
 *      admins and the request dialog for everyone else, the
 *      confirm click is required (nothing deletes on open), and
 *      leadService.deleteLeadDirect posts to the admin endpoint.
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

describe('admin direct delete — server', () => {
  let pool: any;
  let app: express.Express;
  let adminToken = '';
  let memToken = '';
  let delToken = '';
  let adminId = '';
  let memId = '';
  let leadIds: Record<string, string> = {};
  let leadCodes: Record<string, string> = {};

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
    // The REAL migration 062 — the request-flow coexistence tests
    // need the lead_delete_requests table.
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
    const memRoleId = await mkRole('RO', 6, 'Own');
    const delRoleId = await mkRole('DEL', 6, 'Own');
    const adminRole = await mkRole('ADMIN', 1, 'Organization');
    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, TRUE) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const mem = await mkUser('DMEM', memRoleId, null);
    const del = await mkUser('DDEL', delRoleId, null);
    const admin = await mkUser('DADM', adminRole, null);
    memId = mem.id;
    adminId = admin.id;
    memToken = signToken({ ...mem, role: 'RO' });
    delToken = signToken({ ...del, role: 'DEL' });
    adminToken = signToken({ ...admin, role: 'ADMIN' });

    const mkPerm = async (code: string, module: string, action: string) => {
      const r: any = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, $2, $3) RETURNING id`,
        [code, module, action]
      );
      return r.rows[0].id;
    };
    const viewPerm = await mkPerm('leads.view', 'Leads', 'VIEW');
    const deletePerm = await mkPerm('leads.delete', 'Leads', 'DELETE');
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(memRoleId, viewPerm);
    await grant(delRoleId, viewPerm);
    await grant(delRoleId, deletePerm);
    // ADMIN gets NO grants at all: the direct path gates on the
    // role, not on any grant.

    const mkLead = async (name: string, assignedTo: string, deleted = false) => {
      const code = `LD-${name.replace(/[^A-Za-z0-9]/g, '')}`;
      const r: any = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, is_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING id`,
        [code, name, '01700000000', 'Interested', assignedTo, assignedTo, deleted]
      );
      leadIds[name] = r.rows[0].id;
      leadCodes[name] = code;
    };
    await mkLead('Admin Target', mem.id);
    await mkLead('Agent Target', mem.id);
    await mkLead('Grant Target', del.id);
    await mkLead('Code Target', mem.id);
    await mkLead('Request Target', mem.id);
    await mkLead('Pending Target', mem.id);
    await mkLead('Already Deleted', mem.id, true);

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

  const directDelete = (token: string | null, id: string) => {
    const req = request(app).post(`/api/leads/${id}/delete`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const requestDelete = (token: string, id: string) =>
    request(app).post(`/api/leads/${id}/delete-request`).set('Authorization', `Bearer ${token}`).send({});
  const listRequests = (token: string) =>
    request(app).get('/api/leads/delete-requests').set('Authorization', `Bearer ${token}`);
  const reviewRequest = (token: string, requestId: string, action: string) =>
    request(app).post(`/api/leads/delete-requests/${requestId}/review`).set('Authorization', `Bearer ${token}`).send({ action });
  const leadRow = async (id: string) => {
    const r: any = await pool.query(`SELECT is_deleted, deleted_by FROM leads WHERE id = $1`, [id]);
    return r.rows[0];
  };

  it('admin direct delete: 200 soft-deletes the lead and writes the leads.delete.direct audit row — with NO grant', async () => {
    // The admin role holds no permission grants at all: the direct
    // path gates on the role, not on leads.delete.
    const grants: any = await pool.query(
      `SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.role_code = 'ADMIN'`
    );
    assert.equal(Number(grants.rows[0].n), 0, 'the ADMIN role holds no grants in this fixture');
    const res = await directDelete(adminToken, leadIds['Admin Target']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    const row = await leadRow(leadIds['Admin Target']);
    assert.equal(row.is_deleted, true, 'the lead is soft-deleted');
    assert.equal(String(row.deleted_by), adminId, 'deleted_by is the admin');
    const audit: any = await pool.query(
      `SELECT actor_user_id, action_code, entity_type, entity_id, metadata FROM audit_logs
       WHERE action_code = 'leads.delete.direct' AND entity_id = $1`,
      [leadIds['Admin Target']]
    );
    assert.equal(audit.rows.length, 1, 'exactly one direct-delete audit row');
    assert.equal(String(audit.rows[0].actor_user_id), adminId);
    assert.equal(audit.rows[0].entity_type, 'lead');
    assert.equal(audit.rows[0].metadata.leadCode, leadCodes['Admin Target']);
  });

  it('direct delete: a non-admin agent gets 403 and the lead is untouched', async () => {
    const res = await directDelete(memToken, leadIds['Agent Target']);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const row = await leadRow(leadIds['Agent Target']);
    assert.equal(row.is_deleted, false, 'the lead is NOT deleted by a 403');
  });

  it('direct delete: a non-admin WITH the leads.delete grant still gets 403', async () => {
    // The direct path is role-gated, not grant-gated — this is what
    // separates it from DELETE /leads/:id, where the same grant
    // plus scope DOES delete (pinned in lead-visibility-unified).
    const res = await directDelete(delToken, leadIds['Grant Target']);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const row = await leadRow(leadIds['Grant Target']);
    assert.equal(row.is_deleted, false, 'the lead is NOT deleted by a 403');
    const audit: any = await pool.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action_code = 'leads.delete.direct' AND entity_id = $1`,
      [leadIds['Grant Target']]
    );
    assert.equal(Number(audit.rows[0].n), 0, 'no audit row for a refused delete');
  });

  it('direct delete: unauthenticated is 401', async () => {
    const res = await directDelete(null, leadIds['Agent Target']);
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it('direct delete: a missing lead is 404; an already-deleted lead is 404', async () => {
    const missing = await directDelete(adminToken, '00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    const gone = await directDelete(adminToken, leadIds['Already Deleted']);
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
  });

  it('direct delete by lead code works', async () => {
    const res = await directDelete(adminToken, leadCodes['Code Target']);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await leadRow(leadIds['Code Target']);
    assert.equal(row.is_deleted, true, 'the lead is soft-deleted by code');
  });

  it('the request flow is unchanged: an agent files a request, the admin approves it, the lead is deleted', async () => {
    const filed = await requestDelete(memToken, leadIds['Request Target']);
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(filed.body.request.status, 'pending');
    const rowBefore = await leadRow(leadIds['Request Target']);
    assert.equal(rowBefore.is_deleted, false, 'the lead is NOT deleted while pending');
    const list = await listRequests(adminToken);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(
      (list.body.requests || []).some((r: any) => String(r.leadId) === leadIds['Request Target'] && r.status === 'pending'),
      'the admin review list shows the pending request'
    );
    const reviewed = await reviewRequest(adminToken, filed.body.request.id, 'approve');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'approved');
    const rowAfter = await leadRow(leadIds['Request Target']);
    assert.equal(rowAfter.is_deleted, true, 'approve soft-deletes the lead');
    // The approve audit keeps its own code — it is not a direct delete.
    const audit: any = await pool.query(
      `SELECT action_code FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
      [leadIds['Request Target']]
    );
    const codes = audit.rows.map((r: any) => r.action_code);
    assert.ok(codes.includes('leads.delete.request'), 'the request was audited');
    assert.ok(codes.includes('leads.delete.approve'), 'the approval was audited');
    assert.ok(!codes.includes('leads.delete.direct'), 'no direct-delete audit for an approved request');
    assert.ok(memId, 'fixture sanity: mem user exists');
  });

  it('a direct-deleted lead with a pending request stays reviewable (approve answers leadAlreadyDeleted)', async () => {
    const filed = await requestDelete(memToken, leadIds['Pending Target']);
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const deleted = await directDelete(adminToken, leadIds['Pending Target']);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const reviewed = await reviewRequest(adminToken, filed.body.request.id, 'approve');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'approved');
    assert.equal(reviewed.body.leadAlreadyDeleted, true, 'the review reports the lead was already gone');
  });
});

describe('admin direct delete — source guards', () => {
  it('the direct-delete endpoint is registered with requireAdmin and re-checks the DB role', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(
      routes.includes("router.post('/leads/:id/delete', requireAuth, requireAdmin"),
      'POST /leads/:id/delete is registered behind requireAuth + requireAdmin'
    );
    const start = routes.indexOf("router.post('/leads/:id/delete'");
    const block = routes.slice(start, routes.indexOf("router.get('/leads/:id'", start));
    assert.ok(block.includes('normalizeRole(caller.role_code)'), 'the handler re-checks the DB role, not just the token claim');
    assert.ok(block.includes("role !== 'ADMIN' && role !== 'SUPERADMIN'"), 'the DB check is ADMIN/SUPERADMIN');
    assert.ok(block.includes("actionCode: 'leads.delete.direct'"), 'the direct delete is audited with its own code');
    assert.ok(block.includes("if (!useDb())"), 'demo mode answers 503, like the rest of the 062 family');
    assert.ok(block.includes('is_deleted = TRUE, deleted_at = NOW(), deleted_by = $2'), 'the soft-delete UPDATE matches the existing path');
  });

  it('DELETE /leads/:id is untouched — the manager/grant path still exists', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(
      routes.includes("router.delete('/leads/:id', requireAuth, async (req, res)"),
      'the existing DELETE endpoint keeps its registration'
    );
    assert.ok(routes.includes('checkLeadDeletePermission(req, res)'), 'the DELETE endpoint keeps its permission guard');
    assert.ok(
      routes.includes("hasPermissionCode(caller, 'leads.delete')"),
      'a non-admin with the leads.delete grant can still delete through DELETE /leads/:id'
    );
  });

  it('LeadList shows the direct-delete dialog to admins and the request dialog to everyone else', () => {
    const page = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(page.includes("import DirectDeleteDialog from '../components/DirectDeleteDialog'"), 'LeadList imports the direct dialog');
    assert.ok(
      page.includes("['ADMIN', 'SUPERADMIN'].includes(String(user?.role || '').toUpperCase())"),
      'the admin check is the REAL user role, ADMIN/SUPERADMIN'
    );
    assert.ok(page.includes('<DirectDeleteDialog'), 'the direct dialog is mounted for admins');
    assert.ok(page.includes('onDeleted={removeDeletedLead}'), 'a direct delete removes the lead from the list');
    assert.ok(page.includes('<RequestDeleteDialog'), 'the request dialog stays for non-admins');
    assert.ok(page.includes("title={isAdmin ? 'Delete lead' : 'Request deletion — an admin reviews it'}"), 'the trash tooltip follows the role');
    assert.ok(!page.includes('deleteLeadDirect('), 'LeadList never calls the delete service itself — only the dialog does');
  });

  it('Lead360 shows the direct-delete dialog to admins and leaves the page after the delete', () => {
    const page = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(page.includes("import DirectDeleteDialog from '../components/DirectDeleteDialog'"), 'Lead360 imports the direct dialog');
    assert.ok(
      page.includes("['ADMIN', 'SUPERADMIN'].includes(String(user?.role || '').toUpperCase())"),
      'the admin check is the REAL user role, ADMIN/SUPERADMIN'
    );
    assert.ok(page.includes('<DirectDeleteDialog'), 'the direct dialog is mounted for admins');
    assert.ok(page.includes('<RequestDeleteDialog'), 'the request dialog stays for non-admins');
    assert.ok(page.includes("navigate('/leads')"), 'after a direct delete the admin leaves the deleted lead page');
    assert.ok(!page.includes('deleteLeadDirect('), 'Lead360 never calls the delete service itself — only the dialog does');
  });

  it('the direct-delete dialog requires the confirm click: nothing deletes on open', () => {
    const dialog = read('src/modules/leads/components/DirectDeleteDialog.tsx');
    assert.ok(dialog.includes('Confirm delete'), 'the confirm button says "Confirm delete"');
    assert.ok(!dialog.includes('useEffect'), 'no effect runs on mount — nothing deletes when the dialog opens');
    assert.ok(dialog.includes('onClick={confirm}'), 'the delete runs only from the confirm button handler');
    assert.ok(dialog.includes('await leadService.deleteLeadDirect(lead.id)'), 'the confirm handler calls the direct-delete service');
    assert.ok(dialog.includes("toast.success('Lead deleted.')"), 'a successful delete toasts');
  });

  it('leadService.deleteLeadDirect posts to the admin endpoint', () => {
    const service = read('src/modules/leads/services/leadService.ts');
    assert.ok(service.includes('async deleteLeadDirect(leadId: string)'), 'deleteLeadDirect exists on the lead service');
    assert.ok(
      service.includes("`/api/leads/${encodeURIComponent(leadId)}/delete`, { method: 'POST' }"),
      'it POSTs to /api/leads/:id/delete'
    );
    assert.ok(service.includes('localDb.deleteLead(leadId)'), 'the local cache drops the deleted lead');
  });
});
