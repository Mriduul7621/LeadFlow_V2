/**
 * MeetingNotificationService — meeting invites, RSVP alerts, change
 * notices and the per-meeting reminder runner (calendar upgrade PR E).
 * ------------------------------------------------------------------
 * Everything the meeting data model (migration 055) deliberately
 * left out: telling people about meetings. Four event families, all
 * delivered as IN-APP notifications through the shared idempotency
 * machinery (migration 040 — the SLA pattern), each followed by a
 * best-effort Web Push attempt when the recipient has a subscription
 * (PushReminderService.sendPushToUser). NO email exists anywhere in
 * this app and none is added here.
 *
 *   meeting-invited    a NEW attendee is added (create, or an edit
 *                      whose attendee set GAINS them). The organiser
 *                      is never notified about their own meeting, and
 *                      the assignee alone does not count as invited —
 *                      only actual new attendees are.
 *   meeting-moved      an edit changes scheduled_at: every CURRENT
 *                      attendee (except the organiser, and except
 *                      anyone invited by that same edit — they just
 *                      got the invite with the new time) is told the
 *                      new time.
 *   meeting-cancelled / meeting-completed
 *                      the event leaves 'scheduled': attendees (except
 *                      the organiser) are told, so nobody travels to
 *                      a meeting that is off.
 *   meeting-rsvp       an attendee responds: the organiser is told
 *                      "<name> accepted/declined: <title>".
 *   meeting-reminder   the runner below, fired by an external
 *                      scheduler every ~15 minutes (see the cron
 *                      endpoint in notifications.routes.ts and
 *                      docs/PRODUCTION_READINESS.md §3.1).
 *
 * IDEMPOTENCY: every key is buildIdempotencyKey(event, activityId,
 * recipient, version) with the version derived from the meeting's
 * scheduled_at (stored-UTC ISO) — or, for RSVP, the response itself.
 * Replays and overlapping edits therefore never double-notify, a
 * rescheduled meeting re-arms under its new time, and a changed RSVP
 * answer notifies again while the same answer re-sent does not.
 *
 * FAILURE POLICY: notifications are a fan-out AFTER the business
 * mutation has committed, so a notification failure must never fail
 * the request (the mutation is already durable; erroring would invite
 * a duplicate-creating retry). Every entry point swallows errors with
 * a log line. Demo mode mirrors the same events into
 * fallbackStore.notifications, like the assignment/SLA services.
 */

import { getPool } from '../database/connection.js';
import { createId, fallbackStore } from '../fallbackStore.js';
import { storedTimestampIso, BUSINESS_TIMEZONE } from '../utils/businessTime.js';
import { useDb } from '../routes/production/shared.js';
import {
  buildIdempotencyKey,
  insertNotificationWithIdempotency,
} from './NotificationService.js';
import { getNotificationSettings } from './NotificationSettingsService.js';
import { sendPushToUser, type PushToUserSummary } from './PushReminderService.js';

export const MEETING_INVITED_EVENT = 'meeting-invited';
export const MEETING_MOVED_EVENT = 'meeting-moved';
export const MEETING_CANCELLED_EVENT = 'meeting-cancelled';
export const MEETING_COMPLETED_EVENT = 'meeting-completed';
export const MEETING_RSVP_EVENT = 'meeting-rsvp';
export const MEETING_REMINDER_EVENT = 'meeting-reminder';

/** Where a tapped meeting push lands — the Task Calendar (PR D). */
export const MEETING_CALENDAR_URL = '/task-calendar';

/** Reminder scan window: a ~15-minute scheduler cadence must never
 *  miss a due reminder, so each run looks 20 minutes back. */
export const REMINDER_WINDOW_MINUTES = 20;

/* ====================================================================
   Pure helpers (exported for tests)
==================================================================== */

const dhakaDateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/**
 * Render a stored timestamp the way a Dhaka user reads it, e.g.
 * "Tue, 10 Mar 2027, 10:00 am". Input follows the stored-UTC
 * convention (storedTimestampIso) so the answer is identical in
 * every server process timezone. Null for unparseable input.
 */
