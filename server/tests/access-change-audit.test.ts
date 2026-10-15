/**
 * access-change-audit.test.ts
 * ------------------------------------------------------------------
 * F16 Phase B — two guarantees the audit of the admin surface asked for
 * (design note §7, "access-hardening tooling"):
 *
 *  1. ACCESS CHANGES LEAVE A LEDGER ENTRY.
 *     Before this suite the only audit writers were the password-change
 *     flow and the bulk user import: an admin could grant or deny any
 *     permission, for a whole role or one person, and nothing recorded
 *     who did it. The write path now logs
 *     `role-permissions-update`, `user-permission-overrides-update`,
 *     `role-save` and `role-delete` with actor + target + a bounded
 *     summary of the change.
 *
 *  2. THE LEDGER IS BEST-EFFORT, THE CHANGE IS NOT.
 *     A minimal/older schema may lack `audit_logs`; a failed audit write
 *     must never turn a successful access change into a 500. The table is
 *     created by the REAL migration 032 here, and one test drops it to
 *     prove the mutation still succeeds and reports success.
 *
 *  Plus: the last-active-administrator lockout guard (demote / deactivate
 *  / delete) had NO test coverage; it is pinned here so a future refactor
 *  cannot silently strand an organization with no administrator.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import * as migration027 from '../database/migrations/027_user_permissions.js';
import * as migration032 from '../database/migrations/032_audit_logs.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Access-change audit + last-administrator protection', () => {
  let pool: any;
  let app: express.Express;
  let adminUserId = '';
  let officerUserId = '';
  let officerRoleId = '';
  let memberRoleId = '';

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(30) UNIQUE,
        role_name VARCHAR(150),
        hierarchy_level INT DEFAULT 99,
        description TEXT,
        data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB,
        actions JSONB,
        feature_permissions JSONB,
        is_system BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(50) UNIQUE,
        full_name VARCHAR(200),
        email VARCHAR(150),
        phone VARCHAR(40),
        password TEXT,
        role_id UUID,
        department_id UUID,
        team_id UUID,
        manager_id UUID,
        designation VARCHAR(100),
        profile_photo TEXT,
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
        module_name VARCHAR(100),
        action_name VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE
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
      CREATE TABLE IF NOT EXISTS hierarchies (
        user_id UUID UNIQUE,
        manager_id UUID,
        level INT,
        path JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Shipped migrations create the tables under test — no hand fixtures.
    await migration027.up();
    await migration032.up();

    const adminRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ('ADMIN', 'System Admin', 99) RETURNING id`
    );
    const officerRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ('OFFICER', 'Officer', 99) RETURNING id`
    );
    const memberRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ('FIELD', 'Field Executive', 99) RETURNING id`
    );
    officerRoleId = officerRole.rows[0].id;
    memberRoleId = memberRole.rows[0].id;

    const admin = await pool.query(
      `INSERT INTO users (employee_id, email, role_id) VALUES ('ADMIN1', 'admin@test.com', $1) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminUserId = admin.rows[0].id;
    const officer = await pool.query(
      `INSERT INTO users (employee_id, email, role_id) VALUES ('OFF1', 'off1@test.com', $1) RETURNING id`,
      [officerRole.rows[0].id]
    );
    officerUserId = officer.rows[0].id;

    await pool.query(
      `INSERT INTO permissions (permission_code, module_name, action_name)
       VALUES ('leads.view', 'Leads', 'VIEW'), ('leads.delete', 'Leads', 'DELETE'),
              ('reports.view', 'Reports', 'VIEW')
       ON CONFLICT (permission_code) DO NOTHING`
    );

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });

  const auditRows = async (actionCode: string) =>
    (await pool.query(
      `SELECT actor_user_id, target_user_id, entity_type, entity_id, metadata
         FROM audit_logs WHERE action_code = $1 ORDER BY created_at ASC`,
      [actionCode]
    )).rows;

  it('a role permission change writes exactly one ledger entry with actor + change', async () => {
    const res = await request(app)
      .put(`/api/roles/${officerRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'leads.view', allowed: true }, { code: 'leads.delete', allowed: false }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await auditRows('role-permissions-update');
    assert.equal(rows.length, 1, 'exactly one entry per save');
    assert.equal(rows[0].actor_user_id, adminUserId, 'actor must be the admin who saved');
    assert.equal(rows[0].entity_type, 'role');
    assert.equal(rows[0].entity_id, officerRoleId);
    assert.equal(rows[0].metadata.total, 2);
    assert.deepEqual(rows[0].metadata.granted, ['leads.view']);
    assert.deepEqual(rows[0].metadata.denied, ['leads.delete']);
  });

  it('a per-user override writes an entry naming the target user', async () => {
    const res = await request(app)
      .put(`/api/users/${officerUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'reports.view', allowed: false, reason: 'phase B test' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await auditRows('user-permission-overrides-update');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, adminUserId);
    assert.equal(rows[0].target_user_id, officerUserId, 'the ledger must name whose access moved');
    assert.equal(rows[0].entity_type, 'user');
    assert.deepEqual(rows[0].metadata.denied, ['reports.view']);

    // cleanup so later assertions start from a clean slate
    await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [officerUserId]);
  });

  it('a role save records the page-visibility summary', async () => {
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        roleId: 'AUDITTEST', roleName: 'Audit Test', hierarchyLevel: 99,
        dataVisibility: 'DownTeam',
        menuAccess: { '/leads': true, '/reports': true, '/users': false },
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await auditRows('role-save');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.roleId, 'AUDITTEST');
    assert.equal(rows[0].metadata.dataVisibility, 'DownTeam');
    assert.deepEqual([...rows[0].metadata.menuPathsGranted].sort(), ['/leads', '/reports'], 'only granted paths are recorded');
  });

  it('the ledger is best-effort: a missing audit_logs table never fails the change', async () => {
    await pool.query('DROP TABLE IF EXISTS audit_logs');
    const res = await request(app)
      .put(`/api/roles/${memberRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'leads.view', allowed: true }] });
    assert.equal(res.status, 200, 'the mutation must succeed even when the ledger cannot be written');

    const stored = await pool.query(
      `SELECT rp.is_allowed FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND p.permission_code = 'leads.view'`,
      [memberRoleId]
    );
    assert.equal(stored.rows[0]?.is_allowed, true, 'the grant itself must be persisted');

    await migration032.up(); // restore for the rest of the run
  });

  it('the last active administrator cannot be demoted, deactivated or deleted', async () => {
    // Single-admin org (this suite created exactly one ADMIN).
    const demote = await request(app)
      .put(`/api/users/${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'FIELD' });
    assert.equal(demote.status, 409, 'demoting the last admin must be refused: ' + JSON.stringify(demote.body));
    // (message body printed on failure above so the guard, not an unrelated
    // validation, is what answered)
    assert.match(String(demote.body?.message || ''), /last active administrator/i);

    const deactivate = await request(app)
      .put(`/api/users/${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Inactive' });
    assert.equal(deactivate.status, 409, 'deactivating the last admin must be refused');

    const remove = await request(app)
      .delete(`/api/users/${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    // Two guards can answer here — the self-delete guard (400) when the
    // caller is the admin themselves, the last-admin guard (409) when a
    // SUPERADMIN tries it. Both must refuse; anything else is a hole.
    assert.ok([400, 409].includes(remove.status), 'deleting the sole admin must be refused: ' + JSON.stringify(remove.body));
    assert.match(String(remove.body?.message || ''), /own account|last active administrator/i);

    const stillActive = await pool.query('SELECT is_active FROM users WHERE id = $1', [adminUserId]);
    assert.equal(stillActive.rows[0].is_active, true, 'the admin account must be untouched');
  });

  it('with a second administrator present the demotion is allowed (guard is about the LAST one)', async () => {
    const second = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ employeeId: 'ADMIN2', fullName: 'Second Admin', email: 'admin2@test.com', role: 'ADMIN' });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const demote = await request(app)
      .put(`/api/users/${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'FIELD' });
    // 200 = demoted, or 400 only if an unrelated validation (e.g. reporting
    // link) complains — but it must NOT be the last-admin lockout (409).
    assert.notEqual(demote.status, 409, 'a second admin makes the demotion legal: ' + JSON.stringify(demote.body));
  });
});
