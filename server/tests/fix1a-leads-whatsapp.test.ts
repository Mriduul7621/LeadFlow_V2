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
  effectiveLeadListStatus,
  leadListStatusRulePayload,
  validateLeadListStatusForm,
  buildLeadListFollowUpArgs,
  type LeadListStatusFormState,
} from '../../src/modules/leads/utils/leadListStatusForm.js';
import { leadStatusViolationMessage } from '../../src/modules/leads/utils/leadStatusRules.js';

/**
 * FIX-1a — Leads-page status modal parity (item 1), WhatsApp on the
 * Leads-page surfaces (item 2), the two WhatsApp options (item 3) and
 * admin-managed templates (item 4).
 */

// ---------------------------------------------------------------------------
// Item 1 — the LeadList status form walks the shared F6 rule table.
// ---------------------------------------------------------------------------

const BASE: LeadListStatusFormState = {
  formStatus: '',
  formSubStatus: '',
  formNextFollowUpDate: '',
  formNextCallDate: '',
  formMeetingDate: '',
  formProductName: '',
  formSumAssured: 0,
  formProjectedNCP: 0,
  formCollectedNCP: 0,
  formLossReason: '',
};

describe('FIX-1 item 1 — LeadList status form vs the shared rule table', () => {
  it('Not Interested without a loss reason violates lossReason — the production bug', () => {
    const violations = validateLeadListStatusForm({ ...BASE, formStatus: 'Not Interested' });
    assert.ok(violations.some(v => v.field === 'lossReason'));
    assert.match(leadStatusViolationMessage(violations), /loss reason/i);
  });

  it('Not Interested with a loss reason passes, and the save args carry it (arg 12)', () => {
    const state = { ...BASE, formStatus: 'Not Interested', formLossReason: 'Price' };
    assert.deepEqual(validateLeadListStatusForm(state), []);
    const args = buildLeadListFollowUpArgs(state, 'customer declined');
    assert.equal(args.status, 'Not Interested');
    assert.equal(args.lossReason, 'Price');
  });

  it('Meeting Completed -> Not Interested also requires the loss reason', () => {
    const state = { ...BASE, formStatus: 'Meeting Completed', formSubStatus: 'Not Interested' };
    assert.equal(effectiveLeadListStatus(state), 'Not Interested');
    assert.ok(validateLeadListStatusForm(state).some(v => v.field === 'lossReason'));
    const ok = { ...state, formLossReason: 'Not interested in product' };
    assert.deepEqual(validateLeadListStatusForm(ok), []);
    assert.equal(buildLeadListFollowUpArgs(ok, '').lossReason, 'Not interested in product');
  });

  it('Meeting Completed -> Pipeline Locked: no table row (the modal manual checks guard it); args carry product/sum/projected', () => {
    // LEAD_STAGE_RULES deliberately has no 'Pipeline Locked' row — the
    // modal's own manual checks are the guard for that status, exactly
    // as before FIX-1. The helper must still pass the three money
    // fields through to the follow-up call.
    const state = { ...BASE, formStatus: 'Meeting Completed', formSubStatus: 'Pipeline Locked' };
    assert.deepEqual(validateLeadListStatusForm(state), []);
    const filled = { ...state, formProductName: 'Endowment', formSumAssured: 500000, formProjectedNCP: 25000 };
    const args = buildLeadListFollowUpArgs(filled, 'locked');
    assert.equal(args.status, 'Pipeline Locked');
    assert.equal(args.productName, 'Endowment');
    assert.equal(args.sumAssured, 500000);
    assert.equal(args.projectedNCP, 25000);
  });

  it('Proposal Sent requires product, sum and projected; args carry all three', () => {
    const state = { ...BASE, formStatus: 'Proposal Sent' };
    const fields = validateLeadListStatusForm(state).map(v => v.field).sort();
    assert.deepEqual(fields, ['productName', 'projectedNCP', 'sumAssured']);
    const ok = { ...state, formProductName: 'S3PP', formSumAssured: 300000, formProjectedNCP: 15000 };
    const args = buildLeadListFollowUpArgs(ok, 'proposal shared');
    assert.equal(args.productName, 'S3PP');
    assert.equal(args.sumAssured, 300000);
    assert.equal(args.projectedNCP, 15000);
  });

  it('Converted requires product, sum and collected; args carry them', () => {
    const state = { ...BASE, formStatus: 'Converted' };
    const fields = validateLeadListStatusForm(state).map(v => v.field).sort();
    assert.deepEqual(fields, ['collectedNCP', 'productName', 'sumAssured']);
    const ok = { ...state, formProductName: 'S4PP', formSumAssured: 200000, formCollectedNCP: 12000 };
    const args = buildLeadListFollowUpArgs(ok, 'done');
    assert.equal(args.ncp, 12000);
    assert.equal(args.productName, 'S4PP');
  });

  it('Meeting Fixed requires the meeting date; Follow-up Set requires the follow-up date', () => {
    assert.ok(validateLeadListStatusForm({ ...BASE, formStatus: 'Meeting Fixed' }).some(v => v.field === 'meetingDate'));
    assert.deepEqual(validateLeadListStatusForm({ ...BASE, formStatus: 'Meeting Fixed', formMeetingDate: '2026-11-20' }), []);
    assert.ok(validateLeadListStatusForm({ ...BASE, formStatus: 'Follow-up Set' }).some(v => v.field === 'nextFollowUpDate'));
    assert.deepEqual(validateLeadListStatusForm({ ...BASE, formStatus: 'Follow-up Set', formNextFollowUpDate: '2026-11-15' }), []);
  });

  it('No Response passes the call date through; plain statuses need nothing extra', () => {
    const state = { ...BASE, formStatus: 'No Response', formNextCallDate: '2026-11-14' };
    assert.deepEqual(validateLeadListStatusForm(state), []);
    assert.equal(buildLeadListFollowUpArgs(state, 'no answer').nextCallDate, '2026-11-14');
    assert.deepEqual(validateLeadListStatusForm({ ...BASE, formStatus: 'Interested' }), []);
  });

  it('rule payload mirrors LeadUpdate: loss reason comes from the form field, not remarks', () => {
    const payload = leadListStatusRulePayload({ ...BASE, formStatus: 'Not Interested', formLossReason: 'Competitor' }, 'some remarks');
    assert.equal(payload.lossReason, 'Competitor');
    assert.equal(payload.note, 'some remarks');
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
  const whatsAppAction = readFileSync(new URL('../../src/modules/leads/components/WhatsAppAction.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../../src/modules/settings/pages/Settings.tsx', import.meta.url), 'utf8');

  it('LeadList modal renders WhatsApp and collects the loss reason', () => {
    assert.match(leadList, /WhatsAppAction/);
    assert.match(leadList, /formLossReason/);
    assert.match(leadList, /validateLeadListStatusForm/);
  });

  it('LeadList failures surface the server message, not the bare generic toast', () => {
    assert.ok(!leadList.includes("toast.error('Failed to update lead status')"));
    assert.match(leadList, /\(err as any\)\?\.message \|\| 'Failed to update lead status'/);
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