export function formatDhakaDateTime(value: unknown): string | null {
  const iso = storedTimestampIso(value);
  if (!iso) return null;
  return dhakaDateTimeFormat.format(new Date(iso));
}

export interface MeetingActivityRef {
  id: string;
  title?: string | null;
  activityType?: string | null;
  /** ISO instant of the meeting start (stored-UTC convention). */
  scheduledAt?: string | null;
  leadCustomerName?: string | null;
  /** users.id of the organiser (scheduled_activities.created_by). */
  createdBy?: string | null;
}

/** The name a notification shows for an activity. */
export function meetingDisplayTitle(activity: MeetingActivityRef): string {
  const title = String(activity.title || '').trim();
  if (title) return title;
  const customer = String(activity.leadCustomerName || '').trim();
  if (customer) return `Meeting with ${customer}`;
  switch (String(activity.activityType || '').toLowerCase()) {
    case 'task': return 'Task';
    case 'call': return 'Call';
    case 'follow_up': return 'Follow-up';
    default: return 'Meeting';
  }
}

function whenText(activity: MeetingActivityRef): string {
  return formatDhakaDateTime(activity.scheduledAt) || '';
}

function keyVersion(activity: MeetingActivityRef): string {
  return storedTimestampIso(activity.scheduledAt) || 'unscheduled';
}

/* ====================================================================
   Delivery core — one notification (+ push attempt), idempotent
==================================================================== */

export interface MeetingRecipient {
  userId: string;
  employeeId: string;
}

interface DeliverOutcome {
  created: boolean;
  push: PushToUserSummary | null;
}

async function deliver(opts: {
  recipient: MeetingRecipient;
  title: string;
  message: string;
  eventType: string;
  idempotencyKey: string;
  activityId: string;
}): Promise<DeliverOutcome> {
  let created = false;
  if (!useDb()) {
    const store = fallbackStore as any;
    if (!Array.isArray(store.notifications)) store.notifications = [];
    const existingKeys = new Set(
      store.notifications.map((n: any) => n.idempotencyKey).filter(Boolean)
    );
    if (!existingKeys.has(opts.idempotencyKey)) {
      store.notifications.push({
        id: createId('notification'),
        userId: opts.recipient.userId,
        title: opts.title,
        message: opts.message,
        leadId: opts.activityId,
        read: false,
        date: new Date().toISOString(),
        eventType: opts.eventType,
        idempotencyKey: opts.idempotencyKey,
      });
      created = true;
    }
  } else {
    const row = await insertNotificationWithIdempotency(getPool(), {
      userId: opts.recipient.userId,
      recipientKey: opts.recipient.employeeId || opts.recipient.userId,
      title: opts.title,
      message: opts.message,
      eventType: opts.eventType,
      idempotencyKey: opts.idempotencyKey,
      leadId: opts.activityId,
      referenceType: 'scheduled_activity',
    });
    created = row !== null;
  }
  if (!created) return { created: false, push: null };
  // Push is strictly best-effort: the in-app row above is the record.
  let push: PushToUserSummary | null = null;
  try {
    push = await sendPushToUser(opts.recipient.userId, {
      title: opts.title,
      body: opts.message,
      url: MEETING_CALENDAR_URL,
    });
  } catch (error: any) {
    console.warn(
      `[meeting-notifications] push attempt failed for user ${opts.recipient.userId}: ${error?.message || 'unknown error'}`
    );
  }
  return { created: true, push };
}

export interface MeetingFanoutSummary {
  created: number;
  skipped: number;
}

const EMPTY_FANOUT: MeetingFanoutSummary = { created: 0, skipped: 0 };

/**
 * DZ-2 (audit §4, L2): the meeting-notifications toggle. One read per
 * fan-out call; getNotificationSettings fails ON, so a missing or
 * unreadable row keeps today's behaviour. Demo mode reads the same
 * value from the fallback store through the same service.
 */
async function meetingNotificationsOn(): Promise<boolean> {
  try {
    return (await getNotificationSettings()).meetingNotifications;
  } catch {
    return true;
  }
}

