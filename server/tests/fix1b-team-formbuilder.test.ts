import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';

/**
 * FIX-1b — Team overview (item 5) and Form Builder controls (item 6).
 *
 * Item 6 diagnosis pinned by this suite: the form-field mutations were
 * gated by requireAdmin (token role claim) while the Form Builder tab
 * is visible via `settings.manage` — a settings-permission holder who
 * was not an ADMIN token got 403 on every save, so the Required toggle
 * silently failed. The gate is now requirePermissionCode(
 * 'settings.manage') (audit item I1) and the `required` round-trip is
 * exercised end-to-end below.
 */

const JWT_SECRET = ['fix1b', '-test', '-secret'].join('');

async function setupCommonSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100),
      department_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
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
      permissions_snapshot JSONB
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      permission_name VARCHAR(255)
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(150) UNIQUE NOT NULL,
      label VARCHAR(255) NOT NULL,
      field_type VARCHAR(50) NOT NULL DEFAULT 'text',
      section VARCHAR(100),
      is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT DEFAULT 999,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_name VARCHAR(255),
      status VARCHAR(100),
      assigned_to VARCHAR(30),
      created_by VARCHAR(30),
      next_follow_up_at TIMESTAMP,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function bootApp() {
  const mod = await import('../routes/production.routes.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', mod.default);
  return app;
}

function tokenFor(u: { id: string; employeeId: string; email: string; role: string; name: string }) {
  return jwt.sign(u, JWT_SECRET, { expiresIn: '1h' });
}

// ---------------------------------------------------------------------------
// Item 5 — team overview scoping, tiers and counts.
// ---------------------------------------------------------------------------

