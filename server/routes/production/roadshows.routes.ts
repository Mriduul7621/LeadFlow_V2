/**
 * production/roadshows.routes.ts — ROADSHOWS + SCHEDULED ACTIVITIES
 * domains of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the four roadshow
 * handlers and the seven scheduled-activity handlers that used to
 * live inline in production.routes.ts, moved verbatim together with
 * their exclusive helpers (roadshow payload/loader, the scheduled
 * constants and row mapper). The two sub-domains stay in ONE file —
 * consistent with the one-file-per-domain pattern of the earlier
 * Phase 1 extractions — and their original relative order is kept:
 * roadshows first, then scheduled activities. Helpers shared with
 * the remaining monolith domains are imported from ./shared.js (one
 * definition, shared with production.routes.ts).
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import { createPerf } from '../../utils/perf.js';
import { addCalendarDays, dhakaStartUtc, parseYmd, storedTimestampIso } from '../../utils/businessTime.js';
import {
  notifyMeetingClosed,
  notifyMeetingInvites,
  notifyMeetingMoved,
  notifyMeetingRsvp,
  type MeetingActivityRef,
} from '../../services/MeetingNotificationService.js';
import {
  compactQualityForFallbackLeads,
  compactScoreLeadRow,
  fetchActivityQualitySignals,
  fetchScheduledQualitySignals,
} from '../../utils/leadQualitySignals.js';
import { getLeadQualityConfig } from '../../services/LeadQualityConfigService.js';
import {
  resolveNextStep,
  syncNextStepAfterFollowUp,
  syncNextStepAfterFollowUpDemo,
} from '../../services/NextStepCalendarSync.js';
import {
  buildDashboardVisibilitySql,
  callerIsAdmin,
  clean,
  dateOrNull,
  dbErrorStatus,
  demoModeAllowed,
  findLeadByIdRaw,
  getCallerDbInfo,
  getFollowUpStatusValues,
  hasPermissionCode,
  isAssignedToAllowed,
  isCanonicalLowerUuid,
  isLeadAccessible,
  mapActivityRow,
  mapScheduledActivityRow,
  parseNumeric,
  requireAuth,
  requirePermissionCode,
  resolveAssignedTo,
  resolveCallerVisibility,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';

const router = Router();

/* ====================================================================
   ROADSHOWS
==================================================================== */

const ROADSHOW_STATUSES = ['pending', 'execute', 'reschedule', 'cancel'] as const;

/**
 * Roadshow assignment rule (Mahadi's decision, 2026-11-09): the assigned
 * people are exactly the roadshow's CREATOR plus the employees picked as
 * "assist" — nobody else is ever added implicitly, and the creator can
 * never be removed from their own roadshow's assignee set. Assist picks
 * must be ACTIVE users: an inactive pick is refused with the same
 * semantics as the lead-assignment rule (PR #106 — 400, naming the
 * person), while an unknown id keeps the historical "unavailable"
 * refusal. Returns the effective assignee id set or an error message.
 */
async function resolveRoadshowAssignees(
  exec: { query: Function },
  creatorId: string | null,
  pickedIds: unknown[]
): Promise<{ ids: string[] } | { error: string }> {
  const picked = [...new Set(pickedIds.map(v => String(v ?? '').trim()).filter(Boolean))];
  if (picked.length > 0) {
    const found = await exec.query(
      `SELECT id, employee_id, COALESCE(is_active, TRUE) AS is_active FROM users WHERE id = ANY($1::uuid[])`,
      [picked]
    );
    const byId = new Map<string, any>(found.rows.map((r: any) => [String(r.id), r]));
    for (const id of picked) {
      const row = byId.get(String(id));
      if (!row) return { error: 'One or more selected assignees are unavailable.' };
      if (row.is_active !== true) {
        return { error: `Assigned user "${row.employee_id}" is inactive and cannot be assigned to a roadshow.` };
      }
    }
  }
  const ids = [...new Set([...(creatorId ? [creatorId] : []), ...picked])];
  return { ids };
}

function roadshowOrganizationKey(organization: string): string {
  return organization
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 80);
}

function roadshowTimestampIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const withZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(withZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function roadshowPayload(row: any): any {
  return {
    id: row.id,
    organization: row.organization,
    location: row.location,
    scheduledAt: roadshowTimestampIso(row.scheduled_at),
    status: row.status,
    sourceCode: row.source_code || null,
    executedAt: row.executed_at || null,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedUsers: row.assigned_users || [],
    totalLeads: Number(row.total_leads || 0),
    convertedLeads: Number(row.converted_leads || 0),
    stageBreakdown: row.stage_breakdown || [],
  };
}

async function loadRoadshows(
  pool: any,
  options: { from?: { y: number; m: number; d: number } | null; to?: { y: number; m: number; d: number } | null; assignedUserId?: string }
): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (options.from) {
    const start = dhakaStartUtc(options.from.y, options.from.m, options.from.d);
    params.push(start.toISOString());
    where.push(`r.scheduled_at >= $${params.length}::timestamp`);
  }
  if (options.to) {
    const next = addCalendarDays(options.to.y, options.to.m, options.to.d, 1);
    const end = dhakaStartUtc(next.y, next.m, next.d);
    params.push(end.toISOString());
    where.push(`r.scheduled_at < $${params.length}::timestamp`);
  }
  if (options.assignedUserId) {
    params.push(options.assignedUserId);
    where.push(`EXISTS (SELECT 1 FROM roadshow_assignees ra_filter WHERE ra_filter.roadshow_id = r.id AND ra_filter.user_id = $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await pool.query(
    `WITH stage_counts AS (
       SELECT source, current_status, COUNT(*)::int AS stage_count
         FROM leads
        WHERE COALESCE(is_deleted, FALSE) = FALSE
        GROUP BY source, current_status
     )
     SELECT r.*,
       COUNT(DISTINCT l.id)::int AS total_leads,
       COUNT(DISTINCT l.id) FILTER (WHERE l.current_status = 'Converted')::int AS converted_leads,
       COALESCE(
         json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.full_name, 'employeeId', u.employee_id))
           FILTER (WHERE u.id IS NOT NULL), '[]'::json
       ) AS assigned_users,
       COALESCE(
         json_agg(DISTINCT jsonb_build_object('status', sc.current_status, 'count', sc.stage_count))
           FILTER (WHERE sc.current_status IS NOT NULL), '[]'::json
       ) AS stage_breakdown
      FROM roadshows r
      LEFT JOIN roadshow_assignees ra ON ra.roadshow_id = r.id
      LEFT JOIN users u ON u.id = ra.user_id
      LEFT JOIN leads l ON l.source = r.source_code AND COALESCE(l.is_deleted, FALSE) = FALSE
      LEFT JOIN stage_counts sc ON sc.source = r.source_code
      ${whereSql}
     GROUP BY r.id
     ORDER BY r.scheduled_at ASC, r.created_at DESC`,
    params
  );
  return result.rows.map(roadshowPayload);
}

router.get('/roadshows', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'roadshows.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view Roadshows.' });
    }
    const fromYmd = parseYmd(req.query?.from ? String(req.query.from) : null);
    const toYmd = parseYmd(req.query?.to ? String(req.query.to) : null);
    if (req.query?.from && !fromYmd) return sendJson(res, 400, { success: false, message: 'from must be YYYY-MM-DD.' });
    if (req.query?.to && !toYmd) return sendJson(res, 400, { success: false, message: 'to must be YYYY-MM-DD.' });
    const assignedUserId = req.query?.mine === 'true' ? caller.id : undefined;
    const rows = await loadRoadshows(getPool(), { from: fromYmd, to: toYmd, assignedUserId });
    return sendJson(res, 200, { success: true, data: rows });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Roadshows could not be loaded.' });
  }
});

router.get('/roadshows/performance', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'roadshows.report'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view Roadshow performance.' });
    }
    const rows = await loadRoadshows(getPool(), {});
    return sendJson(res, 200, { success: true, data: rows.filter(row => row.status === 'execute' && row.sourceCode) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Roadshow performance could not be loaded.' });
  }
});

router.post('/roadshows', requireAuth, requirePermissionCode('roadshows.create'), async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  const organization = clean(req.body?.organization).slice(0, 255);
  const location = clean(req.body?.location).slice(0, 255);
  const scheduledAt = req.body?.scheduledAt;
  const assignedUserIds = Array.isArray(req.body?.assignedUserIds) ? [...new Set(req.body.assignedUserIds.map((id: unknown) => clean(id)).filter(Boolean))] : [];
  const date = typeof scheduledAt === 'string' ? new Date(scheduledAt) : null;
  if (!organization || !location || !date || !Number.isFinite(date.getTime())) {
    return sendJson(res, 400, { success: false, message: 'Organization, location, and date/time are required.' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The creator is always an assignee of their own roadshow; the
      // client's picks are the "assist" set (see resolveRoadshowAssignees).
      // Zero assist picks is valid — the creator alone is assigned.
      const resolvedAssignees = await resolveRoadshowAssignees(client, caller.id, assignedUserIds);
      if ('error' in resolvedAssignees) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: resolvedAssignees.error });
      }
      const created = await client.query(
        `INSERT INTO roadshows (organization, location, scheduled_at, created_by, updated_by)
         VALUES ($1, $2, $3::timestamp, $4, $4) RETURNING id`,
        [organization, location, date.toISOString(), caller.id]
      );
      const roadshowId = created.rows[0].id;
      for (const userId of resolvedAssignees.ids) {
        await client.query(`INSERT INTO roadshow_assignees (roadshow_id, user_id) VALUES ($1, $2)`, [roadshowId, userId]);
      }
      await client.query('COMMIT');
      const rows = await loadRoadshows(pool, {});
      return sendJson(res, 201, { success: true, data: rows.find(row => row.id === roadshowId) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Roadshow could not be created.' });
  }
});

router.put('/roadshows/:id', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  const id = clean(req.params.id);
  const body = req.body || {};
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query(`SELECT * FROM roadshows WHERE id = $1 FOR UPDATE`, [id]);
      const existing = existingResult.rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        return sendJson(res, 404, { success: false, message: 'Roadshow not found.' });
      }
      const isAdmin = callerIsAdmin(req);
      if (existing.status === 'execute' && !isAdmin) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { success: false, message: 'Executed Roadshows are locked. Only an administrator can edit them.' });
      }
      if (existing.status === 'cancel' && !isAdmin) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { success: false, message: 'Cancelled Roadshows cannot be changed.' });
      }
      const nextStatus = body.status === undefined ? existing.status : String(body.status).toLowerCase();
      if (!ROADSHOW_STATUSES.includes(nextStatus)) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: `status must be one of ${ROADSHOW_STATUSES.join(', ')}.` });
      }
      const permission = nextStatus === 'cancel' ? 'roadshows.cancel' : 'roadshows.edit';
      if (!(await hasPermissionCode(caller, permission))) {
        await client.query('ROLLBACK');
        return sendJson(res, 403, { success: false, message: `You do not have permission to ${nextStatus === 'cancel' ? 'cancel' : 'edit'} Roadshows.` });
      }
      const organization = body.organization === undefined ? existing.organization : clean(body.organization).slice(0, 255);
      const location = body.location === undefined ? existing.location : clean(body.location).slice(0, 255);
      const date = body.scheduledAt === undefined ? new Date(existing.scheduled_at) : new Date(body.scheduledAt);
      if (!organization || !location || !Number.isFinite(date.getTime())) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: 'Organization, location, and a valid date/time are required.' });
      }
      if (nextStatus === 'reschedule' && (
        body.scheduledAt === undefined ||
        roadshowTimestampIso(existing.scheduled_at) === date.toISOString()
      )) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: 'A new date and time are required when rescheduling.' });
      }
      const assignedUserIds = body.assignedUserIds === undefined
        ? null
        : Array.isArray(body.assignedUserIds)
          ? [...new Set(body.assignedUserIds.map((userId: unknown) => clean(userId)).filter(Boolean))]
          : [];
      // Same rule as create: the roadshow's CREATOR stays assigned, the
      // submitted picks are the assist set — an edit replaces the assists,
      // never the creator. An empty assist set is valid while a creator
      // exists; with neither, the historical refusal stands.
      let effectiveAssigneeIds: string[] | null = null;
      if (assignedUserIds) {
        const resolvedAssignees = await resolveRoadshowAssignees(
          client,
          existing.created_by ? String(existing.created_by) : null,
          assignedUserIds
        );
        if ('error' in resolvedAssignees) {
          await client.query('ROLLBACK');
          return sendJson(res, 400, { success: false, message: resolvedAssignees.error });
        }
        if (resolvedAssignees.ids.length === 0) {
          await client.query('ROLLBACK');
          return sendJson(res, 400, { success: false, message: 'At least one assignee is required.' });
        }
        effectiveAssigneeIds = resolvedAssignees.ids;
      }

      let sourceCode = existing.source_code as string | null;
      if (nextStatus === 'execute' && !sourceCode) {
        const organizationKey = roadshowOrganizationKey(organization);
        if (!organizationKey) {
          await client.query('ROLLBACK');
          return sendJson(res, 400, { success: false, message: 'Organization must contain a letter or number to create a source code.' });
        }
        const counter = await client.query(
          `INSERT INTO roadshow_code_counters (organization_key, last_sequence)
           VALUES ($1, 1)
           ON CONFLICT (organization_key)
           DO UPDATE SET last_sequence = roadshow_code_counters.last_sequence + 1
           RETURNING last_sequence`,
          [organizationKey]
        );
        sourceCode = `${organizationKey}_${counter.rows[0].last_sequence}`;
        await client.query(
          `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
           VALUES ('Source', $1, $1, COALESCE((SELECT MAX(sort_order) + 1 FROM options WHERE field_key = 'Source'), 1), FALSE, TRUE, $2::jsonb, NOW(), NOW())
           ON CONFLICT (field_key, option_value) DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
          [sourceCode, JSON.stringify({ roadshowId: id, organization })]
        );
      }

      await client.query(
        `UPDATE roadshows
            SET organization = $2, location = $3, scheduled_at = $4::timestamp,
                status = $5::varchar, source_code = $6,
                executed_at = CASE WHEN $5::varchar = 'execute' THEN COALESCE(executed_at, NOW()) ELSE executed_at END,
                updated_by = $7, updated_at = NOW()
          WHERE id = $1`,
        [id, organization, location, date.toISOString(), nextStatus, sourceCode, caller.id]
      );
      if (effectiveAssigneeIds) {
        await client.query(`DELETE FROM roadshow_assignees WHERE roadshow_id = $1`, [id]);
        for (const userId of effectiveAssigneeIds) {
          await client.query(`INSERT INTO roadshow_assignees (roadshow_id, user_id) VALUES ($1, $2)`, [id, userId]);
        }
      }
      await client.query('COMMIT');
      const rows = await loadRoadshows(pool, {});
      return sendJson(res, 200, { success: true, data: rows.find(row => row.id === id) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Roadshow could not be updated.' });
  }
});