/* ====================================================================
   Fan-outs (called by the scheduled-activity route handlers AFTER
   the business mutation commits; they never throw)
==================================================================== */

/**
 * Invite notifications for NEW attendees (create, or the gained set
 * of an edit). The organiser is excluded even when listed — their own
 * attendee row is 'accepted' by construction and they must not be
 * notified about their own meeting.
 */
export async function notifyMeetingInvites(opts: {
  activity: MeetingActivityRef;
  organiserId: string;
  attendees: MeetingRecipient[];
}): Promise<MeetingFanoutSummary> {
  const summary = { ...EMPTY_FANOUT };
  if (!(await meetingNotificationsOn())) return summary;
  try {
    const title = meetingDisplayTitle(opts.activity);
    const when = whenText(opts.activity);
    const message = when
      ? `You are invited: ${title} — ${when}.`
      : `You are invited: ${title}.`;
    for (const attendee of opts.attendees || []) {
      if (!attendee.userId || String(attendee.userId) === String(opts.organiserId)) {
        summary.skipped++;
        continue;
      }
      const outcome = await deliver({
        recipient: attendee,
        title: 'Meeting Invitation',
        message,
        eventType: MEETING_INVITED_EVENT,
        idempotencyKey: buildIdempotencyKey(
          MEETING_INVITED_EVENT, opts.activity.id, attendee.userId, keyVersion(opts.activity)
        ),
        activityId: opts.activity.id,
      });
      if (outcome.created) summary.created++;
      else summary.skipped++;
    }
  } catch (error: any) {
    console.warn(`[meeting-notifications] invite fan-out failed for activity ${opts.activity.id}: ${error?.message || 'unknown error'}`);
  }
  return summary;
}

/**
 * "Meeting moved" for the CURRENT attendee set after a time change.
 * The key versions on the NEW scheduled_at, so each distinct move
 * notifies exactly once. Callers pass retained attendees only —
 * anyone invited by the same edit already holds the new time.
 */
export async function notifyMeetingMoved(opts: {
  activity: MeetingActivityRef;
  organiserId: string;
  attendees: MeetingRecipient[];
}): Promise<MeetingFanoutSummary> {
  const summary = { ...EMPTY_FANOUT };
  if (!(await meetingNotificationsOn())) return summary;
  try {
    const title = meetingDisplayTitle(opts.activity);
    const when = whenText(opts.activity);
    const message = when
      ? `Meeting moved: ${title} — new time ${when}.`
      : `Meeting moved: ${title}.`;
    for (const attendee of opts.attendees || []) {
      if (!attendee.userId || String(attendee.userId) === String(opts.organiserId)) {
        summary.skipped++;
        continue;
      }
      const outcome = await deliver({
        recipient: attendee,
        title: 'Meeting Moved',
        message,
        eventType: MEETING_MOVED_EVENT,
        idempotencyKey: buildIdempotencyKey(
          MEETING_MOVED_EVENT, opts.activity.id, attendee.userId, keyVersion(opts.activity)
        ),
        activityId: opts.activity.id,
      });
      if (outcome.created) summary.created++;
      else summary.skipped++;
    }
  } catch (error: any) {
    console.warn(`[meeting-notifications] moved fan-out failed for activity ${opts.activity.id}: ${error?.message || 'unknown error'}`);
  }
  return summary;
}

/**
 * Cancellation / completion notice to the attendees (organiser
 * excluded — they performed the action). The key versions on the
 * scheduled_at the event had, so the notice fires once per scheduled
 * incarnation of the event.
 */
