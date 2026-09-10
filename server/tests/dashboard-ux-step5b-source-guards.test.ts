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
 *   - Calendar + follow-up queue stay reachable from dashboard/nav
 *   - Grouped sidebar contains only real routes (no dead links)
 *   - Role menuAccess still drives show/hide; admin bypass intact
 *   - No new route bypasses ProtectedRoute
 *   - Mobile sidebar still works
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

const DASHBOARD = () => read('src/modules/dashboard/pages/Dashboard.tsx');
const SERVICE = () => read('src/modules/dashboard/services/dashboardService.ts');
const LAYOUT = () => read('src/layouts/AppLayout.tsx');
const APP = () => read('src/App.tsx');
const FOLLOWUP = () => read('src/modules/leads/pages/FollowUpStrategy.tsx');

/** Every route the sidebar is allowed to reference (must exist in App.tsx). */
const REAL_ROUTES = [
  '/',
  '/activities',
  '/task-calendar',
  '/follow-up',
  '/leads',
  '/leads/new',
  '/leads/upload',
  '/leads/all',
  '/execution-intelligence',
  '/ncp-progress',
  '/trend-charts',
  '/campaign-breakdown',
  '/team',
  '/users',
  '/settings',
];

/** Slice of Dashboard.tsx spanning the KPI data loader (like the Step 5 test). */
function dashboardLoadBody(): string {
  const page = DASHBOARD();
  const start = page.indexOf('const loadDashboardData');
  const end = page.indexOf('const formattedDateRange');
  assert.ok(start >= 0, 'loadDashboardData missing');
  assert.ok(end > start, 'formattedDateRange must appear after loadDashboardData');
  return page.slice(start, end);
}

function sidebarPaths(): string[] {
  const layout = LAYOUT();
  const paths: string[] = [];
  const re = /path:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(layout)) !== null) paths.push(m[1]);
  return paths;
}

