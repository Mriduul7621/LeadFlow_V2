/**
 * Bangladesh business-date boundaries (Asia/Dhaka, UTC+6).
 * Server-authoritative — never use the browser timezone.
 * Historical timestamps are compared as-is; we do not rewrite stored dates.
 */

export const BUSINESS_TIMEZONE = 'Asia/Dhaka';
export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export type FollowUpBucket = 'overdue' | 'today' | 'upcoming' | 'all';

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

/**
 * Serialize a STORED timestamp value to its ISO instant.
 *
 * LeadFlow's TIMESTAMP (without time zone) columns hold UTC wall
 * time — the instant's UTC representation (see the scheduled
 * activities convention: "Business time is Asia/Dhaka; scheduled_at
 * is stored as UTC"). A naive value coming back from the database
 * (a string from PGlite / a text-returning driver) must therefore be
 * read AS UTC. `new Date(naiveString)` would parse it in the server
 * PROCESS's local timezone instead, shifting the instant by the
 * process offset (e.g. −6h when the process runs in Asia/Dhaka) —
 * correctness must never depend on the server's own timezone.
 * Values that already carry a zone, and Date objects (the real pg
 * driver has already fixed their instant), pass through unchanged.
 * Returns null for empty/unparseable input.
 */
export function storedTimestampIso(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const withZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(withZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Driver parser for TIMESTAMP (without time zone) values, OID 1114.
 *
 * The default pg / PGlite parser builds the returned Date in the
 * server PROCESS's local timezone. Because these columns store UTC
 * wall time (see storedTimestampIso), that default silently shifts
 * every timestamp whenever the process does not run in UTC — under
 * an Asia/Dhaka process each value arrives 6 hours early, and any
 * code re-serializing it (DTO mappers, the next-step calendar sync)
 * persists/displays the shifted instant. Parsing the text AS UTC at
 * the driver makes every process timezone correct; in a UTC process
 * (production) the result is identical to the default parser.
 * Registered for the real pg pool in database/connection.ts and for
 * PGlite in database/pglitePool.ts. Exotic values the UTC parse
 * cannot handle (infinity, BC dates) fall back to the default parse.
 */
export function parseTimestampAsUtc(value: string): Date {
  const text = String(value);
  const iso = text.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso) ? iso : `${iso}Z`;
  const parsed = new Date(zoned);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(text);
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