export async function notifyMeetingClosed(opts: {
  activity: MeetingActivityRef;
  organiserId: string;
  attendees: MeetingRecipient[];
  kind: 'cancelled' | 'completed';
}): Promise<MeetingFanoutSummary> {
  const summary = { ...EMPTY_FANOUT };
  if (!(await meetingNotificationsOn())) return summary;
  try {
    const title = meetingDisplayTitle(opts.activity);
    const when = whenText(opts.activity);
    const cancelled = opts.kind === 'cancelled';
    const eventType = cancelled ? MEETING_CANCELLED_EVENT : MEETING_COMPLETED_EVENT;
    const message = when
      ? `${cancelled ? 'Meeting cancelled' : 'Meeting completed'}: ${title} — was scheduled for ${when}.`
      : `${cancelled ? 'Meeting cancelled' : 'Meeting completed'}: ${title}.`;
    for (const attendee of opts.attendees || []) {
      if (!attendee.userId || String(attendee.userId) === String(opts.organiserId)) {
        summary.skipped++;
        continue;
      }
      const outcome = await deliver({
        recipient: attendee,
        title: cancelled ? 'Meeting Cancelled' : 'Meeting Completed',
        message,
        eventType,
        idempotencyKey: buildIdempotencyKey(
          eventType, opts.activity.id, attendee.userId, keyVersion(opts.activity)
        ),
        activityId: opts.activity.id,
      });
      if (outcome.created) summary.created++;
      else summary.skipped++;
    }
  } catch (error: any) {
    console.warn(`[meeting-notifications] closed fan-out failed for activity ${opts.activity.id}: ${error?.message || 'unknown error'}`);
  }
  return summary;
}

/**
 * RSVP notice to the organiser: "<name> accepted: <title>". The key
 * is (event, activity, RESPONDER, response) — re-sending the same
 * response is deduped, flipping the answer notifies again.
 */
export async function notifyMeetingRsvp(opts: {
  activity: MeetingActivityRef;
  responder: { userId: string; name: string };
  response: 'accepted' | 'declined';
}): Promise<MeetingFanoutSummary> {
  const summary = { ...EMPTY_FANOUT };
  if (!(await meetingNotificationsOn())) return summary;
  try {
    const organiserId = opts.activity.createdBy ? String(opts.activity.createdBy) : '';
    if (!organiserId || organiserId === String(opts.responder.userId)) {
      summary.skipped++;
      return summary;
    }
    // The organiser's employee id (the notification recipient_key).
    let organiser: MeetingRecipient | null = null;
    if (!useDb()) {
      const user = (fallbackStore.users as any[]).find(u => String(u.id) === organiserId);
      if (user) organiser = { userId: organiserId, employeeId: String(user.employeeId || '') };
    } else {
      const result = await getPool().query(
        `SELECT employee_id FROM users WHERE id = $1 LIMIT 1`,
        [organiserId]
      );
      if (result.rows[0]) {
        organiser = { userId: organiserId, employeeId: String(result.rows[0].employee_id || '') };
      }
    }
    if (!organiser) {
      summary.skipped++;
      return summary;
    }
    const outcome = await deliver({
      recipient: organiser,
      title: 'Meeting RSVP',
      message: `${opts.responder.name} ${opts.response}: ${meetingDisplayTitle(opts.activity)}`,
      eventType: MEETING_RSVP_EVENT,
      idempotencyKey: buildIdempotencyKey(
        MEETING_RSVP_EVENT, opts.activity.id, opts.responder.userId, opts.response
      ),
      activityId: opts.activity.id,
    });
    if (outcome.created) summary.created++;
    else summary.skipped++;
  } catch (error: any) {
    console.warn(`[meeting-notifications] rsvp fan-out failed for activity ${opts.activity.id}: ${error?.message || 'unknown error'}`);
  }
  return summary;
}

/* ====================================================================
   Reminder runner — fired by the cron-secret endpoint every ~15 min
==================================================================== */

export interface MeetingReminderRunSummary {
  /** Activities whose reminder fell due inside the scan window. */
  scanned: number;
  /** (activity, recipient) pairs considered. */
  recipients: number;
  /** Reminder notifications actually created. */
  notified: number;
  /** Pairs skipped because this run (or an earlier one) already sent. */
  deduped: number;
  pushSent: number;
  pushPruned: number;
  pushFailed: number;
}

