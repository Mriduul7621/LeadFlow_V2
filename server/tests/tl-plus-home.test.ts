/**
 * tl-plus-home.test.ts
 * ------------------------------------------------------------------
 * TL+ Home — team-first landing for anyone with subordinates
 * (owner-approved 2026-11-11: "hae etai better"). Same shell, same
 * routes: a caller WITH >= 1 report (Team Lead / Manager — the UM-1
 * derived fact, never a role label) lands on a team-first home
 * rendered in place at `/`; members keep the PR #96 My Day /
 * Workbench-first landing untouched. A Team/My-work switch persists
 * the user's choice for the session (same marker lifetime as PR #96).
 *
 * Sections:
 *   1. GET /api/team/overview — the `overdue` extension, against the
 *      PRODUCTION leads shape (current_status, NO bare status
 *      column): open lead with a past-due follow-up counts; terminal
 *      and deleted leads never do.
 *   2. resolveHomeLandingDecision — the pure landing decision:
 *      TL+ default team, My-work opt-out, leaf member unchanged.
 *      (KPI drill-down, 2026-11-13: HomeLanding now feeds this
 *      resolver callerSeesTeam — scope not 'Own' OR reports — so an
 *      Organization-scope admin with no reports gets the team home;
 *      the pure resolver itself is unchanged, and the admin case is
 *      pinned in tl-plus-home-kpi-drilldown.test.ts.)
 *   3. Home-view preference lifecycle (session cache, per user,
 *      reset on fresh login together with the landing marker).
 *   4. teamOverviewService shaping — callerHasTeam, totals,
 *      follow-ups-today ordering, stale-lead radar.
 *   5. Rendering — TeamHomeContent from an overview payload (SSR,
 *      repo style) and the HomeViewSwitch labels.
 *   6. Source guards — wiring (HomeLanding decides through the pure
 *      resolver + the shared overview loader; the Workbench shows
 *      the switch only to team holders; no new route exists).
 */
import { describe, it, before, beforeEach } from 'node:test';
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
  DASHBOARD_HOME_PATH,
  WORKBENCH_HOME_PATH,
} from '../../src/layouts/featureRouteAccess';
import {
  TEAM_HOME_PATH,
  consumeHomeLanding,
  getHomeViewPreference,
  hasConsumedHomeLanding,
  homeViewKey,
  resetHomeLanding,
  resolveHomeLandingDecision,
  setHomeViewPreference,
} from '../../src/modules/auth/services/homeLanding';
import { resetSessionCacheForTests } from '../../src/modules/shared/api/sessionCache';
import {
  callerHasTeam,
  staleLeadRadar,
  summarizeTeamTotals,
  teamFollowUpsToday,
  type TeamOverviewPerson,
} from '../../src/modules/team/services/teamOverviewService';
import { TeamHomeContent } from '../../src/modules/team/pages/TeamHome';
import HomeViewSwitch from '../../src/modules/team/components/HomeViewSwitch';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const JWT_SECRET = ['tlhome', '-test', '-secret'].join('');

/* ================================================================ */
/* 1. /api/team/overview — overdue against the production shape      */
/* ================================================================ */

