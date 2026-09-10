/**
 * Bangladesh business-date boundaries (Asia/Dhaka, UTC+6).
 * Server-authoritative — never use the browser timezone.
 * Historical timestamps are compared as-is; we do not rewrite stored dates.
 */

export const BUSINESS_TIMEZONE = 'Asia/Dhaka';
export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export type FollowUpBucket = 'overdue' | 'today' | 'upcoming' | 'all';

export const TERMINAL_LEAD_STATUSES = ['Converted', 'Not Interested'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Calendar Y-M-D in Asia/Dhaka for an instant. */
export function dhakaYmd(instant: Date = new Date()): { y: number; m: number; d: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value);
  const d = Number(parts.find(p => p.type === 'day')?.value);
  return { y, m, d, dateStr: `${y}-${pad2(m)}-${pad2(d)}` };
}

/**
 * Instant (UTC) of 00:00:00 Asia/Dhaka on the given Dhaka calendar date.
 * Dhaka is UTC+6 year-round (no DST).
 */
export function dhakaStartUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - DHAKA_OFFSET_MS);
}

export function addCalendarDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const utc = Date.UTC(y, m - 1, d + days);
  const dt = new Date(utc);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export interface BusinessDayBounds {
  timezone: string;
  todayDate: string;
  todayStart: Date;
  tomorrowStart: Date;
  todayStartIso: string;
  tomorrowStartIso: string;
}

export function getDhakaBusinessDayBounds(now: Date = new Date()): BusinessDayBounds {
  const { y, m, d, dateStr } = dhakaYmd(now);
  const todayStart = dhakaStartUtc(y, m, d);
  const next = addCalendarDays(y, m, d, 1);
  const tomorrowStart = dhakaStartUtc(next.y, next.m, next.d);
  return {
    timezone: BUSINESS_TIMEZONE,
    todayDate: dateStr,
    todayStart,
    tomorrowStart,
    todayStartIso: todayStart.toISOString(),
    tomorrowStartIso: tomorrowStart.toISOString(),
  };
}

export function classifyFollowUpBucket(nextFollowUpAt: Date | string | null | undefined, bounds: BusinessDayBounds): FollowUpBucket | null {
  if (!nextFollowUpAt) return null;
  const t = nextFollowUpAt instanceof Date ? nextFollowUpAt.getTime() : new Date(nextFollowUpAt).getTime();
  if (!Number.isFinite(t)) return null;
  if (t < bounds.todayStart.getTime()) return 'overdue';
  if (t < bounds.tomorrowStart.getTime()) return 'today';
  return 'upcoming';
}

/** Whole overdue days vs start of today in Dhaka (0 if not overdue). */
export function overdueDays(nextFollowUpAt: Date | string | null | undefined, bounds: BusinessDayBounds): number {
  if (!nextFollowUpAt) return 0;
  const t = nextFollowUpAt instanceof Date ? nextFollowUpAt.getTime() : new Date(nextFollowUpAt).getTime();
  if (!Number.isFinite(t) || t >= bounds.todayStart.getTime()) return 0;
  return Math.floor((bounds.todayStart.getTime() - t) / 86400000);
}

export function parseYmd(value: string | undefined | null): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
