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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
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
    // English polished copy present
    assert.ok(visible.includes('Welcome Back'), 'Login must show Welcome Back');
    assert.ok(visible.includes('System Ready') || visible.includes('Secure Node Online') || visible.includes('Setup Required'), 'Login must have system status literals');
    assert.ok(visible.includes('Smart Lead Management System'), 'Login hero must be English');
    assert.ok(visible.includes('Get Started') || visible.includes('Initialize Console'), 'Login CTA must be English');
    assert.ok(visible.includes('Employee ID'), 'Login must label Employee ID in English');
    assert.ok(visible.includes('Back to home'), 'Login must have Back to home');
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
    // Sidebar uses English sectionLabelMap not t()
    assert.ok(visible.includes('sectionLabelMap'), 'sidebar must use sectionLabelMap English');
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
    assert.ok(visible.includes('Sync failed') || visible.includes('Retry'), 'Dashboard must have error Retry English copy');
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

  it('Dashboard: still never calls full getLeads and KPI authority stays server', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads'), 'Dashboard must never call leadService.getLeads');
    assert.ok(d.includes('dashboardService.getDashboard'), 'KPI must come from dashboardService.getDashboard');
    assert.ok(d.includes('statusCounts'), 'pipeline must read statusCounts');
    assert.ok(d.includes('followUpCounts'), 'health must read followUpCounts');
    assert.ok(d.includes('totalLeads') || d.includes('total leads'), 'must read totalLeads from server');
  });

  it('Dashboard: Task Calendar is last major section and /task-calendar route preserved', () => {
    const d = dashboard();
    const taskIdx = d.lastIndexOf('<TaskCalendar');
    assert.ok(taskIdx > 0, 'Dashboard must render TaskCalendar');
    const pipelineIdx = d.indexOf('Pipeline') !== -1 ? d.indexOf('Pipeline') : d.indexOf('pipeline');
    const healthIdx = d.indexOf('Follow') !== -1 ? d.indexOf('Follow') : d.indexOf('followUp');
    const needsIdx = d.indexOf('Needs Attention') !== -1 ? d.indexOf('Needs Attention') : d.indexOf('Attention');
    const trendIdx = d.indexOf('Trend') !== -1 ? d.indexOf('Trend') : d.indexOf('trend');
    // Ensure TaskCalendar is after main sections (soft check — at least after pipeline/health if present)
    if (pipelineIdx >= 0) assert.ok(pipelineIdx < taskIdx, 'TaskCalendar must be after Pipeline');
    if (healthIdx >= 0) assert.ok(healthIdx < taskIdx, 'TaskCalendar must be after Follow-up/Health');
    if (needsIdx >= 0) assert.ok(needsIdx < taskIdx, 'TaskCalendar must be after Needs Attention');
    if (trendIdx >= 0) assert.ok(trendIdx < taskIdx, 'TaskCalendar must be after Trend');
    // Also ensure heading exists and App retains route
    assert.ok(d.includes('embedded'), 'Dashboard must pass embedded to TaskCalendar');
    const app = read('src/App.tsx');
    assert.ok(app.includes('/task-calendar'), 'App must keep /task-calendar route');
    const la = read('src/layouts/AppLayout.tsx');
    assert.ok(la.includes('/task-calendar'), 'sidebar must keep /task-calendar');
  });

  it('Header: removes Dhaka Standard Time and global Sync affordance, keeps degraded indicator', () => {
    const la = stripComments(layout());
    assert.ok(!la.includes('Dhaka Standard Time'), 'global header must not show Dhaka Standard Time');
    assert.ok(!la.includes('handleSync'), 'AppLayout must not have handleSync (sync moved to Settings)');
    assert.ok(!la.includes('Sync Now') || la.includes('Check Connection'), 'header must not show Sync Now; Settings owns Check Connection');
    // Degraded indicator only when offline/degraded
    assert.ok(la.includes('isOffline') || la.includes('WifiOff') || la.includes('Connection degraded'), 'header should have degraded-state indicator (offline only)');
    assert.ok(la.includes('dhakaTime') || la.includes('dateStr') || la.includes('timeStr'), 'header must still show compact date/time without timezone label');
  });

  it('Settings: System Connection houses connection check (not sync)', () => {
    const s = stripComments(settings());
    assert.ok(s.includes('System Connection'), 'Settings must have title System Connection');
    assert.ok(s.includes('Check the current cloud database connection status.'), 'Settings must have desc Check the current cloud database connection status.');
    assert.ok(s.includes('Check Connection'), 'Settings must have button Check Connection');
    assert.ok(s.includes('Cloud database connection is active.'), 'Settings must have success Cloud database connection is active.');
    assert.ok(s.includes('Cloud database connection could not be verified.'), 'Settings must have failure Cloud database connection could not be verified.');
    assert.ok(s.includes('databaseStatusService') || s.includes('checkDatabaseStatus') || s.includes('Database'), 'Settings must call databaseStatusService');
    // No stale sync wording in System Connection block (allow other tabs to keep generic sync word, but block must be connection)
    assert.ok(!s.includes('System Sync'), 'Settings System Tools block must be System Connection, not System Sync');
  });

  it('Brand palette and design tokens centralized', () => {
    const css = indexCss();
    assert.ok(css.includes('#F3702B'), 'brand orange must be #F3702B');
    assert.ok(css.includes('#978C21'), 'brand olive must be #978C21');
    assert.ok(css.includes('#0359B3'), 'brand blue must be #0359B3');
    assert.ok(css.includes('#3C3C3C'), 'brand text must be #3C3C3C');
    assert.ok(css.includes('--color-brand') || css.includes('--color-primary'), 'must use CSS vars for brand');
    assert.ok(css.includes('--radius-card') || css.includes('radius-card'), 'must have card radius token');
    assert.ok(css.includes('shadow-card') || css.includes('--shadow'), 'must have shadow tokens');
    assert.ok(css.includes('#FDFBF7') || css.includes('#FFFCF8'), 'must have warm surface');
    assert.ok(css.includes('120ms') || css.includes('0.12s') || css.includes('--duration-fast'), 'must have 120ms motion');
    assert.ok(css.includes('180ms') || css.includes('0.18s') || css.includes('--duration-normal'), 'must have 180ms motion');
    assert.ok(css.includes('rounded-[12px]') || css.includes('rounded-[10px]') || css.includes('radius'), 'must use 10-14px radii');
  });

  it('Accessibility and responsiveness basics preserved', () => {
    const d = dashboard();
    const la = layout();
    assert.ok(indexCss().includes('focus-visible') || indexCss().includes('focus:'), 'must have focus-visible');
    assert.ok(d.includes('aria-label') || la.includes('aria-label'), 'must have aria-label');
    assert.ok(d.includes('role=\"dialog\"') || la.includes('role=\"dialog\"'), 'dialogs must have role=dialog');
    assert.ok(d.includes('grid-cols-1') && d.includes('sm:grid-cols-2'), 'must have responsive grids');
    assert.ok(indexCss().includes('prefers-reduced-motion'), 'must respect prefers-reduced-motion');
  });

  it('English-only copy consistency: Dashboard no t(), Login/AppLayout no BN strings', () => {
    const d = stripComments(dashboard());
    const la = stripComments(layout());
    const l = stripComments(login());
    // Ensure no Bangla script in visible UI (EN-only) — allow Taka currency symbol ৳ (U+09F3) which is in Bangla block but is business currency, not language
    const bnRegex = /[\u0980-\u09F2\u09F4-\u09FF]/;
    const dNoTaka = d.replace(/৳/g, '');
    const laNoTaka = la.replace(/৳/g, '');
    const lNoTaka = l.replace(/৳/g, '');
    assert.ok(!bnRegex.test(dNoTaka), 'Dashboard visible must not contain Bangla characters');
    assert.ok(!bnRegex.test(laNoTaka), 'AppLayout visible must not contain Bangla characters');
    assert.ok(!bnRegex.test(lNoTaka), 'Login visible must not contain Bangla characters');
    // Ensure no translation hook usage remains in these three files
    for (const [name, src] of [['Dashboard', d], ['AppLayout', la], ['Login', l]] as Array<[string, string]>) {
      assert.ok(!src.includes('useTranslation'), `${name} must not use useTranslation`);
      assert.ok(!src.includes("t('") && !src.includes('t(\"'), `${name} must not call t()`);
    }
  });

  it('Perf guards from PR#19 remain: no polling, fail-closed, memoization, no full refetch', () => {
    const la = layout();
    const svc = read('server/routes/production.routes.ts');
    assert.ok(!la.includes('setInterval(fetchPerms, 6000)') && !la.includes('setInterval(fetchNotifs, 8000)'), 'no aggressive polling in AppLayout');
    assert.ok(svc.includes('Fail closed on DB error') || svc.includes('Fail closed'), 'permission must fail closed');
    assert.ok(svc.includes('has_user_override'), 'must have user override');
    const leadService = read('src/modules/leads/services/leadService.ts');
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server');
  });

  it('Calendar architecture from PR#21 preserved', () => {
    const d = dashboard();
    assert.ok(d.includes('TaskCalendar'), 'must import TaskCalendar');
    assert.ok(d.includes('<TaskCalendar'), 'must render TaskCalendar');
    assert.ok(d.includes('Asia/Dhaka'), 'must be Dhaka-aware');
    assert.ok(d.includes('scheduled_activities') || d.includes('scheduledActivityService'), 'must reference scheduled_activities');
    const cal = read('src/modules/auth/pages/TaskCalendar.tsx');
    assert.ok(cal.includes('scheduledActivityService'), 'TaskCalendar must import scheduledActivityService');
    assert.ok(!stripComments(cal).includes('leadService.getLeads'), 'TaskCalendar must not derive from getLeads');
  });

  it('RBAC/menuAccess regression remains', () => {
    const la = layout();
    assert.ok(la.includes('menuAccess'), 'must keep menuAccess override');
    assert.ok(la.includes('roles.includes'), 'must keep static fallback');
    assert.ok(la.includes('isItemVisible'), 'must have single visibility check');
    assert.ok(la.includes('visibleSections'), 'must filter sections');
  });

  it('No full-lead fetch regression in Dashboard or leadService mutation paths', () => {
    const d = stripComments(dashboard());
    assert.ok(!d.includes('leadService.getLeads('), 'Dashboard must not fetch full leads');
    assert.ok(!d.includes('getLeads'), 'Dashboard must not contain getLeads at all');
    const leadService = read('src/modules/leads/services/leadService.ts');
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server before caching');
  });
});
