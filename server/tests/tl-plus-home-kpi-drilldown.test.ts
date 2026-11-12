/**
 * tl-plus-home-kpi-drilldown.test.ts
 * ------------------------------------------------------------------
 * TL+ Home KPI drill-down (owner-approved 2026-11-13) + the two
 * additions from the same day (member self-view, export at every
 * level).
 *
 * Sections:
 *   1. callerSeesTeam — the new landing rule: admin/CEO/
 *      administration roles (scope not 'Own') get the team home
 *      even with no reports; leaf members keep the member landing.
 *   2. resolveKpiLevel + drill-down helpers (pure): people levels,
 *      leaf levels, member self-view, person=self, breadcrumb
 *      chain (cycle-safe), out-of-scope not-found, URL builders.
 *   3. GET /team/kpi/leads — the leaf lead list against the
 *      PRODUCTION leads shape (current_status, is_deleted,
 *      next_follow_up_at; assigned_to holds the EMPLOYEE ID):
 *      all four KPI definitions, scope 404s, leads.view 403, and
 *      totals matching the overview counts exactly.
 *   4. GET /team/kpi/export — .xlsx of exactly the viewed level
 *      (people rows vs lead rows), `leads.export` grant -> 200 ->
 *      revoke -> 403, out-of-scope 404, audit row.
 *   5. Rendering (SSR, repo style) — the drill-down content at a
 *      people level, a leaf level, not-found; the Export button
 *      only with the grant; Team Home KPI cards link to the page.
 *   6. Source guards — wiring (HomeLanding/useCallerTeam run on
 *      callerSeesTeam; the route + FeatureGate entry exist; the
 *      Workbench strip links person=self; the server never imports
 *      the sibling branches' LeadExportService/teamTree).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';

import {
  callerHasTeam,
  callerSeesTeam,
  type TeamOverviewPerson,
  type TeamOverviewResponse,
} from '../../src/modules/team/services/teamOverviewService';
import {
  KPI_META,
  breadcrumbChain,
  directReportsOf,
  findPersonByEmployeeId,
  isKpiKey,
  kpiDrilldownUrl,
  kpiExportUrl,
  kpiLeadsUrl,
  kpiValueFor,
  resolveKpiLevel,
  sortKpiRows,
  type KpiLevel,
} from '../../src/modules/team/utils/kpiDrilldown';
import { TeamHomeContent } from '../../src/modules/team/pages/TeamHome';
import {
  TeamKpiDrilldownContent,
  type KpiLeadsResponse,
} from '../../src/modules/team/pages/TeamKpiDrilldown';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// NOTE: the secret is assembled from fragments, never written as a
// literal on a *_SECRET-named constant — a literal there was once
// silently replaced by redaction and broke the whole file (FIX-2).
const JWT_SECRET = ['kpi', '-drill', '-secret'].join('');

/* ================================================================ */
/* Fixture people (pure tests) — a visible tree for one caller       */
/* ================================================================ */

const person = (over: Partial<TeamOverviewPerson>): TeamOverviewPerson => ({
  userId: over.employeeId || 'u-x',
  employeeId: 'EMP-X',
  name: 'Person X',
  designation: 'Relationship Officer',
  roleName: 'RO',
  department: 'DSF',
  managerEmployeeId: null,
  managerName: null,
  tier: 'teamMember',
  directReports: 0,
  openLeads: 0,
  convertedLeads: 0,
  dueToday: 0,
  overdue: 0,
  isSelf: false,
  ...over,
});

// HEAD (self, 2 reports) -> TL1 (2 reports) + TL2 (1 report);
// TL1 -> M1, M2; TL2 -> M3. A sibling subtree (SIB -> SX) is NOT in
// this payload: it is outside the caller's visible set.
const treePeople: TeamOverviewPerson[] = [
  person({ userId: 'u-head', employeeId: 'EMP-H', name: 'Hana Head', isSelf: true, directReports: 2, tier: 'manager', openLeads: 1, dueToday: 0, overdue: 0, convertedLeads: 0, designation: 'Business Head', roleName: 'BH' }),
  person({ userId: 'u-tl1', employeeId: 'EMP-T1', name: 'Tariq Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 2, tier: 'teamLead', openLeads: 2, dueToday: 1, overdue: 3, convertedLeads: 1, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-tl2', employeeId: 'EMP-T2', name: 'Tania Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 1, tier: 'teamLead', openLeads: 5, dueToday: 0, overdue: 0, convertedLeads: 2, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-m1', employeeId: 'EMP-M1', name: 'Mina Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', openLeads: 4, dueToday: 2, overdue: 2, convertedLeads: 0 }),
  person({ userId: 'u-m2', employeeId: 'EMP-M2', name: 'Musa Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', openLeads: 1, dueToday: 0, overdue: 5, convertedLeads: 3 }),
  person({ userId: 'u-m3', employeeId: 'EMP-M3', name: 'Mira Member', managerEmployeeId: 'EMP-T2', managerName: 'Tania Lead', openLeads: 3, dueToday: 1, overdue: 1, convertedLeads: 1 }),
];

