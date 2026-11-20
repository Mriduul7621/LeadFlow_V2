/**
 * mobile-shell-sidebar.test.ts — the left sidebar app shell
 * ------------------------------------------------------------------
 * Source + behaviour guards for the mobile-shell change, retargeted
 * to the Enterprise Preview shell (2026-11-19: the `.ep-*` shell,
 * `src/layouts/enterpriseNav.ts`, four role homes):
 *
 *  - the hamburger opens a LEFT drawer whose entries are the permissions-
 *    filtered enterprise nav module (never a hardcoded list),
 *  - the drawer has no close/exit control: the BACK BUTTON closes it
 *    (one history entry is pushed when it opens, popped by back),
 *  - every page the sidebar opens carries a history-aware back control
 *    (useGoBack / BackButton, never a fixed destination),
 *  - the retired More → Reports directory stays retired: analytics,
 *    workspace pages, Roadshow Follow-up and Sales Pipeline live in the
 *    sidebar and nowhere else,
 *  - Performance Diagnostics belongs to Administration,
 *  - Home no longer carries the pipeline / follow-up discipline / needs
 *    attention / embedded calendar sections (and the old home's own
 *    snapshot panels went with them),
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
  const sidebar = () => read('src/layouts/enterpriseNav.ts');
  const more = () => read('src/modules/navigation/pages/MorePages.tsx');
  const app = () => read('src/App.tsx');

  it('the header toggle opens a left drawer rendered from the nav module', () => {
    const l = layout();
    assert.ok(l.includes("aria-label=\"Menu\""), 'the header must expose a Menu toggle');
    assert.ok(l.includes('leadflow-sidebar-toggle'), 'the toggle must use the shell style hook');
    assert.ok(l.includes('ep-hamburger'), 'the toggle must use the enterprise shell class');
    assert.ok(l.includes('id="leadflow-sidebar"'), 'the drawer must carry the shell id');
    assert.ok(l.includes("const [isSidebarOpen, setIsSidebarOpen] = useState(false)"), 'drawer state must exist');
    assert.ok(l.includes('buildEnterpriseNavGroups('), 'drawer contents must come from the nav module, not a hardcoded list');
    assert.ok(l.includes('resolveFeatureRouteAccess('), 'entries must be filtered by the route Feature Access module');
    assert.ok(l.includes('sidebarGroups.map('), 'the drawer must render the resolved groups');
  });

  it('the drawer is on the LEFT and slides in from the left edge', () => {
    const css = read('src/index.css');
    // Desktop: the sidebar is a sticky full-height column, not an overlay.
    const base = css.slice(css.indexOf('.ep-sidebar {'), css.indexOf('.ep-brand {'));
    assert.match(base, /position:\s*sticky/, 'the desktop sidebar is a sticky column');
    assert.match(base, /top:\s*0/, 'full-height sidebar');
    // Mobile (<=720px): the sidebar becomes a fixed drawer parked off the
    // LEFT edge, sliding in when open.
    const mq = css.slice(css.indexOf('@media (max-width: 720px)'));
    const drawer = mq.slice(mq.indexOf('.ep-sidebar {'), mq.indexOf('.ep-sidebar.open'));
    assert.match(drawer, /position:\s*fixed/, 'the mobile drawer is fixed');
    assert.match(drawer, /left:\s*-270px/, 'the closed drawer parks off the left edge');
    assert.match(drawer, /top:\s*0/, 'full-height drawer');
    assert.match(mq, /\.ep-sidebar\.open\s*\{\s*left:\s*0/, 'opening slides the drawer in from the left');
  });

  it('closing is the back button\u2019s job: one history entry, no close control', () => {
    const l = layout();
    // Opening pushes a marker entry; popstate closes the drawer.
    assert.ok(l.includes('lfSidebar: true'), 'opening must push a history marker');
    assert.ok(l.includes("window.addEventListener('popstate'"), 'popstate must close the drawer');
    assert.ok(l.includes('const closeSidebar'), 'a single close helper must own the pop');
    assert.ok(l.includes('window.history.back()'), 'closing must pop the marker entry');
    // No in-drawer close button and no logout/exit row inside the drawer.
    assert.ok(!l.includes('ep-sidebar-close'), 'the drawer must not carry its own close button');
    assert.ok(!l.includes('ep-sidebar-logout'), 'the drawer must not carry an exit control');
    assert.ok(!l.includes('lf-sidebar-close'), 'no retired close-button hook may return');
    assert.ok(!l.includes('lf-sidebar-logout'), 'no retired logout hook may return');
    const css = read('src/index.css');
    assert.ok(!css.includes('.ep-sidebar-close'), 'no orphan close-button style');
    assert.ok(!css.includes('.ep-sidebar-logout'), 'no orphan logout style');
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
  const sidebar = () => read('src/layouts/enterpriseNav.ts');
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
    // The drawer must never expose it to non-admins: no nav item may
    // point at it. (The breadcrumb fallback map may still NAME the
    // route — a label is not an entry.)
    assert.ok(!sidebar().includes("path: '/settings/performance-diagnostics'"), 'the sidebar must not list admin diagnostics');
  });
});

describe('Mobile shell — Home, My Work and Lead 360', () => {
  // Enterprise Preview (2026-11-19): one Dashboard became four role
  // homes (Admin / Manager / Team Lead / Agent).
  const HOMES = [
    'src/modules/workspace/pages/AdminHome.tsx',
    'src/modules/workspace/pages/ManagerHome.tsx',
    'src/modules/workspace/pages/TeamLeadHome.tsx',
    'src/modules/workspace/pages/AgentHome.tsx',
  ];
  const workbench = () => read('src/modules/workbench/pages/DailyWorkbench.tsx');
  const lead360 = () => read('src/modules/leads/pages/Lead360.tsx');
  const leadList = () => read('src/modules/leads/pages/LeadList.tsx');

  it('Home keeps personal work and drops the analysis sections', () => {
    // The dropped sections stay dropped on every home — and the old
    // home's own snapshot panels (ExecutiveSnapshot, TodayTomorrowPanel)
    // went with them.
    for (const file of HOMES) {
      const src = read(file);
      for (const gone of ['SalesPipeline', 'FollowUpDiscipline', 'NeedsAttentionSection', 'TaskCalendar', 'ExecutiveSnapshot', 'TodayTomorrowPanel']) {
        assert.ok(!src.includes(gone), `${gone} must not render on ${file} any more`);
      }
      // Every home still shows the caller's own work: a KPI grid and a
      // follow-up / workload table.
      assert.ok(src.includes('<KpiCard'), `${file} must render its KPI cards`);
      assert.ok(src.includes('<DataTableCard'), `${file} must render its work table`);
    }
  });

  it('Overdue stays prominent on every home: a KPI card and the first attention row', () => {
    // The old Home put "Overdue Follow-ups" beside "Active Leads" in
    // the KPI grid. The role homes keep overdue first-class in both
    // shapes they use: Agent and Team Lead carry an Overdue KPI right
    // after Due today; Manager and Admin lead their attention list
    // with "Overdue follow-ups".
    for (const file of ['src/modules/workspace/pages/AgentHome.tsx', 'src/modules/workspace/pages/TeamLeadHome.tsx']) {
      const src = read(file);
      const grid = src.slice(src.indexOf('<div className="ep-grid">'));
      const dueIdx = grid.indexOf('label="Due today"');
      const overdueIdx = grid.indexOf('label="Overdue"');
      assert.ok(dueIdx !== -1 && overdueIdx > dueIdx, `${file}: the Overdue KPI must follow Due today inside the KPI grid`);
    }
    for (const file of ['src/modules/workspace/pages/ManagerHome.tsx', 'src/modules/workspace/pages/AdminHome.tsx']) {
      const src = read(file);
      const attention = src.slice(src.indexOf('const attentionRows'));
      assert.ok(
        attention.indexOf("title: 'Overdue follow-ups'") !== -1 &&
        attention.indexOf("title: 'Overdue follow-ups'") < attention.indexOf("title: 'No Action Alert'"),
        `${file}: Overdue follow-ups must lead the attention list`
      );
      assert.ok(!src.includes('Overdue Follow-ups shown as a compact callout'), 'the old red callout must be gone');
    }
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