describe('FIX-1 item 5 — GET /api/team/overview', () => {
  let pool: any;
  let app: express.Express;
  const tokens: Record<string, string> = {};

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupCommonSchema(pool);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const deptId = dept.rows[0].id;
    const mkRole = async (code: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      );
      return r.rows[0].id;
    };
    const ceoRole = await mkRole('CEO', 1, 'Organization');
    const headRole = await mkRole('BH', 2, 'DownTeam');
    const leadRole = await mkRole('UM', 5, 'Own'); // Own on purpose: the UM-1 tree floor must lift it
    const memRole = await mkRole('RO', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null, designation: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, designation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId, designation]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const ceo = await mkUser('TCEO', ceoRole, null, 'Chief Executive Officer');
    const head = await mkUser('THEAD', headRole, ceo.id, 'Business Head');
    const lead = await mkUser('TLEAD', leadRole, head.id, 'Unit Manager');
    const mem1 = await mkUser('TMEM1', memRole, lead.id, 'Relationship Officer');
    const mem2 = await mkUser('TMEM2', memRole, lead.id, 'Relationship Officer');
    const other = await mkUser('TOTHER', memRole, null, 'Relationship Officer');
    tokens.ceo = tokenFor({ ...ceo, role: 'CEO' });
    tokens.head = tokenFor({ ...head, role: 'BH' });
    tokens.lead = tokenFor({ ...lead, role: 'UM' });
    tokens.mem1 = tokenFor({ ...mem1, role: 'RO' });
    tokens.other = tokenFor({ ...other, role: 'RO' });

    const bounds = getDhakaBusinessDayBounds(new Date());
    const dueToday = new Date(new Date(bounds.todayStartIso).getTime() + 2 * 3600_000).toISOString();
    const dueTomorrow = new Date(new Date(bounds.tomorrowStartIso).getTime() + 3600_000).toISOString();
    const mkLead = async (assignedTo: string, status: string, nextFollowUpAt: string | null, deleted = false) => {
      await pool.query(
        `INSERT INTO leads (customer_name, status, assigned_to, created_by, next_follow_up_at, is_deleted) VALUES ('C', $1, $2, $2, $3, $4)`,
        [status, assignedTo, nextFollowUpAt, deleted]
      );
    };
    await mkLead('TMEM1', 'Interested', dueToday);          // open + due today
    await mkLead('TMEM1', 'Follow-up Set', dueTomorrow);    // open, not due today
    await mkLead('TMEM1', 'Converted', null);               // converted
    await mkLead('TMEM1', 'Not Interested', null);          // terminal, not open
    await mkLead('TMEM1', 'Interested', dueToday, true);    // deleted — must not count
    await mkLead('TLEAD', 'New', null);                     // lead's own open lead
    await mkLead('TOTHER', 'Interested', dueToday);         // outsider's lead

    app = await bootApp();
  });

  it('a head sees their tree grouped by tier with per-person counts', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${tokens.head}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const people = res.body.people as any[];
    const byEmp = new Map(people.map(p => [p.employeeId, p]));
    assert.deepEqual([...byEmp.keys()].sort(), ['THEAD', 'TLEAD', 'TMEM1', 'TMEM2']);
    assert.equal(byEmp.get('THEAD').tier, 'manager');
    assert.equal(byEmp.get('TLEAD').tier, 'teamLead');
    assert.equal(byEmp.get('TMEM1').tier, 'teamMember');
    const mem1 = byEmp.get('TMEM1');
    assert.equal(mem1.openLeads, 2);
    assert.equal(mem1.convertedLeads, 1);
    assert.equal(mem1.dueToday, 1);
    assert.equal(mem1.managerName, 'Name TLEAD');
    assert.equal(byEmp.get('TLEAD').openLeads, 1);
    assert.equal(byEmp.get('THEAD').isSelf, true);
  });

  it('the UM-1 tree floor applies: an Own-scope lead with reports sees their team', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${tokens.lead}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const emps = (res.body.people as any[]).map(p => p.employeeId).sort();
    assert.deepEqual(emps, ['TLEAD', 'TMEM1', 'TMEM2']);
    assert.equal(res.body.scope, 'Team');
  });

  it('a leaf member sees only themself — no peer is named', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${tokens.mem1}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const people = res.body.people as any[];
    assert.equal(people.length, 1);
    assert.equal(people[0].employeeId, 'TMEM1');
    assert.equal(people[0].tier, 'teamMember');
    assert.equal(people[0].openLeads, 2);
  });

  it('an unrelated user never sees the other tree', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${tokens.other}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body.people as any[]).map(p => p.employeeId), ['TOTHER']);
  });

  it('Organization scope (CEO) sees everyone, tiers intact', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${tokens.ceo}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const people = res.body.people as any[];
    assert.equal(people.length, 6);
    const byEmp = new Map(people.map(p => [p.employeeId, p]));
    assert.equal(byEmp.get('TCEO').tier, 'manager');
    assert.equal(byEmp.get('TOTHER').tier, 'teamMember');
  });

  it('unauthenticated callers get 401', async () => {
    const res = await request(app).get('/api/team/overview');
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Item 6 — Form Builder gate + required round-trip + edit/delete.
// ---------------------------------------------------------------------------

describe('FIX-1 item 6 — Form Builder field controls', () => {
  let pool: any;
  let app: express.Express;
  let mgrToken: string;
  let plainToken: string;
  let adminToken: string;
  let customFieldId: string;
  let systemFieldId: string;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupCommonSchema(pool);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);
    const adminRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const perm: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRole.rows[0].id, perm.rows[0].id]);
    const hash = await bcrypt.hash('password123', 10);
    const mk = async (emp: string, roleId: string, role: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, hash, roleId, dept.rows[0].id]
      );
      return tokenFor({ id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role, name: emp });
    };
    mgrToken = await mk('FBMGR', empRole.rows[0].id, 'EMPLOYEE');   // settings.manage, NOT an admin token
    plainToken = await mk('FBPLAIN', plainRole.rows[0].id, 'EMPLOYEE');
    adminToken = await mk('FBADMIN', adminRole.rows[0].id, 'ADMIN');

    const sys: any = await pool.query(
      `INSERT INTO form_fields (field_key, label, field_type, section, is_mandatory, is_system, sort_order)
       VALUES ('prospect_name', 'Prospect Name', 'text', 'Identity', TRUE, TRUE, 1) RETURNING id`
    );
    systemFieldId = sys.rows[0].id;

    app = await bootApp();
  });

  it('a settings.manage holder (non-admin token) can CREATE a field — the old gate 403d this', async () => {
    const res = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ fieldKey: 'custom_probe', label: 'Probe Field', fieldType: 'text', section: 'Additional', isMandatory: false, isVisible: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.isMandatory, false);
    customFieldId = res.body.id;
    assert.ok(customFieldId);
  });

  it('the Required flag round-trips: toggle false -> true persists through GET', async () => {
    const toggled = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ id: customFieldId, fieldKey: 'custom_probe', label: 'Probe Field', fieldType: 'text', section: 'Additional', isMandatory: true, isVisible: true });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.isMandatory, true);

    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(list.status, 200);
    const probe = (list.body as any[]).find(f => f.fieldKey === 'custom_probe');
    assert.ok(probe, 'probe field listed');
    assert.equal(probe.isMandatory, true, 'GET must show the persisted Required flag');
  });

  it('edit changes label / placeholder / section / dropdown source and persists', async () => {
    const edited = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({
        id: customFieldId, fieldKey: 'custom_probe', label: 'Probe Renamed', fieldType: 'dropdown',
        section: 'Business', isMandatory: true, isVisible: true, placeholder: 'Pick one', metadataTypeKey: 'Product',
      });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.label, 'Probe Renamed');
    assert.equal(edited.body.fieldType, 'dropdown');
    assert.equal(edited.body.metadataTypeKey, 'Product');
    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    const probe = (list.body as any[]).find(f => f.fieldKey === 'custom_probe');
    assert.equal(probe.section, 'Business');
    assert.equal(probe.placeholder, 'Pick one');
  });

  it('reorder works for the settings.manage holder', async () => {
    const res = await request(app)
      .post('/api/form-fields/reorder')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ orderedIds: [customFieldId, systemFieldId] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
  });

  it('a caller without settings.manage is refused on save, reorder and delete', async () => {
    const save = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ fieldKey: 'custom_nope', label: 'Nope', fieldType: 'text', isMandatory: true });
    assert.equal(save.status, 403);
    const reorder = await request(app)
      .post('/api/form-fields/reorder')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ orderedIds: [customFieldId] });
    assert.equal(reorder.status, 403);
    const del = await request(app)
      .delete(`/api/form-fields/${customFieldId}`)
      .set('Authorization', `Bearer ${plainToken}`);
    assert.equal(del.status, 403);
  });

  it('an ADMIN token still passes (bypass preserved)', async () => {
    const res = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: customFieldId, fieldKey: 'custom_probe', label: 'Probe Renamed', fieldType: 'dropdown', section: 'Business', isMandatory: false, isVisible: true, placeholder: 'Pick one', metadataTypeKey: 'Product' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.isMandatory, false);
  });

  it('system fields cannot be deleted (400); custom fields delete cleanly', async () => {
    const sys = await request(app)
      .delete(`/api/form-fields/${systemFieldId}`)
      .set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(sys.status, 400);
    const del = await request(app)
      .delete(`/api/form-fields/${customFieldId}`)
      .set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    assert.ok(!(list.body as any[]).some(f => f.fieldKey === 'custom_probe'));
  });
});