const teamOverview = (people: TeamOverviewPerson[], scope: string): TeamOverviewResponse => ({
  success: true,
  scope,
  people,
});

/* ================================================================ */
/* 1. callerSeesTeam — the new landing rule                          */
/* ================================================================ */

describe('callerSeesTeam — the team-home landing rule', () => {
  it('an Organization-scope admin with NO reports sees a team', () => {
    // THE owner-reported case (2026-11-13): his ADMIN account has no
    // reports, so the old tree-only rule showed him the Workbench.
    // ADMIN/SUPERADMIN resolve to Organization scope, so the scope
    // arm puts him on the team home.
    const overview = teamOverview(
      [person({ isSelf: true, directReports: 0, name: 'Admin A', employeeId: 'EMP-A' })],
      'Organization'
    );
    assert.equal(callerHasTeam(overview.people), false, 'the tree fact is still false — no reports');
    assert.equal(callerSeesTeam(overview), true, 'but Organization scope means a team is visible');
  });

  it('a scope-Team caller with no reports sees a team', () => {
    // E.g. a FullTeam-scope manager whose reports are all indirect,
    // or any role that can see more than themself.
    const overview = teamOverview(
      [
        person({ isSelf: true, directReports: 0 }),
        person({ employeeId: 'EMP-O', name: 'Other Person' }),
      ],
      'Team'
    );
    assert.equal(callerSeesTeam(overview), true);
  });

  it('a team lead with reports sees a team (the original TL+ rule)', () => {
    assert.equal(callerSeesTeam(teamOverview(treePeople, 'Team')), true);
  });

  it('a leaf member (scope Own, no reports) does NOT see a team', () => {
    const overview = teamOverview(
      [person({ isSelf: true, directReports: 0 })],
      'Own'
    );
    assert.equal(callerSeesTeam(overview), false, 'member landing is untouched');
  });

  it('a missing or empty payload never conjures a team', () => {
    assert.equal(callerSeesTeam(null), false);
    assert.equal(callerSeesTeam(undefined), false);
    assert.equal(callerSeesTeam(teamOverview([], '')), false);
    // Empty scope falls back to the tree fact alone.
    assert.equal(
      callerSeesTeam(teamOverview([person({ isSelf: true, directReports: 1 })], '')),
      true,
      'empty scope + a report -> the tree fact still applies'
    );
    assert.equal(
      callerSeesTeam(teamOverview([person({ isSelf: true, directReports: 0 })], '')),
      false
    );
  });
});

/* ================================================================ */
/* 2. resolveKpiLevel + drill-down helpers (pure)                    */
/* ================================================================ */

