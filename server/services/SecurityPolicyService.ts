/**
 * SecurityPolicyService — security policy in the Danger Zone
 * (Admin Control programme, DZ-4; audit §2.1 A1/A5/A8/A9, §4).
 * ------------------------------------------------------------------
 * Four behaviours that used to be hardcoded become ONE versioned
 * config a super admin edits in the Danger Zone, while the code
 * values remain the default and the fail-closed fallback:
 *
 *   A1  minimum password length ......... default 8, floor 5, ceiling 32
 *       Governs every password SET: first-admin bootstrap, self
 *       change, forced change, admin reset — and the admin-set
 *       passwords on user create/edit and bulk import, which had
 *       no floor at all (a bypass of the same rule).
 *   A5  login/session token lifetime ..... default 7 days, bounded 1–30
 *       Affects newly issued tokens only; a token already issued
 *       keeps the expiry it was minted with.
 *   A8  login rate limit ................ default 20 failed / 15 min / IP
 *       The attempts value is editable, bounded 5–100. The 15-min
 *       window stays in code (the audit does not move it).
 *   A9  per-account lockout ............. default ON, 10 failures → 30 min
 *       Uses the migration-022 columns (failed_login_attempts,
 *       locked_until) the login flow never read or wrote before.
 *       Lockout gates LOGIN only: an already-issued token keeps
 *       working until it expires. Disabling the policy takes
 *       effect immediately (the check reads the live value).
 *
 * Storage mirrors LeadQualityConfigService exactly: one Metadata
 * Engine row, group 'SecurityPolicy', ('SecurityPolicy', 'config')
 * carrying the whole policy as meta JSON. No migration — the
 * options table already carries `meta`, and the lockout columns
 * already exist. Reads fail closed to the code defaults whenever
 * the row is missing, malformed or out of range, so a bad stored
 * value can never take authentication down. Writes are validated
 * server-side (400 on anything out of range) and audit-logged
 * with old→new values (action `danger_zone.security_policy.update`,
 * Q7). No complexity toggles: the owner decided length-only (Q3).
 *
 * LAST SUPER ADMIN (audit §3.4 invariant 4): the N3/N4 guards —
 * the last active ADMIN/SUPERADMIN cannot be deleted, deactivated
 * or demoted — are untouched and still enforced by the user write
 * paths. The lockout itself applies UNIFORMLY, including to super
 * admins: a time-bounded lockout (30 min, self-healing) is not a
 * removal, and exempting the highest-value accounts from the
 * brute-force defence would defeat audit Finding 2 for exactly
 * the accounts an attacker targets. What this slice must NOT
 * create is an ADMINISTRATIVE path to lock the last super admin
 * out — so the user-edit unlock is CLEAR-ONLY (clearLockout can
 * only remove a lock, never set one), and no endpoint in this
 * slice sets locked_until except the login flow itself.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb, logAccessChange } from '../routes/production/shared.js';
import {
  DEFAULT_TOKEN_LIFETIME_DAYS,
  TOKEN_LIFETIME_DAYS_MAX,
  TOKEN_LIFETIME_DAYS_MIN,
  resolveTokenLifetimeDays,
} from '../utils/jwt.js';

export const SECURITY_POLICY_OPTION_TYPE = 'SecurityPolicy';
export const SECURITY_POLICY_CONFIG_OPTION_VALUE = 'config';
export const SECURITY_POLICY_CONFIG_OPTION_LABEL = 'Security Policy Config';
export const SECURITY_POLICY_AUDIT_ACTION = 'danger_zone.security_policy.update';
/** Audit action for an admin unlocking a locked account early. */
export const USER_UNLOCK_AUDIT_ACTION = 'user-unlocked';

/* ====================================================================
   BOUNDS (code-enforced; the audit fixes A1's floor at 5, A5 at
   1–30 days and A8 at 5–100 — the remaining bounds keep an admin
   from configuring a self-denial-of-service)
==================================================================== */

/** A1: minimum password length. Floor 5 is the audit's rule; 32 caps absurdity. */
export const PASSWORD_MIN_LENGTH_FLOOR = 5;
export const PASSWORD_MIN_LENGTH_CEILING = 32;
/** A8: failed sign-in attempts per 15-min window per IP. */
export const AUTH_RATE_LIMIT_MIN = 5;
export const AUTH_RATE_LIMIT_MAX = 100;
/** The A8 code default (and the fail-closed fallback). */
export const AUTH_RATE_LIMIT_DEFAULT = 20;
/** A9: failures that lock an account (Q4: 10 → 30 minutes). */
export const LOCKOUT_THRESHOLD_MIN = 3;
export const LOCKOUT_THRESHOLD_MAX = 50;
export const LOCKOUT_MINUTES_MIN = 5;
export const LOCKOUT_MINUTES_MAX = 1440;