describe('TL+ Home — GET /api/team/overview overdue counts (production leads shape)', () => {
  let pool: any;
  let app: express.Express;
  let headToken: string;
  let memToken: string;

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
    // PRODUCTION shape: current_status, next_follow_up_at, is_deleted
    // — and deliberately NO bare `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_name VARCHAR(255),
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
    const leadRole = await mkRole('UM', 5, 'Own');
    const memRole = await mkRole('RO', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('THEAD', headRole, null);
    const lead = await mkUser('TLEAD', leadRole, head.id);
    const mem = await mkUser('TMEM', memRole, lead.id);
    headToken = jwt.sign({ ...head, role: 'BH' }, JWT_SECRET, { expiresIn: '1h' });
    memToken = jwt.sign({ ...mem, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });

    const bounds = getDhakaBusinessDayBounds(new Date());
    const dueToday = new Date(new Date(bounds.todayStartIso).getTime() + 2 * 3600_000).toISOString();
    const overdueAt = new Date(new Date(bounds.todayStartIso).getTime() - 26 * 3600_000).toISOString();
    const mkLead = async (assignedTo: string, status: string, nextFollowUpAt: string | null, deleted = false) => {
      await pool.query(
        `INSERT INTO leads (customer_name, current_status, assigned_to, created_by, next_follow_up_at, is_deleted) VALUES ('C', $1, $2, $2, $3, $4)`,
        [status, assignedTo, nextFollowUpAt, deleted]
      );
    };
    await mkLead('TMEM', 'Interested', overdueAt);            // open + overdue -> overdue 1
    await mkLead('TMEM', 'Follow-up Set', overdueAt);         // open + overdue -> overdue 2
    await mkLead('TMEM', 'Not Interested', overdueAt);        // terminal -> never overdue
    await mkLead('TMEM', 'Converted', overdueAt);             // terminal -> never overdue
    await mkLead('TMEM', 'Interested', overdueAt, true);      // deleted -> invisible
    await mkLead('TMEM', 'Interested', dueToday);             // open + due today (not overdue)
    await mkLead('TMEM', 'Interested', null);                 // open, no follow-up date
    await mkLead('TLEAD', 'New', overdueAt);                  // the lead's own overdue lead

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  it('counts overdue as open leads whose follow-up is before today (Dhaka)', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${headToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byEmp = new Map((res.body.people as any[]).map(p => [p.employeeId, p]));
    const mem = byEmp.get('TMEM');
    assert.ok(mem, 'member listed for the head');
    assert.equal(mem.overdue, 2, 'two open past-due leads; terminal + deleted + due-today excluded');
    assert.equal(mem.openLeads, 4, 'open count unchanged by the overdue extension');
    assert.equal(mem.dueToday, 1);
    assert.equal(mem.convertedLeads, 1);
    const lead = byEmp.get('TLEAD');
    assert.equal(lead.overdue, 1);
    // The team-lead fact the landing decision consumes:
    assert.ok(lead.directReports >= 1, 'the lead has a report -> TL+ landing applies');
    const headRow = byEmp.get('THEAD');
    assert.ok(headRow.directReports >= 1, 'the head has reports -> TL+ landing applies');
  });

  it('a leaf member sees only themself, with zero reports (member landing fact)', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${memToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.people.length, 1, 'Own scope: only the caller');
    const self = res.body.people[0];
    assert.equal(self.employeeId, 'TMEM');
    assert.equal(self.isSelf, true);
    assert.equal(self.directReports, 0, "no reports, Own scope -> callerSeesTeam is false -> member landing");
    assert.equal(self.overdue, 2, 'own overdue still reported for the member themself');
  });
});

/* ================================================================ */
/* 2. resolveHomeLandingDecision — the pure landing decision         */
/* ================================================================ */

describe('resolveHomeLandingDecision — TL+ landing decision', () => {
  it('a caller with a team lands on the team home by default', () => {
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: true, preference: null, memberHomePath: WORKBENCH_HOME_PATH }),
      TEAM_HOME_PATH
    );
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: true, preference: 'team', memberHomePath: WORKBENCH_HOME_PATH }),
      TEAM_HOME_PATH
    );
    // Even when the member decision would have been the Dashboard
    // (Workbench hidden for the role): the team home lives at `/`
    // under the same gate, so it is the TL+ default either way.
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: true, preference: null, memberHomePath: DASHBOARD_HOME_PATH }),
      TEAM_HOME_PATH
    );
  });

  it('the My-work toggle opts a team holder out for the session', () => {
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: true, preference: 'work', memberHomePath: WORKBENCH_HOME_PATH }),
      WORKBENCH_HOME_PATH,
      'preference work -> the member decision (Workbench) applies'
    );
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: true, preference: 'work', memberHomePath: DASHBOARD_HOME_PATH }),
      DASHBOARD_HOME_PATH
    );
  });

  it('a leaf member keeps the member landing in every preference state', () => {
    for (const preference of [null, 'team', 'work'] as const) {
      assert.equal(
        resolveHomeLandingDecision({ hasTeam: false, preference, memberHomePath: WORKBENCH_HOME_PATH }),
        WORKBENCH_HOME_PATH,
        `leaf member, preference=${preference} -> Workbench (PR #96 unchanged)`
      );
    }
  });

  it('hasTeam=false still maps to the member landing (the resolver is unchanged)', () => {
    // KPI drill-down (2026-11-13): what changed is what FEEDS this
    // resolver, not the resolver itself. HomeLanding used to feed it
    // callerHasTeam (the tree fact only), so an Organization-scope
    // admin with no reports landed as a member. It now feeds
    // callerSeesTeam (scope not 'Own' OR reports), so that admin
    // gets the team home — pinned in
    // tl-plus-home-kpi-drilldown.test.ts. The pure rule below still
    // holds: a caller who sees NOBODY (a leaf member) keeps the
    // member landing in every preference state.
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: false, preference: null, memberHomePath: WORKBENCH_HOME_PATH }),
      WORKBENCH_HOME_PATH
    );
    assert.equal(
      resolveHomeLandingDecision({ hasTeam: false, preference: 'team', memberHomePath: WORKBENCH_HOME_PATH }),
      WORKBENCH_HOME_PATH,
      'even a stale Team preference cannot conjure a team home for a caller who sees nobody'
    );
  });
});

