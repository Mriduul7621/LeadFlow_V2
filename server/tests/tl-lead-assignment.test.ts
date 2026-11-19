/**
 * tl-lead-assignment.test.ts — Team Lead lead assignment + Follow-up label fix (2026-11-19)
 * ------------------------------------------------------------------
 * Mahadi's rules (2026-11-19 23:20):
 *   - The two follow-up labels were effectively swapped vs their
 *     pages: /workbench IS the Daily Workbench, /follow-up IS the
 *     Follow-up Queue. The labels were renamed to match the pages;
 *     NO data moved between them.
 *   - A Team Lead may upload leads (Lead Intake) and add leads, and
 *     may reassign ANY lead in their team scope — their own or any
 *     subordinate's (A → B allowed) — to ANYONE in their full
 *     downline (the whole subtree, not just direct reports).
 *
 * Pure guards: label mapping per role, exactly-one-active, the
 * upload route predicate, the downline helper. Integration guards
 * (demo mode, fallbackStore): the server reassign rule and the
 * aligned bulk-import gate.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import productionRoutes from '../routes/production.routes.js';
import { fallbackStore, createId } from '../fallbackStore.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import {
  buildEnterpriseNavGroups,
  buildEnterpriseBottomNavTabs,
  enterpriseActivePath,
  enterpriseHeadingForPath,
  ENTERPRISE_PAGE_DESCRIPTIONS,
} from '../../src/layouts/enterpriseNav.js';
import {
  canResolveRouteAccess,
  FEATURE_ROUTES,
  resolveFeatureRouteAccess,
} from '../../src/layouts/featureRouteAccess.js';
import {
  downlineOf,
  type TeamOverviewPerson,
} from '../../src/modules/team/services/teamOverviewService.js';
import type { EnterpriseRole } from '../../src/layouts/enterpriseRole.js';

const ROLES: EnterpriseRole[] = ['admin', 'manager', 'teamLead', 'agent'];
const allowAll = { canOpen: () => true, canAccess: () => true };

function labelsFor(role: EnterpriseRole): Array<{ label: string; path: string }> {
  return buildEnterpriseNavGroups({ role, ...allowAll }).flatMap(g => g.items);
}

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', productionRoutes);
  return app;
}

function resetStores() {
  fallbackStore.users = [];
  fallbackStore.leads = [];
  fallbackStore.notifications = [];
  (fallbackStore as any).departments = [];
  (fallbackStore as any).teams = [];
}

function makeUser(overrides: any = {}) {
  const id = overrides.id || createId('user');
  const employeeId = overrides.employeeId || `EMP${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return {
    id,
    employeeId,
    fullName: overrides.fullName || `User ${employeeId}`,
    name: overrides.fullName || `User ${employeeId}`,
    email: overrides.email || `${employeeId.toLowerCase()}@test.com`,
    role: overrides.role || 'EMPLOYEE',
    roleCode: overrides.role || 'EMPLOYEE',
    status: 'Active' as const,
    accountStatus: 'ACTIVE',
    isActive: true,
    designation: overrides.designation || 'Officer',
    departmentId: overrides.departmentId || 'dept-1',
    teamId: '',
    managerId: overrides.managerId || '',
    reportingManagerId: overrides.managerId || '',
    avatarUrl: '',
    createdDate: new Date().toISOString(),
    password: 'x',
    mustChangePassword: false,
    reportingChain: [],
    subordinates: [],
    ...overrides,
  };
}

function tokenFor(user: any) {
  return signToken({
    id: user.id,
    employeeId: user.employeeId,
    role: user.role,
    email: user.email,
    name: user.fullName,
  });
}

/** GET /api/leads returns a bare array (the .data arm is the other callers' shape). */
function listRows(res: any): any[] {
  return Array.isArray(res.body) ? res.body : res.body.data || [];
}

/** TL001 → EMPA + EMPB; EMPA → EMPC (grand-report). OUT1, AGENT1 and MGR9 are outside the tree. */
function seedTeam() {
  const tl = makeUser({ employeeId: 'TL001', role: 'TEAM_LEAD' });
  const subA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE', managerId: tl.employeeId });
  const subB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE', managerId: tl.employeeId });
  const subC = makeUser({ employeeId: 'EMPC', role: 'EMPLOYEE', managerId: subA.employeeId });
  const outsider = makeUser({ employeeId: 'OUT1', role: 'EMPLOYEE' });
  const agent = makeUser({ employeeId: 'AGENT1', role: 'EMPLOYEE' });
  const loneManager = makeUser({ employeeId: 'MGR9', role: 'MANAGER' });
  const admin = makeUser({ employeeId: 'ADMIN1', role: 'ADMIN' });
  fallbackStore.users.push(tl, subA, subB, subC, outsider, agent, loneManager, admin);
  return { tl, subA, subB, subC, outsider, agent, loneManager, admin };
}

