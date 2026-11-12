/**
 * OperationsSettingsService — bounded operational limits as real
 * Settings values (Admin Control programme, DZ-2).
 * ------------------------------------------------------------------
 * Audit items G1 (lead bulk-import row cap), G2 (user bulk-import
 * row cap) and M1 (profile/logo image upload cap) were hardcoded
 * constants an admin could not change. They are now persisted
 * Metadata Engine options, group 'Operations', one row per limit,
 * read at request time by the code that enforces them — with the
 * previous hardcoded value as both the default and the CODE CEILING:
 * an admin may lower a limit but never raise it above the ceiling,
 * so a bad value can never take the app down (the audit §1 pattern).
 *
 *   leadBulkImportMaxRows  meta { rows }  default 5000, range 100–5000
 *   userBulkImportMaxRows  meta { rows }  default 1000, range 10–1000
 *   imageUploadMaxMb       meta { mb }    default 1.5,  range 0.5–1.5 MB
 *
 * Reads fail back to the default whenever the row is missing or
 * malformed. Writes outside the range are refused (400 at the route).
 * Storage mirrors NotificationSettingsService exactly (lazy seeding
 * on first write, fallback-store path for demo mode).
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb } from '../routes/production/shared.js';
import {
  IMAGE_UPLOAD_MAX_MB_CEILING,
  IMAGE_UPLOAD_MAX_MB_FLOOR,
  LEAD_BULK_IMPORT_MAX_ROWS_CEILING,
  LEAD_BULK_IMPORT_MAX_ROWS_FLOOR,
  USER_BULK_IMPORT_MAX_ROWS_CEILING,
  USER_BULK_IMPORT_MAX_ROWS_FLOOR,
} from './operationsLimits.js';

/** Re-exported for callers that need the ceilings without a settings read. */
export {
  IMAGE_UPLOAD_MAX_MB_CEILING,
  IMAGE_UPLOAD_MAX_MB_FLOOR,
  LEAD_BULK_IMPORT_MAX_ROWS_CEILING,
  LEAD_BULK_IMPORT_MAX_ROWS_FLOOR,
  USER_BULK_IMPORT_MAX_ROWS_CEILING,
  USER_BULK_IMPORT_MAX_ROWS_FLOOR,
} from './operationsLimits.js';

export const OPERATIONS_OPTION_TYPE = 'Operations';
export const LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE = 'leadBulkImportMaxRows';
export const USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE = 'userBulkImportMaxRows';
export const IMAGE_UPLOAD_MAX_MB_OPTION_VALUE = 'imageUploadMaxMb';

export interface OperationsSettings {
  leadBulkImportMaxRows: number;
  userBulkImportMaxRows: number;
  imageUploadMaxMb: number;
}

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  leadBulkImportMaxRows: LEAD_BULK_IMPORT_MAX_ROWS_CEILING,
  userBulkImportMaxRows: USER_BULK_IMPORT_MAX_ROWS_CEILING,
  imageUploadMaxMb: IMAGE_UPLOAD_MAX_MB_CEILING,
};

const OPTION_LABELS: Record<string, string> = {
  [LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE]: 'Lead Bulk Import Max Rows',
  [USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE]: 'User Bulk Import Max Rows',
  [IMAGE_UPLOAD_MAX_MB_OPTION_VALUE]: 'Image Upload Max Size (MB)',
};

const OPTION_SORT_ORDER: Record<string, number> = {
  [LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE]: 1,
  [USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE]: 2,
  [IMAGE_UPLOAD_MAX_MB_OPTION_VALUE]: 3,
};

/**
 * Range check for a write. Returns an error message when the value is
 * not a usable number inside [floor, ceiling]; null when it is fine.
 * (Reads never throw — see parse helpers below.)
 */
