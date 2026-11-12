/**
 * RoleDefaultsService — role defaults in the Danger Zone
 * (Admin Control programme, DZ-5; audit §2.2 B6, §4).
 * ------------------------------------------------------------------
 * The defaults table (B6) — which permission codes and which
 * data-visibility scope a standard role holds before anyone
 * configures it — becomes editable by a super admin inside the
 * Danger Zone. The code table remains the default and the
 * fail-closed fallback (see roleDefaultsStore.ts).
 *
 * Storage mirrors LeadQualityConfigService / SecurityPolicyService
 * exactly: one Metadata Engine row, group 'RoleDefaults',
 * ('RoleDefaults', 'config') carrying the whole table as meta JSON.
 * No migration — the options table already carries `meta`.
 * Reads fail closed to the code defaults whenever the row is
 * missing, malformed or unreadable. Writes are validated
 * server-side (400 on anything invalid) and audit-logged with
 * old→new values (action `danger_zone.role_defaults.update`, Q7).
 *
 * APPLYING (the part that makes an edit real): the stored table is
 * read by `applyDefaultRoleAccess()` — the same routine the seed
 * and migration 045 use — which only ever touches roles holding
 * ZERO grants, and only moves a role's visibility while it still
 * holds 'Own'. Nothing in this slice widens that: no configured
 * role is ever rewritten by a defaults change. Because that
 * routine otherwise runs only at seed/boot, the Danger Zone offers
 * an explicit, audited "Apply to unconfigured roles" step
 * (`POST /danger-zone/role-defaults/apply`) so a saved edit takes
 * effect on demand instead of waiting for a reinstall. The GET
 * payload lists the roles that step would touch, so the super
 * admin sees exactly what will change before pressing it.
 *
 * What this slice does NOT do (audit §3.4 / §2):
 *   - ADMIN / SUPERADMIN can never be keys here (bypass, invariant 5).
 *   - The UM-1 tree floor is untouched (authz.ts): an 'Own' role
 *     with reports still sees its subtree. This table cannot switch
 *     the floor off, and no edit here changes anyone's effective
 *     scope except through the stored role scope itself.
 *   - The lead-visibility predicate core (C6) is never editable.
 *   - Permission definitions (B1) stay migration-owned: a defaults
 *     entry may only reference codes that exist in the
 *     `permissions` table; inventing a code is refused (400).
 *   - Per-role grants for configured roles (B2) and role records
 *     (B5) stay in normal Settings / Roles & Access — this slice
 *     governs the DEFAULTS table only, and nothing moves out of
 *     normal Settings (the defaults never lived there).
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { logAccessChange, useDb } from '../routes/production/shared.js';
import { applyDefaultRoleAccess, type RoleDefaultsApplyReport } from '../database/roleAccessDefaults.js';
import {
  DEFAULT_ROLE_DEFAULTS,
  ROLE_DEFAULTS_CONFIG_OPTION_LABEL,
  ROLE_DEFAULTS_CONFIG_OPTION_VALUE,
  ROLE_DEFAULTS_OPTION_TYPE,
  VISIBILITY_SCOPES,
  cloneRoleDefaults,
  getEffectiveRoleDefaults,
  getKnownPermissionCodes,
  getStoredRoleDefaults,
  normalizeRoleDefaults,
  type RoleDefaults,
} from './roleDefaultsStore.js';

export const ROLE_DEFAULTS_AUDIT_ACTION = 'danger_zone.role_defaults.update';
export const ROLE_DEFAULTS_APPLY_AUDIT_ACTION = 'danger_zone.role_defaults.apply';

/** Hard cap on table size — a defaults table is a dozen rows, not a list. */
export const ROLE_DEFAULTS_MAX_KEYS = 40;

/** What a PUT accepts: the full table (every role code, every grant). */
export interface RoleDefaultsInput {
  grants: Record<string, string[]>;
  visibility: Record<string, string>;
}

export interface RoleDefaultsPermissionCode {
  code: string;
  name: string | null;
}

export interface UnconfiguredRole {
  roleCode: string;
  roleName: string;
}

export interface RoleDefaultsLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: RoleDefaults | null;
  newValue: RoleDefaults;
}

export interface RoleDefaultsForEdit {
  version: number;
  defaults: RoleDefaults;
  codeDefaults: RoleDefaults;
  permissionCodes: RoleDefaultsPermissionCode[];
  unconfiguredRoles: UnconfiguredRole[];
  lastChange: RoleDefaultsLastChange | null;
}

/** Thrown by setRoleDefaults when the PUT body is invalid (route maps it to a 400). */
export class RoleDefaultsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleDefaultsValidationError';
  }
}

