/**
 * NotificationSettingsService — real, persisted notification toggles
 * (Admin Control programme, DZ-1 "Honest Settings").
 * ------------------------------------------------------------------
 * The Settings → Push Intelligence card used to be a hardcoded array
 * with `enabled: true` on every row — it stored nothing and gated
 * nothing (audit item L5). Two of its rows describe behaviour that
 * genuinely exists, so they are now backed by real settings that the
 * services actually read:
 *
 *   assignmentAlerts  — NotificationService.createAssignmentNotifications
 *                       (and its demo twin) create nothing when OFF.
 *   dailyPushSummary  — PushReminderService.runDailyPushReminders
 *                       sends no digest pushes when OFF. (The SLA
 *                       breach rider on the same morning run has its
 *                       own switch and is NOT gated by this toggle.)
 *
 * Storage follows the CalendarConfigService pattern exactly: Metadata
 * Engine options, group 'Notifications', one row per toggle,
 * meta.enabled boolean, seeded lazily on first write. Reads fail back
 * to TRUE (today's behaviour) whenever the row is missing or
 * malformed, so a fresh or legacy database behaves exactly as the app
 * did before these toggles existed. The third old row, "Tomorrow Call
 * Reminders", described no behaviour anywhere in the app and was
 * removed from the UI rather than wired (DZ-1).
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb } from '../routes/production/shared.js';

export const NOTIFICATIONS_OPTION_TYPE = 'Notifications';
export const ASSIGNMENT_ALERTS_OPTION_VALUE = 'assignmentAlerts';
export const DAILY_PUSH_SUMMARY_OPTION_VALUE = 'dailyPushSummary';

export interface NotificationSettings {
  assignmentAlerts: boolean;
  dailyPushSummary: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  assignmentAlerts: true,
  dailyPushSummary: true,
};

const OPTION_LABELS: Record<string, string> = {
  [ASSIGNMENT_ALERTS_OPTION_VALUE]: 'In-App Assignment Alerts',
  [DAILY_PUSH_SUMMARY_OPTION_VALUE]: 'Daily Push Summary',
};

const OPTION_SORT_ORDER: Record<string, number> = {
  [ASSIGNMENT_ALERTS_OPTION_VALUE]: 1,
  [DAILY_PUSH_SUMMARY_OPTION_VALUE]: 2,
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
  const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  for (const row of rows) {
    if (row.value === ASSIGNMENT_ALERTS_OPTION_VALUE) settings.assignmentAlerts = parseEnabledMeta(row.meta);
    if (row.value === DAILY_PUSH_SUMMARY_OPTION_VALUE) settings.dailyPushSummary = parseEnabledMeta(row.meta);
  }
  return settings;
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
 * Read ONE toggle from inside a caller's transaction (used by
 * createAssignmentNotifications so the check commits atomically with
 * the lead mutation and costs no extra connection). Fails ON.
 */
export async function readToggleWithExec(
  exec: { query: Function },
  optionValue: string
): Promise<boolean> {
  try {
    const result = await exec.query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2`,
      [NOTIFICATIONS_OPTION_TYPE, optionValue]
    );
    if (!result || !Array.isArray(result.rows) || result.rows.length === 0) return true;
    return parseEnabledMeta(result.rows[0].meta);
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
 * Only the two known keys are honoured.
 */
export async function setNotificationSettings(
  patch: Partial<NotificationSettings>
): Promise<NotificationSettings> {
  const entries: Array<[string, boolean]> = [];
  if (typeof patch.assignmentAlerts === 'boolean') entries.push([ASSIGNMENT_ALERTS_OPTION_VALUE, patch.assignmentAlerts]);
  if (typeof patch.dailyPushSummary === 'boolean') entries.push([DAILY_PUSH_SUMMARY_OPTION_VALUE, patch.dailyPushSummary]);
  if (!useDb()) {
    for (const [value, enabled] of entries) setToggleFallback(value, enabled);
    return getNotificationSettings();
  }
  for (const [value, enabled] of entries) await upsertToggleRow(value, enabled);
  return getNotificationSettings();
}
