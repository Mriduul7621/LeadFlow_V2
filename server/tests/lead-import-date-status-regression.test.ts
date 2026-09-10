process.env.TZ = 'Asia/Dhaka';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Bulk import — real-data validation regression (post PR #13 bulk repair).
 * ----------------------------------------------------------------------------
 * Entire file runs with TZ=Asia/Dhaka (UTC+6): the business timezone where
 * the preview off-by-one was reported. In UTC+ zones, `new Date("23-Apr-2026")`
 * parses as LOCAL midnight = the previous UTC day, so any date-only code path
 * that mixes local-time Date construction with toISOString() shifts historical
 * dates one day into the past. Every test here would fail against the old
 * implementation and must keep passing.
 *
 *  Issue 1 (dates):   "23-Apr-2026" must stay 2026-04-23 in the preview AND
 *                     in PostgreSQL storage — never 2026-04-22.
 *  Issue 2 (status):  legacy values ("No response", "Unreachable", "Follow up",
 *                     "Not interested", "Interested") resolve to the EXISTING
 *                     canonical FollowUpStatus options; unknown values still
 *                     fail clearly (never silently "Untouched").
 *  Issue 3 (parity):  the client preview and the server import must apply the
 *                     SAME date + status resolution rules, and the intended
 *                     calendar date must be what PostgreSQL stores.
 */

// Dynamic imports on purpose: nothing that may construct a Date may evaluate
// before the TZ assignment above.
const assertTzApplied = () => {
  // Would be 0 in UTC / 300 in New York — must be -360 (UTC+6) here.
  assert.equal(new Date('2026-04-23T10:00:00Z').getTimezoneOffset(), -360, 'regression suite must run in Asia/Dhaka (UTC+6) to be meaningful');
};

const {
  parseImportDate,
  resolveImportStatus,
  DEFAULT_STATUS_DICTIONARY,
} = await import('../routes/leadImport.js');

const {
  mapRowForPreview,
  formatDateForDisplay,
  parseImportDate: parseImportDateClient,
  resolveImportStatus: resolveImportStatusClient,
  DEFAULT_STATUS_DICTIONARY: CLIENT_DEFAULT_STATUS_DICTIONARY,
} = await import('../../src/modules/leads/utils/leadUploadMapping.js');

/** Excel serial for a YYYY-MM-DD date (serial 25569 == 1970-01-01). */
function excelSerial(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86400000) + 25569;
}

/** The exact legacy sheet row the business re-imported (real values). */
function legacySheetRow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    'Assigned Date': '23-Apr-2026',
    'Lead Date': '22-Apr-2026',
    'Name': 'Ranjon Tng',
    'Phone': '8801557586634',
    'E-mail': 'ranjanchakama@gmail.com',
    'Area': 'CTG',
    'Interested amount of investment': 500000,
    'Source': 'Social media',
    'Product': 'SCEP',
    'Other Info': '',
    'Campaign Name': "Child Education April`26",
    'Assigned To': 'Monsoor_CTG',
    'Previously Assigned': '',
    'TAT': 1,
    '1st Call date': '23-Apr-2026',
    'Initial Status': 'No response',
    'Initial Remarks': '',
    'Follow up date': '29-Apr-2026',
    'Follow up': 'Interested',
    'Final Remarks': 'The customer is currently busy as he works in a factory. He asked to be called at 8 PM.',
    ...overrides,
  };
}

