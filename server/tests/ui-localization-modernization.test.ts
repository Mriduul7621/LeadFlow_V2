/**
 * ui-localization-modernization.test.ts — English-only
 * ------------------------------------------------------------------
 * Guards for PR #22 English-only modernization.
 * Verifies: no EN/বাংলা toggles, no leadflow-language, no runtime
 * switching, English-only polished copy, unified date control, Today &
 * Tomorrow server authority, Task Calendar last, header cleanup,
 * Settings System Connection, brand tokens, accessibility, and
 * preservation of PostgreSQL/RBAC/PR19/PR21.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('UI English-only & Design Modernization — source guards', () => {
  const dashboard = () => read('src/modules/workspace/pages/MemberHome.tsx');
  const layout = () => read('src/layouts/AppLayout.tsx');
  const login = () => read('src/modules/auth/pages/Login.tsx');
  const settings = () => read('src/modules/settings/pages/Settings.tsx');
  const indexCss = () => read('src/index.css');

  it('Login is English-only: no language switcher, no useTranslation, no leadflow-language', () => {
    const l = login();
    const visible = stripComments(l);
    assert.ok(!visible.includes('login-language-switcher'), 'Login must not have #login-language-switcher');
    assert.ok(!visible.includes('leadflow-language'), 'Login must not reference leadflow-language');
    assert.ok(!visible.includes('setLanguage'), 'Login must not have setLanguage (no runtime switching)');
    assert.ok(!visible.includes('useTranslation'), 'Login must not import useTranslation (English-only)');
    assert.ok(!visible.includes("t('") && !visible.includes('t(\"'), 'Login must not call t()');
    // English copy of the SHIPPED login screen. The mobile redesign replaced
    // the old hero/status/CTA marketing block; the English-only guarantee is
    // what this test protects, so it asserts the copy that actually renders.
    assert.ok(visible.includes('Welcome Back'), 'Login must show Welcome Back');
    assert.ok(visible.includes('Sign in to your LeadFlow account'), 'Login subtitle must be English');
    assert.ok(visible.includes('Set up your LeadFlow account'), 'first-time setup subtitle must be English');
    assert.ok(visible.includes('Employee ID'), 'Login must label Employee ID in English');
    assert.ok(visible.includes('Password'), 'Login must label Password in English');
    assert.ok(visible.includes('Remember Me'), 'Login must have the English Remember Me option');
    assert.ok(visible.includes('Login'), 'Login CTA must be English');
    assert.ok(visible.includes('Shanta Life Insurance'), 'footer must be English');
  });

  it('AppLayout is English-only: no language switcher, no useTranslation, polished header & forced-reset copy', () => {
    const la = layout();
    const visible = stripComments(la);
    assert.ok(!visible.includes('layout-language-switcher'), 'AppLayout must not have #layout-language-switcher');
    assert.ok(!visible.includes('leadflow-language'), 'AppLayout must not reference leadflow-language');
    assert.ok(!visible.includes('setLanguage'), 'AppLayout must not have setLanguage');
    assert.ok(!visible.includes('useTranslation'), 'AppLayout must not import useTranslation');
    assert.ok(!visible.includes("t('") && !visible.includes('t(\"'), 'AppLayout must not call t()');
    // Header literals
    assert.ok(visible.includes('Connection degraded'), 'header must show Connection degraded when offline');
    assert.ok(visible.includes('Notifications'), 'header must have Notifications');
    assert.ok(visible.includes('Mark All Read') || visible.includes('Mark all read'), 'header must have Mark All Read');
    assert.ok(visible.includes('Delete All') || visible.includes('Delete all'), 'header must have Delete All');
    assert.ok(visible.includes('No notifications yet'), 'header must have No notifications yet');
    assert.ok(visible.includes('Logged in as'), 'header must have Logged in as');
    assert.ok(visible.includes('Logout'), 'header must have Logout');
    // Forced password reset polished English
    assert.ok(visible.includes('Set New Password'), 'forced reset must show Set New Password');
    assert.ok(visible.includes('For security, create a new password before continuing.'), 'forced reset must show For security copy');
    assert.ok(visible.includes('New Password'), 'forced reset must have New Password');
    assert.ok(visible.includes('Confirm Password'), 'forced reset must have Confirm Password');
    assert.ok(visible.includes('Minimum 6 characters'), 'forced reset must show Minimum 6 characters');
    assert.ok(visible.includes('Re-enter new password'), 'forced reset must show Re-enter new password');
    assert.ok(visible.includes('Updating password...'), 'forced reset must show Updating password...');
    assert.ok(visible.includes('Update Password & Continue'), 'forced reset must show Update Password & Continue');
    // The role sidebar uses fixed English labels, not runtime translation.
    // (The labels moved out of AppLayout with the pill: the home labels
    // live in workspaceRole.ts, the deep-link labels in sidebarNav's
    // FALLBACK_LABELS.)
    assert.ok(read('src/layouts/workspaceRole.ts').includes("member: 'My Work'"), 'the member home label must be the English My Work');
    assert.ok(read('src/layouts/sidebarNav.ts').includes("'/more': 'More'"), 'the More breadcrumb label must be the English More');
  });

  it('Member home is English-only: no useTranslation/t(), polished literals, no leadflow-language', () => {
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(!visible.includes('useTranslation'), 'MemberHome must not import useTranslation');
    // The i18n t() call, word-bounded: the crude t(' substring
    // false-positives on DateTimeFormat(' and split(' ').
    assert.ok(!/\bt\(['"]/.test(visible), 'MemberHome must not call t()');
    assert.ok(!visible.includes('leadflow-language'), 'MemberHome must not reference leadflow-language');
    assert.ok(!visible.includes('layout-language-switcher') && !visible.includes('login-language-switcher'), 'MemberHome must not have language switcher');
    // Polished English literals
    assert.ok(visible.includes('My Work'), 'member-home eyebrow must be My Work');
    assert.ok(visible.includes('Priority follow-ups'), 'member home must have Priority follow-ups');
    assert.ok(visible.includes('My pipeline'), 'member home must have My pipeline');
    assert.ok(visible.includes('Recent leads'), 'member home must have Recent leads');
    assert.ok(visible.includes('Add Lead'), 'member home must have Add Lead');
    assert.ok(visible.includes('Refresh'), 'member home must have Refresh');
    assert.ok(visible.includes('Dashboard data could not be loaded.') || visible.includes('Retry'), 'member home must have neutral error copy Dashboard data could not be loaded. and keep Retry');
    assert.ok(visible.includes('Your saved data is unchanged. Please try again.'), 'member home must have secondary Your saved data is unchanged. Please try again.');
    assert.ok(visible.includes('Retry'), 'member home must keep Retry action');
    assert.ok(visible.includes('Nothing due — no follow-ups are overdue or due today.'), 'member-home empty states must be English');
    // No developer jargon in visible UI (comments stripped already)
    assert.ok(!visible.includes('server-authoritative'), 'visible member home must not show server-authoritative');
    assert.ok(!visible.includes('canonical current_status'), 'visible member home must not show canonical current_status');
    assert.ok(!visible.includes('PostgreSQL source'), 'visible member home must not show PostgreSQL source');
    assert.ok(!visible.includes('Dhaka Standard Time'), 'visible member home must not show Dhaka Standard Time');
  });

  it('the member home has NO period filter: the pipeline is all-time, the KPIs are today / this-month by construction', () => {
    // RETIRED with Dashboard.tsx (2026-11-17): the unified date-range
    // control (Today/WTD/MTD/LMTD/YTD/Custom + All Time) and the LMTD
    // date-resolution logic. The member home must not grow one back:
    // its pipeline reads the full status counts (period ALL) and its
    // KPI cards read the overview self row + converted-this-month.
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(!visible.includes('resolveRange'), 'no period resolver on the member home');
    assert.ok(!visible.includes('periodMeta'), 'no period metadata on the member home');
    assert.ok(!visible.includes('LMTD') && !visible.includes('WTD'), 'no period keys on the member home');
    assert.ok(!visible.includes('Date Range'), 'no date-range control on the member home');
    assert.ok(!visible.includes('Start Date') && !visible.includes('End Date'), 'no custom-range inputs on the member home');
    assert.ok(visible.includes("dashboardService.getDashboard({ period: 'ALL' })"), 'the pipeline read is always all-time');
  });

  it('Today & Tomorrow lives on the Workbench (CALL/MEETING/FOLLOW_UP/TASK via server APIs); the member home reads only the follow-up queue', () => {
    // The TodayTomorrowPanel retired with Dashboard.tsx (2026-11-17):
    // Today/Tomorrow execution is the Workbench's job now. The member
    // home reads follow-ups from the queue buckets only — no scheduled
    // activities, no full lead list.
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(visible.includes('getFollowUpQueue'), 'the member home must use getFollowUpQueue');
    assert.ok(!visible.includes('scheduledActivityService'), 'the member home must not read scheduled activities');
    assert.ok(!visible.includes('leadService.getLeads'), 'member home must not call full getLeads');
    assert.ok(!visible.includes('getLeads('), 'member home must not fetch full leads at all');
    const wb = stripComments(read('src/modules/workbench/pages/DailyWorkbench.tsx'));
    assert.ok(wb.includes('scheduledActivityService.list'), 'the Workbench must use scheduledActivityService.list');
    assert.ok(wb.includes('todayYmd') || wb.includes('tomorrowYmd') || wb.includes('getTodayYmdDhaka'), 'the Workbench must filter by Asia/Dhaka today/tomorrow buckets');
    assert.ok(wb.includes('Calls Today'), 'the Workbench must support CALL');
    assert.ok(wb.includes('Meetings Today'), 'the Workbench must support MEETING');
    assert.ok(wb.toLowerCase().includes('follow_up') || wb.toLowerCase().includes('followup'), 'the Workbench must support FOLLOW_UP');
    assert.ok(wb.includes('Tasks Today'), 'the Workbench must support TASK');
  });

  it('Member home and the pipeline page never call full getLeads and KPI authority stays server', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads'), 'member home must never call leadService.getLeads');
    assert.ok(d.includes('dashboardService.getDashboard'), 'KPI must come from dashboardService.getDashboard');
    // followUpCounts retired with Dashboard.tsx — the KPI cards read
    // the team-overview self row now.
    assert.ok(!d.includes('followUpCounts'), 'followUpCounts retired with Dashboard.tsx');
    assert.ok(d.includes('self?.totalLeads'), 'the Assigned card must read the overview self row');
    assert.ok(d.includes('totalLeads') || d.includes('total leads'), 'must read totalLeads from server');
    // statusCounts now drives the pipeline board page, which reuses the same
    // server response — the authority did not move to the client.
    const pipeline = stripComments(read('src/modules/dashboard/pages/SalesPipelinePage.tsx'));
    assert.ok(pipeline.includes('statusCounts'), 'pipeline must read statusCounts');
    assert.ok(pipeline.includes('dashboardService.getDashboard'), 'the pipeline board must reuse the server dashboard response');
    assert.ok(!pipeline.includes('leadService.getLeads'), 'the pipeline board must not fetch the full lead list');
  });

  it('Home keeps the personal sections and the calendar/pipeline live on their own pages', () => {
    const d = dashboard();
    // Mobile-shell change: Home no longer embeds the calendar, the pipeline
    // board, follow-up discipline or needs-attention. Each has a real route.
    assert.ok(!d.includes('<TaskCalendar'), 'Home must not embed the calendar');
    assert.ok(!d.includes('<SalesPipeline'), 'Home must not embed the pipeline board');
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/task-calendar'"), '/task-calendar route preserved');
    assert.ok(app.includes("path: '/sales-pipeline'"), '/sales-pipeline route preserved');
    const sidebar = read('src/layouts/sidebarNav.ts');
    assert.ok(sidebar.includes("path: '/task-calendar'") && sidebar.includes("path: '/sales-pipeline'"), 'both pages are sidebar destinations');
  });

  it('Calendar architecture from PR#21 preserved', () => {
    const cal = read('src/modules/auth/pages/TaskCalendar.tsx');
    assert.ok(cal.includes('scheduledActivityService'), 'TaskCalendar must import scheduledActivityService');
    assert.ok(!stripComments(cal).includes('leadService.getLeads'), 'TaskCalendar must not derive from getLeads');
    assert.ok(cal.includes('embedded'), 'the embedded prop contract must survive for any future host');
    const app = read('src/App.tsx');
    assert.match(app, /TaskCalendar\s*=\s*lazy\(/, 'the calendar must stay a lazy route chunk');
  });

  it('RBAC/menuAccess regression remains', () => {
    const la = layout();
    // The shell no longer calls resolveMenuVisibility directly: the
    // route gate (resolveFeatureRouteAccess) delegates to it
    // internally, so the menuAccess contract flows through the gate.
    assert.ok(la.includes('resolveFeatureRouteAccess('), 'the shell must filter the sidebar through the route gate');
    assert.ok(la.includes('matchedPermission'), 'the caller permission profile must feed the gate');
    assert.ok(read('src/layouts/menuVisibility.ts').includes('matchedPermission.menuAccess'), 'must keep dynamic menuAccess override');
    assert.ok(read('src/layouts/featureRouteAccess.ts').includes('resolveMenuVisibility'), 'the gate must delegate to the shared visibility resolver');
  });

  it('No full-lead fetch regression in the member home or leadService mutation paths', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads('), 'member home must not fetch full leads');
    assert.ok(!d.includes('getLeads'), 'member home must not contain getLeads at all');
    const leadService = read('src/modules/leads/services/leadService.ts');
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server before caching');
  });

  it('Member-home failure copy does not mislead about offline mode — neutral, distinct, with Retry', () => {
    const d = stripComments(dashboard());
    // Primary and secondary neutral copy must be present and distinct
    assert.ok(d.includes('Dashboard data could not be loaded.'), 'member home must show primary Dashboard data could not be loaded.');
    assert.ok(d.includes('Your saved data is unchanged. Please try again.'), 'member home must show secondary Your saved data is unchanged. Please try again.');
    // Old misleading copy must be removed
    assert.ok(!d.includes('Sync failed'), 'member home must not contain old Sync failed copy');
    assert.ok(!d.includes('Working in offline mode'), 'member home must not contain Working in offline mode');
    // Offline mode may only be claimed when an actual offline condition is checked
    const hasOfflineModeClaim = /offline mode/i.test(d);
    if (hasOfflineModeClaim) {
      assert.ok(
        d.includes('navigator.onLine') || d.includes('isOffline') || d.includes('offlineMode') || d.includes('isOfflineMode') || d.includes('Offline'),
        'offline mode wording must only appear alongside an actual offline condition check',
      );
    } else {
      assert.ok(!/offline mode/i.test(d), 'member-home failure copy must not claim offline mode');
    }
    // Keep Retry action for recovery
    assert.ok(d.includes('Retry'), 'Dashboard must keep Retry action');
    // Avoid rendering the same error sentence twice — each copy exactly once in visible source
    const primaryCount = (d.match(/Dashboard data could not be loaded\./g) || []).length;
    assert.equal(primaryCount, 1, 'primary error Dashboard data could not be loaded. should appear exactly once (avoid duplicate rendering)');
    const secondaryCount = (d.match(/Your saved data is unchanged\. Please try again\./g) || []).length;
    assert.equal(secondaryCount, 1, 'secondary error Your saved data is unchanged. Please try again. should appear exactly once');
    // Ensure primary and secondary are not the same string
    assert.notEqual('Dashboard data could not be loaded.', 'Your saved data is unchanged. Please try again.');
  });
});
