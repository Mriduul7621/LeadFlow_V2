import { leadService, type FollowUpQueueItem, type FollowUpQueueResult } from '../../leads/services/leadService';
import {
  scheduledActivityService,
  type ScheduledActivity,
} from '../../scheduledActivities/services/scheduledActivityService';

/**
 * workbenchService.ts — Daily Workbench composition layer (client).
 * ------------------------------------------------------------------
 * Composes the unified daily execution queue from the two EXISTING
 * authoritative sources — no new mutation semantics, no full lead list:
 *
 *   1. GET /api/leads/follow-ups            (Step 4B queue, server buckets)
 *   2. GET /api/scheduled-activities        (Step 5C planned work)
 *   3. GET /api/scheduled-activities/completed-today  (authoritative count)
 *
 * The server remains the visibility boundary (Own/DownTeam/FullTeam/
 * Organization) and the Asia/Dhaka business-day authority. This module
 * only shapes, sorts and filters what those endpoints already returned.
 */

export type WorkbenchActivityType = 'call' | 'meeting' | 'follow_up' | 'task';
export type WorkbenchSource = 'follow_up_queue' | 'scheduled_activity';
export type WorkbenchDueState = 'overdue' | 'today' | 'invalid-time';
export type WorkbenchFilter = 'all' | 'overdue' | 'call' | 'meeting' | 'follow_up' | 'task';

export interface WorkbenchItem {
  /** Namespaced EXACT identifier — the ONLY de-duplication key. */
  key: string;
  source: WorkbenchSource;
  activityType: WorkbenchActivityType;
  leadId: string;
  name: string;
  title?: string | null;
  /** Due/scheduled instant (ISO) or null when missing/unparseable. */
  scheduledAt: string | null;
  leadStatus?: string | null;
  dueState: WorkbenchDueState;
  overdueDays?: number;
  /** Follow-up queue rows carry the assignee employee name; scheduled rows do not. */
  assignee?: string | null;
  mobile?: string | null;
  raw: FollowUpQueueItem | ScheduledActivity;
}

export interface WorkbenchTomorrowPreview {
  calls: number;
  meetings: number;
  followUps: number;
  tasks: number;
}

export interface WorkbenchData {
  todayYmd: string;
  tomorrowYmd: string;
  /** Sorted execution queue: overdue first, then chronological today, invalid time last. */
  queue: WorkbenchItem[];
  tomorrow: WorkbenchTomorrowPreview;
  /** Authoritative server-side follow-up bucket counts over the whole visible scope. */
  followUpCounts: FollowUpQueueResult['counts'];
  /** Server bounds echoed by the follow-up queue response (Asia/Dhaka). */
  bounds: { todayStart: string; tomorrowStart: string } | null;
  todayDate: string | null;
  /** Authoritative completed-today count; null when the source failed (never fake 0). */
  completedToday: number | null;
  /** Per-source failure flags — partial failures must never silently read as zero. */
  errors: { followUps: boolean; scheduled: boolean; completedToday: boolean };
}

/* ------------------------------------------------------------------
   Asia/Dhaka calendar helpers (client mirror of the server contract —
   the SERVER performs all authoritative boundary filtering; these are
   only used to split the already server-filtered daily page.)
------------------------------------------------------------------- */

/** Calendar Y-M-D in Asia/Dhaka for an instant (en-CA = YYYY-MM-DD). */
export function dhakaYmdOf(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

/** Asia/Dhaka is fixed UTC+6 (no DST) — safe to compute from the YMD string. */
export function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 0, 0, 0, 0) - 6 * 60 * 60 * 1000);
  return dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

export function getDhakaTodayYmd(now: Date = new Date()): string {
  return dhakaYmdOf(now);
}

/** Parse an instant to epoch ms; NaN for null/undefined/invalid (sorts last). */
export function parseTimeMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

