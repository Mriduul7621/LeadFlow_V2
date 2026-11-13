import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as up059 } from '../database/migrations/059_form_fields_timestamps.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';

/**
 * 059 — form_fields schema-drift repair (owner-verified live, 2026-11-11).
 *
 * Production's form_fields predates migration 035: it was created by
 * the legacy bootstrap (server/db.ts) with a `created_date` VARCHAR
 * and NO created_at/updated_at, and 035's CREATE TABLE IF NOT EXISTS
 * never upgraded it — while the save upsert writes both columns. Every
 * form-field save in production therefore died with
 *   column "created_at" of relation "form_fields" does not exist
 * Test suites never caught it because they build the 035 shape.
 *
 * This suite builds the OLD shapes (form_fields, workflow_rules and
 * metadata_types exactly as the legacy bootstrap made them), proves
 * the saves fail with the owner's error, runs migration 059, and then
 * proves the full save round-trips work. Options is built in its 007
 * shape and asserted untouched (007 gave it both columns at birth).
 */

const JWT_SECRET = ['drift059', '-test', '-secret'].join('');

async function setupAuxSchema(pool: any) {
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

/** The pre-035 (legacy bootstrap, server/db.ts) shapes — the drift. */
async function setupOldShapeTables(pool: any) {
  // metadata_types: key/label/description/is_system/sort_order — NO created_at.
  await pool.query(`
    CREATE TABLE metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255),
      description VARCHAR(500),
      is_system BOOLEAN DEFAULT FALSE,
      sort_order INTEGER DEFAULT 0
    );
  `);
  // options: the 007 shape — born WITH created_at/updated_at (no drift).
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
  // form_fields: legacy shape — created_date VARCHAR, NO created_at/updated_at.
  await pool.query(`
    CREATE TABLE form_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL UNIQUE,
      label VARCHAR(255) NOT NULL,
      field_type VARCHAR(50) NOT NULL DEFAULT 'text',
      section VARCHAR(100),
      is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_date VARCHAR(255)
    );
  `);
  // workflow_rules: legacy shape — allowed_next_statuses TEXT,
  // created_date VARCHAR, NO created_at/updated_at.
  await pool.query(`
    CREATE TABLE workflow_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status VARCHAR(255) NOT NULL UNIQUE,
      allowed_next_statuses TEXT,
      requires_loss_reason BOOLEAN NOT NULL DEFAULT FALSE,
      requires_meeting_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_followup_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_note BOOLEAN NOT NULL DEFAULT FALSE,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_date VARCHAR(255)
    );
  `);
}

async function columnExists(pool: any, table: string, column: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows.length > 0;
}

describe('059 — form_fields schema drift repair', () => {
  let pool: any;
  let app: express.Express;
  let mgrToken: string;
  let systemFieldId: string;
  let createdFieldId: string;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupAuxSchema(pool);
    await setupOldShapeTables(pool);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const role: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    for (const code of ['settings.manage', 'workflow.manage']) {
      const perm: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`, [code]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [role.rows[0].id, perm.rows[0].id]);
    }
    const hash = await bcrypt.hash('password123', 10);
    const user: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id) VALUES ('DRIFT1', 'Drift Mgr', 'drift1@test.com', $1, $2, $3) RETURNING id`,
      [hash, role.rows[0].id, dept.rows[0].id]
    );
    mgrToken = jwt.sign(
      { id: user.rows[0].id, employeeId: 'DRIFT1', email: 'drift1@test.com', role: 'EMPLOYEE', name: 'Drift Mgr' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // A pre-existing production-style system field, written the legacy way.
    const sys: any = await pool.query(
      `INSERT INTO form_fields (field_key, label, field_type, section, is_mandatory, is_visible, sort_order, metadata_type_key, is_system, created_date)
       VALUES ('marital_status', 'Marital Status', 'dropdown', 'Identity', FALSE, TRUE, 6, 'MaritalStatus', TRUE, '2026-01-01T00:00:00.000Z') RETURNING id`
    );
    systemFieldId = sys.rows[0].id;

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  it('the old shapes really lack the timestamp columns (precondition)', async () => {
    assert.equal(await columnExists(pool, 'form_fields', 'created_at'), false);
    assert.equal(await columnExists(pool, 'form_fields', 'updated_at'), false);
    assert.equal(await columnExists(pool, 'metadata_types', 'created_at'), false);
    assert.equal(await columnExists(pool, 'workflow_rules', 'created_at'), false);
    assert.equal(await columnExists(pool, 'workflow_rules', 'updated_at'), false);
    assert.equal(await columnExists(pool, 'options', 'created_at'), true, 'options was born with timestamps (007)');
  });

  it('BEFORE 059: the form-field save fails with the owner\u2019s exact production error', async () => {
    const res = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({
        id: systemFieldId, fieldKey: 'marital_status', label: 'Marital Status', fieldType: 'dropdown',
        section: 'Identity', isMandatory: true, isVisible: true, metadataTypeKey: 'MaritalStatus',
      });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.match(String(res.body.message || ''), /created_at/);
    assert.match(String(res.body.message || ''), /form_fields/);
    assert.match(String(res.body.message || ''), /does not exist/);
  });

  it('BEFORE 059: workflow-rule and metadata-type saves fail the same way', async () => {
    const rule = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ status: 'Drift Probe', requiresNote: true });
    assert.equal(rule.status, 500, JSON.stringify(rule.body));
    assert.match(String(rule.body.message || ''), /created_at/);

    const type = await request(app)
      .post('/api/metadata-types')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ key: 'DriftProbe', label: 'Drift Probe', description: 'probe' });
    assert.equal(type.status, 500, JSON.stringify(type.body));
    assert.match(String(type.body.message || ''), /created_at/);
  });

  it('migration 059 adds exactly the missing columns (options untouched)', async () => {
    await up059();
    assert.equal(await columnExists(pool, 'form_fields', 'created_at'), true);
    assert.equal(await columnExists(pool, 'form_fields', 'updated_at'), true);
    assert.equal(await columnExists(pool, 'metadata_types', 'created_at'), true);
    assert.equal(await columnExists(pool, 'metadata_types', 'updated_at'), false, '035 shape has no updated_at for metadata_types — 059 must not invent one');
    assert.equal(await columnExists(pool, 'workflow_rules', 'created_at'), true);
    assert.equal(await columnExists(pool, 'workflow_rules', 'updated_at'), true);
    // Existing rows survive and are backfilled by the column default.
    const sys: any = await pool.query(`SELECT created_at FROM form_fields WHERE field_key = 'marital_status'`);
    assert.equal(sys.rows.length, 1);
    assert.ok(sys.rows[0].created_at, 'pre-existing row got a created_at from the default');
  });

  it('AFTER 059: create + Required-toggle + read-back round-trip succeeds', async () => {
    const created = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ fieldKey: 'drift_probe', label: 'Drift Probe', fieldType: 'text', section: 'Additional', isMandatory: false, isVisible: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.isMandatory, false);
    assert.ok(created.body.createdDate, 'the save now returns the persisted created_at');
    createdFieldId = created.body.id;

    const toggled = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ id: createdFieldId, fieldKey: 'drift_probe', label: 'Drift Probe', fieldType: 'text', section: 'Additional', isMandatory: true, isVisible: true });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.isMandatory, true);

    // The owner's exact scenario: toggling Required on the pre-existing system field.
    const sysToggled = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({
        id: systemFieldId, fieldKey: 'marital_status', label: 'Marital Status', fieldType: 'dropdown',
        section: 'Identity', isMandatory: true, isVisible: true, metadataTypeKey: 'MaritalStatus',
      });
    assert.equal(sysToggled.status, 200, JSON.stringify(sysToggled.body));
    assert.equal(sysToggled.body.isMandatory, true);

    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(list.status, 200);
    const probe = (list.body as any[]).find(f => f.fieldKey === 'drift_probe');
    assert.ok(probe, 'created field listed');
    assert.equal(probe.isMandatory, true, 'GET shows the persisted Required flag');
    const sys = (list.body as any[]).find(f => f.fieldKey === 'marital_status');
    assert.equal(sys.isMandatory, true);
  });

  it('AFTER 059: reorder (UPDATE updated_at) and the sibling saves work', async () => {
    const reorder = await request(app)
      .post('/api/form-fields/reorder')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ orderedIds: [createdFieldId, systemFieldId] });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.equal(reorder.body.success, true);

    const rule = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ status: 'Drift Probe', requiresNote: true });
    assert.equal(rule.status, 200, JSON.stringify(rule.body));
    assert.ok(rule.body.createdDate);

    const type = await request(app)
      .post('/api/metadata-types')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ key: 'DriftProbe', label: 'Drift Probe', description: 'probe' });
    assert.equal(type.status, 200, JSON.stringify(type.body));
    const row: any = await pool.query(`SELECT created_at FROM metadata_types WHERE key = 'DriftProbe'`);
    assert.ok(row.rows[0].created_at, 'metadata_types row carries the added created_at');
  });

  it('migration 059 is idempotent: a second run is a no-op', async () => {
    const before: any = await pool.query(`SELECT COUNT(*)::int AS n FROM form_fields`);
    await up059();
    const after: any = await pool.query(`SELECT COUNT(*)::int AS n FROM form_fields`);
    assert.equal(after.rows[0].n, before.rows[0].n);
    assert.equal(await columnExists(pool, 'form_fields', 'created_at'), true);
    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(list.status, 200);
    assert.equal((list.body as any[]).filter(f => f.fieldKey === 'drift_probe').length, 1);
  });

  it('059 is registered as the migration tail (058 stays registered)', () => {
    assert.ok(MIGRATION_IDS.includes('059_form_fields_timestamps'));
    assert.ok(MIGRATION_IDS.includes('058_user_designation_backfill'));
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '059_form_fields_timestamps');
  });
});
