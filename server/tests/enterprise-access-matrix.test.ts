/**
 * enterprise-access-matrix.test.ts
 * ------------------------------------------------------------------
 * Role x nav item for the Enterprise Preview (2026-11-19), through
 * the REAL route resolver (resolveFeatureRouteAccess) + the REAL
 * default-grant table (DEFAULT_GRANTS) — no stubs for the gate
 * itself.
 *
 * THE ACCESS CHANGE (2026-11-19): FIELD_EXEC in
 * roleGrantDefaults.ts now includes 'reports.view', so the field
 * roles (RO/BE/SBE/EMPLOYEE) hold it by default and INSIGHT_ROLES
 * (derived from the table, never retyped) includes them. The
 * sample's Agent nav carries MY PERFORMANCE -> Performance and
 * NCP Progress, and both pages are gated on that grant.
 *
 * Layering note (read before "fixing" a test here): the ROUTE gate
 * opens ALL FOUR insight pages for a field role, because the
 * route list derives from the one `reports.view` grant. The agent
 * nav hides Trends & Reports and Campaigns anyway — those items
 * are simply not in the agent's nav definition, and the items
 * that ARE there are additionally filtered by the
 * feature-permission layer (canAccess). So this file asserts the
 * ROUTE gate for all four insight pages, and asserts the NAV
 * builder's hiding separately, via a canAccess stub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveFeatureRouteAccess,
  FEATURE_ROUTES,
} from '../../src/layouts/featureRouteAccess';
import {
  DEFAULT_GRANTS,
  rolesWithDefaultGrant,
} from '../../src/modules/shared/access/roleGrantDefaults';
import { buildEnterpriseNavGroups } from '../../src/layouts/enterpriseNav';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** The static-fallback decision: no role matrix loaded yet. */
const canOpen = (route: string, role: string): boolean =>
  resolveFeatureRouteAccess(route, role, undefined);

const INSIGHT_ROUTES = ['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'];

describe('access matrix — the default grant table (2026-11-19 change)', () => {
  it('the field roles hold reports.view by default', () => {
    for (const role of ['RO', 'BE', 'SBE', 'EMPLOYEE']) {
      assert.ok(
        (DEFAULT_GRANTS[role] ?? []).includes('reports.view'),
        `${role} holds reports.view in DEFAULT_GRANTS`
      );
    }
  });

  it('managers and team leads still hold reports.view by default', () => {
    for (const role of ['MANAGER', 'SM', 'RM', 'TEAM_LEAD', 'BDM', 'ASM', 'CEO', 'BH']) {
      assert.ok(
        (DEFAULT_GRANTS[role] ?? []).includes('reports.view'),
        `${role} holds reports.view in DEFAULT_GRANTS`
      );
    }
  });

  it('rolesWithDefaultGrant(reports.view) is exactly the standard role set', () => {
    assert.deepEqual(rolesWithDefaultGrant('reports.view').sort(), [
      'ASM', 'BDM', 'BE', 'BH', 'CEO', 'EMPLOYEE', 'MANAGER', 'RM', 'RO', 'SBE', 'SM', 'TEAM_LEAD',
    ]);
  });

  it('the insight route fallback derives from the table (never a retyped list)', () => {
    const access = read('src/layouts/featureRouteAccess.ts');
    assert.ok(
      access.includes("...rolesWithDefaultGrant('reports.view')"),
      'INSIGHT_ROLES derives from the grant table'
    );
  });
});

describe('access matrix — Admin (ADMIN)', () => {
  it('opens every admin nav destination', () => {
    for (const route of ['/users', '/leads/upload', '/leads/all', '/settings/system', '/settings/status-pipeline', '/settings/products-campaigns', '/administration']) {
      assert.equal(canOpen(route, 'ADMIN'), true, `ADMIN opens ${route}`);
      assert.equal(canOpen(route, 'SUPERADMIN'), true, `SUPERADMIN opens ${route}`);
    }
  });

  it('opens the insight pages too (admin bypass)', () => {
    for (const route of INSIGHT_ROUTES) {
      assert.equal(canOpen(route, 'ADMIN'), true, `ADMIN opens ${route}`);
    }
  });
});

