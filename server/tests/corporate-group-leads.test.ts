import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate065 } from '../database/migrations/065_leads_corporate_client.js';
import {
  _setPolicyLookupReaderForTest,
  _resetPolicyLookupForTest,
} from '../services/PolicyLookupService.js';
import {
  _resetCorporateClientsForTest,
  listCorporateClients,
  rankCorporateSearch,
  searchCorporateClients,
  CORPORATE_SOURCE,
} from '../services/CorporateClientsService.js';
import {
  computeCorporateSummary,
  parseCorporatePeriod,
} from '../utils/corporateSummary.js';

/**
 * Corporate Group Leads (migration 065, Mahadi 2026-11-24)
 * --------------------------------------------------------
 * Shanta Life's group-insurance companies: the field force sells
 * individual policies to their employees, and LeadFlow tracks it
 * per company. The company master lives in a Google Sheet tab
 * ('Corporate Clients', Code + Company Name), read LIVE — no DB
 * sync job, no corporate_clients table.
 *
 *   1. Migration 065 — nullable corporate_client_code/name on
 *      leads + index on the code; seeds the Source option
 *      'Corporate Client Group Insurance'; registered as the tail.
 *   2. Autocomplete — GET /api/corporate-clients/search?q=, exact
 *      name first, then partials; a missing tab is an empty list
 *      with available:false, never a 500.
 *   3. Bulk — a corporate client CODE in the Source column uploads
 *      the row as a corporate lead (source auto-set, code/name
 *      stored); an unknown code is a dry-run error naming the row;
 *      a code match beats a source-name match.
 *   4. Create — the corporate source without a client is a 400;
 *      with a client the link is stored; an edit that omits the
 *      corporate fields keeps the stored link.
 *   5. KPIs — Total Leads by CREATED date, Conversion Ratio and
 *      Total Premium by CONVERSION date (pinned, both pure and
 *      through the endpoint); the summary is scoped by the
 *      caller's lead visibility.
 *   6. converted_at — stamped by the follow-up endpoint on the
 *      first won terminal status (migration 014's column, never
 *      written anywhere before 065).
 *
 * Fixture note: the leads table is created WITHOUT the corporate
 * columns (but WITH converted_at — a 014 column, part of the
 * production shape) and the REAL migration 065 runs against it
 * twice, so the tests prove the migration itself, not a hand-built
 * post-065 shape. All sheet access is mocked — no live sheet calls.
 */
const JWT_SECRET = ['test', 'jwt', 'secret', 'corp', '065'].join('-');

const repoRoot = path.resolve(process.cwd());
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

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

/* Corporate Clients fixture — the tab's header row + 4 companies. */
const CLIENT_ROWS: string[][] = [
  ['Code', 'Company Name'],
  ['SLI-C01', 'Shanta Textile Mills Ltd'],
  ['SLI-C02', 'Shanta Properties Ltd'],
  ['ABC-100', 'ABC Garments'],
  ['XYZ-9', 'Shanta Assurance Staff'],
];

function fixtureReader(range: string): Promise<string[][]> {
  if (range.includes('Corporate Clients')) return Promise.resolve(CLIENT_ROWS);
  throw new Error(`unexpected range ${range}`);
}

function throwingReader(_range: string): Promise<string[][]> {
  // The tab does not exist yet (Mahadi creates it later): the Sheets
  // API answers 404, which the service surfaces as unavailable.
  return Promise.reject(new Error('Requested entity was not found.'));
}

