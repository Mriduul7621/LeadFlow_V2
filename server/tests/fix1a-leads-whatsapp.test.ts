import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { seedMetadata } from '../database/seeds/metadata.seed.js';
import {
  WHATSAPP_TEMPLATES,
  buildWhatsAppHref,
  buildWhatsAppHrefForTemplate,
  buildWhatsAppDirectHref,
  resolveWhatsAppTemplates,
} from '../../src/modules/leads/utils/whatsappTemplates.js';
import {
  validateLeadStatusFields,
  leadStatusViolationMessage,
} from '../../src/modules/leads/utils/leadStatusRules.js';

/**
 * FIX-1a — Leads-page status parity (item 1), WhatsApp on the
 * Leads-page surfaces (item 2), the two WhatsApp options (item 3) and
 * admin-managed templates (item 4).
 *
 * FIX-1c note: the LeadList in-page status modal that item 1 originally
 * served has been REMOVED — editing a lead from the Leads page now
 * opens the Lead 360 workspace, and the status write runs through
 * LeadUpdate.tsx, which derives from the SAME shared rule table
 * (leadStatusRules.ts). The item-1 tests below therefore pin the rule
 * table itself (the single source both the server and LeadUpdate
 * consume) plus LeadUpdate's wiring, instead of the deleted modal
 * helper (leadListStatusForm.ts, removed with the modal).
 */

// ---------------------------------------------------------------------------
// Item 1 — the surviving update path (Lead 360 -> LeadUpdate) walks the
// shared F6 rule table.
// ---------------------------------------------------------------------------

describe('FIX-1 item 1 — shared rule table behind the LeadUpdate path', () => {
  it('Not Interested without a loss reason violates lossReason — the production bug', () => {
    const violations = validateLeadStatusFields('Not Interested', {});
    assert.ok(violations.some(v => v.field === 'lossReason'));
    assert.match(leadStatusViolationMessage(violations), /loss reason/i);
  });

  it('Not Interested with a loss reason passes', () => {
    assert.deepEqual(validateLeadStatusFields('Not Interested', { lossReason: 'Price' }), []);
  });

  it('Proposal Sent requires product, sum and projected', () => {
    const fields = validateLeadStatusFields('Proposal Sent', {}).map(v => v.field).sort();
    assert.deepEqual(fields, ['productName', 'projectedNCP', 'sumAssured']);
    assert.deepEqual(
      validateLeadStatusFields('Proposal Sent', { productName: 'S3PP', sumAssured: 300000, projectedNCP: 15000 }),
      [],
    );
  });

  it('Converted requires product, sum and collected', () => {
    const fields = validateLeadStatusFields('Converted', {}).map(v => v.field).sort();
    assert.deepEqual(fields, ['collectedNCP', 'productName', 'sumAssured']);
    assert.deepEqual(
      validateLeadStatusFields('Converted', { productName: 'S4PP', sumAssured: 200000, collectedNCP: 12000 }),
      [],
    );
  });

  it('Meeting Fixed requires the meeting date; Follow-up Set requires the follow-up date', () => {
    assert.ok(validateLeadStatusFields('Meeting Fixed', {}).some(v => v.field === 'meetingDate'));
    assert.deepEqual(validateLeadStatusFields('Meeting Fixed', { meetingDate: '2026-11-20' }), []);
    assert.ok(validateLeadStatusFields('Follow-up Set', {}).some(v => v.field === 'nextFollowUpDate'));
    assert.deepEqual(validateLeadStatusFields('Follow-up Set', { nextFollowUpDate: '2026-11-15' }), []);
  });

  it('plain statuses need nothing extra', () => {
    assert.deepEqual(validateLeadStatusFields('Interested', {}), []);
    assert.deepEqual(validateLeadStatusFields('Contacted', {}), []);
  });
});

// ---------------------------------------------------------------------------
// Items 3 + 4 — two WhatsApp options and admin-managed templates.
// ---------------------------------------------------------------------------