export function validateOperationsValue(
  key: keyof OperationsSettings,
  value: unknown
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number.`;
  if (key === 'imageUploadMaxMb') {
    if (value < IMAGE_UPLOAD_MAX_MB_FLOOR || value > IMAGE_UPLOAD_MAX_MB_CEILING) {
      return `imageUploadMaxMb must be between ${IMAGE_UPLOAD_MAX_MB_FLOOR} and ${IMAGE_UPLOAD_MAX_MB_CEILING} MB.`;
    }
    return null;
  }
  if (!Number.isInteger(value)) return `${key} must be a whole number.`;
  if (key === 'leadBulkImportMaxRows') {
    if (value < LEAD_BULK_IMPORT_MAX_ROWS_FLOOR || value > LEAD_BULK_IMPORT_MAX_ROWS_CEILING) {
      return `leadBulkImportMaxRows must be between ${LEAD_BULK_IMPORT_MAX_ROWS_FLOOR} and ${LEAD_BULK_IMPORT_MAX_ROWS_CEILING}.`;
    }
    return null;
  }
  if (value < USER_BULK_IMPORT_MAX_ROWS_FLOOR || value > USER_BULK_IMPORT_MAX_ROWS_CEILING) {
    return `userBulkImportMaxRows must be between ${USER_BULK_IMPORT_MAX_ROWS_FLOOR} and ${USER_BULK_IMPORT_MAX_ROWS_CEILING}.`;
  }
  return null;
}

/** Lenient read of a stored numeric meta value: clamp into range, default when unusable. */
function parseRowsMeta(meta: unknown, floor: number, ceiling: number, fallback: number): number {
  if (meta && typeof meta === 'object') {
    const rows = (meta as any).rows;
    if (typeof rows === 'number' && Number.isFinite(rows)) {
      return Math.min(ceiling, Math.max(floor, Math.floor(rows)));
    }
  }
  return fallback;
}

function parseMbMeta(meta: unknown): number {
  if (meta && typeof meta === 'object') {
    const mb = (meta as any).mb;
    if (typeof mb === 'number' && Number.isFinite(mb)) {
      return Math.min(IMAGE_UPLOAD_MAX_MB_CEILING, Math.max(IMAGE_UPLOAD_MAX_MB_FLOOR, mb));
    }
  }
  return IMAGE_UPLOAD_MAX_MB_CEILING;
}

function settingsFromOptionRows(rows: Array<{ value: string; meta: any }>): OperationsSettings {
  const byValue = new Map(rows.map((r) => [r.value, r.meta]));
  return {
    leadBulkImportMaxRows: byValue.has(LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE)
      ? parseRowsMeta(byValue.get(LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE), LEAD_BULK_IMPORT_MAX_ROWS_FLOOR, LEAD_BULK_IMPORT_MAX_ROWS_CEILING, LEAD_BULK_IMPORT_MAX_ROWS_CEILING)
      : LEAD_BULK_IMPORT_MAX_ROWS_CEILING,
    userBulkImportMaxRows: byValue.has(USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE)
      ? parseRowsMeta(byValue.get(USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE), USER_BULK_IMPORT_MAX_ROWS_FLOOR, USER_BULK_IMPORT_MAX_ROWS_CEILING, USER_BULK_IMPORT_MAX_ROWS_CEILING)
      : USER_BULK_IMPORT_MAX_ROWS_CEILING,
    imageUploadMaxMb: byValue.has(IMAGE_UPLOAD_MAX_MB_OPTION_VALUE)
      ? parseMbMeta(byValue.get(IMAGE_UPLOAD_MAX_MB_OPTION_VALUE))
      : IMAGE_UPLOAD_MAX_MB_CEILING,
  };
}

function fallbackOptionRows(): Array<{ value: string; meta: any }> {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  return rows
    .filter((o: any) => o.type === OPERATIONS_OPTION_TYPE)
    .map((o: any) => ({ value: o.value, meta: o.meta }));
}

/** The current limits (defaults whenever unset/unreadable). */
export async function getOperationsSettings(): Promise<OperationsSettings> {
  if (!useDb()) {
    return settingsFromOptionRows(fallbackOptionRows());
  }
  try {
    const result = await getPool().query(
      `SELECT option_value AS value, meta FROM options WHERE field_key = $1`,
      [OPERATIONS_OPTION_TYPE]
    );
    return settingsFromOptionRows(result.rows);
  } catch {
    return { ...DEFAULT_OPERATIONS_SETTINGS };
  }
}

/** Convenience readers for the enforcing call sites (fail-closed to the ceiling). */
export async function getLeadBulkImportMaxRows(): Promise<number> {
  return (await getOperationsSettings()).leadBulkImportMaxRows;
}

export async function getUserBulkImportMaxRows(): Promise<number> {
  return (await getOperationsSettings()).userBulkImportMaxRows;
}

export async function getImageUploadMaxMb(): Promise<number> {
  return (await getOperationsSettings()).imageUploadMaxMb;
}

function metaFor(optionValue: string, value: number): string {
  if (optionValue === IMAGE_UPLOAD_MAX_MB_OPTION_VALUE) return JSON.stringify({ mb: value });
  return JSON.stringify({ rows: value });
}

async function upsertLimitRow(optionValue: string, value: number): Promise<void> {
  const meta = metaFor(optionValue, value);
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, OPERATIONS_OPTION_TYPE, optionValue]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'Operations', 'Operations & Limits',
              'Bounded operational limits (bulk-import row caps, image upload size).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'Operations')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('Operations', $1, $2, $3, FALSE, TRUE, $4::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [optionValue, OPTION_LABELS[optionValue] || optionValue, OPTION_SORT_ORDER[optionValue] || 99, meta]
    );
  }
}

function setLimitFallback(optionValue: string, value: number): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === OPERATIONS_OPTION_TYPE && o.value === optionValue
  );
  const meta = optionValue === IMAGE_UPLOAD_MAX_MB_OPTION_VALUE ? { mb: value } : { rows: value };
  if (existing) existing.meta = { ...(existing.meta || {}), ...meta };
  else {
    store.options.push({
      id: `operations-${optionValue}`,
      type: OPERATIONS_OPTION_TYPE,
      value: optionValue,
      label: OPTION_LABELS[optionValue] || optionValue,
      status: 'Active',
      sortOrder: OPTION_SORT_ORDER[optionValue] || 99,
      meta,
    });
  }
}

/**
 * Persist a partial update; returns the full resulting settings.
 * Only the three known keys are honoured. Throws an Error naming the
 * problem when a supplied value is outside its range — the route
 * maps that to a 400.
 */
export async function setOperationsSettings(
  patch: Partial<OperationsSettings>
): Promise<OperationsSettings> {
  const entries: Array<{ key: keyof OperationsSettings; optionValue: string; num: number }> = [];
  if (patch.leadBulkImportMaxRows !== undefined) {
    entries.push({ key: 'leadBulkImportMaxRows', optionValue: LEAD_BULK_IMPORT_MAX_ROWS_OPTION_VALUE, num: patch.leadBulkImportMaxRows });
  }
  if (patch.userBulkImportMaxRows !== undefined) {
    entries.push({ key: 'userBulkImportMaxRows', optionValue: USER_BULK_IMPORT_MAX_ROWS_OPTION_VALUE, num: patch.userBulkImportMaxRows });
  }
  if (patch.imageUploadMaxMb !== undefined) {
    entries.push({ key: 'imageUploadMaxMb', optionValue: IMAGE_UPLOAD_MAX_MB_OPTION_VALUE, num: patch.imageUploadMaxMb });
  }
  for (const { key, num } of entries) {
    const problem = validateOperationsValue(key, num);
    if (problem) throw new Error(problem);
  }
  if (!useDb()) {
    for (const { optionValue, num } of entries) setLimitFallback(optionValue, num);
    return getOperationsSettings();
  }
  for (const { optionValue, num } of entries) await upsertLimitRow(optionValue, num);
  return getOperationsSettings();
}
