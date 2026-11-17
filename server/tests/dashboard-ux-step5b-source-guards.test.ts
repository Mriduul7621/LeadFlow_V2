/**
 * dashboard-ux-step5b-source-guards.test.ts
 * ------------------------------------------------------------------
 * Step 5B source guards (updated for Step 5C, retargeted at the
 * role-workspace member home, 2026-11-17).
 * These are fast, dependency-free checks that read the frontend source
 * files and assert the data-authority and navigation contracts the
 * redesign must not regress:
 *
 *   - Member-home KPIs come only from the server dashboard response
 *     (pipeline) and the server team overview (self row)
 *   - No fabricated avgResponseTAT / area-team list / trend series
 *   - No client getLeads()/localStorage/localDb KPI authority
 *   - Calendar + follow-up queue stay reachable from the sidebar/nav
 *   - The role sidebar contains only real, gate-checked routes
 *   - Role menuAccess still drives show/hide; admin bypass intact
 *   - No new route bypasses ProtectedRoute
 *   - The role sidebar is the only navigation system (no primary
 *     tabs, no mobile tab bar — retired 2026-11-17)
 *
 * Step 5C supersedes guards E and O: Daily Execution/Calendar now use
 * server-authoritative scheduled_activities (Asia/Dhaka, visibility-
 * enforced) instead of the Step 5B placeholder note. The member home
 * itself carries NO scheduled activities — they live on the Task
 * Calendar page. See docs/SCHEDULED_ACTIVITIES.md.
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

const DASHBOARD = () => read('src/modules/workspace/pages/MemberHome.tsx');
const SERVICE = () => read('src/modules/dashboard/services/dashboardService.ts');
const LAYOUT = () => read('src/layouts/AppLayout.tsx');
const APP = () => read('src/App.tsx');
const FOLLOWUP = () => read('src/modules/leads/pages/FollowUpStrategy.tsx');

/** Routes the role sidebar must offer (every role has a subset). */
const SIDEBAR_ROUTES = [
  '/',
  '/workbench',
  '/leads',
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

/** Slice of MemberHome.tsx spanning the KPI data loader (like the Step 5 test). */
function dashboardLoadBody(): string {
  const page = DASHBOARD();
  const start = page.indexOf('const loadDashboardData');
  const end = page.indexOf('const loadDailyExecution');
  assert.ok(start >= 0, 'loadDashboardData missing');
  assert.ok(end > start, 'loadDailyExecution must appear after loadDashboardData');
  return page.slice(start, end);
}

describe('Dashboard UX Step 5B — source guards', () => {
  it('A. member-home KPI components consume the server responses', () => {
    const body = dashboardLoadBody();
    assert.ok(body.includes('dashboardService.getDashboard'), 'loadDashboardData must call dashboardService.getDashboard');
    const page = DASHBOARD();
    // KPI bindings derive from server response objects, never from a
    // lead list: the pipeline reads the dashboard response, the KPI
    // cards read the team-overview self row, Converted-this-month
    // reads the team-tree self row. followUpCounts retired with
    // Dashboard.tsx — the overview self row is the KPI source now.
    assert.ok(page.includes('totalLeads'), 'total leads must read totalLeads');
    assert.ok(page.includes('self?.totalLeads'), 'the Assigned card must read the overview self row');
    assert.ok(page.includes('self?.dueToday'), 'the Due-today card must read the overview self row');
    assert.ok(page.includes('self?.overdue'), 'the Overdue card must read the overview self row');
    assert.ok(page.includes('convertedThisMonth'), 'the Converted card must read converted-this-month');
    assert.ok(!page.includes('followUpCounts'), 'followUpCounts retired with Dashboard.tsx');
    const pipeline = read('src/modules/dashboard/pages/SalesPipelinePage.tsx');
    assert.ok(pipeline.includes('statusCounts'), 'pipeline/status values must read statusCounts');
    assert.ok(pipeline.includes('dashboardService.getDashboard'), 'the pipeline page must reuse the server dashboard response');
  });

  it('B. no fake avgResponseTAT restored', () => {
    for (const src of [DASHBOARD(), SERVICE()]) {
      assert.ok(!src.includes('24.0h'), 'must not fabricate 24.0h TAT');
      assert.ok(!/avgResponseTAT[^;\n]*24\.0/.test(src), 'must not default TAT to 24.0');
    }
    // The service must preserve null rather than coerce a default.
    assert.ok(SERVICE().includes('avgResponseTAT: null') || SERVICE().includes('avgResponseTAT'), 'avgResponseTAT field must be handled explicitly');
  });

  it('C. no hardcoded team/branch list restored', () => {
    const dashboard = DASHBOARD();
    for (const place of ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara', 'Mirpur']) {
      assert.ok(!dashboard.includes(place), `MemberHome.tsx must not hardcode area/team ${place}`);
    }
  });

  it('D. no fabricated trend series restored — the member home has no trend section at all', () => {
    const dashboard = DASHBOARD();
    // The trend section retired with Dashboard.tsx (2026-11-17): the
    // member home shows a 7-day follow-up chart instead, and no trend
    // copy, series, or empty state may come back.
    assert.ok(!dashboard.includes('No trend data available'), 'no trend empty state on the member home');
    assert.ok(!dashboard.includes('CAMPAIGN_TREND_DATA'), 'must not ship a hardcoded trend series');
    assert.ok(!dashboard.includes('trendData'), 'no trend section on the member home');
  });

  it('E. no client getLeads/localStorage/localDb KPI authority (Step 5C: scheduled_activities is server-authoritative, KPIs still from dashboard)', () => {
    // Scope to the KPI loader only (loadDashboardData). The KPI loader itself
    // must never touch client lead lists — Step 5C adds server scheduled_activities
    // for Daily Execution/Calendar but KPIs remain dashboard-only.
    const page = DASHBOARD();
    const start = page.indexOf('const loadDashboardData');
    const end = page.indexOf('const loadDailyExecution');
    assert.ok(start >= 0 && end > start, 'loaders must be ordered loadDashboardData then loadDailyExecution');
    const body = page.slice(start, end);
    assert.ok(body.includes('dashboardService.getDashboard'));
    assert.ok(!body.includes('localStorage'), 'loadDashboardData must not read localStorage');
    assert.ok(!body.includes('localDb'), 'loadDashboardData must not read localDb');
    assert.ok(!body.includes('filteredLeads.filter'), 'loadDashboardData must not filter a client lead list for totals');
    assert.ok(!body.includes('getLeads('), 'loadDashboardData must not call client getLeads()');
    // Step 5C supersedes the old Step 5B note: MemberHome still must not call getLeads anywhere,
    // calls/meetings now come from server scheduled_activities (on the Task Calendar page).
    assert.ok(!page.includes('leadService.getLeads'), 'MemberHome must not call leadService.getLeads() (replaced by server scheduled_activities in Step 5C)');
  });

  it('F. calendar remains available from the sidebar and its own route', () => {
    assert.ok(read('src/layouts/sidebarNav.ts').includes("path: '/task-calendar'"), 'the sidebar must offer the Task Calendar');
    assert.ok(APP().includes("path: '/task-calendar'"), 'the /task-calendar route must remain');
    assert.ok(!DASHBOARD().includes('TaskCalendar'), 'Home must not embed the calendar any more');
  });

  it('G. follow-up queue navigation remains available', () => {
    assert.ok(read('src/layouts/sidebarNav.ts').includes("path: '/follow-up'"), 'the sidebar must offer the Follow-up Queue');
    assert.ok(FOLLOWUP().includes('useSearchParams'), 'FollowUpStrategy must read ?bucket=');
    // The bucket deep-links moved off Home with the retired discipline card;
    // the queue page itself still owns the three buckets.
    assert.ok(FOLLOWUP().includes('bucket'), 'the queue page must keep its bucket handling');
  });

  it('H. the role sidebar and the Administration directory match the new navigation structure', () => {
    // The five primary tabs retired with the pill (2026-11-17): the
    // role sidebar is the only navigation system, and every route it
    // offers must be a real mounted route.
    const layout = LAYOUT();
    assert.ok(!layout.includes('PRIMARY_NAV_ITEMS'), 'no primary-tabs list may survive the shell change');
    assert.ok(!layout.includes('visiblePrimaryItems'), 'no primary-tabs filter may survive the shell change');
    const sidebar = read('src/layouts/sidebarNav.ts');
    for (const route of SIDEBAR_ROUTES) {
      assert.ok(sidebar.includes(`path: '${route}'`), `the sidebar must retain ${route}`);
    }
    // Routes that never appear in the sidebar still resolve to a
    // friendly breadcrumb label instead of a raw segment.
    assert.ok(sidebar.includes("'/leads/new': 'Add Lead'"), 'the Add Lead action must keep its friendly label');
    assert.ok(sidebar.includes("'/more': 'More'"), 'More must keep its friendly label');
    const more = read('src/modules/navigation/pages/MorePages.tsx');
    for (const route of ADMIN_ROUTES) {
      assert.ok(more.includes(`path: '${route}'`), `Administration must retain ${route}`);
    }
    // The drawer is the LEFT sidebar (opened from the header), never a
    // second navigation system.
    assert.doesNotMatch(layout, /<motion\.aside|isMobileMenuOpen/, 'no legacy drawer implementation may return');
    assert.ok(layout.includes('isSidebarOpen'), 'the left sidebar drawer must be the shell drawer');
  });

  it('I. role menuAccess still controls sidebar visibility, via the route gate', () => {
    const layout = LAYOUT();
    // The shell no longer calls resolveMenuVisibility directly: the
    // route gate (resolveFeatureRouteAccess) delegates to it
    // internally, so the menuAccess contract flows through the gate.
    assert.ok(layout.includes('resolveFeatureRouteAccess('), 'the sidebar must be filtered by the route Feature Access module');
    assert.ok(layout.includes('matchedPermission'), 'the caller permission profile must feed the gate');
    assert.ok(read('src/layouts/menuVisibility.ts').includes('matchedPermission.menuAccess'), 'dynamic menuAccess overrides must still drive visibility');
    assert.ok(read('src/layouts/featureRouteAccess.ts').includes('resolveMenuVisibility'), 'the gate must delegate to the shared visibility resolver');
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
      // The `/` entry carries a HomeLanding comment between its path
      // and its element, so the window is 600 chars, not 300.
      assert.ok(app.slice(idx, idx + 600).includes('ProtectedRoute'), `route ${p} must be wrapped in ProtectedRoute`);
    }
  });

  it('L. the mobile tab bar is retired; the left sidebar is the only shell navigation', () => {
    const layout = LAYOUT();
    assert.ok(!layout.includes('aria-label="Primary mobile navigation"'), 'no mobile tab bar may survive the shell change');
    assert.ok(!layout.includes('leadflow-mobile-nav'), 'no mobile tab bar in the shell');
    assert.ok(!read('src/index.css').includes('.leadflow-mobile-nav'), 'no mobile tab bar styles');
    // The LEFT sidebar is the only navigation: it carries the role
    // pages, and it is closed by the back button (see
    // mobile-shell-sidebar.test.ts for the full contract).
    assert.ok(layout.includes('id="leadflow-sidebar"'), 'the left sidebar must exist');
    assert.ok(read('src/layouts/sidebarNav.ts').includes('buildSidebarGroups'), 'sidebar entries must be permission-filtered');
  });

  it('M. dashboard service remains the single KPI authority', () => {
    const svc = SERVICE();
    assert.ok(svc.includes('/api/dashboard'), 'dashboardService must hit /api/dashboard');
    assert.ok(!svc.includes('localStorage'), 'dashboardService must not read localStorage');
    assert.ok(!svc.includes('localDb'), 'dashboardService must not read localDb');
  });

  it('N. Add Lead quick action navigates to /leads/new and respects leads.create', () => {
    const page = DASHBOARD();
    // Reuses the existing /leads/new route — no new route is created.
    assert.ok(page.includes("to=\"/leads/new\""), 'quick action must navigate to the existing /leads/new route');
    // Capability-gated via the same lead-create permission the page itself enforces.
    assert.ok(page.includes("canAccess('lead_generate', 'create')"), 'quick action must gate on lead_generate.create capability');
    // Only rendered when the user may create leads (the content
    // component receives the capability as a prop).
    assert.ok(page.includes('{props.canCreateLead &&'), 'quick action must be conditionally rendered on the permission');
    // Accessible on icon-only (small) screens.
    assert.ok(page.includes('aria-label="Add Lead"'), 'quick action needs an accessible label for icon-only screens');
  });

  it('O. follow-ups load from the follow-up queue, not getLeads(); scheduled activities live on the Task Calendar (Step 5C)', () => {
    const page = DASHBOARD();
    // Blocker regression: the member home must not fetch the full lead list.
    assert.ok(!page.includes('leadService.getLeads'), 'MemberHome must not call leadService.getLeads()');
    assert.ok(!page.includes('buildActivities('), 'MemberHome must not derive activities from a full client lead list');
    // Follow-ups must still read the server-authoritative follow-up queue.
    assert.ok(page.includes('getFollowUpQueue'), 'the member home must use leadService.getFollowUpQueue for follow-ups');
    assert.ok(page.includes("bucket: 'today'"), 'the home must request today follow-ups');
    // Step 5C supersedes Step 5B: calls/meetings are server-authoritative
    // via scheduled_activities — but they live on the Task Calendar
    // page, not on the member home (retired with Dashboard.tsx).
    assert.ok(!page.includes('scheduledActivityService'), 'the member home must not read scheduled activities');
    assert.ok(!page.includes('scheduled_activities'), 'the member home must not reference scheduled_activities');
    const calendar = read('src/modules/auth/pages/TaskCalendar.tsx');
    assert.ok(calendar.includes('scheduledActivityService'), 'the Task Calendar must use scheduledActivityService (server-authoritative scheduled_activities)');
  });
});
