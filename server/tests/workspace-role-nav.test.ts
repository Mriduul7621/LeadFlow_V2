/**
 * workspace-role-nav.test.ts — role-based sidebar + role derivation
 * ------------------------------------------------------------------
 * Phase 1 role-dashboard redesign (2026-11-17): the shell shows ONE
 * role's navigation, derived from the caller's REAL scope + team
 * fact — never a role switcher (the sample prototype's dropdown is
 * demo-only; a member must never be able to switch into a Manager
 * view). Sections:
 *
 *   1. deriveWorkspaceRole — the pure derivation (scope + reports +
 *      admin bypass), fail-closed to member.
 *   2. buildSidebarGroups — per-role entries with the easy display
 *      labels on unchanged routes; shared sections; admin gating.
 *   3. No dead links — every sidebar entry resolves to a mounted
 *      route with a Feature Access entry.
 *   4. No role switcher — the role is derived, never chosen, never
 *      stored; no switcher control exists anywhere in the shell.
 *   5. sidebarLabelForPath — breadcrumb labels from the sidebar.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  WORKSPACE_HOME_LABELS,
  WORKSPACE_ROLE_LABELS,
  deriveWorkspaceRole,
  type WorkspaceRole,
} from '../../src/layouts/workspaceRole';
import {
  buildSidebarGroups,
  sidebarLabelForPath,
  type SidebarAccess,
  type SidebarGroup,
} from '../../src/layouts/sidebarNav';
import { FEATURE_ROUTES } from '../../src/layouts/featureRouteAccess';
import type {
  TeamOverviewPerson,
  TeamOverviewResponse,
} from '../../src/modules/team/services/teamOverviewService';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

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

const overview = (scope: string, people: TeamOverviewPerson[]): TeamOverviewResponse => ({
  success: true,
  scope,
  people,
});

const selfWithReports = () => [
  person({ userId: 'u-self', employeeId: 'EMP-001', name: 'Lena Lead', isSelf: true, directReports: 2, tier: 'teamLead' }),
  person({ userId: 'u-a', employeeId: 'EMP-002', name: 'Arif Member', managerEmployeeId: 'EMP-001' }),
];
const selfLeaf = () => [person({ userId: 'u-self', employeeId: 'EMP-001', name: 'Solo Member', isSelf: true, directReports: 0 })];

/** Access with every route open and every view permission granted. */
function openAccess(role: WorkspaceRole): SidebarAccess {
  return { canOpen: () => true, canAccess: () => true, role };
}

/**
 * Realistic non-admin access: every non-admin route open, every view
 * permission granted, the admin routes closed (Feature Access keeps
 * them ADMIN-only). Administration gating is by ROUTE, not by role —
 * a member with every route open would see the section, which is why
 * the per-role tests use this instead of openAccess for the admin
 * assertions.
 */
const NON_ADMIN_ROUTES = new Set([
  '/', '/leads', '/leads/all', '/workbench', '/execution-intelligence', '/activities',
  '/team', '/team/organogram', '/sales-pipeline',
  '/ncp-progress', '/trend-charts', '/campaign-breakdown',
  '/task-calendar', '/roadshows', '/follow-up', '/notifications',
]);
function roleAccess(role: WorkspaceRole): SidebarAccess {
  return restrictedAccess(role, NON_ADMIN_ROUTES, new Set([
    'execution_intelligence', 'ncp_progress', 'trend_charts', 'campaign_breakdown',
  ]));
}

/** Access with a restricted route set and permission set. */
function restrictedAccess(
  role: WorkspaceRole,
  openRoutes: Set<string>,
  permissions: Set<string> = new Set(),
): SidebarAccess {
  return {
    canOpen: (route: string) => openRoutes.has(route),
    canAccess: (featureId: string, actionKey: string) => actionKey === 'view' && permissions.has(featureId),
    role,
  };
}

function groupTitles(groups: SidebarGroup[]): string[] {
  return groups.map(g => g.title);
}
function groupPaths(groups: SidebarGroup[], title: string): string[] {
  return groups.find(g => g.title === title)?.items.map(i => i.path) ?? [];
}
function groupLabels(groups: SidebarGroup[], title: string): string[] {
  return groups.find(g => g.title === title)?.items.map(i => i.label) ?? [];
}
function allPaths(groups: SidebarGroup[]): string[] {
  return groups.flatMap(g => g.items.map(i => i.path));
}
function allLabels(groups: SidebarGroup[]): string[] {
  return groups.flatMap(g => g.items.map(i => i.label));
}

/* ================================================================ */
/* 1. deriveWorkspaceRole                                            */
/* ================================================================ */