export interface SecurityPolicy {
  version: number;
  /** A1 — minimum password length (default 8, floor 5). */
  passwordMinLength: number;
  /** A9 — per-account lockout on/off. */
  lockoutEnabled: boolean;
  /** A9 — failed logins that lock the account (default 10). */
  lockoutThreshold: number;
  /** A9 — lock duration in minutes (default 30). */
  lockoutMinutes: number;
  /** A5 — login/session token lifetime in days (default 7). */
  tokenLifetimeDays: number;
  /** A8 — failed sign-ins per 15 min per IP (default 20). */
  authRateLimitAttempts: number;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  version: 0,
  passwordMinLength: 8,
  lockoutEnabled: true,
  lockoutThreshold: 10,
  lockoutMinutes: 30,
  tokenLifetimeDays: DEFAULT_TOKEN_LIFETIME_DAYS,
  authRateLimitAttempts: AUTH_RATE_LIMIT_DEFAULT,
};

/** The editable bounds, returned by GET so the editor can show them. */
export const SECURITY_POLICY_BOUNDS = {
  passwordMinLength: { min: PASSWORD_MIN_LENGTH_FLOOR, max: PASSWORD_MIN_LENGTH_CEILING },
  lockoutThreshold: { min: LOCKOUT_THRESHOLD_MIN, max: LOCKOUT_THRESHOLD_MAX },
  lockoutMinutes: { min: LOCKOUT_MINUTES_MIN, max: LOCKOUT_MINUTES_MAX },
  tokenLifetimeDays: { min: TOKEN_LIFETIME_DAYS_MIN, max: TOKEN_LIFETIME_DAYS_MAX },
  authRateLimitAttempts: { min: AUTH_RATE_LIMIT_MIN, max: AUTH_RATE_LIMIT_MAX },
} as const;

/** What a PUT accepts: the full policy (every field required). */
export type SecurityPolicyInput = Omit<SecurityPolicy, 'version'>;

export interface SecurityPolicyLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: SecurityPolicy | null;
  newValue: SecurityPolicy;
}

export interface SecurityPolicyForEdit {
  version: number;
  policy: SecurityPolicy;
  defaults: SecurityPolicy;
  bounds: typeof SECURITY_POLICY_BOUNDS;
  lastChange: SecurityPolicyLastChange | null;
}

/** Thrown by setSecurityPolicy when the PUT body is invalid (route maps it to a 400). */
export class SecurityPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityPolicyValidationError';
  }
}

/* ====================================================================
   PURE RESOLVERS — clamp any candidate into its code bounds.
   Enforcement points use these (never the raw stored value), so a
   stored value below the A1 floor of 5 still enforces 5, and a
   stored token lifetime above 30 still mints at most 30 days.
==================================================================== */

/** A1: floor 5, ceiling 32; unusable input → default 8. */
export function resolvePasswordMinLength(value?: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SECURITY_POLICY.passwordMinLength;
  return Math.min(PASSWORD_MIN_LENGTH_CEILING, Math.max(PASSWORD_MIN_LENGTH_FLOOR, n));
}

/** A8: bounded 5–100; unusable input → default 20. */
export function resolveAuthRateLimitAttempts(value?: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return AUTH_RATE_LIMIT_DEFAULT;
  return Math.min(AUTH_RATE_LIMIT_MAX, Math.max(AUTH_RATE_LIMIT_MIN, n));
}

/** A9 threshold: bounded 3–50; unusable input → default 10. */
export function resolveLockoutThreshold(value?: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SECURITY_POLICY.lockoutThreshold;
  return Math.min(LOCKOUT_THRESHOLD_MAX, Math.max(LOCKOUT_THRESHOLD_MIN, n));
}

/** A9 duration: bounded 5–1440 minutes; unusable input → default 30. */
export function resolveLockoutMinutes(value?: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SECURITY_POLICY.lockoutMinutes;
  return Math.min(LOCKOUT_MINUTES_MAX, Math.max(LOCKOUT_MINUTES_MIN, n));
}