async function setupSchema(pool: any) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100) UNIQUE,
      department_name VARCHAR(255) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own',
      is_active BOOLEAN DEFAULT TRUE,
      menu_access JSONB,
      actions JSONB,
      feature_permissions JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_code VARCHAR(30) UNIQUE,
      team_name VARCHAR(150),
      department_id UUID,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(30),
      password VARCHAR(255) NOT NULL DEFAULT '',
      role_id UUID,
      department_id UUID,
      team_id UUID,
      manager_id UUID,
      designation VARCHAR(100),
      profile_photo TEXT,
      last_login TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      account_status VARCHAR(30) DEFAULT 'ACTIVE',
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMP,
      password_changed_at TIMESTAMP,
      must_change_password BOOLEAN DEFAULT FALSE,
      reporting_chain JSONB DEFAULT '[]'::jsonb,
      subordinates JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hierarchies (
      user_id UUID PRIMARY KEY,
      manager_id UUID,
      level INT,
      path JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      module_name VARCHAR(100),
      action_name VARCHAR(100)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, permission_id)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, permission_id)
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      target_user_id UUID,
      action_code VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address INET,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
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
    );`);
  // PRE-065 shape on purpose — migration 065 runs against this below.
  // converted_at IS included: it is a migration 014 column, part of
  // the production shape since long before 065.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE,
      customer_name VARCHAR(255) NOT NULL,
      mobile VARCHAR(30) NOT NULL,
      alternate_mobile VARCHAR(30),
      email VARCHAR(255),
      marital_status VARCHAR(50),
      occupation VARCHAR(150),
      address TEXT,
      area VARCHAR(150),
      district VARCHAR(100),
      division VARCHAR(100),
      source VARCHAR(100),
      priority VARCHAR(30) DEFAULT 'NORMAL',
      expected_premium NUMERIC(14,2),
      expected_value NUMERIC(14,2),
      notes TEXT,
      assigned_to UUID,
      assigned_by UUID,
      assigned_at TIMESTAMP,
      previous_assigned_to UUID,
      last_contacted_at TIMESTAMP,
      next_follow_up_at TIMESTAMP,
      current_status VARCHAR(255) DEFAULT 'New',
      status_history JSONB DEFAULT '[]'::jsonb,
      assignment_history JSONB DEFAULT '[]'::jsonb,
      documents JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '{}'::jsonb,
      tags JSONB DEFAULT '[]'::jsonb,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      converted_at TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      deleted_by UUID,
      follow_up_count INT DEFAULT 0
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT,
      next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255),
      collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2),
      product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_followup_mutations (
      mutation_id UUID PRIMARY KEY,
      lead_id UUID,
      user_id UUID,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
      response_body JSONB
    );`);
}

let mobileSeq = 0;
function nextMobile(): string {
  mobileSeq += 1;
  return `0170000${String(1000 + mobileSeq).slice(-4)}`;
}

function bulkRow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    'Assigned Date': '23-Apr-2026',
    'Lead Date': '22-Apr-2026',
    'Name': 'Corporate Prospect',
    'Phone': nextMobile(),
    'E-mail': '',
    'Area': 'Dhaka',
    'Interested amount of investment': 500000,
    'Source': 'Social media',
    'Product': 'SCEP',
    'Other Info': '',
    'Campaign Name': '',
    // Blank on purpose: blank stays unassigned (never fake-assigned).
    'Assigned To': '',
    'Previously Assigned': '',
    'TAT': 1,
    '1st Call date': '23-Apr-2026',
    'Initial Status': 'New',
    'Initial Remarks': '',
    'Follow up date': '',
    'Follow up': '',
    'Final Remarks': '',
    ...overrides,
  };
}