/* ===================================================================
   SCHEDULED ACTIVITIES — SERVER-AUTHORITATIVE CALENDAR (Step 5C)
   ------------------------------------------------------------------
   Dedicated table `scheduled_activities` powers both the Dashboard
   Daily Execution panel (Today/Tomorrow) and the Task Calendar.
   Rows are usually scoped to a lead, with visibility inherited from
   the parent lead via the same Own/DownTeam/FullTeam/Organization
   enforcement used for GET /leads and GET /leads/follow-ups. Since
   migration 055 a row may instead be LEAD-LESS (a team meeting or
   standalone task with attendees + RSVP) — those rows carry their
   own visibility arms (see the meeting helpers below).
   Business time is Asia/Dhaka; scheduled_at is stored as UTC.
   All mutations are PostgreSQL-authoritative with a dev-demo
   fallbackStore mirror for local development.
   =================================================================== */

const SCHEDULED_TYPES = ['call', 'meeting', 'follow_up', 'task'] as const;
type ScheduledType = typeof SCHEDULED_TYPES[number];
const SCHEDULED_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
type ScheduledStatus = typeof SCHEDULED_STATUSES[number];
const SCHEDULED_PRIORITIES = ['LOW', 'NORMAL', 'MEDIUM', 'HIGH'] as const;
type ScheduledPriority = typeof SCHEDULED_PRIORITIES[number];
const SCHEDULED_MAX_LIMIT = 200;
const SCHEDULED_DEFAULT_LIMIT = 50;

function parseScheduledAt(value: any): Date | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const d = new Date(String(value).trim());
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function normalizePriority(value: any): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim().toUpperCase();
  if (!SCHEDULED_PRIORITIES.includes(v as any)) return null;
  return v;
}

/* ====================================================================
   MEETING DATA MODEL (migration 055, PR B) — lead-less events,
   attendees, RSVP, reminders.
   ------------------------------------------------------------------
   A scheduled activity may now have NO lead (an internal team
   meeting or a standalone task). The organiser is `created_by`;
   invited colleagues live in `scheduled_activity_attendees` with an
   RSVP response. Visibility for lead-less rows (no existence leak —
   every surface answers the same 404 as for an invisible lead):
       caller created it, OR caller is an attendee, OR caller is the
       assignee, OR created_by ∈ caller's visibility set
       (resolveCallerVisibility — a manager sees their downline's
       meetings). Lead rows keep the PR #104 lead predicate unchanged.

   Organiser/attendee rule (documented choice): the creator is the
   organiser and is NOT required in attendeeIds; when the organiser
   IS listed, their attendee row is stored as 'accepted' (they
   obviously attend their own meeting) — everyone else starts
   'pending'. The organiser never RSVPs (POST /:id/rsvp refuses with
   a clear 400).

   Schema probing follows the PR A pattern: migration 055 auto-runs
   on server boot, but pre-055 schemas (older test fixtures, a dev DB
   that has not booted the new build) must degrade, never crash — the
   probe reads information_schema (which always exists), so no failed
   SQL can poison a caller's transaction.
==================================================================== */

const ATTENDEE_RESPONSES = ['pending', 'accepted', 'declined'] as const;

async function probeMeetingSchema(): Promise<{ attendees: boolean; reminder: boolean }> {
  if (!useDb()) return { attendees: true, reminder: true };
  try {
    const r = await getPool().query(
      `SELECT (
         EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'scheduled_activity_attendees')
       ) AS attendees, (
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'scheduled_activities' AND column_name = 'reminder_minutes')
       ) AS reminder`
    );
    return { attendees: Boolean(r.rows[0]?.attendees), reminder: Boolean(r.rows[0]?.reminder) };
  } catch {
    return { attendees: false, reminder: false };
  }
}

/**
 * Resolve attendee refs (user uuid / employee id / email) to users.
 * Same active-only semantics as lead assignment (PR #106): an
 * inactive attendee is refused with a 400 naming the person; an
 * unknown ref is a 400 naming the ref. Deduped by user id.
 */
async function resolveAttendees(
  rawRefs: any[]
): Promise<{ attendees: { userId: string; employeeId: string }[] } | { error: string }> {
  const refs = [...new Set((rawRefs || []).map(v => String(v ?? '').trim()).filter(Boolean))];
  const out: { userId: string; employeeId: string }[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const resolved = await resolveAssignedTo(ref);
    if (!resolved) return { error: `attendee "${ref}" was not found.` };
    if (!resolved.isActive) {
      return { error: `Assigned user "${resolved.employeeId}" is inactive and cannot be added as an attendee.` };
    }
    if (!seen.has(resolved.userId)) {
      seen.add(resolved.userId);
      out.push({ userId: resolved.userId, employeeId: resolved.employeeId });
    }
  }
  return { attendees: out };
}

/** reminderMinutes: NULL/empty → null (no reminder); else an integer 0..10080 (a week). */
function parseReminderMinutes(raw: any): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10080) {
    return { error: 'reminderMinutes must be an integer between 0 and 10080.' };
  }
  return { value: n };
}

