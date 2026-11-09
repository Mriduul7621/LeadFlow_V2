/**
 * calendarLayout.ts
 * ------------------------------------------------------------------
 * Pure layout / mapping helpers for the Microsoft-style Task
 * Calendar rebuild (calendar upgrade PR D). Everything here is
 * side-effect free and unit-tested (server/tests/calendar-ui-
 * rebuild.test.ts) so the page component stays a thin shell over:
 *
 *   - category mapping   — a scheduled activity (or a roadshow)
 *                          becomes one of the six "My calendars"
 *                          colour categories;
 *   - work-week maths    — the Work week view shows every weekday
 *                          that is NOT in the configured weekend
 *                          (Calendar Settings, PR C; BD default
 *                          Fri+Sat weekend → Sun–Thu columns);
 *   - time-grid layout   — overlapping events in a day column are
 *                          assigned side-by-side columns (classic
 *                          interval partitioning, no library);
 *   - slot → prefill     — clicking an empty time-grid slot turns
 *                          into the create form's date/start/end;
 *   - form-kind rules    — which create-form kinds need a lead and
 *                          which API activityType they map to
 *                          (PR B: follow_up / call require a lead,
 *                          a team meeting is a lead-less meeting).
 *
 * Weekday numbers follow JS: Sunday = 0 … Saturday = 6. Weeks in
 * LeadFlow start on Sunday (see the pre-rebuild calendar).
 */

export type CalendarCategory =
  | 'followup'
  | 'call'
  | 'customer_meeting'
  | 'team_meeting'
  | 'task'
  | 'roadshow';

export const CALENDAR_CATEGORIES: CalendarCategory[] = [
  'followup',
  'call',
  'customer_meeting',
  'team_meeting',
  'task',
  'roadshow',
];

export const CATEGORY_LABELS: Record<CalendarCategory, string> = {
  followup: 'Follow-ups',
  call: 'Calls',
  customer_meeting: 'Customer meetings',
  team_meeting: 'Team meetings',
  task: 'Tasks',
  roadshow: 'Roadshows',
};

/** Minimal shape of a scheduled activity the mapping needs. */
export interface SchedulableLike {
  activityType?: string | null;
  activity_type?: string | null;
  leadId?: string | null;
  lead_id?: string | null;
}

/**
 * Map a scheduled activity to its calendar category. A meeting WITH
 * a lead is a customer meeting; a meeting WITHOUT one (migration
 * 055 lead-less events) is a team meeting.
 */
export function categoryOfScheduled(sa: SchedulableLike): CalendarCategory {
  const type = String(sa.activityType ?? sa.activity_type ?? '').toLowerCase();
  const leadId = sa.leadId ?? sa.lead_id ?? null;
  switch (type) {
    case 'call':
      return 'call';
    case 'meeting':
      return leadId ? 'customer_meeting' : 'team_meeting';
    case 'task':
      return 'task';
    case 'follow_up':
    default:
      return 'followup';
  }
}

/**
 * PR A managed entries: rows whose source_activity_id is set are
 * owned by the lead follow-up next-step sync — the calendar must
 * not offer time editing for them (the follow-up owns the time).
 */
export function isManagedEntry(sa: {
  sourceActivityId?: string | null;
  source_activity_id?: string | null;
}): boolean {
  return Boolean(sa.sourceActivityId ?? sa.source_activity_id);
}

/* ------------------------------------------------------------------ */
/* Work-week maths                                                     */
/* ------------------------------------------------------------------ */

/** Sanitize an arbitrary weekend config into unique weekday ints 0–6. */
export function sanitizeWeekendDays(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<number>();
  for (const v of input) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Working weekdays = every weekday NOT in the configured weekend,
 * in Sunday-first order. Default BD weekend [5, 6] → [0, 1, 2, 3, 4]
 * (Sun–Thu). An all-week weekend yields [] (the view then falls back
 * to the full week — see visibleWeekDates).
 */
export function deriveWorkWeekDays(weekendDays: unknown): number[] {
  const weekend = new Set(sanitizeWeekendDays(weekendDays));
  const days: number[] = [];
  for (let d = 0; d <= 6; d++) if (!weekend.has(d)) days.push(d);
  return days;
}

/** The 7 dates (Sunday-first) of the week containing `anchor`. */
export function weekDatesContaining(anchor: Date): Date[] {
  const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  sunday.setDate(sunday.getDate() - sunday.getDay());
  const out: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    out.push(d);
  }
  return out;
}

/**
 * Dates to render for the Week / Work week views. `workWeek` keeps
 * only the derived working days; if the config marks every day as
 * weekend (degenerate), it falls back to the full 7-day week so the
 * grid never renders zero columns.
 */
export function visibleWeekDates(anchor: Date, weekendDays: unknown, workWeek: boolean): Date[] {
  const all = weekDatesContaining(anchor);
  if (!workWeek) return all;
  const working = new Set(deriveWorkWeekDays(weekendDays));
  const filtered = all.filter(d => working.has(d.getDay()));
  return filtered.length > 0 ? filtered : all;
}

/* ------------------------------------------------------------------ */
/* Time-grid maths                                                     */
/* ------------------------------------------------------------------ */

export const DEFAULT_EVENT_DURATION_MIN = 30;