/** Lenient normalisation of any stored/loaded candidate (never throws). */
export function normalizeSecurityPolicy(value: unknown): SecurityPolicy {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  return {
    version: Number.isInteger(v.version) && (v.version as number) >= 0 ? v.version : 0,
    passwordMinLength: resolvePasswordMinLength(v.passwordMinLength),
    lockoutEnabled: v.lockoutEnabled !== false,
    lockoutThreshold: resolveLockoutThreshold(v.lockoutThreshold),
    lockoutMinutes: resolveLockoutMinutes(v.lockoutMinutes),
    tokenLifetimeDays: resolveTokenLifetimeDays(v.tokenLifetimeDays),
    authRateLimitAttempts: resolveAuthRateLimitAttempts(v.authRateLimitAttempts),
  };
}

/**
 * Strict validation of a PUT body. Returns error strings (empty =
 * valid). Out-of-range values are REFUSED here (400) — the
 * resolvers above only clamp what is already stored, so a bad
 * stored value degrades to the bounds instead of being saved.
 */
export function validateSecurityPolicyInput(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Security policy must be an object.'];
  }
  const body = input as Record<string, any>;
  const errors: string[] = [];
  const required = [
    'passwordMinLength', 'lockoutEnabled', 'lockoutThreshold',
    'lockoutMinutes', 'tokenLifetimeDays', 'authRateLimitAttempts',
  ] as const;
  for (const key of required) {
    if (body[key] === undefined) errors.push(`${key} is required.`);
  }
  if (errors.length > 0) return errors;
  if (typeof body.lockoutEnabled !== 'boolean') {
    errors.push('lockoutEnabled must be true or false.');
  }
  const intIn = (key: string, min: number, max: number, label: string) => {
    const v = body[key];
    if (!Number.isInteger(v)) errors.push(`${key} must be a whole number.`);
    else if (v < min || v > max) errors.push(`${label} must be between ${min} and ${max}.`);
  };
  intIn('passwordMinLength', PASSWORD_MIN_LENGTH_FLOOR, PASSWORD_MIN_LENGTH_CEILING,
    'Minimum password length');
  intIn('lockoutThreshold', LOCKOUT_THRESHOLD_MIN, LOCKOUT_THRESHOLD_MAX,
    'Lockout threshold');
  intIn('lockoutMinutes', LOCKOUT_MINUTES_MIN, LOCKOUT_MINUTES_MAX,
    'Lockout duration');
  intIn('tokenLifetimeDays', TOKEN_LIFETIME_DAYS_MIN, TOKEN_LIFETIME_DAYS_MAX,
    'Token lifetime');
  intIn('authRateLimitAttempts', AUTH_RATE_LIMIT_MIN, AUTH_RATE_LIMIT_MAX,
    'Login rate limit');
  return errors;
}

/* ====================================================================
   READS — one Metadata row, fail closed to the code defaults.
==================================================================== */