/** Bulk attendee fetch for a page of activities — never per-row. */
async function fetchAttendeesByActivity(activityIds: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  const ids = [...new Set((activityIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return map;
  const r = await getPool().query(
    `SELECT a.activity_id, a.user_id, u.employee_id, u.full_name, a.response, a.responded_at
     FROM scheduled_activity_attendees a
     JOIN users u ON u.id = a.user_id
     WHERE a.activity_id = ANY($1::uuid[])
     ORDER BY u.full_name ASC`,
    [ids]
  );
  for (const row of r.rows || []) {
    const key = String(row.activity_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({
      userId: String(row.user_id),
      employeeId: row.employee_id || null,
      fullName: row.full_name || null,
      response: row.response || 'pending',
      respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    });
  }
  return map;
}

/** Attach `attendees` arrays to DB rows (empty arrays pre-055). */
async function attachAttendees(rows: any[], schema: { attendees: boolean }): Promise<void> {
  if (!rows || rows.length === 0) return;
  if (!schema.attendees) {
    for (const row of rows) row.attendees = [];
    return;
  }
  const map = await fetchAttendeesByActivity(rows.map((r: any) => String(r.id)));
  for (const row of rows) row.attendees = map.get(String(row.id)) || [];
}

/** Insert invite rows for a freshly created activity (organiser-in-list ⇒ accepted). */
async function insertAttendees(
  exec: { query: Function },
  activityId: string,
  organiserId: string,
  attendees: { userId: string }[]
): Promise<void> {
  for (const a of attendees) {
    const isOrganiser = String(a.userId) === String(organiserId);
    await exec.query(
      `INSERT INTO scheduled_activity_attendees (activity_id, user_id, response, responded_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (activity_id, user_id) DO NOTHING`,
      [activityId, a.userId, isOrganiser ? 'accepted' : 'pending', isOrganiser ? new Date() : null]
    );
  }
}

/**
 * Replace an activity's invite set: retained users keep their RSVP,
 * removed users' rows go away, new users start 'pending' (organiser
 * 'accepted', as on create).
 */
async function replaceAttendees(
  exec: { query: Function },
  activityId: string,
  organiserId: string,
  attendees: { userId: string }[]
): Promise<void> {
  const ids = attendees.map(a => a.userId);
  if (ids.length > 0) {
    await exec.query(
      `DELETE FROM scheduled_activity_attendees WHERE activity_id = $1 AND NOT (user_id = ANY($2::uuid[]))`,
      [activityId, ids]
    );
  } else {
    await exec.query(`DELETE FROM scheduled_activity_attendees WHERE activity_id = $1`, [activityId]);
  }
  await insertAttendees(exec, activityId, organiserId, attendees);
  if (ids.includes(String(organiserId))) {
    await exec.query(
      `UPDATE scheduled_activity_attendees
       SET response = 'accepted', responded_at = COALESCE(responded_at, NOW())
       WHERE activity_id = $1 AND user_id = $2`,
      [activityId, organiserId]
    );
  }
}

/** Row-level lead-less visibility (DB rows) — the arms listed in the header. */
function isLeadlessVisible(row: any, attendeeUserIds: string[], visibility: any, caller: any): boolean {
  if (!row) return false;
  if (visibility.all) return true;
  const userIds: string[] = visibility.userIds || [];
  if (row.created_by && userIds.includes(String(row.created_by))) return true;
  if (row.assigned_to && String(row.assigned_to) === String(caller.id)) return true;
  if ((attendeeUserIds || []).includes(String(caller.id))) return true;
  return false;
}

/** SQL twin of isLeadlessVisible for the calendar list. */
function leadlessVisibilitySql(visibility: any, params: any[], caller: any, hasAttendees: boolean): string {
  if (visibility.all) return 'TRUE';
  params.push(visibility.userIds);
  const pUser = params.length;
  params.push(caller.id);
  const pCaller = params.length;
  const attendeeArm = hasAttendees
    ? ` OR EXISTS (SELECT 1 FROM scheduled_activity_attendees saa WHERE saa.activity_id = sa.id AND saa.user_id = $${pCaller}::uuid)`
    : '';
  return `(sa.created_by = ANY($${pUser}::uuid[]) OR sa.assigned_to = $${pCaller}::uuid${attendeeArm})`;
}

/** Demo-mode lead-less visibility (attendees live on the entry object). */
function demoLeadlessVisible(entry: any, visibility: any, caller: any): boolean {
  if (!entry) return false;
  if (visibility.all) return true;
  const userIds: string[] = visibility.userIds || [];
  const createdBy = entry.created_by || entry.createdBy || null;
  if (createdBy && userIds.includes(String(createdBy))) return true;
  const assignedUuid = entry.assigned_to || null;
  const assignedEmp = entry.assignedTo || entry.assigned_to || null;
  if (assignedUuid && String(assignedUuid) === String(caller.id)) return true;
  if (assignedEmp && caller.employee_id && String(assignedEmp).toUpperCase() === String(caller.employee_id).toUpperCase()) return true;
  if (Array.isArray(entry.attendees) && entry.attendees.some((a: any) => String(a.userId) === String(caller.id))) return true;
  return false;
}

/* ------------------------------------------------------------------
   MEETING NOTIFICATIONS (PR E) — fan-out hooks for the handlers
   below. Every hook runs AFTER the business mutation has committed
   (or, in demo mode, after the store write) and goes through
   MeetingNotificationService, which never throws: a notification
   failure can never fail a mutation that is already durable.
   ------------------------------------------------------------------ */

/** Build the notification service's activity ref from a DB/demo row. */
function meetingNotifyActivity(row: any, leadCustomerName?: string | null): MeetingActivityRef {
  return {
    id: String(row.id),
    title: row.title ?? null,
    activityType: row.activity_type || row.activityType || null,
    scheduledAt: storedTimestampIso(row.scheduled_at ?? row.scheduledAt),
    leadCustomerName: leadCustomerName ?? row.lead_customer_name ?? null,
    createdBy: row.created_by || row.createdBy ? String(row.created_by || row.createdBy) : null,
  };
}

/** Notification recipients from attached attendee objects. */
function attendeeRecipients(attendees: any[] | undefined | null): { userId: string; employeeId: string }[] {
  return (Array.isArray(attendees) ? attendees : []).map((a: any) => ({
    userId: String(a.userId),
    employeeId: a.employeeId ? String(a.employeeId) : '',
  }));
}

/** PR E: fetch a DB row's attendees and send the closed notice. */
async function notifyClosedFromDbRow(row: any, kind: 'cancelled' | 'completed', leadCustomerName?: string | null): Promise<void> {
  const schema = await probeMeetingSchema();
  let attendees: any[] = [];
  if (schema.attendees) {
    const map = await fetchAttendeesByActivity([String(row.id)]);
    attendees = map.get(String(row.id)) || [];
  }
  await notifyMeetingClosed({
    activity: meetingNotifyActivity(row, leadCustomerName),
    organiserId: String(row.created_by || ''),
    attendees: attendeeRecipients(attendees),
    kind,
  });
}

/** Demo-mode attendee objects for an entry (organiser-in-list ⇒ accepted). */
function demoAttendeeObjects(attendees: { userId: string; employeeId: string }[], organiserId: string): any[] {
  return attendees.map(a => {
    const u = fallbackStore.users.find(x => x.id === a.userId);
    const isOrganiser = String(a.userId) === String(organiserId);
    return {
      userId: a.userId,
      employeeId: a.employeeId,
      fullName: (u as any)?.fullName || (u as any)?.name || null,
      response: isOrganiser ? 'accepted' : 'pending',
      respondedAt: isOrganiser ? new Date().toISOString() : null,
    };
  });
}

/* ------------------------------------------------------------------
   GET /scheduled-activities — calendar list, visibility enforced
   Query: from=YYYY-MM-DD, to=YYYY-MM-DD, leadId, activityType,
          status, priority, assignedTo, limit, offset
   Scope: Same Own/DownTeam/FullTeam/Organization as leads (via parent lead).
   assignedTo is a NARROWING filter only — it never widens visibility.
------------------------------------------------------------------- */
router.get('/scheduled-activities', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    const [canViewSchedule, visibility] = await Promise.all([
      hasPermissionCode(caller, 'leads.view'),
      resolveCallerVisibility(caller),
    ]);
    if (!canViewSchedule) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }

    const fromYmd = parseYmd(req.query?.from ? String(req.query.from) : null);
    const toYmd = parseYmd(req.query?.to ? String(req.query.to) : null);
    if (req.query?.from && !fromYmd) return sendJson(res, 400, { success: false, message: 'from must be YYYY-MM-DD.' });
    if (req.query?.to && !toYmd) return sendJson(res, 400, { success: false, message: 'to must be YYYY-MM-DD.' });

    const leadIdFilter = req.query?.leadId ? String(req.query.leadId).trim() : (req.query?.lead_id ? String(req.query.lead_id).trim() : '');
    const typeFilter = req.query?.activityType ? String(req.query.activityType).trim().toLowerCase() : (req.query?.activity_type ? String(req.query.activity_type).trim().toLowerCase() : '');
    if (typeFilter && !SCHEDULED_TYPES.includes(typeFilter as any)) {
      return sendJson(res, 400, { success: false, message: `activityType must be one of ${SCHEDULED_TYPES.join(', ')}.` });
    }
    const statusFilter = req.query?.status ? String(req.query.status).trim().toLowerCase() : '';
    if (statusFilter && !SCHEDULED_STATUSES.includes(statusFilter as any)) {
      return sendJson(res, 400, { success: false, message: `status must be one of ${SCHEDULED_STATUSES.join(', ')}.` });
    }
    const priorityFilter = req.query?.priority ? String(req.query.priority).trim().toUpperCase() : '';
    if (priorityFilter && !SCHEDULED_PRIORITIES.includes(priorityFilter as any)) {
      return sendJson(res, 400, { success: false, message: `priority must be one of ${SCHEDULED_PRIORITIES.join(', ')}.` });
    }
    const assignedToRaw = req.query?.assignedTo ? String(req.query.assignedTo).trim() : (req.query?.assigned_to ? String(req.query.assigned_to).trim() : '');

    let limit = Number(req.query?.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = SCHEDULED_DEFAULT_LIMIT;
    limit = Math.min(Math.floor(limit), SCHEDULED_MAX_LIMIT);
    let offset = Number(req.query?.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    offset = Math.floor(offset);

    // `visibility` was resolved together with the permission check above
    // (request-scoped memo — no second lookup).

    // assignedTo NARROWING filter — never widens visibility
    let assignedFilter: { userId: string; employeeId: string } | null = null;
    let assignedOutOfScope = false;
    if (assignedToRaw) {
      const resolved = await resolveAssignedTo(assignedToRaw);
      if (!resolved || !isAssignedToAllowed(resolved, visibility, caller)) {
        assignedOutOfScope = true;
      } else {
        assignedFilter = resolved;
      }
    }
    if (assignedOutOfScope) {
      return sendJson(res, 200, { success: true, data: [], pagination: { limit, offset, total: 0 } });
    }

    // Demo mode (no DB) — filter in-memory
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      let rows = (fallbackStore as any).scheduledActivities || [];
      // Visibility via lead
      const leadById = new Map((fallbackStore.leads || []).map((l: any) => [String(l.id), l]));
      rows = rows.filter((sa: any) => {
        if (leadIdFilter && String(sa.leadId) !== leadIdFilter && String(sa.lead_id) !== leadIdFilter) return false;
        if (typeFilter && String(sa.activityType || sa.activity_type).toLowerCase() !== typeFilter) return false;
        if (statusFilter && String(sa.status).toLowerCase() !== statusFilter) return false;
        if (priorityFilter && String(sa.priority || 'NORMAL').toUpperCase() !== priorityFilter) return false;
        if (assignedFilter && String(sa.assignedTo || sa.assigned_to || '').toUpperCase() !== assignedFilter.employeeId.toUpperCase() && String(sa.assignedTo || sa.assigned_to || '') !== assignedFilter.userId) return false;
        const t = new Date(sa.scheduledAt || sa.scheduled_at).getTime();
        if (fromYmd) {
          const fromStart = dhakaStartUtc(fromYmd.y, fromYmd.m, fromYmd.d).getTime();
          if (t < fromStart) return false;
        }
        if (toYmd) {
          const next = addCalendarDays(toYmd.y, toYmd.m, toYmd.d, 1);
          const toEnd = dhakaStartUtc(next.y, next.m, next.d).getTime();
          if (t >= toEnd) return false;
        }
        // Visibility: lead rows via the parent lead; lead-less rows
        // (migration 055 meetings/tasks) via the meeting arms —
        // organiser / attendee / assignee / organiser-in-scope.
        const leadRef = sa.leadId || sa.lead_id || null;
        if (!leadRef) return demoLeadlessVisible(sa, visibility, caller);
        const lead = leadById.get(String(leadRef));
        if (!lead) return false;
        if (lead.is_deleted === true) return false;
        // THE lead-access predicate — same unified rule as the DB
        // list (assignee in scope OR creator in scope).
        if (!isLeadAccessible(
          { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
          visibility,
          caller
        )) return false;
        // Also respect soft-deleted lead check already done
        return true;
      });
      rows.sort((a: any, b: any) => new Date(a.scheduledAt || a.scheduled_at).getTime() - new Date(b.scheduledAt || b.scheduled_at).getTime());
      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      // Parent-lead quality for the page (in-memory, same formula).
      const pageLeads = Array.from(
        new Map(
          page
            .map((r: any) => leadById.get(String(r.leadId || r.lead_id)))
            .filter(Boolean)
            .map((l: any) => [String(l.id), l])
        ).values()
      );
      const schedDemoQuality = compactQualityForFallbackLeads(
        pageLeads,
        (fallbackStore as any).leadActivities || [],
        (fallbackStore as any).scheduledActivities || [],
        undefined,
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        await getLeadQualityConfig()
      );
      const items = page.map((r: any) => {
        const lead = leadById.get(String(r.leadId || r.lead_id));
        const mapped: any = mapScheduledActivityRow({ ...r, lead_customer_name: (lead as any)?.prospectName || (lead as any)?.customerName, lead_mobile: (lead as any)?.mobile, lead_current_status: (lead as any)?.currentStatus });
        mapped.leadQuality = schedDemoQuality.get(String((lead as any)?.id || '')) || null;
        return mapped;
      });
      return sendJson(res, 200, { success: true, data: items, pagination: { limit, offset, total } });
    }

    const pool = getPool();
    const meetingSchema = await probeMeetingSchema();
    const params: any[] = [];
    const where: string[] = [];

    if (leadIdFilter) {
      params.push(leadIdFilter);
      // Parenthesised: the clauses are AND-joined below, and an
      // unparenthesised OR would bind looser than AND — the first
      // disjunct (lead UUID form) would then escape EVERY other
      // condition, including the visibility predicate and the date
      // range (pre-existing leak, caught by the PR A sync tests).
      where.push(`(sa.lead_id::text = $${params.length} OR sa.lead_id IN (SELECT id FROM leads WHERE lead_code = $${params.length}))`);
    }
    if (typeFilter) {
      params.push(typeFilter);
      // activity_type is CHECK-constrained to lowercase literals
      // ('call','meeting','follow_up','task') and typeFilter is already
      // lowercased, so plain equality is result-identical to LOWER() and
      // keeps the predicate sargable.
      where.push(`sa.activity_type = $${params.length}`);
    }
    if (statusFilter) {
      params.push(statusFilter);
      // status is CHECK-constrained to ('scheduled','completed',
      // 'cancelled') and statusFilter is already lowercased — plain
      // equality is result-identical to LOWER() and sargable, so the
      // status='scheduled' partial index (migration 041) can apply.
      where.push(`sa.status = $${params.length}`);
    }
    if (priorityFilter) {
      params.push(priorityFilter);
      where.push(`UPPER(sa.priority) = UPPER($${params.length})`);
    }
    if (assignedFilter) {
      params.push(assignedFilter.userId);
      // assignedFilter.userId is a server-resolved users.id (canonical
      // uuid). Sargable uuid comparison lets the planner use the
      // scheduled-activity assigned_to index; the ::text cast prevented it.
      where.push(`sa.assigned_to = $${params.length}::uuid`);
    }
    if (fromYmd) {
      params.push(dhakaStartUtc(fromYmd.y, fromYmd.m, fromYmd.d).toISOString());
      where.push(`sa.scheduled_at >= $${params.length}::timestamp`);
    }
    if (toYmd) {
      const next = addCalendarDays(toYmd.y, toYmd.m, toYmd.d, 1);
      params.push(dhakaStartUtc(next.y, next.m, next.d).toISOString());
      where.push(`sa.scheduled_at < $${params.length}::timestamp`);
    }
    // Visibility — ONE combined predicate over the LEFT JOIN:
    //   lead rows: not soft-deleted AND the lead-visibility predicate
    //     (buildDashboardVisibilitySql, identical to the leads list);
    //   lead-less rows (migration 055): the meeting arms
    //     (organiser-in-scope / assignee / attendee).
    // The is_deleted check moved INSIDE the lead arm — on the LEFT
    // JOIN a lead-less row has l.is_deleted NULL, which the old
    // top-level `l.is_deleted = FALSE` would have filtered out.
    const leadVisSql = buildDashboardVisibilitySql(visibility, params);
    const leadlessVisSql = leadlessVisibilitySql(visibility, params, caller, meetingSchema.attendees);
    where.push(`((sa.lead_id IS NOT NULL AND l.is_deleted = FALSE AND ${leadVisSql}) OR (sa.lead_id IS NULL AND ${leadlessVisSql}))`);

    const whereSql = where.join(' AND ');
    const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE ${whereSql}`, params);
    const total = Number(countRes.rows[0]?.cnt || 0);

    params.push(limit, offset);
    const pLimit = params.length - 1;
    const pOffset = params.length;
    const listRes = await pool.query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status,
              l.next_follow_up_at AS lead_next_follow_up_at, l.last_contacted_at AS lead_last_contacted_at,
              l.created_at AS lead_created_at, l.expected_premium AS lead_expected_premium,
              l.custom_fields->>'interestedAmount' AS lead_interested_amount
       FROM scheduled_activities sa
       LEFT JOIN leads l ON l.id = sa.lead_id
       WHERE ${whereSql}
       ORDER BY sa.scheduled_at ASC
       LIMIT $${pLimit} OFFSET $${pOffset}`,
      params
    );
    await attachAttendees(listRes.rows, meetingSchema);
    // Parent-lead quality for the page: two bulk signal queries over the
    // distinct parent leads — never per-row.
    const parentIds = Array.from(
      new Set((listRes.rows || []).map((r: any) => String(r.lead_id || '')))
    ).filter(Boolean);
    const [schedActivity, schedPlanned, schedQualityConfig] = await Promise.all([
      fetchActivityQualitySignals(pool, parentIds),
      fetchScheduledQualitySignals(pool, parentIds),
      // DZ-3: the stored Lead Quality config (code defaults when unset).
      getLeadQualityConfig(),
    ]);
    const items = listRes.rows.map((row: any) => {
      const mapped: any = mapScheduledActivityRow(row);
      const parentKey = String(row.lead_id || '');
      // Lead-less rows have no parent lead to score.
      mapped.leadQuality = row.lead_id ? compactScoreLeadRow(
        {
          id: parentKey,
          current_status: row.lead_current_status,
          next_follow_up_at: row.lead_next_follow_up_at,
          last_contacted_at: row.lead_last_contacted_at,
          created_at: row.lead_created_at,
          expected_premium: row.lead_expected_premium,
          custom_fields: { interestedAmount: row.lead_interested_amount },
        },
        schedActivity.get(parentKey),
        schedPlanned.get(parentKey),
        undefined,
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        schedQualityConfig
      ) : null;
      return mapped;
    });
    return sendJson(res, 200, { success: true, data: items, pagination: { limit, offset, total } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activities fetch failed.' });
  }
});

/* ------------------------------------------------------------------
   GET /scheduled-activities/:id — single item, visibility enforced
------------------------------------------------------------------- */
router.get('/scheduled-activities/:id', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' });

    const visibility = await resolveCallerVisibility(caller);

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const row = (fallbackStore as any).scheduledActivities.find((r: any) => String(r.id) === id);
      if (!row) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (!(row.leadId || row.lead_id)) {
        if (!demoLeadlessVisible(row, visibility, caller)) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
        return sendJson(res, 200, { success: true, data: mapScheduledActivityRow({ ...row }) });
      }
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === String(row.leadId || row.lead_id));
      if (!lead || lead.is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (!isLeadAccessible(
        { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
        visibility,
        caller
      )) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow({ ...row, lead_customer_name: (lead as any).prospectName, lead_mobile: (lead as any).mobile, lead_current_status: (lead as any).currentStatus }) });
    }

    const pool = getPool();
    const meetingSchema = await probeMeetingSchema();
    const r = await pool.query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status,
              l.assigned_to AS lead_assigned_to, l.created_by AS lead_created_by, l.custom_fields AS lead_custom_fields, l.is_deleted AS lead_is_deleted
       FROM scheduled_activities sa
       LEFT JOIN leads l ON l.id = sa.lead_id
       WHERE sa.id = $1 LIMIT 1`,
      [isCanonicalLowerUuid(id) ? id : null]
    );
    if (!r.rows[0]) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    const row = r.rows[0];
    await attachAttendees([row], meetingSchema);
    if (!row.lead_id) {
      const attendeeIds = (row.attendees || []).map((a: any) => String(a.userId));
      if (!isLeadlessVisible(row, attendeeIds, visibility, caller)) {
        return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      }
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(row) });
    }
    if (row.lead_is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    if (!isLeadAccessible({ assigned_to: row.lead_assigned_to, custom_fields: row.lead_custom_fields, created_by: row.lead_created_by }, visibility, caller)) {
      return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    }
    return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(row) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activity fetch failed.' });
  }
});

/* ------------------------------------------------------------------
   POST /scheduled-activities/:id/rsvp — attendee responds
   { response: 'accepted' | 'declined' }. Only an invited attendee
   may respond — everyone else (including users who cannot even see
   the event) gets the same 404 as a missing activity, so the
   endpoint leaks nothing. The organiser never RSVPs to their own
   meeting (clear 400): their attendee row, when listed at all, is
   already 'accepted' by construction.
------------------------------------------------------------------- */
router.post('/scheduled-activities/:id/rsvp', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' });
    const response = String(req.body?.response ?? '').trim().toLowerCase();
    if (response !== 'accepted' && response !== 'declined') {
      return sendJson(res, 400, { success: false, message: `response must be 'accepted' or 'declined'.` });
    }

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const row = (fallbackStore as any).scheduledActivities.find((r: any) => String(r.id) === id);
      if (!row) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (String(row.created_by || row.createdBy || '') === String(caller.id)) {
        return sendJson(res, 400, { success: false, message: 'The organiser does not RSVP to their own meeting.' });
      }
      const mine = (Array.isArray(row.attendees) ? row.attendees : []).find((a: any) => String(a.userId) === String(caller.id));
      if (!mine) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      mine.response = response;
      mine.respondedAt = new Date().toISOString();
      // PR E: tell the organiser (idempotent per response value).
      const responderUser = fallbackStore.users.find((u: any) => String(u.id) === String(caller.id));
      await notifyMeetingRsvp({
        activity: meetingNotifyActivity(row),
        responder: {
          userId: String(caller.id),
          name: (responderUser as any)?.fullName || (responderUser as any)?.name || caller.employee_id,
        },
        response: response as 'accepted' | 'declined',
      });
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow({ ...row }) });
    }

    const pool = getPool();
    const meetingSchema = await probeMeetingSchema();
    if (!meetingSchema.attendees) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    const r = await pool.query(
      `SELECT * FROM scheduled_activities WHERE id = $1 LIMIT 1`,
      [isCanonicalLowerUuid(id) ? id : null]
    );
    if (!r.rows[0]) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    const row = r.rows[0];
    if (String(row.created_by || '') === String(caller.id)) {
      return sendJson(res, 400, { success: false, message: 'The organiser does not RSVP to their own meeting.' });
    }
    const mine = await pool.query(
      `SELECT * FROM scheduled_activity_attendees WHERE activity_id = $1 AND user_id = $2 LIMIT 1`,
      [row.id, caller.id]
    );
    if (!mine.rows[0]) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    await pool.query(
      `UPDATE scheduled_activity_attendees SET response = $1, responded_at = NOW() WHERE activity_id = $2 AND user_id = $3`,
      [response, row.id, caller.id]
    );
    const out = await pool.query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status
       FROM scheduled_activities sa
       LEFT JOIN leads l ON l.id = sa.lead_id
       WHERE sa.id = $1`,
      [row.id]
    );
    const outRow = out.rows[0] || row;
    await attachAttendees([outRow], meetingSchema);
    // PR E: tell the organiser (idempotent per response value — a
    // re-sent answer dedupes, a flipped answer notifies again).
    const myAttendee = (outRow.attendees || []).find((a: any) => String(a.userId) === String(caller.id));
    await notifyMeetingRsvp({
      activity: meetingNotifyActivity(outRow),
      responder: {
        userId: String(caller.id),
        name: myAttendee?.fullName || caller.employee_id,
      },
      response: response as 'accepted' | 'declined',
    });
    return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(outRow) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'RSVP failed.' });
  }
});