describe('workspace role — deriveWorkspaceRole', () => {
  it('Organization scope is a manager, even with no reports', () => {
    assert.equal(deriveWorkspaceRole(overview('Organization', selfLeaf()), false), 'manager');
  });

  it('Team scope is a team lead, even with no direct reports', () => {
    assert.equal(deriveWorkspaceRole(overview('Team', selfLeaf()), false), 'teamLead');
  });

  it('Own scope follows the team fact: reports -> team lead, leaf -> member', () => {
    assert.equal(deriveWorkspaceRole(overview('Own', selfWithReports()), false), 'teamLead');
    assert.equal(deriveWorkspaceRole(overview('Own', selfLeaf()), false), 'member');
  });

  it('an empty scope falls back to the team fact alone', () => {
    assert.equal(deriveWorkspaceRole(overview('', selfWithReports()), false), 'teamLead');
    assert.equal(deriveWorkspaceRole(overview('', selfLeaf()), false), 'member');
  });

  it('no overview never guesses a team view — except the admin bypass', () => {
    assert.equal(deriveWorkspaceRole(null, false), 'member');
    assert.equal(deriveWorkspaceRole(undefined, false), 'member');
    assert.equal(deriveWorkspaceRole(null, true), 'manager', 'the server forces an admin caller to Organization scope');
    assert.equal(deriveWorkspaceRole(undefined, true), 'manager');
  });

  it('the home labels are the easy names, per role', () => {
    assert.deepEqual(WORKSPACE_HOME_LABELS, {
      member: 'My Work',
      teamLead: 'Team Overview',
      manager: 'Business Overview',
    });
    assert.equal(WORKSPACE_ROLE_LABELS.member, 'Team Member');
    assert.equal(WORKSPACE_ROLE_LABELS.teamLead, 'Team Lead');
    assert.equal(WORKSPACE_ROLE_LABELS.manager, 'Manager');
  });
});

/* ================================================================ */
/* 2. buildSidebarGroups — per-role entries                          */
/* ================================================================ */

