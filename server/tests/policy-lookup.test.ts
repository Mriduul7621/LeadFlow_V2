import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate037 } from '../database/migrations/037_lead_activities.js';
import { up as migrate039 } from '../database/migrations/039_scheduled_activities.js';
import {
  lookupPolicy,
  isTermPolicy,
  PolicyLookupError,
  _setPolicyLookupReaderForTest,
  _resetPolicyLookupForTest,
} from '../services/PolicyLookupService.js';
import {
  policyMatchToConvertedFields,
  isFaMismatch,
} from '../../src/modules/leads/utils/policyLookupFill.js';

/**
 * PR sync — conversion policy lookup (POST /api/leads/policy-lookup).
 * ------------------------------------------------------------------
 * The Sheets responses are mocked (no Google calls in tests). Fixtures
 * carry the REAL header names from the live sheets, but the columns are
 * deliberately in a DIFFERENT order than the sheet — the service must
 * match by header name, never by fixed index.
 *
 * Fixture facts (mirror the verified production facts):
 *   - Policy 3 has Proposal No Pro-4 (Proposal No is its OWN sequence).
 *   - PR NO 8 exists on TWO policies (8 and T100203) — never a key.
 *   - T-series (T100203) lives ONLY in the PR Database, never in Due.
 *   - Policy 999 has only Deferred rows — no New PR, no conversion.
 */
const JWT_SECRET = ['pl', 'ook', 'up', '-', 'test', '-', 'key', '-', '2026'].join('');

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

/* Due sheet fixture — headers on ROW 1, columns deliberately shuffled. */
const DUE_HEADERS = [
  'Proposal No', 'Sum Assured', 'Policy No', 'Pay Mode', 'Plan Name',
  'FA Code', 'Premium', 'Term', 'Comm. Date', 'Policy Status',
];
const DUE_ROWS: string[][] = [
  DUE_HEADERS,
  // Policy 3 / Pro-4 (the Pro-N != Policy No case); comma-formatted money.
  ['Pro-4', '1,000,000', '3', 'Yearly', 'S3PP', '2026030', '42,000', '20', '2026-01-15', 'Inforce'],
  // Policy 8 / Pro-9; DD-Mon-YYYY commencement date.
  ['Pro-9', '500000', '8', 'Half-Yearly', 'S4PP', '2024027', '30000', '15', '15-Jan-2026', 'Inforce'],
];

/* PR Database fixture — title rows 1-2, headers on ROW 3. */
const PR_HEADERS = [
  'POLICY NO', 'PR NO', 'PR DATE', 'POLICY OWMER', 'FA Code', 'PR TYPE',
  'TERM', 'PLAN', 'PAYMENT MODE', 'TOTAL PREM.', 'Product Name', 'New Premium',
];
const PR_ROWS: string[][] = [
  ['SLI Retail Sales Dashboard — PR Database'],
  [''],
  PR_HEADERS,
  // T100203 — T-series, shares PR NO 8 with policy 8.
  ['T100203', '8', '2025-10-05', 'Test Owner', '2026030', 'New', '1', 'Shanta Assurance', 'Half-Yearly', '68926', 'Shanta Assurance', '34463'],
  // Policy 8, New PR (same PR NO 8 — the duplicate guard).
  ['8', '8', '2024-09-10', 'Owner Eight', '2024027', 'New', '15', 'S4PP', 'Yearly', '30000', 'S4PP', '30000'],
  // Policy 8, Deferred PR — must never be picked as the conversion record.
  ['8', '9', '2025-03-10', 'Owner Eight', '2024027', 'Deferred', '15', 'S4PP', 'Yearly', '30000', 'S4PP', ''],
  // Policy 555 — empty Product Name + empty New Premium (fallbacks).
  ['555', '77', '2026-02-01', 'Owner Five', '2025019', 'New', '10', 'SDPP', 'Monthly', '12000', '', ''],
  // Policy 999 — Deferred only, no New PR row.
  ['999', '78', '2026-02-01', 'Owner Nine', '2025019', 'Deferred', '10', 'SDPP', 'Monthly', '12000', 'SDPP', ''],
];

function fixtureReader(range: string): Promise<string[][]> {
  if (range.includes('Due and Lapse')) return Promise.resolve(DUE_ROWS);
  if (range.includes('PR Database')) return Promise.resolve(PR_ROWS);
  throw new Error(`unexpected range ${range}`);
}

