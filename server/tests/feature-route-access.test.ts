/**
 * feature-route-access.test.ts — production-safety audit (this PR)
 * ------------------------------------------------------------------
 * Layer B (Feature Access) at the ROUTE level, documented in
 * docs/RBAC_FALLBACK_SAFETY_AUDIT.md:
 *
 *   1. resolveFeatureRouteAccess is a pure, fail-closed decision:
 *      ADMIN/SUPERADMIN pass (established bypass); an explicit dynamic
 *      menuAccess entry wins (true OR false); otherwise the static role
 *      fallback — identical to the enterprise sidebar navigation;
 *   2. a disabled Feature Access module blocks its page route (typing the
 *      URL cannot bypass the sidebar);
 *   3. the registry, the routes wrapped in App.tsx, and the enterprise
 *      sidebar navigation stay in lockstep (no drift, no ungated page route);
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
// Team Lead / Manager / Admin workspace (2026-11-20): My Leads and
// Self Performance are EVERYONE routes (their pages gate on the
// display role themselves); User Management is ADMIN_ONLY with the
// teamLeadAllowed / managerAllowed predicates (like Lead Intake).
const WORKSPACE_ROUTES = ['/', '/more', '/notifications', '/help', '/about', '/sales-pipeline', '/workbench', '/activities', '/task-calendar', '/follow-up', '/leads', '/leads/new', '/leads/my', '/performance/self', '/settings', '/leads/:id'];
const INSIGHT_ROUTES = ['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'];
const ADMIN_ONLY_ROUTES = ['/administration', '/settings/system', '/settings/status-pipeline', '/settings/products-campaigns', '/leads/upload', '/leads/all', '/users', '/users/team'];

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

    // Insight/report pages follow the DEFAULT `reports.view` grant table
    // (decided 2026-10-15): the client fallback derives from it, so the
    // page gate cannot disagree with the server permission again.
    // Enterprise Preview (2026-11-19): FIELD_EXEC now carries
    // `reports.view` by default, so the field roles open the insight
    // pages too — the agent's MY PERFORMANCE nav needs them.
    for (const route of INSIGHT_ROUTES) {
      for (const role of ['MANAGER', 'SM', 'RM', 'TEAM_LEAD', 'BDM', 'ASM', 'CEO', 'BH', 'RO', 'BE', 'SBE', 'EMPLOYEE']) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} open for ${role} (holds reports.view)`);
      }
    }

    assert.equal(resolveFeatureRouteAccess('/team', 'RM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'ASM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BDM', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BE', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/team', 'BH', undefined), true);
    // FIX-1: /team is open to everyone now — the overview endpoint
    // scopes the data server-side (a leaf employee sees only themself),
    // which is the owner's model; the old static role list is gone.
    assert.equal(resolveFeatureRouteAccess('/team', 'RO', undefined), true, 'Team overview open for RO (data scoped server-side)');
    assert.equal(resolveFeatureRouteAccess('/team/organogram', 'RO', undefined), true, 'Organogram inherits the open Team module');

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
    assert.equal(resolveFeatureRouteAccess('/team', 'RO', { menuAccess: {} } as any), true, 'FIX-1: Team overview static fallback is open; an empty profile cannot close it');
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

describe('enterprise sidebar navigation — route coverage', () => {
  it('the retired primary tabs are gone; the enterprise nav owns every secondary page', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    // Enterprise Preview (2026-11-19): the five primary tabs retired
    // with the old shell — the role-based enterprise sidebar
    // (src/layouts/enterpriseNav.ts) is the only navigation surface now.
    assert.ok(!layout.includes('PRIMARY_NAV_ITEMS'), 'the primary-tab config must stay retired');
    assert.ok(!layout.includes('MORE_NAV_PATHS'), 'the More-directory config must stay retired');
    assert.ok(layout.includes('buildEnterpriseNavGroups('), 'the sidebar must come from the enterprise nav module, not a hardcoded list');
    assert.ok(layout.includes('resolveFeatureRouteAccess('), 'entries must be filtered by the route Feature Access module');
    assert.ok(layout.includes('sidebarGroups.map('), 'the sidebar must render the resolved groups');
    assert.ok(layout.includes('isSidebarOpen'), 'the left sidebar drawer owns the shell drawer state');
    assert.doesNotMatch(layout, /<motion\.aside|isMobileMenuOpen/, 'no legacy drawer implementation may return');

    const nav = read('src/layouts/enterpriseNav.ts');
    for (const p of ['/activities', '/task-calendar', '/follow-up', '/team', '/execution-intelligence', '/roadshows']) {
      assert.ok(nav.includes(`path: '${p}'`), `the enterprise nav must include ${p}`);
      assert.ok(FEATURE_ROUTES[p], `nav path ${p} must have a FEATURE_ROUTES entry (page route gate)`);
    }
    // Team Lead / Manager / Admin workspace (2026-11-20, Mahadi's
    // sidebar lists): NCP Progress, Trends & Reports, Campaigns
    // and Sales Pipeline left the TL/Manager/Admin sidebars (the
    // agent never had them) — they are NOT sidebar entries
    // anymore, but their routes stay registered in FEATURE_ROUTES
    // and App.tsx, live by URL. The nav-coverage rule is now:
    // every nav destination is registered; registered routes need
    // not be nav destinations.
    const appForNav = read('src/App.tsx');
    for (const p of ['/ncp-progress', '/trend-charts', '/campaign-breakdown', '/sales-pipeline']) {
      assert.ok(!nav.includes(`path: '${p}'`), `the enterprise nav must NOT include ${p} anymore`);
      assert.ok(FEATURE_ROUTES[p], `${p} stays registered in FEATURE_ROUTES (live by URL)`);
      assert.ok(appForNav.includes(`<FeatureGate route="${p}">`), `${p} stays wrapped in App.tsx`);
    }

    // `/` renders the derived role overview directly (no landing
    // redirect, no Workbench-first bounce).
    const app = read('src/App.tsx');
    assert.ok(app.includes('page={<EnterpriseHome />}'), 'the / route must render EnterpriseHome directly');

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
    // disagree about which matrix they were reading. Both calls also
    // carry the team fact (2026-11-19): the `teamLeadAllowed`
    // predicate needs has-subordinate, and the wait-check needs to
    // know whether the team overview has settled yet. The
    // `managerAllowed` predicate (2026-11-20) adds the derived
    // enterprise-role fact the same way, with its own settle flag.
    assert.ok(src.includes('const matched = matchRole(roles, user);'), 'gate must resolve the role row once');
    assert.ok(src.includes('canResolveRouteAccess(route, user.role, matched, { teamSettled, roleSettled })'), 'gate must check whether the decision is final yet');
    assert.ok(src.includes('resolveFeatureRouteAccess(route, user.role, matched, { hasSubordinates, isManager })'), 'gate must use the shared pure decision');
    assert.ok(src.includes('useCallerTeam()'), 'gate must read the team overview for the team-lead predicate');
    assert.ok(src.includes('callerHasTeam(callerTeam.overview?.people)'), 'gate must derive has-subordinate from the overview');
    assert.ok(src.includes('useEnterpriseRole()'), 'gate must read the derived enterprise role for the manager predicate');
    assert.ok(src.includes("enterpriseRole.role === 'manager'"), 'gate must derive isManager from the enterprise role');
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
    // Reports: every standard role opens them by default — managers and
    // team leads hold reports.view, and since the Enterprise Preview
    // (2026-11-19) the field roles do too (FIELD_EXEC carries it).
    // A custom code still fails closed until an admin grants the page.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'CEO', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'MANAGER', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'TEAM_LEAD', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'EMPLOYEE', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'MKTH', undefined), false, 'custom roles fail closed');
    // ...and an explicit toggle still opens them for anyone.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'MKTH', { menuAccess: { '/execution-intelligence': true } } as any), true);
    // ...while an explicit deny still hides them from a default holder.
    assert.equal(resolveFeatureRouteAccess('/execution-intelligence', 'EMPLOYEE', { menuAccess: { '/execution-intelligence': false } } as any), false);
  });
});

describe('the Team Lead / Manager / Admin workspace routes (2026-11-20)', () => {
  it('My Leads and Self Performance are open to everyone (their pages gate on the display role)', () => {
    for (const route of ['/leads/my', '/performance/self']) {
      for (const role of ['RO', 'TEAM_LEAD', 'MANAGER', 'EMPLOYEE', 'ADMIN']) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} open for ${role}`);
      }
    }
    // An explicit menuAccess deny still closes them (the pages are
    // keyed to their parent modules).
    assert.equal(resolveFeatureRouteAccess('/leads/my', 'RO', { menuAccess: { '/leads': false } } as any), false, 'My Leads inherits the /leads module toggle');
    assert.equal(resolveFeatureRouteAccess('/performance/self', 'RO', { menuAccess: { '/execution-intelligence': false } } as any), false, 'Self Performance inherits the /execution-intelligence module toggle');
  });

  it('User Management is admin-only statically, and opens through the team-lead / manager predicates', () => {
    assert.equal(resolveFeatureRouteAccess('/users/team', 'RO', undefined), false, 'a plain agent cannot open User Management');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'TEAM_LEAD', undefined), false, 'no context, no predicate');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'TEAM_LEAD', undefined, { hasSubordinates: true }), true, 'a team lead with subordinates opens it');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'TEAM_LEAD', undefined, { hasSubordinates: false }), false, 'a team lead with no subordinates does not');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'MANAGER', undefined, { isManager: true }), true, 'a manager opens it');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'MANAGER', undefined, { isManager: false }), false, 'a non-manager does not');
    // An explicit menuAccess entry wins over the predicates either way.
    assert.equal(resolveFeatureRouteAccess('/users/team', 'TEAM_LEAD', { menuAccess: { '/users': false } } as any, { hasSubordinates: true }), false, 'an explicit deny beats the predicate');
    assert.equal(resolveFeatureRouteAccess('/users/team', 'RO', { menuAccess: { '/users': true } } as any), true, 'an explicit grant opens it for anyone');
  });

  it('Lead Intake opens for Managers too (managerAllowed), not just team leads', () => {
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'MANAGER', undefined, { isManager: true }), true, 'a manager opens Lead Intake');
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'MANAGER', undefined, { isManager: false, hasSubordinates: false }), false, 'a non-manager without a team does not');
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'TEAM_LEAD', undefined, { hasSubordinates: true }), true, 'the team-lead arm still works');
    assert.equal(resolveFeatureRouteAccess('/leads/upload', 'TEAM_LEAD', undefined, { hasSubordinates: false, isManager: false }), false, 'neither arm, no access');
  });

  it('canResolveRouteAccess waits for the enterprise-role derivation on managerAllowed routes', () => {
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'MANAGER', undefined, { teamSettled: true, roleSettled: false }),
      false,
      'the manager fact is still loading — wait, never bounce',
    );
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'MANAGER', undefined, { teamSettled: true, roleSettled: true }),
      false,
      'even settled, the matrix itself is still missing — the wait continues',
    );
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'MANAGER', { menuAccess: {} } as any, { teamSettled: true, roleSettled: true }),
      true,
      'matrix + team + role settled — the decision runs',
    );
    // An explicit menuAccess entry decides without the role fact.
    assert.equal(
      canResolveRouteAccess('/leads/upload', 'MANAGER', { menuAccess: { '/leads/upload': true } } as any, { teamSettled: false, roleSettled: false }),
      true,
      'an explicit entry wins — no wait needed',
    );
    // Non-predicate routes never wait on the role fact.
    assert.equal(canResolveRouteAccess('/leads', 'RO', undefined, { teamSettled: true, roleSettled: false }), true, 'ANY_ROLE routes decide immediately');
  });
});