/* ------------------------------------------------------------------
   POST /scheduled-activities — create, visibility + validation
------------------------------------------------------------------- */
router.post('/scheduled-activities', requireAuth, async (req: any, res) => {
  const perf = createPerf('scheduled.create');
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.edit'))) {
      perf.span('authz.permission');
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'You do not have permission to schedule activities.' });
    }
    perf.span('authz.permission');

    const body = req.body || {};
    const rawLeadId = body.leadId ?? body.lead_id ?? body.lead_id?.trim?.();
    const rawType = body.activityType ?? body.activity_type;
    const rawAt = body.scheduledAt ?? body.scheduled_at ?? body.scheduled_at;
    const rawTitle = body.title;
    const rawRemarks = body.remarks;
    const rawDuration = body.durationMinutes ?? body.duration_minutes ?? body.duration;
    const rawStatus = body.status;
    const rawPriority = body.priority;
    const rawMeetingType = body.meetingType ?? body.meeting_type;
    const rawLocation = body.location;
    const rawAssignedTo = body.assignedTo ?? body.assigned_to;
    const rawAttendeeIds = body.attendeeIds ?? body.attendee_ids;
    const rawReminder = body.reminderMinutes ?? body.reminder_minutes;

    const leadId = rawLeadId !== undefined && rawLeadId !== null ? String(rawLeadId).trim() : '';
    const activityType = rawType !== undefined && rawType !== null ? String(rawType).trim().toLowerCase() : '';
    const title = rawTitle !== undefined && rawTitle !== null ? String(rawTitle).trim().slice(0, 255) : null;
    const remarks = rawRemarks !== undefined && rawRemarks !== null ? String(rawRemarks).trim() : null;
    const status = rawStatus !== undefined && rawStatus !== null ? String(rawStatus).trim().toLowerCase() : 'scheduled';
    const meetingType = rawMeetingType !== undefined && rawMeetingType !== null ? String(rawMeetingType).trim().slice(0, 255) : null;
    const location = rawLocation !== undefined && rawLocation !== null ? String(rawLocation).trim().slice(0, 255) : null;

    // leadId is OPTIONAL since migration 055 — no lead means a team
    // meeting / standalone task (extra rules enforced below).
    const isLeadless = !leadId;
    if (!activityType || !SCHEDULED_TYPES.includes(activityType as any)) {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: `activityType must be one of ${SCHEDULED_TYPES.join(', ')}.` });
    }
    if (isLeadless && activityType !== 'meeting' && activityType !== 'task') {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: `activityType must be 'meeting' or 'task' for an event without a lead.` });
    }
    if (isLeadless && !title) {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: 'title is required for an event without a lead.' });
    }
    if (!SCHEDULED_STATUSES.includes(status as any) || status !== 'scheduled') {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: `status must be 'scheduled' on create.` });
    }
    let priority: string = 'NORMAL';
    if (rawPriority !== undefined && rawPriority !== null && String(rawPriority).trim() !== '') {
      const p = normalizePriority(rawPriority);
      if (!p) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: `priority must be one of ${SCHEDULED_PRIORITIES.join(', ')}.` });
      }
      priority = p;
    }
    const scheduledAt = parseScheduledAt(rawAt);
    if (!scheduledAt) {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: 'scheduledAt is required and must be a valid ISO timestamp.' });
    }
    let durationMinutes: number | null = null;
    if (rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== '') {
      const n = Number(String(rawDuration).trim());
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1440) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: 'durationMinutes must be an integer between 1 and 1440.' });
      }
      durationMinutes = n;
    }

    // Attendees + reminder (migration 055). Attendee refs resolve to
    // ACTIVE users only — the PR #106 rule (see resolveAttendees).
    let attendeeSet: { userId: string; employeeId: string }[] = [];
    if (rawAttendeeIds !== undefined && rawAttendeeIds !== null) {
      if (!Array.isArray(rawAttendeeIds)) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: 'attendeeIds must be an array.' });
      }
      const resolvedAttendees = await resolveAttendees(rawAttendeeIds);
      if ('error' in resolvedAttendees) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: resolvedAttendees.error });
      }
      attendeeSet = resolvedAttendees.attendees;
    }
    const reminderParsed = parseReminderMinutes(rawReminder);
    if ('error' in reminderParsed) {
      perf.finish(res);
      return sendJson(res, 400, { success: false, message: reminderParsed.error });
    }
    const reminderMinutes: number | null = reminderParsed.value;
    const meetingSchema = await probeMeetingSchema();
    if (useDb() && attendeeSet.length > 0 && !meetingSchema.attendees) {
      perf.finish(res);
      return sendJson(res, 503, { success: false, message: 'Attendees are unavailable until migration 055 has run.' });
    }
    if (useDb() && reminderMinutes !== null && !meetingSchema.reminder) {
      perf.finish(res);
      return sendJson(res, 503, { success: false, message: 'Reminders are unavailable until migration 055 has run.' });
    }

    // Validate lead exists and is visible to caller
    const visibility = await resolveCallerVisibility(caller);
    let leadRow: any = null;
    let assignedToId: string | null = null;
    let requestedAssignee: { userId: string; employeeId: string } | null = null;
    if (rawAssignedTo !== undefined && rawAssignedTo !== null && String(rawAssignedTo).trim() !== '') {
      const resolved = await resolveAssignedTo(String(rawAssignedTo).trim());
      if (!resolved) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: 'assignedTo was not found.' });
      }
      // An EXPLICIT assignee must be active (PR #106 closed this for lead
      // assignment; scheduled activities take the same rule). The default
      // path — inheriting the lead's current owner — is untouched.
      if (!resolved.isActive) {
        perf.finish(res);
        return sendJson(res, 400, { success: false, message: `Assigned user "${String(rawAssignedTo).trim()}" is inactive and cannot be assigned activities.` });
      }
      if (!(await hasPermissionCode(caller, 'leads.assign'))) {
        perf.finish(res);
        return sendJson(res, 403, { success: false, message: 'You do not have permission to reassign activities.' });
      }
      if (!isAssignedToAllowed(resolved, visibility, caller)) {
        perf.finish(res);
        return sendJson(res, 403, { success: false, message: 'You cannot assign to that user (outside your visibility).' });
      }
      requestedAssignee = resolved;
    }
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      let lead: any = null;
      if (!isLeadless) {
        lead = fallbackStore.leads.find((l: any) => String(l.id) === leadId || String((l as any).leadCode) === leadId);
        if (!lead) {
          perf.finish(res);
          return sendJson(res, 404, { success: false, message: 'Lead not found.' });
        }
        if ((lead as any).is_deleted === true) {
          perf.finish(res);
          return sendJson(res, 404, { success: false, message: 'Lead not found.' });
        }
        if (!isLeadAccessible(
          { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
          visibility,
          caller
        )) {
          perf.finish(res);
          return sendJson(res, 404, { success: false, message: 'Lead not found.' });
        }
      }
      // Determine assigned_to: requested assignee, else the lead's
      // owner, else (lead-less) the organiser themselves.
      if (requestedAssignee) {
        const u = fallbackStore.users.find(x => x.employeeId.toUpperCase() === requestedAssignee!.employeeId.toUpperCase() || x.id === requestedAssignee!.userId);
        assignedToId = u ? u.id : (requestedAssignee.userId);
      } else if (lead) {
        const leadAssigneeEmp = String((lead as any).assignedTo || '');
        const u = fallbackStore.users.find(x => x.employeeId.toUpperCase() === leadAssigneeEmp.toUpperCase());
        assignedToId = u ? u.id : null;
      } else {
        assignedToId = caller.id;
      }
      const id = createId('sched');
      const nowIso = new Date().toISOString();
      const entry: any = {
        id,
        leadId: lead ? String((lead as any).id) : null,
        lead_id: lead ? String((lead as any).id) : null,
        activityType,
        activity_type: activityType,
        title: title || null,
        scheduledAt: scheduledAt.toISOString(),
        scheduled_at: scheduledAt.toISOString(),
        durationMinutes,
        duration_minutes: durationMinutes,
        remarks: remarks || null,
        status,
        priority,
        meetingType: meetingType || null,
        meeting_type: meetingType || null,
        location: location || null,
        reminderMinutes,
        reminder_minutes: reminderMinutes,
        attendees: demoAttendeeObjects(attendeeSet, caller.id),
        createdBy: caller.id,
        created_by: caller.id,
        assignedTo: assignedToId ? (fallbackStore.users.find(x=>x.id===assignedToId)?.employeeId || assignedToId) : null,
        assigned_to: assignedToId,
        updatedBy: caller.id,
        updated_by: caller.id,
        createdAt: nowIso,
        created_at: nowIso,
        updatedAt: nowIso,
        updated_at: nowIso,
        completedAt: null,
        completed_at: null,
        completedBy: null,
        completed_by: null,
        completedActivityId: null,
        completed_activity_id: null,
      };
      (entry as any).priority = priority;
      (fallbackStore as any).scheduledActivities.push(entry);
      // PR E: invite the attendees (the organiser is never notified).
      if (attendeeSet.length > 0) {
        await notifyMeetingInvites({
          activity: meetingNotifyActivity(entry, lead ? ((lead as any).prospectName || (lead as any).customerName || null) : null),
          organiserId: String(caller.id),
          attendees: attendeeSet,
        });
      }
      perf.span('db.insert');
      perf.finish(res);
      return sendJson(res, 201, { success: true, data: mapScheduledActivityRow(lead ? { ...entry, lead_customer_name: (lead as any).prospectName, lead_mobile: (lead as any).mobile, lead_current_status: (lead as any).currentStatus } : { ...entry }) });
    }

    const pool = getPool();
    // Resolve lead by id or lead_code, visibility check via isLeadAccessible after fetch
    if (!isLeadless) {
      leadRow = await findLeadByIdRaw(leadId, false);
      if (!leadRow) {
        perf.finish(res);
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      if (leadRow.is_deleted === true) {
        perf.finish(res);
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      if (!isLeadAccessible(leadRow, visibility, caller)) {
        perf.finish(res);
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
    }
    perf.span('lead.visibility');

    if (requestedAssignee) assignedToId = requestedAssignee.userId;
    else if (leadRow) assignedToId = leadRow.assigned_to || null;
    else assignedToId = caller.id; // lead-less default: the organiser owns their meeting

    // Insert + invite rows in ONE transaction (a meeting without its
    // attendees would be a silent half-write). The reminder column is
    // included only when migration 055 has run (probe above).
    const insertColumns = ['lead_id', 'activity_type', 'title', 'scheduled_at', 'duration_minutes', 'remarks', 'status', 'priority', 'meeting_type', 'location', 'created_by', 'assigned_to', 'updated_by'];
    const insertValues: any[] = [leadRow ? leadRow.id : null, activityType, title, scheduledAt.toISOString(), durationMinutes, remarks, status, priority, meetingType, location, caller.id, assignedToId, caller.id];
    if (meetingSchema.reminder) {
      insertColumns.push('reminder_minutes');
      insertValues.push(reminderMinutes);
    }
    const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    const createClient = await pool.connect();
    let insertedRow: any = null;
    try {
      await createClient.query('BEGIN');
      const insertRes = await createClient.query(
        `INSERT INTO scheduled_activities (${insertColumns.join(', ')})
         VALUES (${insertPlaceholders})
         RETURNING *`,
        insertValues
      );
      if (!insertRes.rows[0]) {
        await createClient.query('ROLLBACK');
        perf.finish(res);
        return sendJson(res, 500, { success: false, message: 'Scheduled activity creation failed.' });
      }
      insertedRow = insertRes.rows[0];
      if (meetingSchema.attendees && attendeeSet.length > 0) {
        await insertAttendees(createClient, insertedRow.id, caller.id, attendeeSet);
      }
      await createClient.query('COMMIT');
    } catch (txError) {
      try { await createClient.query('ROLLBACK'); } catch {}
      throw txError;
    } finally {
      try { createClient.release(); } catch {}
    }
    perf.span('db.insert');
    perf.finish(res);
    const out = await pool.query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status
       FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id = $1`,
      [insertedRow.id]
    );
    const outRow = out.rows[0] || insertedRow;
    await attachAttendees([outRow], meetingSchema);
    // PR E: invite the attendees (the organiser is never notified).
    if (attendeeSet.length > 0) {
      await notifyMeetingInvites({
        activity: meetingNotifyActivity(outRow),
        organiserId: String(caller.id),
        attendees: attendeeSet,
      });
    }
    return sendJson(res, 201, { success: true, data: mapScheduledActivityRow(outRow) });
  } catch (error: any) {
    try { createPerf('scheduled.create').finish(res); } catch {}
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activity creation failed.' });
  }
});

/* ------------------------------------------------------------------
   PUT /scheduled-activities/:id — update, visibility + immutability
   Only PENDING/SCHEDULED (status='scheduled') is editable. COMPLETED/
   CANCELLED are immutable (409). Server-derived updated_by.
------------------------------------------------------------------- */
router.put('/scheduled-activities/:id', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.edit'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to update scheduled activities.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' });

    const body = req.body || {};
    const rawType = body.activityType ?? body.activity_type;
    const rawAt = body.scheduledAt ?? body.scheduled_at;
    const rawTitle = body.title;
    const rawRemarks = body.remarks;
    const rawDuration = body.durationMinutes ?? body.duration_minutes ?? body.duration;
    const rawStatus = body.status;
    const rawPriority = body.priority;
    const rawMeetingType = body.meetingType ?? body.meeting_type;
    const rawLocation = body.location;
    const rawAssignedTo = body.assignedTo ?? body.assigned_to;
    const rawAttendeeIds = body.attendeeIds !== undefined ? body.attendeeIds : body.attendee_ids;
    const rawReminder = body.reminderMinutes !== undefined ? body.reminderMinutes : body.reminder_minutes;

    let hasAny = false;
    const patch: any = {};
    // Attendee-set replacement (migration 055): presence of the field
    // means "this is the new set" — retained users keep their RSVP.
    let attendeePatch: { userId: string; employeeId: string }[] | null = null;

    if (rawType !== undefined) {
      const v = String(rawType).trim().toLowerCase();
      if (!SCHEDULED_TYPES.includes(v as any)) return sendJson(res, 400, { success: false, message: `activityType must be one of ${SCHEDULED_TYPES.join(', ')}.` });
      patch.activity_type = v;
      hasAny = true;
    }
    if (rawAt !== undefined) {
      if (rawAt === null || String(rawAt).trim() === '') return sendJson(res, 400, { success: false, message: 'scheduledAt cannot be empty.' });
      const d = parseScheduledAt(rawAt);
      if (!d) return sendJson(res, 400, { success: false, message: 'scheduledAt must be a valid ISO timestamp.' });
      patch.scheduled_at = d.toISOString();
      hasAny = true;
    }
    if (rawTitle !== undefined) {
      patch.title = rawTitle === null ? null : String(rawTitle).trim().slice(0, 255) || null;
      hasAny = true;
    }
    if (rawRemarks !== undefined) {
      patch.remarks = rawRemarks === null ? null : String(rawRemarks).trim() || null;
      hasAny = true;
    }
    if (rawDuration !== undefined) {
      if (rawDuration === null || String(rawDuration).trim() === '') {
        patch.duration_minutes = null;
      } else {
        const n = Number(String(rawDuration).trim());
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1440) {
          return sendJson(res, 400, { success: false, message: 'durationMinutes must be an integer between 1 and 1440.' });
        }
        patch.duration_minutes = n;
      }
      hasAny = true;
    }
    if (rawStatus !== undefined) {
      return sendJson(res, 400, { success: false, message: 'Status cannot be changed via PUT — use complete/cancel endpoints.' });
    }
    if (rawPriority !== undefined) {
      if (rawPriority === null || String(rawPriority).trim() === '') {
        patch.priority = 'NORMAL';
      } else {
        const p = normalizePriority(rawPriority);
        if (!p) return sendJson(res, 400, { success: false, message: `priority must be one of ${SCHEDULED_PRIORITIES.join(', ')}.` });
        patch.priority = p;
      }
      hasAny = true;
    }
    if (rawMeetingType !== undefined) {
      patch.meeting_type = rawMeetingType === null ? null : String(rawMeetingType).trim().slice(0, 255) || null;
      hasAny = true;
    }
    if (rawLocation !== undefined) {
      patch.location = rawLocation === null ? null : String(rawLocation).trim().slice(0, 255) || null;
      hasAny = true;
    }
    if (rawAssignedTo !== undefined) {
      if (rawAssignedTo === null || String(rawAssignedTo).trim() === '') {
        patch.assigned_to = null;
        hasAny = true;
      } else {
        const resolved = await resolveAssignedTo(String(rawAssignedTo).trim());
        if (!resolved) return sendJson(res, 400, { success: false, message: 'assignedTo was not found.' });
        // Same active-only rule for an explicit reassignment (PR #106).
        if (!resolved.isActive) {
          return sendJson(res, 400, { success: false, message: `Assigned user "${String(rawAssignedTo).trim()}" is inactive and cannot be assigned activities.` });
        }
        const visibilityForAssign = await resolveCallerVisibility(caller);
        if (!(await hasPermissionCode(caller, 'leads.assign'))) {
          return sendJson(res, 403, { success: false, message: 'You do not have permission to reassign activities.' });
        }
        if (!isAssignedToAllowed(resolved, visibilityForAssign, caller)) {
          return sendJson(res, 403, { success: false, message: 'You cannot assign to that user (outside your visibility).' });
        }
        patch.assigned_to = resolved.userId;
        hasAny = true;
      }
    }
    if (rawReminder !== undefined) {
      const reminderParsed = parseReminderMinutes(rawReminder);
      if ('error' in reminderParsed) return sendJson(res, 400, { success: false, message: reminderParsed.error });
      patch.reminder_minutes = reminderParsed.value;
      hasAny = true;
    }
    if (rawAttendeeIds !== undefined) {
      if (rawAttendeeIds !== null && !Array.isArray(rawAttendeeIds)) {
        return sendJson(res, 400, { success: false, message: 'attendeeIds must be an array.' });
      }
      const resolvedAttendees = await resolveAttendees(rawAttendeeIds || []);
      if ('error' in resolvedAttendees) return sendJson(res, 400, { success: false, message: resolvedAttendees.error });
      attendeePatch = resolvedAttendees.attendees;
      hasAny = true;
    }
    const meetingSchema = await probeMeetingSchema();
    if (useDb() && attendeePatch !== null && !meetingSchema.attendees) {
      return sendJson(res, 503, { success: false, message: 'Attendees are unavailable until migration 055 has run.' });
    }
    if (useDb() && patch.reminder_minutes !== undefined && !meetingSchema.reminder) {
      return sendJson(res, 503, { success: false, message: 'Reminders are unavailable until migration 055 has run.' });
    }

    if (!hasAny) return sendJson(res, 400, { success: false, message: 'No valid fields to update.' });

    const visibility = await resolveCallerVisibility(caller);

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const idx = (fallbackStore as any).scheduledActivities.findIndex((r: any) => String(r.id) === id);
      if (idx < 0) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      const existing = (fallbackStore as any).scheduledActivities[idx];
      if (String(existing.status).toLowerCase() !== 'scheduled') {
        return sendJson(res, 409, { success: false, message: `Cannot edit a ${existing.status} activity.` });
      }
      const existingLeadRef = existing.leadId || existing.lead_id || null;
      let lead: any = null;
      if (existingLeadRef) {
        lead = fallbackStore.leads.find((l: any) => String(l.id) === String(existingLeadRef));
        if (!lead || (lead as any).is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
        if (!isLeadAccessible(
          { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
          visibility,
          caller
        )) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      } else {
        // Lead-less edit rule: organiser or current assignee only.
        const organiserId = String(existing.created_by || existing.createdBy || '');
        const assigneeUuid = String(existing.assigned_to || '');
        const assigneeEmp = String(existing.assignedTo || existing.assigned_to || '');
        const isOrganiser = organiserId === String(caller.id);
        const isAssignee = assigneeUuid === String(caller.id)
          || (caller.employee_id && assigneeEmp.toUpperCase() === String(caller.employee_id).toUpperCase());
        if (!isOrganiser && !isAssignee) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      }
      const nowIso = new Date().toISOString();
      const updated = { ...existing };
      if (patch.activity_type !== undefined) { updated.activityType = patch.activity_type; updated.activity_type = patch.activity_type; }
      if (patch.scheduled_at !== undefined) { updated.scheduledAt = patch.scheduled_at; updated.scheduled_at = patch.scheduled_at; }
      if (patch.title !== undefined) updated.title = patch.title;
      if (patch.remarks !== undefined) updated.remarks = patch.remarks;
      if (patch.duration_minutes !== undefined) { updated.durationMinutes = patch.duration_minutes; updated.duration_minutes = patch.duration_minutes; }
      if (patch.priority !== undefined) updated.priority = patch.priority;
      if (patch.meeting_type !== undefined) { updated.meetingType = patch.meeting_type; updated.meeting_type = patch.meeting_type; }
      if (patch.location !== undefined) updated.location = patch.location;
      if (patch.reminder_minutes !== undefined) { updated.reminderMinutes = patch.reminder_minutes; updated.reminder_minutes = patch.reminder_minutes; }
      if (attendeePatch !== null) {
        const organiserId = String(existing.created_by || existing.createdBy || '');
        const kept = new Map<string, any>((Array.isArray(existing.attendees) ? existing.attendees : []).map((a: any) => [String(a.userId), a]));
        updated.attendees = demoAttendeeObjects(attendeePatch, organiserId).map((fresh: any) => {
          const prev = kept.get(String(fresh.userId));
          return prev ? { ...fresh, response: prev.response, respondedAt: prev.respondedAt } : fresh;
        });
      }
      if (patch.assigned_to !== undefined) {
        const u = fallbackStore.users.find(x => x.id === patch.assigned_to);
        updated.assignedTo = u ? u.employeeId : patch.assigned_to;
        updated.assigned_to = patch.assigned_to;
      }
      updated.updatedBy = caller.id;
      updated.updated_by = caller.id;
      updated.updatedAt = nowIso;
      updated.updated_at = nowIso;
      (fallbackStore as any).scheduledActivities[idx] = updated;
      // PR E fan-out: gained attendees get an invite; retained
      // attendees get a "moved" notice when the time changed (the
      // just-invited already hold the new time, so they are excluded
      // from "moved").
      {
        const organiserId = String(existing.created_by || existing.createdBy || '');
        const leadName = lead ? ((lead as any).prospectName || (lead as any).customerName || null) : null;
        const oldRecipients = attendeeRecipients(existing.attendees);
        const newRecipients = attendeeRecipients(updated.attendees);
        const oldIds = new Set(oldRecipients.map(a => a.userId));
        const gained = newRecipients.filter(a => !oldIds.has(a.userId));
        const gainedIds = new Set(gained.map(a => a.userId));
        if (gained.length > 0) {
          await notifyMeetingInvites({
            activity: meetingNotifyActivity(updated, leadName),
            organiserId,
            attendees: gained,
          });
        }
        const oldAt = storedTimestampIso(existing.scheduled_at ?? existing.scheduledAt);
        const newAt = storedTimestampIso(updated.scheduled_at ?? updated.scheduledAt);
        if (oldAt && newAt && oldAt !== newAt) {
          const retained = newRecipients.filter(a => !gainedIds.has(a.userId));
          if (retained.length > 0) {
            await notifyMeetingMoved({
              activity: meetingNotifyActivity(updated, leadName),
              organiserId,
              attendees: retained,
            });
          }
        }
      }
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(lead ? { ...updated, lead_customer_name: (lead as any).prospectName, lead_mobile: (lead as any).mobile, lead_current_status: (lead as any).currentStatus } : { ...updated }) });
    }

    // Verify existence and lead visibility before update
    // Sargable PK lookup: the id branch is NULL unless the input is a
    // canonical-lowercase UUID (the only inputs the legacy id::text
    // comparison could match), so malformed ids still 404 unchanged.
    const existingRes = await getPool().query(
      `SELECT sa.*, l.assigned_to AS lead_assigned_to, l.created_by AS lead_created_by, l.custom_fields AS lead_custom_fields, l.is_deleted AS lead_is_deleted
       FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id = $1 LIMIT 1`,
      [isCanonicalLowerUuid(id) ? id : null]
    );
    if (!existingRes.rows[0]) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    const existingRow = existingRes.rows[0];
    if (existingRow.lead_id) {
      if (existingRow.lead_is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (!isLeadAccessible({ assigned_to: existingRow.lead_assigned_to, custom_fields: existingRow.lead_custom_fields, created_by: existingRow.lead_created_by }, visibility, caller)) {
        return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      }
    } else {
      // Lead-less edit rule (migration 055): the organiser
      // (created_by) or the current assignee may edit — nobody else,
      // and invisibility stays a plain 404.
      const isOrganiser = String(existingRow.created_by || '') === String(caller.id);
      const isAssignee = String(existingRow.assigned_to || '') === String(caller.id);
      if (!isOrganiser && !isAssignee) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    }
    if (String(existingRow.status).toLowerCase() !== 'scheduled') {
      return sendJson(res, 409, { success: false, message: `Cannot edit a ${existingRow.status} activity.` });
    }

    // PR E: snapshot the pre-edit attendee set — the notification
    // fan-out after the update diffs it against the post-edit set.
    let oldAttendees: { userId: string; employeeId: string }[] = [];
    if (meetingSchema.attendees) {
      const oldAttendeeMap = await fetchAttendeesByActivity([String(existingRow.id)]);
      oldAttendees = attendeeRecipients(oldAttendeeMap.get(String(existingRow.id)) || []);
    }

    const setClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (patch.activity_type !== undefined) { setClauses.push(`activity_type = $${idx++}`); params.push(patch.activity_type); }
    if (patch.scheduled_at !== undefined) { setClauses.push(`scheduled_at = $${idx++}`); params.push(patch.scheduled_at); }
    if (patch.title !== undefined) { setClauses.push(`title = $${idx++}`); params.push(patch.title); }
    if (patch.remarks !== undefined) { setClauses.push(`remarks = $${idx++}`); params.push(patch.remarks); }
    if (patch.duration_minutes !== undefined) { setClauses.push(`duration_minutes = $${idx++}`); params.push(patch.duration_minutes); }
    if (patch.priority !== undefined) { setClauses.push(`priority = $${idx++}`); params.push(patch.priority); }
    if (patch.meeting_type !== undefined) { setClauses.push(`meeting_type = $${idx++}`); params.push(patch.meeting_type); }
    if (patch.location !== undefined) { setClauses.push(`location = $${idx++}`); params.push(patch.location); }
    if (patch.reminder_minutes !== undefined) { setClauses.push(`reminder_minutes = $${idx++}`); params.push(patch.reminder_minutes); }
    if (patch.assigned_to !== undefined) { setClauses.push(`assigned_to = $${idx++}`); params.push(patch.assigned_to); }
    setClauses.push(`updated_by = $${idx++}`); params.push(caller.id);
    setClauses.push(`updated_at = NOW()`);
    const idParam = idx++;
    params.push(id);
    const sql = `UPDATE scheduled_activities SET ${setClauses.join(', ')} WHERE id::text = $${idParam} RETURNING *`;
    // Field update + attendee replacement commit together.
    const updClient = await getPool().connect();
    let updRow: any = null;
    try {
      await updClient.query('BEGIN');
      const upd = await updClient.query(sql, params);
      if (!upd.rows[0]) {
        await updClient.query('ROLLBACK');
        return sendJson(res, 500, { success: false, message: 'Scheduled activity update failed.' });
      }
      updRow = upd.rows[0];
      if (attendeePatch !== null && meetingSchema.attendees) {
        await replaceAttendees(updClient, updRow.id, String(existingRow.created_by || ''), attendeePatch);
      }
      await updClient.query('COMMIT');
    } catch (txError) {
      try { await updClient.query('ROLLBACK'); } catch {}
      throw txError;
    } finally {
      try { updClient.release(); } catch {}
    }
    const out = await getPool().query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status
       FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id = $1`,
      [updRow.id]
    );
    const outRow = out.rows[0] || updRow;
    await attachAttendees([outRow], meetingSchema);
    // PR E fan-out: gained attendees → invite; retained attendees →
    // "moved" when the time changed (the just-invited already hold
    // the new time, so they are excluded from "moved").
    {
      const organiserId = String(existingRow.created_by || '');
      const finalAttendees = attendeeRecipients(outRow.attendees);
      const oldIds = new Set(oldAttendees.map(a => a.userId));
      const gained = finalAttendees.filter(a => !oldIds.has(a.userId));
      const gainedIds = new Set(gained.map(a => a.userId));
      if (gained.length > 0) {
        await notifyMeetingInvites({
          activity: meetingNotifyActivity(outRow),
          organiserId,
          attendees: gained,
        });
      }
      const oldAt = storedTimestampIso(existingRow.scheduled_at);
      const newAt = storedTimestampIso(outRow.scheduled_at);
      if (patch.scheduled_at !== undefined && oldAt && newAt && oldAt !== newAt) {
        const retained = finalAttendees.filter(a => !gainedIds.has(a.userId));
        if (retained.length > 0) {
          await notifyMeetingMoved({
            activity: meetingNotifyActivity(outRow),
            organiserId,
            attendees: retained,
          });
        }
      }
    }
    return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(outRow) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activity update failed.' });
  }
});

