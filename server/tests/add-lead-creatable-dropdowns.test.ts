/**
 * Add Lead creatable dropdowns — POST /options/quick-add.
 *
 * Mahadi's spec: in the Add Lead form, a dropdown whose needed option
 * is missing gets a "+" to type a new one, and anything anyone adds
 * appears in EVERYONE's dropdown. Pinned here against the real chain
 * (runMigrations + seeds + default grants, real HTTP endpoints):
 *
 *  - a `leads.create` holder (NOT settings.manage) can append one
 *    option to a lead-form list; it is stored once, Active, with
 *    provenance (meta.addedVia/addedBy) and an audit_logs entry;
 *  - dedupe is case-insensitive and returns the canonical stored
 *    option (`existing: true`) — never a case-variant twin;
 *  - values are normalised (trim + collapsed whitespace), blank and
 *    >255 values are refused;
 *  - the allowlist is exactly the lists the Add Lead form renders:
 *    the seven core types plus any Form Builder dropdown's metadata
 *    type. Workflow-bound (FollowUpStatus) and other real types
 *    (MeetingType) stay admin-only;
 *  - an INACTIVE namesake is not resurrected — admin deactivation wins;
 *  - the permission gate: no leads.create → 403, no token → 401;
 *  - a lead created with a just-added option stores the canonical
 *    value (lead fields are free-form server-side, so the shared list
 *    is the single source of truth);
 *  - two concurrent adds to the same list both survive.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { seedMetadata } from '../database/seeds/metadata.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
// Sign with the server's own secret constant (captured by shared.ts at
// import time) so the token always matches what requireAuth verifies with.
import { JWT_SECRET } from '../routes/production/shared.js';

const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Add Lead creatable dropdowns (POST /options/quick-add)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let emp: any;
  let ceo: any;

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) =>
    sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

  const quickAdd = (token: string, body: Record<string, any>) =>
    request(app).post('/api/options/quick-add').set('Authorization', `Bearer ${token}`).send(body);

  before(async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    await applyDefaultRoleAccess();
    await seedMetadata();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);

    const deptRes = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(deptRes.status, 200, JSON.stringify(deptRes.body));
    const deptId = deptRes.body.id as string;

    const addUser = async (employeeId: string, role: string, managerId?: string) => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({
          employeeId,
          fullName: `Person ${employeeId}`,
          email: `${employeeId.toLowerCase()}@test.com`,
          role,
          departmentId: deptId,
          ...(managerId ? { managerId } : {}),
          status: 'Active',
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };

    ceo = await addUser('CEO1', 'CEO');
    const mgr = await addUser('MGR1', 'MANAGER', ceo.id);
    emp = await addUser('EMP1', 'EMPLOYEE', mgr.id);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM options WHERE meta->>'addedVia' = 'lead-form'`);
    await pool.query(`DELETE FROM options WHERE field_key = 'Hobby'`);
    await pool.query(`DELETE FROM form_fields WHERE field_key = 'hobby'`);
    await pool.query('DELETE FROM leads');
    await pool.query(`DELETE FROM audit_logs WHERE action_code = 'options.quick_add'`);
  });

  it('adds an option for a leads.create holder (no settings.manage) and audits it', async () => {
    // EMPLOYEE holds leads.create via FIELD_EXEC defaults and does NOT
    // hold settings.manage — succeeding here proves the narrow gate.
    const res = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Source', value: 'TikTok' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.type, 'Source');
    assert.equal(res.body.value, 'TikTok');
    assert.equal(res.body.status, 'Active');
    assert.equal(res.body.existing, false);

    // Everyone reads the same list: a fresh GET /options shows it.
    const list = await request(app).get('/api/options').set('Authorization', `Bearer ${tokenFor(emp, 'EMPLOYEE')}`);
    assert.equal(list.status, 200);
    const stored = list.body.find((o: any) => o.type === 'Source' && o.value === 'TikTok');
    assert.ok(stored, 'the new option must be readable by everyone');
    assert.equal(stored.status, 'Active');

    const row = await pool.query(`SELECT meta FROM options WHERE field_key = 'Source' AND option_value = 'TikTok'`);
    assert.equal(row.rows[0].meta.addedVia, 'lead-form');
    assert.equal(row.rows[0].meta.addedBy, 'EMP1');

    const audit = await pool.query(
      `SELECT actor_user_id, entity_id FROM audit_logs WHERE action_code = 'options.quick_add'`
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, emp.id);
    assert.equal(audit.rows[0].entity_id, stored.id);
  });

  it('dedupes case-insensitively and returns the canonical stored option', async () => {
    const first = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Source', value: 'TikTok' });
    assert.equal(first.status, 201);

    const dup = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Source', value: 'tiktok' });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.existing, true);
    assert.equal(dup.body.value, 'TikTok', 'the stored spelling wins');

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'Source' AND LOWER(option_value) = 'tiktok'`
    );
    assert.equal(count.rows[0].n, 1, 'no case-variant twin may be stored');
  });

  it('canonicalises the type key to the spelling the form queries', async () => {
    const res = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'source', value: 'Podcast' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.type, 'Source');
    const row = await pool.query(`SELECT field_key FROM options WHERE option_value = 'Podcast'`);
    assert.equal(row.rows[0].field_key, 'Source');
  });

  it('normalises whitespace and rejects blank / overlong values', async () => {
    const spaced = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Campaign', value: '  Eid   Mela  ' });
    assert.equal(spaced.status, 201, JSON.stringify(spaced.body));
    assert.equal(spaced.body.value, 'Eid Mela');

    const blank = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Campaign', value: '   ' });
    assert.equal(blank.status, 400);

    const overlong = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Campaign', value: 'x'.repeat(256) });
    assert.equal(overlong.status, 400);

    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM options WHERE field_key = 'Campaign' AND meta->>'addedVia' = 'lead-form'`
    );
    assert.equal(rows.rows[0].n, 1, 'only the normalised value was stored');
  });

  it('refuses lists the Add Lead form does not render (allowlist)', async () => {
    const token = tokenFor(emp, 'EMPLOYEE');
    // Workflow-bound pipeline list — extending it would break status rules.
    const status = await quickAdd(token, { type: 'FollowUpStatus', value: 'Sleeping' });
    assert.equal(status.status, 400);
    // A real metadata type, but not an Add Lead dropdown.
    const meeting = await quickAdd(token, { type: 'MeetingType', value: 'Video Call Pro' });
    assert.equal(meeting.status, 400);
    // Not a metadata type at all.
    const bogus = await quickAdd(token, { type: 'TotallyBogus', value: 'X' });
    assert.equal(bogus.status, 400);

    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM options WHERE option_value IN ('Sleeping', 'Video Call Pro', 'X')`
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it('extends a metadata type wired to a Form Builder dropdown field', async () => {
    const field = await request(app)
      .post('/api/form-fields')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ fieldKey: 'hobby', label: 'Hobby', fieldType: 'dropdown', metadataTypeKey: 'Hobby', section: 'Additional' });
    assert.equal(field.status, 200, JSON.stringify(field.body));

    const res = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Hobby', value: 'Fishing' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.type, 'Hobby');
    assert.equal(res.body.value, 'Fishing');
  });

  it('gates on leads.create: a holder of other grants gets 403, anonymous gets 401', async () => {
    // CEO holds the EXECUTIVE default set — deliberately no leads.create.
    const forbidden = await quickAdd(tokenFor(ceo, 'CEO'), { type: 'Source', value: 'Board Meeting' });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));

    const anon = await request(app).post('/api/options/quick-add').send({ type: 'Source', value: 'Board Meeting' });
    assert.equal(anon.status, 401);
  });

  it('does not resurrect an inactive option an admin deactivated', async () => {
    const seed = await request(app)
      .post('/api/options')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ type: 'Source', value: 'Dead Channel', status: 'Inactive' });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));

    const res = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Source', value: 'dead channel' });
    assert.equal(res.status, 400, JSON.stringify(res.body));

    const rows = await pool.query(
      `SELECT is_active FROM options WHERE field_key = 'Source' AND LOWER(option_value) = 'dead channel'`
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].is_active, false);
  });

  it('a lead created with a just-added option stores the canonical value', async () => {
    const add = await quickAdd(tokenFor(emp, 'EMPLOYEE'), { type: 'Source', value: 'Billboard' });
    assert.equal(add.status, 201);

    const lead = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(emp, 'EMPLOYEE')}`)
      .send({
        prospectName: 'Rahim Uddin',
        mobile: '01712345678',
        source: 'Billboard',
        profession: 'Doctor',
        maritalStatus: 'Single',
      });
    assert.equal(lead.status, 200, JSON.stringify(lead.body));
    assert.equal(lead.body.success, true);

    const stored = await pool.query(`SELECT source FROM leads WHERE mobile = '01712345678'`);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].source, 'Billboard');
  });

  it('two concurrent adds to the same list both survive, exactly once each', async () => {
    const token = tokenFor(emp, 'EMPLOYEE');
    const [a, b] = await Promise.all([
      quickAdd(token, { type: 'Product', value: 'Alpha Plan' }),
      quickAdd(token, { type: 'Product', value: 'Beta Plan' }),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));

    const rows = await pool.query(
      `SELECT option_value, COUNT(*)::int AS n FROM options
        WHERE field_key = 'Product' AND option_value IN ('Alpha Plan', 'Beta Plan')
        GROUP BY option_value`
    );
    assert.equal(rows.rows.length, 2);
    for (const r of rows.rows) assert.equal(r.n, 1);
  });
});