async function readStoredPolicyDb(): Promise<SecurityPolicy | null> {
  try {
    const result = await getPool().query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2 LIMIT 1`,
      [SECURITY_POLICY_OPTION_TYPE, SECURITY_POLICY_CONFIG_OPTION_VALUE]
    );
    const meta = result.rows[0]?.meta;
    if (meta == null) return null;
    if (typeof meta !== 'object' || Array.isArray(meta)) {
      console.warn('[security-policy] stored policy is malformed — falling back to code defaults.');
      return null;
    }
    return normalizeSecurityPolicy(meta);
  } catch (error: any) {
    console.warn('[security-policy] stored policy unavailable, using code defaults:', error?.message || error);
    return null;
  }
}

function readStoredPolicyFallback(): SecurityPolicy | null {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  const cfgRow = rows.find(
    (o: any) => o.type === SECURITY_POLICY_OPTION_TYPE && o.value === SECURITY_POLICY_CONFIG_OPTION_VALUE
  );
  if (!cfgRow?.meta || typeof cfgRow.meta !== 'object') return null;
  return normalizeSecurityPolicy(cfgRow.meta);
}

async function readStoredPolicy(): Promise<SecurityPolicy | null> {
  if (!useDb()) return readStoredPolicyFallback();
  return readStoredPolicyDb();
}

/** The current effective policy (code defaults whenever unset/unreadable). */
export async function getSecurityPolicy(): Promise<SecurityPolicy> {
  const stored = await readStoredPolicy();
  return stored ?? { ...DEFAULT_SECURITY_POLICY };
}

/** A1 — the effective minimum password length (floor 5 enforced). */
export async function getPasswordMinLength(): Promise<number> {
  return (await getSecurityPolicy()).passwordMinLength;
}

/** A5 — the effective token lifetime in days (bounded 1–30). */
export async function getTokenLifetimeDays(): Promise<number> {
  return (await getSecurityPolicy()).tokenLifetimeDays;
}

/** A8 — the effective failed-sign-in limit per 15 min per IP (bounded 5–100). */
export async function getAuthRateLimitAttempts(): Promise<number> {
  return (await getSecurityPolicy()).authRateLimitAttempts;
}

export interface LockoutConfig {
  enabled: boolean;
  threshold: number;
  minutes: number;
}

/** A9 — the effective lockout switch + threshold + duration. */
export async function getLockoutConfig(): Promise<LockoutConfig> {
  const policy = await getSecurityPolicy();
  return {
    enabled: policy.lockoutEnabled,
    threshold: policy.lockoutThreshold,
    minutes: policy.lockoutMinutes,
  };
}

/** The stored version (0 when the policy was never saved). */
export async function getSecurityPolicyVersion(): Promise<number> {
  const stored = await readStoredPolicy();
  return stored?.version ?? 0;
}

/** The latest DZ-4 change, from the audit log (null when never changed). */
export async function getLastSecurityPolicyChange(): Promise<SecurityPolicyLastChange | null> {
  if (!useDb()) return null;
  try {
    const result = await getPool().query(
      `SELECT actor_user_id, created_at, metadata FROM audit_logs
        WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [SECURITY_POLICY_AUDIT_ACTION]
    );
    const row = result.rows[0];
    if (!row) return null;
    const meta = (row.metadata || {}) as Record<string, any>;
    return {
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      version: typeof meta.version === 'number' ? meta.version : 0,
      oldValue: meta.oldValue ? normalizeSecurityPolicy(meta.oldValue) : null,
      newValue: normalizeSecurityPolicy(meta.newValue),
    };
  } catch {
    return null;
  }
}

/** Full GET payload for the Danger Zone editor. */
export async function getSecurityPolicyForEdit(): Promise<SecurityPolicyForEdit> {
  const stored = await readStoredPolicy();
  const policy = stored ?? { ...DEFAULT_SECURITY_POLICY };
  const lastChange = await getLastSecurityPolicyChange();
  return {
    version: stored?.version ?? 0,
    policy,
    defaults: { ...DEFAULT_SECURITY_POLICY },
    bounds: SECURITY_POLICY_BOUNDS,
    lastChange,
  };
}

/* ====================================================================
   WRITES — validate, version+1, audit old→new.
==================================================================== */

async function upsertPolicyRowDb(stored: SecurityPolicy): Promise<void> {
  const meta = JSON.stringify(stored);
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, SECURITY_POLICY_OPTION_TYPE, SECURITY_POLICY_CONFIG_OPTION_VALUE]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'SecurityPolicy', 'Security Policy',
              'Security policy config (Danger Zone, DZ-4).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'SecurityPolicy')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('SecurityPolicy', $1, $2, 1, FALSE, TRUE, $3::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [SECURITY_POLICY_CONFIG_OPTION_VALUE, SECURITY_POLICY_CONFIG_OPTION_LABEL, meta]
    );
  }
}

function setPolicyFallback(stored: SecurityPolicy): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === SECURITY_POLICY_OPTION_TYPE && o.value === SECURITY_POLICY_CONFIG_OPTION_VALUE
  );
  if (existing) existing.meta = { ...stored };
  else {
    store.options.push({
      id: `security-policy-${SECURITY_POLICY_CONFIG_OPTION_VALUE}`,
      type: SECURITY_POLICY_OPTION_TYPE,
      value: SECURITY_POLICY_CONFIG_OPTION_VALUE,
      label: SECURITY_POLICY_CONFIG_OPTION_LABEL,
      status: 'Active',
      sortOrder: 1,
      meta: { ...stored },
    });
  }
}

/**
 * Persist a full policy (PUT). Validates server-side, increments
 * the version, and audit-logs old→new. Throws
 * SecurityPolicyValidationError naming the problem — the route maps
 * it to a 400. The audit row carries the effective old and new
 * policies; the old→new detail is rendered only inside the Danger
 * Zone (Q2).
 */
