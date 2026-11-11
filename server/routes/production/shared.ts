/**
 * production/shared.ts — shared foundation for the production router tree.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the helpers that used to sit
 * at the top of production.routes.ts and are needed by more than one
 * route domain — environment/JWT foundations, the auth middleware,
 * the access-change audit writer, role seeding, the user row mapper
 * and the per-request caller resolution.
 *
 * ONE definition rule: a helper lives here exactly once; both
 * production.routes.ts and the extracted domain routers
 * (production/*.routes.ts) import it from this module.
 */

import jwt from 'jsonwebtoken';
import { isWeakJwtSecret } from '../../config/env.js';
import { getPool, isDatabaseConfigured } from '../../database/connection.js';
import { fallbackStore } from '../../fallbackStore.js';
import { resolveVisibility } from '../../authz.js';
import { applyDefaultRoleAccess } from '../../database/roleAccessDefaults.js';
import { getUserDepartmentIds } from '../../utils/departmentMirror.js';
import { storedTimestampIso } from '../../utils/businessTime.js';
import { getRequestMemo } from '../../utils/requestAuthz.js';
import { logAuthTokenRejected } from '../../observability/events.js';
import { DEFAULT_STATUS_DICTIONARY } from '../leadImport.js';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

export const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

if (IS_PRODUCTION && isWeakJwtSecret(process.env.JWT_SECRET)) {
  console.error(
    '❌ JWT_SECRET is not configured, or is a known weak/default value. ' +
      'Authentication will refuse to sign tokens in production. ' +
      'Set a strong, production-specific secret (see docs/PRODUCTION_READINESS.md).'
  );
}

export function useDb(): boolean {
  return isDatabaseConfigured();
}

export function demoModeAllowed(): boolean {
  return !IS_PRODUCTION && !useDb();
}

/**
 * When DB is required but missing/unusable, send the right error instead
 * of silently switching to an in-memory store.
 */
export function sendDbUnavailable(res: any): boolean {
  if (useDb()) return false; // DB configured - callers must handle query errors
  if (!demoModeAllowed()) {
    res.status(503).json({
      success: false,
      message: 'Database is not configured. Set DATABASE_URL on the server, or start in development mode without it.',
      mode: 'db-unconfigured',
    });
    return true;
  }
  return false;
}

export function normalizeRole(value?: string): string {
  if (!value) return 'EMPLOYEE';
  return String(value).trim().toUpperCase();
}

export function signToken(payload: Record<string, any>): string {
  if (IS_PRODUCTION && isWeakJwtSecret(process.env.JWT_SECRET)) {
    throw new Error(
      'JWT_SECRET is not configured, or is a known weak/default value. ' +
        'Refusing to sign a token in production.'
    );
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function getAuthUser(req: any): any {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET) as any;
  } catch {
    return null;
  }
}

/**
 * Observability only: when a Bearer token was PRESENTED but failed
 * verification, emit one safe `auth_token_rejected` event (reason
 * 'expired' | 'invalid'). Anonymous requests (no header) stay silent.
 * Never logs the token, the header or any claim.
 */
export function logRejectedTokenIfPresent(req: any): void {
  const header = req?.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return;
  try {
    jwt.verify(header.slice(7), JWT_SECRET);
  } catch (error: any) {
    logAuthTokenRejected({ reason: error?.name === 'TokenExpiredError' ? 'expired' : 'invalid' });
  }
}

export function requireAuth(req: any, res: any, next: any): void {
  const user = getAuthUser(req);
  if (!user) {
    logRejectedTokenIfPresent(req);
    res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    return;
  }
  req.currentUser = user;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: any, res: any, next: any): void => {
    const currentRole = normalizeRole(req.currentUser?.role || req.currentUser?.roleCode);
    if (!roles.some(role => normalizeRole(role) === currentRole)) {
      res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
}

/** requireAuth + (requireRole ADMIN when DB is configured). In dev demo mode
 *  only authentication is required so the local demo stays usable. */
export function requireAdmin(req: any, res: any, next: any): void {
  if (!req.currentUser) {
    res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    return;
  }
  const role = normalizeRole(req.currentUser.role || req.currentUser.roleCode);
  if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
    res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    return;
  }
  next();
}

export function callerIsAdmin(req: any): boolean {
  const role = normalizeRole(req.currentUser?.role || req.currentUser?.roleCode);
  return role === 'ADMIN' || role === 'SUPERADMIN';
}

/**
 * Access-change audit (F16 Phase B / §7 of the user-management design note).
 *
 * Why these writes exist: "which admin changed whose access, and when" is
 * exactly what an audit trail is for, and this product answered 403s for
 * every read on a database where nobody had opened Roles & Access yet —
 * so access changes are the first thing anyone will argue about later.
 * Today the only audit writers were the password-change flow and the bulk
 * user import; role/permission edits left no trace at all.
 *
 * Best-effort by design: a minimal schema in the wild may lack
 * `audit_logs` (some fixtures predate migration 032), and an audit write
 * failing must NEVER turn a successful access change into a 500 — the
 * same lesson as the `granted_at` regression. Failures are logged, the
 * mutation stands.
 *
 * `metadata` is capped so one bulk edit cannot post an unbounded JSONB
 * document: the arrays carry at most AUDIT_CHANGE_CAP entries and always
 * carry the true totals.
 */
export const AUDIT_CHANGE_CAP = 50;