/** True when an instant falls on the given Asia/Dhaka calendar date. */
export function isDhakaDate(value: string | null | undefined, ymd: string): boolean {
  if (!value) return false;
  try {
    return dhakaYmdOf(value) === ymd;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   Queue composition
------------------------------------------------------------------- */

/**
 * Compose the workbench from already-loaded authoritative data.
 *
 * De-duplication rule (IMPORTANT): an exact shared identifier is the only
 * evidence that two rows are the same logical item. Follow-up queue row IDs
 * identify LEADS (queue row `id` = lead id/code); scheduled activity IDs
 * identify independent planned activities. The two loaded contracts supply
 * NO item-level cross-link, so matching by lead, name or timestamp would be
 * a heuristic and is deliberately NOT done. Keys are namespaced by source
 * (`follow-up:<id>` vs `scheduled:<id>`) and a Map collapses only EXACT
 * duplicate keys within the same source.
 *
 * Tomorrow items never enter today's execution queue — the follow-up queue's
 * server dueState ('overdue' | 'today') is authoritative, and scheduled rows
 * are split by Asia/Dhaka calendar date.
 */
export function composeWorkbenchItems(
  followUps: FollowUpQueueItem[],
  scheduled: ScheduledActivity[],
  todayYmd: string,
  tomorrowYmd: string
): { queue: WorkbenchItem[]; tomorrowFollowUps: FollowUpQueueItem[]; tomorrowScheduled: ScheduledActivity[] } {
  const byExactKey = new Map<string, WorkbenchItem>();

  const timeOf = (value: string | null | undefined): number => parseTimeMs(value);

  for (const item of followUps) {
    const dueMs = timeOf(item.nextFollowUpAt);
    // dueState is computed by the server (Asia/Dhaka bounds) — reuse it.
    let dueState: WorkbenchDueState;
    if (item.dueState === 'overdue') dueState = 'overdue';
    else if (item.dueState === 'today') dueState = 'today';
    else continue; // upcoming rows are not today's execution work
    if (!Number.isFinite(dueMs)) dueState = 'invalid-time';
    byExactKey.set(`follow-up:${item.id}`, {
      key: `follow-up:${item.id}`,
      source: 'follow_up_queue',
      activityType: 'follow_up',
      leadId: item.id,
      name: item.prospectName || item.customerName || 'Follow-up',
      title: null,
      scheduledAt: Number.isFinite(dueMs) ? item.nextFollowUpAt : null,
      leadStatus: item.currentStatus,
      dueState,
      overdueDays: item.overdueDays,
      assignee: item.assignedEmployeeName || item.assignedTo || null,
      mobile: item.mobile || null,
      raw: item,
    });
  }

  for (const sa of scheduled) {
    const at = sa.scheduledAt || (sa as any).scheduled_at || '';
    const atMs = timeOf(at);
    // Only pending work belongs in an execution queue; completed/cancelled
    // rows are terminal history maintained by the server.
    if (String(sa.status || '').toLowerCase() !== 'scheduled') continue;
    const dhakaDate = isDhakaDate(at, todayYmd) ? todayYmd : isDhakaDate(at, tomorrowYmd) ? tomorrowYmd : null;
    if (!dhakaDate) continue; // outside the loaded daily page
    if (dhakaDate === tomorrowYmd) continue; // tomorrow preview handles these separately
    const type = (sa.activityType || (sa as any).activity_type || 'task') as WorkbenchActivityType;
    byExactKey.set(`scheduled:${sa.id}`, {
      key: `scheduled:${sa.id}`,
      source: 'scheduled_activity',
      activityType: type,
      leadId: sa.leadId || (sa as any).lead_id,
      name: (sa as any).leadCustomerName || sa.title || 'Scheduled activity',
      title: sa.title || null,
      scheduledAt: Number.isFinite(atMs) ? at : null,
      leadStatus: (sa as any).leadStatus || null,
      dueState: Number.isFinite(atMs) ? 'today' : 'invalid-time',
      overdueDays: undefined,
      assignee: null,
      mobile: (sa as any).leadMobile || null,
      raw: sa,
    });
  }

  const tomorrowScheduled = scheduled.filter((sa) => {
    if (String(sa.status || '').toLowerCase() !== 'scheduled') return false;
    return isDhakaDate(sa.scheduledAt || (sa as any).scheduled_at, tomorrowYmd);
  });
  const tomorrowFollowUps = followUps.filter((item) => {
    if (item.dueState !== 'upcoming') return false;
    return isDhakaDate(item.nextFollowUpAt, tomorrowYmd);
  });

  return {
    queue: sortWorkbenchQueue([...byExactKey.values()]),
    tomorrowFollowUps,
    tomorrowScheduled,
  };
}

const DUE_STATE_RANK: Record<WorkbenchDueState, number> = {
  overdue: 0,
  today: 1,
  'invalid-time': 2,
};

/**
 * Sort order:
 *   1. overdue first (most overdue — smallest timestamp — at the top)
 *   2. then today's items by scheduled/due time ascending
 *   3. unscheduled / invalid-time items last
 * Sorting is stable; items without a parseable time keep arrival order.
 */
export function sortWorkbenchQueue(items: WorkbenchItem[]): WorkbenchItem[] {
  return [...items].sort((a, b) => {
    const rankDiff = DUE_STATE_RANK[a.dueState] - DUE_STATE_RANK[b.dueState];
    if (rankDiff !== 0) return rankDiff;
    const ta = parseTimeMs(a.scheduledAt);
    const tb = parseTimeMs(b.scheduledAt);
    const aBad = Number.isNaN(ta);
    const bBad = Number.isNaN(tb);
    if (aBad && bBad) return 0;
    if (aBad) return 1;
    if (bBad) return -1;
    return ta - tb;
  });
}

/** Tomorrow preview: counts only — the Task Calendar remains the planning view. */
export function buildTomorrowPreview(followUps: FollowUpQueueItem[], scheduled: ScheduledActivity[]): WorkbenchTomorrowPreview {
  return {
    calls: scheduled.filter((s) => (s.activityType || (s as any).activity_type) === 'call').length,
    meetings: scheduled.filter((s) => (s.activityType || (s as any).activity_type) === 'meeting').length,
    followUps: followUps.length + scheduled.filter((s) => (s.activityType || (s as any).activity_type) === 'follow_up').length,
    tasks: scheduled.filter((s) => (s.activityType || (s as any).activity_type) === 'task').length,
  };
}

/* ------------------------------------------------------------------
   Quick filters — client-side over the ALREADY loaded daily work set.
   No per-tab refetch.
------------------------------------------------------------------- */

export function filterWorkbenchItems(items: WorkbenchItem[], filter: WorkbenchFilter): WorkbenchItem[] {
  if (filter === 'all') return items;
  if (filter === 'overdue') return items.filter((i) => i.dueState === 'overdue');
  return items.filter((i) => i.activityType === filter);
}

export function getWorkbenchFilterCounts(items: WorkbenchItem[]): Record<WorkbenchFilter, number> {
  return {
    all: items.length,
    overdue: items.filter((i) => i.dueState === 'overdue').length,
    call: items.filter((i) => i.activityType === 'call').length,
    meeting: items.filter((i) => i.activityType === 'meeting').length,
    follow_up: items.filter((i) => i.activityType === 'follow_up').length,
    task: items.filter((i) => i.activityType === 'task').length,
  };
}

/* ------------------------------------------------------------------
   Efficient post-mutation state updates — pure functions applied to
   the already-loaded WorkbenchData after the SERVER confirms a
   mutation. No full refetch, no re-fetch-per-row, no notification
   fanout (the page adds none of its own).
------------------------------------------------------------------- */

/**
 * After scheduledActivityService.complete(id) resolves: drop the item from
 * the queue and, ONLY when the server-stamped completed_at falls on today's
 * Dhaka date, increment the authoritative completed-today count.
 */
export function applyCompletedMutation(data: WorkbenchData, key: string, completedAt: string | null | undefined): WorkbenchData {
  let completedToday = data.completedToday;
  if (completedAt) {
    try {
      if (dhakaYmdOf(completedAt) === data.todayYmd) {
        completedToday = (data.completedToday ?? 0) + 1;
      }
    } catch {
      /* unparseable timestamp must not corrupt the count */
    }
  }
  return {
    ...data,
    completedToday,
    queue: data.queue.filter((i) => i.key !== key),
  };
}

/** After scheduledActivityService.cancel(id) resolves: drop the item from the queue. */
export function applyCancelledMutation(data: WorkbenchData, key: string): WorkbenchData {
  return { ...data, queue: data.queue.filter((i) => i.key !== key) };
}

/**
 * After scheduledActivityService.update(id, { scheduledAt }) resolves:
 * re-sort in place when the new time stays on today (Dhaka); drop the item
 * from today's queue when it moved to another day.
 */
export function applyRescheduleMutation(data: WorkbenchData, key: string, nextAt: string): WorkbenchData {
  if (dhakaYmdOf(nextAt) !== data.todayYmd) {
    return { ...data, queue: data.queue.filter((i) => i.key !== key) };
  }
  return {
    ...data,
    queue: sortWorkbenchQueue(data.queue.map((i) => (i.key === key ? { ...i, scheduledAt: nextAt } : i))),
  };
}

/* ------------------------------------------------------------------
   Load orchestration — exactly THREE bounded parallel requests.
   Per-source error capture so a partial failure never silently
   renders as zero (the page shows an explicit partial-state banner).
------------------------------------------------------------------- */

const WORKBENCH_QUEUE_LIMIT = 200; // server maximum for one bounded page

export async function loadWorkbench(now: Date = new Date()): Promise<WorkbenchData> {
  const todayYmd = getDhakaTodayYmd(now);
  const tomorrowYmd = addDaysToYmd(todayYmd, 1);

  const errors = { followUps: false, scheduled: false, completedToday: false };
  const [queueRes, scheduledRes, completedRes] = await Promise.allSettled([
    leadService.getFollowUpQueue({ bucket: 'all', limit: WORKBENCH_QUEUE_LIMIT }),
    scheduledActivityService.list({ from: todayYmd, to: tomorrowYmd, limit: WORKBENCH_QUEUE_LIMIT }),
    scheduledActivityService.completedToday(),
  ]);

  if (queueRes.status === 'rejected') errors.followUps = true;
  if (scheduledRes.status === 'rejected') errors.scheduled = true;
  if (completedRes.status === 'rejected') errors.completedToday = true;

  const followUpItems = queueRes.status === 'fulfilled' ? queueRes.value.items ?? [] : [];
  const scheduledItems = scheduledRes.status === 'fulfilled' ? scheduledRes.value ?? [] : [];
  const followUpCounts =
    queueRes.status === 'fulfilled'
      ? queueRes.value.counts ?? { overdue: 0, today: 0, upcoming: 0, all: 0 }
      : { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const bounds = queueRes.status === 'fulfilled' ? queueRes.value.bounds ?? null : null;
  const todayDate = queueRes.status === 'fulfilled' ? queueRes.value.todayDate ?? null : null;

  const { queue, tomorrowFollowUps, tomorrowScheduled } = composeWorkbenchItems(followUpItems, scheduledItems, todayYmd, tomorrowYmd);

  return {
    todayYmd,
    tomorrowYmd,
    queue,
    tomorrow: buildTomorrowPreview(tomorrowFollowUps, tomorrowScheduled),
    followUpCounts,
    bounds,
    todayDate,
    completedToday: completedRes.status === 'fulfilled' ? completedRes.value.count : null,
    errors,
  };
}

/** Source label for the badge column. */
export const WORKBENCH_SOURCE_LABEL: Record<WorkbenchActivityType, string> = {
  call: 'Call',
  meeting: 'Meeting',
  follow_up: 'Follow-up',
  task: 'Task',
};
