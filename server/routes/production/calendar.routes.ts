/**
 * production/calendar.routes.ts — CALENDAR SETTINGS domain
 * (calendar upgrade PR C).
 * ------------------------------------------------------------------
 * Mahadi's requirement: the weekend (default Friday + Saturday) and
 * the Bangladesh government holidays live in Calendar Settings —
 * pre-seeded by migration 056 (MoPA gazette 2026 + 2027), editable
 * by an admin whenever the government changes them.
 *
 *   GET    /calendar/config      any signed-in user: the weekend
 *                                days + holidays (optional ?from&to=
 *                                range filter) — the read the Task
 *                                Calendar renders from.
 *   PUT    /calendar/weekend     settings.manage — replace the
 *                                weekend day set ([5,6] default).
 *   POST   /calendar/holidays    settings.manage — add a holiday.
 *   PUT    /calendar/holidays/:id  settings.manage — edit one.
 *   DELETE /calendar/holidays/:id  settings.manage — remove one.
 *
 * Duplicate (date, name) is a 400 with a clear message — the pair
 * is the identity of a holiday (one date may carry two holidays).
 * Config storage + validation live in CalendarConfigService (the
 * weekend rides the Metadata Engine like LeadSla/auto-assignment).
 */
import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { createId, fallbackStore } from '../../fallbackStore.js';
import {
  asUuid,
  clean,
  dbErrorStatus,
  getCallerDbInfo,
  logAccessChange,
  requireAuth,
  requirePermissionCode,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';
import {
  getCalendarWeekendDays,
  isValidHolidayDate,
  listCalendarHolidays,
  mapHolidayRow,
  normalizeHolidayCategory,
  parseWeekendDays,
  setCalendarWeekendDays,
  type CalendarHoliday,
} from '../../services/CalendarConfigService.js';

const router = Router();

const DUPLICATE_MESSAGE = 'A holiday with this name already exists on that date.';

function isUniqueViolation(error: any): boolean {
  return error?.code === '23505';
}

interface HolidayPayload {
  date: string;
  name: string;
  category: 'general' | 'executive';
  moonDependent: boolean;
  regional: boolean;
  note: string | null;
}

/** Validate a create/update body; returns the payload or an error message. */
function parseHolidayPayload(body: any): { payload: HolidayPayload } | { error: string } {
  const date = clean(body?.date);
  if (!isValidHolidayDate(date)) return { error: 'A valid holiday date (YYYY-MM-DD) is required.' };
  const name = clean(body?.name);
  if (!name) return { error: 'A holiday name is required.' };
  if (name.length > 255) return { error: 'The holiday name is too long (max 255 characters).' };
  const category = normalizeHolidayCategory(body?.category ?? 'general');
  if (!category) return { error: "Category must be 'general' or 'executive'." };
  const noteRaw = body?.note == null ? null : clean(body.note);
  return {
    payload: {
      date,
      name,
      category,
      moonDependent: body?.moonDependent === true || body?.moon_dependent === true,
      regional: body?.regional === true,
      note: noteRaw ? noteRaw : null,
    },
  };
}

/* ====================================================================
   CONFIG READ — any signed-in user
==================================================================== */

router.get('/calendar/config', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const fromRaw = clean(req.query.from);
  const toRaw = clean(req.query.to);
  if (fromRaw && !isValidHolidayDate(fromRaw)) {
    return sendJson(res, 400, { success: false, message: 'Invalid "from" date (YYYY-MM-DD).' });
  }
  if (toRaw && !isValidHolidayDate(toRaw)) {
    return sendJson(res, 400, { success: false, message: 'Invalid "to" date (YYYY-MM-DD).' });
  }
  try {
    const weekendDays = await getCalendarWeekendDays();
    let holidays: CalendarHoliday[] = [];
    try {
      holidays = await listCalendarHolidays(fromRaw || undefined, toRaw || undefined);
    } catch {
      // Pre-056 schema (table not created yet): the config still
      // answers with the weekend and an empty holiday list.
      holidays = [];
    }
    return sendJson(res, 200, { success: true, data: { weekendDays, holidays } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Calendar config fetch failed' });
  }
});

/* ====================================================================
   WEEKEND — settings.manage
==================================================================== */

router.put('/calendar/weekend', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const days = parseWeekendDays(req.body?.weekendDays);
  if (!days) {
    return sendJson(res, 400, {
      success: false,
      message: 'weekendDays must be an array of unique weekday numbers (0 = Sunday … 6 = Saturday).',
    });
  }
  try {
    const saved = await setCalendarWeekendDays(days);
    const caller = await getCallerDbInfo(req).catch(() => null);
    await logAccessChange({
      actorId: caller?.id || null,
      actionCode: 'calendar.weekend.update',
      entityType: 'calendar_config',
      entityId: null,
      metadata: { weekendDays: saved },
    });
    return sendJson(res, 200, { success: true, data: { weekendDays: saved } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Weekend update failed' });
  }
});

/* ====================================================================
   HOLIDAY CRUD — settings.manage
==================================================================== */

router.post('/calendar/holidays', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const parsed = parseHolidayPayload(req.body);
  if ('error' in parsed) return sendJson(res, 400, { success: false, message: parsed.error });
  const p = parsed.payload;
  const caller = await getCallerDbInfo(req).catch(() => null);
  const actorId = caller?.id && asUuid(caller.id) ? caller.id : null;

  if (!useDb()) {
    const store = fallbackStore as any;
    if (!Array.isArray(store.calendarHolidays)) store.calendarHolidays = [];
    if (store.calendarHolidays.some((h: any) => h.date === p.date && h.name === p.name)) {
      return sendJson(res, 400, { success: false, message: DUPLICATE_MESSAGE });
    }
    const row = { id: createId('holiday'), ...p };
    store.calendarHolidays.push(row);
    return sendJson(res, 201, { success: true, data: row });
  }
  try {
    const result = await getPool().query(
      `INSERT INTO calendar_holidays (holiday_date, name, category, moon_dependent, regional, note, created_by, updated_by)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [p.date, p.name, p.category, p.moonDependent, p.regional, p.note, actorId]
    );
    const saved = mapHolidayRow(result.rows[0]);
    await logAccessChange({
      actorId,
      actionCode: 'calendar.holiday.create',
      entityType: 'calendar_holiday',
      entityId: saved.id,
      metadata: { date: saved.date, name: saved.name },
    });
    return sendJson(res, 201, { success: true, data: saved });
  } catch (error: any) {
    if (isUniqueViolation(error)) return sendJson(res, 400, { success: false, message: DUPLICATE_MESSAGE });
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Holiday creation failed' });
  }
});

router.put('/calendar/holidays/:id', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const id = clean(req.params.id);
  const parsed = parseHolidayPayload(req.body);
  if ('error' in parsed) return sendJson(res, 400, { success: false, message: parsed.error });
  const p = parsed.payload;
  const caller = await getCallerDbInfo(req).catch(() => null);
  const actorId = caller?.id && asUuid(caller.id) ? caller.id : null;

  if (!useDb()) {
    const store = fallbackStore as any;
    const rows: any[] = Array.isArray(store.calendarHolidays) ? store.calendarHolidays : [];
    const row = rows.find((h: any) => String(h.id) === id);
    if (!row) return sendJson(res, 404, { success: false, message: 'Holiday not found.' });
    if (rows.some((h: any) => h !== row && h.date === p.date && h.name === p.name)) {
      return sendJson(res, 400, { success: false, message: DUPLICATE_MESSAGE });
    }
    Object.assign(row, p);
    return sendJson(res, 200, { success: true, data: { id: String(row.id), ...p } });
  }
  try {
    const result = await getPool().query(
      `UPDATE calendar_holidays
          SET holiday_date = $1::date, name = $2, category = $3,
              moon_dependent = $4, regional = $5, note = $6,
              updated_by = $7, updated_at = NOW()
        WHERE id = $8
        RETURNING *`,
      [p.date, p.name, p.category, p.moonDependent, p.regional, p.note, actorId, asUuid(id) ? id : null]
    );
    if (result.rows.length === 0) {
      return sendJson(res, 404, { success: false, message: 'Holiday not found.' });
    }
    const saved = mapHolidayRow(result.rows[0]);
    await logAccessChange({
      actorId,
      actionCode: 'calendar.holiday.update',
      entityType: 'calendar_holiday',
      entityId: saved.id,
      metadata: { date: saved.date, name: saved.name },
    });
    return sendJson(res, 200, { success: true, data: saved });
  } catch (error: any) {
    if (isUniqueViolation(error)) return sendJson(res, 400, { success: false, message: DUPLICATE_MESSAGE });
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Holiday update failed' });
  }
});

router.delete('/calendar/holidays/:id', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const id = clean(req.params.id);

  if (!useDb()) {
    const store = fallbackStore as any;
    const rows: any[] = Array.isArray(store.calendarHolidays) ? store.calendarHolidays : [];
    const idx = rows.findIndex((h: any) => String(h.id) === id);
    if (idx < 0) return sendJson(res, 404, { success: false, message: 'Holiday not found.' });
    rows.splice(idx, 1);
    return sendJson(res, 200, { success: true, data: { deleted: true, id } });
  }
  try {
    const result = await getPool().query(
      `DELETE FROM calendar_holidays WHERE id = $1 RETURNING id`,
      [asUuid(id) ? id : null]
    );
    if (result.rows.length === 0) {
      return sendJson(res, 404, { success: false, message: 'Holiday not found.' });
    }
    const caller = await getCallerDbInfo(req).catch(() => null);
    await logAccessChange({
      actorId: caller?.id || null,
      actionCode: 'calendar.holiday.delete',
      entityType: 'calendar_holiday',
      entityId: id,
    });
    return sendJson(res, 200, { success: true, data: { deleted: true, id } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Holiday delete failed' });
  }
});

export default router;
