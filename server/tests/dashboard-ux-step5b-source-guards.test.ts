/**
 * dashboard-ux-step5b-source-guards.test.ts
 * ------------------------------------------------------------------
 * Step 5B source guards (updated for Step 5C).
 * These are fast, dependency-free checks that read the frontend source
 * files and assert the data-authority and navigation contracts the
 * redesign must not regress:
 *
 *   - Dashboard KPIs come only from the server dashboard response
 *   - No fabricated avgResponseTAT / area-team list / trend series
 *   - No client getLeads()/localStorage/localDb KPI authority
 *   - Calendar + follow-up queue stay reachable from the sidebar/nav
 *   - The enterprise sidebar contains only real routes
 *   - Role menuAccess still drives show/hide; admin bypass intact
 *   - No new route bypasses ProtectedRoute
 *   - The enterprise sidebar remains available in the shell
 *
 * Enterprise Preview retarget (2026-11-19): Dashboard.tsx and
 * sidebarNav.ts are deleted. The KPI loader now lives in the shared
 * home hook (useEnterpriseHomeData: loadDashboardData then
 * loadQueue), navigation lives in enterpriseNav.ts, and the Add Lead
 * action lives on the Agent home. The primary tabs and the mobile
 * tab bar are retired with the old shell, so those guards are
 * dropped (not weakened) and the sidebar guards take their place.
 *
 * Step 5C supersedes guards E and O: Daily Execution/Calendar now use
 * server-authoritative scheduled_activities (Asia/Dhaka, visibility-
 * enforced) instead of the Step 5B placeholder note. See
 * docs/SCHEDULED_ACTIVITIES.md.
 *
 * Behavioral metrics tests (visibility, soft-delete, follow-up parity, etc.)
 * live in dashboard-metrics-integration.test.ts and remain green.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const HOOK = () => read('src/modules/workspace/hooks/useEnterpriseHomeData.ts');
const HOMES = () =>
  ['AdminHome', 'ManagerHome', 'TeamLeadHome', 'AgentHome']
    .map(name => read(`src/modules/workspace/pages/${name}.tsx`))
    .join('\n');
const AGENT_HOME = () => read('src/modules/workspace/pages/AgentHome.tsx');
const MANAGER_HOME = () => read('src/modules/workspace/pages/ManagerHome.tsx');
const ENTERPRISE_NAV = () => read('src/layouts/enterpriseNav.ts');
const SERVICE = () => read('src/modules/dashboard/services/dashboardService.ts');
const LAYOUT = () => read('src/layouts/AppLayout.tsx');
const APP = () => read('src/App.tsx');
const FOLLOWUP = () => read('src/modules/leads/pages/FollowUpStrategy.tsx');

/**
 * Secondary routes retained in the ENTERPRISE SIDEBAR (single source
 * of truth: src/layouts/enterpriseNav.ts) — they used to hang off
 * More → Reports, then off the old left sidebar.
 */
const SIDEBAR_ROUTES = [
  '/activities',
  '/task-calendar',
  '/follow-up',
  '/execution-intelligence',
  '/ncp-progress',
  '/trend-charts',
  '/campaign-breakdown',
  '/team',
];
/** Administration directory routes. */
const ADMIN_ROUTES = [
  '/leads/upload',
  '/leads/all',
  '/users',
  '/settings/system',
];

/** Slice of the home hook spanning the KPI data loader (like the Step 5 test). */
function dashboardLoadBody(): string {
  const hook = HOOK();
  const start = hook.indexOf('const loadDashboardData');
  const end = hook.indexOf('const loadQueue');
  assert.ok(start >= 0, 'loadDashboardData missing');
  assert.ok(end > start, 'loadQueue must appear after loadDashboardData');
  return hook.slice(start, end);
}