export function summarizeAccessChanges(changes: Array<{ code: string; allowed: boolean }>): {
  total: number;
  granted: string[];
  denied: string[];
  truncated: boolean;
} {
  const granted = changes.filter(c => c.allowed).map(c => c.code);
  const denied = changes.filter(c => !c.allowed).map(c => c.code);
  return {
    total: changes.length,
    granted: granted.slice(0, AUDIT_CHANGE_CAP),
    denied: denied.slice(0, AUDIT_CHANGE_CAP),
    truncated: granted.length > AUDIT_CHANGE_CAP || denied.length > AUDIT_CHANGE_CAP,
  };
}

export async function logAccessChange(entry: {
  actorId?: string | null;
  targetUserId?: string | null;
  actionCode: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!useDb()) return; // demo mode has no ledger to write to
  try {
    await getPool().query(
      `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        entry.actorId || null,
        entry.targetUserId || null,
        entry.actionCode,
        entry.entityType,
        entry.entityId || null,
        JSON.stringify(entry.metadata || {}),
      ]
    );
  } catch (error: any) {
    console.warn(`Access-change audit write failed (${entry.actionCode}):`, error?.message || error);
  }
}

/** True when `ref` identifies the authenticated caller (uuid, employee id or email). */
export function isSelfRef(req: any, ref: any): boolean {
  if (!req.currentUser || ref == null) return false;
  const value = String(ref).trim();
  if (!value) return false;
  const candidates = [req.currentUser.id, req.currentUser.employeeId, req.currentUser.email]
    .filter(Boolean)
    .map((entry: any) => String(entry).trim());
  return candidates.some(entry =>
    entry === value || entry.toUpperCase() === value.toUpperCase()
  );
}

/** Translate low-level database failures into HTTP 503 (unavailable). */
export function dbErrorStatus(error: any): number {
  if (!error) return 500;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  if (['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','57P01','57P03','08001','08006','08004','53300'].includes(code)) {
    return 503;
  }
  if (/(connection|timeout|reachable|pool|unavailable)/i.test(msg)) return 503;
  return 500;
}

export function sendJson(res: any, status: number, payload: any): void {
  if (demoModeAllowed()) {
    res.setHeader('X-Data-Mode', 'dev-demo');
  }
  res.status(status).json(payload);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asUuid = (value: any): string | null => (value && UUID_RE.test(String(value)) ? String(value) : null);

/**
 * Strict canonical-lowercase UUID test for query-shape optimization.
 * PostgreSQL renders uuid::text in canonical lowercase, so a predicate
 * like `col::text = $1` can only match when $1 is already canonical
 * lowercase. Only in that case may we rewrite it to the sargable
 * `col = $1::uuid` with EXACTLY the same result set; uppercase or
 * non-UUID inputs keep the legacy (no-match) behavior.
 */
export const isCanonicalLowerUuid = (value: unknown): boolean => {
  const s = String(value ?? '');
  return UUID_RE.test(s) && s === s.toLowerCase();
};

export const jsonbOr = (value: any, fallback: any = null): any => {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
};

/* ====================================================================
   DEFAULT ROLES
==================================================================== */

export const DEFAULT_ROLES: Array<{ code: string; name: string; level: number }> = [
  { code: 'ADMIN', name: 'Administrator', level: 1 },
  { code: 'CEO', name: 'Chief Executive Officer', level: 1 },
  { code: 'MANAGER', name: 'Manager', level: 2 },
  { code: 'TEAM_LEAD', name: 'Team Lead', level: 3 },
  { code: 'EMPLOYEE', name: 'Employee', level: 4 },
  { code: 'SM', name: 'Sales Manager', level: 2 },
  { code: 'BDM', name: 'Business Development Manager', level: 3 },
  { code: 'SBE', name: 'Senior Business Executive', level: 4 },
  { code: 'BE', name: 'Business Executive', level: 5 },
];

let rolesEnsured = false;

/** Seeds default roles when the roles table is empty (idempotent). */
export async function ensureDefaultRoles(): Promise<void> {
  if (rolesEnsured || !useDb()) return;
  const pool = getPool();
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM roles');
  const count = countResult.rows[0]?.count ?? 0;
  if (count === 0) {
    for (const role of DEFAULT_ROLES) {
      await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW(), NOW())
         ON CONFLICT (role_code) DO NOTHING`,
        [role.code, role.name, role.level]
      );
    }
  } else {
    // Existing databases: guarantee the business ladder has a Level-1 (CEO)
    // role available even when the table was seeded before it existed.
    const inserted = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, is_active, created_at, updated_at)
       VALUES ('CEO', 'Chief Executive Officer', 1, TRUE, NOW(), NOW())
       ON CONFLICT (role_code) DO NOTHING`
    );
    if ((inserted.rowCount ?? 0) > 0) {
      // A role must never be born unconfigured: give the brand-new row the
      // same guarded defaults the seed step gives the standard roles, so an
      // install that predates this fix does not end up with a CEO who cannot
      // read a single page (F3/F4). The routine is idempotent and skips any
      // role that already holds a grant, so an admin's matrix is untouched.
      await applyDefaultRoleAccess();
    }
  }
  rolesEnsured = true;
}

/** Resolve (and if necessary create) a role row for a role code. */
export async function resolveRoleId(roleCode: string): Promise<string | null> {
  const pool = getPool();
  await ensureDefaultRoles();
  const code = normalizeRole(roleCode);
  let result = await pool.query('SELECT id FROM roles WHERE UPPER(role_code) = $1 LIMIT 1', [code]);
  if (result.rows[0]) return result.rows[0].id;
  result = await pool.query(
    `INSERT INTO roles (role_code, role_name, hierarchy_level, is_active, created_at, updated_at)
     VALUES ($1, $2, 99, TRUE, NOW(), NOW())
     ON CONFLICT (role_code) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [code, code]
  );
  return result.rows[0]?.id || null;
}

