/**
 * user-permission-override-write.test.ts
 * ------------------------------------------------------------------
 * Regression guard for the per-user permission override write path
 * (`PUT /api/users/:id/permissions` — the User Management → Enterprise
 * Access panel).
 *
 * Why this test exists: the handler's INSERT named a `granted_at` column
 * that NO migration ever creates on `user_permissions` (migration 027 is
 * the only creator). Every real database therefore answered
 *
 *   500  column "granted_at" of relation "user_permissions" does not exist
 *
 * for every override save — while the older integration suites stayed
 * green because each of them hand-writes its own `user_permissions`
 * fixture that INCLUDED that column. The lesson is the fixture: this
 * suite builds the table by running the REAL migration, so the schema
 * under test is the schema a customer database actually has. Any future
 * drift between the endpoint's statement and the shipped migration fails
 * here instead of in production.
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

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Per-user permission overrides — write path against the shipped schema', () => {
  let pool: any;
  let app: express.Express;
  let adminUserId = '';
  let targetUserId = '';

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    // Minimal parents: the override table's FK targets, plus `roles`,
    // which getCallerDbInfo() LEFT JOINs — without it the caller cannot be
    // resolved and every gated route answers 403 for the wrong reason.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(30) UNIQUE,
        role_name VARCHAR(150),
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(50) UNIQUE,
        email VARCHAR(150),
        role_id UUID,
        department_id UUID,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // The read path joins the role-grant table; the caller resolver reads
    // users.email / users.department_id. Both are part of the shipped
    // schema (004_users / 026_role_permissions) — keep the fixture honest.
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
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        module_name VARCHAR(100),
        action_name VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    // THE POINT: the override table comes from the migration, not a fixture.
    await migration027.up();

    const adminRole = await pool.query(
      `INSERT INTO roles (role_code, role_name) VALUES ('ADMIN', 'System Admin') RETURNING id`
    );
    const officerRole = await pool.query(
      `INSERT INTO roles (role_code, role_name) VALUES ('OFFICER', 'Officer') RETURNING id`
    );
    const admin = await pool.query(
      `INSERT INTO users (employee_id, email, role_id) VALUES ('ADMIN1', 'admin@test.com', $1) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminUserId = admin.rows[0].id;
    const target = await pool.query(
      `INSERT INTO users (employee_id, email, role_id) VALUES ('OFF1', 'off1@test.com', $1) RETURNING id`,
      [officerRole.rows[0].id]
    );
    targetUserId = target.rows[0].id;
    await pool.query(
      `INSERT INTO permissions (permission_code, module_name, action_name)
       VALUES ('audit.view', 'Users', 'VIEW') ON CONFLICT (permission_code) DO NOTHING`
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

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN1', role: 'ADMIN' });

  it('the shipped schema really lacks granted_at (the fixture-only column)', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_permissions' ORDER BY column_name`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    assert.ok(names.includes('is_allowed'), 'is_allowed must exist');
    assert.ok(names.includes('reason'), 'reason must exist');
    assert.ok(names.includes('created_at') && names.includes('updated_at'), 'timestamps must exist');
    assert.equal(
      names.includes('granted_at'),
      false,
      'if a future migration adds granted_at the endpoint may use it — update this test, not the fixture'
    );
  });

  it('an ADMIN can store a DENY override (200, never 500)', async () => {
    const res = await request(app)
      .put(`/api/users/${targetUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'audit.view', allowed: false, reason: 'unit test' }] });

    assert.notEqual(res.status, 500, `override save must not 500: ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await pool.query(
      `SELECT up.is_allowed, up.reason
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id = $1 AND p.permission_code = 'audit.view'`,
      [targetUserId]
    );
    assert.equal(row.rows.length, 1, 'the override row must be stored');
    assert.equal(row.rows[0].is_allowed, false);
  });

  it('an ALLOW override upserts (no duplicate row) and null clears it', async () => {
    const allow = await request(app)
      .put(`/api/users/${targetUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'audit.view', allowed: true }] });
    assert.equal(allow.status, 200, JSON.stringify(allow.body));

    const cleared = await request(app)
      .put(`/api/users/${targetUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'audit.view', allowed: null }] });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

    const rows = await pool.query('SELECT 1 FROM user_permissions WHERE user_id = $1', [targetUserId]);
    assert.equal(rows.rows.length, 0, 'allowed:null must delete the override row');
  });

  it('the read path keeps exposing user_override for the client', async () => {
    await request(app)
      .put(`/api/users/${targetUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: [{ code: 'audit.view', allowed: true }] });

    const read = await request(app)
      .get(`/api/users/${targetUserId}/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const row = (read.body?.data || []).find((r: any) => r.permission_code === 'audit.view');
    assert.ok(row, 'the sheet must contain the permission row');
    assert.equal(row.user_override, true, 'the override must be reported to the client');
  });
});
