import type { FollowUpQueueItem } from '../../leads/services/leadService';
import type { DropdownOption } from '../../shared/types';

/**
 * enterpriseData.ts — pure data shaping for the enterprise role
 * homes (Enterprise Preview redesign, 2026-11-19).
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

/** One decimal percent, e.g. 18.6%. */
export function formatPercent(value: number): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return '0%';
  return `${v.toFixed(1)}%`;
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

/** '10:30 am' style Dhaka time for an instant. */
export function formatDhakaTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/**
 * A follow-up's due label in Dhaka terms: "Overdue · 2 days",
 * "Today · 10:30 am", "Tomorrow", or "12 Nov". The overdue day
 * count is whole Dhaka days past the due day.
 */
export function dueLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const startMs = dhakaDayStartMs(now);
  const offset = Math.floor((t - startMs) / 86_400_000);
  if (offset < 0) {
    const days = -offset;
    return `Overdue · ${days} day${days === 1 ? '' : 's'}`;
  }
  if (offset === 0) {
    const time = formatDhakaTime(iso);
    return time ? `Today · ${time}` : 'Today';
  }
  if (offset === 1) return 'Tomorrow';
  return formatDhakaShort(iso);
}

/**
 * Terminal status names from the FollowUpStatus dictionary (DZ-6):
 * an explicit `meta.isTerminal` is honoured; only a missing key
 * falls back to the canonical names (Converted / Not Interested).
 * Names are never the authority — they are only the fallback the
 * server itself uses.
 */
export function resolveTerminalNames(statusOptions: DropdownOption[] = []): Set<string> {
  const names = new Set<string>();
  for (const option of statusOptions) {
    const meta = option?.meta ?? {};
    const name = option.label || option.value;
    if (!name) continue;
    const terminal =
      typeof meta.isTerminal === 'boolean'
        ? meta.isTerminal
        : name === 'Converted' || name === 'Not Interested';
    if (terminal) names.add(name);
  }
  // A dictionary that names nothing terminal is honoured as-is — but
  // when the dictionary is EMPTY (not yet loaded), the canonical
  // names are the only safe fallback.
  if (statusOptions.length === 0) {
    names.add('Converted');
    names.add('Not Interested');
  }
  return names;
}

/**
 * The pipeline bottleneck: the open (non-terminal) status holding
 * the most leads, or null when there are no open leads. The caller
 * labels it honestly ("largest open stage").
 */
export function largestOpenStatus(
  statusCounts: Record<string, number>,
  statusOptions: DropdownOption[] = [],
): { name: string; count: number } | null {
  const terminal = resolveTerminalNames(statusOptions);
  let best: { name: string; count: number } | null = null;
  for (const [name, raw] of Object.entries(statusCounts)) {
    if (terminal.has(name)) continue;
    const count = Number(raw) || 0;
    if (count <= 0) continue;
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

/** Converted share of decided leads (0 when there are no leads at all). */
export function conversionShare(converted: number, open: number): number {
  const total = (Number(converted) || 0) + (Number(open) || 0);
  if (total <= 0) return 0;
  return (Number(converted) || 0) / total;
}