describe('workspace nav — per-role sidebar entries', () => {
  it('a member sees only member entries — never Teams, All Leads, or Administration', () => {
    const groups = buildSidebarGroups(roleAccess('member'));
    assert.deepEqual(groupLabels(groups, 'Workspace'), [
      'My Work', 'My Leads', 'Follow-up Queue', 'My Performance', 'Activities',
    ]);
    assert.deepEqual(groupPaths(groups, 'Workspace'), [
      '/', '/leads', '/workbench', '/execution-intelligence', '/activities',
    ]);
    const labels = allLabels(groups);
    assert.ok(!labels.includes('Teams'), 'no Teams entry for a member');
    assert.ok(!labels.includes('All Leads'), 'no All Leads entry for a member');
    assert.ok(!labels.includes('Team Members'), 'no Team Members entry for a member');
    assert.ok(!labels.includes('Organogram'), 'no Organogram entry for a member');
    assert.ok(!groupTitles(groups).includes('Administration'), 'no Administration section for a member');
  });

  it('a team lead sees team entries, with Organogram under the team pages', () => {
    const groups = buildSidebarGroups(roleAccess('teamLead'));
    assert.deepEqual(groupLabels(groups, 'Workspace'), [
      'Team Overview', 'Team Leads', 'Follow-up Monitor', 'Team Members', 'Organogram', 'Team Performance', 'Activities',
    ]);
    assert.deepEqual(groupPaths(groups, 'Workspace'), [
      '/', '/leads', '/workbench', '/team', '/team/organogram', '/execution-intelligence', '/activities',
    ]);
    assert.ok(!allLabels(groups).includes('All Leads'), 'no All Leads entry for a team lead');
    assert.ok(!allLabels(groups).includes('Sales Pipeline'), 'no Sales Pipeline entry for a team lead');
    assert.ok(!groupTitles(groups).includes('Administration'), 'no Administration section for a team lead');
  });

  it('a manager sees the organisation entries, with Organogram under Teams', () => {
    const groups = buildSidebarGroups(openAccess('manager'));
    assert.deepEqual(groupLabels(groups, 'Workspace'), [
      'Business Overview', 'All Leads', 'Sales Pipeline', 'Teams', 'Organogram', 'Analytics', 'Activities',
    ]);
    assert.deepEqual(groupPaths(groups, 'Workspace'), [
      '/', '/leads/all', '/sales-pipeline', '/team', '/team/organogram', '/execution-intelligence', '/activities',
    ]);
    assert.ok(!allLabels(groups).includes('My Leads'), 'no member entries for a manager');
    assert.ok(!allLabels(groups).includes('Follow-up Queue'), 'no member queue entry for a manager');
  });

  it('every role keeps the shared Analytics and General sections', () => {
    for (const role of ['member', 'teamLead', 'manager'] as const) {
      const groups = buildSidebarGroups(openAccess(role));
      assert.deepEqual(groupLabels(groups, 'Analytics'), ['NCP Progress', 'Trends', 'Campaigns']);
      assert.deepEqual(groupPaths(groups, 'Analytics'), ['/ncp-progress', '/trend-charts', '/campaign-breakdown']);
      assert.deepEqual(groupLabels(groups, 'General'), ['Task Calendar', 'Roadshows', 'Follow-up Strategy', 'Notifications']);
      assert.deepEqual(groupPaths(groups, 'General'), ['/task-calendar', '/roadshows', '/follow-up', '/notifications']);
    }
  });

  it('Administration appears only when the route gate opens it', () => {
    // A member whose role cannot open the admin routes sees no section.
    const member = buildSidebarGroups(restrictedAccess('member', new Set([
      '/', '/leads', '/workbench', '/execution-intelligence', '/activities',
      '/ncp-progress', '/trend-charts', '/campaign-breakdown',
      '/task-calendar', '/roadshows', '/follow-up', '/notifications',
    ]), new Set(['execution_intelligence', 'ncp_progress', 'trend_charts', 'campaign_breakdown'])));
    assert.ok(!groupTitles(member).includes('Administration'), 'the empty admin group is dropped, not rendered empty');

    // An admin caller sees the full section, Diagnostics included.
    const admin = buildSidebarGroups(openAccess('manager'));
    assert.deepEqual(groupLabels(admin, 'Administration'), [
      'Users', 'Settings', 'System', 'Performance Diagnostics',
    ]);
    assert.deepEqual(groupPaths(admin, 'Administration'), [
      '/users', '/settings', '/settings/system', '/settings/performance-diagnostics',
    ]);
  });

  it('a closed route gate hides the entry (never a dead link)', () => {
    const groups = buildSidebarGroups(restrictedAccess('member', new Set([
      '/', '/leads', '/workbench', '/execution-intelligence', '/activities',
      '/ncp-progress', '/trend-charts', '/campaign-breakdown',
      '/task-calendar', '/follow-up', '/notifications',
    ]), new Set(['execution_intelligence', 'ncp_progress', 'trend_charts', 'campaign_breakdown'])));
    assert.ok(!allPaths(groups).includes('/roadshows'), 'a roadshow-less role never sees the Roadshows entry');
    assert.ok(allPaths(groups).includes('/task-calendar'), 'the open entries stay');
  });

  it('analytics entries need their view permission as well as the route gate', () => {
    // Route open, permission missing: the entry hides.
    const noPerm = buildSidebarGroups(restrictedAccess('member', new Set([
      '/', '/leads', '/workbench', '/execution-intelligence', '/activities',
      '/ncp-progress', '/trend-charts', '/campaign-breakdown',
      '/task-calendar', '/roadshows', '/follow-up', '/notifications',
    ]), new Set()));
    assert.ok(!allLabels(noPerm).includes('My Performance'), 'My Performance hides without the view permission');
    assert.ok(!groupTitles(noPerm).includes('Analytics'), 'the whole Analytics section hides without any analytics permission');

    // One permission: only that entry shows.
    const onePerm = buildSidebarGroups(restrictedAccess('member', new Set([
      '/', '/leads', '/workbench', '/execution-intelligence', '/activities',
      '/ncp-progress', '/trend-charts', '/campaign-breakdown',
      '/task-calendar', '/roadshows', '/follow-up', '/notifications',
    ]), new Set(['ncp_progress'])));
    assert.deepEqual(groupLabels(onePerm, 'Analytics'), ['NCP Progress']);
  });

  it('there is no Targets entry anywhere (no targets data model exists)', () => {
    for (const role of ['member', 'teamLead', 'manager'] as const) {
      const groups = buildSidebarGroups(openAccess(role));
      assert.ok(!allLabels(groups).some(l => /target/i.test(l)), `${role}: no Targets entry may be invented`);
      assert.ok(!allPaths(groups).some(p => p.includes('target')), `${role}: no targets route may be linked`);
    }
  });
});

/* ================================================================ */
/* 3. No dead links                                                  */
/* ================================================================ */