// ---------------------------------------------------------------------------
// Source guards — the client actually shipped the controls.
// ---------------------------------------------------------------------------

describe('FIX-1b — source guards', () => {
  const settings = readFileSync(new URL('../../src/modules/settings/pages/Settings.tsx', import.meta.url), 'utf8');
  const metadataRoutes = readFileSync(new URL('../routes/production/metadata.routes.ts', import.meta.url), 'utf8');
  const teamPage = readFileSync(new URL('../../src/modules/team/pages/TeamOverview.tsx', import.meta.url), 'utf8');
  const morePages = readFileSync(new URL('../../src/modules/navigation/pages/MorePages.tsx', import.meta.url), 'utf8');

  it('Form Builder rows have an Edit control wired to an edit mode', () => {
    assert.match(settings, /handleEditField/);
    assert.match(settings, /editingField/);
    assert.match(settings, /Save Changes/);
  });

  it('form-field mutations use the settings.manage gate, not requireAdmin', () => {
    assert.match(metadataRoutes, /router\.post\('\/form-fields', requireAuth, requirePermissionCode\('settings\.manage'\)/);
    assert.match(metadataRoutes, /router\.delete\('\/form-fields\/:id', requireAuth, requirePermissionCode\('settings\.manage'\)/);
    assert.match(metadataRoutes, /router\.post\('\/form-fields\/reorder', requireAuth, requirePermissionCode\('settings\.manage'\)/);
  });

  it('the Team overview page and Administration entry exist', () => {
    assert.match(teamPage, /\/api\/team\/overview/);
    assert.match(teamPage, /Managers/);
    assert.match(teamPage, /Team Leaders/);
    assert.match(teamPage, /Team Members/);
    assert.match(morePages, /label: 'Team'/);
  });
});
