import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * dashboard-ux-step5b.test.ts
 * ------------------------------------------------------------------
 * Static content assertions for Step 5B (dashboard navigation + role-aligned
 * workspace redesign). These tests do not spin up a browser/React renderer —
 * consistent with the rest of this repo's test suite (`tsx --test`, no DOM
 * test runner) — and instead assert on the exact source invariants the PR
 * spec requires: server-authoritative data usage, honest labeling, no dead
 * routes, and that the pre-existing permission/menuAccess architecture is
 * reused rather than replaced.
 */

function read(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8');
}

const DASHBOARD_PAGE = 'src/modules/dashboard/pages/Dashboard.tsx';
const APP_LAYOUT = 'src/layouts/AppLayout.tsx';
const APP_ROUTES = 'src/App.tsx';
const FOLLOW_UP_PAGE = 'src/modules/leads/pages/FollowUpStrategy.tsx';
const USER_MANAGEMENT = 'src/modules/users/pages/UserManagement.tsx';
const ADMIN_SERVICE = 'src/modules/admin/services/adminService.ts';
const PROTECTED_ROUTE = 'src/modules/auth/components/ProtectedRoute.tsx';

describe('Step 5B — Dashboard UX + Sidebar + Role Access Alignment', () => {
  it('A. Dashboard KPI/pipeline/follow-up sections consume the server-authoritative dashboardService.getDashboard payload only', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(page.includes('dashboardService.getDashboard'));
    assert.ok(page.includes('setStatusCounts(metrics.statusCounts'));
    assert.ok(page.includes('setFollowUpCounts(metrics.followUpCounts'));
    assert.ok(page.includes('setTotalLeads(metrics.totalLeads'));
    assert.ok(page.includes('setConvertedCount(metrics.converted'));
    assert.ok(page.includes('setPipelineLockedCount(metrics.pipelineLocked'));
  });

  it('B. Dashboard never restores a fabricated avgResponseTAT default', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(!page.includes("avgResponseTAT: '24.0h'"));
    assert.ok(!page.includes('avgResponseTAT ?? \'24.0h\''));
    // The only literal fallback allowed is null / 'N/A' display, never a fabricated hours string.
    assert.ok(page.includes("stats.avgResponseTAT ?? 'N/A'"));
  });

  it('C. Dashboard does not hardcode a team/branch/area list for Team Performance', () => {
    const page = read(DASHBOARD_PAGE);
    for (const place of ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara', 'Mirpur']) {
      assert.ok(!page.includes(place), `Dashboard.tsx must not hardcode area/team name ${place}`);
    }
    // Team performance table renders only from server-provided teamStats — an
    // explicit unavailable state is shown when it is empty (Step 5 behavior preserved).
    assert.ok(page.includes('teamStats.length === 0'));
    assert.ok(page.includes('Team performance unavailable'));
  });

  it('D. Dashboard does not fabricate a client-generated trend series', () => {
    const page = read(DASHBOARD_PAGE);
    const loadStart = page.indexOf('const loadDashboardData');
    const loadEnd = page.indexOf('const formattedDateRange');
    const loadBody = page.slice(loadStart, loadEnd);
    assert.ok(!loadBody.includes('value: metrics.totalLeads'));
    assert.ok(page.includes('No trend data available'));
    assert.ok(page.includes('setTrendData(Array.isArray(metrics.trendData) ? metrics.trendData : [])'));
  });

  it('E. Dashboard does not derive KPI/queue totals from client getLeads()/localStorage/localDb', () => {
    const page = read(DASHBOARD_PAGE);
    const loadStart = page.indexOf('const loadDashboardData');
    const loadEnd = page.indexOf('const formattedDateRange');
    const loadBody = page.slice(loadStart, loadEnd);
    assert.ok(!loadBody.includes('localStorage'));
    assert.ok(!loadBody.includes('localDb'));
    assert.ok(!loadBody.includes('filteredLeads.filter'));
    // The Daily Execution feed intentionally reuses leadService.getLeads() +
    // activityEngine (same as the standalone Activities page) for a *display*
    // convenience list — but that call must live outside loadDashboardData
    // and must never feed the KPI state setters above.
    assert.ok(!loadBody.includes('leadService.getLeads'));
    assert.ok(page.includes('leadService.getLeads({ employeeId: user.employeeId, role: user.role })'));
  });

  it('F. Daily Execution reuses the existing TaskCalendar embed; Calendar route stays reachable', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(page.includes("import TaskCalendar from '../../auth/pages/TaskCalendar'"));
    assert.ok(page.includes('<TaskCalendar embedded={true} />'));
    const routes = read(APP_ROUTES);
    assert.ok(routes.includes("path: '/task-calendar'"));
    assert.ok(routes.includes('<TaskCalendar />'));
  });

  it('G. Follow-up Health cards link into /follow-up with a bucket query param (no local re-derivation)', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(page.includes('to={`/follow-up?bucket=${card.bucket}`}'));
    assert.ok(page.includes('followUpCounts.overdue'));
    assert.ok(page.includes('followUpCounts.today'));
    assert.ok(page.includes('followUpCounts.upcoming'));

    const followUp = read(FOLLOW_UP_PAGE);
    assert.ok(followUp.includes('readBucketFromSearch'));
    assert.ok(followUp.includes("useLocation"));
    assert.ok(followUp.includes('leadService.getFollowUpQueue'));
    assert.ok(!followUp.includes('localStorage'));
  });

  it('H. Needs Attention only surfaces authoritative fields and shows the deferred-scope placeholder', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(page.includes('Needs Attention'));
    assert.ok(page.includes('Additional attention rules coming in a later phase.'));
    // Must not implement any of the deferred scoring rules in this PR.
    for (const forbidden of ['untouched>24h', 'overdue>3days', 'inactivePipelineScore', 'noNextActionScore', 'leadScore']) {
      assert.ok(!page.includes(forbidden));
    }
  });

  it('I. Campaign/status breakdown is honestly labeled "Lead Status Distribution", not "Campaign Performance"', () => {
    const page = read(DASHBOARD_PAGE);
    assert.ok(page.includes('Lead Status Distribution'));
    assert.ok(!page.includes('Campaign Performance Intelligence'));
    assert.ok(!page.includes('Campaign Performance Breakdown'));
  });

  it('J. Sidebar is grouped (OVERVIEW/MY WORK/LEADS/INSIGHTS/MANAGEMENT/SYSTEM) using only the explicit existing route list — no invented Pipeline route', () => {
    const layout = read(APP_LAYOUT);
    for (const group of ['OVERVIEW', 'MY_WORK', 'LEADS', 'INSIGHTS', 'MANAGEMENT', 'SYSTEM']) {
      assert.ok(layout.includes(`'${group}'`), `AppLayout.tsx missing group ${group}`);
    }
    const allowedPaths = [
      '/', '/activities', '/task-calendar', '/follow-up', '/leads', '/leads/new',
      '/leads/upload', '/leads/all', '/execution-intelligence', '/ncp-progress',
      '/trend-charts', '/campaign-breakdown', '/team', '/users', '/settings',
    ];
    const pathMatches = [...layout.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]);
    // menuItems entries all belong to the approved static path list.
    for (const p of pathMatches) {
      assert.ok(allowedPaths.includes(p), `AppLayout.tsx menuItems references an unapproved path: ${p}`);
    }
    assert.ok(!layout.includes("'/pipeline'"), 'AppLayout.tsx must not invent a /pipeline route');
  });

  it('K. Every sidebar path resolves to a real routed page wrapped in ProtectedRoute (no dead links, no bypass)', () => {
    const layout = read(APP_LAYOUT);
    const routes = read(APP_ROUTES);
    const protectedRoute = read(PROTECTED_ROUTE);
    const pathMatches = [...layout.matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(pathMatches.length > 0);
    for (const p of pathMatches) {
      const routeLiteral = `path: '${p}',`;
      assert.ok(routes.includes(routeLiteral), `App.tsx is missing a route entry for sidebar path ${p}`);
    }
    // Every one of App.tsx's protected pages is wrapped by <ProtectedRoute>...
    const protectedPageCount = (routes.match(/<ProtectedRoute>/g) || []).length;
    assert.ok(protectedPageCount >= pathMatches.length);
    // ...and ProtectedRoute itself only gates auth/init state, not per-route
    // authorization — grouping/relabeling in AppLayout must not smuggle a
    // second authorization system in here.
    assert.ok(protectedRoute.includes('isAuthenticated'));
    assert.ok(!protectedRoute.includes('menuAccess'));
  });

  it('L. Grouped sidebar rendering still flows through the pre-existing filteredMenu permission gate (admin bypass + menuAccess override + static role fallback)', () => {
    const layout = read(APP_LAYOUT);
    const filteredIdx = layout.indexOf('const filteredMenu');
    const groupedIdx = layout.indexOf('const groupedMenu');
    assert.ok(filteredIdx > -1 && groupedIdx > filteredIdx, 'groupedMenu must be computed from filteredMenu, after it');
    const filteredBody = layout.slice(filteredIdx, groupedIdx);
    assert.ok(filteredBody.includes("userRoleNormalized === 'ADMIN'"));
    assert.ok(filteredBody.includes('matchedPermission.menuAccess[item.path]'));
    assert.ok(filteredBody.includes('item.roles.includes'));
    // groupMenuItems() must only partition an already-filtered list — it must
    // never itself consult roles/menuAccess (that would be a parallel authz path).
    const groupFnIdx = layout.indexOf('function groupMenuItems');
    const groupFnEnd = layout.indexOf('\n}', groupFnIdx);
    const groupFnBody = layout.slice(groupFnIdx, groupFnEnd);
    assert.ok(!groupFnBody.includes('menuAccess'));
    assert.ok(!groupFnBody.includes('roles.includes'));
  });

  it('M. Role Configure UI (UserManagement) and adminService default/reverse mapping cover every sidebar route, including the new Activities entry', () => {
    const userMgmt = read(USER_MANAGEMENT);
    const adminSvc = read(ADMIN_SERVICE);
    assert.ok(userMgmt.includes("key: 'activities'"));
    assert.ok(userMgmt.includes("'/activities': roleFormFeatures?.activities?.view"));
    assert.ok(adminSvc.includes("activities: { view: true }") || adminSvc.includes('activities: {view:true}') || /activities:\s*\{\s*view:\s*true\s*\}/.test(adminSvc));
    assert.ok(adminSvc.includes("'/activities': true"));
    assert.ok(adminSvc.includes("'activities'"));
    // Capability permissions from Step 4/5 remain intact — this PR only adds
    // to the map, it does not remove or rename existing ones.
    for (const existingKey of ['dashboard', 'lead_generate', 'lead_upload', 'lead_tracking']) {
      assert.ok(userMgmt.includes(`key: '${existingKey}'`), `UserManagement.tsx lost existing feature key ${existingKey}`);
    }
  });
});