describe('Follow-up labels match their pages (2026-11-19, navs rebuilt 2026-11-20)', () => {
  it('/follow-up is "Follow-up Monitor" for TL/Manager/Admin and "Follow-up Queue" for the Agent', () => {
    // Team Lead / Manager / Admin workspace (2026-11-20, Mahadi's
    // demo screenshot 3): the sidebar label is "Follow-up
    // Monitor" for the three lead roles; the Agent keeps
    // "Follow-up Queue" (his demo). The PAGE heading stays
    // "Follow-up Queue" for every role — the demo's H1 (see the
    // heading test below).
    for (const role of ['admin', 'manager', 'teamLead'] as EnterpriseRole[]) {
      const followUp = labelsFor(role).find(i => i.path === '/follow-up');
      assert.ok(followUp, `${role} nav must include /follow-up`);
      assert.equal(followUp!.label, 'Follow-up Monitor', `${role} must label /follow-up Follow-up Monitor`);
    }
    const agentFollowUp = labelsFor('agent').find(i => i.path === '/follow-up');
    assert.ok(agentFollowUp, 'agent nav must include /follow-up');
    assert.equal(agentFollowUp!.label, 'Follow-up Queue', 'agent must label /follow-up Follow-up Queue');
  });

  it('NO role nav carries /workbench anymore (Daily Workbench left every sidebar 2026-11-20)', () => {
    // The route stays live by URL and the heading still resolves
    // through the fallback map — only the sidebar entry is gone.
    for (const role of ROLES) {
      const workbench = labelsFor(role).find(i => i.path === '/workbench');
      assert.equal(workbench, undefined, `${role} has no workbench entry`);
    }
    assert.equal(
      enterpriseHeadingForPath('agent', '/workbench').title,
      'Daily Workbench',
      'the /workbench heading still resolves through the fallback map',
    );
  });

  it('no role nav carries the retired "Follow-up Strategy" label', () => {
    for (const role of ROLES) {
      const labels = labelsFor(role).map(i => i.label);
      assert.ok(!labels.includes('Follow-up Strategy'), `${role} nav must not carry Follow-up Strategy`);
    }
  });

  it('both labels have descriptions (no empty page subtitle)', () => {
    assert.ok(ENTERPRISE_PAGE_DESCRIPTIONS['Daily Workbench'], 'Daily Workbench needs a description');
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Follow-up Queue'],
      'Prioritize overdue and upcoming follow-ups.',
      'Follow-up Queue keeps the sample description verbatim'
    );
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Follow-up Monitor'],
      'Prioritize overdue and upcoming follow-ups.',
      'Follow-up Monitor shares the queue description'
    );
    assert.equal(ENTERPRISE_PAGE_DESCRIPTIONS['Follow-up Strategy'], undefined, 'the retired label has no description');
  });

  it('page headings follow the demo: /follow-up is "Follow-up Queue" for every role', () => {
    // Mahadi asked to follow the demo exactly: the sidebar label
    // is "Follow-up Monitor" for TL/Manager/Admin, but the page's
    // own H1 is "Follow-up Queue" (the demo's H1). Sidebar and H1
    // deliberately differ here — flagged in the PR report.
    for (const role of ROLES) {
      assert.deepEqual(enterpriseHeadingForPath(role, '/follow-up'), {
        title: 'Follow-up Queue',
        sub: 'Prioritize overdue and upcoming follow-ups.',
      });
    }
    assert.deepEqual(enterpriseHeadingForPath('agent', '/workbench'), {
      title: 'Daily Workbench',
      sub: ENTERPRISE_PAGE_DESCRIPTIONS['Daily Workbench'],
    });
  });

  it('exactly one nav item is active on each queue page', () => {
    for (const role of ROLES) {
      const groups = buildEnterpriseNavGroups({ role, ...allowAll });
      // No two items share a path within one role's nav.
      const paths = groups.flatMap(g => g.items.map(i => i.path));
      assert.equal(new Set(paths).size, paths.length, `${role} nav must not duplicate a path`);
      assert.equal(enterpriseActivePath(groups, '/follow-up'), '/follow-up');
      // No role has a /workbench nav item anymore, so nothing is
      // active there (null) — the page itself stays reachable by URL.
      assert.equal(enterpriseActivePath(groups, '/workbench'), null);
    }
  });

  it('the mobile bottom bar shortens Daily Workbench to "Workbench" (agent only now)', () => {
    // Team Lead / Manager / Admin bottom tabs (2026-11-20) dropped
    // Workbench; only the agent's bar still carries it.
    const agentTabs = buildEnterpriseBottomNavTabs({ role: 'agent', ...allowAll });
    const tab = agentTabs.find(t => t.path === '/workbench');
    assert.ok(tab, 'agent bottom nav must carry /workbench');
    assert.equal(tab!.label, 'Workbench', 'agent bottom tab uses the short form');
    for (const role of ['admin', 'manager', 'teamLead'] as EnterpriseRole[]) {
      const tabs = buildEnterpriseBottomNavTabs({ role, ...allowAll });
      assert.equal(tabs.find(t => t.path === '/workbench'), undefined, `${role} bottom nav has no Workbench tab`);
    }
  });
});

