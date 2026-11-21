/**
 * admin-audit-log.test.ts
 * ------------------------------------------------------------------
 * Admin Audit Log page (2026-11-20, ported from PR #161): the
 * enriched /audit-logs endpoint (actor/target names + Employee IDs)
 * and the admin-only /audit-log page that reads it.
 *
 *   1. Endpoint — an admin caller sees the enriched rows (names +
 *      employee IDs for actor and target); a row with no target and
 *      a row whose actor no longer exists still come back (LEFT
 *      JOIN, nulls — never dropped); a non-admin WITH the audit.view
 *      grant reads fine (the gate is the grant, not the role); a
 *      non-admin WITHOUT it gets 403; no token gets 401.
 *   2. Nav — the admin sidebar carries Audit Log in the
 *      ADMINISTRATION group; no other role ever sees it.
 *   3. Route — only ADMIN/SUPERADMIN open /audit-log.
 *   4. Page — source guards: EnterprisePageHeader for its own path,
 *      the /api/audit-logs read, the six columns, search + refresh,
 *      Asia/Dhaka times.
 *
 * Fixture tables use the PRODUCTION column shapes (migrations
 * 004/023/025/026/032) — the standing lesson from the dz5
 * permission_name drift.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import request from 'supertest';
import { fileURLToPath } from 'node:url';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { resolveFeatureRouteAccess } from '../../src/layouts/featureRouteAccess.js';
import {
  buildEnterpriseNavGroups,
  enterpriseHeadingForPath,
} from '../../src/layouts/enterpriseNav.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

describe('admin audit log — endpoint', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let superId = '';
  let bobId = '';
  let carolId = '';

  const adminT = () => signToken({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' });
  const superT = () => signToken({ id: superId, employeeId: 'SUPER1', role: 'SUPERADMIN', email: 'super@test.com', name: 'Super' });
  const bobT = () => signToken({ id: bobId, employeeId: 'BOB', role: 'EMP', email: 'bob@test.com', name: 'Bob' });
  const carolT = () => signToken({ id: carolId, employeeId: 'CAROL', role: 'EMP', email: 'carol@test.com', name: 'Carol' });

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const appMod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', appMod.default);

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
        idra_fa_code VARCHAR(30) UNIQUE,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL DEFAULT '',
        role_id UUID,
        department_id UUID,
        team_id UUID,
        manager_id UUID,
        designation VARCHAR(100),
        phone VARCHAR(30),
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
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id UUID,
        target_user_id UUID,
        action_code VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const mkRole = async (code: string, name: string) => {
      const r = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active)
         VALUES ($1, $2, 99, 'Own', TRUE) RETURNING id`,
        [code, name]
      );
      return r.rows[0].id;
    };
    const adminRoleId = await mkRole('ADMIN', 'Administrator');
    const superRoleId = await mkRole('SUPERADMIN', 'Super Administrator');
    const empRoleId = await mkRole('EMP', 'Employee');
    const auditRoleId = await mkRole('AUDITREADER', 'Audit Reader');

    await pool.query(
      `INSERT INTO permissions (permission_code, module_name, action_name)
       VALUES ('audit.view', 'Users', 'VIEW') ON CONFLICT (permission_code) DO NOTHING`
    );
    // Carol's role holds audit.view; Bob's does not.
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT $1, p.id, TRUE FROM permissions p WHERE p.permission_code = 'audit.view'
       ON CONFLICT (role_id, permission_id) DO UPDATE SET is_allowed = TRUE`,
      [auditRoleId]
    );

    const mkUser = async (emp: string, fullName: string, roleId: string) => {
      const r = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, true) RETURNING id`,
        [emp, fullName, `${emp.toLowerCase()}@test.com`, roleId]
      );
      return r.rows[0].id;
    };
    adminId = await mkUser('ADMIN1', 'Alice Admin', adminRoleId);
    superId = await mkUser('SUPER1', 'Sam Super', superRoleId);
    bobId = await mkUser('BOB', 'Bob Officer', empRoleId);
    carolId = await mkUser('CAROL', 'Carol Reader', auditRoleId);

    // One row with actor + target, one with no target, one whose
    // actor no longer exists (dangling UUID — no FK in the fixture,
    // mirroring ON DELETE SET NULL in production).
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'users.bulk-import', 'user', $2, '{"rows": 5}'::jsonb)`,
      [adminId, bobId]
    );
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, metadata)
       VALUES ($1, NULL, 'settings.update', 'settings', '{}'::jsonb)`,
      [bobId]
    );
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, metadata)
       VALUES ('00000000-0000-0000-0000-000000000000', NULL, 'roles.delete', 'role', '{}'::jsonb)`
    );
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
  });

  it('an admin sees enriched rows: actor/target names + employee IDs', async () => {
    const res = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${adminT()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.data as any[];
    assert.equal(rows.length, 3, 'all three rows come back');

    const imported = rows.find((r: any) => r.action_code === 'users.bulk-import');
    assert.ok(imported, 'the bulk-import row is present');
    assert.equal(imported.actor_name, 'Alice Admin');
    assert.equal(imported.actor_employee_id, 'ADMIN1');
    assert.equal(imported.target_user_id, bobId);
    assert.equal(imported.target_name, 'Bob Officer');
    assert.equal(imported.target_employee_id, 'BOB');

    const settings = rows.find((r: any) => r.action_code === 'settings.update');
    assert.equal(settings.actor_name, 'Bob Officer');
    assert.equal(settings.target_user_id, null);
    assert.equal(settings.target_name, null);

    // A row whose actor no longer exists is NOT dropped by the join.
    const deleted = rows.find((r: any) => r.action_code === 'roles.delete');
    assert.ok(deleted, 'the dangling-actor row still comes back');
    assert.equal(deleted.actor_name, null);
    assert.equal(deleted.actor_employee_id, null);
  });

  it('a superadmin reads the same enriched rows (server bypass)', async () => {
    const res = await request(app).get('/api/audit-logs?limit=1').set('Authorization', `Bearer ${superT()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body.data as any[]).length, 1, 'limit is honoured');
  });

  it('a non-admin WITH the audit.view grant reads fine; WITHOUT it, 403', async () => {
    const allowed = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${carolT()}`);
    assert.equal(allowed.status, 200, 'the gate is the grant, not the role');
    const denied = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(denied.status, 403);
  });

  it('no token gets 401', async () => {
    const res = await request(app).get('/api/audit-logs');
    assert.equal(res.status, 401);
  });
});

describe('admin audit log — nav, route and page', () => {
  it('the admin sidebar carries Audit Log in ADMINISTRATION; no other role sees it', () => {
    const permissive = { canOpen: () => true, canAccess: () => true };
    const adminGroups = buildEnterpriseNavGroups({ role: 'admin', ...permissive });
    const adminGroup = adminGroups.find(g => g.title === 'ADMINISTRATION');
    assert.ok(adminGroup, 'the admin sidebar has an ADMINISTRATION group');
    const item = adminGroup!.items.find(i => i.label === 'Audit Log');
    assert.ok(item, 'Audit Log is in the ADMINISTRATION group');
    assert.equal(item!.path, '/audit-log');

    for (const role of ['manager', 'teamLead', 'agent'] as const) {
      const groups = buildEnterpriseNavGroups({ role, ...permissive });
      const seen = groups.flatMap(g => g.items).some(i => i.path === '/audit-log');
      assert.equal(seen, false, `${role} must never see the Audit Log nav item`);
    }
  });

  it('only ADMIN/SUPERADMIN open /audit-log at the route level', () => {
    assert.equal(resolveFeatureRouteAccess('/audit-log', 'ADMIN', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/audit-log', 'SUPERADMIN', undefined), true);
    for (const role of ['MANAGER', 'TEAM_LEAD', 'RM', 'RO', 'EMPLOYEE', 'CEO']) {
      assert.equal(resolveFeatureRouteAccess('/audit-log', role, undefined), false, `${role} must not open /audit-log`);
    }
  });

  it('the enterprise heading resolves for /audit-log', () => {
    const heading = enterpriseHeadingForPath('admin', '/audit-log');
    assert.equal(heading.title, 'Audit Log');
    assert.ok(heading.sub.length > 0, 'the heading carries a non-empty subtitle');
  });

  it('the page renders the enterprise header, reads /api/audit-logs and shows all six columns', () => {
    const page = read('src/modules/admin/pages/AuditLogPage.tsx');
    assert.ok(page.includes('EnterprisePageHeader'), 'the page uses the enterprise header');
    assert.ok(page.includes('path="/audit-log"'), 'the header is for its own path');
    assert.ok(page.includes("'/api/audit-logs?limit=200'"), 'the page reads the enriched endpoint');
    for (const col of ['Date &amp; time', 'Action', 'Actor', 'Target', 'Record', 'Details']) {
      assert.ok(page.includes(col), `the table shows the ${col} column`);
    }
    assert.ok(page.includes('actor_name'), 'actor names render');
    assert.ok(page.includes('target_name'), 'target names render');
    assert.ok(page.includes("timeZone: 'Asia/Dhaka'"), 'times render in Asia/Dhaka');
    assert.ok(page.includes('Search audit events'), 'search is present');
    assert.ok(page.includes('Refresh audit events'), 'refresh is present');
  });

  it('the route is registered in App.tsx behind AdminRoute + FeatureGate', () => {
    const app = read('src/App.tsx');
    assert.ok(
      app.includes("const AuditLogPage = lazy(() => import('./modules/admin/pages/AuditLogPage'))"),
      'the page is lazy-loaded'
    );
    assert.ok(app.includes("path: '/audit-log'"), 'the route is registered');
    assert.ok(
      app.includes('<FeatureGate route="/audit-log"><LazyPage page={<AdminRoute><AuditLogPage /></AdminRoute>}'),
      'the route sits behind FeatureGate + AdminRoute'
    );
  });
});
