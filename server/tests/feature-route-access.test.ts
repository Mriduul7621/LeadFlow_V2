/**
 * feature-route-access.test.ts — production-safety audit (this PR)
 * ------------------------------------------------------------------
 * Layer B (Feature Access) at the ROUTE level, documented in
 * docs/RBAC_FALLBACK_SAFETY_AUDIT.md:
 *
 *   1. resolveFeatureRouteAccess is a pure, fail-closed decision:
 *      ADMIN/SUPERADMIN pass (established bypass); an explicit dynamic
 *      menuAccess entry wins (true OR false); otherwise the static role
 *      fallback — identical to primary navigation and More directories;
 *   2. a disabled Feature Access module blocks its page route (typing the
 *      URL cannot bypass the sidebar);
 *   3. the registry, the routes wrapped in App.tsx, and the AppLayout
 *      primary navigation stay in lockstep (no drift, no ungated page route);
 *   4. FeatureGate redirects (never renders) when the decision denies.
 *
 * This is a VISIBILITY gate: the server keeps enforcing canonical Action
 * Permissions and Data Visibility on every request regardless of what a
 * page renders (see rbac-fallback-safety-audit.test.ts for that layer).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_ROUTES,
  canResolveRouteAccess,
  resolveFeatureRouteAccess,
} from '../../src/layouts/featureRouteAccess';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

const ALL_ROUTES = Object.keys(FEATURE_ROUTES);
const NON_ADMIN_ROLES = ['RO', 'RM', 'ASM', 'BDM', 'BE', 'BH'];
const WORKSPACE_ROUTES = ['/', '/more', '/notifications', '/help', '/about', '/sales-pipeline', '/workbench', '/activities', '/task-calendar', '/follow-up', '/leads', '/leads/new', '/settings', '/leads/:id'];
const INSIGHT_ROUTES = ['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'];
const ADMIN_ONLY_ROUTES = ['/administration', '/settings/system', '/leads/upload', '/leads/all', '/users'];

describe('resolveFeatureRouteAccess — pure Layer B decision', () => {
  it('ADMIN and SUPERADMIN pass every registered route, even when menuAccess disables it', () => {
    // menuAccess is keyed by PATH; disable every path explicitly.
    const allOff = Object.fromEntries(ALL_ROUTES.map(key => [FEATURE_ROUTES[key].path, false]));
    for (const route of ALL_ROUTES) {
      assert.equal(resolveFeatureRouteAccess(route, 'ADMIN', { menuAccess: allOff } as any), true, `ADMIN bypass for ${route}`);
      assert.equal(resolveFeatureRouteAccess(route, 'SUPERADMIN', { menuAccess: allOff } as any), true, `SUPERADMIN bypass for ${route}`);
    }
  });

  it('static role fallbacks mirror the primary navigation and More directories for every role class', () => {
    for (const route of ADMIN_ONLY_ROUTES) {
      for (const role of NON_ADMIN_ROLES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), false, `${route} must be admin-only (static), blocked for ${role}`);
      }
      assert.equal(resolveFeatureRouteAccess(route, 'ADMIN', undefined), true, `${route} open for ADMIN`);
    }

    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'RO', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'RM', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'BH', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'ADMIN', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'SUPERADMIN', undefined), true);

    for (const route of INSIGHT_ROUTES) {
      for (const role of ['RO', 'RM']) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} open for ${role}`);
      }
      for (const role of ['ASM', 'BDM', 'BE', 'BH']) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), false, `${route} closed for ${role} (static)`);
      }
    }

    assert.equal(resolveFeatureRouteAccess('/team', 'RM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'ASM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BDM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BE', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BH', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'RO', undefined), false, 'Team closed for RO (static)');

    for (const route of WORKSPACE_ROUTES) {
      for (const role of NON_ADMIN_ROLES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} open for ${role}`);
      }
    }
  });

  it('dynamic menuAccess wins over the static fallback (explicit true OR false)', () => {
    // Explicit false blocks even an ALL_ROLES workspace page.
    assert.equal(resolveFeatureRouteAccess('/leads', 'RO', { menuAccess: { '/leads': false } } as any), false, 'disabled module blocks the page route');
    // Lead 360 inherits the /leads module key.
    assert.equal(resolveFeatureRouteAccess('/leads/:id', 'RO', { menuAccess: { '/leads': false } } as any), false, '/leads/:id inherits the /leads module');
    assert.equal(resolveFeatureRouteAccess('/leads', 'RO', { menuAccess: { '/leads': true } } as any), true);

    // Explicit true can OPEN a statically-closed module to a non-admin role.
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'RO', { menuAccess: { '/leads/upload': true } } as any), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'BE', { menuAccess: { '/execution-intelligence': true } } as any), true);

    // Unrelated entries do not change the outcome (static fallback applies).
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'RO', { menuAccess: { '/other': true } } as any), false);
    assert.equal(resolveFeatureRouteAccess('/team', 'RO', { menuAccess: {} } as any), false);
  });

  it('every report/pipeline route is gated by its OWN module toggle (the aggregate Reports gate is gone)', () => {
    // Mobile-shell change: the "Reports" directory was retired and each page
    // moved to the left sidebar with its own Feature Access module. There is no
    // longer any route that opens because a *different* report module is on.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'RO', {
      menuAccess: { '/execution-intelligence': true },
    } as any), true, 'an enabled report module opens its own page');
    assert.equal(resolveFeatureRouteAccess('/sales-pipeline', 'RO', {
      menuAccess: { '/sales-pipeline': false, '/execution-intelligence': true },
    } as any), false, 'a sibling report module must not open the pipeline page');
    assert.equal(resolveFeatureRouteAccess('/sales-pipeline', 'RO', {
      menuAccess: { '/sales-pipeline': true },
    } as any), true, 'the pipeline module toggle opens the pipeline page');
    // Diagnostics keeps its ADMIN/SUPERADMIN static fallback (the AdminRoute
    // gate inside the element is the hard boundary; an explicit dynamic
    // menuAccess grant is the pre-existing override path).
    assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', 'RO', undefined), false, 'diagnostics stays ADMIN/SUPERADMIN only');
  });

  it('fails closed on unknown route keys and missing roles', () => {
    assert.equal(resolveFeatureRouteAccess('/definitely-not-a-route', 'ADMIN', undefined), false, 'unknown route key fails closed even for ADMIN');
    assert.equal(resolveFeatureRouteAccess('/leads', null, undefined), false);
    assert.equal(resolveFeatureRouteAccess('/leads', '', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/leads', '   ', undefined), false);
  });

  it('the registry covers every page route in App.tsx (no drift, none missing)', () => {
    const app = read('src/App.tsx');
    const wrapped = Array.from(app.matchAll(/<FeatureGate route="([^"]+)"/g), m => m[1]);
    assert.equal(wrapped.length, ALL_ROUTES.length, 'every registered page route is wrapped in App.tsx');
    assert.equal(new Set(wrapped).size, wrapped.length, 'no duplicate FeatureGate routes');
    assert.deepEqual(
      [...new Set(wrapped)].sort(),
      [...ALL_ROUTES].sort(),
      'App.tsx wrapped routes must equal the FEATURE_ROUTES registry'
    );
    assert.ok(app.includes("import FeatureGate") || /import\s+FeatureGate/.test(app), 'App.tsx imports FeatureGate');
  });
});

describe('primary navigation and More directories — route coverage', () => {
  it('primary tabs keep their five entries and the secondary pages live in the left sidebar', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    const start = layout.indexOf('const PRIMARY_NAV_ITEMS');
    const end = layout.indexOf('const MORE_NAV_PATHS');
    assert.ok(start >= 0 && end > start, 'primary navigation config must exist');
    const menuPaths = Array.from(layout.slice(start, end).matchAll(/path: '([^']+)'/g), m => m[1]);
    assert.deepEqual(menuPaths, ['/', '/workbench', '/leads/new', '/leads', '/more']);
    assert.doesNotMatch(layout, /<motion\.aside|isMobileMenuOpen/, 'no legacy drawer implementation may return');
    assert.ok(layout.includes('isSidebarOpen'), 'the left sidebar drawer owns the shell drawer state');

    // The retired More → Reports directory is replaced by the permission-
    // filtered left sidebar (src/layouts/sidebarNav.ts).
    const sidebar = read('src/layouts/sidebarNav.ts');
    for (const p of ['/activities', '/task-calendar', '/follow-up', '/team', '/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown', '/roadshows', '/sales-pipeline']) {
      assert.ok(sidebar.includes(`path: '${p}'`), `the sidebar must include ${p}`);
    }

    for (const p of menuPaths) {
      assert.ok(FEATURE_ROUTES[p], `menu path ${p} must have a FEATURE_ROUTES entry (page route gate)`);
    }
    for (const [route, entry] of Object.entries(FEATURE_ROUTES)) {
      assert.ok(route, `route ${route} is registered`);
      assert.ok(entry.path, `route ${route} has a menuAccess key`);
    }
  });
});

describe('FeatureGate source guard (deny never renders the page)', () => {
  it('redirects on deny and resolves roles through the shared session cache', () => {
    const src = read('src/modules/auth/components/FeatureGate.tsx');
    // The gate resolves the caller's role row once and hands the SAME value
    // to the wait-check and to the decision, so both layers can never
    // disagree about which matrix they were reading.
    assert.ok(src.includes('const matched = matchRole(roles, user);'), 'gate must resolve the role row once');
    assert.ok(src.includes('canResolveRouteAccess(route, user.role, matched)'), 'gate must check whether the decision is final yet');
    assert.ok(src.includes('resolveFeatureRouteAccess(route, user.role, matched)'), 'gate must use the shared pure decision');
    assert.ok(src.includes('<Navigate to="/" replace />'), 'deny must redirect, never render the page');
    assert.ok(src.includes('readSessionCache'), 'roles must come from the shared session cache');
    assert.ok(src.includes('adminService.getRoles()'), 'roles must load through the role API');
    assert.ok(src.includes('ROLES_CACHE_CHANGED_EVENT'), 'gate must refresh when role permissions change');
  });

  it('waits (never redirects) while the role matrix is still unknown', () => {
    const src = read('src/modules/auth/components/FeatureGate.tsx');
    // The undecided branch renders a status placeholder instead of a
    // Navigate — the cold-load bounce fix.
    const waitBlock = src.slice(src.indexOf('if (!canResolveRouteAccess'), src.indexOf('if (!resolveFeatureRouteAccess'));
    assert.ok(waitBlock.length > 0, 'the wait branch must exist');
    assert.ok(waitBlock.includes('<AccessResolving />'), 'the wait branch renders the neutral placeholder');
    assert.ok(!waitBlock.includes('<Navigate'), 'the wait branch must NEVER redirect');
    assert.ok(waitBlock.includes('settled'), 'a finished (empty) fetch must fall through to the static fallback');
  });

  it('the decision can still be made without a matrix for admin + ANY_ROLE routes', () => {
    assert.equal(canResolveRouteAccess('/', 'EMPLOYEE', undefined), true, 'a "*" route is decidable immediately');
    assert.equal(canResolveRouteAccess('/leads', 'ADMIN', undefined), true, 'admin is decidable immediately');
    assert.equal(canResolveRouteAccess('/definitely-not-a-route', 'RO', undefined), true, 'unknown routes fail closed without waiting');
    assert.equal(canResolveRouteAccess('/roadshows', 'EMPLOYEE', undefined), false, 'a menuAccess-only route must wait for the matrix');
    assert.equal(canResolveRouteAccess('/roadshows', 'EMPLOYEE', { menuAccess: { '/roadshows': false } } as any), true, 'a loaded matrix settles the decision');
    assert.equal(canResolveRouteAccess('/leads/upload', 'RO', undefined), false, 'a privileged route waits too (an explicit grant can open it)');
  });

  it('catalogue roles (MANAGER/TEAM_LEAD/EMPLOYEE/SBE/SM) reach the org-wide pages', () => {
    for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE', 'SBE', 'SM', 'CEO', 'MKTH']) {
      for (const route of WORKSPACE_ROUTES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} must open for ${role} (static)`);
      }
    }
    // ...while the privileged shells stay closed for them.
    for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE', 'SBE', 'SM', 'CEO', 'MKTH']) {
      for (const route of ADMIN_ONLY_ROUTES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), false, `${route} stays admin-only for ${role}`);
      }
      assert.equal(resolveFeatureRouteAccess('/settings/performance-diagnostics', role, undefined), false, `diagnostics stays admin-only for ${role}`);
    }
    // Roadshows are a deliberate grant, not an org-wide default.
    assert.equal(resolveFeatureRouteAccess('/roadshows', 'EMPLOYEE', undefined), false, 'employees need the roadshow grant');
    assert.equal(resolveFeatureRouteAccess('/roadshows', 'MANAGER', undefined), true, 'managers carry the roadshow default');
    // Reports: the CEO opens them by default, other catalogue roles do not.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'CEO', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'EMPLOYEE', undefined), false);
    // ...and an explicit toggle still opens them for anyone.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'EMPLOYEE', { menuAccess: { '/execution-intelligence': true } } as any), true);
  });
});
