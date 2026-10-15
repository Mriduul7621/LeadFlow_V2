/**
 * mobile-shell-sidebar.test.ts — the left sidebar app shell
 * ------------------------------------------------------------------
 * Source + behaviour guards for the mobile-shell change:
 *
 *  - the hamburger opens a LEFT drawer whose entries are the permissions-
 *    filtered sidebar nav module (never a hardcoded list),
 *  - the drawer has no close/exit control: the BACK BUTTON closes it
 *    (one history entry is pushed when it opens, popped by back),
 *  - every page the sidebar opens carries a history-aware back control
 *    (useGoBack / BackButton, never a fixed destination),
 *  - the retired More → Reports directory stays retired: analytics,
 *    workspace pages, Roadshow Follow-up and Sales Pipeline live in the
 *    sidebar and nowhere else,
 *  - Performance Diagnostics belongs to Administration,
 *  - Home no longer carries the pipeline / follow-up discipline / needs
 *    attention / embedded calendar sections,
 *  - the workbench queue is a minimal list (no type/quality chips) that
 *    can start a status update in one tap,
 *  - Lead 360's Update and Edit are icon-only (they used to overlap).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Mobile shell — left sidebar drawer', () => {
  const layout = () => read('src/layouts/AppLayout.tsx');
  const sidebar = () => read('src/layouts/sidebarNav.ts');
  const more = () => read('src/modules/navigation/pages/MorePages.tsx');
  const app = () => read('src/App.tsx');

  it('the header toggle opens a left drawer rendered from the nav module', () => {
    const l = layout();
    assert.ok(l.includes("aria-label=\"Menu\""), 'the header must expose a Menu toggle');
    assert.ok(l.includes('lf-sidebar-toggle'), 'the toggle must use the shell style hook');
    assert.ok(l.includes("const [isSidebarOpen, setIsSidebarOpen] = useState(false)"), 'drawer state must exist');
    assert.ok(l.includes('buildSidebarGroups('), 'drawer contents must come from the nav module, not a hardcoded list');
    assert.ok(l.includes('resolveFeatureRouteAccess('), 'entries must be filtered by the route Feature Access module');
    assert.ok(l.includes('sidebarGroups.map('), 'the drawer must render the resolved groups');
  });

  it('the drawer is on the LEFT and is the only fixed overlay in the shell', () => {
    const css = read('src/index.css');
    const block = css.slice(css.indexOf('.lf-sidebar {'), css.indexOf('.lf-sidebar-head {'));
    assert.match(block, /left:\s*0/, 'the drawer must be anchored to the left edge');
    assert.match(block, /top:\s*0/, 'full-height drawer');
  });

  it('closing is the back button\u2019s job: one history entry, no close control', () => {
    const l = layout();
    // Opening pushes a marker entry; popstate closes the drawer.
    assert.ok(l.includes('lfSidebar: true'), 'opening must push a history marker');
    assert.ok(l.includes("window.addEventListener('popstate'"), 'popstate must close the drawer');
    assert.ok(l.includes('const closeSidebar'), 'a single close helper must own the pop');
    assert.ok(l.includes('window.history.back()'), 'closing must pop the marker entry');
    // No in-drawer close button and no logout/exit row inside the drawer.
    assert.ok(!l.includes('lf-sidebar-close'), 'the drawer must not carry its own close button');
    assert.ok(!l.includes('lf-sidebar-logout'), 'the drawer must not carry an exit control');
    const css = read('src/index.css');
    assert.ok(!css.includes('.lf-sidebar-close'), 'no orphan close-button style');
    assert.ok(!css.includes('.lf-sidebar-logout'), 'no orphan logout style');
  });

  it('every sidebar page has a history-aware back control', () => {
    const hook = read('src/modules/shared/hooks/useGoBack.ts');
    assert.ok(hook.includes('useGoBack'), 'the shared back hook must exist');
    assert.ok(hook.includes("navigate(-1)"), 'it must prefer real history back');
    assert.ok(hook.includes('replace: true'), 'the fallback must replace, never push a dead entry');
    assert.ok(hook.includes('history.state?.idx'), 'it must test the router history index');
    const button = read('src/modules/shared/components/BackButton.tsx');
    assert.ok(button.includes('useGoBack('), 'BackButton must use the hook');
    for (const page of [
      'src/modules/dashboard/pages/ExecutionIntelligence.tsx',
      'src/modules/dashboard/pages/NcpProgress.tsx',
      'src/modules/dashboard/pages/TrendCharts.tsx',
      'src/modules/dashboard/pages/CampaignBreakdown.tsx',
      'src/modules/dashboard/pages/SalesPipelinePage.tsx',
      'src/modules/leads/pages/Activities.tsx',
      'src/modules/leads/pages/FollowUpStrategy.tsx',
      'src/modules/hierarchy/pages/TeamHierarchy.tsx',
      'src/modules/roadshows/pages/RoadshowPage.tsx',
      'src/modules/auth/pages/TaskCalendar.tsx',
    ]) {
      assert.ok(read(page).includes('BackButton'), `${page} must render the shared back control`);
    }
  });
});

describe('Mobile shell — navigation ownership', () => {
  const sidebar = () => read('src/layouts/sidebarNav.ts');
  const more = () => read('src/modules/navigation/pages/MorePages.tsx');
  const app = () => read('src/App.tsx');

  it('the sidebar owns analytics, workspace, roadshows and the pipeline', () => {
    const s = sidebar();
    for (const route of [
      '/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown',
      '/activities', '/task-calendar', '/follow-up', '/team',
      '/roadshows', '/sales-pipeline',
    ]) {
      assert.ok(s.includes(`path: '${route}'`), `sidebar must offer ${route}`);
    }
    // Analytics entries keep their functional permission gate.
    assert.ok(s.includes("permission: 'execution_intelligence'"), 'analytics entries must keep their view permission');
    assert.ok(s.includes("canAccess(item.permission, 'view')"), 'the permission filter must be applied');
  });

  it('dashboard/roadshows stay reachable, and the retired Reports directory does not come back', () => {
    const m = more();
    assert.ok(!m.includes("path: '/reports'"), 'More must not list Reports');
    assert.ok(!m.includes("path: '/roadshows'"), 'More must not duplicate the Roadshow sidebar entry');
    assert.ok(!m.includes('export function ReportsPage'), 'the ReportsPage component must be deleted');
    const a = app();
    assert.ok(!a.includes("path: '/reports'"), 'the /reports route must be gone');
    assert.ok(a.includes("path: '/sales-pipeline'"), 'the pipeline board must be a real route');
    const access = read('src/layouts/featureRouteAccess.ts');
    assert.ok(access.includes("'/sales-pipeline'"), 'the route must be registered in Feature Access');
    assert.ok(!access.includes("'/reports'"), 'no /reports entry may survive in Feature Access');
  });

  it('Performance Diagnostics is an Administration destination', () => {
    const m = more();
    const admin = m.slice(m.indexOf('export function AdministrationPage()'));
    assert.ok(admin.includes("path: '/settings/performance-diagnostics'"), 'Administration must list Performance Diagnostics');
    assert.ok(admin.includes('DIAGNOSTICS_ADMIN_ROLES.includes(role)'), 'and keep it admin-only');
    assert.ok(admin.includes('/settings/performance-diagnostics'), 'route retained');
    // The drawer must never expose it to non-admins.
    assert.ok(!sidebar().includes('performance-diagnostics'), 'the sidebar must not list admin diagnostics');
  });
});

describe('Mobile shell — Home, My Work and Lead 360', () => {
  const dashboard = () => read('src/modules/dashboard/pages/Dashboard.tsx');
  const workbench = () => read('src/modules/workbench/pages/DailyWorkbench.tsx');
  const lead360 = () => read('src/modules/leads/pages/Lead360.tsx');
  const leadList = () => read('src/modules/leads/pages/LeadList.tsx');

  it('Home keeps personal work and drops the analysis sections', () => {
    const d = dashboard();
    for (const gone of ['SalesPipeline', 'FollowUpDiscipline', 'NeedsAttentionSection', 'TaskCalendar']) {
      assert.ok(!d.includes(gone), `${gone} must not render on Home any more`);
    }
    assert.ok(d.includes('ExecutiveSnapshot'), 'Core Performance stays');
    assert.ok(d.includes('TodayTomorrowPanel'), "Today's Focus stays");
    assert.ok(d.includes('lf-recent-list'), 'Recent Leads stays');
  });

  it('Overdue Follow-ups is a KPI card beside Active Leads', () => {
    const d = dashboard();
    const grid = d.slice(d.indexOf('grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3'));
    const activeIdx = grid.indexOf('Active Leads');
    const overdueIdx = grid.indexOf('Overdue Follow-ups');
    assert.ok(overdueIdx > activeIdx && activeIdx !== -1, 'the Overdue card must follow Active Leads inside the KPI grid');
    assert.ok(!d.includes('Overdue Follow-ups shown as a compact callout'), 'the old red callout must be gone');
  });

  it('the workbench queue is minimal and every row can start an update', () => {
    const w = workbench();
    assert.ok(!w.includes('activeFilter') && !w.includes('qualityFilter'), 'the type/quality chip rows must be gone');
    assert.ok(w.includes('lf-queue-list'), 'the queue must use the shared minimal row list');
    assert.ok(w.includes('lf-mobile-lead-row'), 'rows reuse the Leads list row language');
    assert.ok(w.includes('/update`'), 'each row must offer the status-update page');
    assert.ok(w.includes('canEditScheduled'), 'the update entry must stay permission-gated');
    assert.ok(w.includes('Roadshows today') && w.includes('roadshowsTomorrow'), 'roadshow alerts stay for users with access');
    assert.ok(w.includes('useRoadshowAccess()'), 'roadshow alerts must be permission-gated (shared predicate)');
    assert.ok(read('src/modules/shared/hooks/useRoadshowAccess.ts').includes("canAccess('roadshow_follow_up', 'view')"),
      'the shared predicate must stay tied to the roadshow capability');
  });

  it('Lead 360 Update/Edit are icon-only so they cannot overlap', () => {
    const l = lead360();
    const updBtn = l.slice(l.indexOf('aria-label="Update lead status"') - 420, l.indexOf('aria-label="Update lead status"') + 200);
    const editBtn = l.slice(l.indexOf('aria-label="Edit lead"') - 420, l.indexOf('aria-label="Edit lead"') + 200);
    assert.ok(/h-10 w-10/.test(updBtn), 'the Update action must be a square icon button');
    assert.ok(/h-10 w-10/.test(editBtn), 'the Edit action must be a square icon button');
    assert.ok(!/> Update</.test(l), 'no text label may remain inside the mobile action row');
    assert.ok(l.includes('aria-label="Update lead status"') && l.includes('aria-label="Edit lead"'), 'both icons keep accessible names');
  });

  it('the Leads list offers a one-tap status update per row', () => {
    const l = leadList();
    assert.ok(l.includes('/update`'), 'rows must link to the update page');
    assert.ok(l.includes('lf-row-action'), 'the quick action must use the shared compact style');
    assert.ok(l.includes('canEditLead'), 'the quick action must be permission-gated');
  });
});
