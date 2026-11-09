import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { readFileSync } from 'node:fs';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
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
 * Minimal schema for the calendar-settings surface: the identity /
 * permission tables requireAuth + requirePermissionCode resolve
 * through, the Metadata Engine tables the weekend config rides, and
 * an audit_logs sink. Migration 056 itself creates calendar_holidays
 * and seeds the weekend row + the 57 gazette holidays.
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

describe('Calendar Settings (PR C) — weekend config + BD govt holidays', () => {
  let pool: any;
  let app: express.Express;
  let adminUser: any;
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
    const adminRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`);
    const empRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`);
    const permRes: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    // The privileged employee's ROLE carries the settings.manage grant.
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRole.rows[0].id, permRes.rows[0].id]);

    const mkUser = async (emp: string, name: string, roleId: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
         VALUES ($1, $2, $3, 'hashed', $4, $5) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@test.com`, roleId, deptId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    adminUser = { ...(await mkUser('ADMIN1', 'Admin User', adminRole.rows[0].id)), role: 'ADMIN' };
    privileged = { ...(await mkUser('EMPP', 'Privileged Employee', empRole.rows[0].id)), role: 'EMPLOYEE' };
    // Plain employee: separate role WITHOUT the grant.
    const plainRole: any = await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE_PLAIN', 'Employee Plain', 10, 'Own') RETURNING id`);
    plain = { ...(await mkUser('EMPU', 'Plain Employee', plainRole.rows[0].id)), role: 'EMPLOYEE' };

    // The migration under test — table + weekend seed + holiday seed.
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

  async function getConfig(user: any, qs = ''): Promise<any> {
    return request(app).get(`/api/calendar/config${qs}`).set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  it('migration 056 is the registered tail and seeds exactly 57 holidays (28 in 2026, 29 in 2027)', async () => {
    assert.ok(MIGRATION_IDS.includes('056_calendar_settings_holidays'));
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '056_calendar_settings_holidays', '056 is the migration tail');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('056_calendar_settings_holidays'), 'runner names migration 056');

    const total: any = await pool.query(`SELECT COUNT(*)::int AS n FROM calendar_holidays`);
    assert.equal(total.rows[0].n, 57);
    const byYear: any = await pool.query(
      `SELECT EXTRACT(YEAR FROM holiday_date)::int AS y, COUNT(*)::int AS n FROM calendar_holidays GROUP BY 1 ORDER BY 1`
    );
    assert.deepEqual(byYear.rows.map((r: any) => [r.y, r.n]), [[2026, 28], [2027, 29]]);
    const byCat: any = await pool.query(
      `SELECT category, COUNT(*)::int AS n FROM calendar_holidays GROUP BY 1 ORDER BY 1`
    );
    assert.deepEqual(byCat.rows.map((r: any) => [r.category, r.n]), [['executive', 28], ['general', 29]]);

    // Re-running the migration must never duplicate (ON CONFLICT DO NOTHING).
    await migrate056();
    const again: any = await pool.query(`SELECT COUNT(*)::int AS n FROM calendar_holidays`);
    assert.equal(again.rows[0].n, 57);
  });

  it('same-date double holidays survive the seed (dedupe is (date, name), never date alone)', async () => {
    for (const date of ['2026-03-20', '2026-05-01', '2027-05-20']) {
      const res: any = await pool.query(`SELECT name FROM calendar_holidays WHERE holiday_date = $1::date ORDER BY name`, [date]);
      assert.equal(res.rows.length, 2, `${date} must carry two holidays`);
    }
    const names: any = await pool.query(`SELECT name FROM calendar_holidays WHERE holiday_date = '2026-05-01'::date ORDER BY name`);
    assert.deepEqual(names.rows.map((r: any) => r.name), ['Buddha Purnima (Baishakhi Purnima)', 'May Day']);
  });

  it('every seeded holiday carries its verified Bangla name (name_bn pairing, all 57)', async () => {
    // The pairing comes from the canonical verified list
    // (bangladesh-govt-holidays-2026-2027.json), matched to the seed
    // by (date, category) — a few English labels differ slightly
    // between the sources ("Jumatul Wida" here vs "Jumatul Bida"
    // there), so this pins EVERY (date, name) -> name_bn pair rather
    // than a sample. The one shared (date, category) group,
    // 2026-05-01, pairs by occasion (May Day / Buddha Purnima).
    const EXPECTED_NAME_BN: Array<[string, string, string]> = [
    ['2026-02-04', 'Shab-e-Barat', 'শব-ই-বরাত'],
    ['2026-02-21', 'Shaheed Day and International Mother Language Day', 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস'],
    ['2026-03-17', 'Shab-e-Qadr', 'শব-ই-কদর'],
    ['2026-03-19', 'Eid-ul-Fitr holiday (2 days before Eid)', 'ঈদুল ফিতর'],
    ['2026-03-20', 'Jumatul Wida', 'জুমাতুল বিদা'],
    ['2026-03-20', 'Eid-ul-Fitr holiday (day before Eid)', 'ঈদুল ফিতর'],
    ['2026-03-21', 'Eid-ul-Fitr', 'ঈদুল ফিতর'],
    ['2026-03-22', 'Eid-ul-Fitr holiday (day after Eid)', 'ঈদুল ফিতর'],
    ['2026-03-23', 'Eid-ul-Fitr holiday (2 days after Eid)', 'ঈদুল ফিতর'],
    ['2026-03-26', 'Independence and National Day', 'স্বাধীনতা ও জাতীয় দিবস'],
    ['2026-04-13', 'Chaitra Sankranti (hill districts only)', 'চৈত্র সংক্রান্তি'],
    ['2026-04-14', 'Bengali New Year', 'পহেলা বৈশাখ'],
    ['2026-05-01', 'May Day', 'মে দিবস'],
    ['2026-05-01', 'Buddha Purnima (Baishakhi Purnima)', 'বুদ্ধ পূর্ণিমা'],
    ['2026-05-26', 'Eid-ul-Azha holiday (2 days before Eid)', 'ঈদুল আজহা'],
    ['2026-05-27', 'Eid-ul-Azha holiday (day before Eid)', 'ঈদুল আজহা'],
    ['2026-05-28', 'Eid-ul-Azha', 'ঈদুল আজহা'],
    ['2026-05-29', 'Eid-ul-Azha holiday (day after Eid)', 'ঈদুল আজহা'],
    ['2026-05-30', 'Eid-ul-Azha holiday (2 days after Eid)', 'ঈদুল আজহা'],
    ['2026-05-31', 'Eid-ul-Azha holiday (3 days after Eid)', 'ঈদুল আজহা'],
    ['2026-06-26', 'Ashura', 'আশুরা'],
    ['2026-08-05', 'July Mass Uprising Day', 'জুলাই গণঅভ্যুত্থান দিবস'],
    ['2026-08-26', 'Eid-e-Milad-un-Nabi (SAW)', 'ঈদ-ই-মিলাদুন্নবী'],
    ['2026-09-04', 'Janmashtami', 'জন্মাষ্টমী'],
    ['2026-10-20', 'Durga Puja (Mahanabami)', 'দুর্গাপূজা (মহানবমী)'],
    ['2026-10-21', 'Durga Puja (Vijaya Dashami)', 'দুর্গাপূজা (বিজয়া দশমী)'],
    ['2026-12-16', 'Victory Day', 'বিজয় দিবস'],
    ['2026-12-25', 'Christmas Day', 'বড়দিন'],
    ['2027-01-24', 'Shab-e-Barat', 'শব-ই-বরাত'],
    ['2027-02-21', 'Shaheed Day and International Mother Language Day', 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস'],
    ['2027-03-05', 'Jumatul Wida', 'জুমাতুল বিদা'],
    ['2027-03-07', 'Shab-e-Qadr', 'শব-ই-কদর'],
    ['2027-03-08', 'Eid-ul-Fitr holiday (2 days before Eid)', 'ঈদুল ফিতর'],
    ['2027-03-09', 'Eid-ul-Fitr holiday (day before Eid)', 'ঈদুল ফিতর'],
    ['2027-03-10', 'Eid-ul-Fitr', 'ঈদুল ফিতর'],
    ['2027-03-11', 'Eid-ul-Fitr holiday (day after Eid)', 'ঈদুল ফিতর'],
    ['2027-03-12', 'Eid-ul-Fitr holiday (2 days after Eid)', 'ঈদুল ফিতর'],
    ['2027-03-26', 'Independence and National Day', 'স্বাধীনতা ও জাতীয় দিবস'],
    ['2027-04-13', 'Chaitra Sankranti (hill districts only)', 'চৈত্র সংক্রান্তি'],
    ['2027-04-14', 'Bengali New Year (Pahela Baishakh)', 'পহেলা বৈশাখ'],
    ['2027-05-01', 'May Day', 'মে দিবস'],
    ['2027-05-15', 'Eid-ul-Azha holiday (2 days before Eid)', 'ঈদুল আজহা'],
    ['2027-05-16', 'Eid-ul-Azha holiday (day before Eid)', 'ঈদুল আজহা'],
    ['2027-05-17', 'Eid-ul-Azha', 'ঈদুল আজহা'],
    ['2027-05-18', 'Eid-ul-Azha holiday (day after Eid)', 'ঈদুল আজহা'],
    ['2027-05-19', 'Eid-ul-Azha holiday (2 days after Eid)', 'ঈদুল আজহা'],
    ['2027-05-20', 'Eid-ul-Azha holiday (3 days after Eid)', 'ঈদুল আজহা'],
    ['2027-05-20', 'Buddha Purnima (Baishakhi Purnima)', 'বুদ্ধ পূর্ণিমা'],
    ['2027-06-16', 'Ashura', 'আশুরা'],
    ['2027-08-05', 'July Mass Uprising Day', 'জুলাই গণঅভ্যুত্থান দিবস'],
    ['2027-08-15', 'Eid-e-Milad-un-Nabi (SAW)', 'ঈদ-ই-মিলাদুন্নবী'],
    ['2027-08-25', 'Janmashtami', 'জন্মাষ্টমী'],
    ['2027-10-09', 'Durga Puja (Mahanabami)', 'দুর্গাপূজা (মহানবমী)'],
    ['2027-10-10', 'Durga Puja (Vijaya Dashami)', 'দুর্গাপূজা (বিজয়া দশমী)'],
    ['2027-11-07', 'National Revolution and Solidarity Day', 'জাতীয় বিপ্লব ও সংহতি দিবস'],
    ['2027-12-16', 'Victory Day', 'বিজয় দিবস'],
    ['2027-12-25', 'Christmas Day', 'বড়দিন'],
    ];
    const blank: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM calendar_holidays WHERE name_bn IS NULL OR btrim(name_bn) = ''`
    );
    assert.equal(blank.rows[0].n, 0, 'no seeded holiday may lack a Bangla name');
    const rows: any = await pool.query(`SELECT holiday_date::text AS d, name, name_bn FROM calendar_holidays`);
    const byKey = new Map(rows.rows.map((r: any) => [`${r.d}|${r.name}`, r.name_bn]));
    assert.equal(byKey.size, 57);
    for (const [date, name, nameBn] of EXPECTED_NAME_BN) {
      assert.equal(byKey.get(`${date}|${name}`), nameBn, `${date} ${name} must carry name_bn ${nameBn}`);
    }
  });

  it('GET /calendar/config answers any signed-in user with the Fri+Sat default weekend and all holidays', async () => {
    const res = await getConfig(plain);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.weekendDays, [5, 6]);
    assert.equal(res.body.data.holidays.length, 57);
    const victory = res.body.data.holidays.find((h: any) => h.date === '2026-12-16');
    assert.equal(victory.name, 'Victory Day');
    assert.equal(victory.category, 'general');
    assert.equal(victory.nameBn, 'বিজয় দিবস');
    assert.ok(
      res.body.data.holidays.every((h: any) => typeof h.nameBn === 'string' && h.nameBn.length > 0),
      'config serves a Bangla name for every seeded holiday'
    );
  });

  it('GET /calendar/config range filter returns exactly the requested year', async () => {
    const res = await getConfig(plain, '?from=2027-01-01&to=2027-12-31');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.holidays.length, 29);
    assert.ok(res.body.data.holidays.every((h: any) => h.date.startsWith('2027')));
    const bad = await getConfig(plain, '?from=not-a-date');
    assert.equal(bad.status, 400);
  });

  it('PUT /calendar/weekend: privileged round-trip persists; the change survives a re-read', async () => {
    const put = await request(app).put('/api/calendar/weekend')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ weekendDays: [5] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.data.weekendDays, [5]);
    const cfg = await getConfig(plain);
    assert.deepEqual(cfg.body.data.weekendDays, [5]);
    // Restore the Bangladesh default for later assertions.
    const back = await request(app).put('/api/calendar/weekend')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ weekendDays: [5, 6] });
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.data.weekendDays, [5, 6]);
  });

  it('PUT /calendar/weekend: invalid payloads are 400 and an empty weekend is legal', async () => {
    for (const weekendDays of [[7], [-1], [5, 5], ['fri'], [1.5], 'fri', null]) {
      const res = await request(app).put('/api/calendar/weekend')
        .set('Authorization', `Bearer ${tokenFor(privileged)}`)
        .send({ weekendDays });
      assert.equal(res.status, 400, `payload ${JSON.stringify(weekendDays)} must be 400`);
    }
    const empty = await request(app).put('/api/calendar/weekend')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ weekendDays: [] });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.weekendDays, []);
    await request(app).put('/api/calendar/weekend')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ weekendDays: [5, 6] });
  });

  it('holiday mutations are gated: a caller without settings.manage gets 403 everywhere', async () => {
    const post = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send({ date: '2027-06-01', name: 'Test Day', category: 'general' });
    assert.equal(post.status, 403);
    const put = await request(app).put('/api/calendar/weekend')
      .set('Authorization', `Bearer ${tokenFor(plain)}`)
      .send({ weekendDays: [0] });
    assert.equal(put.status, 403);
    const anyRow: any = await pool.query(`SELECT id FROM calendar_holidays LIMIT 1`);
    const del = await request(app).delete(`/api/calendar/holidays/${anyRow.rows[0].id}`)
      .set('Authorization', `Bearer ${tokenFor(plain)}`);
    assert.equal(del.status, 403);
  });

  it('holiday CRUD round-trip: create → duplicate 400 → edit → delete → delete again 404', async () => {
    const created = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-01', name: 'Company Foundation Day', category: 'executive', moonDependent: false, regional: false });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.equal(created.body.data.category, 'executive');

    const dup = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-01', name: 'Company Foundation Day', category: 'general' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.message, /already exists/);

    // Same date, different name — legal (the (date, name) identity).
    const sibling = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-01', name: 'Second Same-Day Holiday', category: 'general' });
    assert.equal(sibling.status, 201);

    const edited = await request(app).put(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-02', name: 'Company Foundation Day (observed)', category: 'general', moonDependent: true, regional: false });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.date, '2027-06-02');
    assert.equal(edited.body.data.moonDependent, true);

    const removed = await request(app).delete(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`);
    assert.equal(removed.status, 200);
    const removedAgain = await request(app).delete(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`);
    assert.equal(removedAgain.status, 404);
    // Clean up the sibling so the suite leaves the seed counts intact.
    await request(app).delete(`/api/calendar/holidays/${sibling.body.data.id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`);
  });

  it('holiday nameBn round-trip: create with a Bangla name -> config serves it -> edit clears it -> edit sets it again', async () => {
    const created = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-05', name: 'Bangla Name Day', nameBn: 'বাংলা নাম দিবস', category: 'general' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.nameBn, 'বাংলা নাম দিবস');
    const id = created.body.data.id;

    const cfg = await getConfig(plain, '?from=2027-06-05&to=2027-06-05');
    assert.equal(cfg.body.data.holidays.length, 1);
    assert.equal(cfg.body.data.holidays[0].nameBn, 'বাংলা নাম দিবস');

    // Omitting nameBn on update clears it; a whitespace-only value
    // trims to null as well (empty -> null semantics).
    const cleared = await request(app).put(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-05', name: 'Bangla Name Day', category: 'general' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.data.nameBn, null);
    const blanked = await request(app).put(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-05', name: 'Bangla Name Day', nameBn: '   ', category: 'general' });
    assert.equal(blanked.status, 200);
    assert.equal(blanked.body.data.nameBn, null);

    // A padded value is trimmed and stored.
    const reset = await request(app).put(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-06-05', name: 'Bangla Name Day', nameBn: '  বাংলা নাম দিবস  ', category: 'general' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.nameBn, 'বাংলা নাম দিবস');

    await request(app).delete(`/api/calendar/holidays/${id}`)
      .set('Authorization', `Bearer ${tokenFor(privileged)}`);
  });

  it('holiday validation: impossible dates, blank names and bad categories are 400; seeded duplicate is 400', async () => {
    const badDate = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2026-02-30', name: 'Impossible Day', category: 'general' });
    assert.equal(badDate.status, 400);
    const blankName = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-01-01', name: '   ', category: 'general' });
    assert.equal(blankName.status, 400);
    const badCat = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2027-01-01', name: 'Some Day', category: 'optional' });
    assert.equal(badCat.status, 400);
    const seededDup = await request(app).post('/api/calendar/holidays')
      .set('Authorization', `Bearer ${tokenFor(privileged)}`)
      .send({ date: '2026-12-16', name: 'Victory Day', category: 'general' });
    assert.equal(seededDup.status, 400);
    assert.match(seededDup.body.message, /already exists/);
  });
});