describe('access matrix — Manager (MANAGER)', () => {
  it('opens every manager nav insight + roadshows', () => {
    for (const route of [...INSIGHT_ROUTES, '/roadshows']) {
      assert.equal(canOpen(route, 'MANAGER'), true, `MANAGER opens ${route}`);
    }
  });

  it('opens the manager workspace routes', () => {
    for (const route of ['/', '/team', '/leads', '/workbench', '/sales-pipeline', '/follow-up', '/task-calendar']) {
      assert.equal(canOpen(route, 'MANAGER'), true, `MANAGER opens ${route}`);
    }
  });

  it('does NOT open the admin-only routes', () => {
    for (const route of ['/users', '/leads/upload', '/leads/all', '/settings/system', '/settings/status-pipeline', '/settings/products-campaigns', '/administration']) {
      assert.equal(canOpen(route, 'MANAGER'), false, `MANAGER must not open ${route}`);
    }
  });
});

describe('access matrix — Team Lead (TEAM_LEAD)', () => {
  it('opens the same insight pages as the manager, plus roadshows', () => {
    for (const route of [...INSIGHT_ROUTES, '/roadshows']) {
      assert.equal(canOpen(route, 'TEAM_LEAD'), true, `TEAM_LEAD opens ${route}`);
    }
  });

  it('opens the team-lead workspace routes', () => {
    for (const route of ['/', '/team', '/workbench', '/activities', '/task-calendar', '/follow-up']) {
      assert.equal(canOpen(route, 'TEAM_LEAD'), true, `TEAM_LEAD opens ${route}`);
    }
  });

  it('does NOT open the admin-only routes', () => {
    for (const route of ['/users', '/leads/upload', '/leads/all', '/settings/system', '/settings/status-pipeline', '/settings/products-campaigns', '/administration']) {
      assert.equal(canOpen(route, 'TEAM_LEAD'), false, `TEAM_LEAD must not open ${route}`);
    }
  });
});

describe('access matrix — Agent (RO + EMPLOYEE): the new reports.view grant', () => {
  it('opens Performance and NCP Progress at the route level (the new grant)', () => {
    for (const role of ['RO', 'EMPLOYEE']) {
      assert.equal(canOpen('/execution-intelligence', role), true, `${role} opens Performance`);
      assert.equal(canOpen('/ncp-progress', role), true, `${role} opens NCP Progress`);
    }
  });

  it('opens Trends and Campaigns at the ROUTE level too — the nav hides them, not the gate', () => {
    // One grant (`reports.view`) drives all four insight routes, so
    // the route gate cannot split them. The agent nav omits the
    // Trends/Campaigns items by construction (next test), and the
    // feature-permission layer filters the items that ARE listed.
    for (const role of ['RO', 'EMPLOYEE']) {
      assert.equal(canOpen('/trend-charts', role), true, `${role} passes the route gate for Trends`);
      assert.equal(canOpen('/campaign-breakdown', role), true, `${role} passes the route gate for Campaigns`);
    }
  });

  it('the agent nav hides Trends and Campaigns even with full access', () => {
    const groups = buildEnterpriseNavGroups({
      role: 'agent',
      canOpen: () => true,
      canAccess: () => true,
    });
    const allPaths = groups.flatMap(g => g.items.map(i => i.path));
    assert.ok(!allPaths.includes('/trend-charts'), 'the agent nav never links Trends & Reports');
    assert.ok(!allPaths.includes('/campaign-breakdown'), 'the agent nav never links Campaigns');
    assert.ok(allPaths.includes('/execution-intelligence'), 'My Performance stays in the agent nav');
    // Agent workspace rebuild (2026-11-20): NCP Progress left the
    // agent nav (not in Mahadi's demo) — the route stays live and
    // the other roles keep it.
    assert.ok(!allPaths.includes('/ncp-progress'), 'NCP Progress is no longer in the agent nav');
  });

  it('the feature-permission layer hides a denied agent insight item (canAccess stub)', () => {
    // Agent workspace rebuild (2026-11-20): the agent's only
    // insight item is My Performance (execution_intelligence) —
    // NCP Progress is not in the agent nav at all.
    const denyPerf = buildEnterpriseNavGroups({
      role: 'agent',
      canOpen: (route: string) => resolveFeatureRouteAccess(route, 'RO', undefined),
      canAccess: (featureId: string) => featureId !== 'execution_intelligence',
    });
    const labels = denyPerf.flatMap(g => g.items.map(i => i.label));
    assert.ok(!labels.includes('My Performance'), 'denying execution_intelligence hides the nav item');
    assert.ok(labels.includes('My Leads'), 'the other items stay');
    assert.ok(labels.includes('Follow-up Queue'), 'the other items stay');
    const denyBoth = buildEnterpriseNavGroups({
      role: 'agent',
      canOpen: (route: string) => resolveFeatureRouteAccess(route, 'RO', undefined),
      canAccess: (featureId: string) => !['ncp_progress', 'execution_intelligence'].includes(featureId),
    });
    // The WORKSPACE group survives (it holds non-insight items) —
    // only the insight item itself disappears.
    assert.ok(denyBoth.map(g => g.title).includes('WORKSPACE'), 'the workspace group stays');
    assert.ok(!denyBoth.flatMap(g => g.items.map(i => i.label)).includes('My Performance'), 'the denied item is gone');
  });

  it('opens the agent workspace routes and NOT the admin-only routes', () => {
    for (const role of ['RO', 'EMPLOYEE']) {
      for (const route of ['/', '/leads', '/leads/new', '/workbench', '/activities', '/task-calendar', '/follow-up']) {
        assert.equal(canOpen(route, role), true, `${role} opens ${route}`);
      }
      for (const route of ['/users', '/leads/upload', '/leads/all', '/settings/system', '/settings/status-pipeline', '/settings/products-campaigns', '/administration']) {
        assert.equal(canOpen(route, role), false, `${role} must not open ${route}`);
      }
    }
  });
});

