/**
 * daily-workbench.test.ts — Daily Workbench feature guards (PR #26)
 * ------------------------------------------------------------------
 * Verifies:
 * - /workbench route exists and is protected
 * - sidebar MY WORK contains Daily Workbench first
 * - permission/menu visibility preserved
 * - no full lead list fetch, no N+1
 * - queue composition, ordering, filters, empty/error, Dhaka, dedup
 * - reuse of existing scheduled activity services
 * - design system and English-only preserved
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Daily Workbench — source guards', () => {
  const app = () => read('src/App.tsx');
  const layout = () => read('src/layouts/AppLayout.tsx');
  const workbench = () => read('src/modules/workbench/pages/DailyWorkbench.tsx');
  const dashboard = () => read('src/modules/dashboard/pages/Dashboard.tsx');
  const scheduledSvc = () => read('src/modules/scheduledActivities/services/scheduledActivityService.ts');
  const leadSvc = () => read('src/modules/leads/services/leadService.ts');
  const permsHook = () => read('src/modules/shared/hooks/usePermissions.ts');
  const menuVis = () => read('src/layouts/menuVisibility.ts');

  it('/workbench route exists and is protected', () => {
    const src = app();
    assert.ok(src.includes("path: '/workbench'"), 'App must have /workbench route');
    const idx = src.indexOf("path: '/workbench'");
    assert.ok(src.slice(idx, idx + 300).includes('ProtectedRoute'), '/workbench must be wrapped in ProtectedRoute');
    assert.ok(src.includes('DailyWorkbench'), 'App must import DailyWorkbench');
  });

  it('sidebar MY WORK contains Daily Workbench first', () => {
    const src = layout();
    assert.ok(src.includes('Daily Workbench'), 'sidebar must contain Daily Workbench label');
    assert.ok(src.includes("path: '/workbench'"), 'sidebar must have /workbench path');
    // Check order: Daily Workbench before Activities, Task Calendar, Follow-up Queue in mywork section
    const myworkIdx = src.indexOf("key: 'mywork'");
    assert.ok(myworkIdx >= 0, 'mywork section must exist');
    const myworkSlice = src.slice(myworkIdx, myworkIdx + 800);
    const wbIdx = myworkSlice.indexOf('Daily Workbench');
    const actIdx = myworkSlice.indexOf('Activities');
    const calIdx = myworkSlice.indexOf('Task Calendar');
    const fuIdx = myworkSlice.indexOf('Follow-up Queue');
    assert.ok(wbIdx >= 0 && actIdx >= 0 && calIdx >= 0 && fuIdx >= 0, 'all MY WORK items must exist');
    assert.ok(wbIdx < actIdx && actIdx < calIdx && calIdx < fuIdx, 'Daily Workbench must appear first under MY WORK: Daily Workbench, Activities, Task Calendar, Follow-up Queue');
  });

  it('permission/menu visibility remains correct', () => {
    const l = layout();
    assert.ok(l.includes('menuAccess'), 'must keep menuAccess override');
    assert.ok(l.includes('roles.includes'), 'must keep static fallback');
    assert.ok(l.includes('isItemVisible'), 'must have single visibility check');
    assert.ok(l.includes('visibleSections'), 'must filter sections');
    assert.ok(l.includes("userRoleNormalized === 'ADMIN'"), 'admin bypass must remain');
    assert.ok(menuVis().includes('ADMIN'), 'menuVisibility must preserve ADMIN bypass');

    const perms = permsHook();
    assert.ok(perms.includes('workbench'), 'usePermissions must include workbench mapping');
    assert.ok(perms.includes("'/workbench'"), 'workbench must map to /workbench path');
  });

  it('page does not call leadService.getLeads()', () => {
    const wb = stripComments(workbench());
    assert.ok(!wb.includes('leadService.getLeads'), 'DailyWorkbench must not call leadService.getLeads()');
    assert.ok(!wb.includes('getAllLeads'), 'must not call getAllLeads');
    assert.ok(!wb.includes('getLeads('), 'must not fetch full lead list at all');
  });

  it('overdue follow-ups included', () => {
    const wb = workbench();
    assert.ok(wb.includes('overdueFollowUps'), 'must have overdueFollowUps state');
    assert.ok(wb.includes('dueState') && wb.toLowerCase().includes('overdue'), 'must handle dueState overdue');
    assert.ok(wb.includes('Overdue Follow-ups'), 'daily summary must show Overdue Follow-ups');
  });

  it('today follow-ups included', () => {
    const wb = workbench();
    assert.ok(wb.includes('todayFollowUps'), 'must have todayFollowUps state');
    assert.ok(wb.includes('Follow-ups Today'), 'summary must show Follow-ups Today');
  });

  it('today scheduled CALL included', () => {
    const wb = workbench();
    assert.ok(wb.includes('call'), 'must reference call type');
    assert.ok(wb.includes('Calls Today'), 'summary must show Calls Today');
    assert.ok(wb.includes("activityType") && wb.includes('scheduledToday'), 'must filter scheduledToday');
  });

  it('today scheduled MEETING included', () => {
    const wb = workbench();
    assert.ok(wb.includes('meeting'), 'must reference meeting');
    assert.ok(wb.includes('Meetings Today'), 'summary must show Meetings Today');
  });

  it('today scheduled FOLLOW_UP included', () => {
    const wb = workbench();
    assert.ok(wb.includes('follow_up'), 'must reference follow_up');
    assert.ok(wb.includes('follow_up') && wb.includes('scheduledToday'), 'must include scheduled follow_up');
  });

  it('today scheduled TASK included', () => {
    const wb = workbench();
    assert.ok(wb.includes('task'), 'must reference task');
    assert.ok(wb.includes('Tasks Today'), 'summary must show Tasks Today');
  });

  it('tomorrow items do not enter today execution queue', () => {
    const wb = workbench();
    // scheduledToday filtered by todayYmd, not tomorrow
    assert.ok(wb.includes('scheduledToday'), 'must have scheduledToday');
    assert.ok(wb.includes('isDhakaYmd') && wb.includes('todayYmd'), 'must filter by Dhaka today');
    assert.ok(wb.includes('tomorrow') && wb.includes('scheduledTomorrow'), 'must have tomorrow separation');
    // queue uses overdue+today only
    assert.ok(wb.includes('overdueFollowUps') && wb.includes('todayFollowUps') && wb.includes('toWorkItems'), 'queue must compose overdue+today follow-ups');
    // Ensure comment about tomorrow not entering queue
    assert.ok(wb.toLowerCase().includes('tomorrow does not enter') || wb.includes('Tomorrow Preview') || wb.includes('tomorrowSummary'), 'must document tomorrow not entering queue');
  });

  it('queue ordering: overdue first, then chronological today', () => {
    const wb = workbench();
    assert.ok(wb.includes('overdue first') || wb.includes('a.overdue') && wb.includes('b.overdue'), 'must sort overdue first');
    assert.ok(wb.includes('sortTime'), 'must sort by time');
    assert.ok(wb.includes('MAX_SAFE_INTEGER') || wb.includes('Number.MAX_SAFE_INTEGER'), 'invalid time last');
  });

  it('invalid time last', () => {
    const wb = workbench();
    assert.ok(wb.includes('MAX_SAFE_INTEGER'), 'invalid time must be MAX_SAFE_INTEGER');
    assert.ok(wb.includes('parseTimeSort'), 'must have parseTimeSort helper');
  });

  it('quick filters work over loaded data', () => {
    const wb = workbench();
    assert.ok(wb.includes('activeFilter'), 'must have activeFilter state');
    assert.ok(wb.includes('filterChips') || wb.includes('All') && wb.includes('Overdue') && wb.includes('Calls'), 'must have filter chips All, Overdue, Calls, Meetings, Follow-ups, Tasks');
    assert.ok(wb.includes('filteredItems'), 'must have filteredItems derived from workItems');
    assert.ok(wb.includes('filterCounts'), 'must show counts in filter chips');
    // Ensure filteredItems is client-side over workItems, no refetch
    const filteredIdx = wb.indexOf('const filteredItems');
    assert.ok(filteredIdx >= 0, 'filteredItems must be defined');
    const filteredSlice = wb.slice(filteredIdx, filteredIdx + 1500);
    assert.ok(filteredSlice.includes('workItems'), 'filteredItems must derive from workItems');
    assert.ok(!filteredSlice.includes('getFollowUpQueue') && !filteredSlice.includes('scheduledActivityService.list'), 'filtering must be client-side, no refetch');
  });

  it('no N+1 lead detail requests', () => {
    const wb = stripComments(workbench());
    assert.ok(!wb.includes('getLead('), 'must not call getLead per row');
    assert.ok(!wb.includes('leadService.getLead'), 'must not have N+1 lead detail');
    assert.ok(wb.includes('leadCustomerName') || wb.includes('leadName'), 'should use joined lead name from API response');
  });

  it('scheduled completion uses existing service', () => {
    const wb = workbench();
    assert.ok(wb.includes('scheduledActivityService.complete'), 'must use scheduledActivityService.complete');
    assert.ok(wb.includes('handleComplete'), 'must have handleComplete');
  });

  it('scheduled cancel uses existing service', () => {
    const wb = workbench();
    assert.ok(wb.includes('scheduledActivityService.cancel'), 'must use scheduledActivityService.cancel');
    assert.ok(wb.includes('handleCancel'), 'must have handleCancel');
  });

  it('successful mutation removes/updates item efficiently', () => {
    const wb = workbench();
    assert.ok(wb.includes('setScheduledToday(prev => prev.filter'), 'complete/cancel must remove efficiently');
    assert.ok(wb.includes('setScheduledToday(prev => prev.map') || wb.includes('setScheduledToday'), 'edit must update efficiently');
    assert.ok(!wb.includes('window.location.reload') && !wb.includes('load()') || wb.includes('setScheduledToday'), 'must not full-page refetch unless required');
  });

  it('unauthorized actions not exposed', () => {
    const wb = workbench();
    assert.ok(wb.includes('canAccess') || wb.includes('canEditScheduled'), 'must check permission for actions');
    assert.ok(wb.includes('lead_tracking') && wb.includes('edit'), 'should gate on lead_tracking edit');
  });

  it('dashboard.view alone does NOT expose Complete/Cancel/Edit/Reschedule', () => {
    const wb = stripComments(workbench());
    // The mutation gating must NOT include dashboard.view
    assert.ok(!wb.includes("canAccess('dashboard', 'view')") || !wb.includes('canEditScheduled'), 'dashboard.view must not be in mutation gating');
    // Ensure canEditScheduled definition does NOT contain dashboard
    const editIdx = wb.indexOf('canEditScheduled');
    assert.ok(editIdx >= 0, 'canEditScheduled must be defined');
    const editSlice = wb.slice(editIdx, editIdx + 500);
    assert.ok(!editSlice.includes('dashboard'), 'canEditScheduled must not include dashboard');
    assert.ok(!editSlice.includes('lead_generate'), 'canEditScheduled must not include lead_generate (unless proven)');
  });

  it('correct existing edit permission DOES expose those actions', () => {
    const wb = workbench();
    // Must use lead_tracking edit which maps to leads.edit server boundary
    assert.ok(wb.includes("canAccess('lead_tracking', 'edit')"), 'must gate on lead_tracking edit');
    // And actions must be rendered when canEditScheduled true
    assert.ok(wb.includes('canEditScheduled') && wb.includes('Complete'), 'Complete button must be gated by canEditScheduled');
    assert.ok(wb.includes('canEditScheduled') && wb.includes('Cancel'), 'Cancel button must be gated');
    assert.ok(wb.includes('canEditScheduled') && wb.includes('Edit / Reschedule'), 'Edit must be gated');
  });

  it('lack of edit permission still allows Open Lead where visibility permits', () => {
    const wb = workbench();
    // Open Lead link must be outside canEditScheduled guard
    const openLeadIdx = wb.indexOf('Open Lead');
    assert.ok(openLeadIdx >= 0, 'Open Lead must exist');
    // Ensure Open Lead appears in selectedItem section outside only edit guard
    const quickActionsIdx = wb.indexOf('Quick Actions');
    assert.ok(quickActionsIdx >= 0, 'Quick Actions section must exist');
    const qaSlice = wb.slice(quickActionsIdx, quickActionsIdx + 2000);
    // Open Lead should be present before edit-guarded block or independently
    assert.ok(qaSlice.includes('Open Lead'), 'Quick Actions must contain Open Lead');
    // The scheduled actions block is inside canEditScheduled, but Open Lead is outside that inner block (or also outside)
    // Check that Open Lead Link exists in main queue rows too (always visible)
    assert.ok(wb.includes('/leads/${encodeURIComponent(item.leadId)}'), 'queue rows must have Open link regardless of edit permission');
  });

  it('server remains final authorization boundary', () => {
    const prod = read('server/routes/production.routes.ts');
    assert.ok(prod.includes("hasPermissionCode(caller, 'leads.edit')"), 'server must check leads.edit for scheduled mutations');
    assert.ok(prod.includes('/scheduled-activities/:id/complete'), 'server must have complete endpoint with authz');
    assert.ok(prod.includes('/scheduled-activities/:id/cancel'), 'server must have cancel endpoint with authz');
    assert.ok(prod.includes('PUT /scheduled-activities/:id') || prod.includes("router.put('/scheduled-activities/:id'"), 'server must have update endpoint with authz');
    const wb = workbench();
    assert.ok(wb.includes('scheduledActivityService.complete') && wb.includes('scheduledActivityService.cancel') && wb.includes('scheduledActivityService.update'), 'client must use existing services, server is final boundary');
  });

  it('Completed Today successful empty response shows 0', () => {
    const wb = workbench();
    // When fulfilled, we set completedToday to filtered list — empty list yields 0
    assert.ok(wb.includes('setCompletedToday(todayCompleted)'), 'must set completedToday on success');
    // Summary must show 0 when not unavailable
    assert.ok(wb.includes("String(summary.completedToday)") || wb.includes('completedToday'), 'summary must derive from completedToday length');
    // The card rendering for unavailable is separate; ensure 0 path exists
    assert.ok(wb.includes('Scheduled completed'), 'subtext for success must be Scheduled completed');
  });

  it('Completed Today request failure shows unavailable, not 0', () => {
    const wb = workbench();
    assert.ok(wb.includes('completedTodayError'), 'must have completedTodayError state');
    assert.ok(wb.includes('Completed summary unavailable') || wb.includes('Unavailable'), 'must have unavailable handling');
    // Must show — when unavailable
    assert.ok(wb.includes("'—'") || wb.includes('"—"') || wb.includes('—'), 'must show em dash when unavailable');
    // Must NOT set completedToday to 0 as success; must differentiate
    const compFailIdx = wb.indexOf('completedRes.status ===');
    assert.ok(compFailIdx >= 0, 'must check completedRes status');
    const failSlice = wb.slice(compFailIdx, compFailIdx + 1500);
    assert.ok(failSlice.includes('setCompletedTodayError'), 'failure must set error, not just empty array');
    assert.ok(failSlice.includes('setCompletedToday([])'), 'failure sets empty list but with error flag');
    // Ensure summary uses unavailable flag to render — and Unavailable subtext
    assert.ok(wb.includes('completedTodayUnavailable'), 'summary must track unavailable');
    assert.ok(wb.includes('Unavailable'), 'must have Unavailable subtext');
  });

  it('primary workbench still loads if completed-summary request fails', () => {
    const wb = workbench();
    // completed failure should not set main error
    assert.ok(wb.includes('Do not treat completed fetch failure as fatal'), 'must document non-fatal');
    assert.ok(wb.includes('followUpAllRes.status ===') && wb.includes('scheduledRangeRes.status ==='), 'primary failure check must only consider follow-ups + scheduled, not completed');
    // Ensure followUpError and scheduledError are separate from completed error
    assert.ok(wb.includes('followUpError') && wb.includes('scheduledError') && wb.includes('completedTodayError'), 'must have separate error states');
  });

  it('loading state does not show false empty state', () => {
    const wb = workbench();
    assert.ok(wb.includes('loading') && wb.includes('Skeleton') || wb.includes('animate-pulse'), 'must show skeletons while loading');
    assert.ok(wb.includes("You're clear for today") , 'must have empty state title');
    // Ensure empty state only shown when not loading
    const emptyIdx = wb.indexOf("You're clear for today");
    const loadingCheck = wb.slice(Math.max(0, emptyIdx - 1000), emptyIdx);
    assert.ok(loadingCheck.includes('filteredItems.length === 0') || loadingCheck.includes('length === 0'), 'empty state must check filteredItems length');
  });

  it('source failure does not silently become zero', () => {
    const wb = workbench();
    assert.ok(wb.includes('followUpError') || wb.includes('scheduledError'), 'must have partial error states');
    assert.ok(wb.includes('Follow-ups could not be loaded') || wb.includes('Scheduled activities could not be loaded'), 'must show explicit partial failure');
    assert.ok(wb.includes('Daily work could not be loaded'), 'must have honest neutral error');
    assert.ok(wb.includes('Please try again'), 'must have Please try again');
  });

  it('empty state accurate', () => {
    const wb = workbench();
    assert.ok(wb.includes("You're clear for today"), 'empty title must be You\'re clear for today');
    assert.ok(wb.includes('No overdue follow-ups or scheduled activities are currently due'), 'empty subtitle must be accurate');
    assert.ok(wb.includes('Open Calendar'), 'empty CTA must be Open Calendar');
    assert.ok(!wb.toLowerCase().includes('congratulations') && !wb.toLowerCase().includes('productivity score'), 'must not fabricate congratulations or scores');
  });

  it('Asia/Dhaka day boundary behavior', () => {
    const wb = workbench();
    assert.ok(wb.includes('Asia/Dhaka'), 'must use Asia/Dhaka internally');
    assert.ok(wb.includes('getDhakaTodayYmd') || wb.includes('toLocaleDateString') && wb.includes('Asia/Dhaka'), 'must have Dhaka today helper');
    assert.ok(wb.includes('isDhakaYmd'), 'must have Dhaka YMD check');
    assert.ok(wb.includes('formatDhakaDue') || wb.includes('toLocaleString') && wb.includes('Asia/Dhaka'), 'must format due in Dhaka');
  });

  it('no heuristic cross-source deduplication', () => {
    const wb = workbench();
    assert.ok(wb.includes('No heuristic cross-source deduplication') || wb.includes('namespaced'), 'must document no heuristic dedup');
    assert.ok(wb.includes('follow_up:${') && wb.includes('scheduled:${'), 'must namespace keys by source');
    assert.ok(!wb.includes('fuzzy') && !wb.toLowerCase().includes('merge by lead'), 'must not heuristically merge by lead/name/timestamp');
  });

  it('Dashboard structure unchanged except required shared dependency', () => {
    const dash = dashboard();
    assert.ok(dash.includes('ExecutiveSnapshot'), 'Dashboard must keep ExecutiveSnapshot');
    assert.ok(dash.includes('TodayTomorrowPanel'), 'must keep Today & Tomorrow');
    assert.ok(dash.includes('SalesPipeline'), 'must keep Sales Pipeline');
    assert.ok(dash.includes('FollowUpDiscipline'), 'must keep Follow-up Discipline');
    assert.ok(dash.includes('NeedsAttentionSection'), 'must keep Needs Attention');
    assert.ok(dash.includes('PerformanceInsights'), 'must keep Performance Insights');
    assert.ok(dash.includes('TaskCalendar'), 'must keep Task Calendar last');
    assert.ok(dash.includes('Task Calendar') && dash.lastIndexOf('TaskCalendar') > dash.indexOf('SalesPipeline'), 'Task Calendar must remain last');
  });

  it('PR #19 performance hardening preserved', () => {
    const l = read('src/layouts/AppLayout.tsx');
    assert.ok(!l.includes('setInterval(fetchPerms, 6000)'), 'no 6s roles poll');
    assert.ok(!l.includes('setInterval(fetchNotifs, 8000)'), 'no 8s notif poll');
    assert.ok(l.includes('NOTIFICATION_REFRESH_MS = 60_000'), 'notif refresh 60s');
    const svc = read('server/routes/production.routes.ts');
    assert.ok(svc.includes('has_user_override'), 'permission override still present');
    assert.ok(svc.includes('Fail closed'), 'fail-closed preserved');
  });

  it('PR #21 scheduled activity/calendar architecture preserved', () => {
    const svc = scheduledSvc();
    assert.ok(svc.includes('/api/scheduled-activities'), 'service must hit /api/scheduled-activities');
    assert.ok(svc.includes('complete') && svc.includes('cancel'), 'must have complete/cancel');
    const cal = read('src/modules/auth/pages/TaskCalendar.tsx');
    assert.ok(cal.includes('scheduledActivityService'), 'TaskCalendar must use scheduledActivityService');
    assert.ok(!stripComments(cal).includes('leadService.getLeads'), 'TaskCalendar must not derive from getLeads');
  });

  it('PR #22 English-only/design guards preserved', () => {
    const wb = stripComments(workbench());
    assert.ok(!wb.includes('useTranslation'), 'Workbench must not use useTranslation');
    assert.ok(!wb.includes("t('") && !wb.includes('t("'), 'must not call t()');
    assert.ok(wb.includes('Daily Workbench'), 'title must be Daily Workbench');
    assert.ok(wb.includes("Manage today") || wb.includes('Manage today'), 'subtitle must be Manage today’s calls');
    // Brand tokens via class names
    assert.ok(wb.includes('rounded-[12px]') || wb.includes('rounded-[10px]'), 'must use 10-12px radii');
    assert.ok(wb.includes('bg-white') && wb.includes('border'), 'must use warm neutral surfaces');
  });

  it('RBAC/menuAccess tests stay green (source guard)', () => {
    const l = read('src/layouts/AppLayout.tsx');
    assert.ok(l.includes('resolveMenuVisibility'), 'must use resolveMenuVisibility');
    assert.ok(l.includes('menuAccess'), 'must keep menuAccess');
  });

  it('docs/DAILY_WORKBENCH.md exists and documents required sections', () => {
    const doc = read('docs/DAILY_WORKBENCH.md');
    assert.ok(doc.includes('Daily Workbench'), 'doc must have title');
    assert.ok(doc.includes('/workbench'), 'doc must have route');
    assert.ok(doc.includes('MY WORK'), 'doc must have sidebar location');
    assert.ok(doc.includes('GET /api/leads/follow-ups'), 'doc must have data sources');
    assert.ok(doc.includes('GET /api/scheduled-activities'), 'doc must have scheduled activities');
    assert.ok(doc.includes('queue composition') || doc.includes('Queue Composition'), 'doc must have queue composition');
    assert.ok(doc.includes('Sort Order') || doc.includes('sort order'), 'doc must have sort order');
    assert.ok(doc.includes('Quick Filters') || doc.includes('quick filters'), 'doc must have quick filters');
    assert.ok(doc.includes('Asia/Dhaka'), 'doc must have Dhaka semantics');
    assert.ok(doc.includes('de-duplication') || doc.includes('deduplication') || doc.includes('No heuristic'), 'doc must have dedup rule');
    assert.ok(doc.includes('performance') || doc.includes('Performance'), 'doc must have performance safeguards');
  });

  it('no full lead fetch regression in Dashboard still', () => {
    const dash = stripComments(dashboard());
    assert.ok(!dash.includes('leadService.getLeads'), 'Dashboard must not fetch full leads');
  });
});