/**
 * Strict validation of a PUT body against the canonical permission
 * codes currently in the database. Returns error strings (empty =
 * valid). Unknown codes, bypass-role keys, malformed role codes,
 * out-of-range visibility values and unknown top-level keys are all
 * refused with a clear message — the stored table can only ever
 * reference codes the app actually enforces.
 */
export function validateRoleDefaultsInput(
  input: unknown,
  knownCodes: string[]
): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Role defaults must be an object.'];
  }
  const body = input as Record<string, any>;
  const errors: string[] = [];
  for (const key of Object.keys(body)) {
    if (key !== 'grants' && key !== 'visibility') errors.push(`Unknown field: ${key}.`);
  }
  if (body.grants === undefined) errors.push('grants is required.');
  if (body.visibility === undefined) errors.push('visibility is required.');
  if (errors.length > 0) return errors;

  const known = new Set(knownCodes);
  const checkKeys = (section: string, value: unknown): number => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${section} must be an object of role code to value.`);
      return 0;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > ROLE_DEFAULTS_MAX_KEYS) {
      errors.push(`${section} has too many roles (max ${ROLE_DEFAULTS_MAX_KEYS}).`);
    }
    for (const [key] of entries) {
      if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,29}$/.test(key)) {
        errors.push(`${section}: "${key}" is not a valid role code (uppercase letters, digits, underscore).`);
      } else if (key === 'ADMIN' || key === 'SUPERADMIN') {
        errors.push(`${section}: ${key} can never be a defaults entry — super-admin roles bypass every check.`);
      }
    }
    return entries.length;
  };
  checkKeys('grants', body.grants);
  checkKeys('visibility', body.visibility);
  if (errors.length > 0) return errors;

  for (const [roleCode, codes] of Object.entries(body.grants as Record<string, unknown>)) {
    if (!Array.isArray(codes)) {
      errors.push(`grants.${roleCode} must be a list of permission codes.`);
      continue;
    }
    for (const code of codes) {
      if (typeof code !== 'string' || code.length === 0) {
        errors.push(`grants.${roleCode} contains an invalid permission code.`);
      } else if (!known.has(code)) {
        errors.push(`grants.${roleCode}: unknown permission code "${code}".`);
      }
    }
  }
  for (const [roleCode, scope] of Object.entries(body.visibility as Record<string, unknown>)) {
    if (typeof scope !== 'string' || !(VISIBILITY_SCOPES as readonly string[]).includes(scope)) {
      errors.push(`visibility.${roleCode} must be one of ${VISIBILITY_SCOPES.join(', ')}.`);
    }
  }
  return errors;
}

/* ====================================================================
   READS — one Metadata row, fail closed to the code defaults.
==================================================================== */

/** Roles holding zero grants (the only roles Apply would touch). */
export async function getUnconfiguredRoles(): Promise<UnconfiguredRole[]> {
  if (!useDb()) return [];
  try {
    const result = await getPool().query(
      `SELECT r.role_code, r.role_name
         FROM roles r
        WHERE UPPER(r.role_code) NOT IN ('ADMIN', 'SUPERADMIN')
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = r.id AND rp.is_allowed
          )
        ORDER BY r.role_code`
    );
    return result.rows.map((row: any) => ({
      roleCode: String(row.role_code),
      roleName: String(row.role_name || row.role_code),
    }));
  } catch {
    return [];
  }
}

/** The latest DZ-5 change, from the audit log (null when never changed). */
export async function getLastRoleDefaultsChange(): Promise<RoleDefaultsLastChange | null> {
  if (!useDb()) return null;
  try {
    const result = await getPool().query(
      `SELECT actor_user_id, created_at, metadata FROM audit_logs
        WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [ROLE_DEFAULTS_AUDIT_ACTION]
    );
    const row = result.rows[0];
    if (!row) return null;
    const meta = (row.metadata || {}) as Record<string, any>;
    return {
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      version: typeof meta.version === 'number' ? meta.version : 0,
      oldValue: meta.oldValue ? normalizeRoleDefaults(meta.oldValue) : null,
      newValue: normalizeRoleDefaults(meta.newValue),
    };
  } catch {
    return null;
  }
}

/** Full GET payload for the Danger Zone editor. */
export async function getRoleDefaultsForEdit(): Promise<RoleDefaultsForEdit> {
  const stored = await getStoredRoleDefaults();
  const effective = stored ?? cloneRoleDefaults(DEFAULT_ROLE_DEFAULTS);
  const [permissionCodes, unconfiguredRoles, lastChange] = await Promise.all([
    getKnownPermissionCodes(),
    getUnconfiguredRoles(),
    getLastRoleDefaultsChange(),
  ]);
  return {
    version: stored?.version ?? 0,
    defaults: effective,
    codeDefaults: cloneRoleDefaults(DEFAULT_ROLE_DEFAULTS),
    permissionCodes,
    unconfiguredRoles,
    lastChange,
  };
}