/* ============================================================================
   Issue 1 — DATE OFF-BY-ONE (preview + server parsers, pure regression)
============================================================================ */
describe('Bulk import dates — no one-day shift (TZ=Asia/Dhaka)', () => {
  it('GUARD: suite really runs in Asia/Dhaka (UTC+6)', () => {
    assertTzApplied();
  });

  const REQUIRED_DATE_CASES: Array<[any, string]> = [
    ['23-Apr-2026', '2026-04-23'],
    ['22-Apr-2026', '2026-04-22'],
    ['27-Apr-2026', '2026-04-27'],
    ['7-Jun-2026', '2026-06-07'],
    ['2026-04-23', '2026-04-23'],           // ISO
    ['Apr 23, 2026', '2026-04-23'],          // month-first textual
    ['23/04/2026', '2026-04-23'],            // day-first numeric (BD convention)
    ['07/06/2026', '2026-06-07'],            // day-first numeric, padded
    [excelSerial('2026-04-23'), '2026-04-23'], // Excel serial 46135 (number)
    [String(excelSerial('2026-04-23')), '2026-04-23'], // Excel serial (CSV string)
    [String(excelSerial('2026-06-07')), '2026-06-07'],
  ];

  it('A+B. Preview formatDateForDisplay keeps the exact calendar date for every supported shape', () => {
    for (const [input, expected] of REQUIRED_DATE_CASES) {
      assert.equal(formatDateForDisplay(input), expected, `preview display of ${String(input)} must be ${expected}`);
    }
  });

  it('A+B. Server parseImportDate returns UTC midnight of the exact calendar date', () => {
    for (const [input, expected] of REQUIRED_DATE_CASES) {
      assert.equal(parseImportDate(input), `${expected}T00:00:00.000Z`, `server parse of ${String(input)} must be ${expected} UTC midnight`);
    }
  });

  it('A. REGRESSION: the exact legacy sheet row previews with 2026-04-23 / 2026-04-22 (was 2026-04-22 / 2026-04-21)', () => {
    const preview = mapRowForPreview(legacySheetRow(), 0);
    assert.equal(preview.leadDate, '2026-04-22'); // was "2026-04-21" before the fix
    assert.deepEqual(preview.localIssues, []);
  });

  it('Preview raw-grid formatter (Date cells from xlsx cellDates) never shifts a date', () => {
    // xlsx cellDates:true yields UTC-midnight Dates…
    assert.equal(formatDateForDisplay(new Date(Date.UTC(2026, 3, 23))), '2026-04-23');
    // …and a LOCAL-midnight Date (new Date(2026, 3, 23) in UTC+6) must still
    // display the calendar date it was constructed with.
    assert.equal(formatDateForDisplay(new Date(2026, 3, 23)), '2026-04-23');
    assert.equal(formatDateForDisplay(new Date(Date.UTC(2026, 5, 7))), '2026-06-07');
  });

  it('Server parser hardening: timezone-less midnight timestamps and slash dates keep their calendar date', () => {
    assert.equal(parseImportDate('2026-04-23T00:00:00'), '2026-04-23T00:00:00.000Z');
    assert.equal(parseImportDate('2026-04-23 00:00:00'), '2026-04-23T00:00:00.000Z');
    assert.equal(parseImportDate('2026/04/23'), '2026-04-23T00:00:00.000Z');
    assert.equal(parseImportDateClient('2026/04/23'), '2026-04-23T00:00:00.000Z');
  });

  it('Real timestamps are preserved as instants (date-only rules do not distort them)', () => {
    assert.equal(parseImportDate('2026-04-23T10:30:00Z'), '2026-04-23T10:30:00.000Z');
    assert.equal(parseImportDateClient('2026-04-23T10:30:00Z'), '2026-04-23T10:30:00.000Z');
  });

  it('Unparseable dates still fail explicitly on both sides (never "now", never guessed)', () => {
    assert.equal(parseImportDate('bogus'), null);
    assert.equal(parseImportDate(''), null);
    assert.equal(parseImportDate(null), null);
    assert.equal(parseImportDateClient('bogus'), null);
    // The preview surfaces the raw text as an issue, exactly like the server.
    const preview = mapRowForPreview(legacySheetRow({ 'Assigned Date': 'sometime next week' }), 0);
    assert.ok(preview.localIssues.some(m => m === 'Assigned Date "sometime next week" is not a recognizable date'));
  });

  it('Preview and server agree on the resolved date for every supported shape', () => {
    const inputs: any[] = [
      '23-Apr-2026', '22-Apr-2026', '27-Apr-2026', '7-Jun-2026', '2026-04-23',
      'Apr 23, 2026', '23/04/2026', '2026/04/23', '2026-04-23T00:00:00',
      excelSerial('2026-04-23'), String(excelSerial('2026-04-22')),
      new Date(Date.UTC(2026, 3, 23)),
    ];
    for (const input of inputs) {
      const server = parseImportDate(input);
      const client = parseImportDateClient(input);
      assert.ok(server && client, `both parsers must accept ${String(input)}`);
      assert.equal(client.slice(0, 10), server.slice(0, 10), `preview must show the same calendar date the server stores for ${String(input)}`);
    }
  });
});

