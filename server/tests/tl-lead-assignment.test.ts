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

describe('Follow-up labels match their pages (2026-11-19)', () => {
  it('/workbench is "Daily Workbench" and /follow-up is "Follow-up Queue" in every role', () => {
    for (const role of ROLES) {
      const items = labelsFor(role);
      const workbench = items.find(i => i.path === '/workbench');
      const followUp = items.find(i => i.path === '/follow-up');
      // Admin has no /workbench entry (no Daily Workbench in the
      // admin nav) — the label rule applies wherever the item exists.
      // Agent workspace rebuild (2026-11-20): the agent nav dropped
      // /workbench too (not in Mahadi's demo) — the route stays live
      // and the heading still resolves through the fallback map.
      if (role === 'admin' || role === 'agent') {
        assert.equal(workbench, undefined, `${role} has no workbench entry`);
      } else {
        assert.ok(workbench, `${role} nav must include /workbench`);
        assert.equal(workbench!.label, 'Daily Workbench', `${role} must label /workbench Daily Workbench`);
      }
      assert.ok(followUp, `${role} nav must include /follow-up`);
      assert.equal(followUp!.label, 'Follow-up Queue', `${role} must label /follow-up Follow-up Queue`);
    }
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
    assert.equal(ENTERPRISE_PAGE_DESCRIPTIONS['Follow-up Strategy'], undefined, 'the retired label has no description');
  });

  it('page headings follow the labels', () => {
    assert.deepEqual(enterpriseHeadingForPath('agent', '/workbench'), {
      title: 'Daily Workbench',
      sub: ENTERPRISE_PAGE_DESCRIPTIONS['Daily Workbench'],
    });
    assert.deepEqual(enterpriseHeadingForPath('agent', '/follow-up'), {
      title: 'Follow-up Queue',
      sub: 'Prioritize overdue and upcoming follow-ups.',
    });
  });

  it('exactly one nav item is active on each queue page', () => {
    for (const role of ROLES) {
      const groups = buildEnterpriseNavGroups({ role, ...allowAll });
      // No two items share a path within one role's nav.
      const paths = groups.flatMap(g => g.items.map(i => i.path));
      assert.equal(new Set(paths).size, paths.length, `${role} nav must not duplicate a path`);
      assert.equal(enterpriseActivePath(groups, '/follow-up'), '/follow-up');
      // Admin and Agent have no /workbench nav item, so nothing is
      // active there (null) — the page itself stays reachable by URL.
      if (role === 'admin' || role === 'agent') {
        assert.equal(enterpriseActivePath(groups, '/workbench'), null);
      } else {
        assert.equal(enterpriseActivePath(groups, '/workbench'), '/workbench');
      }
    }
  });

  it('the mobile bottom bar shortens Daily Workbench to "Workbench"', () => {
    for (const role of ['teamLead', 'agent'] as EnterpriseRole[]) {
      const tabs = buildEnterpriseBottomNavTabs({ role, ...allowAll });
      const tab = tabs.find(t => t.path === '/workbench');
      assert.ok(tab, `${role} bottom nav must carry /workbench`);
      assert.equal(tab!.label, 'Workbench', `${role} bottom tab uses the short form`);
    }
  });
});

describe('Lead Intake route predicate — ADMIN or ≥1 subordinate', () => {
  it('the registry pins teamLeadAllowed on /leads/upload (and nowhere else)', () => {
    assert.equal(FEATURE_ROUTES['/leads/upload'].teamLeadAllowed, true);
    for (const [key, entry] of Object.entries(FEATURE_ROUTES)) {
      if (key !== '/leads/upload') assert.equal(entry.teamLeadAllowed, undefined, `${key} must not carry the predicate`);
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

  it('a no-reports MANAGER cannot reassign — holding leads.assign is not having a team', async () => {
    const { loneManager } = seedTeam();
    const lead = await createLeadAs(loneManager, '01700000106');
    const res = await reassignAs(loneManager, lead.id, '01700000106', '');
    assert.equal(res.status, 403, `no-reports manager unassign should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(storedLead(lead.id).assignedTo, 'MGR9');
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
