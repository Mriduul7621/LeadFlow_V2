import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as up059 } from '../database/migrations/059_form_fields_timestamps.js';

/**
 * Form-save `id` failure — the THIRD schema-drift escape (owner-verified
 * live, 2026-11-11, on the PR #121 preview).
 *
 * Migration 059 fixed the missing timestamp columns, and immediately the
 * next layer surfaced: saving a form field died with
 *   null value in column "id" of relation "form_fields" violates
 *   not-null constraint
 * Production's form_fields is the LEGACY bootstrap shape (server/db.ts):
 * `id VARCHAR(255) PRIMARY KEY` with NO default — the legacy seed
 * supplied ids from app code — while the save upsert in
 * metadata.routes.ts supplied no id at all (the canonical 035 shape has
 * DEFAULT gen_random_uuid(), and even the 059 suite's "old shape"
 * fixture quietly kept a UUID default on id, which is how this slipped
 * through a second time).
 *
 * This suite builds form_fields / workflow_rules / metadata_types from
 * the server/db.ts DDL VERBATIM (VARCHAR id, no default), applies
 * migration 059 (the state production is in now), proves the pre-fix
 * upsert statement dies with the owner's exact error, and then proves
 * the fixed API path end-to-end: create + Required toggle + reorder +
 * read-back, with row identity (id) never overwritten on update.
 */

const JWT_SECRET = 'form-save-id-legacy-shape-test-secret';

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

