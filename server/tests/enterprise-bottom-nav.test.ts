/**
 * enterprise-bottom-nav.test.ts
 * ------------------------------------------------------------------
 * Fix round 1 (2026-11-19): Mahadi asked for a fixed bottom
 * navigation bar on his phone — the role's 3–4 most important
 * pages, Overview always first, in the sample's design language
 * (white bar, olive active state, small icons + labels).
 *
 * Pinned here: the exact tabs per role (labels, paths, order);
 * Overview first for every role; every tab a real App.tsx route
 * (no dead buttons); the active state follows the current route
 * (longest-prefix, '/' exact); tabs are filtered by the SAME
 * access predicates as the sidebar; AppLayout builds the bar for
 * the DISPLAY role (so a super-admin preview shows the previewed
 * role's tabs); the bar is mobile-only at the drawer's 720px
 * breakpoint, the drawer overlays above it, and the content keeps
 * clearance so the bar never covers it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEnterpriseBottomNavTabs,
  enterpriseBottomNavActivePath,
  type EnterpriseNavAccess,
} from '../../src/layouts/enterpriseNav';
import type { EnterpriseRole } from '../../src/layouts/enterpriseRole';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const allowAll: Omit<EnterpriseNavAccess, 'role'> = {
  canOpen: () => true,
  canAccess: () => true,
};

const tabsFor = (role: EnterpriseRole, over: Partial<typeof allowAll> = {}) =>
  buildEnterpriseBottomNavTabs({ role, ...allowAll, ...over });

const labels = (role: EnterpriseRole) => tabsFor(role).map(t => t.label);
const paths = (role: EnterpriseRole) => tabsFor(role).map(t => t.path);

describe('bottom nav — the tabs per role (Mahadi’s lists, verbatim)', () => {
  // Team Lead / Manager / Admin bottom tabs (2026-11-20): Mahadi
  // did not specify these — they follow the new sidebar's first
  // four working pages per role (reported to him for veto). The
  // agent's tabs are unchanged (his list, verbatim).
  it('Admin: Team Overview, All Leads, Users & Roles, Team Performance', () => {
    assert.deepEqual(labels('admin'), ['Team Overview', 'All Leads', 'Users & Roles', 'Team Performance']);
    assert.deepEqual(paths('admin'), ['/', '/leads', '/users', '/execution-intelligence']);
  });

  it('Manager: Team Overview, Team Leads, Team Members, Team Performance', () => {
    assert.deepEqual(labels('manager'), ['Team Overview', 'Team Leads', 'Team Members', 'Team Performance']);
    assert.deepEqual(paths('manager'), ['/', '/leads', '/team', '/execution-intelligence']);
  });

  it('Team Lead: Team Overview, Team Leads, Follow-up Monitor, Team Members', () => {
    assert.deepEqual(labels('teamLead'), ['Team Overview', 'Team Leads', 'Follow-up Monitor', 'Team Members']);
    assert.deepEqual(paths('teamLead'), ['/', '/leads', '/follow-up', '/team']);
  });

  it('Agent: My Work, My Leads, Workbench, Add Lead', () => {
    assert.deepEqual(labels('agent'), ['My Work', 'My Leads', 'Workbench', 'Add Lead']);
    assert.deepEqual(paths('agent'), ['/', '/leads', '/workbench', '/leads/new']);
  });

  it('Overview (My Work for the agent) is always first, 4 tabs per role', () => {
    for (const role of ['admin', 'manager', 'teamLead', 'agent'] as EnterpriseRole[]) {
      const tabs = tabsFor(role);
      assert.equal(tabs.length, 4, `${role} has four tabs`);
      assert.equal(tabs[0].path, '/', `${role}'s first tab is the overview`);
    }
  });

  it('every tab is a real App.tsx route — no dead buttons', () => {
    const appRoutes = [...read('src/App.tsx').matchAll(/path: '([^']+)'/g)].map(m => m[1]);
    for (const role of ['admin', 'manager', 'teamLead', 'agent'] as EnterpriseRole[]) {
      for (const tabPath of paths(role)) {
        assert.ok(appRoutes.includes(tabPath), `${role} tab ${tabPath} is a registered route`);
      }
    }
  });
});

describe('bottom nav — access filtering (same predicates as the sidebar)', () => {
  it('a role without the insight grant loses the Team Performance tab', () => {
    const tabs = tabsFor('manager', { canAccess: () => false });
    assert.deepEqual(tabs.map(t => t.label), ['Team Overview', 'Team Leads', 'Team Members']);
  });

  it('a route the user cannot open drops its tab', () => {
    const tabs = tabsFor('admin', { canOpen: (route: string) => route !== '/users' });
    assert.deepEqual(tabs.map(t => t.label), ['Team Overview', 'All Leads', 'Team Performance']);
  });

  it('the overview tab is never filtered (every role opens /)', () => {
    for (const role of ['admin', 'manager', 'teamLead', 'agent'] as EnterpriseRole[]) {
      const tabs = tabsFor(role, { canAccess: () => false });
      assert.equal(tabs[0].path, '/', `${role} keeps its overview tab`);
    }
  });
});

describe('bottom nav — the active state follows the route', () => {
  const adminTabs = tabsFor('admin');

  it('exact matches activate', () => {
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/'), '/');
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/users'), '/users');
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/leads'), '/leads');
  });

  it('deep links activate their tab by longest prefix', () => {
    assert.equal(enterpriseBottomNavActivePath(tabsFor('agent'), '/leads/abc123'), '/leads');
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/users/roles'), '/users');
  });

  it('a route with no tab activates nothing (never a wrong highlight)', () => {
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/settings/system'), null);
    assert.equal(enterpriseBottomNavActivePath(adminTabs, '/task-calendar'), null);
  });
});

describe('bottom nav — shell wiring (source guards)', () => {
  it('AppLayout builds the bar for the DISPLAY role (preview-aware)', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    assert.ok(layout.includes('buildEnterpriseBottomNavTabs({'), 'the bar is built from the nav module');
    assert.ok(layout.includes('role: displayRole'), 'the bar follows the display role');
    assert.ok(
      layout.includes('<EnterpriseBottomNav tabs={bottomNavTabs} activePath={bottomNavActivePath} />'),
      'the bar renders with the resolved tabs + active path',
    );
  });

  it('the component renders a nav of real links with an active state', () => {
    const bar = read('src/layouts/EnterpriseBottomNav.tsx');
    assert.ok(bar.includes('<nav className="ep-bottomnav"'), 'the bar is a <nav>');
    assert.ok(bar.includes('<Link'), 'tabs are router links, not buttons');
    assert.ok(bar.includes("aria-current={active ? 'page' : undefined}"), 'the active tab is announced');
    assert.ok(bar.includes('if (tabs.length === 0) return null;'), 'an empty bar renders nothing');
  });

  it('the bar is mobile-only at the drawer breakpoint, below the drawer, with content clearance', () => {
    const css = read('src/index.css');
    // Hidden by default (desktop), shown at the 720px breakpoint.
    assert.ok(css.includes('.ep-bottomnav {\n  display: none;'), 'the bar is hidden on desktop');
    const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
    assert.ok(mobile.includes('.ep-bottomnav { display: flex; }'), 'the bar shows at <=720px');
    assert.ok(
      mobile.includes('padding: 22px 14px calc(35px + 68px + env(safe-area-inset-bottom));'),
      'the content keeps bottom-nav clearance on mobile',
    );
    // z-index: bar 10 < scrim 15 < sidebar 20 — the open drawer covers the bar.
    assert.ok(css.includes('.ep-bottomnav {') && css.includes('z-index: 10;'), 'the bar sits at z-index 10');
    assert.ok(css.includes('.ep-sidebar-scrim {') && css.includes('z-index: 15;'), 'the scrim sits above the bar');
    assert.ok(css.includes('z-index: 20; left: -270px;'), 'the drawer sits above the scrim');
  });
});
