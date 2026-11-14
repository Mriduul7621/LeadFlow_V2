/**
 * HierarchyRulesService — hierarchy knobs in the Danger Zone
 * (Admin Control programme, DZ-7; audit §2.3 C2/C4, §4).
 * ------------------------------------------------------------------
 * Two behaviours that used to be hardcoded in
 * `server/utils/reportingRules.ts` become ONE versioned config a
 * super admin edits in the Danger Zone, while the code values remain
 * the default and the fail-closed fallback:
 *
 *   C2  maximum reporting gap ....... default 2, bounded 1–3 (audit)
 *       A manager that many levels above the employee is the widest
 *       link the hierarchy-health check still calls normal; a wider
 *       gap is flagged as a WARNING (never a block — UM-1).
 *   C4  same-department requirement . default ON
 *       While ON, a reporting link whose manager belongs to a
 *       different department (primary + additional seats) is flagged
 *       as a WARNING by the health check. While OFF, the health
 *       check ignores department shape entirely. This configures
 *       the requirement AS A FLAG, never as a hard block: UM-1
 *       deliberately removed the write-path blocks, and this slice
 *       does not re-impose them.
 *
 * What stays in code (§3.4 / audit): the Level-1 (CEO) org root
 * (reports to nobody — the one hard rule `validateReportingManagerCandidate`
 * still owns), the Level-1 cross-department exception (a CEO manager
 * is never flagged for department shape), the manager-required rule
 * for in-ladder Level 2+ employees, and the identity / active /
 * cycle hard rules on the write paths.
 *
 * Storage mirrors SecurityPolicyService exactly: one Metadata
 * Engine row, group 'HierarchyRules', ('HierarchyRules', 'config')
 * carrying the whole config as meta JSON. No migration — the
 * options table already carries `meta`. Reads fail closed to the
 * code defaults whenever the row is missing, malformed or out of
 * range, so a bad stored value can never take the hierarchy
 * health screen down. Writes are validated server-side (400 on
 * anything out of range) and audit-logged with old→new values
 * (action `danger_zone.hierarchy_rules.update`, Q7).
 *
 * READ-SAFETY (DZ-1 lesson): the options read runs on the pool
 * OUTSIDE any caller transaction and is wrapped in try/catch, so
 * a fixture / pre-migration schema without the options table
 * degrades to the code defaults instead of aborting a transaction.
 * Callers that run inside a transaction (bulk-import commit) must
 * read the rules BEFORE `BEGIN` and pass them in — never read
 * inside the transaction.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb, logAccessChange } from '../routes/production/shared.js';
import {
  DEFAULT_HIERARCHY_RULES as CODE_DEFAULT_RULES,
  MAX_REPORTING_GAP,
  MAX_REPORTING_GAP_MAX,
  MAX_REPORTING_GAP_MIN,
} from '../utils/reportingRules.js';

export const HIERARCHY_RULES_OPTION_TYPE = 'HierarchyRules';
export const HIERARCHY_RULES_CONFIG_OPTION_VALUE = 'config';
export const HIERARCHY_RULES_CONFIG_OPTION_LABEL = 'Hierarchy Rules Config';
export const HIERARCHY_RULES_AUDIT_ACTION = 'danger_zone.hierarchy_rules.update';

/* ====================================================================
   BOUNDS (code-enforced; the audit fixes the gap bound at 1–3).
   The numbers live in server/utils/reportingRules.ts — the pure
   module that also owns the code defaults — and are re-exported
   here so the editor and the tests read one source of truth.
==================================================================== */

/** C2: maximum reporting gap. Audit bound 1–3; code default 2. */
export { MAX_REPORTING_GAP_MIN, MAX_REPORTING_GAP_MAX };
/** C2 code default (and the fail-closed fallback). */
export const MAX_REPORTING_GAP_DEFAULT = MAX_REPORTING_GAP;

export interface HierarchyRules {
  version: number;
  /** C2 — widest manager gap the health check calls normal (default 2). */
  maxReportingGap: number;
  /** C4 — flag cross-department reporting links as warnings (default true). */
  requireSameDepartment: boolean;
}

export const DEFAULT_HIERARCHY_RULES: HierarchyRules = {
  version: 0,
  ...CODE_DEFAULT_RULES,
};

/** The editable bounds, returned by GET so the editor can show them. */
export const HIERARCHY_RULES_BOUNDS = {
  maxReportingGap: { min: MAX_REPORTING_GAP_MIN, max: MAX_REPORTING_GAP_MAX },
} as const;

/** What a PUT accepts: the full rules (every field required). */
export type HierarchyRulesInput = Omit<HierarchyRules, 'version'>;

export interface HierarchyRulesLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: HierarchyRules | null;
  newValue: HierarchyRules;
}