/** Minutes since local midnight for a Date. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * The [startMin, endMin) span an event occupies in a day column.
 * Missing/invalid durations fall back to 30 minutes; the span is
 * clamped to the day (endMin ≤ 1440) and never zero-length.
 */
export function eventSpan(start: Date, durationMinutes?: number | null): { startMin: number; endMin: number } {
  const startMin = minutesOfDay(start);
  const raw = Number(durationMinutes);
  const dur = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_EVENT_DURATION_MIN;
  const endMin = Math.min(1440, startMin + dur);
  return { startMin, endMin: Math.max(endMin, Math.min(1440, startMin + 15)) };
}

export interface LaidOutEvent {
  column: number;
  columns: number;
}

/**
 * Assign side-by-side columns to overlapping events within one day.
 * Events are grouped into clusters of transitively-overlapping
 * spans; inside a cluster each event takes the first column whose
 * last event has ended (touching endpoints do NOT overlap), and
 * every event in the cluster reports the cluster's column count so
 * widths are uniform per cluster.
 */
export function layoutDayEvents<T extends { id: string; startMin: number; endMin: number }>(
  events: T[],
): Map<string, LaidOutEvent> {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id));
  const out = new Map<string, LaidOutEvent>();

  let cluster: T[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (cluster.length === 0) return;
    const colEnds: number[] = [];
    const assigned = new Map<string, number>();
    for (const ev of cluster) {
      let col = colEnds.findIndex(end => end <= ev.startMin);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(ev.endMin);
      } else {
        colEnds[col] = ev.endMin;
      }
      assigned.set(ev.id, col);
    }
    const columns = Math.max(1, colEnds.length);
    for (const ev of cluster) out.set(ev.id, { column: assigned.get(ev.id) ?? 0, columns });
    cluster = [];
    clusterEnd = -1;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* Fetch-range widening                                                */
/* ------------------------------------------------------------------ */

/**
 * Widen a visible YYYY-MM-DD range by `days` on both ends FOR
 * FETCHING ONLY. The component derives the range in Asia/Dhaka
 * dates, while the server filters the stored UTC-wall timestamps
 * by those literal days — an event at 00:00–05:59 Dhaka on the
 * first visible day is stored on the PREVIOUS UTC day and would
 * fall outside the server's window. Over-fetched rows are harmless:
 * every surface places events by their local (Dhaka) day, so rows
 * outside the visible range simply never render. Pure string-date
 * maths via Date.UTC — identical in every timezone.
 */
export function widenRangeYmd(range: { from: string; to: string }, days = 1): { from: string; to: string } {
  const shift = (ymd: string, delta: number): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return ymd;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta);
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  const n = Math.max(0, Math.floor(days));
  return { from: shift(range.from, -n), to: shift(range.to, n) };
}

/* ------------------------------------------------------------------ */
/* Slot → create-form prefill                                          */
/* ------------------------------------------------------------------ */

export interface SlotPrefill {
  date: string; // YYYY-MM-DD (local)
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function toTimeStr(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(totalMinutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/**
 * Turn a clicked time-grid slot into create-form values: the date,
 * the slot start, and start + duration (clamped to 23:59 at the
 * day's edge).
 */
export function slotPrefill(date: Date, hour: number, minute = 0, durationMin = DEFAULT_EVENT_DURATION_MIN): SlotPrefill {
  const start = Math.max(0, Math.min(1439, Math.floor(hour) * 60 + Math.floor(minute)));
  return {
    date: toDateStr(date),
    startTime: toTimeStr(start),
    endTime: toTimeStr(start + Math.max(1, Math.floor(durationMin))),
  };
}

/* ------------------------------------------------------------------ */
/* Create-form kinds (PR B rules)                                      */
/* ------------------------------------------------------------------ */

export type EventFormKind = 'follow_up' | 'call' | 'customer_meeting' | 'team_meeting' | 'task';

export const FORM_KIND_LABELS: Record<EventFormKind, string> = {
  follow_up: 'Follow-up',
  call: 'Call',
  customer_meeting: 'Customer meeting',
  team_meeting: 'Team meeting',
  task: 'Task',
};

/** Which API activityType a form kind submits as. */
export function apiTypeForKind(kind: EventFormKind): 'follow_up' | 'call' | 'meeting' | 'task' {
  if (kind === 'customer_meeting' || kind === 'team_meeting') return 'meeting';
  return kind;
}

/**
 * PR B server rules, mirrored client-side: follow-ups and calls are
 * lead work and REQUIRE a lead; a customer meeting needs its lead;
 * a team meeting is lead-less by definition; a task may stand alone.
 */
export function kindRequiresLead(kind: EventFormKind): boolean {
  return kind === 'follow_up' || kind === 'call' || kind === 'customer_meeting';
}

/** The form kind an existing event opens with in the edit form. */
export function kindForCategory(category: CalendarCategory): EventFormKind {
  switch (category) {
    case 'call':
      return 'call';
    case 'customer_meeting':
      return 'customer_meeting';
    case 'team_meeting':
      return 'team_meeting';
    case 'task':
      return 'task';
    case 'followup':
    default:
      return 'follow_up';
  }
}

/** Reminder choices offered by the form (minutes before start). */
export const REMINDER_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'No reminder' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
];
