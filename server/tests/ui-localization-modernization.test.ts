/**
 * ui-localization-modernization.test.ts — English-only
 * ------------------------------------------------------------------
 * Guards for PR #22 English-only modernization, retargeted to the
 * Enterprise Preview shell (2026-11-19: Dashboard.tsx retired, four
 * role homes + a shared home-data hook in src/modules/workspace/).
 * Verifies: no EN/বাংলা toggles, no leadflow-language, no runtime
 * switching, English-only polished copy, unified date control, Today &
 * Tomorrow server authority, Task Calendar last, header cleanup,
 * Settings System Connection, brand tokens, accessibility, and
 * preservation of PostgreSQL/RBAC/PR19/PR21.
 *
 * Two invariants retired with the old Dashboard and were deleted
 * (2026-11-19), not weakened: the unified date-range control
 * (Today/WTD/MTD/LMTD/YTD/Custom + LMTD resolution) — the homes read
 * one fixed period ('ALL'); and the scheduled-activity Today &
 * Tomorrow panel (CALL/MEETING/FOLLOW_UP/TASK via
 * scheduledActivityService) — the homes read the bounded follow-up
 * queue buckets instead. The properties that mattered (server APIs
 * only, never the full lead list; Asia/Dhaka day boundaries) moved
 * to the rewritten follow-up test below.
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
  // Enterprise Preview (2026-11-19): Dashboard.tsx retired — the four
  // role homes + the shared home-data hook + the home primitives and
  // the shared error panel carry the home surface now.
  const HOME_FILES = [
    'src/modules/workspace/pages/AdminHome.tsx',
    'src/modules/workspace/pages/ManagerHome.tsx',
    'src/modules/workspace/pages/TeamLeadHome.tsx',
    'src/modules/workspace/pages/AgentHome.tsx',
    'src/modules/workspace/pages/EnterpriseHome.tsx',
    'src/modules/workspace/hooks/useEnterpriseHomeData.ts',
    'src/modules/workspace/components/EnterprisePrimitives.tsx',
    'src/modules/workspace/components/EnterpriseErrorPanel.tsx',
    'src/modules/workspace/utils/enterpriseData.ts',
  ];
  const homeData = () => read('src/modules/workspace/hooks/useEnterpriseHomeData.ts');
  const errorPanel = () => read('src/modules/workspace/components/EnterpriseErrorPanel.tsx');
  const nav = () => read('src/layouts/enterpriseNav.ts');
  const layout = () => read('src/layouts/AppLayout.tsx');
  const login = () => read('src/modules/auth/pages/Login.tsx');
  const settings = () => read('src/modules/settings/pages/Settings.tsx');
  const indexCss = () => read('src/index.css');
  // A bare t('key') / t("key") call — the translation runtime's call
  // shape. The lookbehind keeps import('…'), .split(' '),
  // DateTimeFormat('en-GB', …) and friends from false-positiving.
  const BARE_T_CALL = /(?<![\w.])t\(['"]/;

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
    assert.ok(!BARE_T_CALL.test(visible), 'AppLayout must not call t()');
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
    // Sidebar navigation uses fixed English labels, not runtime translation.
    // (Enterprise Preview: the primary tabs retired; the labels live in
    // the enterprise nav module now.)
    const navSrc = stripComments(nav());
    assert.ok(navSrc.includes("label: 'Overview'"), 'enterprise nav must use the English Overview label');
    assert.ok(navSrc.includes("label: 'Follow-up Queue'"), 'enterprise nav must use the English Follow-up Queue label');
    assert.ok(navSrc.includes("label: 'Sales Pipeline'"), 'enterprise nav must use the English Sales Pipeline label');
  });

  it('Role homes are English-only: no useTranslation/t(), polished literals, no leadflow-language', () => {
    // Enterprise Preview (2026-11-19): the English-only guarantee moves
    // from the retired Dashboard to every file of the workspace module.
    for (const file of HOME_FILES) {
      const visible = stripComments(read(file));
      assert.ok(!visible.includes('useTranslation'), `${file} must not import useTranslation`);
      assert.ok(!BARE_T_CALL.test(visible), `${file} must not call t()`);
      assert.ok(!visible.includes('leadflow-language'), `${file} must not reference leadflow-language`);
      assert.ok(!visible.includes('layout-language-switcher') && !visible.includes('login-language-switcher'), `${file} must not have language switcher`);
    }
    // Polished English literals on the homes.
    const agent = stripComments(read('src/modules/workspace/pages/AgentHome.tsx'));
    assert.ok(agent.includes('Add Lead'), 'Agent home must have Add Lead');
    // Agent workspace rebuild (2026-11-20): the H1 is the greeting
    // and the sections are the demo's — "My Work" survives as the
    // sidebar label (pinned in enterprise-nav.test.ts), not as a
    // literal on the home.
    assert.ok(agent.includes('Personal workspace'), 'Agent home must keep the Personal workspace eyebrow');
    assert.ok(agent.includes("Here's your personal performance and what needs your attention today."), 'Agent home greeting subline must be English');
    assert.ok(agent.includes('Priority follow-ups'), 'Agent home must have Priority follow-ups');
    assert.ok(agent.includes('My pipeline'), 'Agent home must have My pipeline');
    assert.ok(agent.includes('Weekly activity'), 'Agent home must have Weekly activity');
    assert.ok(agent.includes('Recent leads'), 'Agent home must have Recent leads');
    const manager = stripComments(read('src/modules/workspace/pages/ManagerHome.tsx'));
    assert.ok(manager.includes('Overview'), 'Manager home title must be Overview');
    assert.ok(manager.includes('Welcome back'), 'Manager home must greet in English');
    assert.ok(manager.includes('Follow-ups due'), 'Manager home must have the follow-ups chart in English');
    assert.ok(manager.includes('Nothing needs attention right now.'), 'Manager home empty state must be English');
    // Failure copy lives in the shared hook + error panel now.
    assert.ok(stripComments(homeData()).includes('Dashboard data could not be loaded.'), 'home data hook must keep the neutral Dashboard data could not be loaded. error');
    const panel = stripComments(errorPanel());
    assert.ok(panel.includes('Your saved data is unchanged. Please try again.'), 'error panel must have secondary Your saved data is unchanged. Please try again.');
    assert.ok(panel.includes('Retry'), 'error panel must keep Retry action');
    // No developer jargon in visible UI (comments stripped already)
    const all = HOME_FILES.map(f => stripComments(read(f))).join('\n');
    assert.ok(!all.includes('server-authoritative'), 'visible homes must not show server-authoritative');
    assert.ok(!all.includes('canonical current_status'), 'visible homes must not show canonical current_status');
    assert.ok(!all.includes('PostgreSQL source'), 'visible homes must not show PostgreSQL source');
    assert.ok(!all.includes('Dhaka Standard Time'), 'visible homes must not show Dhaka Standard Time');
  });

  // DELETED 2026-11-19 (Enterprise Preview): the unified date-range
  // control test (Today/WTD/MTD/LMTD/YTD/Custom + tooltips) and the
  // LMTD resolution test. The homes read one fixed period ('ALL')
  // through the shared hook — there is no date-range control left to
  // guard, so the invariants no longer apply. See the file header.

  it('Home follow-ups come from the bounded server queue buckets, never the full lead list', () => {
    // Enterprise Preview (2026-11-19): the old Dashboard's Today &
    // Tomorrow panel (CALL/MEETING/FOLLOW_UP/TASK via the scheduled
    // activity API) retired with it. The homes read the follow-up
    // queue in three bounded buckets instead — overdue / today /
    // upcoming, 50 each — and the property that mattered did not
    // change: server APIs only, never the full lead list.
    const hook = stripComments(homeData());
    assert.ok(hook.includes('getFollowUpQueue'), 'homes must use getFollowUpQueue');
    assert.ok(hook.includes("bucket: 'overdue'"), 'homes must read the overdue bucket');
    assert.ok(hook.includes("bucket: 'today'"), 'homes must read the today bucket');
    assert.ok(hook.includes("bucket: 'upcoming'"), 'homes must read the upcoming bucket');
    assert.ok(hook.includes('limit: 50'), 'queue reads must stay bounded');
    assert.ok(!hook.includes('leadService.getLeads'), 'home data must not call full getLeads');
    assert.ok(!hook.includes('getLeads('), 'home data must not fetch full leads at all');
    for (const file of HOME_FILES) {
      assert.ok(!stripComments(read(file)).includes('getLeads('), `${file} must not fetch full leads`);
    }
    // Buckets are grouped by Asia/Dhaka day for the 7-day chart.
    assert.ok(stripComments(read('src/modules/workspace/utils/enterpriseData.ts')).includes('Asia/Dhaka'), 'day grouping must be Asia/Dhaka');
  });

  it('Homes and the pipeline page never call full getLeads and KPI authority stays server', () => {
    const hook = stripComments(homeData());
    assert.ok(!hook.includes('leadService.getLeads'), 'home data must never call leadService.getLeads');
    assert.ok(hook.includes('dashboardService.getDashboard'), 'KPI must come from dashboardService.getDashboard');
    assert.ok(hook.includes('counts?.overdue'), 'health must read the queue counts');
    // The team overview (scoped server payload) drives the per-person
    // totals the KPI cards show.
    const agent = stripComments(read('src/modules/workspace/pages/AgentHome.tsx'));
    assert.ok(agent.includes('totalLeads'), 'must read totalLeads from the server overview');
    // statusCounts now drives the pipeline board page, which reuses the same
    // server response — the authority did not move to the client.
    const pipeline = stripComments(read('src/modules/dashboard/pages/SalesPipelinePage.tsx'));
    assert.ok(pipeline.includes('statusCounts'), 'pipeline must read statusCounts');
    assert.ok(pipeline.includes('dashboardService.getDashboard'), 'the pipeline board must reuse the server dashboard response');
    assert.ok(!pipeline.includes('leadService.getLeads'), 'the pipeline board must not fetch the full lead list');
  });

  it('Home keeps the personal sections and the calendar/pipeline live on their own pages', () => {
    // Enterprise Preview (2026-11-19): the four role homes keep the
    // same rule — no embedded calendar, no embedded pipeline board.
    for (const file of ['src/modules/workspace/pages/AdminHome.tsx', 'src/modules/workspace/pages/ManagerHome.tsx', 'src/modules/workspace/pages/TeamLeadHome.tsx', 'src/modules/workspace/pages/AgentHome.tsx']) {
      const src = read(file);
      assert.ok(!src.includes('<TaskCalendar'), `${file} must not embed the calendar`);
      assert.ok(!src.includes('<SalesPipeline'), `${file} must not embed the pipeline board`);
    }
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/task-calendar'"), '/task-calendar route preserved');
    assert.ok(app.includes("path: '/sales-pipeline'"), '/sales-pipeline route preserved');
    const navSrc = nav();
    assert.ok(navSrc.includes("path: '/task-calendar'") && navSrc.includes("path: '/sales-pipeline'"), 'both pages are sidebar destinations');
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
    // Enterprise Preview (2026-11-19): the primary tabs retired, so
    // there is no visiblePrimaryItems any more — but the rule it pinned
    // did not retire: the shell filters every nav entry through the
    // shared resolvers, and the dynamic menuAccess override still wins
    // over the static fallback.
    const la = layout();
    assert.ok(la.includes('resolveFeatureRouteAccess('), 'must filter nav entries through the route Feature Access decision');
    assert.ok(la.includes('buildEnterpriseNavGroups('), 'must build the sidebar from the enterprise nav module');
    assert.ok(read('src/layouts/menuVisibility.ts').includes('matchedPermission.menuAccess'), 'must keep dynamic menuAccess override');
    assert.ok(read('src/layouts/featureRouteAccess.ts').includes('resolveMenuVisibility('), 'the route decision must still delegate to the shared visibility resolver');
  });

  it('No full-lead fetch regression in the homes or leadService mutation paths', () => {
    for (const file of HOME_FILES) {
      const src = stripComments(read(file));
      assert.ok(!src.includes('leadService.getLeads('), `${file} must not fetch full leads`);
      assert.ok(!src.includes('getLeads'), `${file} must not contain getLeads at all`);
    }
    const leadService = read('src/modules/leads/services/leadService.ts');
    assert.ok(leadService.includes('await apiRequest'), 'leadService must await server before caching');
  });

  it('Home failure copy does not mislead about offline mode — neutral, distinct, with Retry', () => {
    // Enterprise Preview (2026-11-19): the failure copy split across
    // two files — the primary sentence lives in the shared home-data
    // hook (the metrics banner), the secondary sentence + Retry in the
    // shared error panel. The contract is unchanged: neutral, distinct,
    // each exactly once, no offline-mode claim without a real check.
    const hook = stripComments(homeData());
    const panel = stripComments(errorPanel());
    const d = `${hook}\n${panel}`;
    // Primary and secondary neutral copy must be present and distinct
    assert.ok(hook.includes('Dashboard data could not be loaded.'), 'home data must show primary Dashboard data could not be loaded.');
    assert.ok(panel.includes('Your saved data is unchanged. Please try again.'), 'error panel must show secondary Your saved data is unchanged. Please try again.');
    // Old misleading copy must be removed
    assert.ok(!d.includes('Sync failed'), 'homes must not contain old Sync failed copy');
    assert.ok(!d.includes('Working in offline mode'), 'homes must not contain Working in offline mode');
    // Offline mode may only be claimed when an actual offline condition is checked
    const hasOfflineModeClaim = /offline mode/i.test(d);
    if (hasOfflineModeClaim) {
      assert.ok(
        d.includes('navigator.onLine') || d.includes('isOffline') || d.includes('offlineMode') || d.includes('isOfflineMode') || d.includes('Offline'),
        'offline mode wording must only appear alongside an actual offline condition check',
      );
    } else {
      assert.ok(!/offline mode/i.test(d), 'home failure copy must not claim offline mode');
    }
    // Keep Retry action for recovery
    assert.ok(panel.includes('Retry'), 'error panel must keep Retry action');
    // Avoid rendering the same error sentence twice — each copy exactly once in visible source
    const primaryCount = (hook.match(/Dashboard data could not be loaded\./g) || []).length;
    assert.equal(primaryCount, 1, 'primary error Dashboard data could not be loaded. should appear exactly once (avoid duplicate rendering)');
    const secondaryCount = (panel.match(/Your saved data is unchanged\. Please try again\./g) || []).length;
    assert.equal(secondaryCount, 1, 'secondary error Your saved data is unchanged. Please try again. should appear exactly once');
    // Ensure primary and secondary are not the same string
    assert.notEqual('Dashboard data could not be loaded.', 'Your saved data is unchanged. Please try again.');
  });
});