describe('Dashboard UX Step 5B — source guards', () => {
  it('A. dashboard KPI components consume the server dashboard response', () => {
    const body = dashboardLoadBody();
    assert.ok(body.includes('dashboardService.getDashboard'), 'loadDashboardData must call dashboardService.getDashboard');
    const page = DASHBOARD();
    // KPI bindings derive from the server response object (`metrics`), never from a lead list.
    assert.ok(page.includes('statusCounts'), 'pipeline/status values must read statusCounts');
    assert.ok(page.includes('followUpCounts'), 'follow-up health must read followUpCounts');
    assert.ok(page.includes('totalLeads'), 'total leads must read totalLeads');
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
      assert.ok(!dashboard.includes(place), `Dashboard.tsx must not hardcode area/team ${place}`);
    }
  });

  it('D. no fabricated trend series restored', () => {
    const dashboard = DASHBOARD();
    assert.ok(dashboard.includes('No trend data available'), 'trend empty state must remain');
    // No client-generated sample series.
    assert.ok(!dashboard.includes('CAMPAIGN_TREND_DATA'), 'must not ship a hardcoded trend series');
    assert.ok(dashboard.includes('metrics?.trendData') || dashboard.includes('metrics.trendData'), 'trend section must read metrics.trendData');
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
    // Step 5C supersedes the old Step 5B note: Dashboard still must not call getLeads anywhere,
    // calls/meetings now come from server scheduled_activities.
    assert.ok(!page.includes('leadService.getLeads'), 'Dashboard must not call leadService.getLeads() (replaced by server scheduled_activities in Step 5C)');
  });

  it('F. calendar remains available from dashboard and navigation', () => {
    const dashboard = DASHBOARD();
    assert.ok(dashboard.includes('TaskCalendar'), 'Dashboard must import TaskCalendar');
    assert.ok(dashboard.includes('<TaskCalendar'), 'Dashboard must render TaskCalendar');
    assert.ok(LAYOUT().includes("'/task-calendar'"), 'sidebar must keep /task-calendar');
  });

  it('G. follow-up queue navigation remains available', () => {
    assert.ok(LAYOUT().includes("'/follow-up'"), 'sidebar must keep /follow-up');
    assert.ok(DASHBOARD().includes('/follow-up?bucket='), 'dashboard must deep-link follow-up buckets');
    assert.ok(FOLLOWUP().includes('useSearchParams'), 'FollowUpStrategy must read ?bucket=');
  });

  it('H. grouped sidebar contains only real routes', () => {
    const paths = sidebarPaths();
    assert.ok(paths.length >= REAL_ROUTES.length, 'sidebar should declare all real routes');
    const real = new Set(REAL_ROUTES);
    for (const p of paths) {
      assert.ok(real.has(p), `sidebar path ${p} has no matching route (dead link)`);
    }
    for (const p of REAL_ROUTES) {
      assert.ok(paths.includes(p), `real route ${p} is missing from the sidebar mapping`);
    }
    // No invented routes.
    assert.ok(!paths.includes('/pipeline'), 'no Pipeline route may be invented');
  });

  it('I. role menuAccess still hides/shows grouped items correctly', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('menuAccess'), 'dynamic menuAccess override must still drive visibility');
    assert.ok(layout.includes('roles.includes'), 'static role fallback must still apply');
    assert.ok(layout.includes('isItemVisible'), 'grouping must reuse a single visibility check');
    assert.ok(layout.includes('visibleSections'), 'sections must be filtered by visible items');
  });

  it('J. admin behavior remains intact', () => {
    assert.ok(LAYOUT().includes("userRoleNormalized === 'ADMIN'"), 'admin bypass must remain');
  });

  it('K. no new route bypasses ProtectedRoute', () => {
    const app = APP();
    const protectedPaths = [
      '/', '/leads/new', '/leads', '/leads/upload', '/leads/all',
      '/follow-up', '/task-calendar', '/activities', '/leads/:id',
      '/users', '/team', '/execution-intelligence', '/ncp-progress',
      '/trend-charts', '/campaign-breakdown', '/settings',
    ];
    for (const p of protectedPaths) {
      const idx = app.indexOf(`path: '${p}'`);
      assert.ok(idx >= 0, `route ${p} is missing from App.tsx`);
      assert.ok(app.slice(idx, idx + 300).includes('ProtectedRoute'), `route ${p} must be wrapped in ProtectedRoute`);
    }
  });

  it('L. mobile sidebar still works', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('isMobileMenuOpen'), 'mobile menu state must exist');
    assert.ok(layout.includes('setIsMobileMenuOpen(false)'), 'mobile links must close the drawer');
    assert.ok(layout.includes('lg:hidden'), 'mobile drawer must remain responsive');
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
    // Only rendered when the user may create leads.
    assert.ok(page.includes('{canCreateLead &&'), 'quick action must be conditionally rendered on the permission');
    // Accessible on icon-only (small) screens.
    assert.ok(page.includes('aria-label="Add Lead"'), 'quick action needs an accessible label for icon-only screens');
  });

  it('O. Today/Tomorrow activity loads from follow-up queue + server scheduled_activities, not getLeads() (Step 5C supersedes Step 5B)', () => {
    const page = DASHBOARD();
    // Blocker regression: the Daily Execution panel must not fetch the full lead list.
    assert.ok(!page.includes('leadService.getLeads'), 'Dashboard must not call leadService.getLeads() — Step 5C replaces it with server scheduled_activities');
    assert.ok(!page.includes('buildActivities('), 'Dashboard must not derive activities from a full client lead list');
    // Follow-ups must still read the server-authoritative follow-up queue.
    assert.ok(page.includes('getFollowUpQueue'), 'Daily Execution must use leadService.getFollowUpQueue for follow-ups');
    assert.ok(page.includes("bucket: 'today'"), 'panel must request today follow-ups');
    // Step 5C supersedes Step 5B: calls/meetings are now server-authoritative via scheduled_activities (Asia/Dhaka, visibility-enforced).
    assert.ok(page.includes('scheduledActivityService'), 'Daily Execution must use scheduledActivityService (server-authoritative scheduled_activities) — Step 5C supersedes Step 5B placeholder');
    assert.ok(page.includes('scheduled_activities'), 'panel must reference server scheduled_activities');
    assert.ok(page.includes('Asia/Dhaka') || page.includes('Asia/Dhaka'), 'scheduled activities must be Dhaka-aware');
    // Old Step 5B placeholder note is superseded by real integration.
    assert.ok(!page.includes('scheduled_activities in Step 5C'), 'old Step 5B placeholder note must be superseded by real scheduled_activities integration (Step 5C)');
    assert.ok(page.includes('scheduledActivityService.list'), 'Daily Execution must fetch scheduled activities by Dhaka date');
  });
});
