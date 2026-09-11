import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';

/**
 * FORCED FIRST-LOGIN PASSWORD CHANGE — real PostgreSQL (PGlite) + the real
 * production router, exactly like the other integration tests.
 *
 * Proves the three password flows stay distinct:
 *   1. ADMIN reset          -> POST /users/:id/reset-password (ADMIN-only)
 *   2. normal self-service  -> POST /auth/change-password (verifies current)
 *   3. forced first-login   -> POST /auth/change-required-password (self-only)
 *
 * The forced flag is server-authoritative (users.must_change_password), mapped
 * through mapUserRow into login + session payloads, and cleared atomically
 * with the hash update on the dedicated endpoint.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

async function setupSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(30) UNIQUE NOT NULL,
      department_name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(30) UNIQUE NOT NULL,
      role_name VARCHAR(100) NOT NULL,
      hierarchy_level INTEGER NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
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
      phone VARCHAR(20),
      password VARCHAR(255) NOT NULL,
      role_id UUID,
      department_id UUID,
      team_id UUID,
      manager_id UUID,
      designation VARCHAR(100),
      profile_photo TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      account_status VARCHAR(20) DEFAULT 'ACTIVE',
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
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
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
    CREATE TABLE IF NOT EXISTS hierarchies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE,
      manager_id UUID,
      level INTEGER NOT NULL DEFAULT 1,
      path TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
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
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

describe('Forced first-login password change', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId: string;
  let employeeRoleId: string;
  let editorRoleId: string;
  let deptId: string;

  let admin: { id: string; employeeId: string; email: string; role: string; password: string };
  let forced: { id: string; employeeId: string; email: string; role: string; password: string };
  let forced2: { id: string; employeeId: string; email: string; role: string; password: string };
  let normal: { id: string; employeeId: string; email: string; role: string; password: string };
  let editor: { id: string; employeeId: string; email: string; role: string; password: string };

  const FORCED_TEMP_PASSWORD = 'TempPass123';
  const FORCED2_TEMP_PASSWORD = 'TempPass2!';
  const NORMAL_PASSWORD = 'NormalPass1';

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    await pool.query(`DELETE FROM audit_logs`);
    await pool.query(`DELETE FROM hierarchies`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);
    await pool.query(`DELETE FROM departments`);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`);
    deptId = deptRes.rows[0].id;

    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 99, 'Organization') RETURNING id`);
    adminRoleId = adminRoleRes.rows[0].id;
    const empRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 99, 'Own') RETURNING id`);
    employeeRoleId = empRoleRes.rows[0].id;
    const editorRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EDITOR', 'Editor', 99, 'Own') RETURNING id`);
    editorRoleId = editorRoleRes.rows[0].id;

    // The editor role holds users.edit (to prove the credential boundary: a
    // users.edit holder still cannot reset another account's password).
    const editPermRes: any = await pool.query(`INSERT INTO permissions (permission_code, module_name, action_name) VALUES ('users.edit', 'Users', 'EDIT') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [editorRoleId, editPermRes.rows[0].id]);

    const mk = async (emp: string, name: string, email: string, password: string, roleId: string, mustChange: boolean) => {
      const hash = await bcrypt.hash(password, 10);
      const res: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active, account_status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'ACTIVE', $7) RETURNING id`,
        [emp, name, email, hash, roleId, deptId, mustChange]
      );
      return res.rows[0].id;
    };

    admin = { id: await mk('ADMIN1', 'Admin User', 'admin@test.com', 'AdminPass123', adminRoleId, false), employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN', password: 'AdminPass123' };
    forced = { id: await mk('FORCED1', 'Forced User', 'forced@test.com', FORCED_TEMP_PASSWORD, employeeRoleId, true), employeeId: 'FORCED1', email: 'forced@test.com', role: 'EMPLOYEE', password: FORCED_TEMP_PASSWORD };
    forced2 = { id: await mk('FORCED2', 'Forced Two', 'forced2@test.com', FORCED2_TEMP_PASSWORD, employeeRoleId, true), employeeId: 'FORCED2', email: 'forced2@test.com', role: 'EMPLOYEE', password: FORCED2_TEMP_PASSWORD };
    normal = { id: await mk('NORMAL1', 'Normal User', 'normal@test.com', NORMAL_PASSWORD, employeeRoleId, false), employeeId: 'NORMAL1', email: 'normal@test.com', role: 'EMPLOYEE', password: NORMAL_PASSWORD };
    editor = { id: await mk('EDITOR1', 'Editor User', 'editor@test.com', 'EditorPass1', editorRoleId, false), employeeId: 'EDITOR1', email: 'editor@test.com', role: 'EDITOR', password: 'EditorPass1' };

    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // Reset the forced users to a known temp-password + flag state so each
    // case is independent regardless of execution order.
    const reset = async (emp: string, password: string, mustChange: boolean) => {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(`UPDATE users SET password = $1, must_change_password = $2 WHERE employee_id = $3`, [hash, mustChange, emp]);
    };
    await reset('FORCED1', FORCED_TEMP_PASSWORD, true);
    await reset('FORCED2', FORCED2_TEMP_PASSWORD, true);
    await reset('NORMAL1', NORMAL_PASSWORD, false);
  });

  const token = (u: any) => signToken({ id: u.id, employeeId: u.employeeId, role: u.role, email: u.email, name: u.employeeId });

  /* ------------------------------------------------------------------ */
  /* Server-authoritative flag: login + session reflect the real DB      */
  /* ------------------------------------------------------------------ */

  it('1. newly created user persists mustChangePassword=true (POST /api/users)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${token(admin)}`)
      .send({
        employeeId: 'NEWEMP1',
        fullName: 'New Employee',
        email: 'newemp1@test.com',
        role: 'EMPLOYEE',
        departmentId: deptId,
        password: 'TempPass123',
        mustChangePassword: true,
      });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.mustChangePassword, true, 'create response must reflect the persisted flag');

    const pg: any = await pool.query(`SELECT must_change_password FROM users WHERE employee_id = 'NEWEMP1'`);
    assert.equal(pg.rows.length, 1);
    assert.equal(pg.rows[0].must_change_password, true, 'PostgreSQL must store the flag, not just return it');
  });

  it('2. login returns mustChangePassword=true when the DB says true', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'FORCED1', password: FORCED_TEMP_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.mustChangePassword, true);
  });

  it('3. GET /api/auth/session returns the real flag (true and false)', async () => {
    const forcedRes = await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token(forced)}`);
    assert.equal(forcedRes.status, 200);
    assert.equal(forcedRes.body.data.mustChangePassword, true);

    const normalRes = await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token(normal)}`);
    assert.equal(normalRes.status, 200);
    assert.equal(normalRes.body.data.mustChangePassword, false);
  });

  /* ------------------------------------------------------------------ */
  /* Dedicated forced-change endpoint                                     */
  /* ------------------------------------------------------------------ */

  it('4. forced user changes THEIR OWN password without users.edit / admin / Settings access', async () => {
    // FORCED1 is an EMPLOYEE role with no users.edit grant and no admin role.
    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'NewPass456' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.id, forced.id, 'the caller, not a client-supplied target, is changed');
    assert.equal(res.body.data.mustChangePassword, false, 'server returns the cleared flag');
    assert.equal(res.body.data.password, undefined, 'no credential material in the response');
    assert.equal(res.body.data.passwordHash, undefined);

    const pg: any = await pool.query(`SELECT password, must_change_password FROM users WHERE id = $1`, [forced.id]);
    assert.equal(pg.rows[0].must_change_password, false, 'flag cleared in PostgreSQL');
    assert.ok(String(pg.rows[0].password).startsWith('$2'), 'password is stored as a bcrypt hash');
  });

  it('5. successful change: hash changes, old password fails, new password works', async () => {
    const before: any = await pool.query(`SELECT password FROM users WHERE id = $1`, [forced.id]);
    const oldHash = before.rows[0].password;

    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'NewPass456' });
    assert.equal(res.status, 200);

    const after: any = await pool.query(`SELECT password, must_change_password FROM users WHERE id = $1`, [forced.id]);
    assert.notEqual(after.rows[0].password, oldHash, 'the hash must change');
    assert.equal(after.rows[0].must_change_password, false);

    const oldLogin = await request(app).post('/api/auth/login').send({ employeeId: 'FORCED1', password: FORCED_TEMP_PASSWORD });
    assert.equal(oldLogin.status, 401, 'the temporary password must no longer work');

    const newLogin = await request(app).post('/api/auth/login').send({ employeeId: 'FORCED1', password: 'NewPass456' });
    assert.equal(newLogin.status, 200, 'the new password must work');
  });

  it('6. special endpoint rejects the caller when the flag is false (fail closed, no change)', async () => {
    const before: any = await pool.query(`SELECT password FROM users WHERE id = $1`, [normal.id]);
    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(normal)}`)
      .send({ newPassword: 'ShouldNotWork1' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body.message), /required/i);

    const after: any = await pool.query(`SELECT password FROM users WHERE id = $1`, [normal.id]);
    assert.equal(after.rows[0].password, before.rows[0].password, 'password must not change through the forced endpoint');
  });

  it('7. forced user cannot change another user\u2019s password (client-supplied target ignored)', async () => {
    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'Hijack999', userId: forced2.id, employeeId: 'FORCED2' });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, forced.id, 'only the caller is ever changed');

    // forced2 keeps its original temp password and can still log in with it.
    const stillWorks = await request(app).post('/api/auth/login').send({ employeeId: 'FORCED2', password: FORCED2_TEMP_PASSWORD });
    assert.equal(stillWorks.status, 200, 'the other forced user is untouched');
  });

  it('8. a failed change (validation) does not clear the forced flag or change the password', async () => {
    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'abc' });
    assert.equal(res.status, 400);

    const pg: any = await pool.query(`SELECT must_change_password FROM users WHERE id = $1`, [forced.id]);
    assert.equal(pg.rows[0].must_change_password, true, 'flag stays true after a failed change');

    const oldLogin = await request(app).post('/api/auth/login').send({ employeeId: 'FORCED1', password: FORCED_TEMP_PASSWORD });
    assert.equal(oldLogin.status, 200, 'the temporary password still works after a failed change');
  });

  it('9. no plaintext password or bcrypt hash appears in any response body', async () => {
    const ok = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'NewPass456' });
    const okBody = JSON.stringify(ok.body);
    assert.equal(okBody.includes('NewPass456'), false, 'the new plaintext password must not be echoed');
    assert.equal(okBody.includes('$2'), false, 'no bcrypt hash may be returned');

    const rejected = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(normal)}`)
      .send({ newPassword: 'ShouldNotWork1' });
    assert.equal(JSON.stringify(rejected.body).includes('ShouldNotWork1'), false);
  });

  it('10. records a security-safe audit event without password material', async () => {
    await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ newPassword: 'NewPass456' });

    const pg: any = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = 'required-password-change-completed' AND actor_user_id = $1`,
      [forced.id]
    );
    assert.ok(pg.rows.length >= 1, 'a required-password-change-completed event is recorded');
    const meta = pg.rows[0].metadata;
    assert.equal(JSON.stringify(meta).includes('NewPass456'), false);
    assert.equal(JSON.stringify(meta).includes('$2'), false);
  });

  /* ------------------------------------------------------------------ */
  /* Admin reset stays ADMIN-only and distinct                           */
  /* ------------------------------------------------------------------ */

  it('11. admin reset remains ADMIN/SUPERADMIN only', async () => {
    const nonAdmin = await request(app)
      .post(`/api/users/${normal.id}/reset-password`)
      .set('Authorization', `Bearer ${token(editor)}`)
      .send({ password: 'ResetByEditor1' });
    assert.equal(nonAdmin.status, 403, 'a non-admin (even a users.edit holder) cannot reset');

    const employee = await request(app)
      .post(`/api/users/${normal.id}/reset-password`)
      .set('Authorization', `Bearer ${token(forced)}`)
      .send({ password: 'ResetByEmp1' });
    assert.equal(employee.status, 403, 'an employee cannot reset');
  });

  it('12. admin reset sets mustChangePassword=true', async () => {
    const res = await request(app)
      .post(`/api/users/${normal.id}/reset-password`)
      .set('Authorization', `Bearer ${token(admin)}`)
      .send({ password: 'ResetPass1' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const pg: any = await pool.query(`SELECT must_change_password FROM users WHERE id = $1`, [normal.id]);
    assert.equal(pg.rows[0].must_change_password, true, 'admin reset re-imposes the forced-change requirement');
  });

  it('13. generic users.edit cannot reset another account\u2019s password', async () => {
    const before: any = await pool.query(`SELECT password FROM users WHERE id = $1`, [normal.id]);
    const res = await request(app)
      .put(`/api/users/${normal.id}`)
      .set('Authorization', `Bearer ${token(editor)}`)
      .send({ password: 'SneakyReset1' });
    assert.equal(res.status, 403, 'the credential boundary rejects users.edit password writes');

    const after: any = await pool.query(`SELECT password FROM users WHERE id = $1`, [normal.id]);
    assert.equal(after.rows[0].password, before.rows[0].password, 'password unchanged');
  });

  it('14. normal self-service password change remains unchanged (still verifies current password)', async () => {
    const wrongCurrent = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token(normal)}`)
      .send({ userId: normal.id, currentPassword: 'WrongPass', newPassword: 'NormalPass2' });
    assert.equal(wrongCurrent.status, 401, 'current-password verification is preserved');

    const ok = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token(normal)}`)
      .send({ userId: normal.id, currentPassword: NORMAL_PASSWORD, newPassword: 'NormalPass2' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const login = await request(app).post('/api/auth/login').send({ employeeId: 'NORMAL1', password: 'NormalPass2' });
    assert.equal(login.status, 200);
  });

  /* ------------------------------------------------------------------ */
  /* Source guards                                                       */
  /* ------------------------------------------------------------------ */

  const ROOT = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('15. AppLayout cannot bypass the forced flow via generic user edit', () => {
    const src = read('src/layouts/AppLayout.tsx');
    assert.match(src, /changeRequiredPassword/, 'the forced modal must use the dedicated endpoint');
    const forcedBlock = src.slice(src.indexOf('if (user && user.mustChangePassword)'), src.indexOf('const userRoleName'));
    assert.doesNotMatch(forcedBlock, /updateUser/, 'the forced modal must not route through generic user-edit logic');
    assert.match(forcedBlock, /setUser\(updatedUser\)/, 'the store is updated from the server response');
  });

  it('16. the forced-change endpoint carries no admin/permission/feature gate', () => {
    const src = stripComments(read('server/routes/production.routes.ts'));
    const start = src.indexOf("router.post('/auth/change-required-password'");
    assert.ok(start >= 0, 'endpoint must be registered');
    // Slice just this endpoint: from its registration to the next route
    // (GET /users/check-admin opens the USERS section).
    const end = src.indexOf("router.get('/users/check-admin'");
    assert.ok(end > start, 'the USERS section must follow the forced-change endpoint');
    const block = src.slice(start, end);
    assert.doesNotMatch(block, /requirePermissionCode/, 'no canonical action permission gate');
    assert.doesNotMatch(block, /requireAdmin/, 'no admin gate');
    assert.doesNotMatch(block, /requireRole\(/, 'no role gate');
    assert.match(block, /requireAuth/, 'authenticated session is still required');
    assert.doesNotMatch(block, /req\.body\?\.userId/, 'no client-supplied target id is read');
  });
});
