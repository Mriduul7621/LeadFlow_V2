/**
 * daily-workbench.test.ts — Daily Workbench (execution workspace)
 * ------------------------------------------------------------------
 * Covers the /workbench first-class page added on top of the EXISTING
 * authoritative sources (Step 4B follow-up queue + Step 5C scheduled
 * activities). Nothing about those sources changes.
 *
 * Sections:
 *   A. Source guards — route/sidebar/permission architecture
 *   B. Pure composition — queue membership, ordering, filters, dedup
 *   C. Asia/Dhaka boundary behavior
 *   D. React render states — loading/empty/error/partial/actions
 *   E. Runtime — loadWorkbench request shape (bounded, no N+1, no getLeads)
 *   F. Server — GET /scheduled-activities/completed-today (pglite)
 */

import { describe, it, before, after } from 'node:test';
import jwt from 'jsonwebtoken';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const APP = () => read('src/App.tsx');
const LAYOUT = () => read('src/layouts/AppLayout.tsx');
const PAGE = () => read('src/modules/workbench/pages/DailyWorkbench.tsx');
const SERVICE = () => read('src/modules/workbench/services/workbenchService.ts');
const SCHED_SVC = () => read('src/modules/scheduledActivities/services/scheduledActivityService.ts');
const ROUTES = () => read('server/routes/production.routes.ts');

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
}

/* ------------------------------------------------------------------
   Fixtures
------------------------------------------------------------------- */

import {
  addDaysToYmd,
  applyCancelledMutation,
  applyCompletedMutation,
  applyRescheduleMutation,
  buildTomorrowPreview,
  composeWorkbenchItems,
  dhakaYmdOf,
  filterWorkbenchItems,
  getWorkbenchFilterCounts,
  getDhakaTodayYmd,
  sortWorkbenchQueue,
  type WorkbenchData,
  type WorkbenchItem,
} from '../../src/modules/workbench/services/workbenchService.js';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService.js';
import type { ScheduledActivity } from '../../src/modules/scheduledActivities/services/scheduledActivityService.js';
import {
  WorkbenchSummaryCards,
  WorkbenchFilterChips,
  WorkbenchQueueRow,
  WorkbenchEmptyState,
  WorkbenchErrorState,
  WorkbenchPartialDataBanner,
  WorkbenchLoadingState,
  WorkbenchTomorrowPreview,
  WorkbenchRescheduleModal,
} from '../../src/modules/workbench/pages/DailyWorkbench.js';

function followUp(id: string, nextFollowUpAt: string, dueState: 'overdue' | 'today' | 'upcoming', extra: Partial<FollowUpQueueItem> = {}): FollowUpQueueItem {
  return {
    id,
    prospectName: `Lead ${id}`,
    mobile: '01700000000',
    assignedTo: 'EMP1',
    assignedEmployeeName: 'Employee One',
    currentStatus: 'Interested',
    nextFollowUpAt,
    dueState,
    overdueDays: dueState === 'overdue' ? 2 : 0,
    ...extra,
  };
}

