/**
 * roleDefaultsStore.ts — the effective role-defaults table (DZ-5)
 * ------------------------------------------------------------------
 * Admin Control programme, slice DZ-5 (audit §2.2 B6, §4): the
 * defaults table — which permission codes and which data-visibility
 * scope a standard role holds before anyone configures it — becomes
 * editable by a super admin inside the Danger Zone. The code table
 * in `src/modules/shared/access/roleGrantDefaults.ts` remains the
 * default and the fail-closed fallback; the stored table (one
 * Metadata Engine row, type 'RoleDefaults', value 'config') is what
 * `applyDefaultRoleAccess()` reads.
 *
 * This module is deliberately the LOW-LEVEL read side: it imports
 * only the connection pool, the fallback store and the code
 * constants — never `production/shared.ts` — because
 * `server/database/roleAccessDefaults.ts` (imported BY shared.ts)
 * reads the effective table through here. The write side
 * (validation, versioning, audit) lives in RoleDefaultsService,
 * which may import shared.ts freely.
 *
 * Rules that never change here (audit §3.4):
 *   - ADMIN / SUPERADMIN are never keys in this table: they bypass
 *     every permission check and are forced to Organization scope
 *     by code. A stored row naming them is dropped on read.
 *   - The table applies ONLY to roles holding zero grants, exactly
 *     as before (the guard lives in roleAccessDefaults.ts).
 *   - The UM-1 tree floor is untouched: a role whose stored scope
 *     is 'Own' still resolves to its subtree when it has reports
 *     (server/authz.ts). This table cannot switch the floor off.
 *   - The lead-visibility predicate core (PR #104) is untouched.
 */

import { getPool, isDatabaseConfigured } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import {
  DEFAULT_GRANTS,
  DEFAULT_VISIBILITY,
} from '../../src/modules/shared/access/roleGrantDefaults.js';

export const ROLE_DEFAULTS_OPTION_TYPE = 'RoleDefaults';
export const ROLE_DEFAULTS_CONFIG_OPTION_VALUE = 'config';
export const ROLE_DEFAULTS_CONFIG_OPTION_LABEL = 'Role Defaults Config';

/** The four data-visibility scopes (audit §2.3 C7 — definitions fixed). */
export const VISIBILITY_SCOPES = ['Own', 'DownTeam', 'FullTeam', 'Organization'] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

/** Role codes the code table describes, in display order. */
export const STANDARD_ROLE_CODES: string[] = Object.keys(DEFAULT_GRANTS);

/** Roles that may never appear as keys in this table (audit §3.4.5). */
export const BYPASS_ROLE_CODES = ['ADMIN', 'SUPERADMIN'] as const;

export interface RoleDefaults {
  version: number;
  /** role_code -> permission codes granted by default. */
  grants: Record<string, string[]>;
  /** role_code -> data-visibility scope. Absent = no default (stays 'Own'). */
  visibility: Record<string, string>;
}

/** Deep copy of the code table, as the version-0 effective value. */
export function cloneRoleDefaults(source: RoleDefaults): RoleDefaults {
  const grants: Record<string, string[]> = {};
  for (const [code, codes] of Object.entries(source.grants)) grants[code] = [...codes];
  return { version: source.version, grants, visibility: { ...source.visibility } };
}

export const DEFAULT_ROLE_DEFAULTS: RoleDefaults = {
  version: 0,
  grants: Object.fromEntries(
    Object.entries(DEFAULT_GRANTS).map(([code, codes]) => [code, [...codes]])
  ),
  visibility: { ...DEFAULT_VISIBILITY },
};

/** A role-code key is well-formed: uppercase letters, digits, underscore. */
export function isValidRoleCodeKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,29}$/.test(key)
    && !(BYPASS_ROLE_CODES as readonly string[]).includes(key);
}

function normalizeGrants(raw: unknown): Record<string, string[]> {
  // A malformed grants section falls back to the code table (DZ-4
  // per-field fallback): a stored row must never silently empty
  // every role's defaults. An empty object is a legitimate saved
  // state (the super admin removed every key) and stays empty.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(DEFAULT_GRANTS).map(([code, codes]) => [code, [...codes].sort()])
    );
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidRoleCodeKey(key)) continue;
    if (!Array.isArray(value)) continue;
    const codes = [...new Set(
      value.filter((c): c is string => typeof c === 'string' && c.length > 0)
    )].sort();
    out[key] = codes;
  }
  return out;
}

