/**
 * NotificationSettingsService — real, persisted notification toggles
 * (Admin Control programme, DZ-1 "Honest Settings", DZ-2 split).
 * ------------------------------------------------------------------
 * The Settings → Push Intelligence card used to be a hardcoded array
 * with `enabled: true` on every row — it stored nothing and gated
 * nothing (audit item L5). DZ-1 backed two of its rows with real
 * settings; DZ-2 (audit §4) splits the assignment toggle in two and
 * adds the meeting toggle, so every row now maps to one behaviour:
 *
 *   assigneeAlerts  — NotificationService notifies the assignee.
 *   uplineAlerts    — NotificationService notifies upline managers.
 *   meetingNotifications — MeetingNotificationService fan-outs
 *                       (invite/moved/cancelled/completed/RSVP/
 *                       reminder) create nothing when OFF.
 *   dailyPushSummary  — PushReminderService.runDailyPushReminders
 *                       sends no digest pushes when OFF. (The SLA
 *                       breach rider on the same morning run has its
 *                       own switch and is NOT gated by this toggle.)
 *
 * DZ-1 stored one combined `assignmentAlerts` row. DZ-2 keeps that row
 * as a migration fallback only: a split key with no row of its own
 * inherits the legacy value, so an admin who turned assignment alerts
 * OFF under DZ-1 keeps both halves OFF after the upgrade. Once a
 * split key is written, the legacy row is kept in sync (derived
 * assignee && upline) and is never consulted for that half again.
 *
 * Storage follows the CalendarConfigService pattern exactly: Metadata
 * Engine options, group 'Notifications', one row per toggle,
 * meta.enabled boolean, seeded lazily on first write. Reads fail back
 * to TRUE (today's behaviour) whenever the row is missing or
 * malformed, so a fresh or legacy database behaves exactly as the app
 * did before these toggles existed.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb } from '../routes/production/shared.js';

export const NOTIFICATIONS_OPTION_TYPE = 'Notifications';
export const ASSIGNMENT_ALERTS_OPTION_VALUE = 'assignmentAlerts';
export const ASSIGNEE_ALERTS_OPTION_VALUE = 'assigneeAlerts';
export const UPLINE_ALERTS_OPTION_VALUE = 'uplineAlerts';
export const MEETING_NOTIFICATIONS_OPTION_VALUE = 'meetingNotifications';
export const DAILY_PUSH_SUMMARY_OPTION_VALUE = 'dailyPushSummary';

export interface NotificationSettings {
  /** Assignee receives the "New Lead Assigned" notification (L1). */
  assigneeAlerts: boolean;
  /** Upline managers receive the assignment alert (L1). */
  uplineAlerts: boolean;
  /**
   * Deprecated DZ-1 combined value, kept for API compatibility:
   * true only when both assigneeAlerts and uplineAlerts are on.
   * Accepted on write as an alias that sets both halves (only when
   * neither half is sent explicitly).
   */
  assignmentAlerts: boolean;
  dailyPushSummary: boolean;
  /** Meeting invite/moved/cancelled/completed/RSVP/reminder alerts (L2). */
  meetingNotifications: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  assigneeAlerts: true,
  uplineAlerts: true,
  assignmentAlerts: true,
  dailyPushSummary: true,
  meetingNotifications: true,
};

const OPTION_LABELS: Record<string, string> = {
  [ASSIGNMENT_ALERTS_OPTION_VALUE]: 'In-App Assignment Alerts',
  [ASSIGNEE_ALERTS_OPTION_VALUE]: 'Assignee Assignment Alerts',
  [UPLINE_ALERTS_OPTION_VALUE]: 'Upline Assignment Alerts',
  [MEETING_NOTIFICATIONS_OPTION_VALUE]: 'Meeting Notifications',
  [DAILY_PUSH_SUMMARY_OPTION_VALUE]: 'Daily Push Summary',
};

const OPTION_SORT_ORDER: Record<string, number> = {
  [ASSIGNMENT_ALERTS_OPTION_VALUE]: 1,
  [ASSIGNEE_ALERTS_OPTION_VALUE]: 1,
  [UPLINE_ALERTS_OPTION_VALUE]: 2,
  [MEETING_NOTIFICATIONS_OPTION_VALUE]: 3,
  [DAILY_PUSH_SUMMARY_OPTION_VALUE]: 4,
};

/**
 * Lenient read of a stored meta value: only an explicit boolean
 * `false` turns a toggle off. Anything missing or malformed keeps
 * today's behaviour (ON) — the toggles must never silently disable
 * notifications because a row is shaped unexpectedly.
 */