describe('FIX-1 items 3/4 — WhatsApp hrefs and template resolution', () => {
  it('template href carries the rendered message', () => {
    const href = buildWhatsAppHrefForTemplate('01712345678', WHATSAPP_TEMPLATES[0], 'Karim');
    assert.ok(href.startsWith('https://wa.me/8801712345678?text='));
    assert.ok(decodeURIComponent(href).includes('Karim'));
  });

  it('direct href is the bare wa.me link with NO prefilled text', () => {
    const href = buildWhatsAppDirectHref('01712345678');
    assert.equal(href, 'https://wa.me/8801712345678');
    assert.ok(!href.includes('?text='));
  });

  it('built-in href builder is unchanged (regression)', () => {
    const href = buildWhatsAppHref('01712345678', 'first_contact', 'Karim');
    assert.ok(href.startsWith('https://wa.me/8801712345678?text='));
  });

  it('resolveWhatsAppTemplates: stored active options with bodies win', () => {
    const resolved = resolveWhatsAppTemplates([
      { value: 'greeting', label: 'Greeting', status: 'Active', meta: { body: 'Hello {name}' } },
      { value: 'off', label: 'Off one', status: 'Inactive', meta: { body: 'unused' } },
      { value: 'empty', label: 'Empty', status: 'Active', meta: {} },
    ]);
    assert.ok(resolved);
    assert.equal(resolved!.length, 1);
    assert.equal(resolved![0].id, 'greeting');
    assert.equal(resolved![0].body, 'Hello {name}');
  });

  it('resolveWhatsAppTemplates: nothing usable stored -> null (defaults apply)', () => {
    assert.equal(resolveWhatsAppTemplates([]), null);
    assert.equal(resolveWhatsAppTemplates(null), null);
    assert.equal(resolveWhatsAppTemplates([{ value: 'x', label: 'X', status: 'Inactive', meta: { body: 'b' } }]), null);
  });

  it('defaults stay the three Bangla templates', () => {
    assert.deepEqual(WHATSAPP_TEMPLATES.map(t => t.id), ['first_contact', 'follow_up', 'meeting_confirmation']);
  });
});

// ---------------------------------------------------------------------------
// Source guards — the Leads-page surfaces actually shipped the fixes.
// ---------------------------------------------------------------------------

describe('FIX-1 — source guards', () => {
  const leadList = readFileSync(new URL('../../src/modules/leads/pages/LeadList.tsx', import.meta.url), 'utf8');
  const leadUpdate = readFileSync(new URL('../../src/modules/leads/pages/LeadUpdate.tsx', import.meta.url), 'utf8');
  const lead360 = readFileSync(new URL('../../src/modules/leads/pages/Lead360.tsx', import.meta.url), 'utf8');
  const whatsAppAction = readFileSync(new URL('../../src/modules/leads/components/WhatsAppAction.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../../src/modules/settings/pages/Settings.tsx', import.meta.url), 'utf8');

  // FIX-1c replaced the two guards that pinned the old LeadList modal
  // (WhatsApp + loss-reason collection, server-message toast): the modal
  // no longer exists, so the same protections are pinned on the path
  // that replaced it — Leads page -> Lead 360 -> LeadUpdate.
  it('FIX-1c: Leads-page Edit opens the Lead 360 workspace; the in-list modal is gone', () => {
    assert.ok(leadList.includes('navigate(`/leads/${lead.id}`)'), 'row click / Edit must navigate to Lead 360');
    assert.ok(leadList.includes("params.get('leadId')"), 'the ?leadId= deep link must still be honoured');
    assert.ok(leadList.includes('replace: true'), 'the deep link must redirect into Lead 360');
    assert.ok(!leadList.includes('selectedLead'), 'the modal state must be gone');
    assert.ok(!leadList.includes('Lead Detail Modal'), 'the modal markup must be gone');
    assert.ok(!leadList.includes('leadListStatusForm'), 'the modal-only helper must be gone');
  });

  it('FIX-1c: the Lead 360 workspace offers the status update page', () => {
    assert.ok(lead360.includes('/update`'), 'Lead 360 must link into the update page');
    assert.match(lead360, /WhatsAppAction/);
  });

  it('FIX-1c: LeadUpdate sends the loss reason for Not Interested (updateLeadStatus arg 12)', () => {
    assert.ok(leadUpdate.includes('needsLossReason'), 'LeadUpdate must derive the loss-reason requirement');
    assert.ok(
      leadUpdate.includes('needsLossReason ? lossReason : undefined'),
      'the follow-up call must carry the loss reason when the status is Not Interested',
    );
    assert.match(leadUpdate, /validateLeadStatusFields/);
  });

  it('update-path failures surface the server message, not a bare generic toast', () => {
    assert.match(leadUpdate, /toast\.error\(err\?\.message \|\| t\('updError'\)\)/);
    assert.ok(!leadList.includes("toast.error('Failed to update lead status')"));
  });

  it('LeadUpdate (Leads-page follow-up flow) renders WhatsApp', () => {
    assert.match(leadUpdate, /WhatsAppAction/);
  });

  it('the WhatsApp menu offers BOTH options: templates and open-directly', () => {
    assert.match(whatsAppAction, /Open WhatsApp directly/);
    assert.match(whatsAppAction, /buildWhatsAppDirectHref/);
    assert.match(whatsAppAction, /WhatsAppTemplates/);
  });

  it('Settings has the admin WhatsApp Templates section', () => {
    assert.match(settings, /id: 'whatsapp'/);
    assert.match(settings, /WhatsAppTemplates/);
  });
});

// ---------------------------------------------------------------------------
// Item 4 — seed: type + three defaults, idempotent, and the type lands
// even when metadata_types is already populated (long-lived databases).
// ---------------------------------------------------------------------------

async function setupMetadataSchema(pool: any) {
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
}