function normalizeVisibility(raw: unknown): Record<string, string> {
  // Same per-field fallback as grants: a malformed visibility
  // section falls back to the code table, never to "no defaults".
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_VISIBILITY };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidRoleCodeKey(key)) continue;
    if (typeof value !== 'string') continue;
    if (!(VISIBILITY_SCOPES as readonly string[]).includes(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Lenient normalisation of any stored/loaded candidate (never throws).
 * Drops bypass-role keys, malformed keys, non-string codes and
 * out-of-range visibility values; dedupes and sorts grant lists so
 * stored values compare stably.
 */
export function normalizeRoleDefaults(value: unknown): RoleDefaults {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  return {
    version: Number.isInteger(v.version) && (v.version as number) >= 0 ? v.version : 0,
    grants: normalizeGrants(v.grants),
    visibility: normalizeVisibility(v.visibility),
  };
}

async function readStoredDefaultsDb(): Promise<RoleDefaults | null> {
  // PROBE FIRST (DZ-1 precedent): this read runs inside
  // `applyDefaultRoleAccess()`, which the seed and `ensureDefaultRoles`
  // can invoke while a caller's transaction is open on the same
  // connection (single-connection test pools). A failed statement
  // inside that transaction aborts it, so the `options` table is
  // never touched until information_schema says it exists. The probe
  // itself cannot fail this way.
  try {
    const probe = await getPool().query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'options'
       ) AS exists`
    );
    if (!probe.rows[0]?.exists) return null;
  } catch {
    return null;
  }
  try {
    const result = await getPool().query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2 LIMIT 1`,
      [ROLE_DEFAULTS_OPTION_TYPE, ROLE_DEFAULTS_CONFIG_OPTION_VALUE]
    );
    const meta = result.rows[0]?.meta;
    if (meta == null) return null;
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      console.warn('[role-defaults] stored table is malformed — falling back to code defaults.');
      return null;
    }
    return normalizeRoleDefaults(meta);
  } catch (error: any) {
    console.warn('[role-defaults] stored table unavailable, using code defaults:', error?.message || error);
    return null;
  }
}

function readStoredDefaultsFallback(): RoleDefaults | null {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  const cfgRow = rows.find(
    (o: any) => o.type === ROLE_DEFAULTS_OPTION_TYPE && o.value === ROLE_DEFAULTS_CONFIG_OPTION_VALUE
  );
  if (!cfgRow?.meta || typeof cfgRow.meta !== 'object') return null;
  return normalizeRoleDefaults(cfgRow.meta);
}

async function readStoredDefaults(): Promise<RoleDefaults | null> {
  if (!isDatabaseConfigured()) return readStoredDefaultsFallback();
  return readStoredDefaultsDb();
}

/** The stored table (null when never saved in the Danger Zone). */
export async function getStoredRoleDefaults(): Promise<RoleDefaults | null> {
  return readStoredDefaults();
}

/**
 * The current effective table: the stored Danger Zone table when one
 * exists, otherwise the code defaults. Callers that apply defaults
 * must use this — never the imported constants directly.
 */
export async function getEffectiveRoleDefaults(): Promise<RoleDefaults> {
  const stored = await readStoredDefaults();
  return stored ?? cloneRoleDefaults(DEFAULT_ROLE_DEFAULTS);
}

/**
 * The canonical permission codes (audit Appendix A) as they exist in
 * the `permissions` table — the vocabulary a defaults entry may
 * reference (B1: definitions stay migration-owned). Empty when the
 * table cannot be read; validation then refuses every code
 * (fail closed) rather than guessing.
 */
export async function getKnownPermissionCodes(): Promise<Array<{ code: string; name: string | null }>> {
  if (!isDatabaseConfigured()) return [];
  try {
    // Probe first (same reason as readStoredDefaultsDb): never let a
    // missing table raise on a connection that may hold a transaction.
    const probe = await getPool().query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions'
       ) AS exists`
    );
    if (!probe.rows[0]?.exists) return [];
    const result = await getPool().query(
      `SELECT permission_code, permission_name FROM permissions ORDER BY permission_code`
    );
    return result.rows.map((row: any) => ({
      code: String(row.permission_code),
      name: row.permission_name ? String(row.permission_name) : null,
    }));
  } catch {
    return [];
  }
}