/* ====================================================================
   WRITES — validate, version+1, audit old→new.
==================================================================== */

async function upsertDefaultsRowDb(stored: RoleDefaults): Promise<void> {
  const meta = JSON.stringify(stored);
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, ROLE_DEFAULTS_OPTION_TYPE, ROLE_DEFAULTS_CONFIG_OPTION_VALUE]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'RoleDefaults', 'Role Defaults',
              'Role defaults table (Danger Zone, DZ-5).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'RoleDefaults')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('RoleDefaults', $1, $2, 1, FALSE, TRUE, $3::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [ROLE_DEFAULTS_CONFIG_OPTION_VALUE, ROLE_DEFAULTS_CONFIG_OPTION_LABEL, meta]
    );
  }
}

function setDefaultsFallback(stored: RoleDefaults): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === ROLE_DEFAULTS_OPTION_TYPE && o.value === ROLE_DEFAULTS_CONFIG_OPTION_VALUE
  );
  if (existing) existing.meta = { ...stored };
  else {
    store.options.push({
      id: `role-defaults-${ROLE_DEFAULTS_CONFIG_OPTION_VALUE}`,
      type: ROLE_DEFAULTS_OPTION_TYPE,
      value: ROLE_DEFAULTS_CONFIG_OPTION_VALUE,
      label: ROLE_DEFAULTS_CONFIG_OPTION_LABEL,
      status: 'Active',
      sortOrder: 1,
      meta: { ...stored },
    });
  }
}

/**
 * Persist a full defaults table (PUT). Validates server-side against
 * the canonical codes in the database, increments the version, and
 * audit-logs old→new. Throws RoleDefaultsValidationError naming the
 * problem — the route maps it to a 400. Saving alone changes no
 * role: the stored table takes effect when Apply runs (see below).
 */
export async function setRoleDefaults(
  input: RoleDefaultsInput,
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<RoleDefaultsForEdit> {
  const knownCodes = (await getKnownPermissionCodes()).map((c) => c.code);
  const problems = validateRoleDefaultsInput(input, knownCodes);
  if (problems.length > 0) throw new RoleDefaultsValidationError(problems.join(' '));

  const before = await getEffectiveRoleDefaults();
  const storedBefore = await getStoredRoleDefaults();
  const version = (storedBefore?.version ?? 0) + 1;
  const next: RoleDefaults = {
    ...normalizeRoleDefaults({ ...input, version }),
    version,
  };

  if (!useDb()) {
    setDefaultsFallback(next);
  } else {
    await upsertDefaultsRowDb(next);
  }
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: ROLE_DEFAULTS_AUDIT_ACTION,
    entityType: 'role_defaults',
    entityId: null,
    metadata: {
      key: 'roleDefaults',
      version,
      oldValue: before,
      newValue: next,
      ip: opts.ip || undefined,
    },
  });
  const [permissionCodes, unconfiguredRoles] = await Promise.all([
    getKnownPermissionCodes(),
    getUnconfiguredRoles(),
  ]);
  return {
    version,
    defaults: next,
    codeDefaults: cloneRoleDefaults(DEFAULT_ROLE_DEFAULTS),
    permissionCodes,
    unconfiguredRoles,
    lastChange: {
      actorUserId: opts.actorId || null,
      createdAt: new Date().toISOString(),
      version,
      oldValue: before,
      newValue: next,
    },
  };
}

/* ====================================================================
   APPLY — run the guarded routine against the stored table.
   --------------------------------------------------------------------
   The same routine the seed and migration 045 use, with the same
   guards: a role holding ANY grant is skipped; a role's visibility
   only moves while it still holds 'Own'. Idempotent — a second
   Apply after the first changes nothing and reports nothing.
==================================================================== */

export interface RoleDefaultsApplyResult {
  version: number;
  report: RoleDefaultsApplyReport;
}

/**
 * Apply the current effective table to unconfigured roles and
 * audit-log what actually changed (roles touched, grants added,
 * visibility moves). The audit row is the evidence that an edit
 * took effect — a save without an Apply changes no role.
 */
export async function applyRoleDefaults(
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<RoleDefaultsApplyResult> {
  const stored = await getStoredRoleDefaults();
  const report = await applyDefaultRoleAccess();
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: ROLE_DEFAULTS_APPLY_AUDIT_ACTION,
    entityType: 'role_defaults',
    entityId: null,
    metadata: {
      key: 'roleDefaults.apply',
      version: stored?.version ?? 0,
      applied: report.applied,
      skipped: report.skipped,
      ip: opts.ip || undefined,
    },
  });
  return { version: stored?.version ?? 0, report };
}
