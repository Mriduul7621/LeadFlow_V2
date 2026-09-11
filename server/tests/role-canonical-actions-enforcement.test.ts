/**
 * role-canonical-actions-enforcement.test.ts
 * ------------------------------------------------------------------
 * DB-backed regression proving that every canonical action permission
 * exposed in the Roles & Access editor is SERVER-ENFORCED on the
 * mounted router (fail closed), not merely a UI toggle:
 *
 *   - Non-admin with NO grants is rejected (403) on every protected
 *     mutation exposed by the editor: users.create / users.edit /
 *     users.delete / permissions.manage / departments.manage /
 *     roles.manage / teams.manage / hierarchy.manage / settings.manage /
 *     workflow.manage.
 *   - Granting exactly one canonical code enables exactly its action
 *     (independence: users.create does not enable users.delete, etc.).
 *   - Credential boundary: users.edit can edit employee details but can
 *     NEVER reset another user's password — neither via the dedicated
 *     reset endpoint (admin-only requireAdmin; the migration-025 catalog
 *     has no dedicated password-reset code and none was invented) nor via
 *     an inline password field on PUT /users/:id.
 *   - ADMIN / SUPERADMIN keep the admin password reset and their bypass
 *     with zero stored grants.
 *   - Unknown codes stay fail-closed and are never invented.
 *   - Existing custom roles gain nothing automatically (no grants seeded).
 *
 * Self-service boundaries are asserted as well: the own-password change
 * endpoint never requires users.edit.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('Canonical action permissions — server enforcement on mounted routes', () => {
  let pool: any;
  let app: express.Express;
  let officerRoleId = '';
  let officerUserId = '';
  let adminUserId = '';
  let superUserId = '';
  let targetUserId = '';
  let departmentId = '';

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' });
  const superToken = () => signToken({ id: superUserId, employeeId: 'SUPER1', role: 'SUPERADMIN', email: 'super@test.com', name: 'Super Admin' });
  const officerToken = () => signToken({ id: officerUserId, employeeId: 'OFF1', role: 'OFFICER', email: 'off1@test.com', name: 'Officer' });

  /** Grant canonical codes to the OFFICER role through the editor's own API. */
  async function grant(grants: Array<{ code: string; allowed: boolean }>): Promise<void> {
    const res = await request(app)
      .put('/api/roles/OFFICER/permissions')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ permissions: grants });
    assert.equal(res.status, 200, `grant PUT must succeed: ${JSON.stringify(res.body)}`);
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
        password VARCHAR(255) NOT NULL DEFAULT '',
        role_id UUID,
        department_id UUID,
        team_id UUID,
        manager_id UUID,
        designation VARCHAR(100),
        profile_photo VARCHAR(500),
        joining_date VARCHAR(30),
        phone VARCHAR(30),
        is_active BOOLEAN DEFAULT TRUE,
        account_status VARCHAR(30) DEFAULT 'ACTIVE',
        must_change_password BOOLEAN DEFAULT FALSE,
        failed_login_attempts INT DEFAULT 0,
        locked_until TIMESTAMP,
        password_changed_at TIMESTAMP,
        last_login TIMESTAMP,
        employee_record_id UUID,
        reporting_chain JSONB DEFAULT '[]'::jsonb,
        subordinates JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(30) UNIQUE,
        department_name VARCHAR(150),
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_code VARCHAR(30) UNIQUE,
        team_name VARCHAR(150),
        department_id UUID,
        leader_id UUID,
        member_ids JSONB DEFAULT '[]'::jsonb,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        title VARCHAR(255),
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
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
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        reason TEXT,
        granted_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_key VARCHAR(100),
        option_value VARCHAR(150),
        option_label VARCHAR(150),
        sort_order INT DEFAULT 0,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (field_key, option_value)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metadata_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) UNIQUE NOT NULL,
        label VARCHAR(150),
        description TEXT,
        is_system BOOLEAN DEFAULT FALSE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status VARCHAR(100) UNIQUE,
        allowed_next_statuses JSONB,
        requires_loss_reason BOOLEAN DEFAULT FALSE,
        requires_meeting_type BOOLEAN DEFAULT FALSE,
        requires_followup_type BOOLEAN DEFAULT FALSE,
        requires_note BOOLEAN DEFAULT FALSE,
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed the canonical permission catalog subset used by this suite
    // (mirrors migration 025; grants can only ever reference these rows).
    const CATALOG = [
      'users.create', 'users.edit', 'users.delete', 'permissions.manage',
      'departments.manage', 'roles.manage', 'teams.manage', 'hierarchy.manage',
      'settings.manage', 'workflow.manage', 'leads.view',
    ];
    for (const code of CATALOG) {
      await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, 'seed', 'seed') ON CONFLICT DO NOTHING`,
        [code]
      );
    }

    // Seed: ADMIN + a non-ladder OFFICER role (level 99, like a custom role).
    const adminRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Administrator', 1, 'Organization') RETURNING id`
    );
    const officerRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('OFFICER', 'Officer', 99, 'Own') RETURNING id`
    );
    officerRoleId = officerRole.rows[0].id;
    const superRole = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('SUPERADMIN', 'Super Administrator', 0, 'Organization') RETURNING id`
    );
    assert.ok(adminRole.rows[0].id);
    assert.ok(superRole.rows[0].id);

    // The OFFICER role starts with NO canonical grants (fail-closed default
    // for existing custom roles — nothing is seeded by the deployment).
    const seededGrants = await pool.query('SELECT COUNT(*)::int AS c FROM role_permissions');
    assert.equal(seededGrants.rows[0].c, 0, 'no role may start with seeded canonical grants');

    const adminUser = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'Admin One', 'admin@test.com', 'x', $1, true) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminUserId = adminUser.rows[0].id;

    const superUser = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('SUPER1', 'Super Admin', 'super@test.com', 'x', $1, true) RETURNING id`,
      [superRole.rows[0].id]
    );
    superUserId = superUser.rows[0].id;

    const officer = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('OFF1', 'Officer One', 'off1@test.com', 'x', $1, true) RETURNING id`,
      [officerRoleId]
    );
    officerUserId = officer.rows[0].id;

    const target = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('TGT1', 'Target User', 'tgt1@test.com', 'x', $1, true) RETURNING id`,
      [officerRoleId]
    );
    targetUserId = target.rows[0].id;

    const dept = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('OPS', 'Operations') RETURNING id`
    );
    departmentId = dept.rows[0].id;

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

  it('non-admin with NO grants is rejected on every exposed protected mutation (fail closed)', async () => {
    const auth = { Authorization: `Bearer ${officerToken()}` };

    const createUser = await request(app).post('/api/users').set(auth)
      .send({ fullName: 'New Person', employeeId: 'NEWP1', email: 'newp1@test.com', role: 'OFFICER' });
    assert.equal(createUser.status, 403, 'users.create must be enforced');

    const editUser = await request(app).put(`/api/users/${targetUserId}`).set(auth)
      .send({ designation: 'Hacked' });
    assert.equal(editUser.status, 403, 'users.edit must be enforced');

    const resetPw = await request(app).post(`/api/users/${targetUserId}/reset-password`).set(auth)
      .send({ password: 'newpassword1' });
    assert.equal(resetPw.status, 403, 'admin password reset must stay admin-gated');

    const deleteUser = await request(app).delete(`/api/users/${targetUserId}`).set(auth);
    assert.equal(deleteUser.status, 403, 'users.delete must be enforced');

    const userPerms = await request(app).put(`/api/users/${targetUserId}/permissions`).set(auth)
      .send({ permissions: [{ code: 'leads.view', allowed: true }] });
    assert.equal(userPerms.status, 403, 'permissions.manage (user overrides) must be enforced');

    const createDept = await request(app).post('/api/departments').set(auth).send({ name: 'Rogue Dept' });
    assert.equal(createDept.status, 403, 'departments.manage must be enforced');

    const deleteDept = await request(app).delete('/api/departments/nope').set(auth);
    assert.equal(deleteDept.status, 403, 'departments.manage delete must be enforced');

    const createRole = await request(app).post('/api/roles').set(auth)
      .send({ roleId: 'ROGUE', roleName: 'Rogue Role' });
    assert.equal(createRole.status, 403, 'roles.manage must be enforced');

    const createTeam = await request(app).post('/api/teams').set(auth)
      .send({ name: 'Rogue Team', departmentId });
    assert.equal(createTeam.status, 403, 'teams.manage must be enforced');

    const ladder = await request(app).put('/api/hierarchy-config').set(auth)
      .send({ assignments: [{ roleId: 'OFFICER', level: 4 }] });
    assert.equal(ladder.status, 403, 'hierarchy.manage must be enforced');

    const metaType = await request(app).post('/api/metadata-types').set(auth)
      .send({ key: 'rogue_type', label: 'Rogue Type' });
    assert.equal(metaType.status, 403, 'settings.manage (metadata) must be enforced');

    const options = await request(app).post('/api/options').set(auth)
      .send({ type: 'Campaign', value: 'RogueCampaign' });
    assert.equal(options.status, 403, 'settings.manage (options) must be enforced');

    const workflow = await request(app).post('/api/workflow-rules').set(auth)
      .send({ status: 'Untouched', allowedNextStatuses: ['Converted'] });
    assert.equal(workflow.status, 403, 'workflow.manage must be enforced');

    // The role permission matrix itself stays admin-only.
    const matrix = await request(app).put('/api/roles/OFFICER/permissions').set(auth)
      .send({ permissions: [{ code: 'users.create', allowed: true }] });
    assert.equal(matrix.status, 403, 'non-admin can never modify role permissions');
  });

  it('granting users.create enables exactly user creation and nothing else', async () => {
    await grant([{ code: 'users.create', allowed: true }]);

    const createUser = await request(app).post('/api/users').set('Authorization', `Bearer ${officerToken()}`)
      .send({ fullName: 'Created By Officer', employeeId: 'CBY1', email: 'cby1@test.com', role: 'OFFICER' });
    assert.equal(createUser.status, 201, `users.create grant must enable creation: ${JSON.stringify(createUser.body)}`);

    // Independence: the sibling actions stay denied.
    const editUser = await request(app).put(`/api/users/${targetUserId}`).set('Authorization', `Bearer ${officerToken()}`)
      .send({ designation: 'Nope' });
    assert.equal(editUser.status, 403, 'users.create must not enable users.edit');

    const deleteUser = await request(app).delete(`/api/users/${targetUserId}`).set('Authorization', `Bearer ${officerToken()}`);
    assert.equal(deleteUser.status, 403, 'users.create must not enable users.delete');
  });

  it('users.edit enables editing employee details but NOT password resets or delete', async () => {
    await grant([{ code: 'users.edit', allowed: true }]);
    const officerAuth = { Authorization: `Bearer ${officerToken()}` };

    // users.edit CAN edit employee details.
    const editUser = await request(app).put(`/api/users/${targetUserId}`).set(officerAuth)
      .send({ designation: 'Senior Officer' });
    assert.equal(editUser.status, 200, `users.edit grant must enable editing: ${JSON.stringify(editUser.body)}`);

    // users.edit alone CANNOT reset another user's password (dedicated endpoint).
    const resetPw = await request(app).post(`/api/users/${targetUserId}/reset-password`).set(officerAuth)
      .send({ password: 'newpassword1' });
    assert.equal(resetPw.status, 403, 'admin password reset must never follow from users.edit');

    // ...and CANNOT do it through the inline password field on the edit endpoint.
    const pwViaEdit = await request(app).put(`/api/users/${targetUserId}`).set(officerAuth)
      .send({ designation: 'Senior Officer', password: 'sidechannelpw' });
    assert.equal(pwViaEdit.status, 403, 'inline password on PUT /users/:id must be rejected for non-admins');
    // The stored password must be untouched by the rejected request.
    const after = await pool.query('SELECT password FROM users WHERE id = $1', [targetUserId]);
    assert.notEqual(after.rows[0].password, 'sidechannelpw', 'password value must be untouched');

    const deleteUser = await request(app).delete(`/api/users/${targetUserId}`).set(officerAuth);
    assert.equal(deleteUser.status, 403, 'users.edit must not enable users.delete');
  });

  it('ADMIN and SUPERADMIN can still perform the admin password reset', async () => {
    const resetPw = await request(app).post(`/api/users/${targetUserId}/reset-password`).set('Authorization', `Bearer ${adminToken()}`)
      .send({ password: 'adminresetpw1' });
    assert.equal(resetPw.status, 200, `ADMIN keeps the admin password reset: ${JSON.stringify(resetPw.body)}`);

    const superPw = await request(app).post(`/api/users/${targetUserId}/reset-password`).set('Authorization', `Bearer ${superToken()}`)
      .send({ password: 'superresetpw1' });
    assert.equal(superPw.status, 200, `SUPERADMIN keeps the admin password reset: ${JSON.stringify(superPw.body)}`);

    // ADMIN also keeps the inline password field on the edit endpoint.
    const pwViaEdit = await request(app).put(`/api/users/${targetUserId}`).set('Authorization', `Bearer ${adminToken()}`)
      .send({ designation: 'Admin Edited', password: 'admininlinepw' });
    assert.equal(pwViaEdit.status, 200, 'ADMIN keeps the inline password field on PUT /users/:id');
  });

  it('revoking users.edit fails editing closed again (independent persistence)', async () => {
    await grant([{ code: 'users.edit', allowed: false }]);
    const editUser = await request(app).put(`/api/users/${targetUserId}`).set('Authorization', `Bearer ${officerToken()}`)
      .send({ designation: 'Should Not Apply' });
    assert.equal(editUser.status, 403, 'revoked users.edit must fail closed');
  });

  it('users.delete enables deletion (last-admin guards still apply)', async () => {
    await grant([{ code: 'users.delete', allowed: true }]);
    const deleteUser = await request(app).delete(`/api/users/${targetUserId}`).set('Authorization', `Bearer ${officerToken()}`);
    assert.equal(deleteUser.status, 200, `users.delete grant must enable deletion: ${JSON.stringify(deleteUser.body)}`);
  });

  it('permissions.manage enables per-user overrides only; role matrix stays admin-only', async () => {
    await grant([{ code: 'permissions.manage', allowed: true }]);
    const officerAuth = { Authorization: `Bearer ${officerToken()}` };

    // Recreate a target user to override (previous test deleted it).
    const target = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('TGT2', 'Target Two', 'tgt2@test.com', 'x', $1, true) RETURNING id`,
      [officerRoleId]
    );

    const overrides = await request(app).put(`/api/users/${target.rows[0].id}/permissions`).set(officerAuth)
      .send({ permissions: [{ code: 'leads.view', allowed: true }] });
    assert.equal(overrides.status, 200, `permissions.manage must enable user overrides: ${JSON.stringify(overrides.body)}`);

    const matrix = await request(app).put('/api/roles/OFFICER/permissions').set(officerAuth)
      .send({ permissions: [{ code: 'leads.delete', allowed: true }] });
    assert.equal(matrix.status, 403, 'the role permission matrix stays admin-only');
  });

  it('departments.manage, roles.manage, teams.manage, hierarchy.manage follow their canonical codes', async () => {
    const officerAuth = { Authorization: `Bearer ${officerToken()}` };

    await grant([{ code: 'departments.manage', allowed: true }]);
    const dept = await request(app).post('/api/departments').set(officerAuth).send({ name: 'Finance' });
    assert.equal(dept.status, 200, `departments.manage grant must enable creation: ${JSON.stringify(dept.body)}`);

    await grant([{ code: 'roles.manage', allowed: true }]);
    const role = await request(app).post('/api/roles').set(officerAuth)
      .send({ roleId: 'AUDITOR', roleName: 'Auditor' });
    assert.equal(role.status, 200, `roles.manage grant must enable role creation: ${JSON.stringify(role.body)}`);
    const delRole = await request(app).delete('/api/roles/AUDITOR').set(officerAuth);
    assert.equal(delRole.status, 200, 'roles.manage grant must enable role deletion');

    await grant([{ code: 'teams.manage', allowed: true }]);
    const team = await request(app).post('/api/teams').set(officerAuth)
      .send({ name: 'Finance Team', departmentId });
    assert.equal(team.status, 200, `teams.manage grant must enable team creation: ${JSON.stringify(team.body)}`);

    await grant([{ code: 'hierarchy.manage', allowed: true }]);
    const ladder = await request(app).put('/api/hierarchy-config').set(officerAuth)
      .send({ assignments: [{ roleId: 'OFFICER', level: 0 }] });
    assert.equal(ladder.status, 200, `hierarchy.manage grant must enable ladder edits: ${JSON.stringify(ladder.body)}`);
  });

  it('settings.manage and workflow.manage enable Settings administration', async () => {
    const officerAuth = { Authorization: `Bearer ${officerToken()}` };

    await grant([{ code: 'settings.manage', allowed: true }]);
    const metaType = await request(app).post('/api/metadata-types').set(officerAuth)
      .send({ key: 'Region', label: 'Region' });
    assert.equal(metaType.status, 200, `settings.manage must enable metadata types: ${JSON.stringify(metaType.body)}`);
    const option = await request(app).post('/api/options').set(officerAuth)
      .send({ type: 'Region', value: 'Dhaka North' });
    assert.equal(option.status, 200, 'settings.manage must enable option values');

    await grant([{ code: 'workflow.manage', allowed: true }]);
    const rule = await request(app).post('/api/workflow-rules').set(officerAuth)
      .send({ status: 'Untouched', allowedNextStatuses: ['Contacted'] });
    assert.equal(rule.status, 200, `workflow.manage must enable workflow rule edits: ${JSON.stringify(rule.body)}`);
  });

  it('unknown permission codes stay fail-closed and are never invented', async () => {
    await grant([{ code: 'users.superpower', allowed: true }]);
    const found = await pool.query("SELECT 1 FROM permissions WHERE permission_code = 'users.superpower'");
    assert.equal(found.rows.length, 0, 'unknown code must never be created');
    const officerCaller = {
      id: officerUserId, employee_id: 'OFF1', email: 'off1@test.com',
      role_id: officerRoleId, role_code: 'OFFICER', department_id: null,
    };
    const { hasPermissionCode } = await import('../routes/production.routes.js');
    assert.equal(await hasPermissionCode(officerCaller, 'users.superpower'), false, 'unknown codes deny');
  });

  it('self-service password change works without any canonical grant (never users.edit)', async () => {
    await grant([]); // explicit no-op: officer has only earlier test grants, none needed here
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${officerToken()}`)
      .send({ userId: officerUserId, currentPassword: 'x', newPassword: 'brandnewpw1' });
    assert.equal(res.status, 200, `self-service change must only require authentication + current password: ${JSON.stringify(res.body)}`);
  });

  it('ADMIN keeps full bypass with zero stored grants', async () => {
    const adminAuth = { Authorization: `Bearer ${adminToken()}` };
    const createUser = await request(app).post('/api/users').set(adminAuth)
      .send({ fullName: 'Admin Made', employeeId: 'ADM1U', email: 'adm1u@test.com', role: 'OFFICER' });
    assert.equal(createUser.status, 201, 'ADMIN bypasses users.create');
    const dept = await request(app).post('/api/departments').set(adminAuth).send({ name: 'Admin Dept' });
    assert.equal(dept.status, 200, 'ADMIN bypasses departments.manage');
    const metaType = await request(app).post('/api/metadata-types').set(adminAuth)
      .send({ key: 'AdminType', label: 'Admin Type' });
    assert.equal(metaType.status, 200, 'ADMIN bypasses settings.manage');
    const ladder = await request(app).put('/api/hierarchy-config').set(adminAuth)
      .send({ assignments: [{ roleId: 'OFFICER', level: 0 }] });
    assert.equal(ladder.status, 200, 'ADMIN bypasses hierarchy.manage');
  });
});