/* ============================================================================
   Issue 2 + 3 — LEGACY STATUS RESOLUTION (preview == server)
============================================================================ */
describe('Bulk import statuses — legacy aliases resolve identically in preview and server', () => {
  const LEGACY_VALUES = ['No response', 'Unreachable', 'Follow up', 'Not interested', 'Interested'];
  const EXPECTED: Record<string, string> = {
    'No response': 'No Response',
    'Unreachable': 'No Response',
    'Follow up': 'Follow-up Set',
    'Not interested': 'Not Interested',
    'Interested': 'Interested',
  };

  it('D+E. The five real legacy sheet values resolve to the SAME canonical statuses on both sides', () => {
    for (const raw of LEGACY_VALUES) {
      const server = resolveImportStatus(raw, DEFAULT_STATUS_DICTIONARY);
      const client = resolveImportStatusClient(raw, CLIENT_DEFAULT_STATUS_DICTIONARY);
      assert.equal(server.ok, true, `"${raw}" must resolve (server)`);
      assert.equal(client.ok, true, `"${raw}" must resolve (preview)`);
      assert.equal(server.status, EXPECTED[raw], `"${raw}" must resolve to ${EXPECTED[raw]} (server)`);
      assert.equal(client.status, server.status, `preview and server must agree on "${raw}"`);
      // No new status options were invented: the target must BE the existing
      // canonical option, and no dictionary entry may have been added.
      assert.ok(DEFAULT_STATUS_DICTIONARY.includes(server.status), `"${raw}" must resolve to an existing canonical status`);
      assert.equal(DEFAULT_STATUS_DICTIONARY.length, 11, 'canonical taxonomy must not grow');
      assert.equal(CLIENT_DEFAULT_STATUS_DICTIONARY.length, DEFAULT_STATUS_DICTIONARY.length, 'client dictionary mirror must not diverge');
    }
  });

  it('Aliases are deterministic (case/spacing/punctuation-insensitive, stable output)', () => {
    for (const variant of ['unreachable', 'UNREACHABLE', 'Unreachable ', 'un-reachable!', 'follow up', 'FollowUp', 'follow-up']) {
      const server = resolveImportStatus(variant, DEFAULT_STATUS_DICTIONARY);
      const client = resolveImportStatusClient(variant, CLIENT_DEFAULT_STATUS_DICTIONARY);
      assert.equal(server.ok, true, `"${variant}" must resolve`);
      assert.equal(client.status, server.status);
      assert.ok(server.status === 'No Response' || server.status === 'Follow-up Set');
    }
  });

  it('G. Unknown statuses FAIL on both sides — never silently converted to Untouched', () => {
    for (const unknown of ['Totally Made Up Status', 'Maybe Later', 'Ghosted']) {
      const server = resolveImportStatus(unknown, DEFAULT_STATUS_DICTIONARY);
      const client = resolveImportStatusClient(unknown, CLIENT_DEFAULT_STATUS_DICTIONARY);
      assert.equal(server.ok, false, `"${unknown}" must fail (server)`);
      assert.equal(client.ok, false, `"${unknown}" must fail (preview)`);
      assert.equal(server.status, unknown);
      assert.equal(client.status, server.status);
    }
    // And the preview reports the same message the server reports.
    const preview = mapRowForPreview(legacySheetRow({ 'Initial Status': 'Maybe Later' }), 0);
    assert.ok(preview.localIssues.includes('Initial Status "Maybe Later" is not a valid status'));
  });

  it('Admin-configured dictionaries stay authoritative: an alias whose canonical target is absent still fails', () => {
    // An admin removed "Follow-up Set" from the options — "Follow up" must
    // NOT resolve to something else or silently pass.
    const server = resolveImportStatus('Follow up', ['Untouched', 'Contacted', 'No Response']);
    const client = resolveImportStatusClient('Follow up', ['Untouched', 'Contacted', 'No Response']);
    assert.equal(server.ok, false);
    assert.equal(client.ok, false);
    // An admin removed "No Response" — "Unreachable" must fail too.
    assert.equal(resolveImportStatus('Unreachable', ['Untouched', 'Interested']).ok, false);
    assert.equal(resolveImportStatusClient('Unreachable', ['Untouched', 'Interested']).ok, false);
    // Canonical values (any casing) keep resolving without aliases.
    assert.deepEqual(resolveImportStatus('no response', ['No Response']), { ok: true, status: 'No Response' });
  });

  it('Blank statuses stay blank on both sides (no fake Untouched substitution)', () => {
    assert.deepEqual(resolveImportStatus('', DEFAULT_STATUS_DICTIONARY), { ok: true, status: '' });
    assert.deepEqual(resolveImportStatusClient(''), { ok: true, status: '' });
    const preview = mapRowForPreview(legacySheetRow({ 'Initial Status': '', 'Follow up': '' }), 0);
    assert.equal(preview.currentStatusResolved, '');
    assert.deepEqual(preview.localIssues, []);
  });

  it('F. Preview resolves current_status with the server precedence: Follow up wins over Initial Status', () => {
    const preview = mapRowForPreview(legacySheetRow({ 'Initial Status': 'Unreachable', 'Follow up': 'Follow up' }), 0);
    assert.equal(preview.initialStatusResolved, 'No Response');
    assert.equal(preview.followUpResolved, 'Follow-up Set');
    assert.equal(preview.currentStatusResolved, 'Follow-up Set');
  });
});