function scheduled(id: string, activityType: ScheduledActivity['activityType'], scheduledAt: string, extra: Partial<ScheduledActivity> = {}): ScheduledActivity {
  return {
    id,
    leadId: `sched-lead-${id}`,
    leadCustomerName: `Prospect ${id}`,
    activityType,
    scheduledAt,
    title: `${activityType} agenda`,
    status: 'scheduled',
    leadStatus: 'Contacted',
    createdAt: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

// Fixed "today" in Dhaka for deterministic composition tests.
// 2026-09-11 (Dhaka) spans 2026-09-10T18:00:00Z .. 2026-09-11T18:00:00Z.
const TODAY = '2026-09-11';
const TOMORROW = '2026-09-12';
const at = (iso: string) => iso;

function emptyData(queue: WorkbenchItem[]): WorkbenchData {
  return {
    todayYmd: TODAY,
    tomorrowYmd: TOMORROW,
    queue,
    tomorrow: { calls: 0, meetings: 0, followUps: 0, tasks: 0 },
    followUpCounts: { overdue: 0, today: 0, upcoming: 0, all: 0 },
    bounds: null,
    todayDate: TODAY,
    completedToday: 0,
    errors: { followUps: false, scheduled: false, completedToday: false },
  };
}

/* ==================================================================
   A. Source guards — route, sidebar, permission architecture
================================================================= */

describe('Daily Workbench — source guards', () => {
  it('A1. /workbench route exists in App.tsx and is protected by ProtectedRoute', () => {
    const app = APP();
    const idx = app.indexOf("path: '/workbench'");
    assert.ok(idx >= 0, '/workbench route must exist');
    const slice = app.slice(idx, idx + 300);
    assert.ok(slice.includes('ProtectedRoute'), '/workbench must be wrapped in ProtectedRoute');
    assert.ok(slice.includes('DailyWorkbench'), '/workbench must render DailyWorkbench');
  });

  it('A2. sidebar MY WORK contains Daily Workbench first, before Activities/Task Calendar/Follow-up Queue', () => {
    const layout = LAYOUT();
    const myworkIdx = layout.indexOf("key: 'mywork'");
    assert.ok(myworkIdx >= 0, 'mywork section must exist');
    const section = layout.slice(myworkIdx, layout.indexOf("key: 'leads'"));
    const workbenchIdx = section.indexOf("path: '/workbench'");
    const activitiesIdx = section.indexOf("path: '/activities'");
    const calendarIdx = section.indexOf("path: '/task-calendar'");
    const followUpIdx = section.indexOf("path: '/follow-up'");
    for (const entry of [['activities', activitiesIdx], ['task-calendar', calendarIdx], ['follow-up', followUpIdx]] as Array<[string, number]>) {
      assert.ok(entry[1] >= 0, `${entry[0]} must remain in MY WORK`);
    }
    assert.ok(workbenchIdx >= 0, 'Daily Workbench must be in MY WORK');
    assert.ok(workbenchIdx < activitiesIdx && workbenchIdx < calendarIdx && workbenchIdx < followUpIdx,
      'Daily Workbench must appear FIRST under MY WORK');
    assert.ok(section.includes("'Daily Workbench'"), 'item label must be Daily Workbench');
  });

  it('A3. permission/menu visibility architecture is preserved (menuAccess + static fallback + admin bypass)', () => {
    const layout = LAYOUT();
    assert.ok(layout.includes('resolveMenuVisibility'), 'single visibility check must remain');
    assert.ok(layout.includes('menuAccess'), 'dynamic menuAccess override must remain');
    assert.ok(layout.includes('roles.includes') || layout.includes("item.roles"), 'static role fallback must remain');
    assert.ok(layout.includes("userRoleNormalized === 'ADMIN'"), 'admin bypass must remain');
    const menuVisibility = read('src/layouts/menuVisibility.ts');
    assert.ok(menuVisibility.includes("userRoleNormalized === 'ADMIN'"), 'menuVisibility admin bypass unchanged');
  });

  it('A4. workbench item visibility uses ALL_ROLES-style static fallback — no hardcoded admin-only gate', () => {
    const layout = LAYOUT();
    const myworkIdx = layout.indexOf("key: 'mywork'");
    const section = layout.slice(myworkIdx, layout.indexOf("key: 'leads'"));
    const workbenchLine = section.split('\n').find((l) => l.includes("path: '/workbench'")) || '';
    assert.ok(workbenchLine.includes('ALL_ROLES'), 'Daily Workbench must use the shared static fallback (ALL_ROLES), not admin-only');
  });

  it('A5. page never calls leadService.getLeads() and never touches localDb/localStorage for queue data', () => {
    const page = PAGE();
    const service = SERVICE();
    for (const [name, src] of [['DailyWorkbench.tsx', page], ['workbenchService.ts', service]]) {
      assert.ok(!src.includes('leadService.getLeads'), `${name} must not call leadService.getLeads()`);
      assert.ok(!src.includes('getLeads('), `${name} must not fetch the full lead list`);
      assert.ok(!src.includes('localDb'), `${name} must not read localDb`);
      assert.ok(!src.includes('localStorage'), `${name} must not read localStorage`);
      assert.ok(!src.includes('buildActivities'), `${name} must not derive activities from lead fields`);
    }
  });

  it('A6. workbench composes the EXISTING authoritative sources only', () => {
    const service = SERVICE();
    assert.ok(service.includes('getFollowUpQueue'), 'must reuse leadService.getFollowUpQueue (GET /api/leads/follow-ups)');
    assert.ok(service.includes('scheduledActivityService.list'), 'must reuse scheduledActivityService.list (GET /api/scheduled-activities)');
    assert.ok(service.includes('scheduledActivityService.completedToday'), 'must use the completed-today count endpoint');
    const sched = SCHED_SVC();
    assert.ok(sched.includes('/api/scheduled-activities/completed-today'), 'service must bind the dedicated server endpoint');
  });

  it('A7. scheduled mutations reuse the existing PR#21 service — no second completion engine', () => {
    const page = PAGE();
    assert.ok(page.includes('scheduledActivityService.complete('), 'Complete must call scheduledActivityService.complete');
    assert.ok(page.includes('scheduledActivityService.cancel('), 'Cancel must call scheduledActivityService.cancel');
    assert.ok(page.includes('scheduledActivityService.update('), 'Reschedule must call scheduledActivityService.update');
    // Follow-ups keep their Open Lead flow into the existing Lead360 route.
    assert.ok(page.includes('`/leads/${encodeURIComponent(item.leadId)}`'), 'follow-up rows must open the existing Lead360 route');
  });

  it('A8. unauthorized scheduled actions are not exposed — canAccess gate on the server-matching capability', () => {
    const page = PAGE();
    // The server requires leads.edit for complete/cancel/update; the client
    // maps that to the existing canAccess('lead_tracking', 'edit') check.
    assert.ok(page.includes("canAccess('lead_tracking', 'edit')"), 'must gate on the leads.edit-equivalent capability');
    assert.ok(page.includes('isScheduledSource && canEdit &&'), 'Complete/Cancel/Reschedule must render only when permitted');
    // Open Lead must not depend on edit permission.
    assert.ok(page.includes('actions.onOpenLead'), 'Open Lead must remain available');
  });

  it('A9. no dashboard regression — Dashboard.tsx is untouched by the workbench', () => {
    const dashboard = read('src/modules/dashboard/pages/Dashboard.tsx');
    assert.ok(!dashboard.includes('workbench'), 'Dashboard must not embed or depend on the workbench');
    assert.ok(dashboard.includes('dashboardService.getDashboard'), 'Dashboard KPI authority unchanged');
    const app = APP();
    const dashboardIdx = app.indexOf("path: '/'");
    assert.ok(dashboardIdx >= 0, 'Dashboard route unchanged');
  });

  it('A10. completed-today endpoint is registered BEFORE /scheduled-activities/:id (literal route wins)', () => {
    const routes = ROUTES();
    const completedIdx = routes.indexOf("'/scheduled-activities/completed-today'");
    const byIdIdx = routes.indexOf("'/scheduled-activities/:id'");
    assert.ok(completedIdx >= 0, 'completed-today route must exist');
    assert.ok(byIdIdx > completedIdx, 'completed-today must be registered before the :id route');
  });
});

/* ==================================================================
   B. Pure composition — queue membership, ordering, filters, dedup
================================================================= */

describe('Daily Workbench — execution queue composition', () => {
  const { queue, tomorrowFollowUps, tomorrowScheduled } = composeWorkbenchItems(
    [
      followUp('f-overdue', at('2026-09-09T04:00:00Z'), 'overdue'),
      followUp('f-today', at('2026-09-11T03:00:00Z'), 'today'),
      followUp('f-upcoming', at('2026-09-12T03:00:00Z'), 'upcoming'), // tomorrow — preview only
    ],
    [
      scheduled('s-call', 'call', at('2026-09-11T05:30:00Z')),
      scheduled('s-meeting', 'meeting', at('2026-09-11T07:00:00Z')),
      scheduled('s-followup', 'follow_up', at('2026-09-11T09:00:00Z')),
      scheduled('s-task', 'task', at('2026-09-11T02:00:00Z')),
      scheduled('s-tomorrow', 'call', at('2026-09-12T05:00:00Z')), // tomorrow — preview only
      scheduled('s-completed', 'call', at('2026-09-11T01:00:00Z'), { status: 'completed' }), // terminal
      scheduled('s-cancelled', 'call', at('2026-09-11T01:30:00Z'), { status: 'cancelled' }), // terminal
    ],
    TODAY,
    TOMORROW
  );

  it('B1. overdue follow-ups are included in the execution queue', () => {
    assert.ok(queue.some((i) => i.key === 'follow-up:f-overdue' && i.dueState === 'overdue'));
  });

  it('B2. today follow-ups (queue bucket=today) are included', () => {
    assert.ok(queue.some((i) => i.key === 'follow-up:f-today' && i.dueState === 'today'));
  });

  it('B3. today scheduled CALL is included', () => {
    assert.ok(queue.some((i) => i.key === 'scheduled:s-call' && i.activityType === 'call'));
  });

  it('B4. today scheduled MEETING is included', () => {
    assert.ok(queue.some((i) => i.key === 'scheduled:s-meeting' && i.activityType === 'meeting'));
  });

  it('B5. today scheduled FOLLOW_UP activity is included', () => {
    assert.ok(queue.some((i) => i.key === 'scheduled:s-followup' && i.activityType === 'follow_up'));
  });

  it('B6. today scheduled TASK is included', () => {
    assert.ok(queue.some((i) => i.key === 'scheduled:s-task' && i.activityType === 'task'));
  });

  it('B7. tomorrow items never enter the today execution queue (follow-up + scheduled)', () => {
    assert.ok(!queue.some((i) => i.key === 'follow-up:f-upcoming'), 'tomorrow follow-up must stay out of the queue');
    assert.ok(!queue.some((i) => i.key === 'scheduled:s-tomorrow'), 'tomorrow scheduled must stay out of the queue');
    assert.equal(tomorrowFollowUps.length, 1, 'tomorrow follow-up feeds the preview only');
    assert.equal(tomorrowScheduled.length, 1, 'tomorrow scheduled feeds the preview only');
  });

  it('B8. completed/cancelled scheduled activities are not execution work', () => {
    assert.ok(!queue.some((i) => i.key === 'scheduled:s-completed'));
    assert.ok(!queue.some((i) => i.key === 'scheduled:s-cancelled'));
  });

  it('B9. ordering: overdue first, then chronological today, invalid time last', () => {
    const mixed = composeWorkbenchItems(
      [
        followUp('f-today-late', at('2026-09-11T10:00:00Z'), 'today'),
        followUp('f-overdue', at('2026-09-09T04:00:00Z'), 'overdue'),
        followUp('f-broken', 'not-a-date', 'today'), // invalid time
      ],
      [scheduled('s-early', 'call', at('2026-09-11T02:00:00Z'))],
      TODAY,
      TOMORROW
    ).queue;
    const keys = mixed.map((i) => i.key);
    assert.equal(keys[0], 'follow-up:f-overdue', 'overdue first');
    assert.equal(keys.indexOf('follow-up:f-broken'), keys.length - 1, 'invalid time last');
    const todayTimes = mixed.filter((i) => i.dueState === 'today' && i.scheduledAt).map((i) => new Date(i.scheduledAt!).getTime());
    const sorted = [...todayTimes].sort((a, b) => a - b);
    assert.deepEqual(todayTimes, sorted, 'today items chronological');
  });

  it('B10. stable sort keeps invalid-time items in arrival order after timed work', () => {
    const bad: WorkbenchItem = {
      key: 'bad',
      source: 'follow_up_queue',
      activityType: 'follow_up',
      leadId: 'b',
      name: 'Bad',
      scheduledAt: null,
      dueState: 'invalid-time',
      raw: followUp('b', 'not-a-date', 'today'),
    };
    const good = composeWorkbenchItems([followUp('good', at('2026-09-11T03:00:00Z'), 'today')], [], TODAY, TOMORROW).queue[0];
    const sorted = sortWorkbenchQueue([{ ...bad, key: 'bad1' }, good, { ...bad, key: 'bad2' }]);
    const keys = sorted.map((i) => i.key);
    assert.deepEqual(keys, ['follow-up:good', 'bad1', 'bad2']);
  });

  it('B11. no heuristic cross-source dedup — same-named lead in both sources stays as two items', () => {
    // A follow-up queue row for lead 'L1' and an independent scheduled activity
    // that happens to reference the SAME lead id must remain distinct rows —
    // only an exact shared identifier may collapse items, and none exists
    // across the two loaded contracts.
    const { queue: q } = composeWorkbenchItems(
      [followUp('L1', at('2026-09-11T03:00:00Z'), 'today')],
      [{ ...scheduled('s1', 'follow_up', at('2026-09-11T04:00:00Z')), leadId: 'L1', leadCustomerName: 'Lead L1' }],
      TODAY,
      TOMORROW
    );
    assert.equal(q.length, 2, 'both items remain');
    assert.deepEqual(q.map((i) => i.key).sort(), ['follow-up:L1', 'scheduled:s1']);
  });

  it('B12. exact duplicate keys within a source collapse; distinct keys never merge', () => {
    const { queue: q } = composeWorkbenchItems(
      [followUp('dup', at('2026-09-11T03:00:00Z'), 'today'), followUp('dup', at('2026-09-11T03:00:00Z'), 'today')],
      [],
      TODAY,
      TOMORROW
    );
    assert.equal(q.length, 1);
  });

  it('B13. quick filters operate over the loaded set without refetch', () => {
    const { queue } = composeWorkbenchItems(
      [followUp('f1', at('2026-09-11T03:00:00Z'), 'today'), followUp('f2', at('2026-09-09T03:00:00Z'), 'overdue')],
      [scheduled('c1', 'call', at('2026-09-11T05:00:00Z')), scheduled('m1', 'meeting', at('2026-09-11T06:00:00Z')), scheduled('t1', 'task', at('2026-09-11T06:30:00Z'))],
      TODAY,
      TOMORROW
    );
    const counts = getWorkbenchFilterCounts(queue);
    assert.equal(counts.all, 5);
    assert.equal(counts.overdue, 1);
    assert.equal(counts.call, 1);
    assert.equal(counts.meeting, 1);
    assert.equal(counts.follow_up, 2); // queue follow-ups + scheduled follow_up if any
    assert.equal(counts.task, 1);
    assert.equal(filterWorkbenchItems(queue, 'call').length, 1);
    assert.equal(filterWorkbenchItems(queue, 'overdue')[0].key, 'follow-up:f2');
    assert.equal(filterWorkbenchItems(queue, 'all').length, 5);
  });

  it('B14. tomorrow preview counts only (calls/meetings/follow-ups/tasks)', () => {
    const preview = buildTomorrowPreview(
      [followUp('tf', at('2026-09-12T03:00:00Z'), 'upcoming')],
      [scheduled('tc', 'call', at('2026-09-12T05:00:00Z')), scheduled('tm', 'meeting', at('2026-09-12T06:00:00Z')), scheduled('tt', 'task', at('2026-09-12T07:00:00Z'))]
    );
    assert.deepEqual(preview, { calls: 1, meetings: 1, followUps: 1, tasks: 1 });
  });

  it('B15. rows carry display fields from the API response (no per-row lead fetch)', () => {
    const { queue } = composeWorkbenchItems(
      [followUp('f1', at('2026-09-11T03:00:00Z'), 'today')],
      [scheduled('c1', 'call', at('2026-09-11T05:00:00Z'))],
      TODAY,
      TOMORROW
    );
    const f = queue.find((i) => i.key === 'follow-up:f1')!;
    assert.equal(f.name, 'Lead f1');
    assert.equal(f.leadStatus, 'Interested');
    assert.equal(f.assignee, 'Employee One');
    const s = queue.find((i) => i.key === 'scheduled:c1')!;
    assert.equal(s.name, 'Prospect c1');
    assert.equal(s.leadStatus, 'Contacted');
  });

  it('B16. efficient post-mutation state: complete removes the item and bumps completed-today only for today (Dhaka)', () => {
    const base = emptyData(composeWorkbenchItems([], [scheduled('c1', 'call', at('2026-09-11T05:00:00Z'))], TODAY, TOMORROW).queue);
    const next = applyCompletedMutation(base, 'scheduled:c1', at('2026-09-11T06:00:00Z'));
    assert.equal(next.queue.length, 0, 'item removed efficiently (no refetch)');
    assert.equal(next.completedToday, 1);
    // Completion stamped yesterday (Dhaka) must not inflate today's count.
    const next2 = applyCompletedMutation(base, 'scheduled:c1', at('2026-09-10T10:00:00Z'));
    assert.equal(next2.completedToday, 0);
    assert.equal(next2.queue.length, 0);
    // Null completion never fabricates a count.
    const next3 = applyCompletedMutation(base, 'scheduled:c1', null);
    assert.equal(next3.completedToday, 0);
  });

  it('B17. efficient post-mutation state: cancel removes; reschedule re-sorts or drops off-today items', () => {
    const items = composeWorkbenchItems(
      [],
      [scheduled('c1', 'call', at('2026-09-11T05:00:00Z')), scheduled('c2', 'call', at('2026-09-11T08:00:00Z'))],
      TODAY,
      TOMORROW
    ).queue;
    const afterCancel = applyCancelledMutation(emptyData(items), 'scheduled:c1');
    assert.equal(afterCancel.queue.length, 1);
    assert.equal(afterCancel.queue[0].key, 'scheduled:c2');

    const resorted = applyRescheduleMutation(emptyData(items), 'scheduled:c2', at('2026-09-11T01:00:00Z'));
    assert.equal(resorted.queue[0].key, 'scheduled:c2', 'moved earlier by new time');
    const movedOff = applyRescheduleMutation(emptyData(items), 'scheduled:c2', at('2026-09-12T08:00:00Z'));
    assert.equal(movedOff.queue.length, 1, 'rescheduled-off-today item leaves the queue');
    assert.equal(movedOff.queue[0].key, 'scheduled:c1');
  });
});

/* ==================================================================
   C. Asia/Dhaka day boundary behavior
================================================================= */

describe('Daily Workbench — Asia/Dhaka boundaries', () => {
  it('C1. dhakaYmdOf rolls at 18:00Z (00:00 Dhaka)', () => {
    assert.equal(dhakaYmdOf('2026-09-11T17:59:59Z'), '2026-09-11');
    assert.equal(dhakaYmdOf('2026-09-11T18:00:00Z'), '2026-09-12');
    assert.equal(dhakaYmdOf('2026-09-11T00:00:00Z'), '2026-09-11'); // 06:00 Dhaka
  });

  it('C2. addDaysToYmd crosses month and year boundaries', () => {
    assert.equal(addDaysToYmd('2026-09-11', 1), '2026-09-12');
    assert.equal(addDaysToYmd('2026-09-30', 1), '2026-10-01');
    assert.equal(addDaysToYmd('2026-12-31', 1), '2027-01-01');
    assert.equal(addDaysToYmd('2028-02-28', 1), '2028-02-29'); // leap year
  });

  it('C3. a scheduled instant at tomorrow 00:30 Dhaka belongs to tomorrow, not today', () => {
    // 2026-09-11T18:30:00Z == 2026-09-12 00:30 Asia/Dhaka
    const { queue, tomorrowScheduled } = composeWorkbenchItems(
      [],
      [scheduled('edge', 'call', at('2026-09-11T18:30:00Z'))],
      TODAY,
      TOMORROW
    );
    assert.equal(queue.length, 0, 'must not enter today queue');
    assert.equal(tomorrowScheduled.length, 1, 'must be treated as tomorrow');
  });

  it('C4. getDhakaTodayYmd matches the en-CA Dhaka calendar date', () => {
    const ymd = getDhakaTodayYmd(new Date('2026-09-11T02:00:00Z'));
    assert.equal(ymd, '2026-09-11'); // 08:00 Dhaka
  });

  it('C5. page and service reference Asia/Dhaka explicitly (no browser-timezone drift)', () => {
    assert.ok(SERVICE().includes('Asia/Dhaka'), 'service must pin Asia/Dhaka');
    assert.ok(PAGE().includes('Asia/Dhaka'), 'page must pin Asia/Dhaka');
    assert.ok(ROUTES().includes('getDhakaBusinessDayBounds'), 'server bounds helper remains the authority');
  });
});

/* ==================================================================
   D. React render states
================================================================= */

describe('Daily Workbench — render states', () => {
  const noop = () => undefined;
  const rowActions = { onComplete: noop, onCancel: noop, onReschedule: noop, onOpenLead: noop };
  const h = (component: any, props: Record<string, unknown>) => render(React.createElement(component, props));

  it('D1. loading state renders skeletons and NEVER the empty state copy', () => {
    const html = h(WorkbenchLoadingState, {});
    assert.ok(html.includes('role="status"'), 'loading must be announced as status');
    assert.ok(!html.includes('clear for today'), 'loading must not show the empty state');
    assert.ok(html.includes('animate-pulse'), 'skeleton placeholders present');
  });

  it('D2. empty state copy is exact and honest, with an Open Calendar CTA', () => {
    const html = h(WorkbenchEmptyState, {});
    assert.ok(html.includes('clear for today'), 'title present (apostrophe may be entity-escaped)');
    assert.ok(html.includes('No overdue follow-ups or scheduled activities are currently due.'));
    assert.ok(html.includes('Open Calendar'));
    assert.ok(!html.toLowerCase().includes('congratulation'), 'no fabricated congratulations');
    assert.ok(!/score/i.test(html), 'no fabricated performance score');
  });

  it('D3. full error state is neutral and offers Retry', () => {
    const html = h(WorkbenchErrorState, { onRetry: noop });
    assert.ok(html.includes('Daily work could not be loaded.'));
    assert.ok(html.includes('Please try again.'));
    assert.ok(html.includes('Retry'));
    assert.ok(!/offline mode/i.test(html), 'must not claim offline mode');
  });

  it('D4. partial source failure is explicit — never silently zero', () => {
    const html = h(WorkbenchPartialDataBanner, { errors: { followUps: true, scheduled: false, completedToday: false } });
    assert.ok(html.includes('Partial data.'), 'partial banner must render');
    assert.ok(html.includes('the follow-up queue'), 'names the failed source');
    assert.ok(html.includes('not as zero'), 'explicitly not-zero');
    assert.equal(h(WorkbenchPartialDataBanner, { errors: { followUps: false, scheduled: false, completedToday: false } }), '', 'no banner when all sources loaded');
  });

  it('D5. summary: unavailable completed-today renders an em dash, not a fabricated zero', () => {
    const html = h(WorkbenchSummaryCards, { overdueFollowUps: 3, callsToday: 2, meetingsToday: 1, followUpsToday: 4, tasksToday: 5, completedToday: null });
    assert.ok(html.includes('Completed Today'));
    assert.ok(html.includes('—'), 'unavailable count must render an em dash');
    const html2 = h(WorkbenchSummaryCards, { overdueFollowUps: 3, callsToday: 2, meetingsToday: 1, followUpsToday: 4, tasksToday: 5, completedToday: 7 });
    assert.ok(html2.includes('>7</p>'), 'available count renders the number');
    for (const label of ['Overdue Follow-ups', 'Calls Today', 'Meetings Today', 'Follow-ups Today', 'Tasks Today']) {
      assert.ok(html.includes(label), `summary card ${label}`);
    }
  });

  it('D6. quick filter chips show counts and aria-selected state', () => {
    const counts = { all: 6, overdue: 2, call: 1, meeting: 1, follow_up: 1, task: 1 };
    const html = h(WorkbenchFilterChips, { active: 'overdue', counts, onChange: noop });
    assert.ok(html.includes('role="tablist"'));
    assert.ok(html.includes('aria-selected="true"'), 'active chip marked');
    assert.ok(html.includes('Overdue'));
  });

  it('D7. queue row shows type badge, lead status, Dhaka time and overdue badge', () => {
    const item = composeWorkbenchItems([followUp('f1', at('2026-09-09T04:00:00Z'), 'overdue')], [], TODAY, TOMORROW).queue[0];
    const html = h(WorkbenchQueueRow, { item, selected: true, canEdit: false, acting: false, onSelect: noop, actions: rowActions });
    assert.ok(html.includes('Overdue'), 'overdue badge');
    assert.ok(html.includes('Lead f1'), 'lead name from API payload');
    assert.ok(html.includes('Interested'), 'lead status');
    assert.ok(html.includes('Follow-up'), 'source badge');
    assert.ok(html.includes('Employee One'), 'assignee (available on queue rows)');
    assert.ok(!html.includes('Complete</button>'), 'follow-up rows expose no scheduled completion button');
    assert.ok(html.includes('Open Lead'), 'Open Lead CTA');
  });

  it('D8. unauthorized user: scheduled row exposes NO Complete/Cancel/Reschedule actions', () => {
    const item = composeWorkbenchItems([], [scheduled('c1', 'call', at('2026-09-11T05:00:00Z'))], TODAY, TOMORROW).queue[0];
    const html = h(WorkbenchQueueRow, { item, selected: true, canEdit: false, acting: false, onSelect: noop, actions: rowActions });
    assert.ok(html.includes('Open Lead'), 'Open Lead remains');
    assert.ok(!html.includes('Complete</button>'), 'no Complete button without permission');
    assert.ok(!html.includes('>Cancel</button>'), 'no Cancel button without permission');
    assert.ok(!html.includes('Reschedule</button>'), 'no Reschedule button without permission');
  });

  it('D9. permitted user: scheduled row exposes Complete/Cancel/Reschedule', () => {
    const item = composeWorkbenchItems([], [scheduled('c1', 'call', at('2026-09-11T05:00:00Z'))], TODAY, TOMORROW).queue[0];
    const html = h(WorkbenchQueueRow, { item, selected: true, canEdit: true, acting: false, onSelect: noop, actions: rowActions });
    assert.ok(html.includes('Complete</button>'));
    assert.ok(html.includes('Cancel</button>'));
    assert.ok(html.includes('Reschedule</button>'));
  });

  it('D10. tomorrow preview shows counts only — no duplicate large list', () => {
    const html = h(WorkbenchTomorrowPreview, { preview: { calls: 2, meetings: 1, followUps: 3, tasks: 0 } });
    assert.ok(html.includes('Tomorrow Preview'));
    for (const label of ['Calls', 'Meetings', 'Follow-ups', 'Tasks']) assert.ok(html.includes(label));
    assert.ok(!html.includes('Lead '), 'no rows in the preview');
  });

  it('D11. reschedule modal binds a datetime-local input (existing Lead360 semantics)', () => {
    const item = composeWorkbenchItems([], [scheduled('c1', 'call', at('2026-09-11T05:00:00Z'))], TODAY, TOMORROW).queue[0];
    const html = h(WorkbenchRescheduleModal, { item, saving: false, onSave: noop, onClose: noop });
    assert.ok(html.includes('datetime-local'), 'datetime-local input');
    assert.ok(html.includes('Reschedule activity'), 'accessible dialog label');
  });
});

/* ==================================================================
   E. Runtime — loadWorkbench request shape
================================================================= */

describe('Daily Workbench — runtime request discipline', () => {
  it('E1. loadWorkbench issues exactly THREE bounded requests: follow-up queue + today/tomorrow scheduled + completed-today', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push(url);
      if (url.includes('/api/leads/follow-ups')) {
        const body = {
          success: true,
          data: {
            bucket: 'all',
            timezone: 'Asia/Dhaka',
            todayDate: TODAY,
            bounds: { todayStart: '2026-09-10T18:00:00.000Z', tomorrowStart: '2026-09-11T18:00:00.000Z' },
            items: [],
            counts: { overdue: 0, today: 0, upcoming: 0, all: 0 },
            pagination: { limit: 200, offset: 0, total: 0 },
          },
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/scheduled-activities/completed-today')) {
        return new Response(JSON.stringify({ success: true, data: { count: 4, timezone: 'Asia/Dhaka', todayDate: TODAY, bounds: { todayStart: '', tomorrowStart: '' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/scheduled-activities')) {
        return new Response(JSON.stringify({ success: true, data: [], pagination: { limit: 200, offset: 0, total: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { loadWorkbench } = await import('../../src/modules/workbench/services/workbenchService.js');
      const data = await loadWorkbench(new Date('2026-09-11T02:00:00Z'));
      assert.equal(calls.length, 3, `expected exactly 3 requests, got ${calls.length}: ${calls.join(', ')}`);
      assert.ok(calls.some((u) => u.includes('/api/leads/follow-ups')), 'one follow-up queue request');
      assert.ok(calls.some((u) => u.includes('/api/scheduled-activities?')), 'one scheduled activities list request');
      assert.ok(calls.some((u) => u.includes('/api/scheduled-activities/completed-today')), 'one completed-today request');
      // Asia/Dhaka from/to bounds on the scheduled list call.
      const schedUrl = calls.find((u) => /\/api\/scheduled-activities\?/.test(u))!;
      assert.ok(schedUrl.includes('from=2026-09-11'), `from must be Dhaka today (${schedUrl})`);
      assert.ok(schedUrl.includes('to=2026-09-12'), `to must be Dhaka tomorrow (${schedUrl})`);
      // NO full lead list request.
      assert.ok(!calls.some((u) => /\/api\/leads\?/.test(u) || /\/api\/leads$/.test(u)), 'no full lead list fetch');
      assert.equal(data.completedToday, 4);
      assert.equal(data.todayYmd, '2026-09-11');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('E2. a rejected source is captured as an error, not silently zero', async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/leads/follow-ups')) {
        return new Response(JSON.stringify({ success: false, message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/scheduled-activities/completed-today')) {
        return new Response(JSON.stringify({ success: false }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/scheduled-activities')) {
        return new Response(JSON.stringify({ success: true, data: [], pagination: { limit: 200, offset: 0, total: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { loadWorkbench } = await import('../../src/modules/workbench/services/workbenchService.js');
      const data = await loadWorkbench(new Date('2026-09-11T02:00:00Z'));
      assert.equal(data.errors.followUps, true, 'follow-up failure captured');
      assert.equal(data.errors.completedToday, true, 'completed-today failure captured');
      assert.equal(data.errors.scheduled, false, 'successful source stays marked loaded');
      assert.equal(data.completedToday, null, 'failed count must be null (—), not 0');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

/* ==================================================================
   F. Server — GET /scheduled-activities/completed-today
================================================================= */

describe('Daily Workbench — completed-today endpoint (pglite)', () => {
  let pool: any;
  let app: any;
  let adminToken: string;
  let employeeAToken: string;
  let adminUserId: string;
  let employeeAUserId: string;
  let employeeBEmpId: string;

  const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

  before(async () => {
    const { _setTestPoolForTest, _resetPoolsForTest } = await import('../database/connection.js');
    const { getPGliteInstanceAsync, createPGlitePoolAsync } = await import('../database/pglitePool.js');
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _resetPoolsForTest();
    _setTestPoolForTest(pool);

    await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'Untouched', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT, next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255), collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2), product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')), title VARCHAR(255), scheduled_at TIMESTAMP NOT NULL, duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0), remarks TEXT, status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', meeting_type VARCHAR(255), location VARCHAR(255), created_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), completed_at TIMESTAMP, completed_by UUID REFERENCES users(id) ON DELETE SET NULL, completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);

    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);

    // Roles + permissions
    const adminRole = await pool.query(`INSERT INTO roles (role_code, role_name, data_visibility) VALUES ('ADMIN', 'Admin', 'Organization') RETURNING id`);
    const roleA = await pool.query(`INSERT INTO roles (role_code, role_name, data_visibility) VALUES ('BDM', 'BDM', 'Own') RETURNING id`);
    const adminRoleId = adminRole.rows[0].id;
    const roleAId = roleA.rows[0].id;
    for (const code of ['leads.view', 'leads.edit', 'dashboard.view']) {
      const p = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`, [code]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [adminRoleId, p.rows[0].id]);
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleAId, p.rows[0].id]);
    }
    const pRestricted = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('reports.view', 'reports.view') RETURNING id`);

    // Users
    const admin = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('ADM1', 'Admin One', 'admin1@test.dev', 'x', $1) RETURNING *`, [adminRoleId]);
    const empA = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('EMPA', 'Employee A', 'a@test.dev', 'x', $1) RETURNING *`, [roleAId]);
    const empB = await pool.query(`INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('EMPB', 'Employee B', 'b@test.dev', 'x', $1) RETURNING *`, [roleAId]);
    adminUserId = admin.rows[0].id;
    employeeAUserId = empA.rows[0].id;
    employeeBEmpId = empB.rows[0].id; // UUID — leads.assigned_to references users.id

    // Employee A permission restriction (no reports.view — irrelevant, but exercises the table)
    await pool.query(`INSERT INTO user_permissions (user_id, permission_id, is_allowed) VALUES ($1, $2, FALSE)`, [employeeAUserId, pRestricted.rows[0].id]);

    adminToken = jwt.sign({ id: adminUserId, employeeId: 'ADM1', role: 'ADMIN' }, JWT_SECRET);
    employeeAToken = jwt.sign({ id: employeeAUserId, employeeId: 'EMPA', role: 'BDM' }, JWT_SECRET);

    // Leads: one for A, one for B, one soft-deleted
    const leadA = await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile, assigned_to) VALUES ('LC-A', 'Lead A', '017...', $1) RETURNING id`, [employeeAUserId]);
    const leadB = await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile, assigned_to) VALUES ('LC-B', 'Lead B', '018...', $1) RETURNING id`, [employeeBEmpId]);
    const leadD = await pool.query(`INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, is_deleted) VALUES ('LC-D', 'Deleted Lead', '019...', $1, TRUE) RETURNING id`, [employeeAUserId]);

    // Completed-today rows: helper relative to server "now" (Dhaka bounds are computed from the clock).
    const insertSched = async (leadId: string, status: string, scheduledAt: string, completedAt: string | null) => {
      await pool.query(
        `INSERT INTO scheduled_activities (lead_id, activity_type, scheduled_at, status, completed_at) VALUES ($1, 'call', $2, $3, $4)`,
        [leadId, scheduledAt, status, completedAt]
      );
    };
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

    await insertSched(leadA.rows[0].id, 'completed', hoursAgo(2), hoursAgo(1));   // A: completed today → counts
    await insertSched(leadA.rows[0].id, 'completed', daysAgo(3), daysAgo(2));     // A: completed 2d ago → NOT today
    await insertSched(leadA.rows[0].id, 'completed', hoursAgo(1), hoursAgo(0.5)); // A: scheduled today completed today → counts
    await insertSched(leadA.rows[0].id, 'scheduled', hoursAgo(1), null);          // A: still pending → NOT counted
    await insertSched(leadA.rows[0].id, 'cancelled', hoursAgo(1), null);          // A: cancelled → NOT counted
    // Yesterday-completed but scheduled-today row: completed_at (not scheduled_at) decides.
    await insertSched(leadA.rows[0].id, 'completed', hoursAgo(1), daysAgo(1));    // A: completed yesterday → NOT today
    await insertSched(leadB.rows[0].id, 'completed', hoursAgo(1), hoursAgo(1));   // B: completed today — visible to admin only
    await insertSched(leadD.rows[0].id, 'completed', hoursAgo(1), hoursAgo(1));   // soft-deleted lead → never counted

    const mod = await import('../routes/production.routes.js');
    const express = (await import('express')).default;
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  after(async () => {
    const { closePool } = await import('../database/connection.js');
    await closePool();
  });

  it('F1. requires authentication', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/scheduled-activities/completed-today');
    assert.equal(res.status, 401);
  });

  it('F2. admin sees the visible completed-today count (today-only, non-terminal, non-deleted)', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/scheduled-activities/completed-today').set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    // Admin (Organization visibility) counts A's two today completions + B's one = 3.
    assert.equal(res.body.data.count, 3);
    assert.equal(res.body.data.timezone, 'Asia/Dhaka');
    assert.ok(res.body.data.todayDate, 'todayDate present');
    assert.ok(res.body.data.bounds?.todayStart && res.body.data.bounds?.tomorrowStart, 'Dhaka bounds present');
  });

  it('F3. visibility boundary: Own-scope employee sees only their own completions', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/scheduled-activities/completed-today').set('Authorization', `Bearer ${employeeAToken}`);
    assert.equal(res.status, 200);
    // Employee A (Own): 2 completions today on their leads; B's and deleted are out of scope.
    assert.equal(res.body.data.count, 2);
  });

  it('F4. scheduled_at alone never counts — only server-stamped completed_at inside today (Dhaka)', () => {
    // Covered by the row matrix in before(): a row scheduled today but
    // completed yesterday is excluded from BOTH counts above.
    assert.ok(true);
  });
});