export interface HierarchyRulesForEdit {
  version: number;
  rules: HierarchyRules;
  defaults: HierarchyRules;
  bounds: typeof HIERARCHY_RULES_BOUNDS;
  lastChange: HierarchyRulesLastChange | null;
}

/** Thrown by setHierarchyRules when the PUT body is invalid (route maps it to a 400). */
export class HierarchyRulesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HierarchyRulesValidationError';
  }
}

/* ====================================================================
   PURE RESOLVERS — clamp any candidate into its code bounds.
   Enforcement points use these (never the raw stored value), so a
   stored gap above 3 still flags at 3, and a stored gap below 1
   still flags at 1.
==================================================================== */

/** C2: bounded 1–3; unusable input → default 2. */
export function resolveMaxReportingGap(value?: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_HIERARCHY_RULES.maxReportingGap;
  return Math.min(MAX_REPORTING_GAP_MAX, Math.max(MAX_REPORTING_GAP_MIN, n));
}

/** C4: boolean; unusable input → default true (flag cross-department links). */
export function resolveRequireSameDepartment(value?: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_HIERARCHY_RULES.requireSameDepartment;
}

/** Lenient normalisation of any stored/loaded candidate (never throws). */
export function normalizeHierarchyRules(value: unknown): HierarchyRules {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  return {
    version: Number.isInteger(v.version) && (v.version as number) >= 0 ? v.version : 0,
    maxReportingGap: resolveMaxReportingGap(v.maxReportingGap),
    requireSameDepartment: resolveRequireSameDepartment(v.requireSameDepartment),
  };
}

/**
 * Strict validation of a PUT body. Returns error strings (empty =
 * valid). Out-of-range values are REFUSED here (400) — the
 * resolvers above only clamp what is already stored, so a bad
 * stored value degrades to the bounds instead of being saved.
 */
export function validateHierarchyRulesInput(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Hierarchy rules must be an object.'];
  }
  const body = input as Record<string, any>;
  const errors: string[] = [];
  const required = ['maxReportingGap', 'requireSameDepartment'] as const;
  for (const key of required) {
    if (body[key] === undefined) errors.push(`${key} is required.`);
  }
  if (errors.length > 0) return errors;
  if (!Number.isInteger(body.maxReportingGap)) {
    errors.push('maxReportingGap must be a whole number.');
  } else if (body.maxReportingGap < MAX_REPORTING_GAP_MIN || body.maxReportingGap > MAX_REPORTING_GAP_MAX) {
    errors.push(`Maximum reporting gap must be between ${MAX_REPORTING_GAP_MIN} and ${MAX_REPORTING_GAP_MAX}.`);
  }
  if (typeof body.requireSameDepartment !== 'boolean') {
    errors.push('requireSameDepartment must be true or false.');
  }
  return errors;
}

/* ====================================================================
   READS — one Metadata row, fail closed to the code defaults.
==================================================================== */

async function readStoredRulesDb(): Promise<HierarchyRules | null> {
  try {
    const result = await getPool().query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2 LIMIT 1`,
      [HIERARCHY_RULES_OPTION_TYPE, HIERARCHY_RULES_CONFIG_OPTION_VALUE]
    );
    const meta = result.rows[0]?.meta;
    if (meta == null) return null;
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      console.warn('[hierarchy-rules] stored rules are malformed — falling back to code defaults.');
      return null;
    }
    return normalizeHierarchyRules(meta);
  } catch (error: any) {
    console.warn('[hierarchy-rules] stored rules unavailable, using code defaults:', error?.message || error);
    return null;
  }
}

function readStoredRulesFallback(): HierarchyRules | null {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  const cfgRow = rows.find(
    (o: any) => o.type === HIERARCHY_RULES_OPTION_TYPE && o.value === HIERARCHY_RULES_CONFIG_OPTION_VALUE
  );
  if (!cfgRow?.meta || typeof cfgRow.meta !== 'object') return null;
  return normalizeHierarchyRules(cfgRow.meta);
}

async function readStoredRules(): Promise<HierarchyRules | null> {
  if (!useDb()) return readStoredRulesFallback();
  return readStoredRulesDb();
}

/** The current effective rules (code defaults whenever unset/unreadable). */
export async function getHierarchyRules(): Promise<HierarchyRules> {
  const stored = await readStoredRules();
  return stored ?? { ...DEFAULT_HIERARCHY_RULES };
}

/** C2 — the effective maximum reporting gap (bounded 1–3). */
export async function getMaxReportingGap(): Promise<number> {
  return (await getHierarchyRules()).maxReportingGap;
}

/** C4 — whether cross-department links are flagged as warnings. */
export async function getRequireSameDepartment(): Promise<boolean> {
  return (await getHierarchyRules()).requireSameDepartment;
}

/** The stored version (0 when the rules were never saved). */
export async function getHierarchyRulesVersion(): Promise<number> {
  const stored = await readStoredRules();
  return stored?.version ?? 0;
}

/** The latest DZ-7 change, from the audit log (null when never changed). */
export async function getLastHierarchyRulesChange(): Promise<HierarchyRulesLastChange | null> {
  if (!useDb()) return null;
  try {
    const result = await getPool().query(
      `SELECT actor_user_id, created_at, metadata FROM audit_logs
        WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [HIERARCHY_RULES_AUDIT_ACTION]
    );
    const row = result.rows[0];
    if (!row) return null;
    const meta = (row.metadata || {}) as Record<string, any>;
    return {
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      version: typeof meta.version === 'number' ? meta.version : 0,
      oldValue: meta.oldValue ? normalizeHierarchyRules(meta.oldValue) : null,
      newValue: normalizeHierarchyRules(meta.newValue),
    };
  } catch {
    return null;
  }
}

