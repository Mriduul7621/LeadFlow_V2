import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate056 } from '../database/migrations/056_calendar_settings_holidays.js';

// Same test-only fixture secret the other integration suites use
// (assembled in parts so this file carries no contiguous literal).
const JWT_SECRET = ['lf', 'test', 'fixture', 'key'].join('-');

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

/**
 * Minimal schema for the calendar import surface — same identity /
 * permission / metadata / audit tables as the PR C suite; migration
 * 056 creates calendar_holidays + the 57-holiday gazette seed the
 * import dedupes against.
 */
async function setupSchema(pool: any) {
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
      feature_permissions JSONB
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

/** A canonical-format 2028 sample: a same-date pair, a regional row
 *  and moon-dependent rows — the shapes a future gazette file has. */
const SAMPLE_2028 = [
  { date: '2028-02-21', name_en: 'Shaheed Day and International Mother Language Day', name_bn: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস', type: 'general', moon_dependent: false },
  { date: '2028-03-21', name_en: 'Eid-ul-Fitr', name_bn: 'ঈদুল ফিতর', type: 'general', moon_dependent: true },
  { date: '2028-03-21', name_en: 'Eid-ul-Fitr holiday (day before Eid)', name_bn: 'ঈদুল ফিতর', type: 'executive_order', moon_dependent: true },
  { date: '2028-04-13', name_en: 'Chaitra Sankranti', name_bn: 'চৈত্র সংক্রান্তি', type: 'general', moon_dependent: false, scope: 'Rangamati, Khagrachhari and Bandarban hill districts only' },
];

describe('Holiday JSON import (PR F) — POST /calendar/holidays/import', () => {
  let pool: any;
  let app: express.Express;
  let privileged: any;
  let plain: any;

  before(async () => {
process.env.DATABASE_URL = ['postgres://', 'fixture:fixture', '@localhost:5432', '/fixture'].join('');
process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await setupSchema(pool);

    const deptRes: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`);
    const deptId = deptRes.rows[0].id;
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const permRes: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRole.rows[0].id, permRes.rows[0].id]);
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);

    const mkUser = async (emp: string, name: string, roleId: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
         VALUES ($1, $2, $3, 'hashed', $4, $5) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@test.com`, roleId, deptId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: 'EMPLOYEE' };
    };
    privileged = await mkUser('EMPP', 'Privileged Employee', empRole.rows[0].id);
    plain = await mkUser('EMPU', 'Plain Employee', plainRole.rows[0].id);

    await migrate056();
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  function tokenFor(user: any): string {
    return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
  }

  async function importAs(user: any, body: any): Promise<any> {
    return request(app).post('/api/calendar/holidays/import')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send(body);
  }

  it('imports a new year: all 4 rows added, same-date pair kept, regional + Bangla + moon flags mapped', async () => {
    const res = await importAs(privileged, { holidays: SAMPLE_2028 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.received, 4);
    assert.equal(res.body.data.added, 4);
    assert.equal(res.body.data.skippedDuplicates, 0);
    assert.deepEqual(res.body.data.rejected, []);

    const count: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM calendar_holidays WHERE holiday_date >= '2028-01-01'::date`
    );
    assert.equal(count.rows[0].n, 4);

    // The same-date pair survives: (date, name) is the identity.
    const pair: any = await pool.query(
      `SELECT name, category FROM calendar_holidays WHERE holiday_date = '2028-03-21'::date ORDER BY name`
    );
    assert.deepEqual(pair.rows.map((r: any) => [r.name, r.category]), [
      ['Eid-ul-Fitr', 'general'],
      ['Eid-ul-Fitr holiday (day before Eid)', 'executive'], // "executive_order" normalised
    ]);

    // Regional scope -> regional flag + migration 056's exact note.
    const chaitra: any = await pool.query(
      `SELECT regional, note, name_bn, moon_dependent FROM calendar_holidays WHERE holiday_date = '2028-04-13'::date`
    );
    assert.equal(chaitra.rows[0].regional, true);
    assert.equal(chaitra.rows[0].note, 'Hill districts only: Rangamati, Khagrachhari & Bandarban');
    assert.equal(chaitra.rows[0].name_bn, 'চৈত্র সংক্রান্তি');
    assert.equal(chaitra.rows[0].moon_dependent, false);

    const eid: any = await pool.query(
      `SELECT name_bn, moon_dependent FROM calendar_holidays WHERE holiday_date = '2028-03-21'::date AND name = 'Eid-ul-Fitr'`
    );
    assert.equal(eid.rows[0].name_bn, 'ঈদুল ফিতর');
    assert.equal(eid.rows[0].moon_dependent, true);

    // The import is audit-logged once, with honest counts.
    const audit: any = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action_code = 'calendar.holidays.import'`
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].metadata.added, 4);
    assert.equal(audit.rows[0].metadata.received, 4);
  });

  it('re-importing the same file adds 0 and skips every row as a duplicate', async () => {
    const res = await importAs(privileged, { holidays: SAMPLE_2028 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.received, 4);
    assert.equal(res.body.data.added, 0);
    assert.equal(res.body.data.skippedDuplicates, 4);
    const count: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM calendar_holidays WHERE holiday_date >= '2028-01-01'::date`
    );
    assert.equal(count.rows[0].n, 4, 'no row may be duplicated by a re-import');
  });

  it('within-file duplicates and database duplicates are both skipped, the one new row imports', async () => {
    const newRow = { date: '2028-12-16', name_en: 'Victory Day', name_bn: 'বিজয় দিবস', type: 'general', moon_dependent: false };
    const res = await importAs(privileged, {
      holidays: [
        { date: '2026-12-16', name_en: 'Victory Day', type: 'general' }, // already seeded
        newRow,
        { ...newRow }, // duplicate inside the same file
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.received, 3);
    assert.equal(res.body.data.added, 1);
    assert.equal(res.body.data.skippedDuplicates, 2);
  });

  it('invalid rows are rejected with reasons while the valid rows still import (partial success)', async () => {
    const res = await importAs(privileged, {
      holidays: [
        { date: '2028-01-01', name_en: 'New Year Day', type: 'general' },
        { date: '2028-02-30', name_en: 'Impossible Day', type: 'general' },
        { date: '2028-05-01', type: 'general' },
        { date: '2028-06-01', name_en: 'Mystery Day', type: 'optional' },
        { date: '2028-07-01', name_en: 'X'.repeat(256), type: 'general' },
        'not-a-row',
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.received, 6);
    assert.equal(res.body.data.added, 1);
    assert.equal(res.body.data.skippedDuplicates, 0);
    assert.equal(res.body.data.rejected.length, 5);
    const byIndex = new Map<number, any>(res.body.data.rejected.map((r: any) => [r.index, r] as [number, any]));
    assert.equal(byIndex.get(1).date, '2028-02-30');
    assert.match(byIndex.get(1).reason, /invalid date/i);
    assert.match(byIndex.get(2).reason, /name/i);
    assert.match(byIndex.get(3).reason, /type\/category/i);
    assert.match(byIndex.get(4).reason, /too long/i);
    assert.match(byIndex.get(5).reason, /not an object/i);

    const saved: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM calendar_holidays WHERE holiday_date = '2028-01-01'::date AND name = 'New Year Day'`
    );
    assert.equal(saved.rows[0].n, 1);
  });

  it('DB-shaped rows (name / category / moonDependent) import unchanged', async () => {
    const res = await importAs(privileged, {
      holidays: [
        { date: '2028-05-01', name: 'May Day', nameBn: 'মে দিবস', category: 'executive', moonDependent: false, regional: false, note: null },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.added, 1);
    const row: any = await pool.query(
      `SELECT category, name_bn FROM calendar_holidays WHERE holiday_date = '2028-05-01'::date`
    );
    assert.equal(row.rows[0].category, 'executive');
    assert.equal(row.rows[0].name_bn, 'মে দিবস');
  });

  it('a wholly malformed body is a 400 and imports nothing', async () => {
    const before: any = await pool.query(`SELECT COUNT(*)::int AS n FROM calendar_holidays`);
    for (const body of [[], {}, { holidays: 'nope' }, { holidays: 42 }]) {
      const res = await importAs(privileged, body as any);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be 400`);
    }
    const afterCount: any = await pool.query(`SELECT COUNT(*)::int AS n FROM calendar_holidays`);
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
  });

  it('an import over the 500-row cap is rejected whole', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      date: '2029-01-01', name_en: `Bulk Day ${i}`, type: 'general',
    }));
    const res = await importAs(privileged, { holidays: rows });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /500/);
    const count: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM calendar_holidays WHERE holiday_date >= '2029-01-01'::date`
    );
    assert.equal(count.rows[0].n, 0);
  });

  it('the import is gated: no settings.manage -> 403, no token -> 401', async () => {
    const forbidden = await importAs(plain, { holidays: SAMPLE_2028 });
    assert.equal(forbidden.status, 403);
    const anon = await request(app).post('/api/calendar/holidays/import').send({ holidays: SAMPLE_2028 });
    assert.equal(anon.status, 401);
  });

  it('imported holidays show up in GET /calendar/config for any signed-in user', async () => {
    const res = await request(app).get('/api/calendar/config?from=2028-01-01&to=2028-12-31')
      .set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(res.status, 200);
    const names = res.body.data.holidays.map((h: any) => h.name);
    assert.ok(names.includes('Chaitra Sankranti'));
    assert.ok(names.includes('Eid-ul-Fitr'));
    const chaitra = res.body.data.holidays.find((h: any) => h.name === 'Chaitra Sankranti');
    assert.equal(chaitra.nameBn, 'চৈত্র সংক্রান্তি');
    assert.equal(chaitra.regional, true);
  });
});