describe('Lead Intake route predicate — ADMIN or ≥1 subordinate', () => {
  it('the registry pins teamLeadAllowed + managerAllowed on /leads/upload and /users/team (and nowhere else)', () => {
    // Team Lead / Manager / Admin workspace (2026-11-20): User
    // Management carries the same two predicates as Lead Intake.
    for (const route of ['/leads/upload', '/users/team']) {
      assert.equal(FEATURE_ROUTES[route].teamLeadAllowed, true, `${route} carries teamLeadAllowed`);
      assert.equal(FEATURE_ROUTES[route].managerAllowed, true, `${route} carries managerAllowed`);
    }
    for (const [key, entry] of Object.entries(FEATURE_ROUTES)) {
      if (key !== '/leads/upload' && key !== '/users/team') {
        assert.equal(entry.teamLeadAllowed, undefined, `${key} must not carry teamLeadAllowed`);
        assert.equal(entry.managerAllowed, undefined, `${key} must not carry managerAllowed`);
      }
    }
  });

  it('a team lead (≥1 subordinate) opens Lead Intake; a plain Agent does not', () => {
    assert.equal(
      resolveFeatureRouteAccess('/leads/upload', 'EMPLOYEE', undefined, { hasSubordinates: true }),
      true,
      'has-subordinate opens the upload page'
    );
    assert.equal(
      resolveFeatureRouteAccess('/leads/upload', 'EMPLOYEE', undefined, { hasSubordinates: false }),
      false,
      'a plain agent stays blocked'
    );
  });

  it('without the tree fact the static ADMIN_ONLY fallback decides (no-context callers unchanged)', () => {
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'EMPLOYEE', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'TEAM_LEAD', undefined), false, 'a TEAM_LEAD code alone is not the tree fact');
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'ADMIN', undefined), true, 'ADMIN bypass needs no context');
  });

  it('an explicit menuAccess entry wins over the predicate (admin control preserved)', () => {
    // Explicit false hides the page from a team lead.
    assert.equal(
      resolveFeatureRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: { '/leads/upload': false } } as any, { hasSubordinates: true }),
      false,
      'explicit false beats the predicate'
    );
    // Explicit true opens it for a plain agent.
    assert.equal(
      resolveFeatureRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: { '/leads/upload': true } } as any, { hasSubordinates: false }),
      true,
      'explicit true beats the missing tree fact'
    );
  });

  it('canResolveRouteAccess waits for the team fact only when it decides the answer', () => {
    // No explicit entry + team still loading => not decidable yet.
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: {} } as any, { teamSettled: false }),
      false,
      'the predicate route waits for the team overview'
    );
    // Team settled + matrix present => decidable.
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: {} } as any, { teamSettled: true }),
      true
    );
    // An explicit entry decides without the team fact.
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: { '/leads/upload': false } } as any, { teamSettled: false }),
      true,
      'an explicit entry never waits on the team'
    );
    // Callers that omit the context keep the old matrix-only behaviour.
    assert.equal(canResolveRouteAccess('/leads/upload', 'EMPLOYEE', undefined), false, 'no matrix yet => wait');
    assert.equal(canResolveRouteAccess('/leads/upload', 'EMPLOYEE', { menuAccess: {} } as any), true);
    // Non-predicate routes never wait on the team.
    assert.equal(
      canResolveRouteAccess('/leads/all', 'EMPLOYEE', { menuAccess: {} } as any, { teamSettled: false }),
      true
    );
  });
});

