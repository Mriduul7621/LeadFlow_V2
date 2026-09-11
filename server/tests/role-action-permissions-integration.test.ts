/**
 * role-action-permissions-integration.test.ts
 * ------------------------------------------------------------------
 * DB-backed regression for the canonical Role Action Permissions layer
 * exposed in Role Feature Access (PR #28 follow-up):
 *
 *   - `PUT /api/roles/:roleId/permissions` persists grants to
 *     `role_permissions` (NOT localStorage) and `GET` reads them back.
 *   - `hasPermissionCode()` — the server authorization boundary — reflects
 *     those persisted grants.
 *   - View/Create/Edit/Delete/Assign/Transfer/Import/Export are independent.
 *   - Revoking Edit does not revoke View; granting View does not grant Edit.
 *   - Unknown/malformed codes are ignored (never invented) → fail closed.
 *   - Writes are admin-gated; direct API actions stay server-protected.
 *   - ADMIN keeps its bypass regardless of the stored grants.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes, { hasPermissionCode, type CallerDbInfo } from '../routes/production.routes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const LEAD_CODES = [
  'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
  'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
];

describe('Role Action Permissions — server persistence & enforcement', () => {
  let pool: any;
  let app: express.Express;
  let employeeRoleId = '';
  let adminRoleId = '';
  let userId = '';
  const permIds: Record<string, string> = {};

  const adminToken = () => signToken({ id: 'admin-uuid', employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' });
  const employeeToken = () => signToken({ id: userId, employeeId: 'EMP1', role: 'EMPLOYEE', email: 'emp1@test.com', name: 'Emp' });

  function caller(roleCode = 'EMPLOYEE'): CallerDbInfo {
    return {
      id: userId,
      employee_id: 'EMP1',
      email: 'emp1@test.com',
      role_id: employeeRoleId,
      role_code: roleCode,
      department_id: null,
    };
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        module_name VARCHAR(100),
        action_name VARCHAR(100)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
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

    const admin = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Administrator', 1, 'Organization') RETURNING id`
    );
    adminRoleId = admin.rows[0].id;
    const emp = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
    );
    employeeRoleId = emp.rows[0].id;

    for (const code of [...LEAD_CODES, 'dashboard.view']) {
      const r = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, 'leads', 'view') ON CONFLICT DO NOTHING RETURNING id`,
        [code]
      );
      permIds[code] = r.rows[0]?.id || (await pool.query('SELECT id FROM permissions WHERE permission_code = $1', [code])).rows[0].id;
    }

    const u = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('EMP1', 'Emp One', 'emp1@test.com', 'x', $1, true) RETURNING id`,
      [employeeRoleId]
    );
    userId = u.rows[0].id;

    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', productionRoutes);
  });

  after(async () => {
    _resetPoolsForTest();
    await resetPGlite();
    await closePool();
    delete process.env.DATABASE_URL;
  });

  async function grantRolePermissions(grants: Array<{ code: string; allowed: boolean }>): Promise<request.Response> {
    return request(app)
      .put('/api/roles/EMPLOYEE/permissions')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: grants });
  }

  it('PUT persists grants to role_permissions and GET reads them back', async () => {
    const res = await grantRolePermissions([
      { code: 'leads.view', allowed: true },
      { code: 'leads.create', allowed: true },
      { code: 'leads.edit', allowed: false },
      { code: 'leads.assign', allowed: true },
      { code: 'leads.transfer', allowed: false },
      { code: 'leads.import', allowed: true },
      { code: 'leads.export', allowed: true },
      { code: 'leads.delete', allowed: false },
    ]);
    assert.equal(res.status, 200, `PUT should succeed: ${JSON.stringify(res.body)}`);

    const get = await request(app)
      .get('/api/roles/EMPLOYEE/permissions')
      .set('Authorization', `Bearer ${employeeToken()}`);
    assert.equal(get.status, 200);
    const byCode: Record<string, boolean> = {};
    for (const row of get.body.data) byCode[row.code] = row.allowed;

    assert.equal(byCode['leads.view'], true);
    assert.equal(byCode['leads.create'], true);
    assert.equal(byCode['leads.edit'], false);
    assert.equal(byCode['leads.assign'], true);
    assert.equal(byCode['leads.transfer'], false);
    assert.equal(byCode['leads.import'], true);
    assert.equal(byCode['leads.export'], true);
    assert.equal(byCode['leads.delete'], false);
  });

  it('hasPermissionCode reflects the persisted role grants (server boundary)', async () => {
    assert.equal(await hasPermissionCode(caller(), 'leads.view'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.create'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.edit'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.delete'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.assign'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.transfer'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.import'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.export'), true);
  });

  it('revoking Edit does not revoke View (independent actions)', async () => {
    await grantRolePermissions([{ code: 'leads.edit', allowed: false }]);
    assert.equal(await hasPermissionCode(caller(), 'leads.view'), true, 'view must survive edit revocation');
    assert.equal(await hasPermissionCode(caller(), 'leads.edit'), false);
  });

  it('granting View does not grant Edit/Delete (no implicit broadening)', async () => {
    await grantRolePermissions([{ code: 'leads.edit', allowed: false }, { code: 'leads.delete', allowed: false }]);
    assert.equal(await hasPermissionCode(caller(), 'leads.view'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.edit'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.delete'), false);
  });

  it('a mixed configuration (view/create/assign/export on, edit/transfer/import/delete off) is valid and exact', async () => {
    await grantRolePermissions([
      { code: 'leads.view', allowed: true },
      { code: 'leads.create', allowed: true },
      { code: 'leads.edit', allowed: false },
      { code: 'leads.delete', allowed: false },
      { code: 'leads.assign', allowed: true },
      { code: 'leads.transfer', allowed: false },
      { code: 'leads.import', allowed: false },
      { code: 'leads.export', allowed: true },
    ]);
    assert.equal(await hasPermissionCode(caller(), 'leads.view'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.create'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.edit'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.delete'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.assign'), true);
    assert.equal(await hasPermissionCode(caller(), 'leads.transfer'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.import'), false);
    assert.equal(await hasPermissionCode(caller(), 'leads.export'), true);
  });

  it('unknown permission codes are ignored (never invented) — fail closed', async () => {
    const res = await grantRolePermissions([{ code: 'leads.superpower', allowed: true }]);
    assert.equal(res.status, 200);
    // No such row exists and the check remains denied.
    const found = await pool.query("SELECT 1 FROM permissions WHERE permission_code = 'leads.superpower'");
    assert.equal(found.rows.length, 0, 'unknown code must never be created');
    assert.equal(await hasPermissionCode(caller(), 'leads.superpower'), false, 'unknown code must stay fail-closed');
  });

  it('malformed grant payload is rejected or ignored without corrupting state', async () => {
    const res = await request(app)
      .put('/api/roles/EMPLOYEE/permissions')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: '', allowed: true }, { bogus: true }, null] });
    assert.equal(res.status, 200, `malformed entries are skipped: ${JSON.stringify(res.body)}`);
    // Existing grant survives.
    assert.equal(await hasPermissionCode(caller(), 'leads.view'), true);
  });

  it('role permission writes are admin-gated (403 for non-admin)', async () => {
    const res = await request(app)
      .put('/api/roles/EMPLOYEE/permissions')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ permissions: [{ code: 'leads.view', allowed: true }] });
    assert.equal(res.status, 403, 'non-admin must not write role permissions');
  });

  it('ADMIN keeps its bypass regardless of stored grants', async () => {
    const adminCaller: CallerDbInfo = {
      id: 'admin-uuid', employee_id: 'ADMIN1', email: 'admin@test.com',
      role_id: adminRoleId, role_code: 'ADMIN', department_id: null,
    };
    assert.equal(await hasPermissionCode(adminCaller, 'leads.edit'), true, 'ADMIN bypasses even if grants are absent');
    assert.equal(await hasPermissionCode(adminCaller, 'leads.delete'), true);
    assert.equal(await hasPermissionCode(adminCaller, 'dashboard.view'), true);
  });
});