/* ================================================================ */
/* 3. Home-view preference — session lifecycle                       */
/* ================================================================ */

describe('home view preference — session persistence of the Team/My-work toggle', () => {
  beforeEach(() => resetSessionCacheForTests());

  it('starts unset, records the toggle, and is keyed per user', () => {
    assert.equal(getHomeViewPreference('user-1'), null);
    setHomeViewPreference('user-1', 'work');
    assert.equal(getHomeViewPreference('user-1'), 'work');
    setHomeViewPreference('user-1', 'team');
    assert.equal(getHomeViewPreference('user-1'), 'team', 'the latest toggle wins');
    assert.equal(getHomeViewPreference('user-2'), null, 'one user\'s choice never leaks to another');
    assert.notEqual(homeViewKey('user-1'), homeViewKey('user-2'));
  });

  it('a fresh login forgets the choice together with the landing marker', () => {
    consumeHomeLanding('user-1');
    setHomeViewPreference('user-1', 'work');
    resetHomeLanding('user-1');
    assert.equal(hasConsumedHomeLanding('user-1'), false, 'landing re-arms');
    assert.equal(getHomeViewPreference('user-1'), null, 'the TL+ default decides again, not a stale toggle');
  });
});

/* ================================================================ */
/* 4. teamOverviewService shaping                                    */
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
  totalLeads: 0,
  todayLeads: 0,
  noActionLeads: 0,
  isSelf: false,
  ...over,
});

const fixturePeople: TeamOverviewPerson[] = [
  person({ userId: 'u-self', employeeId: 'EMP-001', name: 'Lena Lead', isSelf: true, directReports: 2, tier: 'teamLead', openLeads: 3, dueToday: 1, overdue: 1, convertedLeads: 2, totalLeads: 8, todayLeads: 1, noActionLeads: 0 }),
  person({ userId: 'u-a', employeeId: 'EMP-002', name: 'Arif Member', openLeads: 9, dueToday: 2, overdue: 5, convertedLeads: 4, totalLeads: 15, todayLeads: 2, noActionLeads: 2 }),
  person({ userId: 'u-b', employeeId: 'EMP-003', name: 'Bina Member', openLeads: 4, dueToday: 0, overdue: 5, convertedLeads: 1, totalLeads: 9, todayLeads: 0, noActionLeads: 1 }),
  person({ userId: 'u-c', employeeId: 'EMP-004', name: 'Chad Member', openLeads: 2, dueToday: 3, overdue: 0, convertedLeads: 0, totalLeads: 5, todayLeads: 1, noActionLeads: 0 }),
  person({ userId: 'u-d', employeeId: 'EMP-005', name: 'Dina Member', openLeads: 1, dueToday: 0, overdue: 0, convertedLeads: 6, totalLeads: 7, todayLeads: 0, noActionLeads: 0 }),
];

describe('teamOverviewService — team facts and shaping', () => {
  it('callerHasTeam is the self row\'s directReports — nothing else', () => {
    assert.equal(callerHasTeam(fixturePeople), true, 'self has 2 reports');
    assert.equal(callerHasTeam([person({ isSelf: true, directReports: 0 })]), false, 'leaf self');
    assert.equal(callerHasTeam([person({ directReports: 3 })]), false, 'no self row -> no team claim');
    assert.equal(callerHasTeam([]), false);
    assert.equal(callerHasTeam(null), false);
    assert.equal(callerHasTeam(undefined), false);
  });

  it('summarizeTeamTotals sums the whole team', () => {
    assert.deepEqual(summarizeTeamTotals(fixturePeople), { open: 19, dueToday: 6, overdue: 11, converted: 13, totalLeads: 44, todayCollection: 4, noAction: 3 });
    assert.deepEqual(summarizeTeamTotals([]), { open: 0, dueToday: 0, overdue: 0, converted: 0, totalLeads: 0, todayCollection: 0, noAction: 0 });
  });

  it('teamFollowUpsToday lists only members with due/overdue work, worst first', () => {
    const rows = teamFollowUpsToday(fixturePeople);
    assert.deepEqual(rows.map(p => p.employeeId), ['EMP-002', 'EMP-003', 'EMP-001', 'EMP-004'],
      'overdue desc, then due-today desc; the idle member is absent');
  });

  it('staleLeadRadar ranks the most overdue and caps the list', () => {
    const rows = staleLeadRadar(fixturePeople);
    assert.deepEqual(rows.map(p => p.employeeId), ['EMP-002', 'EMP-003', 'EMP-001'],
      'overdue desc; the 5-overdue tie breaks on open leads (9 before 4)');
    assert.equal(staleLeadRadar(fixturePeople, 2).length, 2, 'limit honoured');
    assert.deepEqual(staleLeadRadar([person({ overdue: 0 })]), [], 'nobody overdue -> empty radar');
  });
});