describe('downlineOf — the full reporting subtree', () => {
  const person = (employeeId: string, managerEmployeeId: string | null, directReports = 0): TeamOverviewPerson => ({
    userId: `u-${employeeId}`,
    employeeId,
    name: `Person ${employeeId}`,
    designation: null,
    roleName: null,
    department: null,
    managerEmployeeId,
    managerName: null,
    tier: 'teamMember',
    directReports,
    openLeads: 0,
    convertedLeads: 0,
    dueToday: 0,
    overdue: 0,
    totalLeads: 0,
    todayLeads: 0,
    noActionLeads: 0,
    isSelf: employeeId === 'TL001',
  });

  const people: TeamOverviewPerson[] = [
    person('TL001', 'CEO1', 2),
    person('EMPA', 'TL001', 1),
    person('EMPB', 'TL001'),
    person('EMPC', 'EMPA'),
    person('OUT1', 'CEO1'),
  ];

  it('returns the whole subtree — direct reports and grand-reports — never the caller or outsiders', () => {
    const ids = downlineOf(people, 'TL001').map(p => p.employeeId).sort();
    assert.deepEqual(ids, ['EMPA', 'EMPB', 'EMPC']);
  });

  it('a middle manager sees only their own subtree', () => {
    assert.deepEqual(downlineOf(people, 'EMPA').map(p => p.employeeId), ['EMPC']);
    assert.deepEqual(downlineOf(people, 'EMPB'), [], 'a leaf has no downline');
  });

  it('matches employee ids case-insensitively', () => {
    const ids = downlineOf(people, 'tl001').map(p => p.employeeId).sort();
    assert.deepEqual(ids, ['EMPA', 'EMPB', 'EMPC']);
  });

  it('is cycle-safe and empty-safe', () => {
    const cyclic: TeamOverviewPerson[] = [
      person('A', 'B'),
      person('B', 'A'),
      person('C', 'A'),
    ];
    assert.deepEqual(downlineOf(cyclic, 'A').map(p => p.employeeId).sort(), ['B', 'C']);
    assert.deepEqual(downlineOf(null, 'TL001'), []);
    assert.deepEqual(downlineOf(people, null), []);
    assert.deepEqual(downlineOf([], 'TL001'), []);
  });
});