const EMPTY_RUN: MeetingReminderRunSummary = {
  scanned: 0, recipients: 0, notified: 0, deduped: 0,
  pushSent: 0, pushPruned: 0, pushFailed: 0,
};

interface DueActivity {
  activity: MeetingActivityRef;
  recipientIds: string[];
}

function accumulatePush(summary: MeetingReminderRunSummary, push: PushToUserSummary | null): void {
  if (!push) return;
  summary.pushSent += push.sent;
  summary.pushPruned += push.pruned;
  summary.pushFailed += push.failed;
}

async function findDueActivitiesDb(now: Date): Promise<DueActivity[]> {
  const windowStart = new Date(now.getTime() - REMINDER_WINDOW_MINUTES * 60 * 1000);
  // Due instant = scheduled_at − reminder_minutes, in the stored-UTC
  // convention. Window is (now − 20 min, now]: strictly after the
  // window start so a reminder is never picked up twice by window
  // overlap alone (the idempotency key is the real dedupe regardless).
  let rows: any[] = [];
  try {
    const result = await getPool().query(
      `SELECT sa.id, sa.title, sa.activity_type, sa.scheduled_at, sa.reminder_minutes,
              sa.created_by, sa.assigned_to, l.customer_name AS lead_customer_name
       FROM scheduled_activities sa
       LEFT JOIN leads l ON l.id = sa.lead_id
       WHERE sa.status = 'scheduled'
         AND sa.reminder_minutes IS NOT NULL
         AND sa.scheduled_at - (sa.reminder_minutes * INTERVAL '1 minute') > $1::timestamp
         AND sa.scheduled_at - (sa.reminder_minutes * INTERVAL '1 minute') <= $2::timestamp
       ORDER BY sa.scheduled_at ASC`,
      [windowStart.toISOString(), now.toISOString()]
    );
    rows = result.rows || [];
  } catch (error: any) {
    // Pre-055 schema (no reminder_minutes / attendees yet): nothing
    // can be due — the runner stays a clean no-op, never an error.
    console.warn(`[meeting-reminders] due-scan unavailable: ${error?.message || 'unknown error'}`);
    return [];
  }
  if (rows.length === 0) return [];

  // Attendees for the whole page in ONE query (never per-row).
  const attendeeMap = new Map<string, { userId: string; response: string }[]>();
  try {
    const att = await getPool().query(
      `SELECT activity_id, user_id, response FROM scheduled_activity_attendees
       WHERE activity_id = ANY($1::uuid[])`,
      [rows.map(r => String(r.id))]
    );
    for (const row of att.rows || []) {
      const key = String(row.activity_id);
      if (!attendeeMap.has(key)) attendeeMap.set(key, []);
      attendeeMap.get(key)!.push({ userId: String(row.user_id), response: String(row.response || 'pending') });
    }
  } catch {
    // Attendees table missing on a pre-055 schema — organiser +
    // assignee reminders still work.
  }

  return rows.map((row: any) => {
    const recipientIds = new Set<string>();
    if (row.created_by) recipientIds.add(String(row.created_by));
    if (row.assigned_to) recipientIds.add(String(row.assigned_to));
    for (const attendee of attendeeMap.get(String(row.id)) || []) {
      if (attendee.response !== 'declined') recipientIds.add(attendee.userId);
    }
    return {
      activity: {
        id: String(row.id),
        title: row.title ?? null,
        activityType: row.activity_type ?? null,
        scheduledAt: storedTimestampIso(row.scheduled_at),
        leadCustomerName: row.lead_customer_name ?? null,
        createdBy: row.created_by ? String(row.created_by) : null,
      },
      recipientIds: [...recipientIds],
    };
  });
}