/* ============================================================================
   Issue 3 — PREVIEW/SERVER CONSISTENCY ON THE REAL IMPORT PATH (PGlite)
============================================================================ */
const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

let jwt: any;
let request: any;
let pool: any;
let app: any;

async function setupSchema(p: any) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_code VARCHAR(100),
      department_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE,
      role_name VARCHAR(255),
      hierarchy_level INT DEFAULT 0,
      data_visibility VARCHAR(30) DEFAULT 'Own'
    );
  `);
  await p.query(`
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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      permission_name VARCHAR(255)
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, permission_id)
    );
  `);
  await p.query(`
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
      deleted_at TIMESTAMP
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT uq_field_option_datestatus_test UNIQUE(field_key, option_value)
    );
  `);
}

describe('Bulk import — preview/server consistency on the real import path (PGlite, TZ=Asia/Dhaka)', () => {
  let adminUser: any;
  let monsoor: any;

  before(async () => {
    assertTzApplied();
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    jwt = (await import('jsonwebtoken')).default;
    request = (await import('supertest')).default;

    const { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } = await import('../database/pglitePool.js');
    const { _setTestPoolForTest, _resetPoolsForTest, closePool } = await import('../database/connection.js');

    const db = await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM options`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);
    await pool.query(`DELETE FROM departments`);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;

    const adminRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const adminRoleId = adminRoleRes.rows[0].id;
    const employeeRoleRes: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const employeeRoleId = employeeRoleRes.rows[0].id;

    const permCodes = ['leads.view', 'leads.create', 'leads.edit', 'leads.import'];
    const permIds: Record<string, string> = {};
    for (const code of permCodes) {
      const res: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      permIds[code] = res.rows[0].id;
    }
    for (const roleId of [adminRoleId, employeeRoleId]) {
      for (const code of permCodes) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, permIds[code]]);
      }
    }

    const adminRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('ADMIN1', 'Admin User', 'admin@test.com', 'hashed', $1, $2, true) RETURNING id`, [adminRoleId, deptId]);
    adminUser = { id: adminRes.rows[0].id, employeeId: 'ADMIN1', email: 'admin@test.com', role: 'ADMIN' };

    const monsoorRes: any = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active) VALUES ('Monsoor_CTG', 'Monsoor CTG', 'monsoor@test.com', 'hashed', $1, $2, true) RETURNING id`, [employeeRoleId, deptId]);
    monsoor = { id: monsoorRes.rows[0].id, employeeId: 'Monsoor_CTG' };

    const mod = await import('../routes/production.routes.js');
    const express = (await import('express')).default;
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  after(async () => {
    const { closePool } = await import('../database/connection.js');
    const { _resetPoolsForTest } = await import('../database/connection.js');
    const { resetPGlite } = await import('../database/pglitePool.js');
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM options`);
    // Canonical status dictionary exactly as the metadata engine seeds it.
    for (let i = 0; i < DEFAULT_STATUS_DICTIONARY.length; i++) {
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active) VALUES ('FollowUpStatus', $1, $1, $2, TRUE)`,
        [DEFAULT_STATUS_DICTIONARY[i], i + 1]
      );
    }
  });

  const adminToken = () => signToken({ id: adminUser.id, employeeId: adminUser.employeeId, role: adminUser.role, email: adminUser.email });

  async function importRows(rows: any[], dryRun = false) {
    return request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: rows, dryRun });
  }

  async function leadByMobile(mobile: string) {
    const res: any = await pool.query(
      `SELECT *, assigned_at::text AS assigned_at_text, created_at::text AS created_at_text,
              last_contacted_at::text AS last_contacted_at_text, next_follow_up_at::text AS next_follow_up_at_text
       FROM leads WHERE mobile = $1 AND is_deleted = FALSE`, [mobile]);
    return res.rows[0] || null;
  }

  it('A+B. The EXACT legacy sheet row: preview (dryRun) accepts it and PostgreSQL stores the intended calendar dates', async () => {
    // Legacy real values, including the statuses the preview used to reject.
    const row = legacySheetRow({ 'Initial Status': 'No response', 'Follow up': 'Follow up' });

    // Preview first — the row must not be rejected.
    const preview = await importRows([row], true);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.failed, 0, JSON.stringify(preview.body.data.errors));
    assert.equal(preview.body.data.inserted, 1);

    // Nothing written during dryRun.
    let count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0, 'dry run must not write');

    // Real import.
    const res = await importRows([row]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));

    // H. PostgreSQL stores the exact intended historical calendar dates
    // (::text = stored wall-clock value, reader-timezone independent).
    const lead = await leadByMobile('8801557586634');
    assert.ok(lead, 'lead must be committed');
    assert.match(lead.assigned_at_text, /^2026-04-23 /, 'Assigned Date 23-Apr-2026 must be stored as 2026-04-23');
    assert.match(lead.created_at_text, /^2026-04-22 /, 'Lead Date 22-Apr-2026 must be stored as 2026-04-22');
    assert.match(lead.last_contacted_at_text, /^2026-04-23 /, '1st Call date 23-Apr-2026 must be stored as 2026-04-23');
    assert.match(lead.next_follow_up_at_text, /^2026-04-29 /, 'Follow up date 29-Apr-2026 must be stored as 2026-04-29');

    // Statuses: canonical only in current_status; resolved + raw preserved.
    assert.equal(lead.current_status, 'Follow-up Set');
    assert.equal(lead.custom_fields.initialStatus, 'No Response');
    assert.equal(lead.custom_fields.followUpStatus, 'Follow-up Set');
    assert.equal(lead.custom_fields.initialStatusRaw, 'No response');
    assert.equal(lead.custom_fields.followUpStatusRaw, 'Follow up');
    assert.notEqual(lead.current_status, 'Untouched');

    // Preview and server agreed: the preview resolved the same current status.
    const previewRow = mapRowForPreview(row, 0);
    assert.equal(previewRow.currentStatusResolved, lead.current_status);
    assert.equal(previewRow.leadDate, '2026-04-22');
    assert.deepEqual(previewRow.localIssues, []);
  });

  it('C. Excel serial dates import as the intended calendar dates (no shift)', async () => {
    const row = legacySheetRow({
      'Assigned Date': excelSerial('2026-04-23'), // 46135
      'Lead Date': excelSerial('2026-04-22'),
      '1st Call date': excelSerial('2026-04-23'),
      'Follow up date': excelSerial('2026-04-29'),
      'Phone': '8801711000111',
    });
    const preview = await importRows([row], true);
    assert.equal(preview.body.data.failed, 0, JSON.stringify(preview.body.data.errors));

    const res = await importRows([row]);
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));
    const lead = await leadByMobile('8801711000111');
    assert.match(lead.assigned_at_text, /^2026-04-23 /);
    assert.match(lead.created_at_text, /^2026-04-22 /);
    assert.match(lead.last_contacted_at_text, /^2026-04-23 /);
    assert.match(lead.next_follow_up_at_text, /^2026-04-29 /);
    // And the client preview formatter shows the same dates.
    assert.equal(formatDateForDisplay(excelSerial('2026-04-23')), '2026-04-23');
    assert.equal(mapRowForPreview(row, 0).leadDate, '2026-04-22');
  });

  it('C2. Day-first numeric dates (23/04/2026) import as the intended calendar dates', async () => {
    const row = legacySheetRow({
      'Assigned Date': '23/04/2026',
      'Lead Date': '22/04/2026',
      'Follow up date': '07/06/2026',
      'Phone': '8801711000222',
    });
    const res = await importRows([row]);
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));
    const lead = await leadByMobile('8801711000222');
    assert.match(lead.assigned_at_text, /^2026-04-23 /);
    assert.match(lead.created_at_text, /^2026-04-22 /);
    assert.match(lead.next_follow_up_at_text, /^2026-06-07 /);
  });

  it('D. "Unreachable" resolves consistently between preview and server (stored as No Response)', async () => {
    const row = legacySheetRow({
      'Initial Status': 'Unreachable',
      'Follow up': '',
      'Follow up date': '',
      'Phone': '8801711000333',
    });
    // Preview: accepted locally AND by the authoritative dryRun.
    const previewRow = mapRowForPreview(row, 0);
    assert.equal(previewRow.initialStatusResolved, 'No Response');
    assert.equal(previewRow.currentStatusResolved, 'No Response');
    assert.deepEqual(previewRow.localIssues, []);
    const dry = await importRows([row], true);
    assert.equal(dry.body.data.failed, 0, JSON.stringify(dry.body.data.errors));

    // Server: resolves to the same canonical status.
    const res = await importRows([row]);
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));
    const lead = await leadByMobile('8801711000333');
    assert.equal(lead.current_status, 'No Response');
    assert.equal(lead.custom_fields.initialStatus, 'No Response');
    assert.equal(lead.custom_fields.initialStatusRaw, 'Unreachable', 'raw sheet value must be preserved');
  });

  it('E. "Follow up" resolves consistently between preview and server (stored as Follow-up Set)', async () => {
    const row = legacySheetRow({
      'Initial Status': 'No response',
      'Follow up': 'Follow up',
      'Phone': '8801711000444',
    });
    const previewRow = mapRowForPreview(row, 0);
    assert.equal(previewRow.followUpResolved, 'Follow-up Set');
    assert.equal(previewRow.currentStatusResolved, 'Follow-up Set');
    assert.deepEqual(previewRow.localIssues, []);
    const dry = await importRows([row], true);
    assert.equal(dry.body.data.failed, 0, JSON.stringify(dry.body.data.errors));

    const res = await importRows([row]);
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));
    const lead = await leadByMobile('8801711000444');
    assert.equal(lead.current_status, 'Follow-up Set');
    assert.equal(lead.custom_fields.followUpStatus, 'Follow-up Set');
    assert.equal(lead.custom_fields.followUpStatusRaw, 'Follow up', 'raw sheet value must be preserved');
  });

  it('F. No response / Not interested / Interested keep working (case-insensitive canonical match)', async () => {
    const rows = [
      legacySheetRow({ 'Initial Status': 'No response', 'Follow up': '', 'Follow up date': '', 'Phone': '8801711000555' }),
      legacySheetRow({ 'Initial Status': 'Not interested', 'Follow up': '', 'Follow up date': '', 'Phone': '8801711000666' }),
      legacySheetRow({ 'Initial Status': 'Interested', 'Follow up': '', 'Follow up date': '', 'Phone': '8801711000777' }),
    ];
    for (const row of rows) assert.deepEqual(mapRowForPreview(row, 0).localIssues, []);
    const res = await importRows(rows);
    assert.equal(res.body.data.failed, 0, JSON.stringify(res.body.data.errors));
    assert.equal((await leadByMobile('8801711000555')).current_status, 'No Response');
    assert.equal((await leadByMobile('8801711000666')).current_status, 'Not Interested');
    assert.equal((await leadByMobile('8801711000777')).current_status, 'Interested');
  });

  it('G. Unknown status still fails — in dryRun AND real import — and nothing is written', async () => {
    const row = legacySheetRow({ 'Initial Status': 'Totally Made Up Status', 'Phone': '8801711000888' });
    const localPreview = mapRowForPreview(row, 0);
    assert.ok(localPreview.localIssues.includes('Initial Status "Totally Made Up Status" is not a valid status'));

    const dry = await importRows([row], true);
    assert.equal(dry.body.data.failed, 1);
    assert.match(dry.body.data.errors[0].message, /Initial Status "Totally Made Up Status" is not a valid status/);

    const res = await importRows([row]);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.failed, 1);
    assert.equal(res.body.data.errors[0].message, dry.body.data.errors[0].message, 'server error message must equal the preview message');
    const count: any = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    assert.equal(count.rows[0].c, 0, 'failed row must not be imported');
  });

  it('Preview and server agree per-row on a mixed batch (valid + alias + invalid)', async () => {
    const rows = [
      legacySheetRow({ 'Phone': '8801711000999' }),
      legacySheetRow({ 'Initial Status': 'Unreachable', 'Follow up': 'Follow up', 'Phone': '8801711001111' }),
      legacySheetRow({ 'Initial Status': 'Ghosted', 'Phone': '8801711001222' }),
      legacySheetRow({ 'Assigned Date': 'not a date at all', 'Phone': '8801711001333' }),
    ];
    // Local preview issues must exactly predict which rows the server rejects.
    const failingLocal = new Set(rows.map((r, i) => (mapRowForPreview(r, i).localIssues.length > 0 ? i : -1)).filter(i => i >= 0));

    const dry = await importRows(rows, true);
    assert.equal(dry.body.data.failed, 2);
    const serverFailing = new Set(dry.body.data.errors.map((e: any) => e.index));
    assert.deepEqual(serverFailing, failingLocal, 'preview must reject exactly the rows the server rejects');

    const res = await importRows(rows);
    assert.equal(res.body.data.inserted + res.body.data.updated, 2);
    assert.equal(res.body.data.failed, 2);
    assert.deepEqual(new Set(res.body.data.errors.map((e: any) => e.index)), serverFailing, 'import must reject exactly the rows the preview rejected');
    // The two valid rows committed with their intended statuses/dates.
    assert.equal((await leadByMobile('8801711000999')).current_status, 'Interested');
    assert.equal((await leadByMobile('8801711001111')).current_status, 'Follow-up Set');
  });

  it('I. The client import path posts to the server and contains no localStorage fallback', async () => {
    // Source-level regression guard: the Bulk Upload page and the bulk
    // upload service must not fall back to localStorage or fake success —
    // the server response is the only success signal.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(new URL('.', import.meta.url));
    const page = readFileSync(here + '../../src/modules/leads/pages/LeadUpload.tsx', 'utf8');
    const mapping = readFileSync(here + '../../src/modules/leads/utils/leadUploadMapping.ts', 'utf8');
    const service = readFileSync(here + '../../src/modules/leads/services/leadService.ts', 'utf8');
    assert.doesNotMatch(page, /localStorage/, 'upload page must not use localStorage');
    assert.doesNotMatch(mapping, /localStorage/, 'preview mapping must not use localStorage');
    const bulkFn = service.slice(service.indexOf('async bulkUploadLeads'), service.indexOf('async getLeads'));
    assert.ok(bulkFn.includes('/api/leads/bulk'), 'bulk upload must go through POST /api/leads/bulk');
    assert.doesNotMatch(bulkFn, /localStorage/, 'bulk upload must not fall back to localStorage');
  });
});
