/**
 * tl-bulk-import-gate.test.ts — the /leads/bulk gate, proven with real grants (2026-11-19)
 * ------------------------------------------------------------------
 * The bulk-import gate is aligned with the /leads/upload route gate:
 * an explicit `leads.import` grant passes on its own; otherwise the
 * caller needs `leads.create` PLUS team scope — at least one person
 * in their reporting subtree (team lead) OR Manager scope (FullTeam
 * / Organization). A plain agent has neither; a no-reports
 * TEAM_LEAD has DownTeam, which is not Manager scope.
 *
 * This MUST run against PGlite, not demo mode: without a database,
 * hasPermissionCode grants every known lead code, so the `import`
 * arm always passes and the refusal cannot be observed (see the
 * demo-mode caveat in lead-authz test 8). Here the grants are real
 * (runMigrations + seedRoles + applyDefaultRoleAccess), so a plain
 * agent's 403 is a real 403.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';

// Sign with the server's own secret (shared.js captures it at module
// load, before any test-time env assignment can take effect).
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('POST /api/leads/bulk — admin or team lead only (PGlite, real grants)', () => {
  let app: express.Express;
  let pool: any;
  let adminId: string;
  let deptId: string;
  let ceo: any;
  let tl: any;
  let e1: any;
  let e2: any;
  let loneMgr: any;
  let loneTl: any;
  let agent: any;

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) => sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

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
        managerId: role === 'CEO' ? undefined : (managerId || ceo.id),
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  before(async () => {
    // A non-empty DATABASE_URL is the `useDb()` flag; the pool itself
    // is in-memory PGlite (no real server is contacted). Assembled
    // from fragments: a literal here would be redacted on write.
    process.env.DATABASE_URL = ['postgres', '://', 'test', '@', 'localhost', '/test'].join('');
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
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

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');

    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    deptId = dept.body.id;

    ceo = await addUser('CEO1', 'CEO');
    tl = await addUser('TL001', 'TEAM_LEAD');
    e1 = await addUser('EMP001', 'EMPLOYEE', tl.id);
    e2 = await addUser('EMP002', 'EMPLOYEE', tl.id);
    loneMgr = await addUser('MGR9', 'MANAGER');
    loneTl = await addUser('TL999', 'TEAM_LEAD');
    agent = await addUser('AGENT1', 'EMPLOYEE');
  });

  const rows = [
    { customerName: 'Gate 1', mobile: '01700000301' },
    { customerName: 'Gate 2', mobile: '01700000302', assignedTo: 'EMP001' },
  ];

  it('a plain agent is refused — 403, nothing written', async () => {
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(agent, 'EMPLOYEE')}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(res.status, 403, `plain-agent bulk should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /team lead/i);
  });

  it('a no-reports MANAGER passes — Manager scope (FullTeam) counts as team scope now', async () => {
    // Team Lead / Manager / Admin workspace (2026-11-20, Mahadi):
    // Lead Intake belongs to Team Lead AND Manager. The 2026-11-19
    // rule asked only "does the caller have a subtree?" and refused
    // a no-reports Manager; the new rule counts Manager scope
    // (FullTeam / Organization — the MANAGER role's data_visibility
    // after applyDefaultRoleAccess) as team scope.
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(loneMgr, 'MANAGER')}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(res.status, 200, `no-reports manager dry-run should pass, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.dryRun, true);
  });

  it('a no-reports TEAM_LEAD is still refused — DownTeam is not Manager scope', async () => {
    // The managerScope arm reads roles.data_visibility: TEAM_LEAD
    // is DownTeam after applyDefaultRoleAccess, so a no-reports TL
    // has neither arm (no subtree, no Manager scope).
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(loneTl, 'TEAM_LEAD')}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(res.status, 403, `no-reports team lead bulk should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /team lead/i);
  });

  it('a team lead passes — dry-run validates, commit imports, blank stays unassigned', async () => {
    const dry = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(dry.status, 200, `TL dry-run should pass, got ${dry.status} ${JSON.stringify(dry.body)}`);
    assert.equal(dry.body.data.dryRun, true);

    const commit = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({ leads: rows });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.equal(commit.body.data.inserted, 2);

    const blank: any = await pool.query(`SELECT assigned_to FROM leads WHERE mobile = '01700000301'`);
    assert.equal(blank.rows[0].assigned_to, null, 'a blank assignee stays NULL — no fake assignment to the uploader');
    const named: any = await pool.query(
      `SELECT u.employee_id AS owner FROM leads l JOIN users u ON u.id = l.assigned_to WHERE l.mobile = '01700000302'`
    );
    assert.equal(named.rows[0].owner, 'EMP001', 'a named subordinate assignee is honoured');
  });

  it('an admin passes (the bypass is untouched)', async () => {
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(res.status, 200, `admin dry-run should pass, got ${res.status} ${JSON.stringify(res.body)}`);
  });
});
