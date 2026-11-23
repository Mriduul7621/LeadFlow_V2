/**
 * enterprise-nav.test.ts
 * ------------------------------------------------------------------
 * The role-based enterprise sidebar (Enterprise Preview redesign,
 * 2026-11-19; Team Lead / Manager / Admin workspace rebuild,
 * 2026-11-20): buildEnterpriseNavGroups is a pure function of the
 * caller's derived role and two access predicates, so every role's
 * groups and labels are pinned here without a React tree.
 *
 * Group titles, item labels and page subtitles are the sample
 * prototype's EXACT words — except where Mahadi renamed a label
 * to match its page or his demo screenshots; every item links to
 * a real LeadFlow page. Sample items with no real page
 * (Assignment Rules, Lead Distribution) are omitted, never
 * dead-linked. (Audit Log left this list on 2026-11-20, when the
 * audit-viewer UI was ported from PR #161.)
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

// Grant-gated items (User Management) need the server permission
// sheet settled before they render — the plain allowAll helper
// leaves grantsSettled undefined, so they stay hidden there.
const groupsForGranted = (role: EnterpriseRole) =>
  buildEnterpriseNavGroups({ role, ...allowAll, grantsSettled: true });

const titles = (groups: EnterpriseNavGroup[]) => groups.map(g => g.title);
const labels = (groups: EnterpriseNavGroup[]) => groups.flatMap(g => g.items.map(i => i.label));
const paths = (groups: EnterpriseNavGroup[]) => groups.flatMap(g => g.items.map(i => i.path));
const groupLabels = (groups: EnterpriseNavGroup[], title: string) =>
  groups.find(g => g.title === title)?.items.map(i => i.label) ?? [];

describe('buildEnterpriseNavGroups — Admin', () => {
  // Admin workspace (2026-11-20, Mahadi): ONE WORKSPACE group in
  // his order, then the unchanged CONFIGURATION and
  // ADMINISTRATION groups. NO INSIGHTS group (Team Performance
  // lives in WORKSPACE now) and NO ACCOUNT group (the profile
  // block + settings gear render for every role; Notifications
  // live behind the topbar bell).
  it('has WORKSPACE, CONFIGURATION and ADMINISTRATION — no INSIGHTS, no ACCOUNT', () => {
    assert.deepEqual(titles(groupsFor('admin')), [
      'WORKSPACE',
      'CONFIGURATION',
      'ADMINISTRATION',
    ]);
  });

  it('WORKSPACE carries the twelve items in Mahadi\'s exact order', () => {
    const work = groupsFor('admin').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      work.items.map(i => [i.label, i.path]),
      [
        ['Team Overview', '/'],
        ['All Leads', '/leads'],
        // Corporate Group Leads (065): after All Leads.
        ['Corporate Group Lead', '/leads/corporate'],
        ['Lead Intake', '/leads/upload'],
        ['Lead Pool', '/leads/all'],
        ['Follow-up Monitor', '/follow-up'],
        ['Team Members', '/team'],
        ['Team Performance', '/execution-intelligence'],
        ['Task Calendar', '/task-calendar'],
        ['Roadshow', '/roadshows'],
        ['Activities', '/activities'],
        ['Users & Roles', '/users'],
      ],
    );
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

  it('ADMINISTRATION carries Administration and Audit Log', () => {
    assert.deepEqual(groupLabels(groupsFor('admin'), 'ADMINISTRATION'), ['Administration', 'Audit Log']);
    const items = groupsFor('admin').find(g => g.title === 'ADMINISTRATION')!.items;
    assert.equal(items[0].path, '/administration');
    assert.equal(items[1].path, '/audit-log');
  });

  it('omits the sample items with no real page (never a dead link)', () => {
    const all = labels(groupsFor('admin'));
    assert.ok(!all.includes('Assignment Rules'), 'auto-assignment has no dedicated page');
    // Audit Log is NO LONGER in this list: the audit-viewer UI exists
    // since the 2026-11-20 port from PR #161 (see the test above).
    assert.ok(!all.includes('Lead Distribution'), 'the Team Members page already is that view');
  });

  it('has NO seller pages and NO removed pages (admin is not a seller)', () => {
    const all = labels(groupsFor('admin'));
    assert.ok(!all.includes('My Leads'), 'an admin is not a seller');
    assert.ok(!all.includes('My Performance'), 'an admin is not a seller');
    assert.ok(!all.includes('Self Performance'), 'an admin is not a seller');
    assert.ok(!all.includes('Add Lead'), 'an admin is not a seller');
    assert.ok(!all.includes('User Management'), 'admins use Users & Roles, not the team page');
    assert.ok(!all.includes('Daily Workbench'), 'left the admin sidebar 2026-11-20');
    assert.ok(!all.includes('Sales Pipeline'), 'left the admin sidebar 2026-11-20');
    assert.ok(!all.includes('Campaigns'), 'left the admin sidebar 2026-11-20');
    assert.ok(!all.includes('Trends & Reports'), 'left the admin sidebar 2026-11-20');
    assert.ok(!all.includes('NCP Progress'), 'left the admin sidebar 2026-11-20');
    assert.ok(!all.includes('Profile & Settings'), 'no ACCOUNT group anymore');
    assert.ok(!all.includes('Notifications'), 'the topbar bell carries notifications now');
  });
});

describe('buildEnterpriseNavGroups — Manager', () => {
  // Manager workspace (2026-11-20, Mahadi): the Team Lead
  // workspace minus My Leads and Add Lead, with My Performance
  // (own data) instead of Self Performance. ONE WORKSPACE group,
  // no ACCOUNT group.
  it('has ONE WORKSPACE group', () => {
    assert.deepEqual(titles(groupsFor('manager')), ['WORKSPACE']);
  });

  it('WORKSPACE carries the eleven items in Mahadi\'s exact order (User Management is grant-gated)', () => {
    const work = groupsFor('manager').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      work.items.map(i => [i.label, i.path]),
      [
        ['Team Overview', '/'],
        ['Team Leads', '/leads'],
        // Corporate Group Leads (065): after Team Leads.
        ['Corporate Group Lead', '/leads/corporate'],
        ['Lead Intake', '/leads/upload'],
        ['Follow-up Monitor', '/follow-up'],
        ['Team Members', '/team'],
        ['Team Performance', '/execution-intelligence'],
        ['My Performance', '/performance/self'],
        ['Task Calendar', '/task-calendar'],
        ['Roadshow', '/roadshows'],
        ['Activities', '/activities'],
      ],
    );
    // With the admin-granted users.add_employee grant, User
    // Management appears LAST.
    const granted = groupsForGranted('manager').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      granted.items.map(i => i.label).slice(-1),
      ['User Management'],
    );
    assert.equal(
      granted.items.find(i => i.label === 'User Management')!.path,
      '/users/team',
    );
  });

  it('has NO My Leads and NO Add Lead — and none of the removed pages', () => {
    const all = labels(groupsForGranted('manager'));
    assert.ok(!all.includes('My Leads'), 'the manager has no My Leads page');
    assert.ok(!all.includes('Add Lead'), 'the manager cannot add single leads');
    assert.ok(!all.includes('Self Performance'), 'the manager page is My Performance');
    assert.ok(!all.includes('Lead Pool'), 'only the admin distributes from the pool');
    assert.ok(!all.includes('Daily Workbench'), 'left the manager sidebar 2026-11-20');
    assert.ok(!all.includes('Sales Pipeline'), 'left the manager sidebar 2026-11-20');
    assert.ok(!all.includes('Campaigns'), 'left the manager sidebar 2026-11-20');
    assert.ok(!all.includes('Trends & Reports'), 'left the manager sidebar 2026-11-20');
    assert.ok(!all.includes('NCP Progress'), 'left the manager sidebar 2026-11-20');
    assert.ok(!all.includes('Profile & Settings'), 'no ACCOUNT group anymore');
    assert.ok(!all.includes('Notifications'), 'the topbar bell carries notifications now');
  });
});

describe('buildEnterpriseNavGroups — Team Lead', () => {
  // Team Lead workspace (2026-11-20, Mahadi's demo screenshots +
  // words): ONE WORKSPACE group in his exact order, no ACCOUNT
  // group. My Leads sits directly below Team Leads.
  it('has ONE WORKSPACE group', () => {
    assert.deepEqual(titles(groupsFor('teamLead')), ['WORKSPACE']);
  });

  it('WORKSPACE carries the twelve items in Mahadi\'s exact order (User Management is grant-gated)', () => {
    const work = groupsFor('teamLead').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      work.items.map(i => [i.label, i.path]),
      [
        ['Team Overview', '/'],
        ['Team Leads', '/leads'],
        ['My Leads', '/leads/my'],
        // Corporate Group Leads (065): after My Leads.
        ['Corporate Group Lead', '/leads/corporate'],
        ['Lead Intake', '/leads/upload'],
        ['Follow-up Monitor', '/follow-up'],
        ['Team Members', '/team'],
        ['Team Performance', '/execution-intelligence'],
        ['Self Performance', '/performance/self'],
        ['Task Calendar', '/task-calendar'],
        ['Roadshow', '/roadshows'],
        ['Activities', '/activities'],
      ],
    );
    // With the admin-granted users.add_employee grant, User
    // Management appears LAST.
    const granted = groupsForGranted('teamLead').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      granted.items.map(i => i.label).slice(-1),
      ['User Management'],
    );
    assert.equal(
      granted.items.find(i => i.label === 'User Management')!.path,
      '/users/team',
    );
  });

  it('has no Add Lead sidebar item (Add Lead is a button on Team Overview)', () => {
    assert.ok(!labels(groupsForGranted('teamLead')).includes('Add Lead'));
  });

  it('has no admin or removed entries', () => {
    const all = labels(groupsForGranted('teamLead'));
    assert.ok(!all.includes('Users & Roles'));
    assert.ok(!all.includes('System Settings'));
    assert.ok(!all.includes('Lead Pool'), 'TLs distribute through Reassign, not the pool');
    assert.ok(!all.includes('Daily Workbench'), 'left the TL sidebar 2026-11-20 (route stays live)');
    assert.ok(!all.includes('Sales Pipeline'), 'left the TL sidebar 2026-11-20');
    assert.ok(!all.includes('Campaigns'), 'left the TL sidebar 2026-11-20');
    assert.ok(!all.includes('Trends & Reports'), 'left the TL sidebar 2026-11-20');
    assert.ok(!all.includes('NCP Progress'), 'left the TL sidebar 2026-11-20');
    assert.ok(!all.includes('Profile & Settings'), 'no ACCOUNT group anymore');
    assert.ok(!all.includes('Notifications'), 'the topbar bell carries notifications now');
  });
});

describe('buildEnterpriseNavGroups — Agent', () => {
  // Agent workspace rebuild (2026-11-20, Mahadi's demo): the agent
  // nav is ONE WORKSPACE group in his exact order — My Work,
  // Activities right after it, My Leads, Follow-up Queue, My
  // Performance, Task Calendar, Roadshow. NO ACCOUNT group: the
  // profile block at the sidebar bottom carries the settings gear.
  // Daily Workbench, Sales Pipeline, Add Lead and NCP Progress left
  // the agent sidebar with the rebuild (their routes stay live).
  it('has ONE WORKSPACE group', () => {
    assert.deepEqual(titles(groupsFor('agent')), ['WORKSPACE']);
  });

  it('WORKSPACE carries the eight items in Mahadi\'s exact order', () => {
    const work = groupsFor('agent').find(g => g.title === 'WORKSPACE')!;
    assert.deepEqual(
      work.items.map(i => [i.label, i.path]),
      [
        ['My Work', '/'],
        ['Activities', '/activities'],
        ['My Leads', '/leads'],
        // Corporate Group Leads (065): after My Leads.
        ['Corporate Group Lead', '/leads/corporate'],
        ['Follow-up Queue', '/follow-up'],
        ['My Performance', '/execution-intelligence'],
        ['Task Calendar', '/task-calendar'],
        ['Roadshow', '/roadshows'],
      ],
    );
  });

  it('carries NONE of the removed items (Daily Workbench, Sales Pipeline, Add Lead, NCP Progress, Account)', () => {
    const all = labels(groupsFor('agent'));
    assert.ok(!all.includes('Daily Workbench'));
    assert.ok(!all.includes('Sales Pipeline'));
    assert.ok(!all.includes('Add Lead'));
    assert.ok(!all.includes('NCP Progress'));
    assert.ok(!all.includes('Profile & Settings'));
    assert.ok(!all.includes('Notifications'));
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

describe('buildEnterpriseNavGroups — grant-gated items (User Management)', () => {
  it('User Management stays hidden until the server permission sheet settles', () => {
    // canAccess true for everything, but grantsSettled is
    // undefined (the sheet has not loaded): the item must NOT
    // flash in on the role-matrix fallback.
    assert.ok(!labels(groupsFor('teamLead')).includes('User Management'));
    assert.ok(!labels(groupsFor('manager')).includes('User Management'));
    assert.ok(
      !labels(buildEnterpriseNavGroups({ role: 'teamLead', ...allowAll, grantsSettled: false })).includes('User Management'),
      'explicitly unsettled also hides it'
    );
  });

  it('User Management stays hidden when the grant is denied even after settling', () => {
    const denyGrant = {
      grantsSettled: true,
      canAccess: (featureId: string, actionKey: string) =>
        !(featureId === 'user_management' && actionKey === 'add_employee'),
    };
    assert.ok(!labels(groupsFor('teamLead', denyGrant)).includes('User Management'));
    assert.ok(!labels(groupsFor('manager', denyGrant)).includes('User Management'));
    // The rest of the nav is untouched by the one denied grant.
    assert.ok(labels(groupsFor('teamLead', denyGrant)).includes('Team Members'));
  });

  it('User Management appears when the sheet has settled AND the grant resolves', () => {
    assert.ok(labels(groupsForGranted('teamLead')).includes('User Management'));
    assert.ok(labels(groupsForGranted('manager')).includes('User Management'));
    // The Agent and Admin navs never carry it (the agent cannot
    // add users; the admin uses Users & Roles).
    assert.ok(!labels(groupsForGranted('agent')).includes('User Management'));
    assert.ok(!labels(groupsForGranted('admin')).includes('User Management'));
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
    assert.ok(!labels(groupsFor('admin', denyInsights)).includes('Team Performance'));
    assert.ok(!labels(groupsFor('manager', denyInsights)).includes('Team Performance'));
    assert.ok(!labels(groupsFor('teamLead', denyInsights)).includes('Team Performance'));
    assert.ok(!labels(groupsFor('agent', denyInsights)).includes('My Performance'));
    // The rest of the nav is untouched by one denied feature.
    assert.ok(labels(groupsFor('agent', denyInsights)).includes('My Leads'));
  });

  it('NCP Progress / Campaigns / Trends & Reports are in NO role\'s nav anymore', () => {
    // They left the TL/Manager/Admin sidebars with the 2026-11-20
    // rebuild (their routes stay live by URL); the agent never had
    // them. Denying their features changes nothing anywhere.
    const denyNcp = {
      canAccess: (featureId: string, _actionKey: string) => featureId !== 'ncp_progress',
    };
    for (const role of ['admin', 'manager', 'teamLead', 'agent'] as const) {
      assert.ok(!labels(groupsFor(role, denyNcp)).includes('NCP Progress'), `${role} has no NCP item`);
      assert.ok(!labels(groupsFor(role, denyNcp)).includes('Campaigns'), `${role} has no Campaigns item`);
      assert.ok(!labels(groupsFor(role, denyNcp)).includes('Trends & Reports'), `${role} has no Trends item`);
    }
    // The agent's own insight item is unaffected (different feature).
    assert.ok(labels(groupsFor('agent', denyNcp)).includes('My Performance'));
  });

  it('a group left with no items disappears entirely (no empty group headers)', () => {
    // Deny every CONFIGURATION route for the admin: the whole
    // group goes, not an empty header.
    const denyConfig = {
      canOpen: (route: string) => !route.startsWith('/settings/'),
    };
    const groups = groupsFor('admin', denyConfig);
    assert.ok(!titles(groups).includes('CONFIGURATION'), 'an empty group is dropped, not rendered empty');
    assert.ok(titles(groups).includes('WORKSPACE'), 'the other groups stay');
    assert.ok(titles(groups).includes('ADMINISTRATION'), 'the other groups stay');
  });

  it('non-insight items never consult canAccess', () => {
    // canAccess false for everything still leaves the plain items.
    const groups = groupsFor('agent', { canAccess: () => false });
    assert.ok(labels(groups).includes('My Work'));
    assert.ok(labels(groups).includes('My Leads'));
    assert.ok(labels(groups).includes('Activities'));
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
    assert.ok(all.includes('Team Overview'));
    assert.ok(all.includes('All Leads'));
    assert.ok(all.includes('Team Members'));
    assert.ok(all.includes('Team Performance'), 'RO holds reports.view since 2026-11-19');
  });

  it('an ADMIN caller building the Admin nav sees everything', () => {
    const groups = buildEnterpriseNavGroups({
      role: 'admin',
      canOpen: (route: string) => resolveFeatureRouteAccess(route, 'ADMIN', undefined),
      canAccess: () => true,
    });
    const all = labels(groups);
    for (const label of ['Users & Roles', 'Lead Intake', 'Lead Pool', 'System Settings', 'Administration', 'Team Performance']) {
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
    // /leads is the agent's "My Leads", the manager's "Team Leads".
    assert.equal(enterpriseLabelForPath(groupsFor('agent'), '/leads'), 'My Leads');
    assert.equal(enterpriseLabelForPath(groupsFor('manager'), '/leads'), 'Team Leads');
    assert.equal(enterpriseLabelForPath(groupsFor('admin'), '/leads'), 'All Leads');
    assert.equal(enterpriseLabelForPath(groupsFor('teamLead'), '/leads'), 'Team Leads');
    assert.equal(enterpriseLabelForPath(groupsFor('teamLead'), '/leads/my'), 'My Leads');
  });

  it('falls back to the exact fallback map for routes outside the sidebar', () => {
    assert.equal(enterpriseLabelForPath([], '/leads/new'), 'Add Lead');
    assert.equal(enterpriseLabelForPath([], '/settings/system'), 'System Settings');
    assert.equal(enterpriseLabelForPath([], '/settings/performance-diagnostics'), 'Performance Diagnostics');
    assert.equal(enterpriseLabelForPath([], '/more'), 'More');
    assert.equal(enterpriseLabelForPath([], '/administration'), 'Administration');
    // The new routes have fallback labels too (used when the
    // sidebar entry is hidden — e.g. User Management ungranted).
    assert.equal(enterpriseLabelForPath([], '/leads/my'), 'My Leads');
    assert.equal(enterpriseLabelForPath([], '/performance/self'), 'Self Performance');
    assert.equal(enterpriseLabelForPath([], '/users/team'), 'User Management');
  });

  it('resolves deep links by longest prefix', () => {
    // No sidebar item prefixes /team/kpi for the agent, so the
    // fallback prefix names it.
    assert.equal(enterpriseLabelForPath(groupsFor('agent'), '/team/kpi/noAction'), 'KPI detail');
    // A role whose sidebar HAS /team claims the deep link through
    // the sidebar prefix instead (sidebar prefix precedes the
    // fallback prefix in the resolver).
    assert.equal(enterpriseLabelForPath(groupsFor('teamLead'), '/team/kpi/overdue'), 'Team Members');
    // Organogram H1 fix (2026-11-21): the route's fallback label is
    // the board title now, not the Team Members label it borrowed.
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

  it('every new workspace label has a description (no empty heading subtitle)', () => {
    for (const label of [
      'Team Overview',
      'Team Leads',
      'All Leads',
      'Follow-up Monitor',
      'Self Performance',
      'User Management',
      'Team Members',
      'Team Performance',
    ]) {
      assert.ok(
        typeof ENTERPRISE_PAGE_DESCRIPTIONS[label] === 'string' && ENTERPRISE_PAGE_DESCRIPTIONS[label].length > 0,
        `${label} has a description`
      );
    }
  });
});