describe('workspace nav — no dead links', () => {
  it('every sidebar entry resolves to a mounted route with a Feature Access entry', () => {
    const app = read('src/App.tsx');
    for (const role of ['member', 'teamLead', 'manager'] as const) {
      for (const p of allPaths(buildSidebarGroups(openAccess(role)))) {
        assert.ok(app.includes(`path: '${p}'`), `${role}: sidebar path ${p} must be a mounted route`);
        assert.ok(FEATURE_ROUTES[p], `${role}: sidebar path ${p} must have a FEATURE_ROUTES entry`);
      }
    }
  });

  it('every sidebar path is unique within a role', () => {
    for (const role of ['member', 'teamLead', 'manager'] as const) {
      const paths = allPaths(buildSidebarGroups(openAccess(role)));
      assert.equal(new Set(paths).size, paths.length, `${role}: no duplicate sidebar destinations`);
    }
  });
});

/* ================================================================ */
/* 4. No role switcher                                               */
/* ================================================================ */

describe('workspace nav — no role switcher anywhere', () => {
  it('no switcher control exists in the shell, the nav module, or the landing', () => {
    // Comments may NAME the forbidden pattern (the design notes say
    // "never a role-switcher"); only live code is guarded.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const file of [
      'src/layouts/AppLayout.tsx',
      'src/layouts/sidebarNav.ts',
      'src/layouts/workspaceRole.ts',
      'src/modules/auth/components/HomeLanding.tsx',
    ]) {
      const src = stripComments(read(file));
      assert.ok(!src.includes('RoleSwitcher'), `${file}: no RoleSwitcher component`);
      assert.ok(!src.includes('role-switcher'), `${file}: no role-switcher hook`);
      assert.ok(!src.includes('switchRole'), `${file}: no role-switch action`);
      assert.ok(!src.includes('Switch role'), `${file}: no switch-role copy`);
      assert.ok(!src.includes('View as'), `${file}: no view-as impersonation`);
    }
  });

  it('the role is derived from the overview in exactly the two places that need it', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    assert.ok(layout.includes('deriveWorkspaceRole(callerTeam.overview, isAdminBypass)'),
      'the shell derives the role from the loaded overview');
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('deriveWorkspaceRole(overview, isAdminBypass)'),
      'the landing derives the role from the same overview');
    // The derivation inputs are the scope + the team fact — never a
    // stored choice.
    const derivation = read('src/layouts/workspaceRole.ts');
    assert.ok(!derivation.includes('localStorage'), 'the role is never read from storage');
    assert.ok(!derivation.includes('sessionStorage'), 'the role is never read from session storage');
    const nav = read('src/layouts/sidebarNav.ts');
    assert.ok(!nav.includes('localStorage'), 'the nav module never reads storage');
  });

  it('the shell stores only the activity timestamp, never a role choice', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    const storageUses = Array.from(layout.matchAll(/localStorage\.(get|set)Item\('([^']+)'/g), m => m[2]);
    assert.ok(storageUses.length > 0, 'the shell does use localStorage (activity timestamp)');
    assert.deepEqual([...new Set(storageUses)], ['leadflow_last_activity'],
      'the only stored key is the session-activity timestamp — no role key exists');
  });
});

/* ================================================================ */
/* 5. sidebarLabelForPath                                            */
/* ================================================================ */

describe('workspace nav — sidebarLabelForPath (breadcrumb labels)', () => {
  it('the home label follows the role', () => {
    assert.equal(sidebarLabelForPath(buildSidebarGroups(openAccess('member')), '/'), 'My Work');
    assert.equal(sidebarLabelForPath(buildSidebarGroups(openAccess('teamLead')), '/'), 'Team Overview');
    assert.equal(sidebarLabelForPath(buildSidebarGroups(openAccess('manager')), '/'), 'Business Overview');
  });

  it('deep links resolve to the longest-prefix sidebar entry', () => {
    const member = buildSidebarGroups(openAccess('member'));
    assert.equal(sidebarLabelForPath(member, '/leads/123'), 'My Leads');
    assert.equal(sidebarLabelForPath(member, '/leads'), 'My Leads');
    const lead = buildSidebarGroups(openAccess('teamLead'));
    assert.equal(sidebarLabelForPath(lead, '/team/kpi/overdue'), 'Team Members');
    assert.equal(sidebarLabelForPath(lead, '/team/organogram'), 'Organogram');
  });

  it('routes outside the sidebar fall back to their friendly label, never a raw segment', () => {
    const member = buildSidebarGroups(openAccess('member'));
    assert.equal(sidebarLabelForPath(member, '/leads/new'), 'Add Lead');
    assert.equal(sidebarLabelForPath(member, '/more'), 'More');
    assert.equal(sidebarLabelForPath(member, '/help'), 'Help');
    assert.equal(sidebarLabelForPath(member, '/settings/performance-diagnostics'), 'Performance Diagnostics');
  });
});