export async function setSecurityPolicy(
  input: SecurityPolicyInput,
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<SecurityPolicyForEdit> {
  const problems = validateSecurityPolicyInput(input);
  if (problems.length > 0) throw new SecurityPolicyValidationError(problems.join(' '));

  const before = await getSecurityPolicy();
  const storedBefore = await readStoredPolicy();
  const version = (storedBefore?.version ?? 0) + 1;
  const next: SecurityPolicy = { version, ...(input as SecurityPolicy) };

  if (!useDb()) {
    setPolicyFallback(next);
  } else {
    await upsertPolicyRowDb(next);
  }
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: SECURITY_POLICY_AUDIT_ACTION,
    entityType: 'security_policy',
    entityId: null,
    metadata: {
      key: 'securityPolicy',
      version,
      oldValue: before,
      newValue: next,
      ip: opts.ip || undefined,
    },
  });
  return {
    version,
    policy: next,
    defaults: { ...DEFAULT_SECURITY_POLICY },
    bounds: SECURITY_POLICY_BOUNDS,
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
   PER-ACCOUNT LOCKOUT (A9) — the login flow's read/write side.
   --------------------------------------------------------------------
   The columns are migration-022's; the values are the live policy's.
   Every function here is best-effort by contract: a fixture schema
   that predates migration 022 (no columns) must never turn a login
   into a 500 — the failure is warned, the login proceeds with the
   per-IP limiter (A8) as the remaining layer. In production the
   columns exist (migrations auto-run), so a warning here means a
   real problem, not a normal path.
==================================================================== */

export interface LockoutCheck {
  locked: boolean;
  lockedUntil: string | null;
}

/**
 * Pure read-side check against a user row (USER_SELECT `u.*` carries
 * the columns when they exist; undefined when the schema predates
 * migration 022 — treated as not locked). The policy gate belongs
 * to the caller: when lockout is disabled, this is never consulted.
 */
export function checkAccountLockout(userRow: any): LockoutCheck {
  const raw = userRow?.locked_until ?? userRow?.lockedUntil ?? null;
  if (!raw) return { locked: false, lockedUntil: null };
  const until = new Date(raw).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) return { locked: false, lockedUntil: null };
  return { locked: true, lockedUntil: new Date(until).toISOString() };
}

export interface FailedLoginResult {
  attempts: number;
  lockedUntil: string | null;
  justLocked: boolean;
}

/**
 * Record one failed login: increment the counter and, when the
 * counter reaches the live threshold, stamp locked_until = now +
 * duration. One atomic UPDATE, so concurrent failures cannot lose
 * a count. Returns the post-update state (null when the write
 * could not happen — the caller still answers 401/423 from the
 * pre-check, never from this).
 */
export async function recordFailedLoginAttempt(
  userId: string,
  lockout: LockoutConfig
): Promise<FailedLoginResult | null> {
  if (!useDb()) return null; // demo mode keeps its counters on the fallback user object
  try {
    // TZ-proof expiry: locked_until is a TIMESTAMP (no tz) and the
    // driver parses it back as UTC, while NOW() follows the DB
    // session timezone — under a non-UTC session (e.g. TZ=Asia/Dhaka
    // in tests) NOW() + interval stored a wall time hours ahead of
    // the instant it meant (a 30-min lock read back as ~390 min).
    // Compute the expiry in JS (UTC) and store the UTC wall-clock
    // string, which round-trips exactly in any session timezone.
    // (updated_at stays NOW(): bookkeeping only, never compared.)
    const lockedUntilUtc = new Date(Date.now() + lockout.minutes * 60000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const result = await getPool().query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                THEN $3::timestamp
                ELSE locked_until END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING failed_login_attempts, locked_until`,
      [userId, lockout.threshold, lockedUntilUtc]
    );
    const row = result.rows[0];
    if (!row) return null;
    const lockedUntil = row.locked_until ? new Date(row.locked_until).toISOString() : null;
    return {
      attempts: Number(row.failed_login_attempts) || 0,
      lockedUntil,
      justLocked: lockedUntil !== null && Number(row.failed_login_attempts) >= lockout.threshold,
    };
  } catch (error: any) {
    console.warn('[security-policy] failed-login counter write failed:', error?.message || error);
    return null;
  }
}

/**
 * Clear the counter + lock (successful login, password change, admin
 * reset, admin early-unlock). Best-effort: never fails the caller.
 */
export async function clearFailedLoginAttempts(userId: string): Promise<void> {
  if (!useDb()) return;
  try {
    await getPool().query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [userId]
    );
  } catch (error: any) {
    console.warn('[security-policy] failed-login counter clear failed:', error?.message || error);
  }
}
