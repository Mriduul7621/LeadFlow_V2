import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';
import { buildTeamTree, type TeamOwnStats, type TeamTreePersonInput } from '../services/teamTree.js';

/**
 * Org-tree team report (owner request, 2026-11-11).
 *
 * /team opens as the reporting TREE (rooted at the top of the caller's
 * visible scope), every node with own numbers + subtree rollup incl.
 * pipeline value ("possible business"), and a drill-down detail with
 * the subtree's status pipeline and follow-up / appreciation insights.
 *
 * Server: GET /api/team/tree (users.routes.ts) feeds the pure builder
 * in server/services/teamTree.ts. Visibility is the caller's existing
 * scope (resolveCallerVisibility) — the builder only ever receives
 * in-scope people, and edges exist only among them.
 *
 * The HTTP suite builds leads in the PRODUCTION shape (current_status,
 * expected_premium, converted_at, next_follow_up_at, is_deleted — and
 * deliberately NO bare `status` column; the FIX-1b overview died on
 * exactly that drift once).
 */

const stats = (partial: Partial<TeamOwnStats>): TeamOwnStats => ({
  openLeads: 0, dueToday: 0, overdue: 0, converted: 0, convertedThisMonth: 0, pipelineValue: 0, ...partial,
});
const person = (userId: string, name: string, managerUserId: string | null, level: number | null = null): TeamTreePersonInput => ({
  userId, employeeId: userId.toUpperCase(), name, designation: null, roleName: null,
  department: null, managerUserId, managerEmployeeId: null, managerName: null,
  hierarchyLevel: level, isSelf: false,
});

describe('buildTeamTree — shape, roots, rollups', () => {
  const A = person('a', 'A Root', null, 1);
  const B = person('b', 'B Lead', 'a', 3);
  const C = person('c', 'C Member', 'b');
  const D = person('d', 'D Member', 'b');
  const E = person('e', 'E Root', null, 1);
  const statsMap = new Map<string, TeamOwnStats>([
    ['A', stats({ openLeads: 1, pipelineValue: 10 })],
    ['B', stats({ openLeads: 2, dueToday: 1, pipelineValue: 20 })],
    ['C', stats({ openLeads: 3, overdue: 2, converted: 1, convertedThisMonth: 1, pipelineValue: 30 })],
    ['D', stats({ openLeads: 4, converted: 2, pipelineValue: 40 })],
    ['E', stats({ openLeads: 5, pipelineValue: 50 })],
  ]);
  const statusMap = new Map<string, Record<string, number>>([
    ['C', { Interested: 3, Converted: 1 }],
    ['D', { New: 4, Converted: 2 }],
  ]);
  const { people, rootIds } = buildTeamTree([A, B, C, D, E], statsMap, statusMap);
  const byId = new Map(people.map(p => [p.userId, p]));

  it('roots are the people whose manager is not in the set', () => {
    assert.deepEqual(rootIds, ['a', 'e']);
  });

  it('edges only among returned people, children name-sorted', () => {
    assert.deepEqual(byId.get('b')!.childrenIds, ['c', 'd']);
    assert.deepEqual(byId.get('a')!.childrenIds, ['b']);
    assert.equal(byId.get('a')!.directReports, 1);
  });

  it('rollup math: subtree = own + all descendants (incl. pipeline value)', () => {
    const b = byId.get('b')!;
    assert.equal(b.subtree.people, 3);
    assert.equal(b.subtree.openLeads, 2 + 3 + 4);
    assert.equal(b.subtree.pipelineValue, 20 + 30 + 40);
    assert.equal(b.subtree.converted, 0 + 1 + 2);
    assert.equal(b.subtree.overdue, 2);
    const a = byId.get('a')!;
    assert.equal(a.subtree.people, 4);
    assert.equal(a.subtree.openLeads, 1 + 2 + 3 + 4);
    assert.equal(a.subtree.pipelineValue, 10 + 20 + 30 + 40);
    const c = byId.get('c')!;
    assert.equal(c.subtree.people, 1);
    assert.equal(c.subtree.openLeads, c.openLeads);
  });

  it('subtree status counts merge down the tree', () => {
    assert.deepEqual(byId.get('b')!.subtreeStatusCounts, { Interested: 3, Converted: 3, New: 4 });
    assert.deepEqual(byId.get('e')!.subtreeStatusCounts, {});
  });

  it('tiers: grand-reports -> manager, reports -> teamLead, else teamMember', () => {
    assert.equal(byId.get('a')!.tier, 'manager');
    assert.equal(byId.get('b')!.tier, 'teamLead');
    assert.equal(byId.get('c')!.tier, 'teamMember');
  });

  it("a scoped caller's subtree becomes the forest (manager outside the set)", () => {
    const scoped = buildTeamTree([B, C, D], statsMap, statusMap);
    assert.deepEqual(scoped.rootIds, ['b']);
    assert.equal(scoped.people.length, 3);
  });

  it('a manager cycle cannot hang or drop people', () => {
    const X = person('x', 'X', 'y');
    const Y = person('y', 'Y', 'x');
    const cyclic = buildTeamTree([X, Y], new Map(), new Map());
    assert.equal(cyclic.people.length, 2);
    assert.ok(cyclic.rootIds.length >= 1, 'cycle island is surfaced as root(s)');
    for (const p of cyclic.people) assert.ok(Number.isFinite(p.subtree.people));
  });
});

