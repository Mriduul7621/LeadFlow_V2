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

/* ====================================================================
   Holiday JSON import (PR F)
   ------------------------------------------------------------------
   Settings → Calendar accepts a JSON file of holidays so a future
   year's government list can be loaded by an admin with NO code
   help. Two row shapes are accepted and normalised to one:

   CANONICAL (the shape of bangladesh-govt-holidays-*.json and of
   the sample download the Settings page offers):
     { date: "YYYY-MM-DD", name_en, name_bn?, type: "general" |
       "executive" | "executive_order", moon_dependent?: bool,
       scope?: "national" | "<region text>" }
     - type maps to the DB category ("executive*" -> executive).
     - No scope / "national" = nationwide; any other scope text
       marks the row regional and becomes the note — the hill-
       districts scope resolves to migration 056's exact note
       ('Hill districts only: Rangamati, Khagrachhari & Bandarban').

   DB SHAPE (a row as GET /calendar/config serves it / the table
   stores it), so an exported list re-imports unchanged:
     { date, name, name_bn? | nameBn?, category: "general" |
       "executive", moonDependent?: bool, regional?: bool, note? }

   The (date, name) pair stays the identity — duplicates (against
   the database or within the file) are skipped by the route via
   ON CONFLICT DO NOTHING, never duplicated.
==================================================================== */

export const MAX_HOLIDAY_IMPORT_ROWS = 500;

/** Migration 056's note for the hill-districts (Chaitra Sankranti) rows. */
export const REGIONAL_HILL_DISTRICTS_NOTE =
  'Hill districts only: Rangamati, Khagrachhari & Bandarban';

export interface ImportHolidayRow {
  date: string; // YYYY-MM-DD
  name: string;
  nameBn: string | null;
  category: HolidayCategory;
  moonDependent: boolean;
  regional: boolean;
  note: string | null;
}

function importBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

/**
 * Validate + normalise ONE import row (either accepted shape).
 * Returns the row, or a human-readable rejection reason.
 */
export function normalizeImportHolidayRow(
  raw: unknown
): { row: ImportHolidayRow } | { reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reason: 'Row is not an object.' };
  }
  const r = raw as Record<string, any>;

  const dateRaw = typeof r.date === 'string' ? r.date.trim() : r.date;
  const date = typeof r.holiday_date === 'string' && dateRaw == null
    ? r.holiday_date.trim()
    : dateRaw;
  if (!isValidHolidayDate(date)) {
    return { reason: 'Missing or invalid date (expected a real date as YYYY-MM-DD).' };
  }

  const nameRaw = r.name_en ?? r.name;
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) return { reason: 'Missing holiday name (name_en).' };
  if (name.length > 255) return { reason: 'Holiday name is too long (max 255 characters).' };

  const nameBnRaw = r.name_bn ?? r.nameBn;
  const nameBn = typeof nameBnRaw === 'string' ? nameBnRaw.trim() : '';
  if (nameBn.length > 255) return { reason: 'Bangla name is too long (max 255 characters).' };

  // Category: canonical `type` wins; DB-shape `category` otherwise.
  // An absent value defaults to 'general' (same default as the
  // single-holiday form); a present-but-unknown value is rejected.
  let category: HolidayCategory = 'general';
  const typeRaw = r.type ?? r.category;
  if (typeRaw != null && String(typeRaw).trim() !== '') {
    const t = String(typeRaw).trim().toLowerCase().replace(/_/g, ' ');
    if (t === 'general') category = 'general';
    else if (t === 'executive' || t === 'executive order') category = 'executive';
    else return { reason: `Unknown type/category "${String(typeRaw)}" (expected "general" or "executive").` };
  }

  const moonDependent = importBool(r.moon_dependent ?? r.moonDependent);

  // Regional + note. A canonical `scope` string wins when present;
  // otherwise the DB-shape regional flag + note ride through.
  let regional = importBool(r.regional);
  let note: string | null = null;
  if (typeof r.note === 'string' && r.note.trim()) note = r.note.trim();
  if (typeof r.scope === 'string' && r.scope.trim()) {
    const scope = r.scope.trim();
    if (scope.toLowerCase() === 'national') {
      regional = false;
    } else {
      regional = true;
      note = /hill|rangamati|khagrachhari|bandarban/i.test(scope)
        ? REGIONAL_HILL_DISTRICTS_NOTE
        : scope;
    }
  } else if (typeof r.scope === 'string') {
    regional = false; // scope present but blank -> nationwide
  }

  return {
    row: {
      date: date as string,
      name,
      nameBn: nameBn ? nameBn : null,
      category,
      moonDependent,
      regional,
      note,
    },
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