describe('access matrix — fail-closed edges', () => {
  it('an unknown role opens org-wide routes but no insight or admin route', () => {
    assert.equal(canOpen('/', 'GHOSTROLE'), true, 'ANY_ROLE routes stay open to any authenticated role');
    assert.equal(canOpen('/leads', 'GHOSTROLE'), true);
    for (const route of INSIGHT_ROUTES) {
      assert.equal(canOpen(route, 'GHOSTROLE'), false, `a custom role with no grant must not open ${route}`);
    }
    assert.equal(canOpen('/users', 'GHOSTROLE'), false);
    assert.equal(canOpen('/roadshows', 'GHOSTROLE'), false, 'roadshows stay behind an explicit list');
  });

  it('no role opens an unknown route key — not even ADMIN', () => {
    for (const role of ['ADMIN', 'SUPERADMIN', 'MANAGER', 'RO']) {
      assert.equal(canOpen('/no-such-route', role), false, `${role} must not open an unknown route`);
    }
  });

  it('no role at all opens anything', () => {
    for (const route of ['/', '/leads', '/execution-intelligence']) {
      assert.equal(resolveFeatureRouteAccess(route, null, undefined), false);
      assert.equal(resolveFeatureRouteAccess(route, '', undefined), false);
    }
  });

  it('an explicit menuAccess entry wins over the static fallback, both ways', () => {
    // An admin can still hide reports from a field role that holds
    // the default grant (the revocation path for the new grant).
    assert.equal(
      resolveFeatureRouteAccess('/execution-intelligence', 'RO', { menuAccess: { '/execution-intelligence': false } } as any),
      false,
      'an explicit false hides the page despite the default grant'
    );
    // …and can grant a page the static list denies.
    assert.equal(
      resolveFeatureRouteAccess('/users', 'RO', { menuAccess: { '/users': true } } as any),
      true,
      'an explicit true opens the page despite the admin-only fallback'
    );
  });

  it('every nav destination in the enterprise nav is a registered feature route', () => {
    const nav = read('src/layouts/enterpriseNav.ts');
    const navPaths = [...new Set([...nav.matchAll(/path: '([^']+)'/g)].map(m => m[1]))];
    assert.ok(navPaths.length > 10, 'the nav declares a real path set');
    for (const navPath of navPaths) {
      assert.ok(
        FEATURE_ROUTES[navPath] !== undefined,
        `nav path ${navPath} is registered in FEATURE_ROUTES`
      );
    }
  });
});

describe('access matrix — the Roles & Access editor catalogs the Reports module', () => {
  it('ACTION_PERMISSION_GROUPS has a Reports module with reports.view', () => {
    const users = read('src/modules/users/pages/UserManagement.tsx');
    const groupsAt = users.indexOf('const ACTION_PERMISSION_GROUPS');
    assert.ok(groupsAt >= 0, 'the editor catalog exists');
    const reportsAt = users.indexOf("module: 'Reports'", groupsAt);
    assert.ok(reportsAt > groupsAt, 'the catalog has a Reports module');
    const reportsBlock = users.slice(reportsAt, reportsAt + 800);
    assert.ok(
      reportsBlock.includes("{ code: 'reports.view', label: 'View'"),
      'the Reports module toggles the canonical reports.view grant'
    );
  });
});
