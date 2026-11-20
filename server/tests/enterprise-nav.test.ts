/**
 * enterprise-nav.test.ts
 * ------------------------------------------------------------------
 * The role-based enterprise sidebar (Enterprise Preview redesign,
 * 2026-11-19): buildEnterpriseNavGroups is a pure function of the
 * caller's derived role and two access predicates, so every role's
 * groups and labels are pinned here without a React tree.
 *
 * Group titles, item labels and page subtitles are the sample
 * prototype's EXACT words; every item links to a real LeadFlow
 * page. Sample items with no real page (Assignment Rules, Audit
 * Log, Lead Distribution) are omitted, never dead-linked.
 *
 * The sidebar is a UX surface, never a security boundary: entries
 * are filtered by the SAME resolvers the router uses
 * (resolveFeatureRouteAccess for the route + canAccess for the
 * functional permission), and each destination keeps its own
 * FeatureGate + ProtectedRoute.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnterpriseNavGroups,
  enterpriseLabelForPath,
  ENTERPRISE_PAGE_DESCRIPTIONS,
  type EnterpriseNavGroup,
  type EnterpriseNavAccess,
} from '../../src/layouts/enterpriseNav';
import { resolveFeatureRouteAccess } from '../../src/layouts/featureRouteAccess';
import type { EnterpriseRole } from '../../src/layouts/enterpriseRole';

const allowAll: Omit<EnterpriseNavAccess, 'role'> = {
  canOpen: () => true,
  canAccess: () => true,
};

const groupsFor = (role: EnterpriseRole, over: Partial<typeof allowAll> = {}) =>
  buildEnterpriseNavGroups({ role, ...allowAll, ...over });

const titles = (groups: EnterpriseNavGroup[]) => groups.map(g => g.title);
const labels = (groups: EnterpriseNavGroup[]) => groups.flatMap(g => g.items.map(i => i.label));
const paths = (groups: EnterpriseNavGroup[]) => groups.flatMap(g => g.items.map(i => i.path));
const groupLabels = (groups: EnterpriseNavGroup[], title: string) =>
  groups.find(g => g.title === title)?.items.map(i => i.label) ?? [];

describe('buildEnterpriseNavGroups — Admin', () => {
  it('has the sample\'s groups, in order', () => {
    assert.deepEqual(titles(groupsFor('admin')), [
      'WORKSPACE',
      'INSIGHTS',
      'CONFIGURATION',
      'ACCOUNT',
      'ADMINISTRATION',
    ]);
  });

  it('WORKSPACE carries Users & Roles, Lead Intake and Lead Pool on the real routes', () => {
    const groups = groupsFor('admin');
    const workspace = groups.find(g => g.title === 'WORKSPACE')!;
    const byLabel = new Map(workspace.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Users & Roles'), '/users');
    assert.equal(byLabel.get('Lead Intake'), '/leads/upload');
    assert.equal(byLabel.get('Lead Pool'), '/leads/all');
    assert.equal(byLabel.get('Overview'), '/');
    assert.equal(byLabel.get('Teams & Hierarchy'), '/team');
    assert.equal(byLabel.get('Follow-up Queue'), '/follow-up');
  });

  it('CONFIGURATION carries the three settings pages on three DISTINCT routes', () => {
    // Fix round 1 (2026-11-19): the three items used to share
    // /settings/system, so every click landed on the same page and
    // all three highlighted at once. Each is now its own page with
    // only its own content.
    assert.deepEqual(groupLabels(groupsFor('admin'), 'CONFIGURATION'), [
      'Status & Pipeline',
      'Products & Campaigns',
      'System Settings',
    ]);
    const config = groupsFor('admin').find(g => g.title === 'CONFIGURATION')!;
    const byLabel = new Map(config.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Status & Pipeline'), '/settings/status-pipeline');
    assert.equal(byLabel.get('Products & Campaigns'), '/settings/products-campaigns');
    assert.equal(byLabel.get('System Settings'), '/settings/system');
    assert.equal(new Set(config.items.map(i => i.path)).size, 3, 'three distinct destinations');
  });

  it('INSIGHTS carries Analytics and ADMINISTRATION carries Administration', () => {
    assert.deepEqual(groupLabels(groupsFor('admin'), 'INSIGHTS'), ['Analytics']);
    assert.deepEqual(groupLabels(groupsFor('admin'), 'ADMINISTRATION'), ['Administration']);
    assert.equal(
      groupsFor('admin').find(g => g.title === 'ADMINISTRATION')!.items[0].path,
      '/administration'
    );
  });

  it('omits the sample items with no real page (never a dead link)', () => {
    const all = labels(groupsFor('admin'));
    assert.ok(!all.includes('Assignment Rules'), 'auto-assignment has no dedicated page');
    assert.ok(!all.includes('Audit Log'), 'no audit-viewer UI exists');
    assert.ok(!all.includes('Lead Distribution'), 'the Team Members page already is that view');
  });
});

describe('buildEnterpriseNavGroups — Manager', () => {
  it('has the sample\'s groups, in order', () => {
    assert.deepEqual(titles(groupsFor('manager')), [
      'WORKSPACE',
      'INSIGHTS',
      'FIELD EXECUTION',
      'ACCOUNT',
    ]);
  });

  it('WORKSPACE carries Teams and Sales Pipeline', () => {
    const workspace = groupsFor('manager').find(g => g.title === 'WORKSPACE')!;
    const byLabel = new Map(workspace.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Teams'), '/team');
    assert.equal(byLabel.get('Sales Pipeline'), '/sales-pipeline');
    assert.equal(byLabel.get('Leads'), '/leads');
    assert.equal(byLabel.get('Daily Workbench'), '/workbench');
  });

  it('INSIGHTS carries all four report pages', () => {
    const insights = groupsFor('manager').find(g => g.title === 'INSIGHTS')!;
    const byLabel = new Map(insights.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Performance'), '/execution-intelligence');
    assert.equal(byLabel.get('Campaigns'), '/campaign-breakdown');
    assert.equal(byLabel.get('Trends & Reports'), '/trend-charts');
    assert.equal(byLabel.get('NCP Progress'), '/ncp-progress');
  });

  it('FIELD EXECUTION carries Roadshow Follow-up', () => {
    const field = groupsFor('manager').find(g => g.title === 'FIELD EXECUTION')!;
    const byLabel = new Map(field.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Roadshow Follow-up'), '/roadshows');
    assert.equal(byLabel.get('Task Calendar'), '/task-calendar');
  });
});

describe('buildEnterpriseNavGroups — Team Lead', () => {
  it('has WORKSPACE, PERFORMANCE and ACCOUNT — and NO Configuration group', () => {
    assert.deepEqual(titles(groupsFor('teamLead')), ['WORKSPACE', 'PERFORMANCE', 'ACCOUNT']);
  });

  it('WORKSPACE carries Team Members; PERFORMANCE carries Team Performance + Roadshow Follow-up', () => {
    const groups = groupsFor('teamLead');
    const workspace = groups.find(g => g.title === 'WORKSPACE')!;
    const byLabel = new Map(workspace.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Team Members'), '/team');
    assert.equal(byLabel.get('Daily Workbench'), '/workbench');
    assert.equal(byLabel.get('Follow-up Queue'), '/follow-up');
    assert.equal(byLabel.get('Activities'), '/activities');
    const performance = groups.find(g => g.title === 'PERFORMANCE')!;
    const perfByLabel = new Map(performance.items.map(i => [i.label, i.path]));
    assert.equal(perfByLabel.get('Team Performance'), '/execution-intelligence');
    assert.equal(perfByLabel.get('Roadshow Follow-up'), '/roadshows');
  });

  it('WORKSPACE carries Lead Intake and Add Lead (team-lead lead creation, 2026-11-19)', () => {
    const workspace = groupsFor('teamLead').find(g => g.title === 'WORKSPACE')!;
    const byLabel = new Map(workspace.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Lead Intake'), '/leads/upload');
    assert.equal(byLabel.get('Add Lead'), '/leads/new');
  });

  it('has no admin or manager-only entries', () => {
    const all = labels(groupsFor('teamLead'));
    assert.ok(!all.includes('Users & Roles'));
    assert.ok(!all.includes('System Settings'));
    assert.ok(!all.includes('Teams'));
    assert.ok(!all.includes('Sales Pipeline'));
  });
});

describe('buildEnterpriseNavGroups — Agent', () => {
  it('has MY WORK, MY PERFORMANCE and ACCOUNT', () => {
    assert.deepEqual(titles(groupsFor('agent')), ['MY WORK', 'MY PERFORMANCE', 'ACCOUNT']);
  });

  it('MY WORK carries Add Lead and My Leads', () => {
    const work = groupsFor('agent').find(g => g.title === 'MY WORK')!;
    const byLabel = new Map(work.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Add Lead'), '/leads/new');
    assert.equal(byLabel.get('My Leads'), '/leads');
    assert.equal(byLabel.get('Daily Workbench'), '/workbench');
    assert.equal(byLabel.get('Follow-up Queue'), '/follow-up');
    assert.equal(byLabel.get('Activities'), '/activities');
  });

  it('MY PERFORMANCE carries Performance and NCP Progress — and no other report pages', () => {
    const perf = groupsFor('agent').find(g => g.title === 'MY PERFORMANCE')!;
    const byLabel = new Map(perf.items.map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Performance'), '/execution-intelligence');
    assert.equal(byLabel.get('NCP Progress'), '/ncp-progress');
    assert.deepEqual([...byLabel.keys()].sort(), ['NCP Progress', 'Performance']);
  });

  it('has NO admin entries and NO Trends/Campaigns entries', () => {
    const all = labels(groupsFor('agent'));
    const allPaths = paths(groupsFor('agent'));
    assert.ok(!all.includes('Users & Roles'));
    assert.ok(!all.includes('Lead Intake'));
    assert.ok(!all.includes('Lead Pool'));
    assert.ok(!all.includes('System Settings'));
    assert.ok(!all.includes('Trends & Reports'));
    assert.ok(!all.includes('Campaigns'));
    assert.ok(!allPaths.includes('/trend-charts'), 'the agent nav never links Trends & Reports');
    assert.ok(!allPaths.includes('/campaign-breakdown'), 'the agent nav never links Campaigns');
  });
});

describe('buildEnterpriseNavGroups — permission filtering', () => {
  it('a route the caller cannot open is hidden (canOpen false)', () => {
    const groups = groupsFor('admin', { canOpen: (route: string) => route !== '/users' });
    assert.ok(!labels(groups).includes('Users & Roles'), 'the denied item is hidden');
    assert.ok(labels(groups).includes('Lead Intake'), 'the other items stay');
  });

  it('an insight item whose feature permission is denied is hidden (canAccess false)', () => {
    const denyInsights = {
      canAccess: (featureId: string, actionKey: string) =>
        !(featureId === 'execution_intelligence' && actionKey === 'view'),
    };
    assert.ok(!labels(groupsFor('admin', denyInsights)).includes('Analytics'));
    assert.ok(!labels(groupsFor('manager', denyInsights)).includes('Performance'));
    assert.ok(!labels(groupsFor('agent', denyInsights)).includes('Performance'));
    // The rest of the nav is untouched by one denied feature.
    assert.ok(labels(groupsFor('agent', denyInsights)).includes('NCP Progress'));
  });

  it('denying NCP Progress hides it for Manager and Agent alike', () => {
    const denyNcp = {
      canAccess: (featureId: string, _actionKey: string) => featureId !== 'ncp_progress',
    };
    assert.ok(!labels(groupsFor('manager', denyNcp)).includes('NCP Progress'));
    assert.ok(!labels(groupsFor('agent', denyNcp)).includes('NCP Progress'));
    assert.ok(labels(groupsFor('agent', denyNcp)).includes('Performance'));
  });

  it('a group left with no items disappears entirely (no empty group headers)', () => {
    // Deny every INSIGHTS feature for the manager: the whole group goes.
    const denyAllInsights = { canAccess: () => false };
    const groups = groupsFor('manager', denyAllInsights);
    assert.ok(!titles(groups).includes('INSIGHTS'), 'an empty group is dropped, not rendered empty');
    assert.ok(titles(groups).includes('WORKSPACE'), 'the other groups stay');
  });

  it('non-insight items never consult canAccess', () => {
    // canAccess false for everything still leaves the plain items.
    const groups = groupsFor('agent', { canAccess: () => false });
    assert.ok(labels(groups).includes('My Leads'));
    assert.ok(labels(groups).includes('Add Lead'));
    assert.ok(labels(groups).includes('Daily Workbench'));
    assert.ok(labels(groups).includes('Follow-up Queue'));
  });
});

describe('buildEnterpriseNavGroups — fail-closed through the REAL route resolver', () => {
  it('an RO caller building the Admin nav sees no admin-only entries', () => {
    // canOpen wired to the real resolver (not a stub): the route
    // gate itself decides, so the nav can never disagree with the
    // router. RO holds no admin-only route.
    const groups = buildEnterpriseNavGroups({
      role: 'admin',
      canOpen: (route: string) => resolveFeatureRouteAccess(route, 'RO', undefined),
      canAccess: () => true,
    });
    const all = labels(groups);
    assert.ok(!all.includes('Users & Roles'), '/users is ADMIN_ONLY');
    assert.ok(!all.includes('Lead Intake'), '/leads/upload is ADMIN_ONLY');
    assert.ok(!all.includes('Lead Pool'), '/leads/all is ADMIN_ONLY');
    assert.ok(!all.includes('System Settings'), '/settings/system is admin-only');
    assert.ok(!all.includes('Status & Pipeline'));
    assert.ok(!all.includes('Products & Campaigns'));
    assert.ok(!all.includes('Administration'), '/administration is admin-only');
    assert.ok(!titles(groups).includes('CONFIGURATION'), 'the emptied group disappears');
    assert.ok(!titles(groups).includes('ADMINISTRATION'), 'the emptied group disappears');
    // The routes RO CAN open stay visible.
    assert.ok(all.includes('Overview'));
    assert.ok(all.includes('Teams & Hierarchy'));
    assert.ok(all.includes('Analytics'), 'RO holds reports.view since 2026-11-19');
  });

  it('an ADMIN caller building the Admin nav sees everything', () => {
    const groups = buildEnterpriseNavGroups({
      role: 'admin',
      canOpen: (route: string) => resolveFeatureRouteAccess(route, 'ADMIN', undefined),
      canAccess: () => true,
    });
    const all = labels(groups);
    for (const label of ['Users & Roles', 'Lead Intake', 'Lead Pool', 'System Settings', 'Administration', 'Analytics']) {
      assert.ok(all.includes(label), `ADMIN sees ${label}`);
    }
  });

  it('an unknown route key fails closed even for ADMIN', () => {
    assert.equal(resolveFeatureRouteAccess('/no-such-route', 'ADMIN', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/no-such-route', 'RO', undefined), false);
    assert.equal(resolveFeatureRouteAccess('', 'ADMIN', undefined), false);
  });
});

describe('enterpriseLabelForPath — breadcrumb labels', () => {
  it('prefers the sidebar entry\'s own label over the generic fallback', () => {
    // /leads is the agent's "My Leads", not the fallback's "Leads".
    assert.equal(enterpriseLabelForPath(groupsFor('agent'), '/leads'), 'My Leads');
    assert.equal(enterpriseLabelForPath(groupsFor('manager'), '/leads'), 'Leads');
  });

  it('falls back to the exact fallback map for routes outside the sidebar', () => {
    assert.equal(enterpriseLabelForPath([], '/leads/new'), 'Add Lead');
    assert.equal(enterpriseLabelForPath([], '/settings/system'), 'System Settings');
    assert.equal(enterpriseLabelForPath([], '/settings/performance-diagnostics'), 'Performance Diagnostics');
    assert.equal(enterpriseLabelForPath([], '/more'), 'More');
    assert.equal(enterpriseLabelForPath([], '/administration'), 'Administration');
  });

  it('resolves deep links by longest prefix', () => {
    // No sidebar item prefixes /team/kpi for the agent, so the
    // fallback prefix names it.
    assert.equal(enterpriseLabelForPath(groupsFor('agent'), '/team/kpi/noAction'), 'KPI detail');
    // A role whose sidebar HAS /team claims the deep link through
    // the sidebar prefix instead (sidebar prefix precedes the
    // fallback prefix in the resolver).
    assert.equal(enterpriseLabelForPath(groupsFor('teamLead'), '/team/kpi/overdue'), 'Team Members');
    assert.equal(enterpriseLabelForPath(groupsFor('admin'), '/team/organogram'), 'Teams & Hierarchy');
  });

  it('returns a sensible label for an unknown path instead of a raw segment', () => {
    assert.equal(enterpriseLabelForPath(groupsFor('agent'), '/definitely-not-a-route'), 'LeadFlow');
    assert.equal(enterpriseLabelForPath([], '/definitely-not-a-route'), 'LeadFlow');
    assert.equal(enterpriseLabelForPath([], '/'), 'LeadFlow');
  });
});

describe('ENTERPRISE_PAGE_DESCRIPTIONS — the sample\'s subtitles, verbatim', () => {
  it('pins the key descriptions', () => {
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Users & Roles'],
      'Manage users and review access across permission layers.'
    );
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Lead Intake'],
      'Monitor uploads, validation and import exceptions.'
    );
    assert.equal(ENTERPRISE_PAGE_DESCRIPTIONS['NCP Progress'], 'Track NCP progress against target.');
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Roadshow Follow-up'],
      'Track roadshow activity and follow-up actions.'
    );
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Sales Pipeline'],
      'Understand stage volume and conversion bottlenecks.'
    );
  });

  it('every insight nav label has a description', () => {
    for (const label of ['Analytics', 'Performance', 'Campaigns', 'Trends & Reports', 'NCP Progress']) {
      assert.ok(
        typeof ENTERPRISE_PAGE_DESCRIPTIONS[label] === 'string' && ENTERPRISE_PAGE_DESCRIPTIONS[label].length > 0,
        `${label} has a description`
      );
    }
  });
});
