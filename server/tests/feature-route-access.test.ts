/**
 * feature-route-access.test.ts — production-safety audit (this PR)
 * ------------------------------------------------------------------
 * Layer B (Feature Access) at the ROUTE level, documented in
 * docs/RBAC_FALLBACK_SAFETY_AUDIT.md:
 *
 *   1. resolveFeatureRouteAccess is a pure, fail-closed decision:
 *      ADMIN/SUPERADMIN pass (established bypass); an explicit dynamic
 *      menuAccess entry wins (true OR false); otherwise the static role
 *      fallback — identical to the sidebar;
 *   2. a disabled Feature Access module blocks its page route (typing the
 *      URL cannot bypass the sidebar);
 *   3. the registry, the routes wrapped in App.tsx, and the AppLayout
 *      sidebar stay in lockstep (no drift, no ungated page route);
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
  resolveFeatureRouteAccess,
} from '../../src/layouts/featureRouteAccess';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

const ALL_ROUTES = Object.keys(FEATURE_ROUTES);
const NON_ADMIN_ROLES = ['RO', 'RM', 'ASM', 'BDM', 'BE', 'BH'];
const WORKSPACE_ROUTES = ['/', '/workbench', '/activities', '/task-calendar', '/follow-up', '/leads', '/leads/new', '/settings', '/leads/:id'];
const INSIGHT_ROUTES = ['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'];
const ADMIN_ONLY_ROUTES = ['/leads/upload', '/leads/all', '/users'];

describe('resolveFeatureRouteAccess — pure Layer B decision', () => {
  it('ADMIN and SUPERADMIN pass every registered route, even when menuAccess disables it', () => {
    // menuAccess is keyed by PATH; disable every path explicitly.
    const allOff = Object.fromEntries(ALL_ROUTES.map(key => [FEATURE_ROUTES[key].path, false]));
    for (const route of ALL_ROUTES) {
      assert.equal(resolveFeatureRouteAccess(route, 'ADMIN', { menuAccess: allOff } as any), true, `ADMIN bypass for ${route}`);
      assert.equal(resolveFeatureRouteAccess(route, 'SUPERADMIN', { menuAccess: allOff } as any), true, `SUPERADMIN bypass for ${route}`);
    }
  });

  it('static role fallbacks mirror the sidebar for every role class', () => {
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

  it('fails closed on unknown route keys and missing roles', () => {
    assert.equal(resolveFeatureRouteAccess('/definitely-not-a-route', 'ADMIN', undefined), false, 'unknown route key fails closed even for ADMIN');
    assert.equal(resolveFeatureRouteAccess('/leads', null, undefined), false);
    assert.equal(resolveFeatureRouteAccess('/leads', '', undefined), false);
    assert.equal(resolveFeatureRouteAccess('/leads', '   ', undefined), false);
  });

  it('the registry covers every page route in App.tsx (no drift, none missing)', () => {
    const app = read('src/App.tsx');
    const wrapped = Array.from(app.matchAll(/<FeatureGate route="([^"]+)"/g), m => m[1]);
    assert.equal(wrapped.length, 18, 'exactly 18 page routes are wrapped in App.tsx');
    assert.equal(new Set(wrapped).size, wrapped.length, 'no duplicate FeatureGate routes');
    assert.deepEqual(
      [...new Set(wrapped)].sort(),
      [...ALL_ROUTES].sort(),
      'App.tsx wrapped routes must equal the FEATURE_ROUTES registry'
    );
    assert.ok(app.includes("import FeatureGate") || /import\s+FeatureGate/.test(app), 'App.tsx imports FeatureGate');
  });
});

describe('sidebar parity — AppLayout menuSections <-> FEATURE_ROUTES', () => {
  it('every sidebar menu path is gated by a route entry, and vice versa', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    const menuPaths = Array.from(layout.matchAll(/path: '([^']+)'/g), m => m[1]);
    assert.ok(menuPaths.length >= 17, `expected the full sidebar, found ${menuPaths.length} menu paths`);

    for (const p of menuPaths) {
      assert.ok(FEATURE_ROUTES[p], `menu path ${p} must have a FEATURE_ROUTES entry (page route gate)`);
    }
    for (const [route, entry] of Object.entries(FEATURE_ROUTES)) {
      assert.ok(
        menuPaths.includes(entry.path),
        `registry entry ${route} (path ${entry.path}) must map to a real sidebar module`
      );
    }
  });
});

describe('FeatureGate source guard (deny never renders the page)', () => {
  it('redirects on deny and resolves roles through the shared session cache', () => {
    const src = read('src/modules/auth/components/FeatureGate.tsx');
    assert.ok(src.includes('resolveFeatureRouteAccess(route, user.role, matchRole(roles, user))'), 'gate must use the shared pure decision');
    assert.ok(src.includes('<Navigate to="/" replace />'), 'deny must redirect, never render the page');
    assert.ok(src.includes('readSessionCache'), 'roles must come from the shared session cache (sidebar parity)');
    assert.ok(src.includes('adminService.getRoles()'), 'roles must load through the same API as the sidebar');
    assert.ok(src.includes('ROLES_CACHE_CHANGED_EVENT'), 'gate must refresh when role permissions change');
  });
});