describe('Team Lead reassign — server rule (demo mode)', () => {
  let app: express.Express;

  beforeEach(() => {
    resetStores();
    app = createTestApp();
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
  });

  async function createLeadAs(user: any, mobile: string, extra: Record<string, any> = {}) {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ customerName: `Prospect ${mobile}`, mobile, ...extra });
    assert.equal(res.status, 200, `create should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function reassignAs(user: any, leadId: string, mobile: string, assignedTo: string) {
    return request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ id: leadId, customerName: `Prospect ${mobile}`, mobile, assignedTo });
  }

  function storedLead(id: string) {
    return fallbackStore.leads.find((l: any) => l.id === id);
  }

  it('TL reassigns their own lead to a direct report — 200, history recorded, ownership moves', async () => {
    const { tl, subA, subB } = seedTeam();
    const lead = await createLeadAs(tl, '01700000101');

    const res = await reassignAs(tl, lead.id, '01700000101', 'EMPA');
    assert.equal(res.status, 200, `TL reassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);

    const stored = storedLead(lead.id);
    assert.equal(stored.assignedTo, 'EMPA', 'the lead now belongs to EMPA');
    const history = Array.isArray(stored.assignmentHistory) ? stored.assignmentHistory : [];
    assert.ok(
      history.some((h: any) => h.note === 'Reassigned via API' && h.toEmployeeId === 'EMPA'),
      'the move is recorded in the assignment history'
    );

    // The new owner sees it; a sibling who never owned it does not.
    const asSubA = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(subA)}`);
    assert.ok(listRows(asSubA).some((l: any) => l.id === lead.id), 'EMPA sees the reassigned lead');
    const asSubB = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(subB)}`);
    assert.ok(!listRows(asSubB).some((l: any) => l.id === lead.id), 'EMPB must not see a lead owned by EMPA');
    // The TL still sees it via team scope.
    const asTl = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(tl)}`);
    assert.ok(listRows(asTl).some((l: any) => l.id === lead.id), 'the TL still sees the lead via team scope');
  });

  it('A → B: the TL reassigns a subordinate\u2019s lead to another subordinate', async () => {
    const { tl, subA } = seedTeam();
    const lead = await createLeadAs(subA, '01700000102');
    assert.equal(storedLead(lead.id).assignedTo, 'EMPA', 'the lead starts with EMPA');

    const res = await reassignAs(tl, lead.id, '01700000102', 'EMPB');
    assert.equal(res.status, 200, `A → B reassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'EMPB');
  });

  it('TL reassigns to a grand-report (full downline, not just direct reports)', async () => {
    const { tl, subA } = seedTeam();
    const lead = await createLeadAs(subA, '01700000103');

    const res = await reassignAs(tl, lead.id, '01700000103', 'EMPC');
    assert.equal(res.status, 200, `reassign to a grand-report should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'EMPC');
  });

  it('TL cannot reassign to someone outside the subtree — 403, lead unchanged', async () => {
    const { tl, subA } = seedTeam();
    const lead = await createLeadAs(subA, '01700000104');

    const res = await reassignAs(tl, lead.id, '01700000104', 'OUT1');
    assert.equal(res.status, 403, `outside-subtree reassign should be 403, got ${res.status}`);
    assert.equal(storedLead(lead.id).assignedTo, 'EMPA', 'the lead must stay with EMPA');
  });

  it('a plain agent cannot reassign or unassign — the tree check blocks them (not just the UI)', async () => {
    const { agent } = seedTeam();
    const lead = await createLeadAs(agent, '01700000105');
    // Unassigning isolates the tree check: the scope check allows a
    // null target and demo mode grants leads.assign to everyone, so
    // only the has-subordinate rule can refuse this.
    const res = await reassignAs(agent, lead.id, '01700000105', '');
    assert.equal(res.status, 403, `agent unassign should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'AGENT1', 'the lead must stay with the agent');
  });

  it('a no-reports MANAGER CAN unassign — Manager scope (FullTeam) counts as team scope now', async () => {
    // Team Lead / Manager / Admin workspace (2026-11-20, Mahadi):
    // reassign belongs to Team Lead AND Manager. The 2026-11-19
    // rule asked only "does the caller have a subtree?" and
    // refused a no-reports Manager; the new rule counts Manager
    // scope (FullTeam / Organization) as team scope. Unassigning
    // isolates the team-scope arm: the scope check allows a null
    // target, so only the has-team rule can refuse this — and it
    // no longer does for a Manager.
    const { loneManager } = seedTeam();
    const lead = await createLeadAs(loneManager, '01700000106');
    const res = await reassignAs(loneManager, lead.id, '01700000106', '');
    assert.equal(res.status, 200, `no-reports manager unassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, '', 'the lead is unassigned');
  });

  it('a no-reports MANAGER cannot reassign OUTSIDE their visibility — the scope check binds them', async () => {
    // Manager-scope callers skip the subtree check, but the
    // visibility check (isAssignedToAllowed) still bounds them:
    // a no-reports Manager's demo visibility is self-only, so
    // OUT1 is out of scope. (In DB mode the FullTeam arm is the
    // whole department — the same check, a wider set.)
    const { loneManager } = seedTeam();
    const lead = await createLeadAs(loneManager, '01700000106');
    const res = await reassignAs(loneManager, lead.id, '01700000106', 'OUT1');
    assert.equal(res.status, 403, `out-of-scope manager reassign should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'MGR9', 'the lead must stay with the manager');
  });

  it('a Manager WITH a downline reassigns inside their subtree — 200', async () => {
    const { subA } = seedTeam();
    // Give the TL's subtree to a Manager: MGR9 manages EMPA.
    const mgr = fallbackStore.users.find((u: any) => u.employeeId === 'MGR9');
    const empA = fallbackStore.users.find((u: any) => u.employeeId === 'EMPA');
    empA.managerId = 'MGR9';
    empA.reportingManagerId = 'MGR9';
    const lead = await createLeadAs(subA, '01700000110');
    assert.equal(storedLead(lead.id).assignedTo, 'EMPA');

    // The manager reassigns EMPA's lead to EMPC (EMPA's report —
    // inside the manager's subtree, and inside their visibility).
    const res = await reassignAs(mgr, lead.id, '01700000110', 'EMPC');
    assert.equal(res.status, 200, `in-scope manager reassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'EMPC');
  });

  it('a no-reports TEAM_LEAD still cannot reassign — DownTeam is not Manager scope', async () => {
    // The managerScope arm reads the DEFAULT_VISIBILITY table,
    // deliberately NOT the demo `isManagerLike` role list — so a
    // no-reports TEAM_LEAD / BDM (DownTeam) still counts as an
    // agent here and cannot reassign. Only FullTeam / Organization
    // visibility counts as Manager scope.
    seedTeam();
    const loneTl = makeUser({ employeeId: 'TL999', role: 'TEAM_LEAD' });
    fallbackStore.users.push(loneTl);
    const lead = await createLeadAs(loneTl, '01700000111');
    const res = await reassignAs(loneTl, lead.id, '01700000111', '');
    assert.equal(res.status, 403, `no-reports team lead unassign should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'TL999');
  });

  it('a TL CAN unassign (has-subordinate arm, no target to place)', async () => {
    const { tl } = seedTeam();
    const lead = await createLeadAs(tl, '01700000107');
    const res = await reassignAs(tl, lead.id, '01700000107', '');
    assert.equal(res.status, 200, `TL unassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, '', 'the lead is unassigned');
    const history = Array.isArray(storedLead(lead.id).assignmentHistory) ? storedLead(lead.id).assignmentHistory : [];
    assert.ok(history.some((h: any) => h.note === 'Unassigned via API'), 'the unassignment is recorded');
  });

  it('Admin reassigns anyone to anyone (cross-team included) — the tree rule does not bind admins', async () => {
    const { admin, subA } = seedTeam();
    const lead = await createLeadAs(subA, '01700000108');
    const res = await reassignAs(admin, lead.id, '01700000108', 'OUT1');
    assert.equal(res.status, 200, `admin cross-team reassign should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'OUT1');
  });

  it('a lead Admin assigns to the TL appears on the TL\u2019s lead page (visibility, not rebuilt)', async () => {
    const { admin, tl, subA } = seedTeam();
    const lead = await createLeadAs(admin, '01700000109', { assignedTo: 'TL001' });
    assert.equal(storedLead(lead.id).assignedTo, 'TL001');

    const asTl = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(tl)}`);
    assert.ok(listRows(asTl).some((l: any) => l.id === lead.id), 'the TL sees the admin-assigned lead');
    const asSubA = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(subA)}`);
    assert.ok(!listRows(asSubA).some((l: any) => l.id === lead.id), 'a subordinate does not see the TL\u2019s own lead');
  });
});

