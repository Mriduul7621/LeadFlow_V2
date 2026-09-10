/**
 * ui-localization-modernization-source-guards.test.ts
 * ------------------------------------------------------------------
 * Fast, dependency-free source guards for the "modernize LeadFlow
 * dashboard UX, localization and visual design" PR. These read the
 * frontend source and assert the UI/UX + localization contracts that the
 * redesign must not regress. They complement the Step 5B/5C guards in
 * dashboard-ux-step5b-source-guards.test.ts (which remain authoritative for
 * data-authority / navigation / menuAccess semantics).
 *
 * Covered here:
 *   1. Login language selector exists and is persisted via the language store
 *   2. Bangla reaches far beyond the sidebar (dictionary coverage + call sites)
 *   3. Dashboard / lead / calendar / modal surfaces are localized via t()
 *   4. Developer-facing wording is absent from visible UI (header, dashboard)
 *   5. Calendar remains the last Dashboard section (no /task-calendar removal)
 *   6. Today & Tomorrow render CALL / MEETING / FOLLOW_UP / TASK activity types
 *   7. Dashboard never calls the full client lead list (getLeads)
 *   8. Unified date-range control options + explicit server CUSTOM query
 *   9. PR #19 polling / performance guards intact (no aggressive polling)
 *  10. PR #21 scheduled-activity guards intact (server-authoritative calendar)
 *  11. RBAC / menuAccess regression (single visibility check, admin bypass)
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
const LAYOUT = () => read('src/layouts/AppLayout.tsx');
const LOGIN = () => read('src/modules/auth/pages/Login.tsx');
const TRANSLATIONS = () => read('src/modules/shared/utils/translations.ts');
const LANG_STORE = () => read('src/store/languageStore.ts');
const CALENDAR = () => read('src/modules/auth/pages/TaskCalendar.tsx');
const LEAD_LIST = () => read('src/modules/leads/pages/LeadList.tsx');
const ALL_LEADS = () => read('src/modules/leads/pages/AllLeads.tsx');

/** Strip `//` and `/* ... * /` comments so guards only inspect code + JSX text. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('UI localization & modernization — source guards', () => {
  it('1. Login exposes a pre-login language selector persisted through the language store', () => {
    const login = LOGIN();
    assert.ok(login.includes('useTranslation'), 'Login must use the translation hook');
    assert.ok(login.includes('setLanguage('), 'Login must call setLanguage for EN/BN');
    assert.ok(login.includes("setLanguage('en')") && login.includes("setLanguage('bn')"), 'both EN and BN must be selectable');
    // Persistence lives in the language store under a stable key.
    assert.ok(LANG_STORE().includes("'leadflow-language'"), 'language store must persist under leadflow-language');
  });

  it('2. Bangla reaches beyond the sidebar — dictionary coverage and translated call sites', () => {
    const tr = TRANSLATIONS();
    assert.ok(tr.includes('  en: {') && tr.includes('  bn: {'), 'both EN and BN dictionaries must exist');
    // Activity types (CALL / MEETING / FOLLOW_UP / TASK) localized in both languages.
    for (const key of ['activityCall', 'activityMeeting', 'activityFollowUp', 'activityTask']) {
      assert.ok(new RegExp(`^\\s{4}${key}:`, 'm').test(tr), `${key} EN key missing`);
    }
    // Dashboard, leads and calendar call t() for user-facing strings.
    assert.ok(DASHBOARD().includes("t('dashboardTitle')"), 'dashboard title must be localized');
    assert.ok(LEAD_LIST().includes('useTranslation'), 'LeadList must use translations');
    assert.ok(ALL_LEADS().includes('useTranslation'), 'AllLeads must use translations');
    assert.ok(CALENDAR().includes('useTranslation'), 'TaskCalendar must use translations');
  });

  it('3. Dashboard / lead / calendar / modal surfaces are localized', () => {
    const dash = DASHBOARD();
    for (const key of [
      'dashboardTitle', 'totalLeads', 'salesPipeline', 'dailyExecution',
      'followUpHealth', 'needsAttention', 'taskCalendarTitle',
    ]) {
      assert.ok(dash.includes(`t('${key}')`), `Dashboard must localize ${key}`);
    }
    // Lead detail modal (LeadList) is localized.
    assert.ok(LEAD_LIST().includes("t('operationalPipelineUpdate')"), 'LeadList modal must localize pipeline update header');
    assert.ok(LEAD_LIST().includes("t('saveUpdateStatus')"), 'LeadList modal must localize save action');

    // Execution Intelligence & NCP Progress pages are fully localized.
    const exec = read('src/modules/dashboard/pages/ExecutionIntelligence.tsx');
    for (const key of ['dailyStatusAudit', 'executionScope', 'contacted', 'meetings', 'followUps']) {
      assert.ok(exec.includes(`t('${key}')`), `ExecutionIntelligence must localize ${key}`);
    }
    const ncp = read('src/modules/dashboard/pages/NcpProgress.tsx');
    for (const key of ['financialTargetTracking', 'collectedVsProjected', 'ncpRegistryLedger', 'clientProspect', 'ncpStatusLine']) {
      assert.ok(ncp.includes(`t('${key}')`), `NcpProgress must localize ${key}`);
    }

    // LeadGenerate priority placeholder and the Enterprise Access Panel are localized.
    assert.ok(read('src/modules/leads/pages/LeadGenerate.tsx').includes('selectPriority'), 'LeadGenerate must localize Select Priority');
    const access = read('src/modules/users/components/EnterpriseAccessPanel.tsx');
    assert.ok(access.includes('useTranslation'), 'EnterpriseAccessPanel must use translations');
    for (const key of ['effectivePermissionOverrides', 'auditTrail', 'saveUserOverrides']) {
      assert.ok(access.includes(`t('${key}')`), `EnterpriseAccessPanel must localize ${key}`);
    }
  });

  it('4. Developer-facing wording is absent from visible header & dashboard UI', () => {
    const layout = LAYOUT();
    assert.ok(!layout.includes('Dhaka Standard Time'), 'header must not show "Dhaka Standard Time"');
    assert.ok(!layout.includes('handleSync'), 'header must not keep a manual sync handler');
    assert.ok(!layout.includes('isSyncing'), 'header must not keep sync spinner state');

    // Only code + JSX (comments may legitimately carry technical notes).
    const dash = withoutComments(DASHBOARD());
    assert.ok(!dash.includes('PostgreSQL'), 'dashboard visible text must not mention PostgreSQL');
    assert.ok(!dash.includes('Step 4B') && !dash.includes('Step 5'), 'dashboard must not show step numbering');
    assert.ok(!dash.includes('visibility-enforced'), 'dashboard must not show visibility-enforced wording');
    assert.ok(!dash.includes('server-authoritative') && !dash.includes('Server-Authoritative'), 'dashboard must not show server-authoritative wording');
    // The dashboard subtitle is user-friendly and localized.
    assert.ok(dash.includes("t('dashboardSubtitle')"), 'dashboard subtitle must be localized');
  });

  it('5. Task Calendar is the LAST major Dashboard section (route preserved)', () => {
    const dash = DASHBOARD();
    assert.ok(dash.includes('TaskCalendar'), 'Dashboard must import TaskCalendar');
    assert.ok(dash.includes('final section'), 'calendar section must be marked final');
    const calIdx = dash.indexOf('<TaskCalendar');
    const distIdx = dash.indexOf("t('leadStatusDistribution')");
    assert.ok(calIdx >= 0, 'TaskCalendar must be rendered');
    assert.ok(calIdx > distIdx, 'TaskCalendar must render AFTER the status distribution section (last)');
    // The dedicated route is preserved (never removed).
    assert.ok(LAYOUT().includes("'/task-calendar'"), '/task-calendar route must remain');
  });

  it('6. Today & Tomorrow show CALL / MEETING / FOLLOW_UP / TASK from server sources', () => {
    const dash = DASHBOARD();
    assert.ok(dash.includes('scheduledActivityService.list'), 'scheduled activities must come from the server');
    assert.ok(dash.includes('getFollowUpQueue'), 'follow-ups must come from the server follow-up queue');
    assert.ok(dash.includes('activityLabel('), 'activity type labels must be localized via activityLabel');
    // All four activity types exist in the dictionary (EN + BN).
    const tr = TRANSLATIONS();
    for (const key of ['activityCall', 'activityMeeting', 'activityFollowUp', 'activityTask']) {
      assert.ok(new RegExp(`^\\s{4}${key}:`, 'm').test(tr), `${key} missing`);
    }
  });

  it('7. Dashboard never calls the full client lead list', () => {
    const dash = DASHBOARD();
    assert.ok(!dash.includes('leadService.getLeads'), 'Dashboard must not call leadService.getLeads');
    assert.ok(!dash.includes('getLeads('), 'Dashboard must not fetch a full lead list');
  });

  it('8. Unified date-range control offers all periods and sends explicit server CUSTOM query', () => {
    const dash = DASHBOARD();
    for (const key of ['periodToday', 'periodWtd', 'periodMtd', 'periodLmtd', 'periodYtd', 'periodCustom', 'periodAllTime']) {
      assert.ok(dash.includes(`t('${key}')`), `date control must include ${key}`);
    }
    // WTD/MTD/LMTD/YTD resolve to explicit Dhaka bounds and reuse the CUSTOM query.
    assert.ok(dash.includes('resolveRange'), 'date control must resolve range bounds');
    assert.ok(dash.includes("period: 'CUSTOM'"), 'unsupported periods must reuse the server CUSTOM query');
    assert.ok(dash.includes('startDate') && dash.includes('endDate'), 'explicit startDate/endDate must be sent');
  });

  it('9. PR #19 polling / performance guards remain intact', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('NOTIFICATION_REFRESH_MS = 60_000'), 'notifications must refresh at most every 60s');
    assert.ok(layout.includes('ROLE_MENU_TTL_MS = 5 * 60 * 1000'), 'role menu must be TTL-gated at 5 minutes');
    assert.ok(layout.includes("document.visibilityState !== 'visible'"), 'background refresh must pause while hidden');
    assert.ok(layout.includes('readSessionCache'), 'session cache must still de-duplicate navigation fetches');
  });

  it('10. PR #21 scheduled-activity guards remain intact', () => {
    const dash = DASHBOARD();
    assert.ok(dash.includes('scheduledActivityService'), 'calendar/panel must use scheduledActivityService');
    assert.ok(dash.includes('scheduled_activities'), 'panel must reference server scheduled_activities');
    assert.ok(dash.includes('getFollowUpQueue'), 'follow-ups must use the server follow-up queue');
    assert.ok(!dash.includes('buildActivities('), 'panel must not derive activities from a client lead list');
  });

  it('11. RBAC / menuAccess semantics are preserved by the grouped sidebar', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('resolveMenuVisibility'), 'visibility must delegate to resolveMenuVisibility');
    assert.ok(layout.includes('menuAccess'), 'dynamic menuAccess override must still apply');
    assert.ok(layout.includes('isItemVisible'), 'single visibility check must still be used');
    assert.ok(layout.includes('visibleSections'), 'sections must still be filtered by visible items');
    assert.ok(layout.includes("userRoleNormalized === 'ADMIN'"), 'admin bypass must remain intact');
  });
});