export function parseEnabledMeta(meta: unknown): boolean {
  if (meta && typeof meta === 'object') {
    const enabled = (meta as any).enabled;
    if (typeof enabled === 'boolean') return enabled;
  }
  return true;
}

function settingsFromOptionRows(rows: Array<{ value: string; meta: any }>): NotificationSettings {
  const byValue = new Map(rows.map((r) => [r.value, r.meta]));
  // DZ-1 migration fallback: a split half with no row of its own
  // inherits the legacy combined `assignmentAlerts` value (if any).
  const legacy = byValue.has(ASSIGNMENT_ALERTS_OPTION_VALUE)
    ? parseEnabledMeta(byValue.get(ASSIGNMENT_ALERTS_OPTION_VALUE))
    : undefined;
  const assigneeAlerts = byValue.has(ASSIGNEE_ALERTS_OPTION_VALUE)
    ? parseEnabledMeta(byValue.get(ASSIGNEE_ALERTS_OPTION_VALUE))
    : (legacy ?? true);
  const uplineAlerts = byValue.has(UPLINE_ALERTS_OPTION_VALUE)
    ? parseEnabledMeta(byValue.get(UPLINE_ALERTS_OPTION_VALUE))
    : (legacy ?? true);
  return {
    assigneeAlerts,
    uplineAlerts,
    assignmentAlerts: assigneeAlerts && uplineAlerts,
    dailyPushSummary: byValue.has(DAILY_PUSH_SUMMARY_OPTION_VALUE)
      ? parseEnabledMeta(byValue.get(DAILY_PUSH_SUMMARY_OPTION_VALUE))
      : true,
    meetingNotifications: byValue.has(MEETING_NOTIFICATIONS_OPTION_VALUE)
      ? parseEnabledMeta(byValue.get(MEETING_NOTIFICATIONS_OPTION_VALUE))
      : true,
  };
}

function fallbackOptionRows(): Array<{ value: string; meta: any }> {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  return rows
    .filter((o: any) => o.type === NOTIFICATIONS_OPTION_TYPE)
    .map((o: any) => ({ value: o.value, meta: o.meta }));
}

/** The current toggle values (defaults ON whenever unset/unreadable). */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  if (!useDb()) {
    return settingsFromOptionRows(fallbackOptionRows());
  }
  try {
    const result = await getPool().query(
      `SELECT option_value AS value, meta FROM options WHERE field_key = $1`,
      [NOTIFICATIONS_OPTION_TYPE]
    );
    return settingsFromOptionRows(result.rows);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

/**
 * Synchronous read for the demo (fallback) path, used by
 * createAssignmentNotificationsDemo which is a sync function. Only
 * meaningful when the app is running without a database.
 */
export function getNotificationSettingsSyncFallback(): NotificationSettings {
  return settingsFromOptionRows(fallbackOptionRows());
}

/**
 * True when the Metadata Engine's `options` table exists with the
 * columns the toggle read needs. The probe queries information_schema
 * only, so it can never fail on a schema that predates the Metadata
 * Engine tables (legacy/minimal test fixtures, mid-rollout deploys) —
 * the migration-053/054 pattern from NextStepCalendarSync.
 */
async function hasOptionsColumns(exec: { query: Function }): Promise<boolean> {
  const res = await exec.query(
    `SELECT (
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'options' AND column_name = 'field_key')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'options' AND column_name = 'option_value')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'options' AND column_name = 'meta')
     ) AS ok`
  );
  return Boolean(res?.rows?.[0]?.ok);
}

/**
 * Read ONE toggle from inside a caller's transaction (used by
 * createAssignmentNotifications so the check commits atomically with
 * the lead mutation and costs no extra connection). Fails ON.
 *
 * `fallbackOptionValue` is the DZ-1 legacy row: when the primary key
 * has no row, the fallback row's value is used instead (so an admin
 * who switched the old combined toggle OFF keeps both halves OFF
 * until they write the split keys). Both rows are fetched in one
 * SELECT; the primary always wins when present.
 *
 * The `options` table is PROBED (information_schema) before it is
 * touched — deciding first, never catching after. A try/catch around
 * the SELECT is NOT enough inside a transaction: when the statement
 * errors (e.g. `options` missing on a minimal schema), PostgreSQL
 * aborts the caller's whole transaction, so every later statement
 * fails with "current transaction is aborted" and the lead write
 * itself is lost. Probing keeps the transaction healthy: table or
 * columns absent → the toggle simply reads as its default (ON).
 */
export async function readToggleWithExec(
  exec: { query: Function },
  optionValue: string,
  fallbackOptionValue?: string
): Promise<boolean> {
  try {
    if (!(await hasOptionsColumns(exec))) return true;
    const values = fallbackOptionValue ? [optionValue, fallbackOptionValue] : [optionValue];
    const result = await exec.query(
      `SELECT option_value, meta FROM options WHERE field_key = $1 AND option_value = ANY($2::text[])`,
      [NOTIFICATIONS_OPTION_TYPE, values]
    );
    if (!result || !Array.isArray(result.rows)) return true;
    const byValue = new Map(result.rows.map((r: any) => [r.option_value, r.meta]));
    if (byValue.has(optionValue)) return parseEnabledMeta(byValue.get(optionValue));
    if (fallbackOptionValue && byValue.has(fallbackOptionValue)) return parseEnabledMeta(byValue.get(fallbackOptionValue));
    return true;
  } catch {
    return true;
  }
}

async function upsertToggleRow(optionValue: string, enabled: boolean): Promise<void> {
  const meta = JSON.stringify({ enabled });
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, NOTIFICATIONS_OPTION_TYPE, optionValue]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'Notifications', 'Notification Settings',
              'Workspace notification toggles (assignment alerts, daily push summary).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'Notifications')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('Notifications', $1, $2, $3, FALSE, TRUE, $4::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [optionValue, OPTION_LABELS[optionValue] || optionValue, OPTION_SORT_ORDER[optionValue] || 99, meta]
    );
  }
}