describe('Team Lead bulk import — server gate aligned with the route gate (demo mode)', () => {
  let app: express.Express;

  beforeEach(() => {
    resetStores();
    app = createTestApp();
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
  });

  it('TL dry-run passes (the refusal side needs real grants — see tl-bulk-import-gate.test.ts)', async () => {
    // Demo-mode caveat (as in lead-authz test 8): hasPermissionCode
    // grants every known lead code without a database, so a plain
    // agent's bulk call passes here too and the refusal cannot be
    // observed. The 403s are proven against PGlite with real grants
    // in tl-bulk-import-gate.test.ts; this test pins the TL flow.
    const { tl } = seedTeam();
    const rows = [
      { customerName: 'Dry 1', mobile: '01700000201' },
      { customerName: 'Dry 2', mobile: '01700000202', assignedTo: 'EMPA' },
    ];
    const dry = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl)}`)
      .send({ leads: rows, dryRun: true });
    assert.equal(dry.status, 200, `TL dry-run should pass, got ${dry.status} ${JSON.stringify(dry.body)}`);
    assert.equal(dry.body.data.dryRun, true);
    assert.equal(fallbackStore.leads.length, 0, 'a dry run writes nothing');
  });

  it('a blank assignee in bulk stays unassigned by design (no fake assignment to the uploader)', async () => {
    const { tl } = seedTeam();
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl)}`)
      .send({ leads: [{ customerName: 'Blank Owner', mobile: '01700000203' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inserted, 1, 'a blank assignee does not reject the row');
    const stored = fallbackStore.leads.find((l: any) => l.mobile === '01700000203');
    assert.ok(stored, 'the row was imported');
    assert.ok(!stored.assignedTo, 'blank stays blank — the TL distributes it with Reassign');
    // The TL still sees it: they created it (the creator arm of the
    // visibility predicate), so the loop closes without a default.
    const asTl = await request(app).get('/api/leads').set('Authorization', `Bearer ${tokenFor(tl)}`);
    assert.ok(listRows(asTl).some((l: any) => l.id === stored.id), 'the TL sees their unassigned import');
  });
});