describe('kpiDrilldown helpers — levels, chains, URLs', () => {
  it('the top level lists the caller\'s direct reports, KPI desc', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', null);
    assert.equal(level.kind, 'people');
    if (level.kind !== 'people') return;
    assert.equal(level.current.employeeId, 'EMP-H');
    assert.deepEqual(level.rows.map(p => p.employeeId), ['EMP-T1', 'EMP-T2'],
      'overdue desc: TL1 (3) before TL2 (0)');
    assert.deepEqual(level.chain.map(p => p.employeeId), ['EMP-H']);
  });

  it('drilling by name goes one level deeper (manager -> TL -> member)', () => {
    const tl1 = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', 'EMP-T1');
    assert.equal(tl1.kind, 'people');
    if (tl1.kind !== 'people') return;
    assert.deepEqual(tl1.rows.map(p => p.employeeId), ['EMP-M2', 'EMP-M1'],
      'overdue desc: M2 (5) before M1 (2)');
    assert.deepEqual(tl1.chain.map(p => p.employeeId), ['EMP-H', 'EMP-T1']);

    const m1 = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', 'EMP-M1');
    assert.equal(m1.kind, 'leads', 'a leaf member resolves to the lead list');
    if (m1.kind !== 'leads') return;
    assert.equal(m1.current.employeeId, 'EMP-M1');
    assert.deepEqual(m1.chain.map(p => p.employeeId), ['EMP-H', 'EMP-T1', 'EMP-M1']);
  });

  it('a leaf member with no person sees their OWN leads (member self-view)', () => {
    const memberOverview = teamOverview(
      [person({ isSelf: true, directReports: 0, name: 'Solo Member', employeeId: 'EMP-S' })],
      'Own'
    );
    const level = resolveKpiLevel(memberOverview, 'open', null);
    assert.equal(level.kind, 'leads');
    if (level.kind !== 'leads') return;
    assert.equal(level.current.employeeId, 'EMP-S', 'the member themself, not a team level');
  });

  it('person=self forces the caller\'s own leads even with reports', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'dueToday', 'self');
    assert.equal(level.kind, 'leads', 'the My Day strip always lands on own leads');
    if (level.kind !== 'leads') return;
    assert.equal(level.current.employeeId, 'EMP-H');
  });

  it('a person outside the payload is not-found (sibling subtree invisible)', () => {
    // SIB/SX are not in this payload at all: the client cannot even
    // name them, and the server 404s the same URL (section 3).
    assert.equal(resolveKpiLevel(teamOverview(treePeople, 'Team'), 'open', 'EMP-SIB').kind, 'not-found');
    assert.equal(resolveKpiLevel(teamOverview(treePeople, 'Team'), 'open', 'NOPE-1').kind, 'not-found');
  });

  it('an unknown KPI is invalid', () => {
    assert.equal(resolveKpiLevel(teamOverview(treePeople, 'Team'), 'bogus', null).kind, 'invalid-kpi');
    assert.equal(resolveKpiLevel(teamOverview(treePeople, 'Team'), null, null).kind, 'invalid-kpi');
    assert.equal(isKpiKey('open'), true);
    assert.equal(isKpiKey('dueToday'), true);
    assert.equal(isKpiKey('overdue'), true);
    assert.equal(isKpiKey('converted'), true);
    assert.equal(isKpiKey('Open'), false, 'keys are case-sensitive');
  });

  it('kpiValueFor reads the matching overview count', () => {
    const tl1 = treePeople[1];
    assert.equal(kpiValueFor(tl1, 'open'), 2);
    assert.equal(kpiValueFor(tl1, 'dueToday'), 1);
    assert.equal(kpiValueFor(tl1, 'overdue'), 3);
    assert.equal(kpiValueFor(tl1, 'converted'), 1);
    assert.equal(KPI_META.overdue.label, 'Overdue');
  });

  it('directReportsOf + findPersonByEmployeeId match case-insensitively', () => {
    assert.deepEqual(
      directReportsOf(treePeople, 'emp-h').map(p => p.employeeId).sort(),
      ['EMP-T1', 'EMP-T2']
    );
    assert.equal(findPersonByEmployeeId(treePeople, 'emp-m3')?.name, 'Mira Member');
    assert.equal(findPersonByEmployeeId(treePeople, 'EMP-ZZ'), undefined);
  });

  it('sortKpiRows is KPI desc, then name', () => {
    const rows = sortKpiRows(treePeople.filter(p => p.managerEmployeeId === 'EMP-T1'), 'open');
    assert.deepEqual(rows.map(p => p.employeeId), ['EMP-M1', 'EMP-M2'], 'open 4 before open 1');
  });

  it('breadcrumbChain stops at the caller and is cycle-safe', () => {
    assert.deepEqual(
      breadcrumbChain(treePeople, 'EMP-M2', 'EMP-H').map(p => p.employeeId),
      ['EMP-H', 'EMP-T1', 'EMP-M2']
    );
    assert.deepEqual(breadcrumbChain(treePeople, 'EMP-H', 'EMP-H').map(p => p.employeeId), ['EMP-H']);
    assert.deepEqual(breadcrumbChain(treePeople, 'EMP-ZZ', 'EMP-H'), [], 'absent person -> empty chain');
    // A manager cycle (A reports to B, B reports to A) must terminate.
    const cyclic = [
      person({ employeeId: 'EMP-C', name: 'Cid Caller', isSelf: true, managerEmployeeId: null }),
      person({ employeeId: 'EMP-A', name: 'Ann Cycle', managerEmployeeId: 'EMP-B' }),
      person({ employeeId: 'EMP-B', name: 'Bob Cycle', managerEmployeeId: 'EMP-A' }),
    ];
    const chain = breadcrumbChain(cyclic, 'EMP-A', 'EMP-C');
    assert.ok(chain.length <= 2, 'the walk stops on the repeated employee ID');
    assert.deepEqual(chain.map(p => p.employeeId), ['EMP-B', 'EMP-A']);
  });

  it('URL builders carry the KPI and the person param', () => {
    assert.equal(kpiDrilldownUrl('overdue'), '/team/kpi/overdue');
    assert.equal(kpiDrilldownUrl('open', 'EMP-T1'), '/team/kpi/open?person=EMP-T1');
    assert.equal(kpiExportUrl('converted', null), '/api/team/kpi/export?kpi=converted');
    assert.equal(kpiExportUrl('converted', 'EMP-M1'), '/api/team/kpi/export?kpi=converted&person=EMP-M1');
    assert.equal(kpiLeadsUrl('dueToday', 'self'), '/api/team/kpi/leads?kpi=dueToday&person=self');
  });
});