/* ------------------------------------------------------------------
   DELETE /scheduled-activities/:id — hard delete (compatibility)
   Prefer CANCEL for normal business cancellation; DELETE is retained
   but also respects immutability: only scheduled can be hard-deleted.
------------------------------------------------------------------- */
router.delete('/scheduled-activities/:id', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.edit'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to delete scheduled activities.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' });

    const visibility = await resolveCallerVisibility(caller);

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const idx = (fallbackStore as any).scheduledActivities.findIndex((r: any) => String(r.id) === id);
      if (idx < 0) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      const existing = (fallbackStore as any).scheduledActivities[idx];
      if (String(existing.status).toLowerCase() !== 'scheduled') {
        return sendJson(res, 409, { success: false, message: `Cannot delete a ${existing.status} activity — use cancel for pending work.` });
      }
      const delLeadRef = existing.leadId || existing.lead_id || null;
      if (delLeadRef) {
        const lead = fallbackStore.leads.find((l: any) => String(l.id) === String(delLeadRef));
        if (!lead || (lead as any).is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
        if (!isLeadAccessible(
          { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
          visibility,
          caller
        )) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      } else {
        // Lead-less delete rule: organiser or current assignee.
        const organiserId = String(existing.created_by || existing.createdBy || '');
        const assigneeUuid = String(existing.assigned_to || '');
        const assigneeEmp = String(existing.assignedTo || existing.assigned_to || '');
        const isOrganiser = organiserId === String(caller.id);
        const isAssignee = assigneeUuid === String(caller.id)
          || (caller.employee_id && assigneeEmp.toUpperCase() === String(caller.employee_id).toUpperCase());
        if (!isOrganiser && !isAssignee) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      }
      (fallbackStore as any).scheduledActivities.splice(idx, 1);
      return sendJson(res, 200, { success: true, message: 'Scheduled activity deleted.' });
    }

    // Sargable PK lookup (see the update path) — malformed ids still 404.
    const existingRes = await getPool().query(
      `SELECT sa.*, l.assigned_to AS lead_assigned_to, l.created_by AS lead_created_by, l.custom_fields AS lead_custom_fields, l.is_deleted AS lead_is_deleted
       FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id = $1 LIMIT 1`,
      [isCanonicalLowerUuid(id) ? id : null]
    );
    if (!existingRes.rows[0]) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    const row = existingRes.rows[0];
    if (row.lead_id) {
      if (row.lead_is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (!isLeadAccessible({ assigned_to: row.lead_assigned_to, custom_fields: row.lead_custom_fields, created_by: row.lead_created_by }, visibility, caller)) {
        return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      }
    } else {
      // Lead-less delete rule (migration 055): organiser or current
      // assignee — consistent with the edit rule. Attendee rows are
      // removed by the FK cascade.
      const isOrganiser = String(row.created_by || '') === String(caller.id);
      const isAssignee = String(row.assigned_to || '') === String(caller.id);
      if (!isOrganiser && !isAssignee) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
    }
    if (String(row.status).toLowerCase() !== 'scheduled') {
      return sendJson(res, 409, { success: false, message: `Cannot delete a ${row.status} activity — use cancel for pending work.` });
    }
    // Sargable PK delete (existence already verified above); the param is
    // NULL for non-canonical inputs exactly like the legacy text compare.
    await getPool().query(`DELETE FROM scheduled_activities WHERE id = $1`, [isCanonicalLowerUuid(id) ? id : null]);
    return sendJson(res, 200, { success: true, message: 'Scheduled activity deleted.' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activity delete failed.' });
  }
});

/* ------------------------------------------------------------------
   POST /scheduled-activities/:id/complete — atomic completion
   1. lock FOR UPDATE, verify scheduled, verify lead visibility
   2. create ONE lead_activities row (immutable history)
   3. for FOLLOW_UP, reuse canonical follow-up logic if payload
      contains status/remarks/nextFollowUp data (update lead)
   4. mark scheduled COMPLETED with server time/by/activity_id
   5. COMMIT — duplicate complete returns 409 without duplicate row
------------------------------------------------------------------- */
router.post('/scheduled-activities/:id/complete', requireAuth, async (req: any, res) => {
  const perf = createPerf('scheduled.complete');
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) { perf.finish(res); return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' }); }
    if (!(await hasPermissionCode(caller, 'leads.edit'))) { perf.span('authz.permission'); perf.finish(res); return sendJson(res, 403, { success: false, message: 'You do not have permission to complete scheduled activities.' }); }
    perf.span('authz.permission');
    const id = String(req.params.id || '').trim();
    if (!id) { perf.finish(res); return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' }); }
    const body = req.body || {};
    const rawRemarks = body.remarks;
    const rawStatus = body.status ?? body.currentStatus;
    const rawNextFollowUpDate = body.nextFollowUpDate ?? body.next_follow_up_at ?? body.nextFollowUpAt;
    const rawNextCallDate = body.nextCallDate ?? body.next_call_at;
    const rawMeetingDate = body.meetingDate ?? body.meeting_at;
    const rawMeetingType = body.meetingType ?? body.meeting_type;
    const rawCollectedNCP = body.collectedNCP ?? body.collected_ncp;
    const rawProjectedNCP = body.projectedNCP ?? body.projected_ncp;
    const rawSumAssured = body.sumAssured ?? body.sum_assured;
    const rawProductName = body.productName ?? body.product_name;
    const rawLossReason = body.lossReason ?? body.loss_reason;
    const visibility = await resolveCallerVisibility(caller);
    if (!useDb()) {
      if (!demoModeAllowed()) { perf.finish(res); return sendJson(res, 503, { success: false, message: 'Database is not configured.' }); }
      const idx = (fallbackStore as any).scheduledActivities.findIndex((r: any) => String(r.id) === id);
      if (idx < 0) { perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      const sched = (fallbackStore as any).scheduledActivities[idx];
      if (String(sched.status).toLowerCase() !== 'scheduled') { perf.finish(res); return sendJson(res, 409, { success: false, message: `Scheduled activity already ${sched.status}.` }); }
      if (!(sched.leadId || sched.lead_id)) {
        // Lead-less completion (migration 055): mark done — there is
        // no lead history to write and no follow-up side effects.
        if (!demoLeadlessVisible(sched, visibility, caller)) { perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
        const nowIsoLL = new Date().toISOString();
        sched.status = 'completed';
        sched.completedAt = nowIsoLL;
        sched.completed_at = nowIsoLL;
        sched.completedBy = caller.id;
        sched.completed_by = caller.id;
        sched.completedActivityId = null;
        sched.completed_activity_id = null;
        sched.updatedBy = caller.id;
        sched.updated_by = caller.id;
        sched.updatedAt = nowIsoLL;
        sched.updated_at = nowIsoLL;
        // PR E: tell the attendees the event is done.
        await notifyMeetingClosed({
          activity: meetingNotifyActivity(sched),
          organiserId: String(sched.created_by || sched.createdBy || ''),
          attendees: attendeeRecipients(sched.attendees),
          kind: 'completed',
        });
        perf.span('db.complete');
        perf.finish(res);
        return sendJson(res, 200, { success: true, data: { scheduled: mapScheduledActivityRow(sched), activity: null } });
      }
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === String(sched.leadId || sched.lead_id));
      if (!lead || (lead as any).is_deleted === true) { perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      if (!isLeadAccessible(
        { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
        visibility,
        caller
      )) { perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      const nowIso = new Date().toISOString();
      const historyId = createId('activity');
      const isFollowUp = String(sched.activityType || sched.activity_type).toLowerCase() === 'follow_up';
      let statusForHistory = (lead as any).currentStatus || 'Interested';
      let remarksForHistory = rawRemarks !== undefined && rawRemarks !== null ? String(rawRemarks) : (sched.remarks || '');
      if (isFollowUp && rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '') {
        const dict = fallbackStore.options.filter((o: any) => o.type === 'FollowUpStatus' && o.status !== 'Inactive').map((o: any) => o.value);
        if (dict.length > 0 && !dict.includes(String(rawStatus).trim())) { perf.finish(res); return sendJson(res, 400, { success: false, message: `Invalid status "${rawStatus}".` }); }
        statusForHistory = String(rawStatus).trim();
      }
      if (isFollowUp) {
        if (rawStatus !== undefined && String(rawStatus).trim() !== '') (lead as any).currentStatus = statusForHistory;
        if (remarksForHistory !== undefined) (lead as any).notes = remarksForHistory;
        const nfd = rawNextFollowUpDate !== undefined && String(rawNextFollowUpDate).trim() !== '' ? String(rawNextFollowUpDate) : undefined;
        if (nfd !== undefined) { try { new Date(nfd).toISOString(); (lead as any).nextFollowUpDate = nfd; } catch {} }
        (lead as any).lastFollowUpDate = nowIso;
        (lead as any).followUpCount = Number((lead as any).followUpCount || 0) + 1;
        const cf = (lead as any).custom_fields || {};
        if (rawNextCallDate !== undefined) cf.nextCallDate = String(rawNextCallDate);
        if (rawMeetingDate !== undefined) cf.meetingDate = String(rawMeetingDate);
        if (rawMeetingType !== undefined) cf.meetingType = String(rawMeetingType);
        if (rawCollectedNCP !== undefined) cf.collectedNCP = Number(rawCollectedNCP);
        if (rawProjectedNCP !== undefined) cf.projectedNCP = Number(rawProjectedNCP);
        if (rawSumAssured !== undefined) cf.sumAssured = Number(rawSumAssured);
        if (rawProductName !== undefined) cf.productName = String(rawProductName);
        if (rawLossReason !== undefined) cf.lossReason = String(rawLossReason);
        (lead as any).custom_fields = cf;
        const sh = Array.isArray((lead as any).statusHistory) ? (lead as any).statusHistory : [];
        sh.push({ status: statusForHistory, date: nowIso, remarks: remarksForHistory, updatedBy: caller.employee_id });
        (lead as any).statusHistory = sh;
      }
      const activity: any = {
        id: historyId,
        leadId: String(lead.id),
        activityType: isFollowUp ? 'follow_up' : String(sched.activityType || sched.activity_type),
        activity_type: isFollowUp ? 'follow_up' : String(sched.activityType || sched.activity_type),
        status: statusForHistory,
        remarks: remarksForHistory,
        nextFollowUpAt: rawNextFollowUpDate !== undefined ? String(rawNextFollowUpDate) : null,
        next_follow_up_at: rawNextFollowUpDate !== undefined ? String(rawNextFollowUpDate) : null,
        nextCallAt: rawNextCallDate !== undefined ? String(rawNextCallDate) : null,
        next_call_at: rawNextCallDate !== undefined ? String(rawNextCallDate) : null,
        meetingAt: rawMeetingDate !== undefined ? String(rawMeetingDate) : (String(sched.activityType).toLowerCase() === 'meeting' ? sched.scheduledAt || sched.scheduled_at : null),
        meeting_at: rawMeetingDate !== undefined ? String(rawMeetingDate) : (String(sched.activityType).toLowerCase() === 'meeting' ? sched.scheduledAt || sched.scheduled_at : null),
        meetingType: rawMeetingType !== undefined ? String(rawMeetingType) : (sched.meetingType || sched.meeting_type || null),
        meeting_type: rawMeetingType !== undefined ? String(rawMeetingType) : (sched.meetingType || sched.meeting_type || null),
        collectedNcp: rawCollectedNCP !== undefined ? Number(rawCollectedNCP) : null,
        collected_ncp: rawCollectedNCP !== undefined ? Number(rawCollectedNCP) : null,
        projectedNcp: rawProjectedNCP !== undefined ? Number(rawProjectedNCP) : null,
        projected_ncp: rawProjectedNCP !== undefined ? Number(rawProjectedNCP) : null,
        sumAssured: rawSumAssured !== undefined ? Number(rawSumAssured) : null,
        sum_assured: rawSumAssured !== undefined ? Number(rawSumAssured) : null,
        productName: rawProductName !== undefined ? String(rawProductName) : null,
        product_name: rawProductName !== undefined ? String(rawProductName) : null,
        lossReason: rawLossReason !== undefined ? String(rawLossReason) : null,
        loss_reason: rawLossReason !== undefined ? String(rawLossReason) : null,
        createdBy: caller.id,
        created_by: caller.id,
        createdAt: nowIso,
        created_at: nowIso,
      };
      (fallbackStore as any).leadActivities.push(activity);
      sched.status = 'completed';
      sched.completedAt = nowIso;
      sched.completed_at = nowIso;
      sched.completedBy = caller.id;
      sched.completed_by = caller.id;
      sched.completedActivityId = historyId;
      sched.completed_activity_id = historyId;
      sched.updatedBy = caller.id;
      sched.updated_by = caller.id;
      sched.updatedAt = nowIso;
      sched.updated_at = nowIso;
      // Next-step calendar sync (demo mirror of the DB sync below).
      if (isFollowUp) {
        const demoStep = resolveNextStep({
          meetingAt: activity.meetingAt ?? null,
          nextCallAt: activity.nextCallAt ?? null,
          nextFollowUpAt: activity.nextFollowUpAt ?? null,
        });
        syncNextStepAfterFollowUpDemo(fallbackStore as any, {
          leadId: String(lead.id),
          sourceActivityId: String(historyId),
          sourceKind: 'scheduled_complete',
          actorId: caller.id,
          assignedTo: (lead as any).assignedTo ?? null,
          customerName: (lead as any).prospectName || (lead as any).customerName || null,
          nextStepAt: demoStep?.at ?? null,
          kind: demoStep?.kind ?? 'follow_up',
          meetingType: activity.meetingType ?? null,
          remarks: remarksForHistory,
          leadStatusAfter: statusForHistory,
          excludeScheduledId: String(sched.id),
        });
      }
      // PR E: tell the attendees the event is done.
      await notifyMeetingClosed({
        activity: meetingNotifyActivity(sched, (lead as any).prospectName || (lead as any).customerName || null),
        organiserId: String(sched.created_by || sched.createdBy || ''),
        attendees: attendeeRecipients(sched.attendees),
        kind: 'completed',
      });
      perf.span('db.complete');
      perf.finish(res);
      return sendJson(res, 200, { success: true, data: { scheduled: mapScheduledActivityRow(sched), activity: mapActivityRow(activity) } });
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const schedRes = await client.query(
        `SELECT sa.*, l.id AS lead_db_id, l.is_deleted AS lead_is_deleted, l.assigned_to AS lead_assigned_to, l.created_by AS lead_created_by, l.custom_fields AS lead_custom_fields, l.current_status AS lead_current_status
         FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id
         WHERE sa.id = $1 FOR UPDATE OF sa`,
        [isCanonicalLowerUuid(id) ? id : null]
      );
      if (!schedRes.rows[0]) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      const schedRow: any = schedRes.rows[0];
      if (String(schedRow.status).toLowerCase() !== 'scheduled') { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 409, { success: false, message: `Scheduled activity already ${schedRow.status}.` }); }
      if (!schedRow.lead_id) {
        // Lead-less completion (migration 055): visibility via the
        // meeting arms, then a plain status flip — NO lead_activities
        // history row and NO follow-up side effects (there is no lead
        // to write history against).
        const completeSchema = await probeMeetingSchema();
        let completeAttendees: any[] = [];
        if (completeSchema.attendees) {
          const attMap = await fetchAttendeesByActivity([String(schedRow.id)]);
          completeAttendees = attMap.get(String(schedRow.id)) || [];
        }
        if (!isLeadlessVisible(schedRow, completeAttendees.map((a: any) => String(a.userId)), visibility, caller)) {
          await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
        }
        await client.query(`UPDATE scheduled_activities SET status='completed', completed_at=$1, completed_by=$2, completed_activity_id=NULL, updated_by=$2, updated_at=NOW() WHERE id=$3`, [new Date(), caller.id, schedRow.id]);
        await client.query('COMMIT');
        perf.span('db.complete');
        perf.finish(res);
        const schedOutLL = await getPool().query(`SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id=$1`, [schedRow.id]);
        const outRowLL = schedOutLL.rows[0] || schedRow;
        await attachAttendees([outRowLL], completeSchema);
        // PR E: tell the attendees the event is done.
        await notifyMeetingClosed({
          activity: meetingNotifyActivity(outRowLL),
          organiserId: String(schedRow.created_by || ''),
          attendees: attendeeRecipients(outRowLL.attendees),
          kind: 'completed',
        });
        return sendJson(res, 200, { success: true, data: { scheduled: mapScheduledActivityRow(outRowLL), activity: null } });
      }
      if (schedRow.lead_is_deleted === true) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      if (!isLeadAccessible({ assigned_to: schedRow.lead_assigned_to, custom_fields: schedRow.lead_custom_fields, created_by: schedRow.lead_created_by }, visibility, caller)) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      const nowForDb = new Date();
      const nowIso = nowForDb.toISOString();
      const activityType = String(schedRow.activity_type).toLowerCase();
      const isFollowUp = activityType === 'follow_up';
      let statusForHistory = String(schedRow.lead_current_status || 'Interested');
      let remarksForHistory: string | null = schedRow.remarks || null;
      if (isFollowUp) {
        if (rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '') {
          const dict = await getFollowUpStatusValues().catch(() => []);
          const trimmed = String(rawStatus).trim();
          if (dict.length > 0) {
            const matched = dict.find((s: string) => s.toLowerCase() === trimmed.toLowerCase()) || dict.find((s: string) => s === trimmed);
            if (!matched) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 400, { success: false, message: `Invalid status "${rawStatus}".` }); }
            statusForHistory = matched;
          } else {
            statusForHistory = trimmed;
          }
        }
        if (rawRemarks !== undefined && rawRemarks !== null) remarksForHistory = String(rawRemarks).trim() || null;
      } else {
        if (rawRemarks !== undefined && rawRemarks !== null) remarksForHistory = String(rawRemarks).trim() || schedRow.remarks || null;
      }
      const nextFollowUpDateInput = rawNextFollowUpDate !== undefined && rawNextFollowUpDate !== null && String(rawNextFollowUpDate).trim() !== '' ? dateOrNull(String(rawNextFollowUpDate).trim()) : undefined;
      if (rawNextFollowUpDate !== undefined && rawNextFollowUpDate !== null && String(rawNextFollowUpDate).trim() !== '' && nextFollowUpDateInput === null) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 400, { success: false, message: 'Invalid nextFollowUpDate.' }); }
      const nextCallDateInput = rawNextCallDate !== undefined && rawNextCallDate !== null && String(rawNextCallDate).trim() !== '' ? dateOrNull(String(rawNextCallDate).trim()) : undefined;
      if (rawNextCallDate !== undefined && String(rawNextCallDate).trim() !== '' && nextCallDateInput === null) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 400, { success: false, message: 'Invalid nextCallDate.' }); }
      const meetingDateInput = rawMeetingDate !== undefined && String(rawMeetingDate).trim() !== '' ? dateOrNull(String(rawMeetingDate).trim()) : undefined;
      if (rawMeetingDate !== undefined && String(rawMeetingDate).trim() !== '' && meetingDateInput === null) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 400, { success: false, message: 'Invalid meetingDate.' }); }
      if (isFollowUp && (rawStatus !== undefined || rawRemarks !== undefined || nextFollowUpDateInput !== undefined || nextCallDateInput !== undefined || meetingDateInput !== undefined || rawMeetingType !== undefined || rawCollectedNCP !== undefined || rawProjectedNCP !== undefined || rawSumAssured !== undefined || rawProductName !== undefined || rawLossReason !== undefined)) {
        const leadId = schedRow.lead_db_id;
        const leadLock = await client.query(`SELECT * FROM leads WHERE id = $1 FOR UPDATE`, [leadId]);
        const leadRow = leadLock.rows[0];
        if (!leadRow) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 404, { success: false, message: 'Lead not found.' }); }
        const newStatus = rawStatus !== undefined && String(rawStatus).trim() !== '' ? statusForHistory : String(leadRow.current_status || 'Interested');
        const existingHistory: any[] = Array.isArray(leadRow.status_history) ? leadRow.status_history : [];
        const cfExisting: Record<string, any> = leadRow.custom_fields && typeof leadRow.custom_fields === 'object' ? leadRow.custom_fields : {};
        const collectedNCPInput = rawCollectedNCP !== undefined && String(rawCollectedNCP).trim() !== '' ? parseNumeric(rawCollectedNCP) : undefined;
        const projectedNCPInput = rawProjectedNCP !== undefined && String(rawProjectedNCP).trim() !== '' ? parseNumeric(rawProjectedNCP) : undefined;
        const sumAssuredInput = rawSumAssured !== undefined && String(rawSumAssured).trim() !== '' ? parseNumeric(rawSumAssured) : undefined;
        const productNameInput = rawProductName !== undefined && String(rawProductName).trim() !== '' ? String(rawProductName).trim().slice(0,255) : undefined;
        const lossReasonInput = rawLossReason !== undefined && String(rawLossReason).trim() !== '' ? String(rawLossReason).trim() : undefined;
        const meetingTypeInput = rawMeetingType !== undefined && String(rawMeetingType).trim() !== '' ? String(rawMeetingType).trim().slice(0,255) : undefined;
        const historyEntry: Record<string, any> = {
          status: newStatus,
          date: nowIso,
          remarks: remarksForHistory !== null ? remarksForHistory : '',
          nextFollowUpDate: nextFollowUpDateInput !== undefined ? nextFollowUpDateInput! : (leadRow.next_follow_up_at ? new Date(leadRow.next_follow_up_at).toISOString() : undefined),
          nextCallDate: nextCallDateInput !== undefined ? nextCallDateInput! : undefined,
          meetingDate: meetingDateInput !== undefined ? meetingDateInput! : undefined,
          sumAssured: sumAssuredInput !== undefined ? sumAssuredInput! : (leadRow.expected_value != null ? Number(leadRow.expected_value) : undefined),
          productName: productNameInput !== undefined ? productNameInput! : undefined,
          lossReason: lossReasonInput !== undefined ? lossReasonInput! : undefined,
          meetingType: meetingTypeInput !== undefined ? meetingTypeInput! : undefined,
          collectedNCP: collectedNCPInput !== undefined ? collectedNCPInput! : undefined,
          projectedNCP: projectedNCPInput !== undefined ? projectedNCPInput! : undefined,
          updatedBy: caller.employee_id,
          changedBy: caller.employee_id,
        };
        const newHistory = [...existingHistory, historyEntry];
        const newCustomFields: Record<string, any> = { ...(cfExisting || {}) };
        if (nextCallDateInput !== undefined) newCustomFields.nextCallDate = nextCallDateInput;
        if (meetingDateInput !== undefined) newCustomFields.meetingDate = meetingDateInput;
        if (meetingTypeInput !== undefined) newCustomFields.meetingType = meetingTypeInput;
        if (productNameInput !== undefined) newCustomFields.productName = productNameInput;
        if (lossReasonInput !== undefined) newCustomFields.lossReason = lossReasonInput;
        if (collectedNCPInput !== undefined) newCustomFields.collectedNCP = collectedNCPInput;
        if (projectedNCPInput !== undefined) newCustomFields.projectedNCP = projectedNCPInput;
        if (sumAssuredInput !== undefined) newCustomFields.sumAssured = sumAssuredInput;
        const setClauses: string[] = [];
        const params: any[] = [];
        let idx2 = 1;
        if (rawStatus !== undefined && String(rawStatus).trim() !== '') { setClauses.push(`current_status = $${idx2++}`); params.push(newStatus); }
        if (remarksForHistory !== null || rawRemarks !== undefined) { setClauses.push(`notes = $${idx2++}`); params.push(remarksForHistory); }
        if (nextFollowUpDateInput !== undefined) { setClauses.push(`next_follow_up_at = $${idx2++}`); params.push(nextFollowUpDateInput); }
        setClauses.push(`last_contacted_at = $${idx2++}`); params.push(nowForDb);
        if (projectedNCPInput !== undefined) { setClauses.push(`expected_premium = $${idx2++}`); params.push(projectedNCPInput); }
        if (sumAssuredInput !== undefined) { setClauses.push(`expected_value = $${idx2++}`); params.push(sumAssuredInput); }
        setClauses.push(`status_history = $${idx2++}::jsonb`); params.push(JSON.stringify(newHistory));
        setClauses.push(`custom_fields = $${idx2++}::jsonb`); params.push(JSON.stringify(newCustomFields));
        setClauses.push(`updated_by = $${idx2++}`); params.push(caller.id);
        setClauses.push(`updated_at = NOW()`);
        setClauses.push(`follow_up_count = COALESCE(follow_up_count, 0) + 1`);
        const leadIdParamIdx = idx2++; params.push(leadId);
        const updateSql = `UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${leadIdParamIdx} RETURNING *`;
        await client.query(updateSql, params);
        const actInsert = await client.query(
          `INSERT INTO lead_activities
             (lead_id, activity_type, status, remarks, next_follow_up_at, next_call_at, meeting_at, meeting_type, collected_ncp, projected_ncp, sum_assured, product_name, loss_reason, created_by, created_at)
           VALUES ($1, 'follow_up', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [leadId, newStatus, remarksForHistory, nextFollowUpDateInput !== undefined ? nextFollowUpDateInput : null, nextCallDateInput !== undefined ? nextCallDateInput : null, meetingDateInput !== undefined ? meetingDateInput : null, meetingTypeInput !== undefined ? meetingTypeInput : null, collectedNCPInput !== undefined ? collectedNCPInput : null, projectedNCPInput !== undefined ? projectedNCPInput : null, sumAssuredInput !== undefined ? sumAssuredInput : null, productNameInput !== undefined ? productNameInput : null, lossReasonInput !== undefined ? lossReasonInput : null, caller.id, nowForDb]
        );
        if (!actInsert.rows[0]) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 500, { success: false, message: 'Activity insertion failed.' }); }
        const insertedActId = actInsert.rows[0].id;
        await client.query(`UPDATE scheduled_activities SET status='completed', completed_at=$1, completed_by=$2, completed_activity_id=$3, updated_by=$2, updated_at=NOW() WHERE id=$4`, [nowForDb, caller.id, insertedActId, schedRow.id]);
        // Next-step calendar sync (PR A): completing a follow-up with
        // a NEW next step mirrors that step onto the calendar in the
        // same transaction (the row completed above is excluded — the
        // handler already closed it; the sync closes any OTHER open
        // managed entry and upserts the new activity's entry).
        const step = resolveNextStep({
          meetingAt: meetingDateInput ?? null,
          nextCallAt: nextCallDateInput ?? null,
          nextFollowUpAt: nextFollowUpDateInput ?? null,
        });
        await syncNextStepAfterFollowUp(client, {
          leadId: String(leadId),
          sourceActivityId: String(insertedActId),
          sourceKind: 'scheduled_complete',
          actorId: caller.id,
          assignedTo: leadRow.assigned_to ?? null,
          customerName: leadRow.customer_name ?? null,
          nextStepAt: step?.at ?? null,
          kind: step?.kind ?? 'follow_up',
          meetingType: meetingTypeInput ?? null,
          remarks: remarksForHistory,
          leadStatusAfter: newStatus,
          excludeScheduledId: String(schedRow.id),
        });
        await client.query('COMMIT');
        // PR E: tell the attendees the event is done.
        await notifyClosedFromDbRow(schedRow, 'completed', leadRow.customer_name ?? null);
        perf.span('db.complete');
        perf.finish(res);
        const schedOut = await getPool().query(`SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id=$1`, [schedRow.id]);
        const actOut = await getPool().query(`SELECT * FROM lead_activities WHERE id=$1`, [insertedActId]);
        return sendJson(res, 200, { success: true, data: { scheduled: mapScheduledActivityRow(schedOut.rows[0]), activity: mapActivityRow(actOut.rows[0]) } });
      }
      const historyStatus = String(schedRow.lead_current_status || 'Interested');
      const histRemarks = remarksForHistory;
      let meetingAtVal: string | null = null;
      if (activityType === 'meeting' || activityType === 'task') meetingAtVal = schedRow.scheduled_at ? new Date(schedRow.scheduled_at).toISOString() : null;
      else if (meetingDateInput !== undefined) meetingAtVal = meetingDateInput;
      const actInsert2 = await client.query(
        `INSERT INTO lead_activities
           (lead_id, activity_type, status, remarks, next_follow_up_at, next_call_at, meeting_at, meeting_type, collected_ncp, projected_ncp, sum_assured, product_name, loss_reason, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [schedRow.lead_db_id, activityType, historyStatus, histRemarks, null, null, meetingAtVal, schedRow.meeting_type || null, null, null, null, null, null, caller.id, nowForDb]
      );
      if (!actInsert2.rows[0]) { await client.query('ROLLBACK'); perf.finish(res); return sendJson(res, 500, { success: false, message: 'Activity insertion failed.' }); }
      const insertedId2 = actInsert2.rows[0].id;
      await client.query(`UPDATE scheduled_activities SET status='completed', completed_at=$1, completed_by=$2, completed_activity_id=$3, updated_by=$2, updated_at=NOW() WHERE id=$4`, [nowForDb, caller.id, insertedId2, schedRow.id]);
      await client.query('COMMIT');
      // PR E: tell the attendees the event is done.
      await notifyClosedFromDbRow(schedRow, 'completed');
      perf.span('db.complete');
      perf.finish(res);
      const schedOut2 = await getPool().query(`SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id=$1`, [schedRow.id]);
      const actOut2 = await getPool().query(`SELECT * FROM lead_activities WHERE id=$1`, [insertedId2]);
      return sendJson(res, 200, { success: true, data: { scheduled: mapScheduledActivityRow(schedOut2.rows[0]), activity: mapActivityRow(actOut2.rows[0]) } });
    } catch (error: any) {
      try { await client.query('ROLLBACK'); } catch {}
      perf.finish(res);
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Complete failed.' });
    } finally {
      try { client.release(); } catch {}
    }
  } catch (error: any) {
    try { createPerf('scheduled.complete').finish(res); } catch {}
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Complete failed.' });
  }
});

