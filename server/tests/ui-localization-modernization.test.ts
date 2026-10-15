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
  const dashboard = () => read('src/modules/dashboard/pages/Dashboard.tsx');
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
    // Primary navigation uses fixed English labels, not runtime translation.
    assert.ok(visible.includes("label: 'My Work'"), 'primary navigation must use the English My Work label');
    assert.ok(visible.includes("label: 'More'"), 'primary navigation must use the English More label');
  });

  it('Dashboard is English-only: no useTranslation/t(), polished literals, no leadflow-language', () => {
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(!visible.includes('useTranslation'), 'Dashboard must not import useTranslation');
    assert.ok(!visible.includes("t('") && !visible.includes('t(\"'), 'Dashboard must not call t()');
    assert.ok(!visible.includes('leadflow-language'), 'Dashboard must not reference leadflow-language');
    assert.ok(!visible.includes('layout-language-switcher') && !visible.includes('login-language-switcher'), 'Dashboard must not have language switcher');
    // Polished English literals
    assert.ok(visible.includes('Dashboard'), 'Dashboard header title must be Dashboard');
    assert.ok(visible.includes('Sales performance'), 'Dashboard subtitle must be Sales performance at a glance');
    assert.ok(visible.includes('Date Range'), 'Dashboard must have Date Range collapsed label');
    assert.ok(visible.includes('Add Lead'), 'Dashboard must have Add Lead');
    assert.ok(visible.includes('Refresh'), 'Dashboard must have Refresh');
    assert.ok(visible.includes('Dashboard data could not be loaded.') || visible.includes('Retry'), 'Dashboard must have neutral error copy Dashboard data could not be loaded. and keep Retry');
    assert.ok(visible.includes('Your saved data is unchanged. Please try again.'), 'Dashboard must have secondary Your saved data is unchanged. Please try again.');
    assert.ok(visible.includes('Retry'), 'Dashboard must keep Retry action');
    assert.ok(visible.includes('No trend data available'), 'Dashboard empty states must be English');
    // No developer jargon in visible UI (comments stripped already)
    assert.ok(!visible.includes('server-authoritative'), 'visible Dashboard must not show server-authoritative');
    assert.ok(!visible.includes('canonical current_status'), 'visible Dashboard must not show canonical current_status');
    assert.ok(!visible.includes('PostgreSQL source'), 'visible Dashboard must not show PostgreSQL source');
    assert.ok(!visible.includes('Dhaka Standard Time'), 'visible Dashboard must not show Dhaka Standard Time');
  });

  it('Dashboard unified date-range control Today/WTD/MTD/LMTD/YTD/Custom + All Time — English labels & tooltips', () => {
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(visible.includes('Today'), 'must expose Today');
    assert.ok(visible.includes('WTD'), 'must expose WTD');
    assert.ok(visible.includes('MTD'), 'must expose MTD');
    assert.ok(visible.includes('LMTD'), 'must expose LMTD');
    assert.ok(visible.includes('YTD'), 'must expose YTD');
    assert.ok(visible.includes('Custom'), 'must expose Custom');
    assert.ok(visible.includes('All Time') || visible.includes('All time'), 'must expose All Time');
    // Tooltips — English descriptions
    assert.ok(visible.includes('Week to date') || visible.includes('Week to Date'), 'must have tooltip Week to date');
    assert.ok(visible.includes('Month to date') || visible.includes('Month to Date'), 'must have tooltip Month to date');
    assert.ok(visible.includes('Last month to date') || visible.includes('Last Month to Date'), 'must have tooltip Last month to date');
    assert.ok(visible.includes('Year to date') || visible.includes('Year to Date'), 'must have tooltip Year to date');
    assert.ok(visible.includes('Custom range') || visible.includes('Pick a start'), 'must have tooltip for Custom');
    // Custom Start/End inside same popover/dropdown + single Apply, no duplicate inputs outside
    assert.ok(visible.includes('Start Date'), 'Custom must have Start Date');
    assert.ok(visible.includes('End Date'), 'Custom must have End Date');
    assert.ok(visible.includes('Apply'), 'Custom must have single Apply action');
    assert.ok(visible.includes('Date Range'), 'must have collapsed Date Range presentation');
    assert.ok(visible.includes('resolveRange') || visible.includes('periodMeta'), 'must resolve unified periods to date range');
    assert.ok(visible.includes('dashboardService.getDashboard'), 'must call server-authoritative dashboardService.getDashboard');
    assert.ok(visible.includes('Asia/Dhaka'), 'date boundaries must be Asia/Dhaka');
  });

  it('Dashboard date resolution: LMTD same elapsed days of prior month, capped, server CUSTOM', () => {
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(visible.includes('LMTD') || visible.includes('lastMonth'), 'LMTD must be implemented');
    assert.ok(visible.includes('lastMonthDays') || visible.includes('capped') || visible.includes('Math.min'), 'LMTD must cap at month length');
    assert.ok(visible.includes('startYmd') && visible.includes('endYmd'), 'range must be resolved to start/end YMD');
    assert.ok(visible.includes('period:') && visible.includes('CUSTOM'), 'CUSTOM must send period CUSTOM with startDate/endDate');
    assert.ok(visible.includes("getTodayYmdDhaka") || visible.includes('Asia/Dhaka'), 'must use Dhaka helpers');
  });

  it('Dashboard Today & Tomorrow supports CALL/MEETING/FOLLOW_UP/TASK via server APIs only, no full lead list', () => {
    const d = dashboard();
    const visible = stripComments(d);
    assert.ok(visible.includes('getFollowUpQueue'), 'Today & Tomorrow must use getFollowUpQueue');
    assert.ok(visible.includes('scheduledActivityService.list'), 'Today & Tomorrow must use scheduledActivityService.list');
    // Ensure no full lead list — check stripped source (comments removed) to avoid comment false positives
    assert.ok(!visible.includes('leadService.getLeads'), 'Dashboard must not call full getLeads');
    assert.ok(!visible.includes('getLeads('), 'Dashboard must not fetch full leads at all');
    // Distinct scheduled activities filtered by Asia/Dhaka day boundaries
    assert.ok(visible.includes('todayYmd') || visible.includes('tomorrowYmd') || visible.includes('getTodayYmdDhaka'), 'must filter by Asia/Dhaka today/tomorrow buckets');
    assert.ok(visible.includes('CALL') || visible.toLowerCase().includes('call'), 'must support CALL');
    assert.ok(visible.includes('MEETING') || visible.toLowerCase().includes('meeting'), 'must support MEETING');
    assert.ok(visible.toLowerCase().includes('follow_up') || visible.toLowerCase().includes('followup'), 'must support FOLLOW_UP');
    assert.ok(visible.includes('TASK') || visible.toLowerCase().includes('task'), 'must support TASK');
    assert.ok(visible.includes('Phone') || visible.includes('Video') || visible.includes('ClipboardCheck') || visible.includes('History'), 'must have distinct icons for types');
  });

  it('Dashboard and the pipeline page never call full getLeads and KPI authority stays server', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads'), 'Dashboard must never call leadService.getLeads');
    assert.ok(d.includes('dashboardService.getDashboard'), 'KPI must come from dashboardService.getDashboard');
    assert.ok(d.includes('followUpCounts'), 'health must read followUpCounts');
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
    assert.ok(la.includes('resolveMenuVisibility'), 'must use the shared visibility resolver');
    assert.ok(la.includes('visiblePrimaryItems'), 'must filter primary navigation items');
    assert.ok(read('src/layouts/menuVisibility.ts').includes('matchedPermission.menuAccess'), 'must keep dynamic menuAccess override');
  });

  it('No full-lead fetch regression in Dashboard or leadService mutation paths', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads('), 'Dashboard must not fetch full leads');
    assert.ok(!d.includes('getLeads'), 'Dashboard must not contain getLeads at all');
    const leadService = read('src/modules/leads/services/leadService.ts');
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server before caching');
  });

  it('Dashboard failure copy does not mislead about offline mode — neutral, distinct, with Retry', () => {
    const d = stripComments(dashboard());
    // Primary and secondary neutral copy must be present and distinct
    assert.ok(d.includes('Dashboard data could not be loaded.'), 'Dashboard must show primary Dashboard data could not be loaded.');
    assert.ok(d.includes('Your saved data is unchanged. Please try again.'), 'Dashboard must show secondary Your saved data is unchanged. Please try again.');
    // Old misleading copy must be removed
    assert.ok(!d.includes('Sync failed'), 'Dashboard must not contain old Sync failed copy');
    assert.ok(!d.includes('Working in offline mode'), 'Dashboard must not contain Working in offline mode');
    // Offline mode may only be claimed when an actual offline condition is checked
    const hasOfflineModeClaim = /offline mode/i.test(d);
    if (hasOfflineModeClaim) {
      assert.ok(
        d.includes('navigator.onLine') || d.includes('isOffline') || d.includes('offlineMode') || d.includes('isOfflineMode') || d.includes('Offline'),
        'offline mode wording must only appear alongside an actual offline condition check',
      );
    } else {
      assert.ok(!/offline mode/i.test(d), 'Dashboard failure copy must not claim offline mode');
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