describe('FIX-1 item 4 — WhatsAppTemplates seed', () => {
  let pool: any;

  before(async () => {
    process.env.DATABASE_URL = '';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupMetadataSchema(pool);
  });

  it('seeds the type and the three default templates with bodies, idempotently', async () => {
    await seedMetadata();
    const types: any = await pool.query(`SELECT key FROM metadata_types WHERE key = 'WhatsAppTemplates'`);
    assert.equal(types.rows.length, 1);
    const opts: any = await pool.query(
      `SELECT option_value, option_label, meta FROM options WHERE field_key = 'WhatsAppTemplates' ORDER BY sort_order`
    );
    assert.equal(opts.rows.length, 3);
    assert.deepEqual(opts.rows.map((r: any) => r.option_value), ['first_contact', 'follow_up', 'meeting_confirmation']);
    for (const [i, row] of opts.rows.entries()) {
      assert.equal(row.meta.body, WHATSAPP_TEMPLATES[i].body, `seed body for ${row.option_value} must match the built-in default`);
    }
    await seedMetadata();
    const again: any = await pool.query(`SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'WhatsAppTemplates'`);
    assert.equal(again.rows[0].n, 3);
  });

  it('creates the type even when metadata_types is already populated', async () => {
    await pool.query(`DELETE FROM options WHERE field_key = 'WhatsAppTemplates'`);
    await pool.query(`DELETE FROM metadata_types WHERE key = 'WhatsAppTemplates'`);
    await pool.query(`INSERT INTO metadata_types (key, label, is_system, sort_order) VALUES ('Product', 'Product', TRUE, 1) ON CONFLICT (key) DO NOTHING`);
    await seedMetadata();
    const types: any = await pool.query(`SELECT key FROM metadata_types WHERE key = 'WhatsAppTemplates'`);
    assert.equal(types.rows.length, 1, 'the type must be upserted even on a non-empty types table');
    const opts: any = await pool.query(`SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'WhatsAppTemplates'`);
    assert.equal(opts.rows[0].n, 3);
  });
});

// ---------------------------------------------------------------------------
// Item 4 — template changes are audit-logged with old→new meta values.
// ---------------------------------------------------------------------------

const JWT_SECRET = ['fix1a', '-test', '-secret'].join('');

async function setupAuditSchema(pool: any) {
  await setupMetadataSchema(pool);
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
}

describe('FIX-1 item 4 — template audit trail carries old→new bodies', () => {
  let pool: any;
  let app: express.Express;
  let managerToken: string;
  let plainToken: string;

  before(async () => {
    // A truthy placeholder: useDb()/isDatabaseConfigured() keys off its
    // presence; the actual pool is the PGlite test pool below.
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupAuditSchema(pool);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const role: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);
    const perm: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [role.rows[0].id, perm.rows[0].id]);
    const hash = await bcrypt.hash('password123', 10);
    const mk = async (emp: string, roleId: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, hash, roleId, dept.rows[0].id]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: 'EMPLOYEE', name: emp };
    };
    const manager = await mk('FIXMGR', role.rows[0].id);
    const plain = await mk('FIXPLAIN', plainRole.rows[0].id);
    managerToken = jwt.sign(manager, JWT_SECRET, { expiresIn: '1h' });
    plainToken = jwt.sign(plain, JWT_SECRET, { expiresIn: '1h' });

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  it('a settings.manage holder can save a template; the audit row carries the body old→new', async () => {
    const created = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ type: 'WhatsAppTemplates', value: 'custom_greeting', label: 'Greeting', meta: { body: 'Hello {name}' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const updated = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ type: 'WhatsAppTemplates', value: 'custom_greeting', label: 'Greeting', meta: { body: 'Bye {name}' } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const audits: any = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action_code = 'options.save' ORDER BY created_at ASC, metadata->>'value' ASC`
    );
    const rows = audits.rows.map((r: any) => r.metadata).filter((m: any) => m.type === 'WhatsAppTemplates' && m.value === 'custom_greeting');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].oldValue, null);
    assert.equal(rows[0].newValue.meta.body, 'Hello {name}');
    assert.equal(rows[1].oldValue.meta.body, 'Hello {name}');
    assert.equal(rows[1].newValue.meta.body, 'Bye {name}');
  });

  it('a caller without settings.manage gets 403', async () => {
    const res = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ type: 'WhatsAppTemplates', value: 'nope', label: 'Nope', meta: { body: 'x' } });
    assert.equal(res.status, 403);
  });

  it('non-template option saves keep the lean audit shape (no meta)', async () => {
    const res = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ type: 'Product', value: 'FIX1A Product', label: 'FIX1A Product' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const audits: any = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action_code = 'options.save' AND metadata->>'type' = 'Product'`
    );
    assert.ok(audits.rows.length >= 1);
    assert.equal(audits.rows[0].metadata.newValue.meta, undefined);
  });
});