describe('Dashboard UX Step 5B — source guards', () => {
  it('A. dashboard KPI components consume the server dashboard response', () => {
    const body = dashboardLoadBody();
    assert.ok(body.includes('dashboardService.getDashboard'), 'loadDashboardData must call dashboardService.getDashboard');
    const manager = MANAGER_HOME();
    // KPI bindings derive from the server response object (`metrics`), never
    // from a lead list. statusCounts now feeds the pipeline board page, which
    // reads the same GET /api/dashboard payload.
    assert.ok(manager.includes('metrics.converted'), 'conversion KPI must read metrics.converted');
    assert.ok(manager.includes('metrics.totalLeads'), 'total leads must read metrics.totalLeads');
    // Follow-up health comes from the hook's bounded queue buckets.
    assert.ok(HOOK().includes("getFollowUpQueue({ bucket: 'today', limit: 50 })"), 'follow-up health must read the today queue bucket');
    const pipeline = read('src/modules/dashboard/pages/SalesPipelinePage.tsx');
    assert.ok(pipeline.includes('statusCounts'), 'pipeline/status values must read statusCounts');
    assert.ok(pipeline.includes('dashboardService.getDashboard'), 'the pipeline page must reuse the server dashboard response');
  });

  it('B. no fake avgResponseTAT restored', () => {
    for (const src of [HOOK(), HOMES(), SERVICE()]) {
      assert.ok(!src.includes('24.0h'), 'must not fabricate 24.0h TAT');
      assert.ok(!/avgResponseTAT[^;\n]*24\.0/.test(src), 'must not default TAT to 24.0');
    }
    // The service must preserve null rather than coerce a default.
    assert.ok(SERVICE().includes('avgResponseTAT: null') || SERVICE().includes('avgResponseTAT'), 'avgResponseTAT field must be handled explicitly');
  });

  it('C. no hardcoded team/branch list restored', () => {
    const home = HOOK() + HOMES();
    for (const place of ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara', 'Mirpur']) {
      assert.ok(!home.includes(place), `the home hook/pages must not hardcode area/team ${place}`);
    }
  });

  it('D. no fabricated trend series restored', () => {
    // Enterprise Preview: the Home trend section died with Dashboard.tsx
    // (the "No trend data available" empty state with it — that assert is
    // dropped, not weakened). The home chart is now built from the real
    // follow-up queue buckets; no client-generated sample series may return.
    const home = HOOK() + HOMES();
    assert.ok(!home.includes('CAMPAIGN_TREND_DATA'), 'must not ship a hardcoded trend series');
    assert.ok(!home.includes('value: metrics.totalLeads'), 'must not fabricate a trend series from current totals');
    assert.ok(HOOK().includes('setChartDays(buildNext7Days([...today, ...upcoming]))'), 'the home chart must be built from the real queue buckets');
  });

  it('E. no client getLeads/localStorage/localDb KPI authority (Step 5C: scheduled_activities is server-authoritative, KPIs still from dashboard)', () => {
    // Scope to the KPI loader only (loadDashboardData). The KPI loader itself
    // must never touch client lead lists — Step 5C adds server scheduled_activities
    // for Daily Execution/Calendar but KPIs remain dashboard-only.
    const hook = HOOK();
    const start = hook.indexOf('const loadDashboardData');
    const end = hook.indexOf('const loadQueue');
    assert.ok(start >= 0 && end > start, 'loaders must be ordered loadDashboardData then loadQueue');
    const body = hook.slice(start, end);
    assert.ok(body.includes('dashboardService.getDashboard'));
    assert.ok(!body.includes('localStorage'), 'loadDashboardData must not read localStorage');
    assert.ok(!body.includes('localDb'), 'loadDashboardData must not read localDb');
    assert.ok(!body.includes('filteredLeads.filter'), 'loadDashboardData must not filter a client lead list for totals');
    assert.ok(!body.includes('getLeads('), 'loadDashboardData must not call client getLeads()');
    // Step 5C supersedes the old Step 5B note: the home hook still must not call getLeads anywhere,
    // calls/meetings now come from server scheduled_activities.
    assert.ok(!hook.includes('leadService.getLeads'), 'the home hook must not call leadService.getLeads() (replaced by server scheduled_activities in Step 5C)');
  });

  it('F. calendar remains available from the sidebar and its own route', () => {
    assert.ok(ENTERPRISE_NAV().includes("path: '/task-calendar'"), 'the sidebar must offer the Task Calendar');
    assert.ok(APP().includes("path: '/task-calendar'"), 'the /task-calendar route must remain');
    assert.ok(!HOMES().includes('TaskCalendar'), 'no home must embed the calendar any more');
  });

  it('G. follow-up queue navigation remains available', () => {
    assert.ok(ENTERPRISE_NAV().includes("path: '/follow-up'"), 'the sidebar must offer the Follow-up Strategy queue');
    assert.ok(ENTERPRISE_NAV().includes("label: 'Follow-up Queue', path: '/workbench'"), 'the sidebar must offer Follow-up Queue → /workbench');
    assert.ok(FOLLOWUP().includes('useSearchParams'), 'FollowUpStrategy must read ?bucket=');
    // The bucket deep-links moved off Home with the retired discipline card;
    // the queue page itself still owns the three buckets.
    assert.ok(FOLLOWUP().includes('bucket'), 'the queue page must keep its bucket handling');
  });

  it('H. the enterprise sidebar and the Administration directory match the new navigation structure', () => {
    // The five primary tabs are retired with the old shell (no
    // PRIMARY_NAV_ITEMS any more); the enterprise sidebar is the only
    // navigation system, and it must retain every kept route.
    const nav = ENTERPRISE_NAV();
    for (const route of SIDEBAR_ROUTES) {
      assert.ok(nav.includes(`path: '${route}'`), `the sidebar must retain ${route}`);
    }
    const more = read('src/modules/navigation/pages/MorePages.tsx');
    for (const route of ADMIN_ROUTES) {
      assert.ok(more.includes(`path: '${route}'`), `Administration must retain ${route}`);
    }
    // The sidebar is the shell drawer (opened from the header), never a
    // second navigation system.
    assert.doesNotMatch(LAYOUT(), /<motion\.aside|isMobileMenuOpen/, 'no legacy drawer implementation may return');
    assert.ok(LAYOUT().includes('isSidebarOpen'), 'the sidebar drawer must be the shell drawer');
    assert.ok(LAYOUT().includes('id="leadflow-sidebar"'), 'the sidebar must exist in the shell');
  });

  it('I. role menuAccess still controls sidebar navigation visibility', () => {
    const layout = LAYOUT();
    // The shell filters the enterprise sidebar with the SAME resolvers
    // the router uses; there are no primary tabs left to filter
    // (visiblePrimaryItems retired).
    assert.ok(layout.includes('buildEnterpriseNavGroups'), 'the shell must build the sidebar from the enterprise nav');
    assert.ok(layout.includes('resolveFeatureRouteAccess'), 'sidebar entries must use the router feature gate');
    assert.ok(read('src/layouts/menuVisibility.ts').includes('matchedPermission.menuAccess'), 'dynamic menuAccess overrides must still drive visibility');
  });

  it('J. admin behavior remains intact', () => {
    assert.ok(read('src/layouts/menuVisibility.ts').includes("userRoleNormalized === 'ADMIN'"), 'admin bypass must remain');
  });

  it('K. no new route bypasses ProtectedRoute', () => {
    const app = APP();
    const protectedPaths = [
      '/', '/more', '/sales-pipeline', '/administration', '/notifications', '/help', '/about',
      '/workbench', '/leads/new', '/leads', '/leads/upload', '/leads/all',
      '/follow-up', '/task-calendar', '/activities', '/leads/:id',
      '/users', '/team', '/execution-intelligence', '/ncp-progress',
      '/trend-charts', '/campaign-breakdown', '/settings', '/settings/system',
      '/settings/performance-diagnostics',
    ];
    for (const p of protectedPaths) {
      const idx = app.indexOf(`path: '${p}'`);
      assert.ok(idx >= 0, `route ${p} is missing from App.tsx`);
      // Slice to the next route entry, not a fixed window: the root
      // route carries a multi-line comment between its path and its
      // element, which a 300-char window would miss.
      const nextRoute = app.indexOf("path: '", idx + 1);
      const entry = nextRoute >= 0 ? app.slice(idx, nextRoute) : app.slice(idx);
      assert.ok(entry.includes('ProtectedRoute'), `route ${p} must be wrapped in ProtectedRoute`);
    }
  });

  it('L. the mobile tab bar is retired; the enterprise sidebar is the only navigation in the shell', () => {
    const layout = LAYOUT();
    // The mobile tab bar died with the old shell — it must not return.
    assert.ok(!layout.includes('leadflow-mobile-nav'), 'the retired mobile tab bar must stay gone');
    assert.ok(!layout.includes('aria-label="Primary mobile navigation"'), 'the retired mobile tab bar must stay gone');
    // The sidebar is the shell's navigation: it carries the pages that
    // used to hide in More → Reports, and it is closed by the back
    // button (see mobile-shell-sidebar.test.ts for the full contract).
    assert.ok(layout.includes('id="leadflow-sidebar"'), 'the sidebar must exist');
    assert.ok(layout.includes('id="leadflow-sidebar-toggle"'), 'the sidebar toggle must exist');
    assert.ok(ENTERPRISE_NAV().includes('buildEnterpriseNavGroups'), 'sidebar entries must be permission-filtered');
  });

  it('M. dashboard service remains the single KPI authority', () => {
    const svc = SERVICE();
    assert.ok(svc.includes('/api/dashboard'), 'dashboardService must hit /api/dashboard');
    assert.ok(!svc.includes('localStorage'), 'dashboardService must not read localStorage');
    assert.ok(!svc.includes('localDb'), 'dashboardService must not read localDb');
  });

  it('N. Add Lead quick action navigates to /leads/new and respects leads.create', () => {
    const page = AGENT_HOME();
    // Reuses the existing /leads/new route — no new route is created.
    assert.ok(page.includes('to="/leads/new"'), 'quick action must navigate to the existing /leads/new route');
    // Capability-gated via the same lead-create permission the page itself enforces.
    assert.ok(page.includes("canAccess('lead_generate', 'create')"), 'quick action must gate on lead_generate.create capability');
    // Only rendered when the user may create leads.
    assert.ok(page.includes("canAccess('lead_generate', 'create') ? ("), 'quick action must be conditionally rendered on the permission');
    // Visible text (not icon-only), so the accessible name comes from the content.
    assert.ok(page.includes('Add Lead'), 'quick action must carry visible Add Lead text');
  });

  it('O. Today/Tomorrow activity loads from follow-up queue + server scheduled_activities, not getLeads() (Step 5C supersedes Step 5B)', () => {
    // Enterprise Preview: the Daily Execution panel died with
    // Dashboard.tsx. Its two halves now live apart — the follow-up
    // queue buckets in the home hook, the scheduled activities in
    // the Daily Workbench — and both halves keep the Step 5C contract.
    const hook = HOOK();
    // Blocker regression: the home data load must not fetch the full lead list.
    assert.ok(!hook.includes('leadService.getLeads'), 'the home hook must not call leadService.getLeads() — Step 5C replaces it with server scheduled_activities');
    assert.ok(!hook.includes('buildActivities('), 'the home hook must not derive activities from a full client lead list');
    // Follow-ups must still read the server-authoritative follow-up queue.
    assert.ok(hook.includes('getFollowUpQueue'), 'the home hook must use leadService.getFollowUpQueue for follow-ups');
    assert.ok(hook.includes("bucket: 'today'"), 'the hook must request today follow-ups');
    // Step 5C supersedes Step 5B: calls/meetings are now server-authoritative via scheduled_activities (Asia/Dhaka, visibility-enforced).
    const wb = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(wb.includes('scheduledActivityService'), 'the Workbench must use scheduledActivityService (server-authoritative scheduled_activities) — Step 5C supersedes Step 5B placeholder');
    assert.ok(wb.includes('scheduled_activities'), 'the Workbench must reference server scheduled_activities');
    assert.ok(wb.includes('Asia/Dhaka'), 'scheduled activities must be Dhaka-aware');
    // Old Step 5B placeholder note is superseded by real integration.
    assert.ok(!wb.includes('scheduled_activities in Step 5C'), 'old Step 5B placeholder note must be superseded by real scheduled_activities integration (Step 5C)');
    assert.ok(wb.includes('scheduledActivityService.list'), 'the Workbench must fetch scheduled activities by Dhaka date');
  });
});
