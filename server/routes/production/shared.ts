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
import { getRequestMemo } from '../../utils/requestAuthz.js';
import { logAuthTokenRejected } from '../../observability/events.js';

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
    // Demo mode: compute downline from fallbackStore for MANAGER-like roles
    // to allow realistic integration tests without PostgreSQL
    try {
      const allUsers = fallbackStore.users;
      const callerUser = allUsers.find(u => u.id === caller.id || u.employeeId === caller.employee_id);
      const roleUpper = normalizeRole(caller.role_code);
      const isManagerLike = ['MANAGER','TEAM_LEAD','SM','BDM','CEO'].includes(roleUpper);
      if (isManagerLike && callerUser) {
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
        return { all: false, userIds, employeeIds };
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

/** Check if a lead row is accessible to caller via visibility. */
export function isLeadAccessible(leadRow: any, visibility: any, caller: CallerDbInfo): boolean {
  if (!leadRow) return false;
  if (visibility.all) return true;
  // Support both DB row shape (assigned_to, custom_fields, created_by) and fallbackStore shape (assignedTo, customFields, etc)
  const assignedToId = leadRow.assigned_to ? String(leadRow.assigned_to) : (leadRow.assignedTo ? '' : '');
  // Fallback records expose assignedTo directly; PostgreSQL records use
  // assigned_to and never consult custom_fields for ownership.
  const isDbLeadRow = Object.prototype.hasOwnProperty.call(leadRow, 'assigned_to');
  const customAssignedTo = isDbLeadRow ? '' : String(leadRow.assignedTo || '').trim();
  const createdBy = leadRow.created_by ? String(leadRow.created_by) : (leadRow.createdBy ? String(leadRow.createdBy) : '');

  if (assignedToId) {
    if (visibility.userIds.includes(assignedToId)) return true;
    if (assignedToId === caller.id) return true;
  }
  // Also check direct assigned_to as userId for fallbackStore shape where assignedTo is employeeId but we have userId mapping
  // Check customAssignedTo (employeeId) against visible employeeIds
  if (customAssignedTo) {
    const upperCustom = customAssignedTo.toUpperCase();
    const empIdsUpper = (visibility.employeeIds || []).map((e: string) => String(e).toUpperCase());
    if (empIdsUpper.includes(upperCustom)) return true;
    if (caller.employee_id && upperCustom === String(caller.employee_id).toUpperCase()) return true;
    // Also check if customAssignedTo matches any visible userId's employeeId via direct comparison
    // For fallbackStore, assignedTo is employeeId, so check against caller employeeId already done, and against visibility employeeIds
  }
  // Check if leadRow has assigned_to as userId in fallback shape? Actually fallbackStore leads store assignedTo as employeeId, not userId.
  // For safety, also check if leadRow.id or assignedTo matches caller
  if (!assignedToId && !customAssignedTo) {
    if (createdBy && createdBy === caller.id) return true;
    return false;
  }
  // If no assigned_to but customAssignedTo matched via employeeIds already, return true handled above
  // Otherwise, check createdBy as fallback for unassigned leads
  if (createdBy && createdBy === caller.id) return true;
  return false;
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