function findDueActivitiesDemo(now: Date): DueActivity[] {
  const windowStartMs = now.getTime() - REMINDER_WINDOW_MINUTES * 60 * 1000;
  const out: DueActivity[] = [];
  for (const entry of (fallbackStore as any).scheduledActivities || []) {
    if (String(entry.status || '').toLowerCase() !== 'scheduled') continue;
    const reminder = entry.reminderMinutes ?? entry.reminder_minutes;
    if (reminder === null || reminder === undefined) continue;
    const startMs = new Date(entry.scheduledAt || entry.scheduled_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const dueMs = startMs - Number(reminder) * 60 * 1000;
    if (!(dueMs > windowStartMs && dueMs <= now.getTime())) continue;
    const recipientIds = new Set<string>();
    const organiserId = entry.created_by || entry.createdBy || null;
    if (organiserId) recipientIds.add(String(organiserId));
    if (entry.assigned_to) recipientIds.add(String(entry.assigned_to));
    for (const attendee of Array.isArray(entry.attendees) ? entry.attendees : []) {
      if (String(attendee.response || 'pending') !== 'declined') {
        recipientIds.add(String(attendee.userId));
      }
    }
    out.push({
      activity: {
        id: String(entry.id),
        title: entry.title ?? null,
        activityType: entry.activityType || entry.activity_type || null,
        scheduledAt: storedTimestampIso(entry.scheduledAt || entry.scheduled_at),
        leadCustomerName: null,
        createdBy: organiserId ? String(organiserId) : null,
      },
      recipientIds: [...recipientIds],
    });
  }
  return out;
}

/** Resolve employee ids for the DB recipient_key in ONE query. */
async function resolveEmployeeIds(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return map;
  if (!useDb()) {
    for (const user of fallbackStore.users as any[]) {
      if (ids.includes(String(user.id))) {
        map.set(String(user.id), String(user.employeeId || ''));
      }
    }
    return map;
  }
  const result = await getPool().query(
    `SELECT id, employee_id FROM users WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  for (const row of result.rows || []) {
    map.set(String(row.id), String(row.employee_id || ''));
  }
  return map;
}

/**
 * One reminder pass: every still-scheduled activity whose
 * (scheduled_at − reminder_minutes) fell due in the last
 * REMINDER_WINDOW_MINUTES gets ONE reminder per recipient —
 * organiser, assignee and non-declined attendees, deduplicated.
 * Idempotent: the key versions on scheduled_at, so a second run
 * sends nothing and a RESCHEDULED meeting re-arms under its new
 * time. Cancelled/completed events are never selected
 * (status='scheduled' only). Individual failures are logged,
 * never fatal to the run.
 */
export async function runMeetingReminders(now: Date = new Date()): Promise<MeetingReminderRunSummary> {
  const summary: MeetingReminderRunSummary = { ...EMPTY_RUN };
  if (!(await meetingNotificationsOn())) return summary;
  const due = useDb() ? await findDueActivitiesDb(now) : findDueActivitiesDemo(now);
  summary.scanned = due.length;
  if (due.length === 0) return summary;

  const employeeIds = await resolveEmployeeIds(due.flatMap(d => d.recipientIds));
  for (const item of due) {
    const title = meetingDisplayTitle(item.activity);
    const when = whenText(item.activity);
    const message = when
      ? `Reminder: ${title} starts at ${when}.`
      : `Reminder: ${title}.`;
    for (const userId of item.recipientIds) {
      summary.recipients++;
      try {
        const outcome = await deliver({
          recipient: { userId, employeeId: employeeIds.get(userId) || '' },
          title: 'Meeting Reminder',
          message,
          eventType: MEETING_REMINDER_EVENT,
          idempotencyKey: buildIdempotencyKey(
            MEETING_REMINDER_EVENT, item.activity.id, userId, keyVersion(item.activity)
          ),
          activityId: item.activity.id,
        });
        if (outcome.created) {
          summary.notified++;
          accumulatePush(summary, outcome.push);
        } else {
          summary.deduped++;
        }
      } catch (error: any) {
        console.warn(
          `[meeting-reminders] reminder failed for activity ${item.activity.id} / user ${userId}: ${error?.message || 'unknown error'}`
        );
      }
    }
  }

  console.log(
    `[meeting-reminders] run complete: scanned=${summary.scanned} recipients=${summary.recipients} ` +
    `notified=${summary.notified} deduped=${summary.deduped} pushSent=${summary.pushSent}`
  );
  return summary;
}