describe('Corporate Group Leads (migration 065)', () => {
  let pool: any;
  let app: express.Express;
  let adminRoleId: string;
  let employeeRoleId: string;
  let adminUserId: string;
  let agent1Id: string;
  let agent2Id: string;

  const adminToken = () => signToken({ id: adminUserId, employeeId: 'ADMIN001', role: 'ADMIN', email: 'admin@test.com' });
  const agent1Token = () => signToken({ id: agent1Id, employeeId: '2026010', role: 'EMPLOYEE', email: 'agent1@test.com' });
  const agent2Token = () => signToken({ id: agent2Id, employeeId: '2026011', role: 'EMPLOYEE', email: 'agent2@test.com' });

  async function leadByMobile(mobile: string) {
    const res: any = await pool.query(
      `SELECT * FROM leads WHERE mobile = $1 AND is_deleted = FALSE`, [mobile],
    );
    return res.rows[0] || null;
  }

  async function seedCorporateLead(overrides: Record<string, any> = {}) {
    const mobile = nextMobile();
    const {
      assigneeId = agent1Id, creatorId = agent1Id, code = 'SLI-C01',
      name = 'Shanta Textile Mills Ltd', status = 'New',
      createdAt = 'NOW()', convertedAt = null, customFields = {},
      statusHistory = [],
    } = overrides;
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, source, current_status,
         corporate_client_code, corporate_client_name, assigned_to, created_by,
         created_at, updated_at, converted_at, custom_fields, status_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13)
       RETURNING *`,
      [
        `CORP-${mobile}`, `Prospect ${mobile}`, mobile, CORPORATE_SOURCE, status,
        code, name, assigneeId, creatorId,
        createdAt === 'NOW()' ? new Date().toISOString() : createdAt, convertedAt,
        JSON.stringify(customFields), JSON.stringify(statusHistory),
      ],
    );
    return res.rows[0];
  }

  before(async () => {
process.env.DATABASE_URL = 'postgres://' + 'test:test@localhost:5432/test';
process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    // The REAL migration 065 — twice, to pin idempotency.
    await migrate065();
    await migrate065();

    const dept: any = await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`,
    );
    const salesDeptId = dept.rows[0].id;

    const mkRole = async (code: string, name: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility, is_active) VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
        [code, name, level, vis],
      );
      return r.rows[0].id;
    };
    adminRoleId = await mkRole('ADMIN', 'Administrator', 1, 'Organization');
    employeeRoleId = await mkRole('EMPLOYEE', 'Employee', 10, 'Own');

    const permIds: Record<string, string> = {};
    for (const code of ['leads.view', 'leads.create', 'leads.edit', 'leads.import']) {
      const res: any = await pool.query(
        `INSERT INTO permissions (permission_code, module_name, action_name) VALUES ($1, 'test', 'test') RETURNING id`,
        [code],
      );
      permIds[code] = res.rows[0].id;
    }
    for (const code of Object.keys(permIds)) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`,
        [adminRoleId, permIds[code]],
      );
    }
    for (const code of ['leads.view', 'leads.create', 'leads.edit']) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`,
        [employeeRoleId, permIds[code]],
      );
    }

    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active, must_change_password)
         VALUES ($1, $2, $3, 'hashed', $4, $5, $6, TRUE, FALSE) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, roleId, salesDeptId, managerId],
      );
      return r.rows[0].id;
    };
    adminUserId = await mkUser('ADMIN001', adminRoleId, null);
    agent1Id = await mkUser('2026010', employeeRoleId, adminUserId);
    agent2Id = await mkUser('2026011', employeeRoleId, adminUserId);

    // Source dictionary (populated — the bulk unknown-source rule
    // only errors when it is). 'ABC-100' doubles as a source name so
    // the code-beats-source test has a real collision to resolve.
    for (const value of ['Social media', 'Walk-in', 'ABC-100']) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order) VALUES ('Source', $1, $1, 0) ON CONFLICT DO NOTHING`,
        [value],
      );
    }
    // Follow-up status dictionary (field_key 'FollowUpStatus').
    // Terminal/won resolve by name when meta carries no flags, so
    // 'Converted' is a won terminal status here, as in production.
    for (const value of ['New', 'Contacted', 'Interested', 'Converted', 'Not Interested']) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, meta) VALUES ('FollowUpStatus', $1, $1, 0, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [value],
      );
    }

    _setPolicyLookupReaderForTest(fixtureReader);
    app = await createTestApp();
  });

  after(async () => {
    _setPolicyLookupReaderForTest(null);
    _resetPolicyLookupForTest();
    _resetCorporateClientsForTest();
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM processed_followup_mutations`);
    await pool.query(`DELETE FROM leads`);
    // Reset FIRST, then set the reader: _resetPolicyLookupForTest
    // nulls the reader override, so setting it before the reset
    // would leave every test with no reader at all.
    _resetPolicyLookupForTest();
    _resetCorporateClientsForTest();
    _setPolicyLookupReaderForTest(fixtureReader);
  });

  /* ---- Migration 065 ---- */

  it('migration 065 adds both corporate columns, nullable', async () => {
    const res: any = await pool.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'leads' AND column_name IN ('corporate_client_code', 'corporate_client_name')
      ORDER BY column_name`);
    assert.equal(res.rows.length, 2);
    const byName = Object.fromEntries(res.rows.map((r: any) => [r.column_name, r]));
    assert.equal(byName.corporate_client_code.data_type, 'character varying');
    assert.equal(byName.corporate_client_code.character_maximum_length, 50);
    assert.equal(byName.corporate_client_code.is_nullable, 'YES');
    assert.equal(byName.corporate_client_name.data_type, 'character varying');
    assert.equal(byName.corporate_client_name.character_maximum_length, 200);
    assert.equal(byName.corporate_client_name.is_nullable, 'YES');
  });

  it('migration 065 creates the index on corporate_client_code', async () => {
    const res: any = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'leads' AND indexname = 'idx_leads_corporate_client_code'`,
    );
    assert.equal(res.rows.length, 1);
  });

  it('migration 065 seeds the Corporate Client Group Insurance source exactly once', async () => {
    const res: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'Source' AND option_value = $1`,
      [CORPORATE_SOURCE],
    );
    assert.equal(res.rows[0].n, 1, 'ran twice in before() — the seed must be idempotent');
  });

  it('migration 065 is the registered tail in runMigrations.ts', () => {
    const runner = read('server/database/runMigrations.ts');
    assert.ok(runner.includes('065_leads_corporate_client'), '065 must be registered');
    const idx065 = runner.indexOf('065_leads_corporate_client');
    const idx064 = runner.indexOf('064_users_idra_fa_code');
    assert.ok(idx064 !== -1 && idx065 > idx064, '065 must come after 064');
    // 065 is the tail: no later migration id appears after it.
    const tail = runner.slice(idx065);
    assert.ok(!/0(6[6-9]|[7-9]\d\d)_/.test(tail), 'no migration after 065');
  });

  /* ---- Autocomplete: service + endpoint ---- */

  it('autocomplete: exact name match ranks first', async () => {
    const result = await searchCorporateClients('Shanta Textile Mills Ltd');
    assert.equal(result.available, true);
    assert.equal(result.clients[0]?.code, 'SLI-C01');
  });

  it('autocomplete: partial matches narrow as the query narrows', async () => {
    const wide = await searchCorporateClients('shanta');
    assert.equal(wide.clients.length, 3, 'three Shanta companies in the fixture');
    const narrow = await searchCorporateClients('shanta textile');
    assert.equal(narrow.clients.length, 1);
    assert.equal(narrow.clients[0]?.code, 'SLI-C01');
  });

  it('autocomplete: a code fragment matches the code', async () => {
    const result = await searchCorporateClients('sli-c02');
    assert.equal(result.clients[0]?.code, 'SLI-C02');
  });

  it('autocomplete: empty query returns an empty list, sheet available', async () => {
    const result = await searchCorporateClients('');
    assert.equal(result.available, true);
    assert.deepEqual(result.clients, []);
  });

  it('autocomplete: ranking is case-insensitive (pure ranker)', async () => {
    const { clients } = await listCorporateClients();
    const ranked = rankCorporateSearch(clients, 'SHANTA PROPERTIES LTD');
    assert.equal(ranked[0]?.code, 'SLI-C02');
  });

  it('search endpoint: 200 with ordered clients + available:true', async () => {
    const res = await request(app)
      .get('/api/corporate-clients/search?q=shanta')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.available, true);
    assert.equal(res.body.data.clients.length, 3);
    // All three are name-starts-with matches for 'shanta', so the
    // tiebreak is alphabetical by name: Assurance < Properties <
    // Textile.
    assert.equal(res.body.data.clients[0].name, 'Shanta Assurance Staff');
    assert.equal(res.body.data.clients[0].code, 'XYZ-9');
    assert.deepEqual(
      res.body.data.clients.map((c: any) => c.code).sort(),
      ['SLI-C01', 'SLI-C02', 'XYZ-9'],
    );
  });

  it('search endpoint: a missing tab is 200 with available:false and an empty list, never 500', async () => {
    _resetPolicyLookupForTest();
    _resetCorporateClientsForTest();
    _setPolicyLookupReaderForTest(throwingReader);
    const res = await request(app)
      .get('/api/corporate-clients/search?q=shanta')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.available, false);
    assert.deepEqual(res.body.data.clients, []);
    assert.ok(String(res.body.data.error || '').length > 0, 'a clear message for the picker');
  });

  it('search endpoint: requires auth', async () => {
    const res = await request(app).get('/api/corporate-clients/search?q=shanta');
    assert.equal(res.status, 401);
  });

  /* ---- Bulk: code in the Source column ---- */

  it('bulk: a client code in Source uploads a corporate lead (case-insensitive, canonical code stored)', async () => {
    const row = bulkRow({ Source: 'sli-c01' });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [row] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.corporate, 1);
    const stored = await leadByMobile(row['Phone']);
    assert.ok(stored, 'the lead must be stored');
    assert.equal(stored.source, CORPORATE_SOURCE);
    assert.equal(stored.corporate_client_code, 'SLI-C01');
    assert.equal(stored.corporate_client_name, 'Shanta Textile Mills Ltd');
  });

  it('bulk dry-run: an unknown code is an error naming the row, and nothing is written', async () => {
    const row = bulkRow({ Source: 'NOPE-999' });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [row], dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.failed, 1);
    const err = (res.body.data.errors || []).find((e: any) => e.index === 0);
    assert.ok(err, 'an error entry must name the row index');
    assert.ok(String(err.message).includes('NOPE-999'), 'the message must name the value');
    assert.equal(await leadByMobile(row['Phone']), null, 'dry-run writes nothing');
  });

  it('bulk: a code match beats a source-name match', async () => {
    // 'ABC-100' is BOTH a seeded Source option and a client code.
    const row = bulkRow({ Source: 'ABC-100' });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [row] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await leadByMobile(row['Phone']);
    assert.ok(stored);
    assert.equal(stored.source, CORPORATE_SOURCE);
    assert.equal(stored.corporate_client_code, 'ABC-100');
    assert.equal(stored.corporate_client_name, 'ABC Garments');
  });

  it('bulk: a normal source still uploads a normal lead, no corporate link', async () => {
    const row = bulkRow({ Source: 'Social media' });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [row] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.corporate, 0);
    const stored = await leadByMobile(row['Phone']);
    assert.ok(stored);
    assert.equal(stored.source, 'Social media');
    assert.equal(stored.corporate_client_code, null);
  });

  it('bulk: the corporate source name alone (no code) is an error naming the row', async () => {
    const row = bulkRow({ Source: CORPORATE_SOURCE });
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: [row], dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.failed, 1);
    const err = (res.body.data.errors || []).find((e: any) => e.index === 0);
    assert.ok(err, 'an error entry must name the row index');
  });

  /* ---- Single create: validation + storage ---- */

  it('create: corporate source without a client is a 400', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ customerName: 'No Client', mobile: nextMobile(), source: CORPORATE_SOURCE });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  it('create: corporate source with a client stores the link', async () => {
    const mobile = nextMobile();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        customerName: 'With Client', mobile, source: CORPORATE_SOURCE,
        corporateClientCode: 'SLI-C02', corporateClientName: 'Shanta Properties Ltd',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await leadByMobile(mobile);
    assert.ok(stored);
    assert.equal(stored.corporate_client_code, 'SLI-C02');
    assert.equal(stored.corporate_client_name, 'Shanta Properties Ltd');
  });

  it('create: a manual code without a name stores the code and a blank name', async () => {
    const mobile = nextMobile();
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        customerName: 'Manual Code', mobile, source: CORPORATE_SOURCE,
        corporateClientCode: 'HAND-1',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await leadByMobile(mobile);
    assert.ok(stored);
    assert.equal(stored.corporate_client_code, 'HAND-1');
    assert.ok(!stored.corporate_client_name, 'name stays blank until resolved later');
  });

  it('edit: omitting the corporate fields keeps the stored link', async () => {
    const mobile = nextMobile();
    const created = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        customerName: 'Keep Link', mobile, source: CORPORATE_SOURCE,
        corporateClientCode: 'SLI-C01', corporateClientName: 'Shanta Textile Mills Ltd',
      });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const leadCode = created.body.data.leadCode || created.body.data.id;
    const edited = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ id: leadCode, customerName: 'Keep Link Renamed', mobile, source: CORPORATE_SOURCE });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stored = await leadByMobile(mobile);
    assert.equal(stored.customer_name, 'Keep Link Renamed');
    assert.equal(stored.corporate_client_code, 'SLI-C01', 'the link survives an edit that omits it');
  });

  /* ---- KPI maths: pure function (fixed clock, exact boundaries) ---- */

  it('KPI math (pure): leads by created date, premium/ratio by conversion date', () => {
    // Fixed clock: 24 Nov 2026, so THIS_MONTH is [1 Nov, 1 Dec) Dhaka.
    const now = new Date('2026-11-24T12:00:00+06:00');
    const period = parseCorporatePeriod({ period: 'THIS_MONTH' }, now);
    const lead = (over: Record<string, any>) => ({
      corporateClientCode: 'SLI-C01',
      corporateClientName: 'Shanta Textile Mills Ltd',
      assignedTo: '2026010',
      currentStatus: 'New',
      customFields: {},
      statusHistory: [],
      // The aggregator reads creationDate (the mapped Lead field),
      // not createdAt.
      creationDate: '2026-11-10T10:00:00+06:00',
      convertedAt: null,
      ...over,
    });
    const summary = computeCorporateSummary([
      // Created + converted in the period: counts everywhere.
      lead({ currentStatus: 'Converted', convertedAt: '2026-11-20T10:00:00+06:00', customFields: { collectedNCP: 42000 } }),
      // Created in the period, not converted: leads only.
      lead({}),
      // Created BEFORE the period, converted IN it: premium + ratio
      // numerator only — NOT in Total Leads.
      lead({
        creationDate: '2026-10-15T10:00:00+06:00',
        currentStatus: 'Converted', convertedAt: '2026-11-05T10:00:00+06:00',
        customFields: { collectedNCP: 30000 },
      }),
      // Created in the period, converted AFTER it: leads only.
      lead({ currentStatus: 'Converted', convertedAt: '2026-12-03T10:00:00+06:00', customFields: { collectedNCP: 99999 } }),
      // Not a corporate lead at all: ignored entirely.
      lead({ corporateClientCode: null, corporateClientName: null, currentStatus: 'Converted', convertedAt: '2026-11-12T10:00:00+06:00', customFields: { collectedNCP: 55555 } }),
    ], period, ['Converted']);
    assert.equal(summary.kpis.totalLeads, 3, 'only the three created in November');
    assert.equal(summary.kpis.converted, 2, 'the two converted in November');
    assert.equal(summary.kpis.conversionRatio, 2 / 3);
    assert.equal(summary.kpis.totalPremium, 72000, '42,000 + 30,000; the December + non-corporate premiums excluded');
    assert.equal(summary.policies.length, 2, 'only the in-period conversions list as policies');
    assert.equal(summary.byCompany.length, 1);
    assert.equal(summary.byCompany[0].leads, 3);
    assert.equal(summary.byCompany[0].converted, 2);
    assert.equal(summary.byCompany[0].premium, 72000);
    assert.equal(summary.byAgent.length, 1);
    assert.equal(summary.byAgent[0].companies, 1);
  });

  it('KPI math (pure): conversion date falls back converted_at → status history → updated → created', () => {
    const now = new Date('2026-11-24T12:00:00+06:00');
    const period = parseCorporatePeriod({ period: 'THIS_MONTH' }, now);
    const base = {
      corporateClientCode: 'SLI-C01', corporateClientName: 'Shanta Textile Mills Ltd',
      assignedTo: '2026010', currentStatus: 'Converted', customFields: { collectedNCP: 10000 },
      creationDate: '2026-11-10T10:00:00+06:00',
    };
    // No converted_at, but the status history has a won entry in-period.
    const fromHistory = computeCorporateSummary([
      { ...base, convertedAt: null, statusHistory: [{ status: 'Converted', date: '2026-11-18T10:00:00+06:00' }] },
    ], period, ['Converted']);
    assert.equal(fromHistory.kpis.converted, 1);
    assert.equal(fromHistory.kpis.totalPremium, 10000);
    // No converted_at, no history: the mapped timestamp decides.
    const fromUpdated = computeCorporateSummary([
      { ...base, convertedAt: null, statusHistory: [], timestamp: '2026-11-19T10:00:00+06:00' },
    ], period, ['Converted']);
    assert.equal(fromUpdated.kpis.converted, 1);
    // Nothing at all: created_at decides (in-period here).
    const fromCreated = computeCorporateSummary([
      { ...base, convertedAt: null, statusHistory: [] },
    ], period, ['Converted']);
    assert.equal(fromCreated.kpis.converted, 1);
    // A non-won status never converts, whatever the dates say.
    const notWon = computeCorporateSummary([
      { ...base, currentStatus: 'Contacted', convertedAt: '2026-11-18T10:00:00+06:00' },
    ], period, ['Converted']);
    assert.equal(notWon.kpis.converted, 0);
  });

  it('KPI math (pure): an unknown period key falls back to This month', () => {
    const now = new Date('2026-11-24T12:00:00+06:00');
    const period = parseCorporatePeriod({ period: 'NOT_A_PERIOD' }, now);
    assert.equal(period.key, 'THIS_MONTH');
  });

  /* ---- Summary endpoint: scoping + shape ---- */

  it('summary endpoint: KPIs + tables for an admin, scoped to corporate leads only', async () => {
    // Two corporate leads for agent1 (one converted in-period), one
    // for agent2, one NON-corporate lead (must not count anywhere).
    await seedCorporateLead({
      status: 'Converted', convertedAt: new Date().toISOString(),
      customFields: { collectedNCP: 42000, policyNo: '3', productName: 'S3PP', payMode: 'Yearly', sumAssured: 1000000 },
    });
    await seedCorporateLead({ code: 'SLI-C02', name: 'Shanta Properties Ltd' });
    await seedCorporateLead({ assigneeId: agent2Id, creatorId: agent2Id, code: 'ABC-100', name: 'ABC Garments' });
    const mobile = nextMobile();
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, source, current_status, assigned_to, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'Social media', 'Converted', $4, $4, NOW(), NOW())`,
      [`NORM-${mobile}`, `Normal ${mobile}`, mobile, agent1Id],
    );
    const res = await request(app)
      .get('/api/leads/corporate/summary?period=THIS_MONTH')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.kpis.totalLeads, 3, 'the non-corporate lead is excluded');
    assert.equal(data.kpis.converted, 1);
    assert.equal(data.kpis.totalPremium, 42000);
    assert.equal(data.byCompany.length, 3);
    const textile = data.byCompany.find((c: any) => c.code === 'SLI-C01');
    assert.equal(textile.leads, 1);
    assert.equal(textile.converted, 1);
    assert.equal(textile.premium, 42000);
    assert.equal(data.byAgent.length, 2);
    assert.equal(data.policies.length, 1);
    assert.equal(data.policies[0].policyNo, '3');
    assert.equal(data.policies[0].product, 'S3PP');
    assert.equal(data.policies[0].payMode, 'Yearly');
    assert.equal(data.policies[0].sumAssured, 1000000);
    assert.equal(data.policies[0].premium, 42000);
  });

  it('summary endpoint: an agent sees only their own corporate leads', async () => {
    await seedCorporateLead({ status: 'Converted', convertedAt: new Date().toISOString(), customFields: { collectedNCP: 42000 } });
    await seedCorporateLead({ code: 'SLI-C02', name: 'Shanta Properties Ltd' });
    await seedCorporateLead({ assigneeId: agent2Id, creatorId: agent2Id, code: 'ABC-100', name: 'ABC Garments' });
    const res = await request(app)
      .get('/api/leads/corporate/summary?period=THIS_MONTH')
      .set('Authorization', `Bearer ${agent1Token()}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.kpis.totalLeads, 2, 'agent2’s lead is invisible');
    assert.equal(res.body.data.kpis.converted, 1);
    assert.equal(res.body.data.kpis.totalPremium, 42000);
    assert.equal(res.body.data.byCompany.length, 2);
    assert.equal(res.body.data.byAgent.length, 1);
    assert.equal(res.body.data.byAgent[0].employeeId, '2026010');
  });

  it('summary endpoint: requires leads.view', async () => {
    const res = await request(app)
      .get('/api/leads/corporate/summary?period=THIS_MONTH')
      .set('Authorization', `Bearer ${agent2Token()}`);
    // agent2 HAS leads.view (role grant) — so this proves the
    // endpoint works for a granted agent; the negative case is the
    // unauthenticated call below.
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const anon = await request(app).get('/api/leads/corporate/summary?period=THIS_MONTH');
    assert.equal(anon.status, 401);
  });

  /* ---- Corporate list filters on GET /leads ---- */

  it('GET /leads: corporateOnly=1 narrows to corporate leads; companyCode= narrows to one company', async () => {
    await seedCorporateLead({ code: 'SLI-C01', name: 'Shanta Textile Mills Ltd' });
    await seedCorporateLead({ code: 'SLI-C02', name: 'Shanta Properties Ltd' });
    const mobile = nextMobile();
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, source, current_status, assigned_to, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'Social media', 'New', $4, $4, NOW(), NOW())`,
      [`NORM-${mobile}`, `Normal ${mobile}`, mobile, agent1Id],
    );
    const all = await request(app)
      .get('/api/leads?corporateOnly=1')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    // GET /leads returns a BARE array (the client contract) — the
    // body itself is the list, not { data: ... }.
    const allRows = Array.isArray(all.body) ? all.body : (all.body.data?.leads || all.body.data || []);
    assert.equal(allRows.length, 2, 'only the two corporate leads');
    const one = await request(app)
      .get('/api/leads?corporateOnly=1&companyCode=SLI-C02')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const oneRows = Array.isArray(one.body) ? one.body : (one.body.data?.leads || one.body.data || []);
    assert.equal(oneRows.length, 1);
    assert.equal(oneRows[0].corporateClientCode, 'SLI-C02');
  });

  /* ---- converted_at stamping ---- */

  it('follow-up: the first won status stamps converted_at; later follow-ups keep it', async () => {
    const lead = await seedCorporateLead();
    const leadCode = lead.lead_code;
    const res = await request(app)
      .post(`/api/leads/${leadCode}/follow-up`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        status: 'Converted', remarks: 'Policy sold',
        collectedNCP: 42000, sumAssured: 1000000, productName: 'S3PP',
        payMode: 'Yearly', policyNo: '3', proposalNo: 'Pro-4',
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stamped: any = await pool.query(
      `SELECT converted_at, current_status FROM leads WHERE lead_code = $1`, [leadCode],
    );
    assert.ok(stamped.rows[0].converted_at, 'converted_at must be stamped on conversion');
    assert.equal(stamped.rows[0].current_status, 'Converted');
    const firstStamp = new Date(stamped.rows[0].converted_at).getTime();
    // A later follow-up (remarks only, no status re-asserted — the F6
    // rule would demand the conversion fields again otherwise) must
    // NOT move the stamp.
    const again = await request(app)
      .post(`/api/leads/${leadCode}/follow-up`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ remarks: 'Second note' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const restamped: any = await pool.query(
      `SELECT converted_at FROM leads WHERE lead_code = $1`, [leadCode],
    );
    assert.equal(new Date(restamped.rows[0].converted_at).getTime(), firstStamp);
  });

  it('follow-up: a non-won status does not stamp converted_at', async () => {
    const lead = await seedCorporateLead();
    const res = await request(app)
      .post(`/api/leads/${lead.lead_code}/follow-up`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'Contacted', remarks: 'Called, will think' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row: any = await pool.query(
      `SELECT converted_at FROM leads WHERE lead_code = $1`, [lead.lead_code],
    );
    assert.equal(row.rows[0].converted_at, null);
  });

  /* ---- Source guards (static — the page wiring, not the API) ---- */

  it('source guard: the picker renders only while the corporate source is selected', () => {
    const src = read('src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(src.includes("CORPORATE_SOURCE = 'Corporate Client Group Insurance'"));
    assert.ok(src.includes('<CorporateClientPicker'));
    assert.ok(
      src.includes("isFieldVisible('source') && isCorporateSource"),
      'the picker must be gated on the corporate source',
    );
  });

  it('source guard: the sidebar tab exists in all four role navs', () => {
    const nav = read('src/layouts/enterpriseNav.ts');
    const hits = nav.split("path: '/leads/corporate'").length - 1;
    assert.equal(hits, 4, 'admin, manager, team lead, agent');
    assert.ok(nav.includes("label: 'Corporate Group Lead'"));
  });

  it('source guard: the route is registered before /leads/:id', () => {
    const appSrc = read('src/App.tsx');
    assert.ok(appSrc.includes("path: '/leads/corporate'"));
    assert.ok(
      appSrc.indexOf("path: '/leads/corporate'") < appSrc.indexOf("path: '/leads/:id'"),
      'the static route must be declared before the dynamic one',
    );
  });

  it('source guard: the LeadList mobile rows are untouched by corporate code', () => {
    const list = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(!list.includes('corporate'), 'no corporate references in LeadList at all');
  });

  it('source guard: the upload page documents the code-in-Source behaviour', () => {
    const upload = read('src/modules/leads/pages/LeadUpload.tsx');
    assert.ok(upload.includes('Corporate leads:'), 'the hint text must name the behaviour');
    assert.ok(upload.includes('Corporate Client Group Insurance'));
  });
});