/* ================================================================ */
/* 5. Rendering (SSR, repo style)                                    */
/* ================================================================ */

describe('TeamHome — rendering from the overview payload', () => {
  it('renders totals, member rows (name + employee ID) and the radar', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamHomeContent, { people: fixturePeople, scope: 'Team' })
      )
    );
    assert.ok(html.includes('Team Home'), 'team-first heading');
    assert.ok(html.includes('Open leads') && html.includes('Due today') && html.includes('Overdue') && html.includes('Converted')
      && html.includes('Total Lead') && html.includes('Today Lead Collection') && html.includes('No Action Alert'),
      'the seven team totals are labelled');
    assert.ok(html.includes('>19<') && html.includes('>11<'), 'totals are summed over the whole team (19 open, 11 overdue)');
    assert.ok(html.includes('Team follow-ups today'), 'follow-ups section present');
    assert.ok(html.includes('Arif Member') && html.includes('EMP-002'), 'member rows carry name + employee ID');
    assert.ok(html.includes('href="/team"'), 'member rows link through to My Team');
    assert.ok(html.includes('Stale-lead radar'), 'radar section present');
    assert.ok(!html.includes('Dina Member'), 'a member with nothing due/overdue appears in neither list');
    const followUpOrder = ['Arif Member', 'Bina Member', 'Lena Lead', 'Chad Member'].map(n => html.indexOf(n));
    assert.ok(followUpOrder.every((v, i) => v >= 0 && (i === 0 || followUpOrder[i - 1] < v)),
      'follow-up rows render worst-first');
  });

  it('renders the all-clear states when nothing is due or overdue', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamHomeContent, {
          people: [person({ isSelf: true, directReports: 1, name: 'Solo Lead', employeeId: 'EMP-100' })],
          scope: 'Team',
        })
      )
    );
    assert.ok(html.includes('Nothing due today'), 'follow-ups all-clear');
    assert.ok(html.includes('No overdue follow-ups'), 'radar all-clear');
  });

  it('the switch offers Team and My work', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(HomeViewSwitch, { active: 'work' })
      )
    );
    assert.ok(html.includes('Team') && html.includes('My work'), 'both sides of the toggle are labelled');
  });
});

/* ================================================================ */
/* 6. Source guards                                                  */
/* ================================================================ */

describe('TL+ Home — source guards', () => {
  it('HomeLanding decides through the pure resolver and the shared overview loader', () => {
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('resolveHomeLandingDecision({'), 'landing decision goes through the pure TL+ resolver');
    assert.ok(landing.includes('loadTeamOverview(userId)'), 'team fact comes from the ONE overview data path');
    assert.ok(landing.includes("setHomeViewPreference(userId, 'team')"), 'a team landing pins the session Team preference');
    assert.ok(landing.includes('decision === TEAM_HOME_PATH'), 'the team decision renders the team home in place');
    assert.ok(!landing.includes("to={TEAM_HOME_PATH}"), 'the team home is NOT a redirect target — TEAM_HOME_PATH is a decision token, not a route');
  });

  it('no team-home route exists; the root composition is unchanged', () => {
    const app = read('src/App.tsx');
    assert.ok(!app.includes("path: '/team-home'"), 'no new route was invented for the team home');
    assert.ok(
      app.includes('<HomeLanding><LazyPage page={<Dashboard />} /></HomeLanding>'),
      'the root still wraps the unchanged Dashboard in HomeLanding'
    );
  });

  it('the Workbench shows the switch only to callers with a team; the My Team page is untouched by this feature', () => {
    const workbench = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(workbench.includes('callerTeam.hasTeam && <HomeViewSwitch active="work" />'),
      'the Team toggle on My Day is gated on having a team');
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes("import('../../team/pages/TeamHome')"), 'the team home is the landing\'s lazy TeamHome page');
  });

  it('the server extension is one field on the existing endpoint, in both data paths', () => {
    const users = read('server/routes/production/users.routes.ts');
    assert.ok(users.includes('overdue_count'), 'DB path computes overdue in the same counts query');
    assert.ok(users.includes('overdue: c.overdue_count || 0'), 'DB person rows carry overdue');
    assert.ok(users.includes('overdue,'), 'demo person rows carry overdue');
  });
});