/* ================================================================ */
/* 3 + 4. HTTP — KPI leads + export (production leads shape)         */
/* ================================================================ */

describe('KPI drill-down — HTTP endpoints (production leads shape)', () => {
  let pool: any;
  let app: express.Express;
  let headToken: string;
  let tlToken: string;
  let memToken: string;
  let outToken: string;
  let nogToken: string;
  let umRoleId: string;
  let memRoleId: string;
  let exportPermId: string;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(100),
        department_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE roles (
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
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        designation TEXT,
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
      CREATE TABLE permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        permission_name VARCHAR(255)
      );
    `);
    await pool.query(`
      CREATE TABLE role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE user_permissions (
        user_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE audit_logs (
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
    // PRODUCTION shape: current_status, next_follow_up_at, is_deleted,
    // assigned_to holding the EMPLOYEE ID — and deliberately NO bare
    // `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50),
        customer_name VARCHAR(255),
        mobile VARCHAR(30),
        current_status VARCHAR(255),
        assigned_to VARCHAR(30),
        created_by VARCHAR(30),
        next_follow_up_at TIMESTAMP,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const deptId = dept.rows[0].id;
    const mkRole = async (code: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      );
      return r.rows[0].id;
    };
    const headRole = await mkRole('BH', 2, 'DownTeam');
    umRoleId = await mkRole('UM', 5, 'Own');
    memRoleId = await mkRole('RO', 6, 'Own');
    const memRole = memRoleId;
    const nogRole = await mkRole('NOG', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('KHEAD', headRole, null);
    const tl = await mkUser('KTL', umRoleId, head.id);
    const mem = await mkUser('KMEM', memRole, tl.id);
    const sib = await mkUser('KSIB', umRoleId, head.id);
    const smem = await mkUser('KSMEM', memRole, sib.id);
    const out = await mkUser('KOUT', memRole, null);
    const nog = await mkUser('KNOG', nogRole, null);
    headToken = jwt.sign({ ...head, role: 'BH' }, JWT_SECRET, { expiresIn: '1h' });
    tlToken = jwt.sign({ ...tl, role: 'UM' }, JWT_SECRET, { expiresIn: '1h' });
    memToken = jwt.sign({ ...mem, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });
    outToken = jwt.sign({ ...out, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });
    nogToken = jwt.sign({ ...nog, role: 'NOG' }, JWT_SECRET, { expiresIn: '1h' });

    // Permission grants: BH gets leads.view + leads.export; UM/RO get
    // leads.view only (TL's export grant is toggled by the test);
    // NOG gets nothing (403 pins).
    const viewPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, permission_name) VALUES ('leads.view', 'View leads') RETURNING id`
    );
    const exportPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, permission_name) VALUES ('leads.export', 'Export leads') RETURNING id`
    );
    exportPermId = exportPerm.rows[0].id;
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(headRole, viewPerm.rows[0].id);
    await grant(headRole, exportPermId);
    await grant(umRoleId, viewPerm.rows[0].id);
    await grant(memRole, viewPerm.rows[0].id);

    const bounds = getDhakaBusinessDayBounds(new Date());
    const dueToday = new Date(new Date(bounds.todayStartIso).getTime() + 2 * 3600_000).toISOString();
    const dueTodayLater = new Date(new Date(bounds.todayStartIso).getTime() + 3 * 3600_000).toISOString();
    const overdueAt = new Date(new Date(bounds.todayStartIso).getTime() - 26 * 3600_000).toISOString();
    const tomorrowStart = bounds.tomorrowStartIso;
    const mkLead = async (name: string, assignedTo: string, status: string, nextFollowUpAt: string | null, deleted = false) => {
      await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, is_deleted) VALUES ($1, $2, '01700000000', $3, $4, $4, $5, $6)`,
        [`LC-${name.replace(/[^A-Za-z0-9]/g, '')}`, name, status, assignedTo, nextFollowUpAt, deleted]
      );
    };
    // KMEM: open 5 (M1,M2,M3,M5,M9), dueToday 2 (M3,M4), overdue 2
    // (M1,M2), converted 2 (M4,M6).
    await mkLead('MEM Overdue 1', 'KMEM', 'Interested', overdueAt);
    await mkLead('MEM Overdue 2', 'KMEM', 'Follow-up Set', overdueAt);
    await mkLead('MEM Due Today', 'KMEM', 'Interested', dueToday);
    await mkLead('MEM Converted Due', 'KMEM', 'Converted', dueTodayLater);
    await mkLead('MEM No Date', 'KMEM', 'Interested', null);
    await mkLead('MEM Converted', 'KMEM', 'Converted', null);
    await mkLead('MEM Not Interested', 'KMEM', 'Not Interested', null);
    await mkLead('MEM Deleted', 'KMEM', 'Interested', overdueAt, true);
    await mkLead('MEM Tomorrow', 'KMEM', 'Interested', tomorrowStart);
    await mkLead('TL Overdue', 'KTL', 'New', overdueAt);
    await mkLead('SMEM Overdue', 'KSMEM', 'Interested', overdueAt);
    await mkLead('OUT Overdue', 'KOUT', 'Interested', overdueAt);

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  const kpiLeads = (token: string, kpi: string, person: string) =>
    request(app).get(`/api/team/kpi/leads?kpi=${kpi}&person=${encodeURIComponent(person)}`).set('Authorization', `Bearer ${token}`);

  it('overdue: only open past-due leads of that person', async () => {
    const res = await kpiLeads(headToken, 'overdue', 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['MEM Overdue 1', 'MEM Overdue 2'],
      'terminal + deleted + due-today + tomorrow leads are excluded'
    );
    for (const item of res.body.items) {
      assert.ok(item.id, 'lead rows carry the UUID for the Lead360 link');
      assert.ok(item.leadCode, 'lead rows carry the lead code');
      assert.ok(item.nextFollowUpAt, 'overdue rows carry their follow-up date');
    }
  });

  it('open: every non-terminal lead, regardless of follow-up date', async () => {
    const res = await kpiLeads(headToken, 'open', 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 5);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['MEM Due Today', 'MEM No Date', 'MEM Overdue 1', 'MEM Overdue 2', 'MEM Tomorrow'],
      'includes the no-date and tomorrow leads; excludes terminal + deleted'
    );
  });

  it('dueToday: within the Dhaka day, terminal leads INCLUDED (overview parity)', async () => {
    const res = await kpiLeads(headToken, 'dueToday', 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['MEM Converted Due', 'MEM Due Today'],
      'the overview due_today_count has no terminal filter, so neither does this list'
    );
  });

  it('converted: only Converted leads', async () => {
    const res = await kpiLeads(headToken, 'converted', 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['MEM Converted', 'MEM Converted Due']
    );
  });

  it('a member sees ONLY their own leads via person=self', async () => {
    const res = await kpiLeads(memToken, 'overdue', 'self');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.ok(res.body.items.every((l: any) => l.customerName.startsWith('MEM ')), 'no other member\'s leads leak in');
  });

  it('a member requesting their manager answers 404', async () => {
    const res = await kpiLeads(memToken, 'open', 'KTL');
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Person not found.');
  });

  it('a member requesting a sibling subtree answers 404', async () => {
    const res = await kpiLeads(memToken, 'overdue', 'KSMEM');
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Person not found.');
  });

  it('a head requesting someone outside their subtree answers 404, identical to a nonexistent person', async () => {
    const outside = await kpiLeads(headToken, 'open', 'KOUT');
    const ghost = await kpiLeads(headToken, 'open', 'NOPE999');
    assert.equal(outside.status, 404);
    assert.equal(ghost.status, 404);
    assert.deepEqual(outside.body, ghost.body, 'no existence leak: same status, same body');
  });

  it('an invalid KPI answers 400', async () => {
    const res = await kpiLeads(headToken, 'bogus', 'KMEM');
    assert.equal(res.status, 400);
  });

  it('a caller without leads.view answers 403', async () => {
    const res = await kpiLeads(nogToken, 'open', 'self');
    assert.equal(res.status, 403);
  });

  it('KPI totals match the overview counts exactly, for every KPI', async () => {
    const overview = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${headToken}`);
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const mem = (overview.body.people as any[]).find(p => p.employeeId === 'KMEM');
    assert.ok(mem, 'member listed for the head');
    const expected: Record<string, number> = {
      open: mem.openLeads,
      dueToday: mem.dueToday,
      overdue: mem.overdue,
      converted: mem.convertedLeads,
    };
    assert.deepEqual(expected, { open: 5, dueToday: 2, overdue: 2, converted: 2 }, 'fixture sanity');
    for (const kpi of ['open', 'dueToday', 'overdue', 'converted']) {
      const res = await kpiLeads(headToken, kpi, 'KMEM');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.total, expected[kpi], `${kpi}: leaf-list total must equal the overview count`);
    }
  });

  /* ---------------- export ---------------- */

  // Binary download: superagent needs a custom parser, or the .xlsx
  // arrives as a mangled string. Error cases use the plain JSON
  // helper instead (the binary parser would hand back a Buffer).
  const kpiExport = (token: string, query: string) =>
    request(app)
      .get(`/api/team/kpi/export${query}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: any) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const kpiExportJson = (token: string, query: string) =>
    request(app).get(`/api/team/kpi/export${query}`).set('Authorization', `Bearer ${token}`);

  const readWorkbook = async (buf: Buffer) => {
    const ExcelJS = (await import('exceljs')).default as any;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb.getWorksheet('KPI Export');
  };

  const sheetRows = (ws: any): any[][] => {
    const rows: any[][] = [];
    // includeEmpty: the blank row 3 must occupy its slot, or every
    // row below it shifts up by one in this array.
    ws.eachRow({ includeEmpty: true }, (row: any) => {
      rows.push((row.values as any[]).slice(1));
    });
    return rows;
  };

  it('export at a leaf level carries exactly the lead rows shown', async () => {
    const res = await kpiExport(headToken, '?kpi=overdue&person=KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.match(res.headers['content-type'] || '', /spreadsheetml\.sheet/);
    assert.match(res.headers['content-disposition'] || '', /kpi-overdue-KMEM-.*\.xlsx/);
    const ws = await readWorkbook(res.body as Buffer);
    assert.ok(ws, 'the KPI Export sheet exists');
    const rows = sheetRows(ws);
    assert.match(String(rows[0][0]), /Overdue/, 'title names the KPI');
    assert.deepEqual(rows[3], ['Lead Code', 'Customer Name', 'Mobile', 'Status', 'Next Follow-up']);
    const names = rows.slice(4).map(r => r[1]).sort();
    assert.deepEqual(names, ['MEM Overdue 1', 'MEM Overdue 2']);
  });

  it('export at a people level carries exactly the people rows shown', async () => {
    const res = await kpiExport(headToken, '?kpi=overdue');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const ws = await readWorkbook(res.body as Buffer);
    const rows = sheetRows(ws);
    assert.deepEqual(rows[3], ['Name', 'Employee ID', 'Designation', 'Overdue']);
    // HEAD's direct reports, KPI desc: TL (1 overdue) before SIB (0).
    assert.deepEqual(rows.slice(4).map(r => [r[1], r[3]]), [['KTL', 1], ['KSIB', 0]]);
  });

  it('export at a drilled people level carries that person\'s team', async () => {
    const res = await kpiExport(headToken, '?kpi=overdue&person=KTL');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const ws = await readWorkbook(res.body as Buffer);
    const rows = sheetRows(ws);
    assert.deepEqual(rows.slice(4).map(r => [r[1], r[3]]), [['KMEM', 2]]);
  });

  it('a member without the grant cannot export, even their own data', async () => {
    const res = await kpiExportJson(memToken, '?kpi=overdue&person=self');
    assert.equal(res.status, 403, 'no grant, no export — even of their own data');
  });

  it('a member WITH the grant exports only their own leads — never anyone else\'s', async () => {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [memRoleId, exportPermId]);
    try {
      const own = await kpiExport(memToken, '?kpi=overdue&person=self');
      assert.equal(own.status, 200, JSON.stringify(own.body).slice(0, 200));
      const ws = await readWorkbook(own.body as Buffer);
      assert.deepEqual(sheetRows(ws).slice(4).map(r => r[1]).sort(), ['MEM Overdue 1', 'MEM Overdue 2'],
        'only the member\'s own leads — the grant opens export, the scope still binds it');
      const others = await kpiExportJson(memToken, '?kpi=overdue&person=KTL');
      assert.equal(others.status, 404, 'the grant never widens the visible set');
    } finally {
      await pool.query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [memRoleId, exportPermId]);
    }
  });

  it('export needs leads.export: 403 -> grant -> 200 -> revoke -> 403', async () => {
    const denied = await kpiExportJson(tlToken, '?kpi=overdue&person=KMEM');
    assert.equal(denied.status, 403, 'UM has no leads.export grant yet');
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [umRoleId, exportPermId]);
    const allowed = await kpiExport(tlToken, '?kpi=overdue&person=KMEM');
    assert.equal(allowed.status, 200, 'the admin grant opens the export');
    const ws = await readWorkbook(allowed.body as Buffer);
    assert.deepEqual(sheetRows(ws).slice(4).map(r => r[1]).sort(), ['MEM Overdue 1', 'MEM Overdue 2']);
    await pool.query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [umRoleId, exportPermId]);
    const revoked = await kpiExportJson(tlToken, '?kpi=overdue&person=KMEM');
    assert.equal(revoked.status, 403, 'revoking the grant closes the export again');
  });

  it('export of an out-of-scope person is refused with 404', async () => {
    const res = await kpiExportJson(headToken, '?kpi=open&person=KOUT');
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Person not found.');
  });

  it('export with an invalid KPI answers 400', async () => {
    const res = await kpiExportJson(headToken, '?kpi=bogus');
    assert.equal(res.status, 400);
  });

  it('every export is audit-logged as leads.export with kpi/person/level/count', async () => {
    const res = await kpiExport(headToken, '?kpi=converted&person=KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const rows: any = await pool.query(
      `SELECT metadata FROM audit_logs WHERE action_code = 'leads.export'`
    );
    const mine = (rows.rows as any[]).find(
      r => r.metadata?.kpi === 'converted' && r.metadata?.person === 'KMEM'
    );
    assert.ok(mine, 'an audit row exists for this export');
    assert.equal(mine.metadata.level, 'leads');
    assert.equal(mine.metadata.count, 2);
    assert.equal(mine.metadata.total, 2);
  });
});

/* ================================================================ */
/* 5. Rendering (SSR, repo style)                                    */
/* ================================================================ */

describe('TeamKpiDrilldown — rendering from the resolved level', () => {
  const noop = () => {};
  const renderContent = (props: {
    level: KpiLevel;
    kpi: 'open' | 'dueToday' | 'overdue' | 'converted' | null;
    leads?: KpiLeadsResponse | null;
    leadsLoading?: boolean;
    leadsError?: string | null;
    leadsNotFound?: boolean;
    canExport?: boolean;
  }) =>
    renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamKpiDrilldownContent, {
          level: props.level,
          kpi: props.kpi,
          leads: props.leads ?? null,
          leadsLoading: props.leadsLoading ?? false,
          leadsError: props.leadsError ?? null,
          leadsNotFound: props.leadsNotFound ?? false,
          canExport: props.canExport ?? false,
          exporting: false,
          exportError: null,
          onExport: noop,
          onRetryLeads: noop,
        })
      )
    );

  it('a people level renders rows (name + employee ID + KPI value) with drill links', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', null);
    const html = renderContent({ level, kpi: 'overdue' });
    assert.ok(html.includes('Overdue'), 'the KPI is the heading');
    assert.ok(html.includes('Your team'), 'the top level belongs to the caller');
    assert.ok(html.includes('Tariq Lead') && html.includes('EMP-T1'), 'rows carry name + employee ID');
    assert.ok(html.includes('Tania Lead') && html.includes('EMP-T2'), 'both direct reports are listed');
    assert.ok(html.includes('3 overdue'), 'the KPI value rides on the row');
    assert.ok(html.includes('href="/team/kpi/overdue?person=EMP-T1"'), 'a name drills one level deeper');
    assert.ok(!html.includes('Mina Member'), 'grand-reports stay one level down');
  });

  it('a drilled people level renders the breadcrumb chain', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', 'EMP-T1');
    const html = renderContent({ level, kpi: 'overdue' });
    assert.ok(html.includes('Tariq Lead'), 'the current person heads the page');
    assert.ok(html.includes('Mina Member') && html.includes('Musa Member'), 'their team is listed');
    // Breadcrumb: Home > Overdue > Your team (caller) > Tariq Lead.
    // (The Home crumb carries an icon before its text, so match the
    // closing tag instead of the opening one.)
    const homeAt = html.indexOf('Home</a>');
    const overdueAt = html.indexOf('>Overdue<');
    assert.ok(homeAt >= 0 && overdueAt > homeAt, 'breadcrumb starts Home, then the KPI');
    assert.ok(html.includes('href="/team/kpi/overdue"'), 'the KPI crumb links back to the top level');
  });

  it('a leaf level renders lead rows with Lead360 links', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', 'EMP-M2');
    const leads: KpiLeadsResponse = {
      success: true,
      kpi: 'overdue',
      employeeId: 'EMP-M2',
      total: 2,
      items: [
        { id: 'lead-1', leadCode: 'LC-1', customerName: 'Karim Uddin', mobile: '01700000001', currentStatus: 'Interested', nextFollowUpAt: '2026-11-10T00:00:00.000Z' },
        { id: 'lead-2', leadCode: null, customerName: 'Rina Akter', mobile: '', currentStatus: 'Follow-up Set', nextFollowUpAt: null },
      ],
    };
    const html = renderContent({ level, kpi: 'overdue', leads });
    assert.ok(html.includes('Musa Member'), 'the leaf person heads the page');
    assert.ok(html.includes('Karim Uddin') && html.includes('Rina Akter'), 'their leads are listed');
    assert.ok(html.includes('href="/leads/lead-1"'), 'a lead row opens Lead360');
    assert.ok(html.includes('Interested'), 'status rides on the row');
    assert.ok(html.includes('10 Nov 2026'), 'the follow-up date renders in Dhaka');
    assert.ok(html.includes('No next action set'), 'a lead without a date says so plainly');
  });

  it('a truncated leaf list says how many are shown', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'open', 'EMP-M1');
    const leads: KpiLeadsResponse = {
      success: true,
      kpi: 'open',
      employeeId: 'EMP-M1',
      total: 250,
      items: [{ id: 'lead-1', leadCode: null, customerName: 'Only Shown', mobile: '', currentStatus: 'New', nextFollowUpAt: null }],
    };
    const html = renderContent({ level, kpi: 'open', leads });
    assert.ok(html.includes('Showing 1 of 250 leads'), 'the cap is stated, not silently applied');
  });

  it('not-found renders the panel, never a guessed level', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'open', 'EMP-SIB');
    const html = renderContent({ level, kpi: 'open' });
    assert.ok(html.includes('Person not found'), 'out-of-scope person -> not-found panel');
    assert.ok(html.includes('Team Home'), 'a way back is offered');
    const badKpi = renderContent({ level: { kind: 'invalid-kpi' }, kpi: null });
    assert.ok(badKpi.includes('Unknown KPI'), 'unknown KPI -> its own panel');
  });

  it('the Export button renders only with the grant', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'overdue', null);
    const withGrant = renderContent({ level, kpi: 'overdue', canExport: true });
    assert.ok(withGrant.includes('Export'), 'granted callers see the button');
    const withoutGrant = renderContent({ level, kpi: 'overdue', canExport: false });
    assert.ok(!withoutGrant.includes('Export'), 'ungranted callers see no button at all');
  });

  it('Team Home KPI cards link to the drill-down page', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamHomeContent, { people: treePeople, scope: 'Team' })
      )
    );
    for (const kpi of ['open', 'dueToday', 'overdue', 'converted']) {
      assert.ok(html.includes(`href="/team/kpi/${kpi}"`), `the ${kpi} card links to its drill-down`);
    }
  });
});

/* ================================================================ */
/* 6. Source guards                                                  */
/* ================================================================ */

describe('KPI drill-down — source guards', () => {
  it('HomeLanding and useCallerTeam run on callerSeesTeam, not the tree fact alone', () => {
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('callerSeesTeam(overview)'), 'the landing decision uses the sees-a-team rule');
    assert.ok(!landing.includes('callerHasTeam('), 'no tree-only check remains in the landing');
    const hook = read('src/modules/team/hooks/useCallerTeam.ts');
    assert.ok(hook.includes('hasTeam: callerSeesTeam(overview)'), 'the switch gating uses the same rule');
  });

  it('the drill-down route exists, gated, under the Team module', () => {
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/team/kpi/:kpi'"), 'the route is registered');
    assert.ok(app.includes('<FeatureGate route="/team/kpi/:kpi">'), 'the route passes through FeatureGate');
    assert.ok(app.includes("import('./modules/team/pages/TeamKpiDrilldown')"), 'the page is lazy-loaded');
    const access = read('src/layouts/featureRouteAccess.ts');
    assert.ok(access.includes("'/team/kpi/:kpi': { route: '/team/kpi/:kpi', path: '/team', roles: EVERYONE }"),
      'the route is in the access table as a Team sub-page, open to everyone (scoping is server-side)');
  });

  it('the Workbench strip links the caller\'s own leads for all four KPIs', () => {
    const workbench = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(workbench.includes('My numbers'), 'the strip is headed My numbers');
    for (const kpi of ['open', 'dueToday', 'overdue', 'converted']) {
      assert.ok(workbench.includes(`to="/team/kpi/${kpi}?person=self"`),
        `the ${kpi} strip card opens the caller's own leads`);
    }
    assert.ok(workbench.includes('getSelfPerson(callerTeam.overview'), 'the strip reads the already-loaded self row');
  });

  it('the server gates the export on leads.export and never imports the sibling branches', () => {
    const users = read('server/routes/production/users.routes.ts');
    assert.ok(users.includes("router.get('/team/kpi/leads'"), 'the leaf-leads endpoint exists');
    assert.ok(users.includes("router.get('/team/kpi/export', requireAuth, requirePermissionCode('leads.export')"),
      'the export endpoint is gated on the existing leads.export code');
    assert.ok(users.includes("actionCode: 'leads.export'"), 'exports are audit-logged as leads.export');
    assert.ok(!users.includes('LeadExportService'), 'FIX-2\'s service lives on another branch — never imported here');
    assert.ok(!users.includes('teamTree'), 'the sibling tree branch\'s builder is never imported here');
    const service = read('server/services/TeamKpiExportService.ts');
    assert.ok(service.includes("from 'exceljs'"), 'the workbook builder uses exceljs (server-side, outside the src-only guard)');
  });

  it('the drill-down page resolves levels from the overview payload, not a new server shape', () => {
    const page = read('src/modules/team/pages/TeamKpiDrilldown.tsx');
    assert.ok(page.includes('resolveKpiLevel(overview, kpiParam, personParam)'), 'levels come from the ONE overview payload');
    assert.ok(page.includes("canAccess('lead_tracking', 'export')"), 'the button follows the Leads-page permission pattern');
    const helper = read('src/modules/team/utils/kpiDrilldown.ts');
    assert.ok(!helper.includes('fetch(') && !helper.includes('apiRequest('),
      'the pure helpers never fetch — the hook owns the one request');
  });
});
