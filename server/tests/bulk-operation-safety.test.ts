/**
 * bulk-operation-safety.test.ts — reliability audit route fixes, proven on
 * the REAL migrated schema (isolated PGlite + full runMigrations + seeds)
 * ------------------------------------------------------------------
 * Every route below was previously exercised only against hand-written
 * synthetic tables. This suite mounts the production router on the actual
 * migration output so column-list drift is caught.
 *
 *   A. PUT /users/:id/permissions — regression: the INSERT referenced a
 *      `granted_at` column that migration 027 never created (42703 on a
 *      real database). Now persists an override row and re-saves
 *      idempotently (ON CONFLICT upsert).
 *   B. DELETE /leads/campaign/:campaign — fail-closed filter: blank /
 *      whitespace campaign names are rejected with 400 and nothing is
 *      soft-deleted; a real purge stays admin-only, is scoped to the exact
 *      campaign, and writes an aggregate audit_logs row (counts only).
 *   C. POST /leads/clear-all — admin-only, writes an aggregate audit row;
 *      a failing audit write never turns a completed purge into a 5xx
 *      (failure injection at the pool boundary).
 *   D. Established behaviour preserved: non-admin 403 on both routes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { runMigrations } from '../database/runMigrations.js';
import { runSeeds } from '../database/runSeeds.js';
import productionRoutes from '../routes/production.routes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Bulk-operation safety & permission-override persistence (real schema)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let empId = '';
  let managerId = '';
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);
  const adminAuth = () => ({ Authorization: `Bearer ${sign({ id: adminId, employeeId: 'BOADMIN', role: 'ADMIN', email: 'boadmin@t.test', name: 'Admin' })}` });
  const managerAuth = () => ({ Authorization: `Bearer ${sign({ id: managerId, employeeId: 'BOMGR', role: 'MANAGER', email: 'bomgr@t.test', name: 'Mgr' })}` });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await runMigrations();
    await runSeeds();

    const roles = await q(`SELECT id, role_code FROM roles WHERE role_code IN ('ADMIN','MANAGER','EMPLOYEE')`);
    const roleId = (code: string) => roles.rows.find((r: any) => r.role_code === code).id;
    const dept = await q(`INSERT INTO departments (department_code, department_name) VALUES ('BO', 'Bulk Ops') RETURNING id`);
    const mk = async (emp: string, role: string, mgr: string | null) => {
      const r = await q(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $1, $2, 'hash', $3, $4, $5, TRUE) RETURNING id`,
        [emp, `${emp.toLowerCase()}@t.test`, roleId(role), dept.rows[0].id, mgr]
      );
      return r.rows[0].id as string;
    };
    adminId = await mk('BOADMIN', 'ADMIN', null);
    managerId = await mk('BOMGR', 'MANAGER', adminId);
    empId = await mk('BOEMP', 'EMPLOYEE', managerId);

    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', productionRoutes);
  });

  after(async () => {
    try { _resetPoolsForTest(); } catch { /* ignore */ }
    try { resetPGlite(); } catch { /* ignore */ }
  });

  async function insertLead(code: string, campaign: string | null) {
    const r = await q(
      `INSERT INTO leads (lead_code, customer_name, mobile, created_by, assigned_to, current_status, custom_fields)
       VALUES ($1, $1, $2, $3, $4, 'Interested', $5::jsonb) RETURNING id`,
      [code, '0170' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), adminId, empId, JSON.stringify(campaign === null ? {} : { campaignName: campaign })]
    );
    return r.rows[0].id as string;
  }
  const activeCount = async () => Number((await q(`SELECT COUNT(*)::int AS c FROM leads WHERE is_deleted = FALSE`)).rows[0].c);
  const auditRows = async (code: string) => (await q(`SELECT actor_user_id, entity_type, metadata FROM audit_logs WHERE action_code = $1 ORDER BY created_at`, [code])).rows;

  /* ------------------------------------------------------------------ */
  it('A. PUT /users/:id/permissions persists overrides on the migrated user_permissions table (granted_at regression)', async () => {
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_permissions'`);
    assert.ok(!cols.rows.some((c: any) => c.column_name === 'granted_at'), 'precondition: the real schema has no granted_at column');

    const first = await request(app).put(`/api/users/${empId}/permissions`).set(adminAuth()).send({
      permissions: [{ code: 'leads.export', allowed: true, reason: 'audit test' }, { code: 'does.not.exist', allowed: true }],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const rows = await q(
      `SELECT up.is_allowed, up.reason, p.permission_code FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = $1`,
      [empId]
    );
    assert.equal(rows.rows.length, 1, 'unknown codes are ignored, known code persisted');
    assert.equal(rows.rows[0].permission_code, 'leads.export');
    assert.equal(rows.rows[0].is_allowed, true);

    // Idempotent re-save flips the value through the ON CONFLICT path.
    const second = await request(app).put(`/api/users/${empId}/permissions`).set(adminAuth()).send({ permissions: [{ code: 'leads.export', allowed: false }] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const after = await q(`SELECT is_allowed FROM user_permissions WHERE user_id = $1`, [empId]);
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].is_allowed, false);

    // null → override removed.
    const cleared = await request(app).put(`/api/users/${empId}/permissions`).set(adminAuth()).send({ permissions: [{ code: 'leads.export', allowed: null }] });
    assert.equal(cleared.status, 200);
    assert.equal((await q(`SELECT COUNT(*)::int AS c FROM user_permissions WHERE user_id = $1`, [empId])).rows[0].c, 0);

    // Non-admin without permissions.manage stays 403 (established behaviour).
    const denied = await request(app).put(`/api/users/${empId}/permissions`).set(managerAuth()).send({ permissions: [{ code: 'leads.export', allowed: true }] });
    assert.equal(denied.status, 403);
  });

  /* ------------------------------------------------------------------ */
  it('B. campaign purge fails closed on blank filters, stays scoped, and is audited with counts only', async () => {
    await insertLead('BO-C1', 'Spring Drive');
    await insertLead('BO-C2', 'Spring Drive');
    await insertLead('BO-C3', 'Other');
    await insertLead('BO-C4', '');          // literally empty campaign name
    await insertLead('BO-C5', null);        // no campaign key at all
    const before = await activeCount();
    assert.equal(before, 5);

    // Blank / whitespace names → 400, nothing deleted.
    for (const blank of ['%20', '%20%20', '%09']) {
      const r = await request(app).delete(`/api/leads/campaign/${blank}`).set(adminAuth());
      assert.equal(r.status, 400, `blank "${blank}" → ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(r.body.message, /campaign name is required/i);
    }
    assert.equal(await activeCount(), before, 'blank filters must not touch any row');
    assert.equal((await auditRows('LEAD_CAMPAIGN_PURGE')).length, 0, 'rejected requests are not audited as purges');

    // Non-admin still denied, nothing deleted.
    const denied = await request(app).delete('/api/leads/campaign/Spring%20Drive').set(managerAuth());
    assert.equal(denied.status, 403);
    assert.equal(await activeCount(), before);

    // Real purge: exact-campaign scope only.
    const purge = await request(app).delete('/api/leads/campaign/Spring%20Drive').set(adminAuth());
    assert.equal(purge.status, 200, JSON.stringify(purge.body));
    assert.equal(purge.body.deleted, 2);
    assert.equal(await activeCount(), 3);
    const remaining = await q(`SELECT lead_code FROM leads WHERE is_deleted = FALSE ORDER BY lead_code`);
    assert.deepEqual(remaining.rows.map((r: any) => r.lead_code), ['BO-C3', 'BO-C4', 'BO-C5']);
    const deleted = await q(`SELECT deleted_by, deleted_at FROM leads WHERE lead_code = 'BO-C1'`);
    assert.equal(deleted.rows[0].deleted_by, adminId);
    assert.ok(deleted.rows[0].deleted_at, 'soft-delete sets deleted_at (integrity invariant leads.soft_delete_inconsistent)');

    // Aggregate audit row: actor + counts, no lead payload / campaign text.
    const audits = await auditRows('LEAD_CAMPAIGN_PURGE');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, adminId);
    assert.equal(audits[0].entity_type, 'lead');
    assert.equal(audits[0].metadata.deleted, 2);
    assert.equal(audits[0].metadata.campaignNameLength, 'Spring Drive'.length);
    assert.ok(!JSON.stringify(audits[0].metadata).includes('Spring Drive'), 'audit metadata carries counts, not the filter text');

    // Second purge of the same campaign: nothing left, still 200 + audited with 0.
    const again = await request(app).delete('/api/leads/campaign/Spring%20Drive').set(adminAuth());
    assert.equal(again.status, 200);
    assert.equal(again.body.deleted, 0);
    assert.equal((await auditRows('LEAD_CAMPAIGN_PURGE')).length, 2);
  });

  /* ------------------------------------------------------------------ */
  it('C. clear-all is admin-only, audited, and an audit failure never masks the completed purge', async () => {
    const denied = await request(app).post('/api/leads/clear-all').set(managerAuth());
    assert.equal(denied.status, 403);
    const before = await activeCount();
    assert.ok(before >= 3);

    // Failure injection: audit_logs INSERT fails at the pool boundary while
    // the purge UPDATE succeeds. The route must still report the real
    // outcome (200 + count) — the purge already committed.
    const realPool = pool;
    const failingAuditPool = {
      query: async (sql: string, params?: any[]) => {
        if (/INSERT INTO audit_logs/i.test(sql)) {
          const err: any = new Error('permission denied for table audit_logs');
          err.code = '42501';
          throw err;
        }
        return realPool.query(sql, params);
      },
      connect: () => realPool.connect(),
      on: () => undefined,
      end: async () => undefined,
    };
    _setTestPoolForTest(failingAuditPool);
    let cleared: any;
    try {
      cleared = await request(app).post('/api/leads/clear-all').set(adminAuth());
    } finally {
      _setTestPoolForTest(realPool);
    }
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.deleted, before);
    assert.equal(await activeCount(), 0);
    assert.equal((await auditRows('LEAD_CLEAR_ALL')).length, 0, 'audit was injected to fail');

    // Normal path writes the aggregate audit row.
    await insertLead('BO-C6', 'Late');
    const ok = await request(app).post('/api/leads/clear-all').set(adminAuth());
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deleted, 1);
    const audits = await auditRows('LEAD_CLEAR_ALL');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, adminId);
    assert.equal(audits[0].metadata.deleted, 1);
    assert.equal(Object.keys(audits[0].metadata).sort().join(','), 'deleted', 'counts only');
  });
});