async function setupSchema(pool: any) {
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, idra_fa_code VARCHAR(30) UNIQUE, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, reason TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID, action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address INET, user_agent TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_types (key VARCHAR(100) PRIMARY KEY, label VARCHAR(255) NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
  // Production shape (migrations 014 + 035): current_status, NO bare
  // "status" column; assigned_to UUID REFERENCES users(id).
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID REFERENCES users(id), assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, follow_up_count INTEGER NOT NULL DEFAULT 0, current_status VARCHAR(255) DEFAULT 'New', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID REFERENCES users(id), updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, corporate_client_code VARCHAR(50), corporate_client_name VARCHAR(200), converted_at TIMESTAMP);`);
  await migrate037();
  await migrate039();
}

describe('PR sync — policy lookup', () => {
  let pool: any;
  let app: express.Express;
  let deptId: string;
  let agent: any;
  let noEdit: any;

  function tokenFor(user: any) {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function createLead(assignee: any, mobile: string) {
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 'Interested') RETURNING id, lead_code`,
      [`PL-${mobile}`, `Lead ${mobile}`, mobile, assignee.id],
    );
    return { id: res.rows[0].id, leadCode: res.rows[0].lead_code };
  }

  before(async () => {
    process.env.DATABASE_URL = ['postgres', '://', 'test', ':test', '@localhost', '/test'].join('');
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    const deptRes: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`,
    );
    deptId = deptRes.rows[0].id;

    const roleIds: Record<string, string> = {};
    for (const [code, name, level, vis] of [
      ['ADMIN', 'Admin', 100, 'Organization'],
      ['EMPLOYEE', 'Employee', 10, 'Own'],
      ['NOEDIT', 'No Edit', 10, 'Own'],
    ] as const) {
      const res: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis],
      );
      roleIds[code] = res.rows[0].id;
    }
    const permIds: Record<string, string> = {};
    for (const code of ['leads.view', 'leads.edit']) {
      const res: any = await pool.query(
        `INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`,
        [code, code],
      );
      permIds[code] = res.rows[0].id;
    }
    const grants: Record<string, string[]> = {
      ADMIN: ['leads.view', 'leads.edit'],
      EMPLOYEE: ['leads.view', 'leads.edit'],
      NOEDIT: ['leads.view'],
    };
    for (const [roleCode, codes] of Object.entries(grants)) {
      for (const code of codes) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
          [roleIds[roleCode], permIds[code]],
        );
      }
    }
    async function createUser(employeeId: string, roleCode: string) {
      const res: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, true) RETURNING id`,
        [employeeId, `User ${employeeId}`, `${employeeId.toLowerCase()}@test.com`, roleIds[roleCode], deptId],
      );
      return { id: res.rows[0].id, employeeId, email: `${employeeId.toLowerCase()}@test.com`, role: roleCode };
    }
    agent = await createUser('AGENT1', 'EMPLOYEE');
    noEdit = await createUser('NOEDIT1', 'NOEDIT');

    app = await createTestApp();
  });

  after(async () => {
    _resetPolicyLookupForTest();
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM audit_logs`);
    _resetPolicyLookupForTest();
  });

  /* ==================================================================
     Service: matching + mapping (mocked Sheets)
  ================================================================== */
  describe('service matching', () => {
    it('Due hit by Policy No maps every field (collected = Premium M)', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const m = await lookupPolicy('3');
      assert.ok(m);
      assert.equal(m.policyNo, '3');
      assert.equal(m.proposalNo, 'Pro-4');
      assert.equal(m.productName, 'S3PP');
      assert.equal(m.sumAssured, 1000000);
      assert.equal(m.collectedNCP, 42000);
      assert.equal(m.term, '20');
      assert.equal(m.payMode, 'Yearly');
      assert.equal(m.faCode, '2026030');
      assert.equal(m.commDate, '2026-01-15');
      assert.equal(m.source, 'due');
      assert.equal(m.isTermPolicy, false);
    });

    it('Due hit by Proposal No, case-insensitive; Pro-4 resolves to policy 3', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const m = await lookupPolicy('pro-4');
      assert.ok(m);
      assert.equal(m.policyNo, '3');
      assert.equal(m.proposalNo, 'Pro-4');
    });

    it('Proposal No is its own sequence: key "4" does not match Pro-4', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const m = await lookupPolicy('4');
      assert.equal(m, null);
    });

    it('Due miss falls back to the PR Database New PR row (T-series)', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const m = await lookupPolicy('T100203');
      assert.ok(m);
      assert.equal(m.policyNo, 'T100203');
      assert.equal(m.proposalNo, null);
      assert.equal(m.productName, 'Shanta Assurance');
      assert.equal(m.sumAssured, null);
      assert.equal(m.collectedNCP, 34463);
      assert.equal(m.term, '1');
      assert.equal(m.payMode, 'Half-Yearly');
      assert.equal(m.faCode, '2026030');
      assert.equal(m.commDate, '2025-10-05');
      assert.equal(m.source, 'pr-database');
      assert.equal(m.isTermPolicy, true);
    });

    it('PR-NO duplicate guard: shared PR NO 8 never cross-matches policies', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const t = await lookupPolicy('T100203');
      assert.ok(t);
      assert.equal(t.policyNo, 'T100203');
      assert.equal(t.productName, 'Shanta Assurance');
      // Policy 8 resolves via its own Due row, not via the shared PR NO.
      const eight = await lookupPolicy('8');
      assert.ok(eight);
      assert.equal(eight.policyNo, '8');
      assert.equal(eight.productName, 'S4PP');
      assert.equal(eight.source, 'due');
    });

    it('PR fallback: empty Product Name falls back to PLAN, empty New Premium to TOTAL PREM.', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const m = await lookupPolicy('555');
      assert.ok(m);
      assert.equal(m.productName, 'SDPP');
      assert.equal(m.collectedNCP, 12000);
      assert.equal(m.source, 'pr-database');
      assert.equal(m.sumAssured, null);
    });

    it('a policy with only Deferred rows has no conversion record', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      assert.equal(await lookupPolicy('999'), null);
    });

    it('both sheets miss -> null', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      assert.equal(await lookupPolicy('NOPE-1'), null);
    });

    it('cache: a second lookup re-reads neither sheet; a Due hit never reads PR', async () => {
      let dueReads = 0;
      let prReads = 0;
      _setPolicyLookupReaderForTest(async (range: string) => {
        if (range.includes('Due and Lapse')) { dueReads += 1; return DUE_ROWS; }
        prReads += 1;
        return PR_ROWS;
      });
      await lookupPolicy('3');
      assert.equal(dueReads, 1);
      assert.equal(prReads, 0, 'a Due hit must not read the PR Database');
      await lookupPolicy('3');
      assert.equal(dueReads, 1, 'second lookup served from cache');
      assert.equal(prReads, 0);
      await lookupPolicy('T100203');
      assert.equal(dueReads, 1, 'Due still cached');
      assert.equal(prReads, 1);
      await lookupPolicy('T100203');
      assert.equal(prReads, 1, 'PR still cached');
    });

    it('missing env -> 503 SYNC_NOT_CONFIGURED (manual conversion unaffected)', async () => {
      const savedEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const savedKey = process.env.GOOGLE_PRIVATE_KEY;
      const savedSheet = process.env.GOOGLE_SHEET_ID;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      delete process.env.GOOGLE_PRIVATE_KEY;
      delete process.env.GOOGLE_SHEET_ID;
      try {
        await assert.rejects(
          lookupPolicy('3'),
          (err: any) => err instanceof PolicyLookupError && err.status === 503 && err.code === 'SYNC_NOT_CONFIGURED',
        );
      } finally {
        if (savedEmail !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = savedEmail;
        if (savedKey !== undefined) process.env.GOOGLE_PRIVATE_KEY = savedKey;
        if (savedSheet !== undefined) process.env.GOOGLE_SHEET_ID = savedSheet;
      }
    });

    it('empty key -> 400 INVALID_KEY', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      await assert.rejects(
        lookupPolicy('   '),
        (err: any) => err instanceof PolicyLookupError && err.status === 400 && err.code === 'INVALID_KEY',
      );
    });

    it('isTermPolicy: T-prefixed number or Shanta Assurance plan', () => {
      assert.equal(isTermPolicy('T100203', 'Shanta Assurance'), true);
      assert.equal(isTermPolicy('t100203', ''), true);
      assert.equal(isTermPolicy('123', 'Shanta Assurance'), true);
      assert.equal(isTermPolicy('123', 'S3PP'), false);
      assert.equal(isTermPolicy('', ''), false);
    });
  });

  /* ==================================================================
     Client fill mapping (pure helper — the approved mapping, pinned)
  ================================================================== */
  describe('client fill mapping', () => {
    it('fills exactly the mapped fields from a Due match', () => {
      const filled = policyMatchToConvertedFields({
        policyNo: '3', proposalNo: 'Pro-4', productName: 'S3PP',
        sumAssured: 1000000, collectedNCP: 42000, term: '20',
        payMode: 'Yearly', faCode: '2026030', commDate: '2026-01-15',
        source: 'due', isTermPolicy: false,
      });
      assert.deepEqual(filled, {
        productName: 'S3PP',
        sumAssured: '1000000',
        collectedNCP: '42000',
        term: '20',
        payMode: 'Yearly',
        policyNo: '3',
        proposalNo: 'Pro-4',
      });
    });

    it('T-series: sum assured stays blank, never "0"; PR fallback has no proposal', () => {
      const filled = policyMatchToConvertedFields({
        policyNo: 'T100203', proposalNo: null, productName: 'Shanta Assurance',
        sumAssured: null, collectedNCP: 34463, term: '1',
        payMode: 'Half-Yearly', faCode: '2026030', commDate: '2025-10-05',
        source: 'pr-database', isTermPolicy: true,
      });
      assert.equal(filled.sumAssured, '');
      assert.notEqual(filled.sumAssured, '0');
      assert.equal(filled.proposalNo, '');
      assert.equal(filled.collectedNCP, '34463');
    });

    it('FA mismatch is a soft comparison, case/space tolerant, silent when unknown', () => {
      assert.equal(isFaMismatch('2026030', '2026030'), false);
      assert.equal(isFaMismatch(' 2026030 ', '2026030'), false);
      assert.equal(isFaMismatch('2026030', '2024027'), true);
      assert.equal(isFaMismatch(null, '2024027'), false);
      assert.equal(isFaMismatch('2026030', null), false);
      assert.equal(isFaMismatch('', ''), false);
    });
  });

  /* ==================================================================
     Endpoint: POST /api/leads/policy-lookup
  ================================================================== */
  describe('endpoint', () => {
    it('401 without a token; 403 without leads.edit', async () => {
      const anon = await request(app).post('/api/leads/policy-lookup').send({ key: '3' });
      assert.equal(anon.status, 401);

      const denied = await request(app)
        .post('/api/leads/policy-lookup')
        .set('Authorization', `Bearer ${tokenFor(noEdit)}`)
        .send({ key: '3' });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.permission, 'leads.edit');
    });

    it('400 on an empty key', async () => {
      const res = await request(app)
        .post('/api/leads/policy-lookup')
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ key: '   ' });
      assert.equal(res.status, 400);
    });

    it('404 POLICY_NOT_FOUND when neither sheet has the policy', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const res = await request(app)
        .post('/api/leads/policy-lookup')
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ key: 'NOPE-1' });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'POLICY_NOT_FOUND');
      assert.match(res.body.message, /manually/);
    });

    it('200 returns ONLY the matched policy (never the sheet)', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const res = await request(app)
        .post('/api/leads/policy-lookup')
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ key: 'pro-4' });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const d = res.body.data;
      assert.equal(d.policyNo, '3');
      assert.equal(d.proposalNo, 'Pro-4');
      assert.equal(d.productName, 'S3PP');
      assert.equal(d.sumAssured, 1000000);
      assert.equal(d.collectedNCP, 42000);
      assert.equal(d.term, '20');
      assert.equal(d.payMode, 'Yearly');
      assert.equal(d.faCode, '2026030');
      assert.equal(d.source, 'due');
      assert.equal(d.isTermPolicy, false);
      assert.equal(JSON.stringify(res.body).includes('S4PP'), false, 'no other policy leaks into the response');
      assert.equal(JSON.stringify(res.body).includes('T100203'), false);
    });

    it('200 via the PR fallback for a T-series policy', async () => {
      _setPolicyLookupReaderForTest(fixtureReader);
      const res = await request(app)
        .post('/api/leads/policy-lookup')
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ key: 'T100203' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.source, 'pr-database');
      assert.equal(res.body.data.isTermPolicy, true);
      assert.equal(res.body.data.sumAssured, null);
      assert.equal(res.body.data.collectedNCP, 34463);
    });

    it('503 when Sheets is unconfigured', async () => {
      const savedEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const savedKey = process.env.GOOGLE_PRIVATE_KEY;
      const savedSheet = process.env.GOOGLE_SHEET_ID;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      delete process.env.GOOGLE_PRIVATE_KEY;
      delete process.env.GOOGLE_SHEET_ID;
      try {
        const res = await request(app)
          .post('/api/leads/policy-lookup')
          .set('Authorization', `Bearer ${tokenFor(agent)}`)
          .send({ key: '3' });
        assert.equal(res.status, 503);
        assert.equal(res.body.error, 'SYNC_NOT_CONFIGURED');
      } finally {
        if (savedEmail !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = savedEmail;
        if (savedKey !== undefined) process.env.GOOGLE_PRIVATE_KEY = savedKey;
        if (savedSheet !== undefined) process.env.GOOGLE_SHEET_ID = savedSheet;
      }
    });
  });

  /* ==================================================================
     Follow-up: T-series exemption + policy reference storage
  ================================================================== */
  describe('follow-up T-series exemption', () => {
    it('Converted with a matched T-series policy saves without sumAssured and stores the reference', async () => {
      const lead = await createLead(agent, '01710000001');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({
          status: 'Converted',
          productName: 'Shanta Assurance',
          collectedNCP: 34463,
          policyNo: 'T100203',
          proposalNo: 'Pro-99',
          policyTerm: '1',
          payMode: 'Half-Yearly',
        });
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
      const saved = res.body.data.lead;
      assert.equal(saved.currentStatus, 'Converted');
      assert.equal(saved.policyNo, 'T100203');
      assert.equal(saved.proposalNo, 'Pro-99');
      assert.equal(saved.policyTerm, '1');
      assert.equal(saved.payMode, 'Half-Yearly');
      const lastHistory = saved.statusHistory[saved.statusHistory.length - 1];
      assert.equal(lastHistory.policyNo, 'T100203');
      assert.equal(lastHistory.proposalNo, 'Pro-99');
    });

    it('manual Converted without a matched policy still requires sumAssured', async () => {
      const lead = await createLead(agent, '01710000002');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ status: 'Converted', productName: 'S3PP', collectedNCP: 42000 });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Sum Assured/);
    });

    it('a conventional matched policy does NOT exempt sumAssured', async () => {
      const lead = await createLead(agent, '01710000003');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({
          status: 'Converted',
          productName: 'S3PP',
          collectedNCP: 42000,
          policyNo: '3',
          proposalNo: 'Pro-4',
        });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Sum Assured/);
    });

    it('T-series exemption drops ONLY sumAssured — productName is still required', async () => {
      const lead = await createLead(agent, '01710000004');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({ status: 'Converted', collectedNCP: 34463, policyNo: 'T100203' });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Product/);
    });

    it('T-series with sumAssured supplied still saves (normal path unaffected)', async () => {
      const lead = await createLead(agent, '01710000005');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({
          status: 'Converted',
          productName: 'Shanta Assurance',
          sumAssured: 100000,
          collectedNCP: 34463,
          policyNo: 'T100203',
        });
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
    });

    it('a conventional Converted save with all fields still works and stores the reference', async () => {
      const lead = await createLead(agent, '01710000006');
      const res = await request(app)
        .post(`/api/leads/${encodeURIComponent(lead.leadCode)}/follow-up`)
        .set('Authorization', `Bearer ${tokenFor(agent)}`)
        .send({
          status: 'Converted',
          productName: 'S3PP',
          sumAssured: 1000000,
          collectedNCP: 42000,
          policyNo: '3',
          proposalNo: 'Pro-4',
          policyTerm: '20',
          payMode: 'Yearly',
        });
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
      assert.equal(res.body.data.lead.policyNo, '3');
      assert.equal(res.body.data.lead.proposalNo, 'Pro-4');
      assert.equal(res.body.data.lead.policyTerm, '20');
      assert.equal(res.body.data.lead.payMode, 'Yearly');
    });
  });
});