// ---------------------------------------------------------------------------
// HTTP — production-shaped schema
// ---------------------------------------------------------------------------

const JWT_SECRET = 'team-tree-test-secret';

describe('GET /api/team/tree — org-tree report over the production leads shape', () => {
  let pool: any;
  let app: express.Express;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(100), department_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );`);
    await pool.query(`
      CREATE TABLE roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255),
        hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB, actions JSONB, feature_permissions JSONB, permissions_snapshot JSONB
      );`);
    await pool.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL,
        role_id UUID, department_id UUID, manager_id UUID, designation TEXT,
        is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE,
        reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb,
        hierarchy_level INT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      );`);
    await pool.query(`CREATE TABLE permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
    await pool.query(`CREATE TABLE role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
    await pool.query(`CREATE TABLE user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
    await pool.query(`
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID,
        action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );`);
    // PRODUCTION shape: current_status + expected_premium + converted_at
    // (014) — and NO bare `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_name VARCHAR(255), current_status VARCHAR(255),
        assigned_to VARCHAR(30), created_by VARCHAR(30),
        next_follow_up_at TIMESTAMP, expected_premium NUMERIC(14,2),
        converted_at TIMESTAMP, is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );`);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const deptId = dept.rows[0].id;
    const mkRole = async (code: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      );
      return r.rows[0].id;
    };
    const ceoRole = await mkRole('ADMIN', 1, 'Organization');
    const headRole = await mkRole('BH', 2, 'DownTeam');
    const leadRole = await mkRole('UM', 5, 'Own');
    const memRole = await mkRole('RO', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null, role: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId]
      );
      const u = { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
      ids[emp] = u.id;
      tokens[emp] = jwt.sign({ ...u, role }, JWT_SECRET, { expiresIn: '1h' });
      return u;
    };
    const ceo = await mkUser('TCEO', ceoRole, null, 'ADMIN');
    const head = await mkUser('THEAD', headRole, ceo.id, 'BH');
    const sib = await mkUser('TSIB', headRole, ceo.id, 'BH');
    const lead = await mkUser('TLEAD', leadRole, head.id, 'UM');
    await mkUser('TMEM1', memRole, lead.id, 'RO');
    await mkUser('TMEM2', memRole, lead.id, 'RO');
    await mkUser('TSMEM', memRole, sib.id, 'RO');

    const bounds = getDhakaBusinessDayBounds(new Date());
    const startMs = new Date(bounds.todayStartIso).getTime();
    const dueToday = new Date(startMs + 2 * 3600_000).toISOString();
    const dueTomorrow = new Date(new Date(bounds.tomorrowStartIso).getTime() + 3600_000).toISOString();
    const overdueAt = new Date(startMs - 3600_000).toISOString();
    const nowIso = new Date().toISOString();
    const longAgo = new Date(Date.now() - 40 * 86400_000).toISOString();
    const mkLead = async (assignedTo: string, status: string, next: string | null, premium: number | null, convertedAt: string | null = null, deleted = false) => {
      await pool.query(
        `INSERT INTO leads (customer_name, current_status, assigned_to, created_by, next_follow_up_at, expected_premium, converted_at, is_deleted)
         VALUES ('C', $1, $2, $2, $3, $4, $5, $6)`,
        [status, assignedTo, next, premium, convertedAt, deleted]
      );
    };
    // TMEM1: open 2 (due today 100k, overdue 50k), converted 2 (1 this
    // month), 1 terminal with a past follow-up (NOT overdue), 1 deleted.
    await mkLead('TMEM1', 'Interested', dueToday, 100000);
    await mkLead('TMEM1', 'New', overdueAt, 50000);
    await mkLead('TMEM1', 'Converted', null, null, nowIso);
    await mkLead('TMEM1', 'Converted', null, null, longAgo);
    await mkLead('TMEM1', 'Not Interested', overdueAt, null);
    await mkLead('TMEM1', 'Interested', dueToday, 777, null, true);
    // TMEM2: open 1 (tomorrow, 200k), converted this month.
    await mkLead('TMEM2', 'Follow-up Set', dueTomorrow, 200000);
    await mkLead('TMEM2', 'Converted', null, null, nowIso);
    // TLEAD: one own open lead (30k).
    await mkLead('TLEAD', 'New', null, 30000);
    // TSMEM (sibling subtree): big pipeline that must never leak to THEAD.
    await mkLead('TSMEM', 'Interested', dueToday, 999999);

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  const get = async (emp: string) =>
    request(app).get('/api/team/tree').set('Authorization', `Bearer ${tokens[emp]}`);

  it('the test leads table is the production shape (precondition)', async () => {
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    assert.ok(names.includes('current_status') && names.includes('expected_premium') && names.includes('converted_at'));
    assert.ok(!names.includes('status'), 'no bare status column — the production shape');
  });

  it("a scoped head sees exactly their subtree, rooted at themself", async () => {
    const res = await get('THEAD');
    assert.equal(res.status, 200);
    const emps = res.body.people.map((p: any) => p.employeeId).sort();
    assert.deepEqual(emps, ['THEAD', 'TLEAD', 'TMEM1', 'TMEM2']);
    assert.deepEqual(res.body.rootIds, [ids.THEAD]);
    assert.ok(!JSON.stringify(res.body).includes('TSIB'), 'sibling manager must be absent');
    assert.ok(!JSON.stringify(res.body).includes('TSMEM'), "sibling's member must be absent");
    assert.ok(!JSON.stringify(res.body).includes('999999'), "sibling's pipeline must not leak");
  });

  it('own numbers per person (open / due today / overdue / converted / this month / pipeline)', async () => {
    const res = await get('THEAD');
    const mem1 = res.body.people.find((p: any) => p.employeeId === 'TMEM1');
    assert.equal(mem1.openLeads, 2);
    assert.equal(mem1.dueToday, 1);
    assert.equal(mem1.overdue, 1, 'terminal lead with a past follow-up is NOT overdue');
    assert.equal(mem1.convertedLeads, 2);
    assert.equal(mem1.convertedThisMonth, 1, 'only the converted_at inside this Dhaka month counts');
    assert.equal(mem1.pipelineValue, 150000, 'deleted lead premium excluded; open leads only');
  });

  it('subtree rollups aggregate the whole team incl. pipeline value', async () => {
    const res = await get('THEAD');
    const lead = res.body.people.find((p: any) => p.employeeId === 'TLEAD');
    assert.equal(lead.subtree.people, 3);
    assert.equal(lead.subtree.openLeads, 1 + 2 + 1);
    assert.equal(lead.subtree.pipelineValue, 30000 + 150000 + 200000);
    assert.equal(lead.subtree.converted, 3);
    assert.equal(lead.subtree.convertedThisMonth, 2);
    assert.equal(lead.subtree.overdue, 1);
    assert.equal(lead.subtree.dueToday, 1);
    const head = res.body.people.find((p: any) => p.employeeId === 'THEAD');
    assert.equal(head.subtree.people, 4);
    assert.deepEqual(lead.childrenIds.sort(), [ids.TMEM1, ids.TMEM2].sort());
  });

  it('subtree status pipeline counts by current_status (deleted excluded)', async () => {
    const res = await get('THEAD');
    const head = res.body.people.find((p: any) => p.employeeId === 'THEAD');
    assert.deepEqual(head.subtreeStatusCounts, {
      Interested: 1, New: 2, 'Follow-up Set': 1, Converted: 3, 'Not Interested': 1,
    });
  });

  it('a leaf member sees only themself, as the root', async () => {
    const res = await get('TMEM1');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.people.map((p: any) => p.employeeId), ['TMEM1']);
    assert.deepEqual(res.body.rootIds, [ids.TMEM1]);
  });

  it('an Organization caller starts at the real root and sees both subtrees', async () => {
    const res = await get('TCEO');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rootIds, [ids.TCEO]);
    assert.equal(res.body.people.length, 7);
    const ceo = res.body.people.find((p: any) => p.employeeId === 'TCEO');
    assert.equal(ceo.subtree.pipelineValue, 380000 + 999999);
    const sib = res.body.people.find((p: any) => p.employeeId === 'TSIB');
    assert.deepEqual(sib.childrenIds, [ids.TSMEM]);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/team/tree');
    assert.equal(res.status, 401);
  });
});

describe('org-tree report — source guards', () => {
  const page = readFileSync(new URL('../../src/modules/team/pages/TeamOverview.tsx', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../routes/production/users.routes.ts', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../services/teamTree.ts', import.meta.url), 'utf8');

  it('the page renders tree + detail + insights from the one endpoint', () => {
    assert.ok(page.includes("'/api/team/tree'"));
    assert.ok(page.includes('Team tree'));
    assert.ok(page.includes('Possible business (open pipeline)'));
    assert.ok(page.includes('Needs follow-up'));
    assert.ok(page.includes('Doing well — converted'));
    assert.ok(page.includes('Direct team'));
    assert.ok(page.includes('Pipeline by status') || page.includes('pipeline by status'));
  });

  it('the flat tier groups still exist on the same page', () => {
    assert.ok(page.includes("'Managers'") || page.includes('Managers'));
    assert.ok(page.includes('Team Leaders') && page.includes('Team Members'));
  });

  it('the builder is pure (no database access — scope comes from the route)', () => {
    assert.ok(!builder.includes('getPool') && !builder.includes('pool.query'));
    assert.ok(routes.includes("router.get('/team/tree', requireAuth"));
    assert.ok(routes.includes('buildTeamTree'));
  });

  it('the tree query uses production column names only', () => {
    const treeBlock = routes.slice(routes.indexOf("router.get('/team/tree'"));
    assert.ok(treeBlock.includes('current_status'));
    assert.ok(treeBlock.includes('expected_premium'));
    assert.ok(treeBlock.includes('converted_at'));
    assert.ok(!/FROM leads[^;]*\bstatus\b(?!_)/s.test(treeBlock.split('router.get')[0]), 'no bare status column in the tree queries');
  });
});
