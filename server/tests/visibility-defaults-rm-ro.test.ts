/**
 * visibility-defaults-rm-ro.test.ts
 * ------------------------------------------------------------------
 * Organogram fix 1 of 3 — the default lead-visibility scopes for RM
 * and RO were wider than the jobs:
 *
 *   - RM (Relationship Manager, the first-line supervisor directly
 *     above the RO base agents) defaulted to 'FullTeam' — the whole
 *     department, including sibling managers' teams. Its default is
 *     now 'DownTeam' (its own downline only).
 *   - RO (Relationship Officer, the base field agent) defaulted to
 *     'DownTeam'. Its default is now 'Own'.
 *
 * MANAGER / SM keep 'FullTeam' (the department-wide roles) and CEO /
 * BH keep 'Organization' — untouched by this change.
 *
 * What is pinned here, on the real chain (runMigrations 001→052 +
 * seedRoles + applyDefaultRoleAccess against PGlite):
 *
 *   A. Defaults: with NO admin customisation, the stored role values
 *      and resolveDataVisibility() agree — RM 'DownTeam', RO 'Own',
 *      department-head roles unchanged.
 *   B. Migration 052: narrows rows still holding the EXACT old default
 *      (RM 'FullTeam', RO 'DownTeam'), is idempotent, and never moves
 *      a value an admin chose (wider or narrower). down() is symmetric.
 *   C. Overrides: a stored admin choice is honoured at resolution time
 *      and survives a re-run of the defaults applier.
 *   D. Source guards: the defaults table + migration registration.
 *   E. HTTP: an RM caller listing leads no longer receives a sibling
 *      manager's team leads under default config; their own downline
 *      still arrives; dashboard totals agree with the list; an RO sees
 *      only their own leads; a MANAGER (FullTeam) still sees the whole
 *      department (the fixture's department really is shared).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
import { resolveDataVisibility } from '../authz.js';
import { DEFAULT_VISIBILITY } from '../../src/modules/shared/access/roleGrantDefaults.js';
import { up as narrow052, down as revert052 } from '../database/migrations/052_visibility_defaults_rm_ro.js';

const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Visibility defaults — RM downline-only, RO own (organogram fix 1)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) => sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

  async function visibilityOf(roleCode: string): Promise<string> {
    const r = await pool.query(`SELECT data_visibility FROM roles WHERE UPPER(role_code) = $1`, [roleCode]);
    return r.rows[0]?.data_visibility;
  }

  async function setVisibility(roleCode: string, value: string): Promise<void> {
    await pool.query(`UPDATE roles SET data_visibility = $2 WHERE UPPER(role_code) = $1`, [roleCode, value]);
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();

    // RM / RO are legacy codes: production databases carry the rows
    // (pre-rename installs, organogram imports) even though the fresh
    // seed list no longer creates them. Insert them the way production
    // has them — column default 'Own', grants not yet applied.
    await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES
         ('RM', 'Relationship Manager', 3),
         ('RO', 'Relationship Officer', 4)
       ON CONFLICT (role_code) DO NOTHING`
    );

    // The seed entry point: applies DEFAULT_GRANTS + DEFAULT_VISIBILITY.
    await applyDefaultRoleAccess();

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
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  /* ------------------------------------------------------------------ */
  it('A. defaults: RM resolves DownTeam, RO resolves Own, heads unchanged', async () => {
    // Stored values straight after the standard bootstrap.
    assert.equal(await visibilityOf('RM'), 'DownTeam', 'RM default must be its own downline only');
    assert.equal(await visibilityOf('RO'), 'Own', 'RO default must be its own leads only');
    assert.equal(await visibilityOf('MANAGER'), 'FullTeam', 'department-wide role unchanged');
    assert.equal(await visibilityOf('SM'), 'FullTeam', 'department-wide role unchanged');
    assert.equal(await visibilityOf('CEO'), 'Organization');
    assert.equal(await visibilityOf('TEAM_LEAD'), 'DownTeam');
    assert.equal(await visibilityOf('EMPLOYEE'), 'Own');

    // The runtime resolver (the security boundary) agrees.
    assert.equal(await resolveDataVisibility('RM'), 'DownTeam');
    assert.equal(await resolveDataVisibility('RO'), 'Own');
    assert.equal(await resolveDataVisibility('MANAGER'), 'FullTeam');
    assert.equal(await resolveDataVisibility('CEO'), 'Organization');
  });

  /* ------------------------------------------------------------------ */
  it('B. migration 052 narrows only rows still holding the exact old default', async () => {
    // Simulate a pre-fix production database.
    await setVisibility('RM', 'FullTeam');
    await setVisibility('RO', 'DownTeam');
    await narrow052();
    assert.equal(await visibilityOf('RM'), 'DownTeam', 'RM holding the old default is narrowed');
    assert.equal(await visibilityOf('RO'), 'Own', 'RO holding the old default is narrowed');

    // Idempotent: a second run changes nothing.
    await narrow052();
    assert.equal(await visibilityOf('RM'), 'DownTeam');
    assert.equal(await visibilityOf('RO'), 'Own');

    // Admin choices that differ from the old default survive untouched —
    // wider AND narrower alike.
    await setVisibility('RM', 'Organization');
    await setVisibility('RO', 'FullTeam');
    await narrow052();
    assert.equal(await visibilityOf('RM'), 'Organization', 'an admin-granted wider scope survives');
    assert.equal(await visibilityOf('RO'), 'FullTeam', 'an admin-granted wider scope survives');

    await setVisibility('RM', 'Own');
    await narrow052();
    assert.equal(await visibilityOf('RM'), 'Own', 'an admin-narrowed scope survives');

    // down() restores only rows still holding exactly what up() set.
    await setVisibility('RM', 'DownTeam');
    await setVisibility('RO', 'Own');
    await revert052();
    assert.equal(await visibilityOf('RM'), 'FullTeam', 'down() restores the untouched default');
    assert.equal(await visibilityOf('RO'), 'DownTeam', 'down() restores the untouched default');
    await setVisibility('RM', 'Organization');
    await revert052();
    assert.equal(await visibilityOf('RM'), 'Organization', 'down() never stomps an admin value either');

    // Leave the database in the post-fix default state for later suites.
    await setVisibility('RM', 'FullTeam');
    await setVisibility('RO', 'DownTeam');
    await narrow052();
    assert.equal(await visibilityOf('RM'), 'DownTeam');
    assert.equal(await visibilityOf('RO'), 'Own');
  });

  /* ------------------------------------------------------------------ */
  it('C. a stored admin choice is honoured and survives the defaults applier', async () => {
    await setVisibility('RM', 'FullTeam'); // admin deliberately grants department-wide
    await setVisibility('RO', 'DownTeam'); // admin deliberately grants team view
    assert.equal(await resolveDataVisibility('RM'), 'FullTeam', 'stored admin choice wins at runtime');
    assert.equal(await resolveDataVisibility('RO'), 'DownTeam', 'stored admin choice wins at runtime');

    await applyDefaultRoleAccess();
    assert.equal(await visibilityOf('RM'), 'FullTeam', 'the applier never overrides a stored choice');
    assert.equal(await visibilityOf('RO'), 'DownTeam', 'the applier never overrides a stored choice');

    // Restore the post-fix defaults for the HTTP suite.
    await setVisibility('RM', 'DownTeam');
    await setVisibility('RO', 'Own');
  });

  /* ------------------------------------------------------------------ */
  it('D. source guards: defaults table and migration registration', () => {
    assert.equal(DEFAULT_VISIBILITY.RM, 'DownTeam', 'the defaults table must give RM its downline only');
    assert.ok(!('RO' in DEFAULT_VISIBILITY), 'RO must have no elevated default entry (stays Own)');
    assert.equal(DEFAULT_VISIBILITY.MANAGER, 'FullTeam', 'department heads keep FullTeam');
    assert.equal(DEFAULT_VISIBILITY.SM, 'FullTeam', 'department heads keep FullTeam');
    assert.equal(DEFAULT_VISIBILITY.CEO, 'Organization');

    assert.ok(
      MIGRATION_IDS.includes('052_visibility_defaults_rm_ro'),
      'migration 052 stays registered (053_delete_chain_repair later became the tail)'
    );
    const runner = readFileSync('server/database/runMigrations.ts', 'utf8');
    assert.ok(runner.includes('052_visibility_defaults_rm_ro'), 'runner names migration 052');

    const table = readFileSync('src/modules/shared/access/roleGrantDefaults.ts', 'utf8');
    assert.ok(!/RO:\s*'(DownTeam|FullTeam)'/.test(table), 'no elevated RO default may creep back into the table');
  });

  /* ------------------------------------------------------------------ */
  it('E. HTTP: RM sees own downline only, RO sees own, dashboard agrees', async () => {
    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    const deptId = dept.body.id;

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
          managerId,
          status: 'Active',
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };

    // Organogram, ONE shared department:
    //   CEO
    //   ├── HEAD (MANAGER — FullTeam dept head)
    //   ├── RM_A (RM) ── RO_A1, RO_A2 (RO)
    //   └── RM_B (RM) ── RO_B1 (RO)
    const ceo = await addUser('CEO1', 'CEO');
    const head = await addUser('HEAD1', 'MANAGER', ceo.id);
    const rmA = await addUser('RMA01', 'RM', ceo.id);
    const rmB = await addUser('RMB01', 'RM', ceo.id);
    const roA1 = await addUser('ROA01', 'RO', rmA.id);
    const roA2 = await addUser('ROA02', 'RO', rmA.id);
    const roB1 = await addUser('ROB01', 'RO', rmB.id);

    const addLead = async (mobile: string, ownerId: string) => {
      await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status)
         VALUES ($1, $2, $3, $4, $4, $4, $4, 'New')`,
        [`lead_${mobile}`, `Customer ${mobile}`, mobile, ownerId]
      );
    };
    await addLead('01730000001', rmA.id);  // RM_A's own lead
    await addLead('01730000002', roA1.id); // downline of RM_A
    await addLead('01730000003', roA2.id); // downline of RM_A
    await addLead('01730000004', roB1.id); // sibling team (RM_B's downline)
    await addLead('01730000005', rmB.id);  // sibling manager's own lead

    const listMobiles = async (u: any, role: string): Promise<string[]> => {
      const res = await request(app)
        .get('/api/leads')
        .set('Authorization', `Bearer ${tokenFor(u, role)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return (res.body as any[]).map((l: any) => l.mobile).sort();
    };
    const dashboardTotal = async (u: any, role: string): Promise<number> => {
      const res = await request(app)
        .get('/api/dashboard')
        .set('Authorization', `Bearer ${tokenFor(u, role)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data.totalLeads;
    };

    // RM_A (default DownTeam): own + downline, NOT the sibling team.
    const rmAList = await listMobiles(rmA, 'RM');
    assert.deepEqual(rmAList, ['01730000001', '01730000002', '01730000003'],
      'RM under default config sees exactly their own downline');
    assert.ok(!rmAList.includes('01730000004'), "a sibling manager's team lead must not leak to RM");
    assert.ok(!rmAList.includes('01730000005'), "a sibling manager's own lead must not leak to RM");
    assert.equal(await dashboardTotal(rmA, 'RM'), rmAList.length, 'dashboard total agrees with the list');

    // RO_A1 (default Own): only their own lead.
    const roA1List = await listMobiles(roA1, 'RO');
    assert.deepEqual(roA1List, ['01730000002'], 'RO under default config sees only their own leads');
    assert.equal(await dashboardTotal(roA1, 'RO'), 1, 'dashboard total agrees with the list');

    // HEAD (MANAGER, FullTeam — unchanged default): the whole department,
    // which also proves the fixture's department really is shared, so the
    // RM exclusions above are the scope at work, not a data accident.
    const headList = await listMobiles(head, 'MANAGER');
    assert.deepEqual(headList, ['01730000001', '01730000002', '01730000003', '01730000004', '01730000005'],
      'the department head still sees every team in the department');
  });
});
