import type { FollowUpQueueItem } from '../../leads/services/leadService';
import type { DashboardStatusCounts } from '../../dashboard/services/dashboardService';
import type { DropdownOption } from '../../shared/types';

/**
 * workspaceData.ts — pure data shaping for the role homes
 * (role-dashboard redesign, Phase 1, 2026-11-17).
 * ------------------------------------------------------------------
 * Every helper here is pure and timezone-explicit (Asia/Dhaka, UTC+6
 * year-round, no DST) so the node test suite can pin it without a
 * browser. Nothing here fetches, and nothing invents a number: each
 * helper only reshapes a server payload for display.
 */

/** Money is always ৳ (BDT) — never $. Same shape as the analytics
 * pages (`৳${n.toLocaleString()}`), with the locale pinned so the
 * grouping never depends on the viewer's device. */
export function money(n: number): string {
  return `৳${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/** The Dhaka calendar day (year/month/day) of one instant. */
export function dhakaYmdParts(instant: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const pick = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { y: pick('year'), m: pick('month'), d: pick('day') };
}

/** 'YYYY-MM-DD' of the instant's Dhaka day. */
export function dhakaDayKey(instant: Date): string {
  const { y, m, d } = dhakaYmdParts(instant);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** UTC milliseconds of the start of the instant's Dhaka day. */
export function dhakaDayStartMs(instant: Date): number {
  const { y, m, d } = dhakaYmdParts(instant);
  // Dhaka is UTC+6 with no daylight saving: midnight Dhaka is 18:00 UTC
  // the previous day.
  return Date.UTC(y, m - 1, d) - 6 * 3600 * 1000;
}

/** 'Mon 12' style label for a Dhaka day key. */
export function dhakaDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const instant = new Date(Date.UTC(y, m - 1, d) - 6 * 3600 * 1000 + 3600 * 1000);
  return instant.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
    day: 'numeric',
  });
}

export interface DayBucket {
  /** 'YYYY-MM-DD' (Dhaka). */
  dayKey: string;
  /** 'Mon 12' style label. */
  label: string;
  count: number;
  isToday: boolean;
}

/**
 * Group follow-up queue items by their Dhaka due day for today plus
 * the next six days. Always returns all seven days, even at 0
 * (never-empty rule). Items due before today or after day 6 are not
 * in any bucket — the caller keeps them in the overdue / upcoming
 * totals instead.
 */
export function buildNext7Days(items: FollowUpQueueItem[], now: Date = new Date()): DayBucket[] {
  const startMs = dhakaDayStartMs(now);
  const days: DayBucket[] = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = startMs + i * 86_400_000;
    const key = dhakaDayKey(new Date(dayStart + 3600 * 1000));
    days.push({ dayKey: key, label: dhakaDayLabel(key), count: 0, isToday: i === 0 });
  }
  for (const item of items) {
    const t = new Date(item.nextFollowUpAt).getTime();
    if (Number.isNaN(t)) continue;
    const offset = Math.floor((t - startMs) / 86_400_000);
    if (offset >= 0 && offset < 7) days[offset].count += 1;
  }
  return days;
}

/** Greeting by Dhaka hour (the caller passes the Dhaka hour). */
export function greetingForHour(dhakaHour: number): string {
  if (dhakaHour < 12) return 'Good morning';
  if (dhakaHour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** '12 Nov' style short date for a Dhaka instant. */
export function formatDhakaShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return iso;
  }
}

/**
 * Count queue items whose follow-up is more than `days` overdue —
 * i.e. due before (today minus `days`) in Dhaka. Used for the
 * manager's stalled-lead alert; the caller labels the count as a
 * floor when the queue read was truncated.
 */
export function countStalled(items: FollowUpQueueItem[], days: number, now: Date = new Date()): number {
  const cutoff = dhakaDayStartMs(now) - days * 86_400_000;
  let count = 0;
  for (const item of items) {
    const t = new Date(item.nextFollowUpAt).getTime();
    if (!Number.isNaN(t) && t < cutoff) count += 1;
  }
  return count;
}

/** Converted share of decided leads (0 when there are no leads at all). */
export function conversionShare(converted: number, open: number): number {
  const total = (Number(converted) || 0) + (Number(open) || 0);
  if (total <= 0) return 0;
  return (Number(converted) || 0) / total;
}

/**
 * Pipeline segments from the server status counts.
 * ------------------------------------------------------------------
 * Order is the funnel order of LeadFlow's REAL statuses — never the
 * sample's generic demo stages (Won/Lost/Qualified/Proposal). A
 * status the server returns that is not in the known order (a renamed
 * or added dictionary entry) still shows, after the known ones, in
 * descending count order.
 *
 * Terminal / won / lost come from the DZ-6 dictionary flags on the
 * FollowUpStatus options (meta.isTerminal / isWon / isLost), with
 * the server's own tri-state fallback: an explicit `false` is
 * honoured; only a missing key falls back to the canonical names
 * (Converted / Not Interested). Names are never the authority —
 * they are only the fallback the server itself uses.
 */
export interface PipelineSegment {
  name: string;
  count: number;
  terminal: boolean;
  won: boolean;
  lost: boolean;
}

const PIPELINE_ORDER = [
  'New',
  'Contacted',
  'Interested',
  'Follow-up Set',
  'Meeting Fixed',
  'Meeting Completed',
  'Pipeline Locked',
  'Proposal Sent',
  'Busy',
  'No Response',
  'Converted',
  'Not Interested',
];

const CANONICAL_WON = 'Converted';
const CANONICAL_LOST = 'Not Interested';

export function resolvePipelineSegments(
  statusCounts: DashboardStatusCounts | Record<string, number>,
  statusOptions: DropdownOption[] = [],
): PipelineSegment[] {
  const byValue = new Map<string, DropdownOption>();
  for (const option of statusOptions) {
    if (!byValue.has(option.value)) byValue.set(option.value, option);
    if (option.label && !byValue.has(option.label)) byValue.set(option.label, option);
  }

  const flag = (name: string): { terminal: boolean; won: boolean; lost: boolean } => {
    const option = byValue.get(name);
    const meta = option?.meta ?? {};
    const terminal =
      typeof meta.isTerminal === 'boolean'
        ? meta.isTerminal
        : name === CANONICAL_WON || name === CANONICAL_LOST;
    const won =
      typeof meta.isWon === 'boolean' ? meta.isWon : terminal && name === CANONICAL_WON;
    const lost =
      typeof meta.isLost === 'boolean' ? meta.isLost : terminal && name === CANONICAL_LOST;
    return { terminal, won, lost };
  };

  const counts = statusCounts as Record<string, number>;
  const known = PIPELINE_ORDER.map(name => ({
    name,
    count: Number(counts[name]) || 0,
    ...flag(name),
  }));
  const knownNames = new Set(PIPELINE_ORDER);
  const extra = Object.entries(counts)
    .filter(([name]) => !knownNames.has(name))
    .map(([name, count]) => ({ name, count: Number(count) || 0, ...flag(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return [...known, ...extra];
}