function setToggleFallback(optionValue: string, enabled: boolean): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === NOTIFICATIONS_OPTION_TYPE && o.value === optionValue
  );
  if (existing) existing.meta = { ...(existing.meta || {}), enabled };
  else {
    store.options.push({
      id: `notifications-${optionValue}`,
      type: NOTIFICATIONS_OPTION_TYPE,
      value: optionValue,
      label: OPTION_LABELS[optionValue] || optionValue,
      status: 'Active',
      sortOrder: OPTION_SORT_ORDER[optionValue] || 99,
      meta: { enabled },
    });
  }
}

/**
 * Persist a partial update; returns the full resulting settings.
 * Only the known keys are honoured. The DZ-1 `assignmentAlerts` key
 * is accepted as a legacy alias: it sets BOTH split halves, and only
 * when neither half is sent explicitly. After any split-half write
 * the legacy row is kept in sync (derived assignee && upline) so the
 * Metadata Engine list never shows a stale combined value.
 */
export async function setNotificationSettings(
  patch: Partial<NotificationSettings>
): Promise<NotificationSettings> {
  const entries: Array<[string, boolean]> = [];
  if (typeof patch.assigneeAlerts === 'boolean') entries.push([ASSIGNEE_ALERTS_OPTION_VALUE, patch.assigneeAlerts]);
  if (typeof patch.uplineAlerts === 'boolean') entries.push([UPLINE_ALERTS_OPTION_VALUE, patch.uplineAlerts]);
  if (typeof patch.meetingNotifications === 'boolean') entries.push([MEETING_NOTIFICATIONS_OPTION_VALUE, patch.meetingNotifications]);
  if (typeof patch.dailyPushSummary === 'boolean') entries.push([DAILY_PUSH_SUMMARY_OPTION_VALUE, patch.dailyPushSummary]);
  if (
    typeof patch.assignmentAlerts === 'boolean' &&
    typeof patch.assigneeAlerts !== 'boolean' &&
    typeof patch.uplineAlerts !== 'boolean'
  ) {
    entries.push([ASSIGNEE_ALERTS_OPTION_VALUE, patch.assignmentAlerts]);
    entries.push([UPLINE_ALERTS_OPTION_VALUE, patch.assignmentAlerts]);
  }
  const touchedSplit = entries.some(([v]) => v === ASSIGNEE_ALERTS_OPTION_VALUE || v === UPLINE_ALERTS_OPTION_VALUE);
  if (!useDb()) {
    for (const [value, enabled] of entries) setToggleFallback(value, enabled);
    const after = await getNotificationSettings();
    if (touchedSplit) setToggleFallback(ASSIGNMENT_ALERTS_OPTION_VALUE, after.assignmentAlerts);
    return after;
  }
  for (const [value, enabled] of entries) await upsertToggleRow(value, enabled);
  const after = await getNotificationSettings();
  if (touchedSplit) await upsertToggleRow(ASSIGNMENT_ALERTS_OPTION_VALUE, after.assignmentAlerts);
  return after;
}