export function mapUserRow(row: any, managerEmployeeId?: string | null) {
  const isInactive =
    row.is_active === false || String(row.account_status || '').toUpperCase() === 'INACTIVE';
  const role = row.role_code || 'EMPLOYEE';
  return {
    id: row.id,
    employeeId: row.employee_id,
    fullName: row.full_name,
    name: row.full_name,
    email: row.email || '',
    phone: row.phone || '',
    role,
    roleCode: role,
    roleName: row.role_name || role,
    status: isInactive ? 'Inactive' : 'Active',
    accountStatus: (row.account_status || (row.is_active === false ? 'INACTIVE' : 'ACTIVE')).toUpperCase(),
    isActive: !isInactive,
    designation: row.designation || '',
    departmentId: row.department_id || '',
    /**
     * F16 Phase D: the person's ACTIVE department memberships (primary seat
     * plus any extra one). The client's FullTeam mirror reads this, so a head
     * who leads several departments sees all of them; when the memberships
     * were not attached the list is empty and the primary column stands.
     */
    departmentIds: Array.isArray(row.department_ids) ? row.department_ids.map(String) : [],
    /**
     * Phase E: how many OPEN leads this person owns (null when the caller
     * did not load the counts). The Users screen warns before a deactivation;
     * the server refuses one that would strand them either way.
     */
    openLeadCount: row.open_lead_count === undefined || row.open_lead_count === null
      ? null
      : Number(row.open_lead_count),
    teamId: row.team_id || '',
    managerId: managerEmployeeId || row.manager_employee_id || '',
    reportingManagerId: managerEmployeeId || row.manager_employee_id || '',
    avatarUrl: row.profile_photo || '',
    joiningDate: row.joining_date || null,
    lastLogin: row.last_login || null,
    mustChangePassword: row.must_change_password === true,
    reportingChain: jsonbOr(row.reporting_chain, []),
    subordinates: jsonbOr(row.subordinates, []),
    hierarchyLevel: Number(row.hierarchy_level) > 0 ? Number(row.hierarchy_level) : 0,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const USER_SELECT = `
  SELECT u.*, r.role_code, r.role_name, r.hierarchy_level, m.employee_id AS manager_employee_id
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN users m ON m.id = u.manager_id
`;

/**
 * Attach a person's active department memberships before `mapUserRow`, so
 * every user payload that reaches the client carries the same membership list
 * the server's data-visibility layer uses (F16 Phase D). One indexed query;
 * a database without migration 046 simply attaches an empty list.
 */
export async function withMembershipDepartments(
  exec: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  row: any
): Promise<any> {
  if (!row?.id) return { ...row, department_ids: [] };
  const ids = await getUserDepartmentIds(exec, String(row.id));
  return { ...row, department_ids: ids };
}

export const clean = (value: any): string => String(value == null ? '' : value).trim();

export interface CallerDbInfo {
  id: string;
  employee_id: string;
  email: string;
  role_id: string | null;
  role_code: string;
  department_id: string | null;
}

/**
 * Resolve caller to DB record (or fallbackStore in dev-demo).
 * Memoized per HTTP request: a route that authorizes several times
 * (guard + handler, multiple permission codes) performs the caller
 * lookup exactly once.
 */
export async function getCallerDbInfo(req: any): Promise<CallerDbInfo | null> {
  const memo = getRequestMemo(req);
  if (memo?.callerPromise) return memo.callerPromise as Promise<CallerDbInfo | null>;
  const promise = resolveCallerDbInfo(req);
  if (memo) memo.callerPromise = promise;
  return promise;
}

async function resolveCallerDbInfo(req: any): Promise<CallerDbInfo | null> {
  const rawId = String(req.currentUser?.id || '').trim();
  const rawEmp = String(req.currentUser?.employeeId || '').trim();
  const rawEmail = String(req.currentUser?.email || '').trim();
  if (!useDb()) {
    const user = fallbackStore.users.find(u =>
      (rawId && u.id === rawId) ||
      (rawEmp && u.employeeId.toUpperCase() === rawEmp.toUpperCase()) ||
      (rawEmail && u.email.toLowerCase() === rawEmail.toLowerCase())
    );
    if (!user) return null;
    return {
      id: user.id,
      employee_id: user.employeeId,
      email: user.email,
      role_id: null,
      role_code: normalizeRole(user.roleCode || user.role),
      department_id: (user as any).departmentId || null,
    };
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT u.id, u.employee_id, u.email, u.role_id, u.department_id, r.role_code
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($2) OR UPPER(u.email) = UPPER($3)
       LIMIT 1`,
      [rawId || rawEmp || rawEmail, rawEmp || rawId, rawEmail || rawId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      employee_id: row.employee_id,
      email: row.email || '',
      role_id: row.role_id || null,
      role_code: row.role_code || normalizeRole(req.currentUser?.role || req.currentUser?.roleCode),
      department_id: row.department_id || null,
    };
  } catch {
    return null;
  }
}

export async function adminExistsInDb(): Promise<boolean> {
  if (!useDb()) {
    return fallbackStore.users.some(u => normalizeRole(u.role) === 'ADMIN' || normalizeRole(u.roleCode) === 'ADMIN');
  }
  await ensureDefaultRoles();
  const pool = getPool();
  const result = await pool.query(
    `SELECT 1 FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE UPPER(r.role_code) IN ('ADMIN', 'SUPERADMIN')
     LIMIT 1`
  );
  return result.rows.length > 0;
}

export const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,29}$/;

/* ====================================================================
   CALLER AUTHORIZATION + LEAD LOOKUP (Phase 1, notifications step)
   ------------------------------------------------------------------
   The permission/visibility cluster and the lead-row lookup that the
   notifications domain shares with the leads/users domains. Moved
   verbatim from production.routes.ts; the monolith imports them back
   and re-exports the public surface its test suite consumes.
==================================================================== */

export interface CallerVisibilityResult {
  /** true = unrestricted (sees everyone) */
  all: boolean;
  userIds: string[];
  employeeIds: string[];
}

/**
 * Per-caller authorization memo. The caller object is created once per
 * HTTP request (and shared by reference only within that request), so
 * memoizing on it is request-scoped: no authorization result ever leaks
 * across requests or users, and nothing survives longer than one request.
 */
interface CallerAuthzMemo {
  permissions: Map<string, Promise<boolean>>;
  visibility: Promise<CallerVisibilityResult> | null;
}

function callerMemo(caller: CallerDbInfo): CallerAuthzMemo {
  let memo = (caller as any).__authzMemo as CallerAuthzMemo | undefined;
  if (!memo) {
    memo = { permissions: new Map(), visibility: null };
    (caller as any).__authzMemo = memo;
  }
  return memo;
}

/** Check if caller has a specific permission code (admin bypass).
 *
 * Resolution semantics (unchanged from the previous sequential lookups):
 *   ADMIN/SUPERADMIN            -> allow
 *   permission definition missing -> deny (fail closed)
 *   user override row exists     -> its is_allowed wins (precedence)
 *   else role grant row exists   -> its is_allowed
 *   else                         -> deny (fail closed)
 *   DB error                     -> deny (fail closed)
 *
 * The three lookups now run as ONE join, and each (caller, code) result is
 * memoized for the lifetime of the caller object — i.e. a single request —
 * so a route checking several codes pays for the resolution once.
 */
export async function hasPermissionCode(caller: CallerDbInfo | null, permissionCode: string): Promise<boolean> {
  if (!caller) return false;
  const role = normalizeRole(caller.role_code);
  if (role === 'ADMIN' || role === 'SUPERADMIN') return true;
  if (!useDb()) {
    // Demo mode: allow only when caller exists, but still fail closed for unknown codes if we want strictness.
    // For dev-demo usability, allow known lead codes; unknown codes deny.
    const knownLeadCodes = new Set(['leads.view','leads.create','leads.edit','leads.delete','leads.assign','leads.transfer','leads.import','leads.export']);
    if (!knownLeadCodes.has(permissionCode)) return false;
    return true;
  }
  const memo = callerMemo(caller);
  const cached = memo.permissions.get(permissionCode);
  if (cached) return cached;
  const resolution = (async () => {
    try {
      const pool = getPool();
      // One round trip: definition + user override + role grant.
      // Zero rows => the permission definition does not exist.
      // Row presence is detected via the NOT NULL composite-PK column
      // (neither grant table has a surrogate id column).
      const result = await pool.query(
        `SELECT
           up.permission_id IS NOT NULL  AS has_user_override,
           up.is_allowed             AS user_override_allowed,
           rp.permission_id IS NOT NULL  AS has_role_grant,
           rp.is_allowed             AS role_grant_allowed
         FROM (SELECT id FROM permissions WHERE permission_code = $3 LIMIT 1) p
         LEFT JOIN user_permissions up ON up.permission_id = p.id AND up.user_id = $1
         LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $2`,
        [caller.id, caller.role_id || null, permissionCode]
      );
      if (result.rows.length === 0) {
        // Fail closed: missing permission definition => deny
        console.warn(`Permission definition missing for ${permissionCode} - denying access`);
        return false;
      }
      const row = result.rows[0];
      if (row.has_user_override) {
        return row.user_override_allowed === true;
      }
      if (row.has_role_grant) {
        return row.role_grant_allowed === true;
      }
      // No explicit grant => deny (fail closed)
      return false;
    } catch (e) {
      console.warn(`Permission check failed for ${permissionCode}:`, (e as any)?.message || e);
      // Fail closed on DB error
      return false;
    }
  })();
  memo.permissions.set(permissionCode, resolution);
  return resolution;
}

/**
 * requireAuth + canonical permission grant (permissions × role_permissions
 * × user_permissions, resolved through hasPermissionCode).
 *
 * Semantics (fail closed everywhere):
 *   - unauthenticated                    -> 401
 *   - caller not resolvable              -> 403
 *   - ADMIN / SUPERADMIN                 -> allowed (bypass inside
 *                                           hasPermissionCode — behavior
 *                                           identical to the previous
 *                                           requireAdmin gate)
 *   - permission definition missing      -> deny
 *   - no explicit grant row              -> deny
 *   - database failure                   -> deny (503)
 *   - unknown permission code            -> deny
 *
 * Used for the administration mutations that map 1:1 to canonical action
 * codes exposed in the Roles & Access editor (users.create, users.edit,
 * users.delete, roles.manage, permissions.manage, departments.manage,
 * teams.manage, hierarchy.manage, settings.manage). Capability is granted
 * ONLY by an explicit canonical grant row — never by a Feature Access
 * menu toggle.
 */
export function requirePermissionCode(permissionCode: string) {
  return async (req: any, res: any, next: any): Promise<void> => {
    if (!req.currentUser) {
      res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
      return;
    }
    try {
      const caller = await getCallerDbInfo(req);
      if (!caller) {
        res.status(403).json({ success: false, message: 'Your account was not found. Please log in again.' });
        return;
      }
      if (!(await hasPermissionCode(caller, permissionCode))) {
        res.status(403).json({
          success: false,
          message: 'You do not have permission to perform this action.',
          permission: permissionCode,
        });
        return;
      }
      next();
    } catch (error: any) {
      console.error(`Permission gate failed for ${permissionCode}:`, error?.message || error);
      res.status(503).json({ success: false, message: 'Authorization service unavailable.' });
    }
  };
}

/** Resolve visibility for caller (admin => all).
 *  Memoized per caller instance (one request): routes that scope reads
 *  AND authorize writes resolve the visibility set once. */
export async function resolveCallerVisibility(caller: CallerDbInfo): Promise<CallerVisibilityResult> {
  if (!caller) return { all: false, userIds: [], employeeIds: [] };
  const role = normalizeRole(caller.role_code);
  if (role === 'ADMIN' || role === 'SUPERADMIN') {
    return { all: true, userIds: [], employeeIds: [] };
  }
  const memo = callerMemo(caller);
  if (!memo.visibility) {
    memo.visibility = resolveCallerVisibilityOnce(caller);
  }
  return memo.visibility;
}

async function resolveCallerVisibilityOnce(caller: CallerDbInfo) {
  if (!useDb()) {
    // Demo mode: compute the downline from fallbackStore. MANAGER-like
    // roles get their subtree (as before); UM-1 adds the same floor the
    // DB path applies in authz.resolveVisibility — ANY caller with at
    // least one person in their subtree gets that subtree, whatever
    // their role is called. A caller with no reports keeps self-only.
    try {
      const allUsers = fallbackStore.users;
      const callerUser = allUsers.find(u => u.id === caller.id || u.employeeId === caller.employee_id);
      const roleUpper = normalizeRole(caller.role_code);
      const isManagerLike = ['MANAGER','TEAM_LEAD','SM','BDM','CEO'].includes(roleUpper);
      if (callerUser) {
        // BFS downline via managerId
        const visited = new Set<string>();
        const queue: string[] = [callerUser.employeeId];
        const userIds: string[] = [caller.id];
        const employeeIds: string[] = [caller.employee_id];
        visited.add(callerUser.employeeId);
        while (queue.length > 0) {
          const currentEmp = queue.shift()!;
          const directReports = allUsers.filter(u => String(u.managerId || '').toUpperCase() === String(currentEmp).toUpperCase());
          for (const dr of directReports) {
            if (!visited.has(dr.employeeId)) {
              visited.add(dr.employeeId);
              queue.push(dr.employeeId);
              userIds.push(dr.id);
              employeeIds.push(dr.employeeId);
            }
          }
        }
        if (isManagerLike || userIds.length > 1) {
          return { all: false, userIds, employeeIds };
        }
      }
    } catch {}
    return { all: false, userIds: [caller.id], employeeIds: [caller.employee_id] };
  }
  try {
    const vis = await resolveVisibility(caller.id, caller.role_code, caller.department_id);
    if (!vis.all) {
      if (!vis.userIds.includes(caller.id)) vis.userIds.push(caller.id);
      const empUpper = vis.employeeIds.map((e: string) => String(e).toUpperCase());
      if (caller.employee_id && !empUpper.includes(String(caller.employee_id).toUpperCase())) {
        vis.employeeIds.push(caller.employee_id);
      }
    }
    return vis;
  } catch {
    return { all: false, userIds: [caller.id], employeeIds: [caller.employee_id] };
  }
}

/**
 * THE lead-access predicate (row-level twin of buildDashboardVisibilitySql).
 * ------------------------------------------------------------------
 * Organogram Fix 2: one rule everywhere. A lead is accessible to a
 * caller iff the caller's resolved visibility set contains the lead's
 * assignee OR its creator:
 *
 *     assigned_to ∈ visibility.userIds  OR  created_by ∈ visibility.userIds
 *
 * The SQL surfaces (leads list, follow-up queue, dashboard counts,
 * scheduled-activities list) have always used exactly this rule; this
 * checker is what detail/mutation endpoints use, and it must never
 * disagree with them — a lead the list shows must open, and a lead in
 * neither chain stays invisible (callers answer 404, no existence leak).
 *
 * DB rows (an own `assigned_to` property is present): only the
 * assigned_to / created_by COLUMNS count — custom_fields is never an
 * ownership source for PostgreSQL records (a stale custom owner must
 * not resurrect access).
 *
 * fallbackStore rows (demo mode): `assignedTo` carries an employeeId
 * while `createdBy` may carry a users.id (server-written records) or
 * an employeeId (client-shaped seeds), so both arms accept either id
 * space — the same dual-space treatment the assignee arm has always
 * had in demo mode.
 */
export function isLeadAccessible(leadRow: any, visibility: any, caller: CallerDbInfo): boolean {
  if (!leadRow) return false;
  if (visibility.all) return true;
  const userIds: string[] = visibility.userIds || [];
  const inUserScope = (value: string): boolean =>
    Boolean(value) && (userIds.includes(value) || value === caller.id);
  const isDbLeadRow = Object.prototype.hasOwnProperty.call(leadRow, 'assigned_to');
  if (isDbLeadRow) {
    const assignedToId = leadRow.assigned_to ? String(leadRow.assigned_to) : '';
    const createdBy = leadRow.created_by ? String(leadRow.created_by) : '';
    return inUserScope(assignedToId) || inUserScope(createdBy);
  }
  const empIdsUpper = (visibility.employeeIds || []).map((e: string) => String(e).toUpperCase());
  const inEmployeeScope = (value: string): boolean => {
    if (!value) return false;
    const upper = value.toUpperCase();
    return empIdsUpper.includes(upper)
      || Boolean(caller.employee_id) && upper === String(caller.employee_id).toUpperCase();
  };
  const assignedTo = String(leadRow.assignedTo || '').trim();
  const createdBy = leadRow.createdBy
    ? String(leadRow.createdBy)
    : (leadRow.created_by ? String(leadRow.created_by) : '');
  return inUserScope(assignedTo) || inEmployeeScope(assignedTo)
    || inUserScope(createdBy) || inEmployeeScope(createdBy);
}

/**
 * Allows the request when the route param identifies the caller
 * themselves, or when the caller is an administrator. Used for
 * user-scoped reads/writes (own notifications, own permission sheet,
 * own password change) so one authenticated user cannot mutate
 * another user's data.
 */
export function requireSelfOrAdmin(paramName: string) {
  return (req: any, res: any, next: any): void => {
    if (!req.currentUser) {
      res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
      return;
    }
    if (callerIsAdmin(req)) {
      next();
      return;
    }
    if (isSelfRef(req, req.params?.[paramName])) {
      next();
      return;
    }
    res.status(403).json({ success: false, message: 'You can only access your own records.' });
  };
}

/** Resolve a user reference (uuid, employee id, or email) to a users.id. */
export async function resolveUserId(ref: any): Promise<string | null> {
  if (!ref) return null;
  const value = String(ref).trim();
  if (!value) return null;
  const pool = getPool();
  const uuid = asUuid(value);
  const result = await pool.query(
    `SELECT id FROM users
     WHERE id::text = $1 OR UPPER(employee_id) = UPPER($2) OR UPPER(email) = UPPER($2)
     LIMIT 1`,
    [uuid || value, value]
  );
  return result.rows[0]?.id || null;
}

export const LEAD_SELECT = `
  SELECT l.*,
         au.employee_id AS assigned_to_employee_id,
         ab.employee_id AS assigned_by_employee_id
  FROM leads l
  LEFT JOIN users au ON au.id = l.assigned_to
  LEFT JOIN users ab ON ab.id = l.assigned_by
`;

export async function findLeadByIdRaw(leadIdParam: string, forUpdate = false): Promise<any | null> {
  const raw = String(leadIdParam || '').trim();
  if (!raw) return null;
  if (!useDb()) {
    const lead = fallbackStore.leads.find((l: any) => String(l.id) === raw || String((l as any).leadCode) === raw);
    return lead || null;
  }
  const pool = getPool();
  // Note: FOR UPDATE is only valid inside a transaction (client.query). Caller must handle when useDb() but not in tx.
  // This helper is used both inside and outside tx; when forUpdate=true we use SELECT ... FOR UPDATE (caller must be inside tx via client).
  // However to keep helper simple, we just do normal select; the transactional callers will do their own SELECT FOR UPDATE.
  // Sargable dual lookup: lead_code equality OR PK equality. The id branch
  // is only populated for canonical-lowercase UUID input — exactly the
  // inputs that could match the legacy `l.id::text = $1` comparison — so
  // the result set is unchanged while the PK index becomes usable.
  const result = await pool.query(
    `${LEAD_SELECT} WHERE (l.lead_code = $1 OR l.id = $2) AND l.is_deleted = FALSE LIMIT 1`,
    [raw, isCanonicalLowerUuid(raw) ? raw : null]
  );
  return result.rows[0] || null;
}

/**
 * THE lead-visibility SQL predicate — one definition (Organogram
 * Fix 2). Every SQL surface that scopes leads by caller visibility
 * uses this builder: the leads list and the follow-up queue
 * (production/leads.routes.ts), the dashboard handler
 * (production/dashboard.routes.ts) and the scheduled-activities list
 * (production/roadshows.routes.ts). Its row-level twin is
 * isLeadAccessible above; the two must always agree:
 *   accessible ⇔ assigned_to ∈ userIds OR created_by ∈ userIds.
 * (Moved here in Phase 1 PR #6, leads extraction.)
 */
export function buildDashboardVisibilitySql(
  visibility: { all: boolean; userIds: string[]; employeeIds: string[] },
  params: any[]
): string {
  if (visibility.all) return 'TRUE';
  params.push(visibility.userIds);
  const pUser = params.length;
  // UUID-typed ANY (never a ::text cast on the indexed columns):
  // visibility.userIds are users.id values resolved server-side, so the
  // comparison stays sargable and the planner can BitmapOr the existing
  // idx_leads_assigned_to / idx_leads_created_by indexes instead of
  // seq-scanning leads. Result-identical to the previous text cast.
  return `(l.assigned_to = ANY($${pUser}::uuid[]) OR l.created_by = ANY($${pUser}::uuid[]))`;
}

/* ====================================================================
   LEAD VALUE / ASSIGNMENT HELPERS — moved here in Phase 1 PR #4
   (roadshows + scheduled-activities extraction): value conversions,
   assignment resolution and the activity/follow-up row helpers the
   scheduled-activities handlers share with the leads domain. One
   definition, imported by both production.routes.ts and
   production/roadshows.routes.ts.
==================================================================== */

export const dateOrNull = (value: any): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Resolve assignedTo reference to userId + employeeId (+ activity).
 * `isActive` mirrors the bulk-import rule exactly: DB rows read
 * users.is_active (COALESCE TRUE, the same expression bulkResolveUserRefs
 * uses); demo users read the status text (status ?? employmentStatus),
 * with an explicit isActive === false also honoured. Callers that ROUTE
 * work to the resolved user (manual lead assignment) must refuse an
 * inactive target; read-only callers (list/queue filters) ignore it.
 */
export async function resolveAssignedTo(ref: any): Promise<{ userId: string; employeeId: string; isActive: boolean } | null> {
  if (!ref) return null;
  const value = String(ref).trim();
  if (!value) return null;
  if (!useDb()) {
    const user = fallbackStore.users.find(u =>
      u.id === value ||
      u.employeeId.toUpperCase() === value.toUpperCase() ||
      u.email.toLowerCase() === value.toLowerCase()
    );
    if (!user) return null;
    const statusText = String((user as any).status ?? (user as any).employmentStatus ?? 'Active');
    const isActive = (user as any).isActive !== false && statusText.toLowerCase() !== 'inactive';
    return { userId: user.id, employeeId: user.employeeId, isActive };
  }
  try {
    const pool = getPool();
    const uuid = asUuid(value);
    const result = await pool.query(
      `SELECT id, employee_id, COALESCE(is_active, TRUE) AS is_active FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($2) OR UPPER(email) = UPPER($2) LIMIT 1`,
      [uuid || value, value]
    );
    if (!result.rows[0]) return null;
    return { userId: result.rows[0].id, employeeId: result.rows[0].employee_id, isActive: result.rows[0].is_active === true };
  } catch {
    return null;
  }
}

/** Check if caller is allowed to assign a lead to target user. */
export function isAssignedToAllowed(target: { userId: string; employeeId: string } | null, visibility: any, caller: CallerDbInfo): boolean {
  if (!target) return true;
  if (visibility.all) return true;
  if (target.userId && visibility.userIds.includes(target.userId)) return true;
  if (target.userId === caller.id) return true;
  const empUpper = String(target.employeeId || '').toUpperCase();
  const visEmpUpper = (visibility.employeeIds || []).map((e: string) => String(e).toUpperCase());
  if (empUpper && visEmpUpper.includes(empUpper)) return true;
  if (empUpper && caller.employee_id && empUpper === String(caller.employee_id).toUpperCase()) return true;
  return false;
}

/**
 * Fetch canonical FollowUpStatus values (active options). Falls back to
 * DEFAULT_STATUS_DICTIONARY when the options table has no rows (same
 * policy as bulk import, so validation never depends on seed ordering).
 */
export async function getFollowUpStatusValues(): Promise<string[]> {
  if (!useDb()) {
    const opts = fallbackStore.options.filter((o: any) => o.type === 'FollowUpStatus' && o.status !== 'Inactive');
    if (opts.length > 0) return opts.map(o => String(o.value));
    const legacy = fallbackStore.options.filter((o: any) => o.type === 'lead_status' && o.status !== 'Inactive').map(o => String(o.value));
    if (legacy.length > 0) return legacy;
    return DEFAULT_STATUS_DICTIONARY as unknown as string[];
  }
  try {
    let res = await getPool().query(`SELECT option_value FROM options WHERE field_key = 'FollowUpStatus' AND COALESCE(is_active, TRUE) = TRUE`);
    if (res.rows.length > 0) return res.rows.map((r: any) => String(r.option_value));
    // Fallback to legacy key used by some deployments
    res = await getPool().query(`SELECT option_value FROM options WHERE field_key = 'lead_status' AND COALESCE(is_active, TRUE) = TRUE`);
    if (res.rows.length > 0) return res.rows.map((r: any) => String(r.option_value));
  } catch {}
  return DEFAULT_STATUS_DICTIONARY as unknown as string[];
}

export function parseNumeric(value: any): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[,\\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function mapActivityRow(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id || row.leadId,
    activityType: row.activity_type || row.activityType || 'follow_up',
    status: row.status || '',
    remarks: row.remarks || '',
    nextFollowUpAt: row.next_follow_up_at || row.nextFollowUpAt || null,
    nextFollowUpDate: row.next_follow_up_at || row.nextFollowUpAt || null,
    nextCallAt: row.next_call_at || row.nextCallAt || null,
    nextCallDate: row.next_call_at || row.nextCallAt || null,
    meetingAt: row.meeting_at || row.meetingAt || null,
    meetingDate: row.meeting_at || row.meetingAt || null,
    meetingType: row.meeting_type || row.meetingType || null,
    collectedNcp: row.collected_ncp != null ? Number(row.collected_ncp) : (row.collectedNcp ?? null),
    collectedNCP: row.collected_ncp != null ? Number(row.collected_ncp) : (row.collectedNcp ?? null),
    projectedNcp: row.projected_ncp != null ? Number(row.projected_ncp) : (row.projectedNcp ?? null),
    projectedNCP: row.projected_ncp != null ? Number(row.projected_ncp) : (row.projectedNcp ?? null),
    sumAssured: row.sum_assured != null ? Number(row.sum_assured) : (row.sumAssured ?? null),
    sum_assured: row.sum_assured != null ? Number(row.sum_assured) : (row.sumAssured ?? null),
    productName: row.product_name || row.productName || null,
    product_name: row.product_name || row.productName || null,
    lossReason: row.loss_reason || row.lossReason || null,
    loss_reason: row.loss_reason || row.lossReason || null,
    createdBy: row.created_by || row.createdBy || null,
    created_by: row.created_by || row.createdBy || null,
    createdAt: row.created_at || row.createdAt,
    created_at: row.created_at || row.createdAt,
    // Actor employeeId for UI convenience (joined when possible)
    actorEmployeeId: row.actor_employee_id || row.created_by_employee || null,
  };
}

export function mapScheduledActivityRow(row: any) {
  const completedAtRaw = row.completed_at ?? row.completedAt ?? null;
  const completedByRaw = row.completed_by ?? row.completedBy ?? null;
  const completedActRaw = row.completed_activity_id ?? row.completedActivityId ?? null;
  // Stored TIMESTAMP columns hold UTC wall time (businessTime
  // convention) — serialize via storedTimestampIso so a naive value
  // is read AS UTC, never in the server process's own timezone
  // (`new Date(naive)` would shift the instant, e.g. −6h when the
  // process runs in Asia/Dhaka; the Task Calendar consumes this DTO).
  const ts = (snake: any, camel: any) => storedTimestampIso(snake ?? camel);
  return {
    id: row.id,
    leadId: row.lead_id || row.leadId || null,
    lead_id: row.lead_id || row.leadId || null,
    activityType: row.activity_type || row.activityType,
    activity_type: row.activity_type || row.activityType,
    title: row.title ?? null,
    scheduledAt: ts(row.scheduled_at, row.scheduledAt),
    scheduled_at: ts(row.scheduled_at, row.scheduledAt),
    durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : (row.durationMinutes != null ? Number(row.durationMinutes) : null),
    duration_minutes: row.duration_minutes != null ? Number(row.duration_minutes) : (row.durationMinutes != null ? Number(row.durationMinutes) : null),
    remarks: row.remarks ?? null,
    status: row.status || 'scheduled',
    priority: row.priority || 'NORMAL',
    meetingType: row.meeting_type ?? row.meetingType ?? null,
    meeting_type: row.meeting_type ?? row.meetingType ?? null,
    location: row.location ?? null,
    createdBy: row.created_by || row.createdBy || null,
    created_by: row.created_by || row.createdBy || null,
    assignedTo: row.assigned_to || row.assignedTo || null,
    assigned_to: row.assigned_to || row.assignedTo || null,
    updatedBy: row.updated_by || row.updatedBy || null,
    updated_by: row.updated_by || row.updatedBy || null,
    createdAt: ts(row.created_at, row.createdAt),
    created_at: ts(row.created_at, row.createdAt),
    updatedAt: ts(row.updated_at, row.updatedAt),
    updated_at: ts(row.updated_at, row.updatedAt),
    completedAt: storedTimestampIso(completedAtRaw),
    completed_at: storedTimestampIso(completedAtRaw),
    completedBy: completedByRaw || null,
    completed_by: completedByRaw || null,
    completedActivityId: completedActRaw || null,
    completed_activity_id: completedActRaw || null,
    // Next-step sync provenance (migration 054): non-null only for
    // entries the server keeps in sync with a follow-up's next step.
    sourceActivityId: row.source_activity_id || row.sourceActivityId || null,
    source_activity_id: row.source_activity_id || row.sourceActivityId || null,
    sourceKind: row.source_kind || row.sourceKind || null,
    source_kind: row.source_kind || row.sourceKind || null,
    // Meeting data model (migration 055): minutes before start at
    // which a reminder is wanted (NULL = none), and the attendee list
    // the routes attach after a bulk fetch (empty for rows that carry
    // no invites or on pre-055 schemas, where the routes attach []).
    reminderMinutes: row.reminder_minutes != null ? Number(row.reminder_minutes) : (row.reminderMinutes != null ? Number(row.reminderMinutes) : null),
    reminder_minutes: row.reminder_minutes != null ? Number(row.reminder_minutes) : (row.reminderMinutes != null ? Number(row.reminderMinutes) : null),
    attendees: Array.isArray(row.attendees) ? row.attendees : [],
    leadCustomerName: row.lead_customer_name || row.customer_name || row.leadCustomerName || null,
    leadMobile: row.lead_mobile || row.leadMobile || null,
    leadStatus: row.lead_current_status || row.leadStatus || null,
  };
}

/* ====================================================================
   USER ID / EMPLOYEE ID RESOLUTION — moved from production.routes.ts
   in the Phase 1 users/access extraction (verbatim, one definition):
   managerEmployeeId / employeeIdsFor are called by the users domain
   AND by the leads domain, so they live here; production.routes.ts
   and production/users.routes.ts both import them from this module.
==================================================================== */

export async function managerEmployeeId(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const result = await getPool().query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.employee_id || null;
}

/**
 * Resolve many user UUIDs to employee ids in ONE round trip (primary-key
 * lookup). Replaces sequential per-user lookups on mutation response
 * paths (e.g. a lead save joining assigned_to + assigned_by).
 */
export async function employeeIdsFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.map(i => asUuid(String(i || ''))).filter((v): v is string => !!v)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const result = await getPool().query('SELECT id, employee_id FROM users WHERE id = ANY($1::uuid[])', [unique]);
  for (const row of result.rows) out.set(String(row.id), row.employee_id);
  return out;
}