/** Full GET payload for the Danger Zone editor. */
export async function getHierarchyRulesForEdit(): Promise<HierarchyRulesForEdit> {
  const stored = await readStoredRules();
  const rules = stored ?? { ...DEFAULT_HIERARCHY_RULES };
  const lastChange = await getLastHierarchyRulesChange();
  return {
    version: stored?.version ?? 0,
    rules,
    defaults: { ...DEFAULT_HIERARCHY_RULES },
    bounds: HIERARCHY_RULES_BOUNDS,
    lastChange,
  };
}

/* ====================================================================
   WRITES — validate, version+1, audit old→new.
==================================================================== */

async function upsertRulesRowDb(stored: HierarchyRules): Promise<void> {
  const meta = JSON.stringify(stored);
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, HIERARCHY_RULES_OPTION_TYPE, HIERARCHY_RULES_CONFIG_OPTION_VALUE]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'HierarchyRules', 'Hierarchy Rules',
              'Hierarchy rules config (Danger Zone, DZ-7).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'HierarchyRules')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('HierarchyRules', $1, $2, 1, FALSE, TRUE, $3::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [HIERARCHY_RULES_CONFIG_OPTION_VALUE, HIERARCHY_RULES_CONFIG_OPTION_LABEL, meta]
    );
  }
}

function setRulesFallback(stored: HierarchyRules): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === HIERARCHY_RULES_OPTION_TYPE && o.value === HIERARCHY_RULES_CONFIG_OPTION_VALUE
  );
  if (existing) existing.meta = { ...stored };
  else {
    store.options.push({
      id: `hierarchy-rules-${HIERARCHY_RULES_CONFIG_OPTION_VALUE}`,
      type: HIERARCHY_RULES_OPTION_TYPE,
      value: HIERARCHY_RULES_CONFIG_OPTION_VALUE,
      label: HIERARCHY_RULES_CONFIG_OPTION_LABEL,
      status: 'Active',
      sortOrder: 1,
      meta: { ...stored },
    });
  }
}

/**
 * Persist a full ruleset (PUT). Validates server-side, increments
 * the version, and audit-logs old→new. Throws
 * HierarchyRulesValidationError naming the problem — the route maps
 * it to a 400. The audit row carries the effective old and new
 * rules; the old→new detail is rendered only inside the Danger
 * Zone (Q2). Saving alone changes no reporting link — it changes
 * what the hierarchy-health check flags from the next read on.
 */
export async function setHierarchyRules(
  input: HierarchyRulesInput,
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<HierarchyRulesForEdit> {
  const problems = validateHierarchyRulesInput(input);
  if (problems.length > 0) throw new HierarchyRulesValidationError(problems.join(' '));

  const before = await getHierarchyRules();
  const storedBefore = await readStoredRules();
  const version = (storedBefore?.version ?? 0) + 1;
  const next: HierarchyRules = { version, ...(input as HierarchyRules) };

  if (!useDb()) {
    setRulesFallback(next);
  } else {
    await upsertRulesRowDb(next);
  }
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: HIERARCHY_RULES_AUDIT_ACTION,
    entityType: 'hierarchy_rules',
    entityId: null,
    metadata: {
      key: 'hierarchyRules',
      version,
      oldValue: before,
      newValue: next,
      ip: opts.ip || undefined,
    },
  });
  return {
    version,
    rules: next,
    defaults: { ...DEFAULT_HIERARCHY_RULES },
    bounds: HIERARCHY_RULES_BOUNDS,
    lastChange: {
      actorUserId: opts.actorId || null,
      createdAt: new Date().toISOString(),
      version,
      oldValue: before,
      newValue: next,
    },
  };
}