/** The TRUE legacy shapes — server/db.ts DDL, copied verbatim. */
async function setupLegacyTables(pool: any) {
  // server/db.ts: metadata_types — key is the PK; there is NO id column.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255),
      description VARCHAR(500),
      is_system BOOLEAN DEFAULT FALSE,
      sort_order INTEGER DEFAULT 0
    )
  `);
  // options: the 007 shape (born with an id default + timestamps).
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
  // server/db.ts VERBATIM: form_fields — id VARCHAR PRIMARY KEY, NO default.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_fields (
      id VARCHAR(255) PRIMARY KEY,
      field_key VARCHAR(100) UNIQUE,
      label VARCHAR(255),
      field_type VARCHAR(50),
      section VARCHAR(100),
      is_mandatory BOOLEAN DEFAULT FALSE,
      is_visible BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN DEFAULT FALSE,
      created_date VARCHAR(255)
    )
  `);
  // server/db.ts VERBATIM: workflow_rules — id VARCHAR PRIMARY KEY, NO default.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id VARCHAR(255) PRIMARY KEY,
      status VARCHAR(255) UNIQUE,
      allowed_next_statuses TEXT,
      requires_loss_reason BOOLEAN DEFAULT FALSE,
      requires_meeting_type BOOLEAN DEFAULT FALSE,
      requires_followup_type BOOLEAN DEFAULT FALSE,
      requires_note BOOLEAN DEFAULT FALSE,
      is_system BOOLEAN DEFAULT FALSE,
      created_date VARCHAR(255)
    )
  `);
}

async function columnDefault(pool: any, table: string, column: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows.length ? res.rows[0].column_default : null;
}

describe('form-save id — true legacy shape (VARCHAR id, no default)', () => {
  let pool: any;
  let app: express.Express;
  let mgrToken: string;
  const systemFieldId = 'field_marital_status';
  const systemRuleId = 'rule_not_interested';
  let createdFieldId = '';
  let createdRuleId = '';

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupAuxSchema(pool);
    await setupLegacyTables(pool);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const role: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    for (const code of ['settings.manage', 'workflow.manage']) {
      const perm: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`, [code]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [role.rows[0].id, perm.rows[0].id]);
    }
    const hash = await bcrypt.hash('password123', 10);
    const user: any = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id) VALUES ('LEGACY1', 'Legacy Mgr', 'legacy1@test.com', $1, $2, $3) RETURNING id`,
      [hash, role.rows[0].id, dept.rows[0].id]
    );
    mgrToken = jwt.sign(
      { id: user.rows[0].id, employeeId: 'LEGACY1', email: 'legacy1@test.com', role: 'EMPLOYEE', name: 'Legacy Mgr' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Pre-existing production rows, written the legacy way (id from app code).
    await pool.query(
      `INSERT INTO form_fields (id, field_key, label, field_type, section, is_mandatory, is_visible, sort_order, metadata_type_key, is_system, created_date)
       VALUES ($1, 'marital_status', 'Marital Status', 'dropdown', 'Identity', FALSE, TRUE, 6, 'MaritalStatus', TRUE, '2026-01-01T00:00:00.000Z')`,
      [systemFieldId]
    );
    await pool.query(
      `INSERT INTO workflow_rules (id, status, allowed_next_statuses, requires_loss_reason, requires_meeting_type, is_system, created_date)
       VALUES ($1, 'Not Interested', NULL, TRUE, FALSE, TRUE, '2026-01-01T00:00:00.000Z')`,
      [systemRuleId]
    );

    // The state production is in today: legacy shape + migration 059 applied.
    await up059();

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  it('precondition: the legacy tables really have a VARCHAR id with NO default', async () => {
    assert.equal(await columnDefault(pool, 'form_fields', 'id'), null, 'form_fields.id must have no default in this fixture');
    assert.equal(await columnDefault(pool, 'workflow_rules', 'id'), null, 'workflow_rules.id must have no default in this fixture');
    const ff: any = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'form_fields' AND column_name = 'id'`
    );
    assert.equal(ff.rows[0].data_type, 'character varying');
    const mt: any = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'metadata_types' AND column_name = 'id'`
    );
    assert.equal(mt.rows.length, 0, 'metadata_types has no id column at all — nothing to fix there');
  });

  it('the PRE-FIX upsert statement dies here with the owner\u2019s exact error', async () => {
    // The form-field upsert exactly as it read before this fix (no id).
    await assert.rejects(
      pool.query(
        `INSERT INTO form_fields (field_key, label, field_type, section, is_mandatory, is_visible, sort_order,
                                  metadata_type_key, placeholder, is_system, created_at, updated_at)
         VALUES ('id_probe', 'ID Probe', 'text', 'Additional', FALSE, TRUE, 9, NULL, NULL, FALSE, NOW(), NOW())
         ON CONFLICT (field_key) DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()
         RETURNING *`
      ),
      /null value in column "id" of relation "form_fields" violates not-null constraint/
    );
    // Same for the workflow-rule upsert as it read before this fix (no id).
    await assert.rejects(
      pool.query(
        `INSERT INTO workflow_rules (status, allowed_next_statuses, requires_loss_reason, requires_meeting_type,
                                     requires_followup_type, requires_note, is_system, created_at, updated_at)
         VALUES ('Id Probe', NULL, FALSE, FALSE, FALSE, TRUE, FALSE, NOW(), NOW())
         ON CONFLICT (status) DO UPDATE SET requires_note = EXCLUDED.requires_note, updated_at = NOW()
         RETURNING *`
      ),
      /null value in column "id" of relation "workflow_rules" violates not-null constraint/
    );
  });

  it('FIXED: form-field create succeeds on the legacy shape and returns a real id', async () => {
    const created = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ fieldKey: 'id_probe', label: 'ID Probe', fieldType: 'text', section: 'Additional', isMandatory: false, isVisible: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body.id, 'the created field carries a non-null id');
    createdFieldId = created.body.id;
    const row: any = await pool.query(`SELECT id FROM form_fields WHERE field_key = 'id_probe'`);
    assert.equal(row.rows[0].id, createdFieldId);
  });

  it('FIXED: Required toggle works and never overwrites the row id', async () => {
    const toggled = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ id: createdFieldId, fieldKey: 'id_probe', label: 'ID Probe', fieldType: 'text', section: 'Additional', isMandatory: true, isVisible: true });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.isMandatory, true);
    assert.equal(toggled.body.id, createdFieldId, 'update path must keep the original id');

    // The owner's exact scenario: toggling Required on the pre-existing
    // system field. The payload even carries the legacy id — the stored
    // identity must survive untouched.
    const sysToggled = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({
        id: systemFieldId, fieldKey: 'marital_status', label: 'Marital Status', fieldType: 'dropdown',
        section: 'Identity', isMandatory: true, isVisible: true, metadataTypeKey: 'MaritalStatus',
      });
    assert.equal(sysToggled.status, 200, JSON.stringify(sysToggled.body));
    assert.equal(sysToggled.body.isMandatory, true);
    const row: any = await pool.query(`SELECT id, is_mandatory FROM form_fields WHERE field_key = 'marital_status'`);
    assert.equal(row.rows[0].id, systemFieldId, 'the legacy row keeps its original VARCHAR id');
    assert.equal(row.rows[0].is_mandatory, true);
  });

  it('FIXED: reorder + read-back round-trip on the legacy shape', async () => {
    const reorder = await request(app)
      .post('/api/form-fields/reorder')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ orderedIds: [createdFieldId, systemFieldId] });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.equal(reorder.body.success, true);

    const list = await request(app).get('/api/form-fields').set('Authorization', `Bearer ${mgrToken}`);
    assert.equal(list.status, 200);
    const probe = (list.body as any[]).find(f => f.fieldKey === 'id_probe');
    assert.ok(probe, 'created field listed');
    assert.equal(probe.isMandatory, true, 'GET shows the persisted Required flag');
    const sys = (list.body as any[]).find(f => f.fieldKey === 'marital_status');
    assert.equal(sys.isMandatory, true);
  });

  it('FIXED: workflow-rule create + update succeed and keep the row id', async () => {
    const created = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ status: 'Id Probe', requiresNote: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body.id, 'the created rule carries a non-null id');
    createdRuleId = created.body.id;

    const updated = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ status: 'Id Probe', requiresNote: false, requiresLossReason: true });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.id, createdRuleId, 'update path must keep the original id');
    const row: any = await pool.query(`SELECT id, requires_loss_reason FROM workflow_rules WHERE status = 'Id Probe'`);
    assert.equal(row.rows[0].id, createdRuleId);
    assert.equal(row.rows[0].requires_loss_reason, true);

    // Re-saving the pre-existing legacy rule keeps its VARCHAR id too.
    const legacy = await request(app)
      .post('/api/workflow-rules')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ status: 'Not Interested', requiresLossReason: true, requiresNote: true });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    const legacyRow: any = await pool.query(`SELECT id FROM workflow_rules WHERE status = 'Not Interested'`);
    assert.equal(legacyRow.rows[0].id, systemRuleId, 'the legacy rule keeps its original VARCHAR id');
  });

  it('metadata_types save works unchanged (key is the PK — no id trap)', async () => {
    const type = await request(app)
      .post('/api/metadata-types')
      .set('Authorization', `Bearer ${mgrToken}`)
      .send({ key: 'IdProbeType', label: 'ID Probe Type', description: 'probe' });
    assert.equal(type.status, 200, JSON.stringify(type.body));
    const row: any = await pool.query(`SELECT key FROM metadata_types WHERE key = 'IdProbeType'`);
    assert.equal(row.rows.length, 1);
  });
});
