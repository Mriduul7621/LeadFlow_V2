/**
 * CalendarConfigService — workspace calendar configuration
 * (calendar upgrade PR C).
 * ------------------------------------------------------------------
 * Two pieces of configuration, both seeded by migration 056:
 *
 *   WEEKEND — Metadata Engine options, group 'Calendar', row
 *   'weekendDays', meta.days = JS weekday numbers (Sun=0 … Sat=6).
 *   Default [5, 6] (Friday + Saturday, the Bangladesh weekend).
 *   Stored exactly like the LeadSla / LeadAutoAssignment config
 *   (049/051) and seeded only when absent, so an admin's change in
 *   Settings → Calendar survives restarts and redeploys. Reads fail
 *   back to the default whenever the row is missing or malformed.
 *
 *   HOLIDAYS — the `calendar_holidays` table (one row per holiday
 *   day; UNIQUE (holiday_date, name)). Admin CRUD lives in
 *   calendar.routes.ts behind settings.manage; this module owns the
 *   shared validation + row mapping so the routes stay thin.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb } from '../routes/production/shared.js';

export const CALENDAR_OPTION_TYPE = 'Calendar';
export const WEEKEND_OPTION_VALUE = 'weekendDays';
export const DEFAULT_WEEKEND_DAYS: number[] = [5, 6];

export type HolidayCategory = 'general' | 'executive';

export interface CalendarHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  nameBn: string | null;
  category: HolidayCategory;
  moonDependent: boolean;
  regional: boolean;
  note: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/* ====================================================================
   Weekend days
==================================================================== */

/**
 * Strict validation for the PUT /calendar/weekend payload: an array
 * of UNIQUE integers in 0..6. Length 0..7 is legal (an empty weekend
 * is a legitimate configuration). Returns the sorted days, or null
 * when the payload is invalid.
 */
export function parseWeekendDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 7) return null;
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item)) return null;
    if (item < 0 || item > 6) return null;
    if (seen.has(item)) return null;
    seen.add(item);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Lenient normalisation for a STORED meta.days value. */
export function normalizeWeekendDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_WEEKEND_DAYS];
  const days = new Set<number>();
  for (const item of value) {
    const n = typeof item === 'string' ? Number(item) : item;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6) days.add(n);
  }
  return [...days].sort((a, b) => a - b);
}

function weekendFromOptionRow(row: any): number[] {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return normalizeWeekendDays((meta as any).days);
}

/** The configured weekend days (default [5, 6] whenever unset/bad). */
export async function getCalendarWeekendDays(): Promise<number[]> {
  if (!useDb()) {
    const rows = (fallbackStore.options as any[]).filter(
      (o: any) => o.type === CALENDAR_OPTION_TYPE
    );
    const row = rows.find((o: any) => o.value === WEEKEND_OPTION_VALUE);
    return row ? weekendFromOptionRow({ meta: row.meta }) : [...DEFAULT_WEEKEND_DAYS];
  }
  try {
    const result = await getPool().query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2`,
      [CALENDAR_OPTION_TYPE, WEEKEND_OPTION_VALUE]
    );
    if (result.rows.length === 0) return [...DEFAULT_WEEKEND_DAYS];
    return weekendFromOptionRow(result.rows[0]);
  } catch {
    return [...DEFAULT_WEEKEND_DAYS];
  }
}

/**
 * Persist the weekend days. UPDATE the seeded options row; when the
 * row is absent (legacy-adopted database), create the registry row +
 * option, following the insert shape of migrations 049/051.
 */
export async function setCalendarWeekendDays(days: number[]): Promise<number[]> {
  const normalized = parseWeekendDays(days);
  if (!normalized) throw new Error('Invalid weekend days');
  if (!useDb()) {
    const store = fallbackStore as any;
    if (!Array.isArray(store.options)) store.options = [];
    const existing = store.options.find(
      (o: any) => o.type === CALENDAR_OPTION_TYPE && o.value === WEEKEND_OPTION_VALUE
    );
    if (existing) existing.meta = { ...(existing.meta || {}), days: normalized };
    else store.options.push({
      id: 'calendar-weekend-days',
      type: CALENDAR_OPTION_TYPE,
      value: WEEKEND_OPTION_VALUE,
      label: 'Weekend days',
      status: 'Active',
      sortOrder: 1,
      meta: { days: normalized },
    });
    return normalized;
  }
  const pool = getPool();
  const meta = JSON.stringify({ days: normalized });
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, CALENDAR_OPTION_TYPE, WEEKEND_OPTION_VALUE]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'Calendar', 'Calendar Settings',
              'Workspace calendar configuration: weekend days and government holidays.',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'Calendar')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('Calendar', 'weekendDays', 'Weekend days', 1, FALSE, TRUE, $1::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [meta]
    );
  }
  return normalized;
}

/* ====================================================================
   Holidays
==================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD + real-calendar-date validation. */
export function isValidHolidayDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Accept 'general' | 'executive' (and the gazette spellings). */
export function normalizeHolidayCategory(value: unknown): HolidayCategory | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'general') return 'general';
  if (v === 'executive' || v === 'executive order') return 'executive';
  return null;
}

/** node-pg returns DATE as a Date at local midnight; pglite as string. */
export function formatHolidayDate(value: any): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value || '').slice(0, 10);
}

export function mapHolidayRow(row: any): CalendarHoliday {
  return {
    id: String(row.id),
    date: formatHolidayDate(row.holiday_date),
    name: row.name,
    nameBn: row.name_bn ?? null,
    category: row.category === 'executive' ? 'executive' : 'general',
    moonDependent: row.moon_dependent === true,
    regional: row.regional === true,
    note: row.note ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

/** Holidays in [from, to] (either bound optional), date-ordered. */
export async function listCalendarHolidays(
  from?: string,
  to?: string
): Promise<CalendarHoliday[]> {
  if (!useDb()) {
    const rows = ((fallbackStore as any).calendarHolidays as any[]) || [];
    return rows
      .filter(h => (!from || h.date >= from) && (!to || h.date <= to))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)))
      .map(h => ({
        id: String(h.id),
        date: h.date,
        name: h.name,
        nameBn: h.nameBn ?? null,
        category: h.category === 'executive' ? 'executive' : 'general',
        moonDependent: h.moonDependent === true,
        regional: h.regional === true,
        note: h.note ?? null,
      }));
  }
  const pool = getPool();
  const params: any[] = [];
  let sql = `SELECT * FROM calendar_holidays`;
  const where: string[] = [];
  if (from) { params.push(from); where.push(`holiday_date >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`holiday_date <= $${params.length}::date`); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY holiday_date ASC, name ASC`;
  const result = await pool.query(sql, params);
  return result.rows.map(mapHolidayRow);
}
