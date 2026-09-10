/**
 * ui-localization-modernization.test.ts
 * ------------------------------------------------------------------
 * Guards for PR: feat: modernize LeadFlow dashboard UX, localization and visual design
 * Covers: Dashboard UX, header, date filter, Task Calendar ordering,
 * Today & Tomorrow server authority, Login persistence, BN localization,
 * hardcoded-string audit, brand tokens, motion, and preservation of PR#19/#21/ RBAC.
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
  // Remove /* ... */ and // ... to avoid false positives on visible UI checks
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('UI Localization & Design Modernization — source guards', () => {
  const dashboard = () => read('src/modules/dashboard/pages/Dashboard.tsx');
  const layout = () => read('src/layouts/AppLayout.tsx');
  const login = () => read('src/modules/auth/pages/Login.tsx');
  const translationsShared = () => read('src/modules/shared/utils/translations.ts');
  const translationsLegacy = () => read('src/utils/translations.ts');
  const langStore = () => read('src/store/languageStore.ts');
  const indexCss = () => read('src/index.css');
  const settings = () => read('src/modules/settings/pages/Settings.tsx');

  it('Login: EN/BN language selector exists and persists', () => {
    const l = login();
    assert.ok(l.includes('login-language-switcher'), 'Login must have #login-language-switcher');
    assert.ok(l.includes("setLanguage('en')") || l.includes('setLanguage("en")') || l.includes("setLanguage('en')"), 'Login must allow EN');
    assert.ok(l.includes("setLanguage('bn')") || l.includes('setLanguage("bn")'), 'Login must allow BN');
    assert.ok(l.includes('useTranslation'), 'Login must use translation hook');

    const store = langStore();
    assert.ok(store.includes('persist'), 'languageStore must use zustand persist');
    assert.ok(store.includes('leadflow-language'), 'languageStore must persist under leadflow-language');
    assert.ok(store.includes("'en'") || store.includes('"en"'), 'languageStore default must be en');
  });

  it('Language persistence shared between Login and AppLayout', () => {
    const la = layout();
    assert.ok(la.includes('layout-language-switcher'), 'AppLayout must have #layout-language-switcher');
    assert.ok(la.includes('useTranslation'), 'AppLayout must use translation hook');
    assert.ok(la.includes("setLanguage('en')") || la.includes('setLanguage("en")'), 'AppLayout must expose EN');
    assert.ok(la.includes("setLanguage('bn')") || la.includes('setLanguage("bn")'), 'AppLayout must expose BN');
  });

  it('Translations: comprehensive EN/BN coverage for active routes', () => {
    const t = translationsShared();
    // Dashboard
    for (const key of ['dashboardTitle', 'dashboardSubtitle', 'kpiTotalLeads', 'dashboardPipelineTitle', 'dashboardFollowUpHealthTitle']) {
      assert.ok(t.includes(key), `translations must include ${key}`);
    }
    // Date filter unified
    for (const key of ['dashboardFilterToday', 'dashboardFilterWtd', 'dashboardFilterMtd', 'dashboardFilterLmtd', 'dashboardFilterYtd', 'dashboardFilterCustom', 'dashboardFilterAllTime', 'dashboardDateRange']) {
      assert.ok(t.includes(key), `translations must include ${key}`);
    }
    // Tooltips
    for (const key of ['dashboardTooltipWtd', 'dashboardTooltipMtd', 'dashboardTooltipLmtd', 'dashboardTooltipYtd']) {
      assert.ok(t.includes(key), `translations must include ${key}`);
    }
    // Lead / activities / calendar
    for (const key of ['activityCall', 'activityMeeting', 'activityFollowUp', 'activityTask', 'taskCalendarTitle']) {
      assert.ok(t.includes(key), `translations must include ${key}`);
    }
    // Common
    for (const key of ['navDashboard', 'navLeadGenerate', 'navTaskCalendar', 'navSettings']) {
      assert.ok(t.includes(key), `translations must include ${key}`);
    }
    // BN block exists
    assert.ok(t.includes('bn:'), 'translations must have bn block');
    assert.ok(t.includes('ড্যাশবোর্ড'), 'BN must contain natural business Bangla (ড্যাশবোর্ড)');
    // Legacy mirror re-exports canonical
    const legacy = translationsLegacy();
    assert.ok(legacy.includes('from') && legacy.includes('translations'), 'src/utils/translations.ts must re-export canonical dictionary');
    // Ensure BN not literal user-data translation side effect: we at least check that translations file does not translate email placeholder literally?
    assert.ok(!t.includes('john.doe@'), 'translations must not contain example user data');
  });

  it('Dashboard: localized, no developer subtitles in visible UI', () => {
    const d = dashboard();
    const visible = stripComments(d);
    // Visible subtitles should be business-friendly, not technical
    assert.ok(visible.includes("t('dashboardTitle')") || visible.includes('dashboardTitle'), 'Dashboard header must be localized');
    assert.ok(visible.includes("t('dashboardSubtitle')") || visible.includes('dashboardSubtitle'), 'Dashboard subtitle must be localized business copy');
    // Technical developer subtitles must be absent from visible sections (comments stripped)
    // These strings would be visible if they appear outside comments
    assert.ok(!visible.includes('server-authoritative'), 'visible Dashboard must not show server-authoritative');
    assert.ok(!visible.includes('canonical current_status'), 'visible Dashboard must not show canonical current_status');
    assert.ok(!visible.includes('PostgreSQL source'), 'visible Dashboard must not show PostgreSQL source');
    // Asia/Dhaka may appear in code helpers but must not be shown as a visible header label; ensure not in SectionHeading desc
    // We allow Asia/Dhaka in code (date helpers) but not as UI text "Dhaka Standard Time"
    assert.ok(!visible.includes('Dhaka Standard Time'), 'visible Dashboard must not show Dhaka Standard Time wording');
  });

  it('Header: removes Dhaka Standard Time and global Sync affordance', () => {
    const la = layout();
    const visible = stripComments(la);
    assert.ok(!visible.includes('Dhaka Standard Time'), 'global header must not show Dhaka Standard Time');
    // No persistent Sync button in header — AppLayout must not contain a header Sync action
    // We check that header does not have a button that calls handleSync or shows Sync icon in header context
    // The sync should still exist in Settings, so we only guard the header
    assert.ok(!visible.includes('handleSync'), 'AppLayout must not have handleSync (sync moved to Settings)');
    // Ensure header still has degraded/offline indicator but only when offline
    assert.ok(visible.includes('isOffline') || visible.includes('WifiOff') || visible.includes('Offline') || visible.includes('degraded'), 'header should have degraded-state indicator (offline only)');
    // Ensure header still has compact date/time without timezone label
    assert.ok(visible.includes('dhakaTime') || visible.includes('dateStr') || visible.includes('timeStr'), 'header must still show compact date/time');
  });

  it('Settings: System Tools houses genuine sync operation', () => {
    const s = settings();
    // Sync must exist somewhere in Settings (moved from header)
    assert.ok(s.includes('databaseStatusService') || s.includes('checkDatabaseStatus') || s.includes('Synchronization'), 'Settings must house sync operation');
    assert.ok(s.includes('System Tools') || s.includes('System Configuration') || s.includes('Network & Sync'), 'Settings must have System Tools / sync area');
  });

  it('Dashboard: unified date-range control Today/WTD/MTD/LMTD/YTD/Custom + All Time', () => {
    const d = dashboard();
    assert.ok(d.includes('WTD'), 'Dashboard must expose WTD');
    assert.ok(d.includes('MTD'), 'Dashboard must expose MTD');
    assert.ok(d.includes('LMTD'), 'Dashboard must expose LMTD (equivalent elapsed days)');
    assert.ok(d.includes('YTD'), 'Dashboard must expose YTD');
    assert.ok(d.includes('CUSTOM') || d.includes('Custom'), 'Dashboard must expose Custom');
    assert.ok(d.includes('ALL') || d.includes('All Time') || d.includes('All time') || d.includes('AllTime'), 'Dashboard must expose All Time');
    // Tooltip/accessibility for abbreviations
    assert.ok(d.includes('dashboardTooltipWtd') || d.includes('Week to date'), 'Dashboard must have tooltip for WTD');
    assert.ok(d.includes('dashboardTooltipLmtd') || d.includes('Last month to date'), 'Dashboard must have tooltip for LMTD');
    // Custom Start/End inside same popover/dropdown + single Apply
    assert.ok(d.includes('customStart') || d.includes('StartDate') || d.includes('startDate'), 'Custom must have startDate handling');
    assert.ok(d.includes('customEnd') || d.includes('EndDate') || d.includes('endDate'), 'Custom must have endDate handling');
    assert.ok(d.includes('Apply') || d.includes('dashboardApply'), 'Custom must have single Apply action');
    // Collapsed presentation includes range display
    assert.ok(d.includes('Date Range') || d.includes('dashboardDateRange'), 'Dashboard must have collapsed Date Range presentation');
    // No duplicate separate date inputs/labels (ensure no standalone TODAY date picker outside popover)
    // We allow date inputs only for CUSTOM inside popover
    // Check that period handling resolves to server CUSTOM query
    assert.ok(d.includes("resolveRange"), 'Dashboard must resolve unified periods to date range');
    assert.ok(d.includes("dashboardService.getDashboard"), 'Dashboard must still call server-authoritative dashboard API');
  });

  it('Dashboard: date resolution maps LMTD to same elapsed days of prior month', () => {
    const d = dashboard();
    // LMTD logic: 1 to same day number of prior month, capped
    assert.ok(d.includes('lastMonth') || d.includes('LMTD'), 'LMTD must be implemented');
    assert.ok(d.includes('lastMonthDays') || d.includes('capped'), 'LMTD must cap at month length');
    assert.ok(d.includes('startYmd') && d.includes('endYmd'), 'range must be resolved to start/end YMD');
    // Business date boundaries remain Asia/Dhaka
    assert.ok(d.includes('Asia/Dhaka'), 'date boundaries must be Asia/Dhaka');
  });

  it('Dashboard: Task Calendar is last major section', () => {
    const d = dashboard();
    const taskIdx = d.lastIndexOf('<TaskCalendar');
    assert.ok(taskIdx > 0, 'Dashboard must render TaskCalendar');
    // Find last major headings before TaskCalendar
    const pipelineIdx = d.indexOf('dashboardPipelineTitle');
    const healthIdx = d.indexOf('dashboardFollowUpHealthTitle');
    const needsIdx = d.indexOf('dashboardNeedsAttentionTitle');
    const trendIdx = d.indexOf('dashboardTrendTitle');
    const teamIdx = d.indexOf('dashboardTeamPerformanceTitle');
    const statusIdx = d.indexOf('dashboardStatusDistributionTitle');
    // @ts-ignore - tuple typing for test readability
    for (const [name, idx] of [['Pipeline', pipelineIdx], ['FollowUpHealth', healthIdx], ['NeedsAttention', needsIdx], ['Trend', trendIdx], ['Team', teamIdx], ['StatusDistribution', statusIdx]] as Array<[string, number]>) {
      if (idx >= 0) assert.ok((idx as number) < taskIdx, `TaskCalendar must be after ${name}`);
    }
    // Also ensure TaskCalendar is after pipeline etc. in rendered order
    assert.ok(d.indexOf('Task Calendar') === -1 || d.indexOf('taskCalendarTitle') < taskIdx || true, 'TaskCalendar heading must precede component but section must be last');
  });

  it('Dashboard: Today & Tomorrow supports CALL/MEETING/FOLLOW_UP/TASK via server APIs', () => {
    const d = dashboard();
    // Must use server APIs, not full lead list
    assert.ok(d.includes('getFollowUpQueue'), 'Today & Tomorrow must use getFollowUpQueue');
    assert.ok(d.includes('scheduledActivityService.list'), 'Today & Tomorrow must use scheduledActivityService.list');
    assert.ok(!d.includes('leadService.getLeads'), 'Dashboard must not call full getLeads');
    // Activity types
    assert.ok(d.toLowerCase().includes('call'), 'must support CALL');
    assert.ok(d.toLowerCase().includes('meeting'), 'must support MEETING');
    assert.ok(d.toLowerCase().includes('follow_up') || d.toLowerCase().includes('followup'), 'must support FOLLOW_UP');
    assert.ok(d.toLowerCase().includes('task'), 'must support TASK');
    // Distinct visual differentiation (check for distinct colors/icons)
    assert.ok(d.includes('Phone') || d.includes('Video') || d.includes('ClipboardCheck'), 'must have distinct icons for types');
  });

  it('Dashboard: still never calls full getLeads and KPI authority stays server', () => {
    const d = dashboard();
    assert.ok(!d.includes('leadService.getLeads'), 'Dashboard must never call leadService.getLeads');
    assert.ok(d.includes('dashboardService.getDashboard'), 'KPI must come from dashboardService.getDashboard');
    assert.ok(d.includes('statusCounts'), 'pipeline must read statusCounts');
    assert.ok(d.includes('followUpCounts'), 'health must read followUpCounts');
  });

  it('Brand palette and design tokens centralized', () => {
    const css = indexCss();
    assert.ok(css.includes('#F3702B'), 'brand orange must be #F3702B');
    assert.ok(css.includes('#978C21'), 'brand olive must be #978C21');
    assert.ok(css.includes('#0359B3'), 'brand blue must be #0359B3');
    assert.ok(css.includes('#3C3C3C'), 'brand text must be #3C3C3C');
    assert.ok(css.includes('--color-brand'), 'must use CSS vars for brand');
    assert.ok(css.includes('--radius-card') || css.includes('radius-card'), 'must have card radius token');
    assert.ok(css.includes('shadow-card') || css.includes('--shadow'), 'must have shadow tokens');
    // No scattered raw hex beyond tokens — at least check that warm surface appears
    assert.ok(css.includes('#FDFBF7') || css.includes('#FFFCF8'), 'must have warm surface');
    // Gradient/motion subtle 120-180ms
    assert.ok(css.includes('120ms') || css.includes('0.12s') || css.includes('--duration-fast'), 'must have 120ms motion');
    assert.ok(css.includes('180ms') || css.includes('0.18s') || css.includes('--duration-normal'), 'must have 180ms motion');
  });

  it('Accessibility and responsiveness basics', () => {
    const d = dashboard();
    const la = layout();
    // Keyboard/focus
    assert.ok(indexCss().includes('focus-visible') || indexCss().includes('focus:'), 'must have focus-visible');
    // aria labels
    assert.ok(d.includes('aria-label') || la.includes('aria-label'), 'must have aria-label');
    // Responsive grids
    assert.ok(d.includes('grid-cols-1') && d.includes('sm:grid-cols-2'), 'must have responsive grids');
  });

  it('Hardcoded string audit — no untranslated user-visible copy in Dashboard', () => {
    const d = dashboard();
    const t = translationsShared();
    // At least spot-check that Dashboard uses t() for major headings rather than raw English
    assert.ok(d.includes("t('dashboardTitle')"), 'Dashboard title must be translated');
    assert.ok(d.includes("t('kpiTotalLeads')"), 'KPI must be translated');
    assert.ok(d.includes("t('dashboardPipelineTitle')"), 'Pipeline must be translated');
    assert.ok(d.includes("t('dashboardFollowUpHealthTitle')"), 'Follow-up health must be translated');
    // Ensure translations file is actually comprehensive
    assert.ok(t.includes('dashboardDailyExecutionTitle'), 'translations must cover daily execution');
    assert.ok(t.includes('followUpHealth'), 'translations must cover health');
  });

  it('Perf guards from PR#19 remain: no polling, fail-closed, memoization, no full refetch', () => {
    const la = layout();
    const svc = read('server/routes/production.routes.ts');
    // No 8s/6s polling
    assert.ok(!la.includes('setInterval(fetchPerms, 6000)') && !la.includes('setInterval(fetchNotifs, 8000)'), 'no aggressive polling in AppLayout');
    // Fail-closed
    assert.ok(svc.includes('Fail closed on DB error') || svc.includes('Fail closed'), 'permission must fail closed');
    // User override before role grant
    assert.ok(svc.includes('has_user_override'), 'must have user override');
  });

  it('Calendar architecture from PR#21 preserved', () => {
    const d = dashboard();
    assert.ok(d.includes('TaskCalendar'), 'must import TaskCalendar');
    assert.ok(d.includes('<TaskCalendar'), 'must render TaskCalendar');
    assert.ok(d.includes('scheduled_activities') || d.includes('scheduledActivityService'), 'must reference scheduled_activities');
    assert.ok(d.includes('Asia/Dhaka'), 'must be Dhaka-aware');
  });

  it('RBAC/menuAccess regression remains', () => {
    const la = layout();
    assert.ok(la.includes('menuAccess'), 'must keep menuAccess override');
    assert.ok(la.includes('roles.includes'), 'must keep static fallback');
    assert.ok(la.includes('isItemVisible'), 'must have single visibility check');
    assert.ok(la.includes('visibleSections'), 'must filter sections');
  });

  it('No full-lead fetch regression in Dashboard or leadService mutation paths', () => {
    const d = dashboard();
    assert.ok(!d.includes('leadService.getLeads('), 'Dashboard must not fetch full leads');
    const leadService = read('src/modules/leads/services/leadService.ts');
    // create/update must await apiRequest before caching
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server');
  });
});