/* ------------------------------------------------------------------
   POST /scheduled-activities/:id/cancel — preserves row, status
   Only scheduled can be cancelled; completed/cancelled are 409.
------------------------------------------------------------------- */
router.post('/scheduled-activities/:id/cancel', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.edit'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to cancel scheduled activities.' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) return sendJson(res, 400, { success: false, message: 'Scheduled activity id is required.' });
    const visibility = await resolveCallerVisibility(caller);
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const idx = (fallbackStore as any).scheduledActivities.findIndex((r: any) => String(r.id) === id);
      if (idx < 0) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      const sched = (fallbackStore as any).scheduledActivities[idx];
      if (String(sched.status).toLowerCase() === 'completed') return sendJson(res, 409, { success: false, message: 'Cannot cancel a completed activity.' });
      if (String(sched.status).toLowerCase() === 'cancelled') return sendJson(res, 409, { success: false, message: 'Scheduled activity already cancelled.' });
      if (!(sched.leadId || sched.lead_id)) {
        // Lead-less cancel (migration 055): visibility via the meeting arms.
        if (!demoLeadlessVisible(sched, visibility, caller)) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
        const nowIsoLL = new Date().toISOString();
        sched.status = 'cancelled';
        sched.updatedBy = caller.id;
        sched.updated_by = caller.id;
        sched.updatedAt = nowIsoLL;
        sched.updated_at = nowIsoLL;
        // PR E: tell the attendees the meeting is off.
        await notifyMeetingClosed({
          activity: meetingNotifyActivity(sched),
          organiserId: String(sched.created_by || sched.createdBy || ''),
          attendees: attendeeRecipients(sched.attendees),
          kind: 'cancelled',
        });
        return sendJson(res, 200, { success: true, data: mapScheduledActivityRow({ ...sched }) });
      }
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === String(sched.leadId || sched.lead_id));
      if (!lead || (lead as any).is_deleted === true) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      if (!isLeadAccessible(
        { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
        visibility,
        caller
      )) return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' });
      const nowIso = new Date().toISOString();
      sched.status = 'cancelled';
      sched.updatedBy = caller.id;
      sched.updated_by = caller.id;
      sched.updatedAt = nowIso;
      sched.updated_at = nowIso;
      // PR E: tell the attendees the meeting is off.
      await notifyMeetingClosed({
        activity: meetingNotifyActivity(sched, (lead as any).prospectName || (lead as any).customerName || null),
        organiserId: String(sched.created_by || sched.createdBy || ''),
        attendees: attendeeRecipients(sched.attendees),
        kind: 'cancelled',
      });
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow({ ...sched, lead_customer_name: (lead as any).prospectName, lead_mobile: (lead as any).mobile, lead_current_status: (lead as any).currentStatus }) });
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT sa.*, l.is_deleted AS lead_is_deleted, l.assigned_to AS lead_assigned_to, l.created_by AS lead_created_by, l.custom_fields AS lead_custom_fields, l.customer_name AS lead_customer_name
         FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id
         WHERE sa.id = $1 FOR UPDATE OF sa`,
        [isCanonicalLowerUuid(id) ? id : null]
      );
      if (!r.rows[0]) { await client.query('ROLLBACK'); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      const row = r.rows[0];
      // PR E: the attendee set drives both the lead-less visibility
      // arms below and the cancellation fan-out after commit.
      const cancelSchema = await probeMeetingSchema();
      let cancelAttendees: any[] = [];
      if (cancelSchema.attendees) {
        const attMap = await fetchAttendeesByActivity([String(row.id)]);
        cancelAttendees = attMap.get(String(row.id)) || [];
      }
      if (row.lead_id) {
        if (row.lead_is_deleted === true) { await client.query('ROLLBACK'); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
        if (!isLeadAccessible({ assigned_to: row.lead_assigned_to, custom_fields: row.lead_custom_fields, created_by: row.lead_created_by }, visibility, caller)) { await client.query('ROLLBACK'); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      } else {
        // Lead-less cancel (migration 055): visibility via the meeting arms.
        if (!isLeadlessVisible(row, cancelAttendees.map((a: any) => String(a.userId)), visibility, caller)) { await client.query('ROLLBACK'); return sendJson(res, 404, { success: false, message: 'Scheduled activity not found.' }); }
      }
      if (String(row.status).toLowerCase() === 'completed') { await client.query('ROLLBACK'); return sendJson(res, 409, { success: false, message: 'Cannot cancel a completed activity.' }); }
      if (String(row.status).toLowerCase() === 'cancelled') { await client.query('ROLLBACK'); return sendJson(res, 409, { success: false, message: 'Scheduled activity already cancelled.' }); }
      await client.query(`UPDATE scheduled_activities SET status='cancelled', updated_by=$1, updated_at=NOW() WHERE id=$2`, [caller.id, row.id]);
      await client.query('COMMIT');
      // PR E: tell the attendees the meeting is off.
      await notifyMeetingClosed({
        activity: meetingNotifyActivity(row),
        organiserId: String(row.created_by || ''),
        attendees: attendeeRecipients(cancelAttendees),
        kind: 'cancelled',
      });
      const out = await getPool().query(`SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE sa.id=$1`, [row.id]);
      return sendJson(res, 200, { success: true, data: mapScheduledActivityRow(out.rows[0]) });
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      return sendJson(res, dbErrorStatus(e), { success: false, message: e?.message || 'Cancel failed.' });
    } finally {
      try { client.release(); } catch {}
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Cancel failed.' });
  }
});

export default router;
