/**
 * rbac-fallback-safety-audit.test.ts — production-safety audit (this PR)
 * ------------------------------------------------------------------
 * Behavioral proof for the RBAC / Data Visibility / fallback-safety audit
 * documented in docs/RBAC_FALLBACK_SAFETY_AUDIT.md:
 *
 *   1. every mounted mutation route has the expected permission /
 *      admin / self-service guard (coverage matrix, fail closed)
 *   2. Feature Access (menuAccess/featurePermissions) can NOT grant an
 *      API action — only canonical grants do
 *   3. Action Permissions can NOT widen Data Visibility
 *   4. ADMIN / SUPERADMIN bypass remains consistent
 *   5. Own / DownTeam (recursive) / FullTeam (department-scoped) /
 *      Organization visibility behave correctly on leads reads
 *   6. Lead Quality (PR #38 boundary) does not widen visibility
 *   7. NEW guards added by this audit:
 *        - GET  /audit-logs                  -> canonical `audit.view`
 *        - GET  /notifications/leads/:leadId -> leads.view + lead visibility
 *        - POST /notifications (cross-user)  -> leads.assign / leads.transfer
 *   8. Production DB outage: no false success, no in-memory/demo
 *      persistence — the fallback store stays untouched
 *
 * Runs against a real (PGlite) PostgreSQL instance, exactly like the
 * existing role-* / lead-visibility-* suites.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { fallbackStore } from '../fallbackStore.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

describe('RBAC / fallback-safety audit — server enforcement', () => {
  let pool: any;
  let app: express.Express;

  let adminRoleId = '';
  let superRoleId = '';
  let adminId = '';
  let superId = '';
  let bobId = '';
  let carolId = '';
  let daveId = '';
  let aliceId = '';
  let erinId = '';
  let frankId = '';
  let ginaId = '';
  let hankId = '';
  let ivanId = '';

  let offRoleId = '';
  let featureOnlyRoleId = '';
  let fullPermsRoleId = '';
  let orgRoleId = '';
  let downTeamRoleId = '';
  let fullTeamRoleId = '';
  let ownRoleId = '';
  let salesDept = '';
  let opsDept = '';
  let bobLeadId = '';
  let aliceLeadId = '';
  let carolLeadId = '';
  let daveLeadId = '';
  let erinLeadId = '';
  let frankLeadId = '';

  const adminT = () => signToken({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin1@test.com', name: 'Admin' });
  const superT = () => signToken({ id: superId, employeeId: 'SUPER1', role: 'SUPERADMIN', email: 'super1@test.com', name: 'Super' });
  const bobT = () => signToken({ id: bobId, employeeId: 'BOB', role: 'OFFICER', email: 'bob@test.com', name: 'Bob' });
  const carolT = () => signToken({ id: carolId, employeeId: 'CAROL', role: 'OFFICER', email: 'carol@test.com', name: 'Carol' });
  const daveT = () => signToken({ id: daveId, employeeId: 'DAVE', role: 'FEATUREONLY', email: 'dave@test.com', name: 'Dave' });
  const aliceT = () => signToken({ id: aliceId, employeeId: 'ALICE', role: 'FULLPERMS', email: 'alice@test.com', name: 'Alice' });
  const erinT = () => signToken({ id: erinId, employeeId: 'ERIN', role: 'CEO', email: 'erin@test.com', name: 'Erin' });
  const frankT = () => signToken({ id: frankId, employeeId: 'FRANK', role: 'MGR', email: 'frank@test.com', name: 'Frank' });
  const ginaT = () => signToken({ id: ginaId, employeeId: 'GINA', role: 'EMP', email: 'gina@test.com', name: 'Gina' });
  const hankT = () => signToken({ id: hankId, employeeId: 'HANK', role: 'ORGVIEW', email: 'hank@test.com', name: 'Hank' });
  const ivanT = () => signToken({ id: ivanId, employeeId: 'IVAN', role: 'EMP', email: 'ivan@test.com', name: 'Ivan' });

  async function grant(roleCode: string, grants: Array<{ code: string; allowed: boolean }>): Promise<void> {
    const res = await request(app)
      .put(`/api/roles/${roleCode}/permissions`)
      .set('Authorization', `Bearer ${adminT()}`)
      .send({ permissions: grants });
    assert.equal(res.status, 200, `grant ${roleCode} must succeed: ${JSON.stringify(res.body)}`);
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
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
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50) UNIQUE,
        customer_name VARCHAR(255) NOT NULL,
        mobile VARCHAR(30) NOT NULL,
        email VARCHAR(255),
        occupation VARCHAR(150),
        area VARCHAR(150),
        source VARCHAR(100),
        priority VARCHAR(30) DEFAULT 'NORMAL',
        expected_premium NUMERIC(14,2),
        expected_value NUMERIC(14,2),
        notes TEXT,
        assigned_to UUID,
        assigned_by UUID,
        assigned_at TIMESTAMP,
        last_contacted_at TIMESTAMP,
        next_follow_up_at TIMESTAMP,
        next_action VARCHAR(255),
        follow_up_count INTEGER NOT NULL DEFAULT 0,
        converted_at TIMESTAMP,
        lost_at TIMESTAMP,
        lost_reason TEXT,
        current_status VARCHAR(255) DEFAULT 'Untouched',
        status_history JSONB DEFAULT '[]'::jsonb,
        assignment_history JSONB DEFAULT '[]'::jsonb,
        documents JSONB DEFAULT '[]'::jsonb,
        custom_fields JSONB DEFAULT '{}'::jsonb,
        tags JSONB DEFAULT '[]'::jsonb,
        created_by UUID,
        updated_by UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP,
        deleted_by UUID
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lead_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID,
        activity_type VARCHAR(50),
        status VARCHAR(50),
        remarks TEXT,
        next_follow_up_at TIMESTAMP,
        next_call_at TIMESTAMP,
        meeting_at TIMESTAMP,
        meeting_type VARCHAR(100),
        collected_ncp NUMERIC(14,2),
        projected_ncp NUMERIC(14,2),
        sum_assured NUMERIC(14,2),
        product_name VARCHAR(255),
        loss_reason VARCHAR(255),
        created_by UUID,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID,
        activity_type VARCHAR(50),
        title VARCHAR(255),
        scheduled_at TIMESTAMP,
        duration_minutes INT,
        remarks TEXT,
        status VARCHAR(30) DEFAULT 'scheduled',
        priority VARCHAR(20) DEFAULT 'NORMAL',
        meeting_type VARCHAR(100),
        location VARCHAR(255),
        created_by UUID,
        assigned_to UUID,
        updated_by UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        completed_by UUID,
        completed_activity_id UUID
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        recipient_key VARCHAR(100),
        lead_code VARCHAR(50),
        reference_id UUID,
        title VARCHAR(255),
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        type VARCHAR(30) DEFAULT 'info',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        read_at TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id UUID,
        target_user_id UUID,
        action_code VARCHAR(100),
        entity_type VARCHAR(50),
        entity_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
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

    // ---- canonical permission catalog (subset the audit routes need) ----
    const perms: Array<[string, string, string]> = [
      ['dashboard.view', 'Dashboard', 'VIEW'],
      ['leads.view', 'Leads', 'VIEW'],
      ['leads.create', 'Leads', 'CREATE'],
      ['leads.edit', 'Leads', 'EDIT'],
      ['leads.delete', 'Leads', 'DELETE'],
      ['leads.assign', 'Leads', 'ASSIGN'],
      ['leads.transfer', 'Leads', 'TRANSFER'],
      ['leads.import', 'Leads', 'IMPORT'],
      ['leads.export', 'Leads', 'EXPORT'],
      ['users.view', 'Users', 'VIEW'],
      ['users.create', 'Users', 'CREATE'],
      ['users.edit', 'Users', 'EDIT'],
      ['users.delete', 'Users', 'DELETE'],
      ['departments.manage', 'Departments', 'EDIT'],
      ['teams.manage', 'Teams', 'EDIT'],
      ['roles.manage', 'Roles', 'EDIT'],
      ['permissions.manage', 'Roles', 'EDIT'],
      ['reports.view', 'Reports', 'VIEW'],
      ['workflow.manage', 'Workflow', 'EDIT'],
      ['notifications.view', 'Notifications', 'VIEW'],
      ['settings.manage', 'Settings', 'EDIT'],
      ['hierarchy.manage', 'Users', 'EDIT'],
      ['audit.view', 'Users', 'VIEW'],
    ];
    for (const [code, mod, act] of perms) {
      await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name)
         VALUES ($1, $2, $3) ON CONFLICT (permission_code) DO NOTHING`,
        [code, mod, act]
      );
    }

    // ---- departments ----
    const sales = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`
    );
    salesDept = sales.rows[0].id;
    const ops = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('OPS', 'Ops') RETURNING id`
    );
    opsDept = ops.rows[0].id;

    // ---- roles ----
    const mkRole = async (code: string, name: string, vis: string, menuAccess?: Record<string, boolean>) => {
      const r = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, menu_access, is_active)
         VALUES ($1, $2, 99, $3, $4, TRUE) RETURNING id`,
        [code, name, vis, menuAccess ? JSON.stringify(menuAccess) : null]
      );
      return r.rows[0].id;
    };
    await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Administrator', 1, 'Organization') ON CONFLICT (role_code) DO NOTHING`);
    const adminRole = await pool.query(`SELECT id FROM roles WHERE role_code = 'ADMIN'`);
    adminRoleId = adminRole.rows[0].id;
    const superRole = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('SUPERADMIN', 'Super Administrator', 1, 'Organization') RETURNING id`);
    superRoleId = superRole.rows[0].id;
    offRoleId = await mkRole('OFFICER', 'Officer', 'Own');
    featureOnlyRoleId = await mkRole('FEATUREONLY', 'Feature Only', 'Organization', {
      '/': true, '/workbench': true, '/activities': true, '/task-calendar': true,
      '/follow-up': true, '/leads': true, '/leads/new': true, '/leads/upload': true,
      '/leads/all': true, '/execution-intelligence': true, '/ncp-progress': true,
      '/trend-charts': true, '/campaign-breakdown': true, '/team': true, '/users': true,
      '/settings': true, '/settings/performance-diagnostics': true,
    });
    fullPermsRoleId = await mkRole('FULLPERMS', 'Full Perms', 'Own');
    orgRoleId = await mkRole('ORGVIEW', 'Org View', 'Organization');
    downTeamRoleId = await mkRole('CEO', 'CEO', 'DownTeam');
    fullTeamRoleId = await mkRole('MGR', 'Manager', 'FullTeam');
    ownRoleId = await mkRole('EMP', 'Employee', 'Own');

    // ---- users (reporting tree under ERIN/CEO, Sales dept; IVAN in Ops) ----
    const mkUser = async (emp: string, roleId: string, deptId: string, managerId: string | null) => {
      const r = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, true) RETURNING id`,
        [emp, `User ${emp}`, `${emp.toLowerCase()}@test.com`, roleId, deptId, managerId]
      );
      return r.rows[0].id;
    };
    adminId = await mkUser('ADMIN1', adminRoleId, salesDept, null);
    superId = await mkUser('SUPER1', superRoleId, salesDept, null);
    erinId = await mkUser('ERIN', downTeamRoleId, salesDept, null);
    frankId = await mkUser('FRANK', fullTeamRoleId, salesDept, erinId);
    ginaId = await mkUser('GINA', ownRoleId, salesDept, frankId);
    bobId = await mkUser('BOB', offRoleId, salesDept, ginaId);
    carolId = await mkUser('CAROL', offRoleId, salesDept, ginaId);
    daveId = await mkUser('DAVE', featureOnlyRoleId, salesDept, null);
    aliceId = await mkUser('ALICE', fullPermsRoleId, salesDept, null);
    hankId = await mkUser('HANK', orgRoleId, salesDept, null);
    ivanId = await mkUser('IVAN', ownRoleId, opsDept, null);

    // ---- leads ----
    const mkLead = async (code: string, name: string, assigneeId: string, creatorId: string) => {
      const r = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'Untouched') RETURNING id`,
        [code, name, `017${code.slice(-8)}`, assigneeId, creatorId, creatorId]
      );
      return r.rows[0].id;
    };
    bobLeadId = await mkLead('lead_bob1', 'Bob Prospect', bobId, bobId);
    aliceLeadId = await mkLead('lead_al1', 'Alice Prospect', aliceId, aliceId);
    carolLeadId = await mkLead('lead_car1', 'Carol Prospect', carolId, carolId);
    daveLeadId = await mkLead('lead_dav1', 'Dave Prospect', daveId, daveId);
    erinLeadId = await mkLead('lead_er1', 'Erin Prospect', erinId, erinId);
    frankLeadId = await mkLead('lead_fr1', 'Frank Prospect', frankId, frankId);

    // Audit row so GET /audit-logs has data once authorized.
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'users-bulk-import', 'user', $2, '{}'::jsonb)`,
      [adminId, bobId]
    );
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
  });

  /* ================================================================== */
  /* 1. MUTATION ROUTE COVERAGE MATRIX (fail closed)                     */
  /* ================================================================== */

  it('A1. every admin mutation is rejected for an ungranted non-admin (fail closed)', async () => {
    const b: Array<[string, string, any]> = [
      ['POST', '/api/users', { fullName: 'X Y', employeeId: 'XNEW', email: 'xnew@test.com' }],
      ['PUT', `/api/users/${bobId}`, { fullName: 'Bob Jr' }],
      ['DELETE', `/api/users/${carolId}`, undefined],
      ['POST', `/api/users/${bobId}/reset-password`, { password: 'newpass123' }],
      ['POST', '/api/users/bulk/commit', { rows: [{ employeeId: 'ZNEW', fullName: 'Z New', email: 'znew@test.com', role: 'EMP' }], mode: 'createOnly' }],
      ['PUT', `/api/users/${bobId}/permissions`, { permissions: [{ code: 'leads.view', allowed: true }] }],
      ['GET', '/api/audit-logs', undefined],
      ['POST', '/api/departments', { departmentName: 'X Dept', departmentCode: 'XD' }],
      ['DELETE', `/api/departments/${salesDept}`, undefined],
      ['POST', '/api/roles', { roleId: 'XROLE', roleName: 'X Role' }],
      ['DELETE', `/api/roles/${offRoleId}`, undefined],
      ['GET', `/api/roles/${offRoleId}/permissions`, undefined],
      ['PUT', `/api/roles/${offRoleId}/permissions`, { permissions: [] }],
      ['POST', '/api/permissions', { roleId: 'XROLE', roleName: 'X Role', modules: {} }],
      ['DELETE', `/api/permissions/${offRoleId}`, undefined],
      ['POST', '/api/teams', { teamName: 'X Team', teamCode: 'XT' }],
      ['DELETE', '/api/teams/00000000-0000-0000-0000-000000000000', undefined],
      ['POST', '/api/hierarchies', { departmentId: salesDept, layers: [] }],
      ['DELETE', '/api/hierarchies/00000000-0000-0000-0000-000000000000', undefined],
      ['PUT', '/api/hierarchy-config', { levels: [] }],
      ['POST', '/api/metadata-types', { key: 'x_type', label: 'X' }],
      ['DELETE', '/api/metadata-types/x_type', undefined],
      ['POST', '/api/options', { type: 'x', value: 'y' }],
      ['DELETE', '/api/options/x/y', undefined],
      ['POST', '/api/options/reorder', { type: 'x', values: [] }],
      ['POST', '/api/workflow-rules', { status: 'X', allowedNextStatuses: [] }],
      ['DELETE', '/api/workflow-rules/00000000-0000-0000-0000-000000000000', undefined],
      ['POST', '/api/form-fields', { fieldKey: 'x', label: 'X' }],
      ['DELETE', '/api/form-fields/00000000-0000-0000-0000-000000000000', undefined],
      ['POST', '/api/form-fields/reorder', { fields: [] }],
      // Cross-user notification creation (new guard).
      ['POST', '/api/notifications', { userId: 'CAROL', title: 'Hi', message: 'there' }],
      // Lead mutations without the matching canonical grants.
      ['POST', '/api/leads', { prospectName: 'P', mobile: '01700000111' }],
      ['POST', '/api/leads/bulk', { leads: [{ name: 'P', phone: '01700000112' }], dryRun: true }],
      ['POST', `/api/leads/${bobLeadId}/follow-up`, { status: 'Contacted', remarks: 'r' }],
      ['DELETE', `/api/leads/${bobLeadId}`, undefined],
      // Scheduled-activity mutations (leads.edit / leads.assign surface).
      ['POST', '/api/scheduled-activities', { leadId: bobLeadId, activityType: 'call', scheduledAt: new Date().toISOString() }],
      ['PUT', '/api/scheduled-activities/00000000-0000-0000-0000-000000000000', { title: 'x' }],
      ['DELETE', '/api/scheduled-activities/00000000-0000-0000-0000-000000000000', undefined],
      ['POST', '/api/scheduled-activities/00000000-0000-0000-0000-000000000000/complete', {}],
      ['POST', '/api/scheduled-activities/00000000-0000-0000-0000-000000000000/cancel', {}],
      // Admin-only org destruction.
      ['DELETE', '/api/leads/campaign/None', undefined],
      ['POST', '/api/leads/clear-all', undefined],
    ];

    for (const [method, url, body] of b) {
      let p: any;
      if (method === 'GET') p = request(app).get(url);
      else if (method === 'DELETE') p = request(app).delete(url);
      else if (method === 'PUT') p = request(app).put(url).send(body ?? {});
      else p = request(app).post(url).send(body ?? {});
      const r = await p.set('Authorization', `Bearer ${bobT()}`);
      const status = r.status;
      assert.ok(
        status === 403 || status === 404,
        `${method} ${url} must be fail-closed (403/404) for an ungranted non-admin, got ${status}: ${JSON.stringify(r.body)}`
      );
    }
  });

  it('A2. a single canonical grant enables exactly its action (independence preserved)', async () => {
    // leads.view alone enables reads but NOT mutations.
    await grant('OFFICER', [{ code: 'leads.view', allowed: true }]);
    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(list.status, 200, 'granted leads.view must enable GET /leads');
    const create = await request(app).post('/api/leads').set('Authorization', `Bearer ${bobT()}`).send({ prospectName: 'P', mobile: '01700000222' });
    assert.equal(create.status, 403, 'leads.view must NOT enable lead creation');
    const fu = await request(app).post(`/api/leads/${bobLeadId}/follow-up`).set('Authorization', `Bearer ${bobT()}`).send({ remarks: 'x' });
    assert.equal(fu.status, 403, 'leads.view must NOT enable follow-up mutations');

    // leads.edit enables mutations (on own-visibility leads).
    await grant('OFFICER', [{ code: 'leads.edit', allowed: true }]);
    const fu2 = await request(app).post(`/api/leads/${bobLeadId}/follow-up`).set('Authorization', `Bearer ${bobT()}`).send({ remarks: 'audit check' });
    assert.equal(fu2.status, 200, `leads.edit must enable own-lead follow-up: ${JSON.stringify(fu2.body)}`);
    const del = await request(app).delete(`/api/leads/${carolLeadId}`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(del.status, 403, 'leads.edit must NOT enable deletion');

    // leads.delete enables deletion (own-visibility lead only).
    await grant('OFFICER', [{ code: 'leads.delete', allowed: true }]);
    const delOwn = await request(app).delete(`/api/leads/${bobLeadId}`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(delOwn.status, 200, `leads.delete must enable deletion of an own-visibility lead: ${JSON.stringify(delOwn.body)}`);
    // And the SAME grant must NOT let bob delete CAROL's lead.
    const delForeign = await request(app).delete(`/api/leads/${carolLeadId}`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(delForeign.status, 403, 'own-scope user must not delete a foreign lead despite leads.delete');

    // Restore the fixture for the visibility matrix (the deletion above is
    // the assertion; the fixture lifecycle is a test concern).
    await pool.query(`UPDATE leads SET is_deleted = FALSE, deleted_at = NULL WHERE id = $1`, [bobLeadId]);
  });

  it('A3. self-service boundaries: own records yes, others no (notifications read)', async () => {
    const own = await request(app).get(`/api/notifications/users/BOB`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(own.status, 200, 'own notification read must be self-service');
    const others = await request(app).get(`/api/notifications/users/CAROL`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(others.status, 403, 'another user notification read must be 403 for non-admin');
    const adminRead = await request(app).get(`/api/notifications/users/CAROL`).set('Authorization', `Bearer ${adminT()}`);
    assert.equal(adminRead.status, 200, 'admin may read any notification list');
  });

  /* ================================================================== */
  /* 2. FEATURE ACCESS CANNOT GRANT AN API ACTION                        */
  /* ================================================================== */

  it('B1. full Feature Access (menuAccess + Organization) with ZERO canonical grants still cannot mutate', async () => {
    // dave: FEATUREONLY role — every module toggle ON, Organization
    // visibility, but no role_permissions grants at all.
    const putUser = await request(app).put(`/api/users/${carolId}`).set('Authorization', `Bearer ${daveT()}`).send({ fullName: 'Carol X' });
    assert.equal(putUser.status, 403, 'menuAccess for /users must NOT grant users.edit');
    const createLead = await request(app).post('/api/leads').set('Authorization', `Bearer ${daveT()}`).send({ prospectName: 'P', mobile: '01700000333' });
    assert.equal(createLead.status, 403, 'menuAccess for /leads/new must NOT grant leads.create');
    const audit = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(audit.status, 403, 'menuAccess must NOT grant audit.view');
    const clearAll = await request(app).post('/api/leads/clear-all').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(clearAll.status, 403, 'menuAccess must NOT grant the admin-only clear-all');
    // And reads stay data-visibility scoped, not Organization-wide via feature flags:
    // (Dave is Organization visibility BY ROLE DESIGN here — the point is
    // that mutations still require canonical grants.)
    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(list.status, 403, 'without leads.view, even an Organization-visibility role cannot list leads');
  });

  /* ================================================================== */
  /* 3. ACTION PERMISSIONS CANNOT WIDEN DATA VISIBILITY                  */
  /* ================================================================== */

  it('C1. every leads.* action + Own visibility still sees only own leads', async () => {
    for (const code of ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.transfer', 'leads.import', 'leads.export']) {
      await grant('FULLPERMS', [{ code, allowed: true }]);
    }
    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${aliceT()}`);
    assert.equal(list.status, 200);
    const ids = list.body.map((l: any) => l.id);
    assert.deepEqual(ids, ['lead_al1'], `Own visibility must survive full action grants, got ${JSON.stringify(ids)}`);

    const foreign = await request(app).get(`/api/leads/${bobLeadId}`).set('Authorization', `Bearer ${aliceT()}`);
    assert.equal(foreign.status, 404, 'foreign lead detail must stay hidden despite full action grants');

    const foreignFu = await request(app).post(`/api/leads/${carolLeadId}/follow-up`).set('Authorization', `Bearer ${aliceT()}`).send({ remarks: 'x' });
    assert.equal(foreignFu.status, 403, 'foreign lead mutation must stay blocked despite full action grants');
  });

  it('C2. forged query params can only NARROW the list scope, never widen it', async () => {
    // ALICE (Own) asks for BOB's leads: the param narrows to BOB's lead,
    // which the visibility clause then excludes -> empty. It can never
    // return a lead outside her scope.
    const narrowed = await request(app)
      .get('/api/leads?assignedTo=BOB&status=Untouched')
      .set('Authorization', `Bearer ${aliceT()}`);
    assert.equal(narrowed.status, 200);
    const ids = narrowed.body.map((l: any) => l.id);
    assert.ok(!ids.includes('lead_bob1'), 'assignedTo param must not widen visibility');
    assert.deepEqual(ids, [], `param can only narrow, got ${JSON.stringify(ids)}`);
  });

  /* ================================================================== */
  /* 4. ADMIN / SUPERADMIN BYPASS CONSISTENCY                            */
  /* ================================================================== */

  it('D1. ADMIN bypass works with zero stored grants on admin capabilities', async () => {
    const audit = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${adminT()}`);
    assert.equal(audit.status, 200, 'admin bypass for audit.view');
    const matrix = await request(app).get(`/api/roles/${offRoleId}/permissions`).set('Authorization', `Bearer ${adminT()}`);
    assert.equal(matrix.status, 200, 'admin bypass for role matrix read');
    const put = await request(app).put(`/api/roles/${offRoleId}/permissions`).set('Authorization', `Bearer ${adminT()}`).send({ permissions: [] });
    assert.equal(put.status, 200, 'admin bypass for role matrix write');
    const reset = await request(app).post(`/api/users/${carolId}/reset-password`).set('Authorization', `Bearer ${adminT()}`).send({ password: 'resetpass123' });
    assert.equal(reset.status, 200, 'admin password reset');
    // Org-destruction bypasses (clear-all / campaign purge) are asserted
    // in the FINAL test (D3) so the visibility matrix keeps its fixtures.
  });

  it('D2. SUPERADMIN is treated like ADMIN (bypass consistency)', async () => {
    const audit = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${superT()}`);
    assert.equal(audit.status, 200, 'superadmin bypass for audit.view');
    const matrix = await request(app).get(`/api/roles/${offRoleId}/permissions`).set('Authorization', `Bearer ${superT()}`);
    assert.equal(matrix.status, 200, 'superadmin bypass for role matrix read');
    const reset = await request(app).post(`/api/users/${carolId}/reset-password`).set('Authorization', `Bearer ${superT()}`).send({ password: 'resetpass123' });
    assert.equal(reset.status, 200, 'superadmin password reset');
    // Superadmin visibility: Organization.
    const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${superT()}`);
    assert.equal(list.status, 200, 'superadmin must hold leads.* via bypass');
  });

  /* ================================================================== */
  /* 5. DATA VISIBILITY MATRIX (server-side, leads list)                 */
  /* ================================================================== */

  it('E1. Own visibility: only own leads (no grants beyond leads.view)', async () => {
    await grant('EMP', [{ code: 'leads.view', allowed: true }]);
    // GINA sees her own lead only (she has none) — plus nothing else.
    const gina = await request(app).get('/api/leads').set('Authorization', `Bearer ${ginaT()}`);
    assert.equal(gina.status, 200);
    assert.deepEqual(gina.body.map((l: any) => l.id), [], 'Own user with no leads sees none');

    const ivan = await request(app).get('/api/leads').set('Authorization', `Bearer ${ivanT()}`);
    assert.equal(ivan.status, 200);
    assert.deepEqual(ivan.body.map((l: any) => l.id), [], 'Other-department Own user sees none of Sales leads');
  });

  it('E2. DownTeam visibility is the recursive reporting subtree', async () => {
    await grant(downTeamRoleId, [{ code: 'leads.view', allowed: true }]);
    // ERIN (CEO, DownTeam, root of the Sales tree) sees leads of:
    // self + FRANK + GINA + BOB + CAROL — but not HANK/ALICE/DAVE
    // (peers with no reporting relation) and not IVAN (Ops).
    const erin = await request(app).get('/api/leads').set('Authorization', `Bearer ${erinT()}`);
    assert.equal(erin.status, 200);
    const ids = erin.body.map((l: any) => l.id).sort();
    assert.deepEqual(
      ids,
      ['lead_bob1', 'lead_car1', 'lead_er1', 'lead_fr1'].sort(),
      `DownTeam must be the recursive subtree, got ${JSON.stringify(ids)}`
    );
  });

  it('E3. FullTeam visibility is department-scoped (not the reporting tree)', async () => {
    await grant(fullTeamRoleId, [{ code: 'leads.view', allowed: true }]);
    // FRANK (MGR, FullTeam, Sales) sees every Sales-dept lead — including
    // peers he does not manage (ALICE, DAVE, HANK, ERIN) — but NOT Ops.
    const frank = await request(app).get('/api/leads').set('Authorization', `Bearer ${frankT()}`);
    assert.equal(frank.status, 200);
    const ids = frank.body.map((l: any) => l.id).sort();
    assert.deepEqual(
      ids,
      ['lead_al1', 'lead_bob1', 'lead_car1', 'lead_dav1', 'lead_er1', 'lead_fr1'].sort(),
      `FullTeam must be the whole department, got ${JSON.stringify(ids)}`
    );
  });

  it('E4. Organization visibility (non-admin role) sees everything', async () => {
    await grant('ORGVIEW', [{ code: 'leads.view', allowed: true }]);
    const hank = await request(app).get('/api/leads').set('Authorization', `Bearer ${hankT()}`);
    assert.equal(hank.status, 200);
    const ids = hank.body.map((l: any) => l.id).sort();
    assert.deepEqual(
      ids,
      ['lead_al1', 'lead_bob1', 'lead_car1', 'lead_dav1', 'lead_er1', 'lead_fr1'].sort(),
      `Organization visibility must see all leads, got ${JSON.stringify(ids)}`
    );
  });

  /* ================================================================== */
  /* 6. LEAD QUALITY (PR #38) BOUNDARY — no visibility widening          */
  /* ================================================================== */

  it('F1. lead quality read follows the lead visibility boundary exactly', async () => {
    // BOB (Own, leads.view granted in A2) may read quality for own lead only.
    // (bobLeadId was soft-deleted in A2 — use a fresh own lead for BOB.)
    const fresh = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ('lead_bob2', 'Bob Prospect 2', '01700000444', $1, $1, $1, $1, 'Interested') RETURNING id`,
      [bobId]
    );
    const ownQuality = await request(app).get(`/api/leads/lead_bob2/quality`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(ownQuality.status, 200, 'own lead quality must be readable');
    assert.ok(ownQuality.body.data.score !== undefined, 'quality payload must be the PR #38 score shape');

    const foreignQuality = await request(app).get(`/api/leads/${aliceLeadId}/quality`).set('Authorization', `Bearer ${bobT()}`);
    assert.equal(foreignQuality.status, 404, 'foreign lead quality must be 404 (no existence leak)');

    void fresh;
  });

  it('F2. dashboard quality aggregate is scoped to the caller visibility', async () => {
    const ginaDash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${ginaT()}`);
    assert.equal(ginaDash.status, 200, 'Gina (leads.view via EMP role? no — EMP has only leads.view from E1) dashboard');
    const total = ginaDash.body.data.totalLeads;
    assert.equal(total, 0, `Own dashboard must count only own leads, got ${total}`);
    const quality = ginaDash.body.data.quality || {};
    const bandTotal = Object.values(quality.bands || {}).reduce((a: number, b: any) => a + Number(b || 0), 0);
    assert.equal(bandTotal, 0, `quality bands must stay within the visible scope, got ${JSON.stringify(quality)}`);
  });

  /* ================================================================== */
  /* 7. NEW AUDIT GUARDS                                                 */
  /* ================================================================== */

  it('G1. GET /notifications/leads/:leadId enforces lead visibility', async () => {
    // Seed notifications for a foreign lead.
    await pool.query(
      `INSERT INTO notifications (user_id, recipient_key, lead_code, title, message)
       VALUES ($1, 'BOB', 'lead_bob2', 'Assigned', 'new lead')`,
      [bobId]
    );
    const foreign = await request(app).get('/api/notifications/leads/lead_al1').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(foreign.status, 404, 'foreign lead notification history must be 404');

    const own = await request(app).get('/api/notifications/leads/lead_bob2').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(own.status, 200, 'own lead notification history must be readable');
    assert.equal(own.body.length, 1, 'must return the seeded notification');

    // A role without leads.view gets 403 even for its own lead.
    // (BOB has leads.view from A2; use DAVE — FEATUREONLY, no leads.view.)
    const daveForeign = await request(app).get('/api/notifications/leads/lead_bob2').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(daveForeign.status, 403, 'without leads.view the lead-scoped notification read is 403');
  });

  it('G2. cross-user POST /notifications requires leads.assign / leads.transfer', async () => {
    const cross = await request(app).post('/api/notifications').set('Authorization', `Bearer ${daveT()}`).send({ userId: 'CAROL', title: 'Hi', message: 'x' });
    assert.equal(cross.status, 403, 'cross-user notification must be 403 without routing grants');

    const self = await request(app).post('/api/notifications').set('Authorization', `Bearer ${daveT()}`).send({ userId: 'DAVE', title: 'Self', message: 'x' });
    assert.equal(self.status, 201, 'self-directed notification is self-service (authenticated)');

    await grant('FEATUREONLY', [{ code: 'leads.assign', allowed: true }]);
    const withAssign = await request(app).post('/api/notifications').set('Authorization', `Bearer ${daveT()}`).send({ userId: 'CAROL', title: 'Hi', message: 'x' });
    assert.equal(withAssign.status, 201, 'leads.assign must authorize cross-user notification (assignment fan-out)');

    const adminCross = await request(app).post('/api/notifications').set('Authorization', `Bearer ${adminT()}`).send({ userId: 'CAROL', title: 'Hi', message: 'x' });
    assert.equal(adminCross.status, 201, 'admin bypass for cross-user notification');
  });

  it('G3. GET /audit-logs requires the canonical audit.view grant', async () => {
    const none = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(none.status, 403, 'audit log must be fail-closed without audit.view');

    await grant('FEATUREONLY', [{ code: 'audit.view', allowed: true }]);
    const granted = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${daveT()}`);
    assert.equal(granted.status, 200, 'audit.view must authorize the audit log');
    assert.ok(Array.isArray(granted.body.data), 'audit log payload shape');
  });

  /* ================================================================== */
  /* 8. PRODUCTION DB OUTAGE — NO LOCAL PERSISTENCE, NO FALSE SUCCESS    */
  /* ================================================================== */

  it('H1. with the database unreachable, writes never succeed and the in-memory store stays untouched', async () => {
    const realPool = pool;
    const err: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    err.code = 'ECONNREFUSED';
    const brokenPool = {
      query: async () => { throw err; },
      connect: async () => ({
        query: async () => { throw err; },
        release: () => undefined,
      }),
      on: () => undefined,
      end: async () => undefined,
    };
    _setTestPoolForTest(brokenPool);

    try {
      const before = fallbackStore.leads.length;

      const createLead = await request(app).post('/api/leads').set('Authorization', `Bearer ${adminT()}`).send({ prospectName: 'Outage', mobile: '01700000555' });
      assert.ok(
        createLead.status === 403 || createLead.status === 503,
        `DB-outage lead write must fail (403/503), never 2xx — got ${createLead.status}`
      );

      const list = await request(app).get('/api/leads').set('Authorization', `Bearer ${adminT()}`);
      assert.ok(
        list.status === 403 || list.status === 503,
        `DB-outage lead read must fail (403/503), never 2xx — got ${list.status}`
      );

      const clearAll = await request(app).post('/api/leads/clear-all').set('Authorization', `Bearer ${adminT()}`);
      assert.ok(
        clearAll.status === 403 || clearAll.status === 503,
        `DB-outage clear-all must fail (403/503) — got ${clearAll.status}`
      );

      // The development in-memory store must NEVER become an authority
      // (or a persistence side channel) while a database is configured.
      assert.equal(fallbackStore.leads.length, before, 'fallbackStore.leads must stay untouched during a DB outage');
    } finally {
      _setTestPoolForTest(realPool);
    }
  });

  it('H2. 401/403/404 semantics on the audit route (never a fallback surface)', async () => {
    const anon = await request(app).get('/api/audit-logs');
    assert.equal(anon.status, 401, 'unauthenticated audit read is 401');

    const foreign = await request(app).get('/api/leads/lead_al1').set('Authorization', `Bearer ${ivanT()}`);
    assert.equal(foreign.status, 404, 'invisible lead detail is 404 (never a cache/fallback answer)');

    const forbidden = await request(app).post(`/api/leads/${bobLeadId}/follow-up`).set('Authorization', `Bearer ${ivanT()}`).send({ remarks: 'x' });
    assert.ok(forbidden.status === 403 || forbidden.status === 404, 'out-of-scope mutation is 403/404');
  });

  /* ================================================================== */
  /* 9. ADMIN-ONLY DESTRUCTION (runs LAST — it soft-deletes fixtures)    */
  /* ================================================================== */

  it('D3. campaign purge and clear-all remain ADMIN/SUPERADMIN-only and work for admins', async () => {
    // Non-admin still denied (re-assert after all grants accumulated).
    const bobPurge = await request(app).delete('/api/leads/campaign/None').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(bobPurge.status, 403, 'campaign purge must stay admin-only');
    const bobClear = await request(app).post('/api/leads/clear-all').set('Authorization', `Bearer ${bobT()}`);
    assert.equal(bobClear.status, 403, 'clear-all must stay admin-only');

    const adminPurge = await request(app).delete('/api/leads/campaign/None').set('Authorization', `Bearer ${adminT()}`);
    assert.equal(adminPurge.status, 200, 'admin campaign purge');

    const superClear = await request(app).post('/api/leads/clear-all').set('Authorization', `Bearer ${superT()}`);
    assert.equal(superClear.status, 200, 'superadmin clear-all');

    // Everything is now soft-deleted: even admins list nothing.
    const adminList = await request(app).get('/api/leads').set('Authorization', `Bearer ${adminT()}`);
    assert.equal(adminList.status, 200);
    assert.deepEqual(adminList.body, [], 'clear-all must soft-delete all leads');
  });
});
