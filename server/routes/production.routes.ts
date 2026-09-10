import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool, isDatabaseConfigured } from '../database/connection.js';
import { resolveVisibility } from '../authz.js';
import { fallbackStore, createId } from '../fallbackStore.js';
import { computeHierarchyHealth } from '../utils/hierarchyHealth.js';
import {
  mapSpreadsheetRow,
  normalizePhoneKey,
  parseAmount,
  parseTat,
  rowFingerprint,
  type ImportRow,
} from './leadImport.js';

/**
 * production.routes.ts — LeadFlow mounted API.
 * ------------------------------------------------------------------
 * ARCHITECTURE
 *   Frontend UI -> /api/* -> this router -> PostgreSQL (Supabase)
 *
 * RULES ENFORCED HERE
 *   1. When DATABASE_URL is configured, every database-backed entity is
 *      read/written exclusively through PostgreSQL. In-memory stores are
 *      NEVER used as a fallback after a database failure.
 *   2. In production (NODE_ENV=production / VERCEL) a missing DATABASE_URL
 *      yields HTTP 503 - data is never silently kept in memory.
 *   3. In development only, when no DATABASE_URL exists, an explicit
 *      in-memory demo mode is used so the UI stays usable locally. It is
 *      clearly labelled (X-Data-Mode: dev-demo) and never active in
 *      production.
 *   4. Every mutation returns the persisted record and a meaningful
 *      error/status on failure; nothing is reported as success unless the
 *      database committed it.
 *   5. Authorization is enforced here, never trusted from the UI: admin
 *      mutations require the ADMIN role, user-scoped routes require the
 *      caller to be the subject or an admin, lead deletion requires
 *      admin/grant/ownership, and admins cannot strand the org without
 *      an administrator or lock out their own account.
 * ------------------------------------------------------------------
 */

const router = Router();

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

if (!process.env.JWT_SECRET && IS_PRODUCTION) {
  console.error('❌ JWT_SECRET is not configured in production. Authentication will refuse to start.');
}

function useDb(): boolean {
  return isDatabaseConfigured();
}

function demoModeAllowed(): boolean {
  return !IS_PRODUCTION && !useDb();
}

/**
 * When DB is required but missing/unusable, send the right error instead
 * of silently switching to an in-memory store.
 */
function sendDbUnavailable(res: any): boolean {
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

function normalizeRole(value?: string): string {
  if (!value) return 'EMPLOYEE';
  return String(value).trim().toUpperCase();
}

function signToken(payload: Record<string, any>): string {
  if (!process.env.JWT_SECRET && IS_PRODUCTION) {
    throw new Error('JWT_SECRET is not configured.');
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function getAuthUser(req: any): any {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET) as any;
  } catch {
    return null;
  }
}

function requireAuth(req: any, res: any, next: any): void {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    return;
  }
  req.currentUser = user;
  next();
}

function requireRole(...roles: string[]) {
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
function requireAdmin(req: any, res: any, next: any): void {
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

function callerIsAdmin(req: any): boolean {
  const role = normalizeRole(req.currentUser?.role || req.currentUser?.roleCode);
  return role === 'ADMIN' || role === 'SUPERADMIN';
}

/** True when `ref` identifies the authenticated caller (uuid, employee id or email). */
function isSelfRef(req: any, ref: any): boolean {
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

/**
 * Allows the request when the route param identifies the caller
 * themselves, or when the caller is an administrator. Used for
 * user-scoped reads/writes (own notifications, own permission sheet,
 * own password change) so one authenticated user cannot mutate
 * another user's data.
 */
function requireSelfOrAdmin(paramName: string) {
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


/** Translate low-level database failures into HTTP 503 (unavailable). */
function dbErrorStatus(error: any): number {
  if (!error) return 500;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  if (['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','57P01','57P03','08001','08006','08004','53300'].includes(code)) {
    return 503;
  }
  if (/(connection|timeout|reachable|pool|unavailable)/i.test(msg)) return 503;
  return 500;
}

function sendJson(res: any, status: number, payload: any): void {
  if (demoModeAllowed()) {
    res.setHeader('X-Data-Mode', 'dev-demo');
  }
  res.status(status).json(payload);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value: any): string | null => (value && UUID_RE.test(String(value)) ? String(value) : null);

const jsonbOr = (value: any, fallback: any = null): any => {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
};

/* ====================================================================
   DEFAULT ROLES
==================================================================== */

const DEFAULT_ROLES: Array<{ code: string; name: string; level: number }> = [
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

/** System roles that exist for platform administration and never take part
 *  in the business reporting ladder (Level 1..N company-wide hierarchy). */
const SYSTEM_ROLES = ['ADMIN', 'SUPERADMIN'];

/** Levels at or above this value are considered "not placed in the ladder". */
const UNASSIGNED_LEVEL = 99;

let rolesEnsured = false;

/** Seeds default roles when the roles table is empty (idempotent). */
async function ensureDefaultRoles(): Promise<void> {
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
    await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, is_active, created_at, updated_at)
       VALUES ('CEO', 'Chief Executive Officer', 1, TRUE, NOW(), NOW())
       ON CONFLICT (role_code) DO NOTHING`
    );
  }
  rolesEnsured = true;
}

/** Resolve (and if necessary create) a role row for a role code. */
async function resolveRoleId(roleCode: string): Promise<string | null> {
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

async function roleCodeOf(roleId: string | null): Promise<string | null> {
  if (!roleId) return null;
  const pool = getPool();
  const result = await pool.query('SELECT role_code FROM roles WHERE id = $1', [roleId]);
  return result.rows[0]?.role_code || null;
}

/** Resolve a user reference (uuid, employee id, or email) to a users.id. */
async function resolveUserId(ref: any): Promise<string | null> {
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

/* ====================================================================
   COMPANY-WIDE REPORTING LADDER  (Level 1 = CEO ... Level N)
==================================================================== */

interface RoleRow { id: string; role_code: string; role_name: string; hierarchy_level: number; is_active: boolean }

async function getRoleRows(exec: { query: Function }): Promise<RoleRow[]> {
  const result = await exec.query(
    `SELECT id, role_code, role_name, hierarchy_level, is_active
       FROM roles ORDER BY hierarchy_level ASC, role_name ASC`
  );
  return result.rows as RoleRow[];
}

/** Role level lookup: role code -> ladder level (99 = not in ladder). */
async function roleLevelOf(exec: { query: Function }, roleId: string | null): Promise<number> {
  if (!roleId) return UNASSIGNED_LEVEL;
  const result = await exec.query(
    'SELECT hierarchy_level FROM roles WHERE id = $1 LIMIT 1',
    [roleId]
  );
  const level = Number(result.rows[0]?.hierarchy_level);
  return Number.isFinite(level) && level > 0 ? level : UNASSIGNED_LEVEL;
}

/**
 * Validates a reporting link against the company ladder:
 *   - The manager's role must sit EXACTLY one level above the employee's.
 *   - Both must be in the same department, EXCEPT when the manager is at
 *     Level 1 (CEO) — the CEO sits above every department.
 *   - Level-1 (CEO) employees report to nobody.
 *   - Roles not placed in the ladder (level 99) may omit the manager.
 *   - Cycles are rejected (an employee can never manage their own ancestor).
 * Returns an error message, or null when the link is valid.
 *
 * `managerIsRequired` MUST be true on both user create and user update:
 * Level 2+ ladder employees always need exactly one reporting manager.
 * (Exported for regression tests; the HTTP routes remain the only callers
 * in production code.)
 */
export async function validateReportingLink(
  exec: { query: Function },
  opts: { selfId: string | null; roleId: string | null; departmentId: string | null; managerId: string | null; managerIsRequired: boolean }
): Promise<string | null> {
  const { selfId, roleId, departmentId, managerId, managerIsRequired } = opts;
  const level = await roleLevelOf(exec, roleId);
  const inLadder = level > 0 && level < UNASSIGNED_LEVEL;

  if (level === 1) {
    if (managerId) {
      return 'A Level-1 (CEO) employee cannot report to anyone. Leave the reporting manager empty.';
    }
    return null;
  }

  if (!managerId) {
    if (inLadder && managerIsRequired) {
      return 'A reporting manager is required: select the employee this person reports to.';
    }
    return null;
  }

  if (selfId && managerId === selfId) {
    return 'An employee cannot report to themselves.';
  }

  const managerResult = await exec.query(
    `SELECT u.id, u.employee_id, u.department_id, u.is_active, r.role_code, r.hierarchy_level
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 LIMIT 1`,
    [managerId]
  );
  const manager = managerResult.rows[0];
  if (!manager) return 'The selected reporting manager was not found.';
  if (manager.is_active === false) return 'The reporting manager must be an active employee.';

  const managerLevel = Number(manager.hierarchy_level) > 0 ? Number(manager.hierarchy_level) : UNASSIGNED_LEVEL;

  if (inLadder) {
    // The manager sits one level UP the ladder (Level 1 = CEO at the top),
    // i.e. manager level = employee level - 1.
    if (managerLevel !== level - 1) {
      return `Invalid reporting manager: this role sits at Level ${level}, so the manager must hold a Level ${level - 1} role.`;
    }
    if (managerLevel !== 1) {
      // Same-department rule — the CEO (Level 1) is the only cross-department link.
      if (!departmentId || !manager.department_id || String(manager.department_id) !== String(departmentId)) {
        return 'Invalid reporting manager: the manager must belong to the same department.';
      }
    }
  }

  // Cycle guard: walk up from the proposed manager; the employee must not
  // appear in their own management chain.
  let cursor: string | null = managerId;
  const seen = new Set<string>([managerId]);
  while (cursor) {
    if (selfId && cursor === selfId) {
      return 'Invalid reporting manager: that would create a circular reporting chain.';
    }
    const up = await exec.query('SELECT manager_id FROM users WHERE id = $1 LIMIT 1', [cursor]);
    const next: string | null = up.rows[0]?.manager_id || null;
    if (next && seen.has(next)) break; // pre-existing cycle in stored data; stop walking
    seen.add(next || '');
    cursor = next;
  }
  return null;
}

/**
 * Server-authoritative recompute of reporting_chain / subordinates for all
 * users (derived from users.manager_id), plus the era-B `hierarchies` sync
 * rows. Called after any user create/update that can change the tree.
 *
 * Every database error propagates to the caller: the caller runs this
 * inside the same transaction as the user write and rolls the whole
 * transaction back on failure, so NOTHING here may swallow errors.
 * (Exported for regression tests; the HTTP routes remain the only callers
 * in production code.)
 */
export async function recomputeReportingChains(exec: { query: Function }): Promise<void> {
  const result = await exec.query('SELECT id, employee_id, manager_id FROM users');
  const byId = new Map<string, { id: string; employeeId: string; managerId: string | null }>();
  for (const row of result.rows) {
    byId.set(row.id, { id: row.id, employeeId: row.employee_id, managerId: row.manager_id || null });
  }
  const childrenOf = new Map<string, string[]>();
  for (const u of byId.values()) {
    if (!u.managerId) continue;
    const list = childrenOf.get(u.managerId) || [];
    list.push(u.id);
    childrenOf.set(u.managerId, list);
  }

  const chainMemo = new Map<string, string[]>();
  const chainOf = (id: string, guard: Set<string>): string[] => {
    if (chainMemo.has(id)) return chainMemo.get(id)!;
    const user = byId.get(id);
    if (!user || !user.managerId || guard.has(id)) return [];
    guard.add(id);
    const manager = byId.get(user.managerId);
    const chain = manager ? [manager.employeeId, ...chainOf(user.managerId, guard)] : [];
    guard.delete(id);
    chainMemo.set(id, chain);
    return chain;
  };

  const subsMemo = new Map<string, string[]>();
  const subsOf = (id: string): string[] => {
    if (subsMemo.has(id)) return subsMemo.get(id)!;
    const kids = childrenOf.get(id) || [];
    const all: string[] = [];
    for (const kid of kids) {
      const kidUser = byId.get(kid);
      if (kidUser) all.push(kidUser.employeeId, ...subsOf(kid));
    }
    subsMemo.set(id, all);
    return all;
  };

  for (const user of byId.values()) {
    const chain = chainOf(user.id, new Set());
    const subs = subsOf(user.id);
    await exec.query(
      `UPDATE users SET reporting_chain = $2, subordinates = $3, updated_at = NOW() WHERE id = $1`,
      [user.id, JSON.stringify(chain), JSON.stringify(subs)]
    );
    if (user.managerId) {
      await exec.query(
        `INSERT INTO hierarchies (user_id, manager_id, level, path, created_at, updated_at)
         VALUES ($1, $2, GREATEST($3, 1), $4, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           manager_id = EXCLUDED.manager_id,
           level = EXCLUDED.level,
           path = EXCLUDED.path,
           updated_at = NOW()`,
        [user.id, user.managerId, chain.length + 1, JSON.stringify(chain)]
      );
    } else {
      // No error swallowing here: a failed DELETE inside the caller's
      // transaction would abort that transaction, and the caller must see
      // the failure so it can roll back instead of committing partial data.
      await exec.query('DELETE FROM hierarchies WHERE user_id = $1', [user.id]);
    }
  }
}

/**
 * Ladder + setup status for the admin hierarchy screen.
 * Reports links whose manager no longer matches the ladder rules
 * (e.g. after levels were changed) without blocking the save.
 */
async function buildHierarchyConfig() {
  const pool = getPool();
  await ensureDefaultRoles();
  const roles = (await getRoleRows(pool)).filter(
    r => !SYSTEM_ROLES.includes(String(r.role_code).toUpperCase())
  );
  const usersResult = await pool.query(
    `SELECT u.id, u.employee_id, u.full_name, u.manager_id, u.department_id, u.is_active,
            r.role_code, r.hierarchy_level
       FROM users u LEFT JOIN roles r ON r.id = u.role_id`
  );

  const levelMap = new Map<string, number>();
  for (const r of roles) levelMap.set(String(r.role_code).toUpperCase(), Number(r.hierarchy_level));

  const ladderRoles = roles.filter(r => Number(r.hierarchy_level) > 0 && Number(r.hierarchy_level) < UNASSIGNED_LEVEL);
  const levels: Array<{ level: number; roles: Array<{ roleId: string; roleName: string; employeeCount: number }> }> = [];
  for (const role of ladderRoles) {
    const level = Number(role.hierarchy_level);
    let entry = levels.find(l => l.level === level);
    if (!entry) { entry = { level, roles: [] }; levels.push(entry); }
    entry.roles.push({
      roleId: String(role.role_code),
      roleName: role.role_name,
      employeeCount: usersResult.rows.filter(
        (u: any) => String(u.role_code || '').toUpperCase() === String(role.role_code).toUpperCase() && u.is_active !== false
      ).length,
    });
  }
  levels.sort((a, b) => a.level - b.level);

  const unassignedRoles = roles
    .filter(r => !(Number(r.hierarchy_level) > 0 && Number(r.hierarchy_level) < UNASSIGNED_LEVEL))
    .map(r => ({ roleId: String(r.role_code), roleName: r.role_name, employeeCount: usersResult.rows.filter((u: any) => String(u.role_code || '').toUpperCase() === String(r.role_code).toUpperCase() && u.is_active !== false).length }));

  // Server-authoritative ladder health. The "missing reporting manager"
  // count uses the hierarchy level/business rule: only Level 2+ employees
  // are counted, so the Level-1 (CEO) org root is never reported as missing
  // a manager. Invalid links are recomputed from the CURRENT role levels, so
  // a hierarchy/role-level change is reflected here without mutating any
  // stored manager_id values.
  const health = computeHierarchyHealth(usersResult.rows as any, levelMap);

  return {
    levels,
    unassignedRoles,
    setup: {
      totalUsers: health.totalUsers,
      usersWithManager: health.usersWithManager,
      usersWithoutManager: health.usersWithoutManager,
      invalidLinks: health.invalidLinks,
    },
    rules: {
      levelGap: 1,
      sameDepartmentRequired: true,
      level1CrossesDepartments: true,
      description: 'Level 1 = CEO (company-wide). Every other employee reports to a specific manager exactly one level up, within the same department.',
    },
  };
}

/* ====================================================================
   ROW MAPPERS  (database rows -> frontend contract)
==================================================================== */

function mapUserRow(row: any, managerEmployeeId?: string | null) {
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

const USER_SELECT = `
  SELECT u.*, r.role_code, r.role_name, r.hierarchy_level, m.employee_id AS manager_employee_id
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  LEFT JOIN users m ON m.id = u.manager_id
`;

function mapDepartmentRow(row: any) {
  return {
    id: row.id,
    name: row.department_name,
    code: row.department_code,
    description: row.description || '',
    isActive: row.is_active !== false,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoleRow(row: any) {
  return {
    roleId: row.role_code,
    roleName: row.role_name,
    hierarchyLevel: row.hierarchy_level,
    description: row.description || '',
    isActive: row.is_active !== false,
    dataVisibility: row.data_visibility || 'Own',
    menuAccess: jsonbOr(row.menu_access, {}),
    actions: jsonbOr(row.actions, {}),
    featurePermissions: jsonbOr(row.feature_permissions, {}),
    isSystem: row.role_code === 'ADMIN',
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTeamRow(row: any) {
  return {
    id: row.id,
    name: row.team_name,
    code: row.team_code,
    leaderId: row.leader_employee_id || row.leader_id || '',
    memberIds: jsonbOr(row.member_ids, []),
    departmentId: row.department_id || '',
    description: row.description || '',
    isActive: row.is_active !== false,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLeadRow(row: any) {
  const custom = row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {};
  const spread: Record<string, any> = { ...custom };
  const assignedToEmp = row.assigned_to_employee_id || '';
  const assignedByEmp = row.assigned_by_employee_id || '';
  return {
    ...spread,
    id: row.lead_code || row.id,
    dbId: row.id,
    prospectName: row.customer_name,
    customerName: row.customer_name,
    mobile: row.mobile || '',
    alternateMobile: row.alternate_mobile || '',
    email: row.email || '',
    profession: row.occupation || spread.profession || '',
    occupation: row.occupation || '',
    maritalStatus: row.marital_status || '',
    address: row.address || '',
    area: row.area || '',
    district: row.district || '',
    division: row.division || '',
    source: row.source || '',
    priority: row.priority || spread.priority || 'NORMAL',
    notes: row.notes || '',
    assignedTo: assignedToEmp || spread.assignedTo || '',
    assignedBy: assignedByEmp || spread.assignedBy || '',
    assignedDate: row.assigned_at || spread.assignedDate || '',
    projectedNCP: row.expected_premium != null ? Number(row.expected_premium) : (spread.projectedNCP ?? 0),
    sumAssured: row.expected_value != null ? Number(row.expected_value) : (spread.sumAssured ?? 0),
    lastFollowUpDate: row.last_contacted_at || spread.lastFollowUpDate || '',
    nextFollowUpDate: row.next_follow_up_at || spread.nextFollowUpDate || '',
    currentStatus: row.current_status || spread.currentStatus || 'Untouched',
    statusHistory: Array.isArray(row.status_history) ? row.status_history : (Array.isArray(spread.statusHistory) ? spread.statusHistory : []),
    assignmentHistory: Array.isArray(row.assignment_history) ? row.assignment_history : (Array.isArray(spread.assignmentHistory) ? spread.assignmentHistory : []),
    documents: Array.isArray(row.documents) ? row.documents : (Array.isArray(spread.documents) ? spread.documents : []),
    tags: Array.isArray(row.tags) ? row.tags : [],
    campaignName: spread.campaignName || '',
    creationDate: row.created_at,
    timestamp: row.updated_at || row.created_at,
  };
}

const LEAD_SELECT = `
  SELECT l.*,
         au.employee_id AS assigned_to_employee_id,
         ab.employee_id AS assigned_by_employee_id
  FROM leads l
  LEFT JOIN users au ON au.id = l.assigned_to
  LEFT JOIN users ab ON ab.id = l.assigned_by
`;

function mapHierarchyRow(row: any) {
  return {
    id: row.id,
    departmentId: row.department_id,
    layers: jsonbOr(row.layers, []),
    updatedAt: row.updated_at,
  };
}

function mapMetadataTypeRow(row: any) {
  return {
    key: row.key,
    label: row.label,
    description: row.description || '',
    isSystem: row.is_system === true,
    sortOrder: row.sort_order,
  };
}

function mapOptionRow(row: any) {
  return {
    id: row.id,
    type: row.field_key,
    value: row.option_value,
    label: row.option_label || row.option_value,
    status: row.is_active === false ? 'Inactive' : 'Active',
    sortOrder: row.sort_order,
    meta: jsonbOr(row.meta, {}),
    createdDate: row.created_at,
  };
}

function mapWorkflowRuleRow(row: any) {
  return {
    id: row.id,
    status: row.status,
    allowedNextStatuses: jsonbOr(row.allowed_next_statuses, null),
    requiresLossReason: row.requires_loss_reason === true,
    requiresMeetingType: row.requires_meeting_type === true,
    requiresFollowUpType: row.requires_followup_type === true,
    requiresNote: row.requires_note === true,
    isSystem: row.is_system === true,
    createdDate: row.created_at,
  };
}

function mapFormFieldRow(row: any) {
  return {
    id: row.id,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    section: row.section || '',
    isMandatory: row.is_mandatory === true,
    isVisible: row.is_visible !== false,
    sortOrder: row.sort_order,
    metadataTypeKey: row.metadata_type_key || null,
    placeholder: row.placeholder || '',
    isSystem: row.is_system === true,
    createdDate: row.created_at,
  };
}

function mapNotificationRow(row: any) {
  return {
    id: row.id,
    userId: row.recipient_key || row.user_employee_id || row.user_id,
    title: row.title,
    message: row.message,
    leadId: row.lead_code || row.reference_id || '',
    read: row.is_read === true,
    date: row.created_at,
  };
}

const NOTIFICATION_SELECT = `
  SELECT n.*, u.employee_id AS user_employee_id
  FROM notifications n
  LEFT JOIN users u ON u.id = n.user_id
`;

/* ====================================================================
   HELPERS - shared value conversions
==================================================================== */

const clean = (value: any): string => String(value == null ? '' : value).trim();
const dateOrNull = (value: any): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Deterministic lead code for bulk imports (idempotency across retries). */
function importLeadCode(mobile: string): string {
  const digits = mobile.replace(/\D/g, '').slice(-11);
  return `imp_${digits}`;
}

/* ====================================================================
   LEAD SECURITY HARDENING HELPERS
   - PostgreSQL is authoritative
   - All identity fields derived from authenticated session
   - Ownership + hierarchy/data-scope enforced server-side
   - Permission checks reuse existing permissions table
==================================================================== */

export interface CallerDbInfo {
  id: string;
  employee_id: string;
  email: string;
  role_id: string | null;
  role_code: string;
  department_id: string | null;
}

/** Resolve caller to DB record (or fallbackStore in dev-demo). */
export async function getCallerDbInfo(req: any): Promise<CallerDbInfo | null> {
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

/** Check if caller has a specific permission code (admin bypass). */
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
  try {
    const pool = getPool();
    const permResult = await pool.query(`SELECT id FROM permissions WHERE permission_code = $1 LIMIT 1`, [permissionCode]);
    if (!permResult.rows[0]) {
      // Fail closed: missing permission definition => deny
      console.warn(`Permission definition missing for ${permissionCode} - denying access`);
      return false;
    }
    const permId = permResult.rows[0].id;
    const userOverride = await pool.query(
      `SELECT is_allowed FROM user_permissions WHERE user_id = $1 AND permission_id = $2 LIMIT 1`,
      [caller.id, permId]
    );
    if (userOverride.rows[0] !== undefined) {
      return userOverride.rows[0].is_allowed === true;
    }
    if (caller.role_id) {
      const roleGrant = await pool.query(
        `SELECT is_allowed FROM role_permissions WHERE role_id = $1 AND permission_id = $2 LIMIT 1`,
        [caller.role_id, permId]
      );
      if (roleGrant.rows[0]) {
        return roleGrant.rows[0].is_allowed === true;
      }
    }
    // No explicit grant => deny (fail closed)
    return false;
  } catch (e) {
    console.warn(`Permission check failed for ${permissionCode}:`, (e as any)?.message || e);
    // Fail closed on DB error
    return false;
  }
}

/** Resolve visibility for caller (admin => all). */
export async function resolveCallerVisibility(caller: CallerDbInfo) {
  if (!caller) return { all: false, userIds: [], employeeIds: [] };
  const role = normalizeRole(caller.role_code);
  if (role === 'ADMIN' || role === 'SUPERADMIN') {
    return { all: true, userIds: [], employeeIds: [] };
  }
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

/** Resolve assignedTo reference to userId + employeeId. */
export async function resolveAssignedTo(ref: any): Promise<{ userId: string; employeeId: string } | null> {
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
    return { userId: user.id, employeeId: user.employeeId };
  }
  try {
    const pool = getPool();
    const uuid = asUuid(value);
    const result = await pool.query(
      `SELECT id, employee_id FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($2) OR UPPER(email) = UPPER($2) LIMIT 1`,
      [uuid || value, value]
    );
    if (!result.rows[0]) return null;
    return { userId: result.rows[0].id, employeeId: result.rows[0].employee_id };
  } catch {
    return null;
  }
}

/** Check if a lead row is accessible to caller via visibility. */
export function isLeadAccessible(leadRow: any, visibility: any, caller: CallerDbInfo): boolean {
  if (!leadRow) return false;
  if (visibility.all) return true;
  // Support both DB row shape (assigned_to, custom_fields, created_by) and fallbackStore shape (assignedTo, customFields, etc)
  const assignedToId = leadRow.assigned_to ? String(leadRow.assigned_to) : (leadRow.assignedTo ? '' : '');
  // For fallbackStore, assignedTo is employeeId, need to check against employeeIds
  const customFields = (leadRow.custom_fields && typeof leadRow.custom_fields === 'object' ? leadRow.custom_fields : (leadRow.customFields && typeof leadRow.customFields === 'object' ? leadRow.customFields : {}));
  const customAssignedTo = String((customFields as any).assignedTo || leadRow.assignedTo || '').trim();
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

/** Fields that must NEVER be trusted from client payload for authz. */
export const FORBIDDEN_CUSTOM_KEYS = new Set([
  'assignedBy', 'assigned_by', 'updatedBy', 'updated_by',
  'createdBy', 'created_by', 'created_by_employee', 'updated_by_employee',
  'deletedBy', 'deleted_by', 'owner', 'ownerId', 'owner_id',
  'employeeId', 'employee_id', 'visibility', 'scope', 'role', 'roleCode', 'role_code',
]);

/** Sanitize customFields to remove forbidden authz-influencing keys. */
export function sanitizeCustomFields(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (FORBIDDEN_CUSTOM_KEYS.has(k)) continue;
    if (k.startsWith('_')) continue;
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}


/* ====================================================================
   DB STATUS / HEALTH
==================================================================== */

router.get('/db-status', async (_req, res) => {
  if (!useDb()) {
    const status = demoModeAllowed() ? 200 : 503;
    return sendJson(res, status, {
      connected: false,
      message: demoModeAllowed()
        ? 'DATABASE_URL is not set. Running in development demo mode (in-memory, not persistent).'
        : 'DATABASE_URL is not configured. The application cannot persist data in production.',
      mode: demoModeAllowed() ? 'dev-demo' : 'db-unconfigured',
    });
  }
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return sendJson(res, 200, { connected: true, message: 'Database connected.', mode: 'database' });
  } catch (error: any) {
    return sendJson(res, 503, {
      connected: false,
      message: error?.message || 'Database is unavailable.',
      mode: 'database-unreachable',
    });
  }
});

/* ====================================================================
   FIRST-ADMIN BOOTSTRAP (secure, unauthenticated, guarded)
==================================================================== */

async function adminExistsInDb(): Promise<boolean> {
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

router.get('/auth/bootstrap-status', async (_req, res) => {
  // In production without a database this must report 503 (honest
  // "unavailable") instead of consulting the empty in-memory store and
  // misleading the login screen into first-run setup.
  if (sendDbUnavailable(res)) return;
  try {
    const required = !(await adminExistsInDb());
    return sendJson(res, 200, { required, exists: !required });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Admin check failed' });
  }
});

const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,29}$/;

router.post('/auth/bootstrap-admin', async (req, res) => {
  const payload = req.body || {};
  const fullName = clean(payload.fullName || payload.name);
  const employeeId = clean(payload.employeeId || payload.employee_id).toUpperCase();
  const email = clean(payload.email).toLowerCase();
  const password = String(payload.password || '');

  if (fullName.length < 3 || employeeId.length < 3 || !EMPLOYEE_ID_RE.test(employeeId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 5) {
    return sendJson(res, 400, {
      success: false,
      message: 'Valid full name, employee ID, email and a password of at least 5 characters are required.',
    });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) {
      return sendJson(res, 503, {
        success: false,
        message: 'Database is not configured. Cannot create the first admin in production.',
      });
    }
    // Development demo mode: only allowed while no ADMIN exists.
    const adminExists = fallbackStore.users.some(
      u => normalizeRole(u.role) === 'ADMIN' || normalizeRole(u.roleCode) === 'ADMIN'
    );
    if (adminExists) {
      return sendJson(res, 409, { success: false, message: 'An admin already exists.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const adminUser = {
      id: createId('user'),
      employeeId,
      fullName,
      name: fullName,
      email,
      role: 'ADMIN',
      roleCode: 'ADMIN',
      status: 'Active' as const,
      accountStatus: 'ACTIVE',
      isActive: true,
      designation: 'Administrator',
      departmentId: '',
      teamId: '',
      managerId: '',
      reportingManagerId: '',
      avatarUrl: '',
      createdDate: new Date().toISOString(),
      password: hash,
      mustChangePassword: false,
    };
    fallbackStore.users.push(adminUser);
    const token = signToken({ id: adminUser.id, employeeId, role: 'ADMIN', email, name: fullName });
    const { password: _pw, ...safeUser } = adminUser;
    return sendJson(res, 201, { success: true, token, user: safeUser });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock scoped to the transaction prevents two serverless
    // instances from both bootstrapping an admin concurrently.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['leadflow_first_admin_bootstrap']);
    const adminResult = await client.query(
      `SELECT 1 FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE UPPER(r.role_code) IN ('ADMIN', 'SUPERADMIN')
       LIMIT 1`
    );
    if (adminResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { success: false, message: 'An admin account already exists. Please log in.' });
    }
    const dup = await client.query(
      `SELECT employee_id, email FROM users
       WHERE UPPER(employee_id) = $1 OR UPPER(email) = $2
       LIMIT 1`,
      [employeeId, email]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, {
        success: false,
        message: 'A user with that employee ID or email already exists.',
      });
    }
    const roleId = await resolveRoleId('ADMIN');
    if (!roleId) {
      await client.query('ROLLBACK');
      return sendJson(res, 500, { success: false, message: 'Default ADMIN role could not be prepared.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const created = await client.query(
      `INSERT INTO users (employee_id, full_name, email, phone, password, role_id, designation,
                          is_active, account_status, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, 'Administrator', TRUE, 'ACTIVE', FALSE, NOW(), NOW())
       RETURNING *`,
      [employeeId, fullName, email, hash, roleId]
    );
    await client.query('COMMIT');
    const row = created.rows[0];
    const mapped = mapUserRow({ ...row, role_code: 'ADMIN', role_name: 'Administrator' });
    const token = signToken({ id: row.id, employeeId, role: 'ADMIN', email, name: fullName });
    return sendJson(res, 201, { success: true, token, user: mapped });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'First admin setup failed.' });
  } finally {
    client.release();
  }
});

/* ====================================================================
   AUTH
==================================================================== */

router.post('/auth/login', async (req, res) => {
  const loginId = clean(req.body?.employeeId || req.body?.email);
  const password = String(req.body?.password || '');

  if (!loginId || !password) {
    return sendJson(res, 400, { success: false, message: 'Employee ID and password are required' });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured. Cannot authenticate in production.' });
    }
    const user = fallbackStore.users.find(
      item =>
        String(item.employeeId || '').toUpperCase() === loginId.toUpperCase() ||
        String(item.email || '').toLowerCase() === loginId.toLowerCase()
    );
    if (!user || !user.password) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const ok = user.password.startsWith('$2')
      ? await bcrypt.compare(password, user.password)
      : user.password === password;
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: user.id, employeeId: user.employeeId, role: normalizeRole(user.role), email: user.email, name: user.fullName || user.name });
    const { password: _pw, ...safeUser } = user;
    return res.status(200).json({ token, user: { ...safeUser, name: user.fullName || user.name } });
  }

  try {
    const pool = getPool();
    // Same projection as GET /auth/session below: the profile the client
    // caches at login is then byte-identical to the one startup validation
    // compares it against, so a cold reload of an unchanged account needs no
    // state rewrite (and therefore no re-run of the [user] effects that
    // re-fetch roles/notifications/dashboard data).
    const result = await pool.query(
      `${USER_SELECT}
       WHERE UPPER(u.employee_id) = UPPER($1) OR UPPER(u.email) = UPPER($1)
       LIMIT 1`,
      [loginId]
    );
    const user = result.rows[0];
    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const valid = user.password && String(user.password).startsWith('$2')
      ? await bcrypt.compare(password, user.password)
      : user.password === password;
    if (!valid) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => undefined);
    const role = user.role_code || 'EMPLOYEE';
    const token = signToken({ id: user.id, employeeId: user.employee_id, role, email: user.email, name: user.full_name });
    return sendJson(res, 200, { token, user: mapUserRow(user, user.manager_employee_id) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Login failed' });
  }
});

/**
 * GET /auth/session — authoritative session validation for app startup.
 * ------------------------------------------------------------------
 * The browser must never treat its cached auth state (Zustand persist /
 * localStorage) as proof that a session is still valid. On every cold load
 * the client asks this endpoint before it renders a protected route.
 *
 * Validation is server-side and deliberately cheap:
 *   1. `requireAuth` verifies the bearer token signature and expiry.
 *   2. The account is then re-read (PostgreSQL when configured, the
 *      development in-memory store otherwise) so a deleted or deactivated
 *      employee's cached token stops working immediately instead of
 *      surviving until the JWT expires.
 *
 * The reply uses the same `{ success, data }` envelope as the rest of the
 * production API, so the centralized client helper unwraps it, and `data`
 * is exactly the user object `/auth/login` returns - never the password
 * column.
 *
 * Status contract the client relies on:
 *   401 -> this session was REJECTED (clear it and re-login)
 *   503 -> validation is UNAVAILABLE (database down/unconfigured) - the
 *          client keeps the session rather than logging people out during
 *          an infrastructure outage.
 */
router.get('/auth/session', requireAuth, async (req: any, res) => {
  const claim = req.currentUser || {};
  const claimId = String(claim.id || '').trim();
  const claimEmployeeId = String(claim.employeeId || '').trim();
  const claimEmail = String(claim.email || '').trim();

  if (!claimId && !claimEmployeeId && !claimEmail) {
    return sendJson(res, 401, { success: false, message: 'Your session is not valid. Please log in again.' });
  }

  if (useDb()) {
    try {
      const pool = getPool();
      const result = await pool.query(
        `${USER_SELECT}
         WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($2) OR UPPER(u.email) = UPPER($3)
         LIMIT 1`,
        [claimId || claimEmployeeId || claimEmail, claimEmployeeId || claimId, claimEmail || claimId]
      );
      const row = result.rows[0];
      if (!row) {
        return sendJson(res, 401, { success: false, message: 'Your account no longer exists. Please log in again.' });
      }
      if (row.is_active === false || String(row.account_status || '').toUpperCase() === 'INACTIVE') {
        return sendJson(res, 401, { success: false, message: 'Your account is inactive. Please contact an administrator.' });
      }
      return sendJson(res, 200, { success: true, data: mapUserRow(row, row.manager_employee_id) });
    } catch (error: any) {
      return sendJson(res, dbErrorStatus(error), {
        success: false,
        message: error?.message || 'Session validation is temporarily unavailable.',
      });
    }
  }

  // No database configured: production stays honest (503 - not a rejected
  // session), development uses the in-memory demo store it logged into.
  if (!demoModeAllowed()) {
    return sendJson(res, 503, {
      success: false,
      message: 'Database is not configured. Session validation is unavailable.',
      mode: 'db-unconfigured',
    });
  }

  const demoUser = fallbackStore.users.find(item =>
    (claimId && item.id === claimId) ||
    (claimEmployeeId && String(item.employeeId).toUpperCase() === claimEmployeeId.toUpperCase()) ||
    (claimEmail && String(item.email).toLowerCase() === claimEmail.toLowerCase())
  );
  if (!demoUser) {
    return sendJson(res, 401, { success: false, message: 'Your account no longer exists. Please log in again.' });
  }
  if (
    demoUser.status === 'Inactive' ||
    demoUser.isActive === false ||
    String(demoUser.accountStatus || '').toUpperCase() === 'INACTIVE'
  ) {
    return sendJson(res, 401, { success: false, message: 'Your account is inactive. Please contact an administrator.' });
  }
  const { password: _pw, ...safeSessionUser } = demoUser;
  return sendJson(res, 200, { success: true, data: safeSessionUser });
});

router.post('/auth/change-password', requireAuth, async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body || {};
  if (!userId || !currentPassword || !newPassword) {
    return sendJson(res, 400, { success: false, message: 'All password fields are required' });
  }
  if (String(newPassword).length < 5) {
    return sendJson(res, 400, { success: false, message: 'New password must be at least 5 characters' });
  }
  // Self-service only: one authenticated user must not rotate another
  // user's password. Admins use POST /users/:id/reset-password.
  if (!callerIsAdmin(req) && !isSelfRef(req, userId)) {
    return sendJson(res, 403, { success: false, message: 'You can only change your own password.' });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    }
    const user = fallbackStore.users.find(item => item.id === userId || item.employeeId === userId);
    if (!user || !user.password) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    const ok = user.password.startsWith('$2') ? await bcrypt.compare(currentPassword, user.password) : user.password === currentPassword;
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
  }

  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM users WHERE id::text = $1 OR employee_id = $1 LIMIT 1', [String(userId)]);
    const user = result.rows[0];
    if (!user) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    const ok = user.password && String(user.password).startsWith('$2')
      ? await bcrypt.compare(currentPassword, user.password)
      : user.password === currentPassword;
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [hashed, user.id]
    );
    return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Password update failed' });
  }
});

/* ====================================================================
   USERS
==================================================================== */

router.get('/users/check-admin', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const exists = await adminExistsInDb();
    return sendJson(res, 200, { exists });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Admin check failed' });
  }
});

router.get('/users', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const users = fallbackStore.users.map(({ password: _pw, ...safe }) => safe);
    return sendJson(res, 200, users);
  }
  try {
    const result = await getPool().query(`${USER_SELECT} ORDER BY u.created_at DESC`);
    return sendJson(res, 200, result.rows.map(row => mapUserRow(row, row.manager_employee_id)));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'User fetch failed' });
  }
});

/* Reporting-manager candidates for an employee form: the employees whose
   role sits exactly one level above the given role, in the same
   department (Level 1 / CEO candidates are department-agnostic).
   NOTE: registered BEFORE /users/:id so "reporting-options" is not
   captured as an :id path parameter. */
router.get('/users/reporting-options', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, []);
  try {
    const pool = getPool();
    const roleCode = clean(req.query?.role).toUpperCase();
    const departmentId = await resolveDepartmentId(req.query?.departmentId);
    if (!roleCode) return sendJson(res, 400, { success: false, message: 'role query parameter is required.' });

    const roles = await getRoleRows(pool);
    const role = roles.find(r => String(r.role_code).toUpperCase() === roleCode);
    const level = role ? Number(role.hierarchy_level) : UNASSIGNED_LEVEL;
    if (level === UNASSIGNED_LEVEL) return sendJson(res, 200, []);
    if (level === 1) return sendJson(res, 200, []); // CEO reports to nobody

    const managerLevel = level - 1; // the manager sits one level UP the ladder
    const managerRoleCodes = roles
      .filter(r => Number(r.hierarchy_level) === managerLevel)
      .map(r => String(r.role_code).toUpperCase());
    if (managerRoleCodes.length === 0) return sendJson(res, 200, []);

    const placeholders = managerRoleCodes.map((_, i) => `$${i + 1}`).join(', ');
    const params: any[] = [...managerRoleCodes];
    let sql = `
      SELECT u.id, u.employee_id, u.full_name, u.designation, d.department_name, r.role_code AS role_code, r.role_name AS role_name
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
        LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.is_active = TRUE AND UPPER(r.role_code) IN (${placeholders})`;
    if (managerLevel !== 1) {
      if (!departmentId) return sendJson(res, 200, []);
      sql += ` AND u.department_id = $${params.length + 1}`;
      params.push(departmentId);
    }
    sql += ` ORDER BY u.full_name ASC`;
    const result = await pool.query(sql, params);
    return sendJson(res, 200, result.rows.map((row: any) => ({
      id: row.id,
      employeeId: row.employee_id,
      fullName: row.full_name,
      designation: row.designation || '',
      departmentName: row.department_name || '',
      roleCode: row.role_code,
      roleName: row.role_name,
    })));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Reporting options fetch failed' });
  }
});

router.get('/users/:id', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const user = fallbackStore.users.find(u => u.id === req.params.id || u.employeeId === req.params.id);
    if (!user) return sendJson(res, 404, { success: false, message: 'User not found' });
    const { password: _pw, ...safeUser } = user;
    return sendJson(res, 200, safeUser);
  }
  try {
    const uuid = asUuid(req.params.id);
    const result = await getPool().query(
      `${USER_SELECT} WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($1) OR u.id = $2 LIMIT 1`,
      [req.params.id, uuid || null]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'User not found' });
    return sendJson(res, 200, mapUserRow(result.rows[0], result.rows[0].manager_employee_id));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'User fetch failed' });
  }
});

/** Shared validation + duplicate guard for create/update. */
async function validateUserPayload(payload: any, excludeUserId?: string): Promise<string | null> {
  const pool = getPool();
  const employeeId = clean(payload.employeeId || payload.employee_id).toUpperCase();
  const email = clean(payload.email).toLowerCase();
  if (employeeId) {
    const dup = await pool.query(
      `SELECT id FROM users WHERE UPPER(employee_id) = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
      [employeeId, excludeUserId || null]
    );
    if (dup.rows[0]) return `Employee ID "${employeeId}" is already in use.`;
  }
  if (email) {
    const dup = await pool.query(
      `SELECT id FROM users WHERE UPPER(email) = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
      [email, excludeUserId || null]
    );
    if (dup.rows[0]) return `Email "${email}" is already in use.`;
  }
  return null;
}

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const fullName = clean(payload.fullName || payload.name);
  const employeeId = clean(payload.employeeId || payload.employee_id).toUpperCase();
  if (!fullName || !employeeId) {
    return sendJson(res, 400, { success: false, message: 'Full name and employee ID are required' });
  }
  if (!EMPLOYEE_ID_RE.test(employeeId)) {
    return sendJson(res, 400, { success: false, message: 'Employee ID may only contain letters, numbers, dot, dash and underscore (2-30 chars).' });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const role = normalizeRole(payload.role || payload.roleCode);
    const email = clean(payload.email).toLowerCase();
    const existing = fallbackStore.users.find(
      item => item.employeeId.toUpperCase() === employeeId || (email && item.email === email)
    );
    const createdDate = new Date().toISOString();
    const user = {
      id: existing?.id || createId('user'),
      employeeId,
      fullName,
      name: fullName,
      email,
      phone: clean(payload.phone),
      role,
      roleCode: role,
      status: (payload.status === 'Inactive' ? 'Inactive' : 'Active') as 'Active' | 'Inactive',
      accountStatus: payload.status === 'Inactive' ? 'INACTIVE' : 'ACTIVE',
      isActive: payload.status !== 'Inactive',
      designation: clean(payload.designation) || 'Officer',
      departmentId: clean(payload.departmentId),
      teamId: clean(payload.teamId),
      managerId: clean(payload.managerId || payload.reportingManagerId),
      reportingManagerId: clean(payload.reportingManagerId || payload.managerId),
      avatarUrl: clean(payload.avatarUrl),
      createdDate: existing?.createdDate || createdDate,
      password: existing?.password || (payload.password ? await bcrypt.hash(String(payload.password), 10) : ''),
      mustChangePassword: !!payload.mustChangePassword,
      reportingChain: payload.reportingChain || [],
      subordinates: payload.subordinates || [],
    };
    if (existing) Object.assign(existing, user);
    else fallbackStore.users.push(user);
    const { password: _pw, ...safeUser } = user;
    return sendJson(res, 200, { success: true, data: safeUser });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    // User creation and reporting-chain recomputation share ONE PostgreSQL
    // transaction: if the recompute fails, the user insert rolls back with
    // it and no partially-created user is left behind.
    await client.query('BEGIN');
    const duplicateError = await validateUserPayload(payload);
    if (duplicateError) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { success: false, message: duplicateError });
    }

    const email = clean(payload.email).toLowerCase();
    const roleId = await resolveRoleId(normalizeRole(payload.role || payload.roleCode));
    if (!roleId) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: 'Unknown role code.' });
    }
    const hash = payload.password ? await bcrypt.hash(String(payload.password), 10) : null;
    const departmentId = await resolveDepartmentId(payload.departmentId);
    // Unknown team references must fail loudly instead of being silently
    // dropped to NULL (the UI would otherwise show a team that the
    // database does not have).
    const teamRef = clean(payload.teamId);
    const teamId = teamRef ? await resolveTeamId(teamRef) : null;
    if (teamRef && !teamId) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: `Unknown team "${teamRef}". Please select a valid team.` });
    }
    const managerId = await resolveUserId(payload.managerId || payload.reportingManagerId || null);

    // Reporting ladder: the manager must sit exactly one level up, in the
    // same department (Level-1 CEO is the only cross-department link).
    // Validated on the transaction client so the check and the insert below
    // see the same snapshot.
    const reportingError = await validateReportingLink(client, {
      selfId: null,
      roleId,
      departmentId,
      managerId,
      managerIsRequired: true,
    });
    if (reportingError) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: reportingError });
    }

    const result = await client.query(
      `INSERT INTO users (employee_id, full_name, email, phone, password, role_id, department_id, team_id,
                          manager_id, designation, profile_photo, is_active, account_status,
                          must_change_password, reporting_chain, subordinates, created_at, updated_at)
       VALUES ($1,$2,$3,$4,COALESCE($5,''),$6,$7,$8,$9,$10,$11,$12,
               CASE WHEN $12 = FALSE THEN 'INACTIVE' ELSE 'ACTIVE' END,
               COALESCE($13,FALSE), COALESCE($14,'[]'::jsonb), COALESCE($15,'[]'::jsonb), NOW(), NOW())
       RETURNING *`,
      [
        employeeId,
        fullName,
        email || `${employeeId.toLowerCase()}@leadflow.local`,
        clean(payload.phone) || null,
        hash,
        roleId,
        departmentId,
        teamId,
        managerId,
        clean(payload.designation) || 'Officer',
        clean(payload.avatarUrl) || null,
        payload.status !== 'Inactive',
        payload.mustChangePassword === true,
        JSON.stringify(payload.reportingChain || []),
        JSON.stringify(payload.subordinates || []),
      ]
    );
    const row = result.rows[0];
    // Server-authoritative reporting chains: recomputed in the SAME
    // transaction as the insert above. Errors are NOT swallowed — a failure
    // here throws into the catch below, which rolls the whole transaction
    // back (no partially-created user survives) and returns an error
    // response instead of a false success.
    await recomputeReportingChains(client);
    await client.query('COMMIT');
    const fresh = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [row.id]);
    const freshRow = fresh.rows[0] || row;
    const roleCode = await roleCodeOf(freshRow.role_id);
    const mapped = mapUserRow({ ...freshRow, role_code: roleCode, role_name: roleCode });
    return sendJson(res, 201, { success: true, data: mapped });
  } catch (error: any) {
    // Any failure after BEGIN — including a reporting-chain recomputation
    // failure — rolls the user insert back; the client is always released.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (error?.code === '23505') {
      return sendJson(res, 409, { success: false, message: 'A user with that employee ID or email already exists.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Create user failed' });
  } finally {
    client.release();
  }
});

router.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.users.find(u => u.id === req.params.id || u.employeeId === req.params.id);
    if (!existing) return sendJson(res, 404, { success: false, message: 'User not found' });
    // Demo-mode parity for the autonomy guards below: an admin must not
    // lock themselves out, even locally.
    const demoTargetIsSelf = isSelfRef(req, existing.id) || isSelfRef(req, existing.employeeId);
    if (demoTargetIsSelf) {
      const demoExistingRole = normalizeRole(existing.roleCode || existing.role);
      const demoNextRole = payload.role ? normalizeRole(payload.role) : demoExistingRole;
      const demoNextActive = payload.status !== undefined ? payload.status !== 'Inactive' : existing.status !== 'Inactive';
      const demoLosesAdmin = (demoExistingRole === 'ADMIN' || demoExistingRole === 'SUPERADMIN') &&
        (demoNextRole !== 'ADMIN' && demoNextRole !== 'SUPERADMIN');
      if (demoLosesAdmin || !demoNextActive) {
        return sendJson(res, 403, { success: false, message: 'You cannot remove your own administrator access or deactivate your own account.' });
      }
    }
    const role = payload.role ? normalizeRole(payload.role) : normalizeRole(existing.role);
    if (payload.password) existing.password = await bcrypt.hash(String(payload.password), 10);
    existing.employeeId = clean(payload.employeeId).toUpperCase() || existing.employeeId;
    existing.fullName = clean(payload.fullName || payload.name) || existing.fullName;
    existing.name = existing.fullName;
    existing.email = clean(payload.email).toLowerCase() || existing.email;
    existing.role = role;
    existing.roleCode = role;
    existing.status = payload.status || existing.status;
    existing.isActive = existing.status !== 'Inactive';
    existing.designation = clean(payload.designation) || existing.designation;
    if (payload.departmentId !== undefined) existing.departmentId = clean(payload.departmentId);
    if (payload.teamId !== undefined) existing.teamId = clean(payload.teamId);
    if (payload.managerId !== undefined) existing.managerId = clean(payload.managerId);
    if (payload.reportingManagerId !== undefined) existing.reportingManagerId = clean(payload.reportingManagerId);
    if (payload.mustChangePassword !== undefined) existing.mustChangePassword = !!payload.mustChangePassword;
    if (Array.isArray(payload.reportingChain)) existing.reportingChain = payload.reportingChain;
    if (Array.isArray(payload.subordinates)) existing.subordinates = payload.subordinates;
    const { password: _pw, ...safeUser } = existing;
    return sendJson(res, 200, { success: true, data: safeUser });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uuid = asUuid(req.params.id);
    const found = await client.query('SELECT * FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($1) OR id = $2 LIMIT 1', [req.params.id, uuid || null]);
    const existing = found.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }

    const duplicateError = await validateUserPayload(
      { employeeId: payload.employeeId || existing.employee_id, email: payload.email || existing.email },
      existing.id
    );
    if (duplicateError) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { success: false, message: duplicateError });
    }

    // --- Admin autonomy guards -------------------------------------------
    // 1. The last active administrator can neither be demoted nor
    //    deactivated (otherwise the org strands itself with no admin and
    //    the first-admin bootstrap becomes claimable again).
    // 2. An administrator cannot demote or deactivate their own account
    //    (self lock-out prevention).
    const targetIsSelf = isSelfRef(req, existing.id) || isSelfRef(req, existing.employee_id);
    const targetRoleCode = await roleCodeOf(existing.role_id);
    const targetIsAdmin = targetRoleCode === 'ADMIN' || targetRoleCode === 'SUPERADMIN';
    const incomingRole = payload.role !== undefined && payload.role !== null && payload.role !== ''
      ? normalizeRole(payload.role)
      : null;
    const staysAdmin = incomingRole
      ? (incomingRole === 'ADMIN' || incomingRole === 'SUPERADMIN')
      : targetIsAdmin;
    const staysActive = payload.status !== undefined ? payload.status !== 'Inactive' : existing.is_active !== false;
    if (targetIsAdmin && (!staysAdmin || !staysActive)) {
      const admins = await client.query(
        `SELECT COUNT(*)::int AS count FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE UPPER(r.role_code) IN ('ADMIN','SUPERADMIN') AND u.is_active = TRUE`
      );
      if ((admins.rows[0]?.count ?? 0) <= 1) {
        await client.query('ROLLBACK');
        return sendJson(res, 409, { success: false, message: 'You cannot demote or deactivate the last active administrator account.' });
      }
      if (targetIsSelf) {
        await client.query('ROLLBACK');
        return sendJson(res, 403, { success: false, message: 'You cannot remove your own administrator access or deactivate your own account.' });
      }
    }

    const employeeId = clean(payload.employeeId || payload.employee_id).toUpperCase() || existing.employee_id;
    const fullName = clean(payload.fullName || payload.name) || existing.full_name;
    const email = clean(payload.email).toLowerCase() || existing.email;
    const status = payload.status !== undefined ? (payload.status === 'Inactive' ? false : true) : existing.is_active !== false;
    const roleId = incomingRole
      ? await resolveRoleId(incomingRole)
      : existing.role_id;
    const departmentId = payload.departmentId !== undefined ? await resolveDepartmentId(payload.departmentId) : existing.department_id;
    let teamId = existing.team_id;
    if (payload.teamId !== undefined) {
      const updateTeamRef = clean(payload.teamId);
      teamId = updateTeamRef ? await resolveTeamId(updateTeamRef) : null;
      if (updateTeamRef && !teamId) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: `Unknown team "${updateTeamRef}". Please select a valid team.` });
      }
    }
    const managerRef = payload.managerId !== undefined ? payload.managerId : payload.reportingManagerId;
    let managerId = existing.manager_id;
    if (managerRef !== undefined) {
      managerId = await resolveUserId(managerRef === '' || managerRef == null ? null : managerRef);
    }
    const mustChangePassword = payload.mustChangePassword !== undefined ? !!payload.mustChangePassword : existing.must_change_password === true;

    // Reporting ladder validation (single source of truth: users.manager_id).
    // reporting_chain / subordinates are recomputed server-side after the
    // update — client-supplied values are no longer trusted.
    // The manager is MANDATORY here, exactly as on create: a Level 2+
    // employee must always keep exactly one valid reporting manager, so an
    // update that would leave them without one is rejected (and rolled
    // back, preserving the stored manager_id). Level-1 (CEO) employees must
    // still have NO manager; roles outside the ladder (level 99, including
    // the ADMIN/SUPERADMIN system roles) keep the existing optional-manager
    // behavior because validateReportingLink only requires a manager for
    // in-ladder Level 2+ roles.
    const nextRoleId = roleId || existing.role_id;
    const reportingError = await validateReportingLink(client, {
      selfId: existing.id,
      roleId: nextRoleId,
      departmentId,
      managerId,
      managerIsRequired: true,
    });
    if (reportingError) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: reportingError });
    }

    const existingChain = jsonbOr(existing.reporting_chain, []);
    const existingSubs = jsonbOr(existing.subordinates, []);

    let hash = existing.password;
    if (payload.password && String(payload.password).length > 0) {
      hash = await bcrypt.hash(String(payload.password), 10);
    }

    const updated = await client.query(
      `UPDATE users SET
         employee_id = $1, full_name = $2, email = $3,
         phone = COALESCE(NULLIF($4, ''), phone),
         password = $5, role_id = $6,
         department_id = $7, team_id = $8, manager_id = $9,
         designation = COALESCE(NULLIF($10, ''), designation),
         profile_photo = COALESCE(NULLIF($11, ''), profile_photo),
         is_active = $12,
         account_status = CASE WHEN $12 THEN 'ACTIVE' ELSE 'INACTIVE' END,
         must_change_password = $13,
         reporting_chain = $14, subordinates = $15,
         updated_at = NOW()
       WHERE id = $16
       RETURNING *`,
      [
        employeeId, fullName, email,
        clean(payload.phone), hash, roleId,
        departmentId, teamId, managerId,
        clean(payload.designation), clean(payload.avatarUrl),
        status, mustChangePassword,
        JSON.stringify(existingChain), JSON.stringify(existingSubs),
        existing.id,
      ]
    );
    const row = updated.rows[0];
    // Server-authoritative reporting chains for the whole tree (the link
    // change can affect ancestors and descendants alike).
    await recomputeReportingChains(client);
    await client.query('COMMIT');
    const fresh = await getPool().query(`${USER_SELECT} WHERE u.id = $1`, [row.id]);
    const freshRow = fresh.rows[0] || row;
    const roleCode = await roleCodeOf(freshRow.role_id);
    const mapped = mapUserRow(freshRow);
    return sendJson(res, 200, { success: true, data: mapped });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (error?.code === '23505') {
      return sendJson(res, 409, { success: false, message: 'A user with that employee ID or email already exists.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Update user failed' });
  } finally {
    client.release();
  }
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    if (isSelfRef(req, req.params.id)) {
      return sendJson(res, 400, { success: false, message: 'You cannot delete your own account. Ask another administrator.' });
    }
    fallbackStore.users = fallbackStore.users.filter(u => u.id !== req.params.id && u.employeeId !== req.params.id);
    return sendJson(res, 200, { success: true, message: 'User deleted' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uuid = asUuid(req.params.id);
    const found = await client.query('SELECT * FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($1) OR id = $2 LIMIT 1', [req.params.id, uuid || null]);
    const existing = found.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    if (isSelfRef(req, existing.id) || isSelfRef(req, existing.employee_id)) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: 'You cannot delete your own account. Ask another administrator.' });
    }
    const admins = await client.query(
      `SELECT COUNT(*)::int AS count FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE UPPER(r.role_code) IN ('ADMIN','SUPERADMIN') AND u.is_active = TRUE`
    );
    const isAdmin = await client.query(
      `SELECT 1 FROM roles r WHERE r.id = $1 AND UPPER(r.role_code) IN ('ADMIN','SUPERADMIN')`,
      [existing.role_id]
    );
    if ((admins.rows[0]?.count ?? 0) <= 1 && isAdmin.rows.length > 0) {
      await client.query('ROLLBACK');
      return sendJson(res, 409, { success: false, message: 'You cannot delete the last active administrator account.' });
    }
    await client.query('DELETE FROM hierarchies WHERE user_id = $1', [existing.id]).catch(() => undefined);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [existing.id]).catch(() => undefined);
    await client.query('DELETE FROM users WHERE id = $1', [existing.id]);
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true, message: 'User deleted' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (error?.code === '23503') {
      return sendJson(res, 409, { success: false, message: 'This user still has related records and cannot be deleted.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Delete user failed' });
  } finally {
    client.release();
  }
});

router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 5) {
    return sendJson(res, 400, { success: false, message: 'Password must be at least 5 characters' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const user = fallbackStore.users.find(u => u.id === req.params.id || u.employeeId === req.params.id);
    if (!user) return sendJson(res, 404, { success: false, message: 'User not found' });
    user.password = await bcrypt.hash(password, 10);
    user.mustChangePassword = true;
    return sendJson(res, 200, { success: true, message: 'Password reset successfully' });
  }
  try {
    const uuid = asUuid(req.params.id);
    const found = await getPool().query('SELECT id FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($1) OR id = $2 LIMIT 1', [req.params.id, uuid || null]);
    if (!found.rows[0]) return sendJson(res, 404, { success: false, message: 'User not found' });
    const hash = await bcrypt.hash(password, 10);
    await getPool().query(
      'UPDATE users SET password = $1, must_change_password = TRUE, updated_at = NOW() WHERE id = $2',
      [hash, found.rows[0].id]
    );
    return sendJson(res, 200, { success: true, message: 'Password reset successfully' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Password reset failed' });
  }
});

/* ---------- user permission overrides + audit ---------- */

router.get('/users/:id/permissions', requireAuth, requireSelfOrAdmin('id'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, { success: true, data: [] });
  try {
    const pool = getPool();
    const uuid = asUuid(req.params.id);
    const userResult = await pool.query(
      `SELECT u.id, u.role_id FROM users u
       WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($1) OR u.id = $2 LIMIT 1`,
      [req.params.id, uuid || null]
    );
    if (!userResult.rows[0]) return sendJson(res, 404, { success: false, message: 'User not found' });
    const userId = userResult.rows[0].id;
    const roleId = userResult.rows[0].role_id;

    const result = await pool.query(
      `SELECT p.permission_code, p.module_name, p.action_name,
              COALESCE(rp.is_allowed, FALSE) AS is_allowed,
              up.is_allowed AS user_override
       FROM permissions p
       LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $2
       LEFT JOIN user_permissions up ON up.permission_id = p.id AND up.user_id = $1
       ORDER BY p.module_name, p.action_name, p.permission_code`,
      [userId, roleId]
    );
    return sendJson(res, 200, { success: true, data: result.rows });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission fetch failed' });
  }
});

router.put('/users/:id/permissions', requireAuth, requireAdmin, async (req, res) => {
  const overrides = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Permission overrides saved (demo mode)' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uuid = asUuid(req.params.id);
    const userResult = await client.query('SELECT id FROM users WHERE id::text = $1 OR UPPER(employee_id) = UPPER($1) OR id = $2 LIMIT 1', [req.params.id, uuid || null]);
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    const userId = userResult.rows[0].id;
    for (const override of overrides) {
      const code = clean(override.code || override.permissionCode);
      if (!code) continue;
      const permResult = await client.query('SELECT id FROM permissions WHERE permission_code = $1', [code]);
      if (!permResult.rows[0]) continue;
      if (override.allowed === null || override.allowed === undefined) {
        await client.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_id = $2', [userId, permResult.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason, granted_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
           ON CONFLICT (user_id, permission_id) DO UPDATE SET
             is_allowed = EXCLUDED.is_allowed,
             reason = EXCLUDED.reason,
             updated_at = NOW()`,
          [userId, permResult.rows[0].id, !!override.allowed, clean(override.reason) || 'Configured from User Management']
        );
      }
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true, message: 'User permission overrides saved' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission override save failed' });
  } finally {
    client.release();
  }
});

router.get('/audit-logs', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, { success: true, data: [] });
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const result = await getPool().query(
      `SELECT id, action_code, entity_type, entity_id, actor_user_id, metadata, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return sendJson(res, 200, { success: true, data: result.rows });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Audit log fetch failed' });
  }
});

/* ====================================================================
   DEPARTMENTS
==================================================================== */

async function resolveDepartmentId(ref: any): Promise<string | null> {
  if (!ref) return null;
  const value = String(ref).trim();
  if (!value) return null;
  const uuid = asUuid(value);
  const result = await getPool().query(
    `SELECT id FROM departments WHERE id::text = $1 OR department_code = $2 OR UPPER(department_name) = UPPER($2)
     LIMIT 1`,
    [uuid || value, value]
  );
  return result.rows[0]?.id || null;
}

const fallbackDepartments: Array<{ id: string; name: string; code?: string; description?: string; isActive?: boolean; createdDate: string }> = [];

router.get('/departments', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackDepartments);
  try {
    const result = await getPool().query('SELECT * FROM departments ORDER BY created_at ASC');
    return sendJson(res, 200, result.rows.map(mapDepartmentRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department fetch failed' });
  }
});

router.post('/departments', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const name = clean(payload.name || payload.departmentName || payload.department_name);
  if (!name) return sendJson(res, 400, { success: false, message: 'Department name is required' });
  const code = clean(payload.code || payload.departmentCode || payload.department_code || name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 30);

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackDepartments.find(d => d.id === payload.id || (d.code && d.code === code));
    const item = { id: payload.id || createId('dept'), name, code, description: clean(payload.description), isActive: payload.isActive !== false, createdDate: new Date().toISOString() };
    if (existing) Object.assign(existing, item);
    else fallbackDepartments.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const pool = getPool();
    const existingId = asUuid(payload.id);
    let result;
    if (existingId) {
      result = await pool.query(
        `UPDATE departments
         SET department_name = $2, department_code = $3, description = $4, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [existingId, name, code, clean(payload.description) || null]
      );
    }
    if (!result || result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO departments (department_code, department_name, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW(), NOW())
         ON CONFLICT (department_code) DO UPDATE SET
           department_name = EXCLUDED.department_name,
           description = EXCLUDED.description,
           updated_at = NOW()
         RETURNING *`,
        [code, name, clean(payload.description) || null]
      );
    }
    return sendJson(res, 200, mapDepartmentRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department save failed' });
  }
});

router.delete('/departments/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackDepartments.findIndex(d => d.id === req.params.id || d.code === req.params.id);
    if (idx >= 0) fallbackDepartments.splice(idx, 1);
    return sendJson(res, 200, { success: true, message: 'Department deleted' });
  }
  try {
    const result = await getPool().query('DELETE FROM departments WHERE id::text = $1 OR department_code = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Department not found' });
    return sendJson(res, 200, { success: true, message: 'Department deleted' });
  } catch (error: any) {
    if (error?.code === '23503') {
      return sendJson(res, 409, { success: false, message: 'Department is still assigned to users/teams and cannot be deleted.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department delete failed' });
  }
});

/* ====================================================================
   ROLES
==================================================================== */

router.get('/roles', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const codes = Array.from(new Set(fallbackStore.users.map(u => normalizeRole(u.roleCode || u.role))));
    if (!codes.includes('ADMIN')) codes.unshift('ADMIN');
    return sendJson(res, 200, codes.map(code => ({
      roleId: code, roleName: code, isCustom: code !== 'ADMIN',
      dataVisibility: code === 'ADMIN' ? 'Organization' : 'Own',
      menuAccess: {}, actions: {}, featurePermissions: {}, isSystem: code === 'ADMIN',
    })));
  }
  try {
    await ensureDefaultRoles();
    const result = await getPool().query('SELECT * FROM roles ORDER BY hierarchy_level ASC, role_name ASC');
    return sendJson(res, 200, result.rows.map(mapRoleRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role fetch failed' });
  }
});

router.post('/roles', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const roleIdRaw = clean(payload.roleId || payload.role_code || payload.code);
  const roleName = clean(payload.roleName || payload.role_name || payload.name);
  if (!roleIdRaw || !roleName) {
    return sendJson(res, 400, { success: false, message: 'Role ID and role name are required' });
  }
  const roleCode = roleIdRaw.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
  if (!roleCode) return sendJson(res, 400, { success: false, message: 'Invalid role ID' });
  const dataVisibility = ['Own', 'DownTeam', 'FullTeam', 'Organization'].includes(payload.dataVisibility)
    ? payload.dataVisibility
    : 'Own';
  const menuAccess = payload.menuAccess && typeof payload.menuAccess === 'object' ? payload.menuAccess : null;
  const actions = payload.actions && typeof payload.actions === 'object' ? payload.actions : null;
  const featurePermissions = payload.featurePermissions && typeof payload.featurePermissions === 'object' ? payload.featurePermissions : null;

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, {
      roleId: roleCode,
      roleName,
      isCustom: roleCode !== 'ADMIN',
      menuAccess: menuAccess || {},
      dataVisibility,
      actions: actions || {},
      featurePermissions: featurePermissions || {},
    });
  }

  try {
    const result = await getPool().query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, description, is_active,
                          menu_access, data_visibility, actions, feature_permissions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (role_code) DO UPDATE SET
         role_name = EXCLUDED.role_name,
         description = EXCLUDED.description,
         menu_access = EXCLUDED.menu_access,
         data_visibility = EXCLUDED.data_visibility,
         actions = EXCLUDED.actions,
         feature_permissions = EXCLUDED.feature_permissions,
         updated_at = NOW()
       RETURNING *`,
      [roleCode, roleName, Number(payload.hierarchyLevel) > 0 ? Number(payload.hierarchyLevel) : 99,
        clean(payload.description) || null,
        menuAccess ? JSON.stringify(menuAccess) : null,
        dataVisibility,
        actions ? JSON.stringify(actions) : null,
        featurePermissions ? JSON.stringify(featurePermissions) : null]
    );
    return sendJson(res, 200, mapRoleRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role save failed' });
  }
});

router.delete('/roles/:roleId', requireAuth, requireAdmin, async (req, res) => {
  const roleIdRaw = req.params.roleId;
  if (/^admin$/i.test(roleIdRaw)) {
    return sendJson(res, 400, { success: false, message: 'The Super Admin system role cannot be deleted.' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Role deleted (demo mode)' });
  }
  try {
    const result = await getPool().query(
      'DELETE FROM roles WHERE id::text = $1 OR UPPER(role_code) = UPPER($1) RETURNING id',
      [roleIdRaw]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Role not found' });
    return sendJson(res, 200, { success: true, message: 'Role deleted' });
  } catch (error: any) {
    if (error?.code === '23503') {
      return sendJson(res, 409, { success: false, message: 'Role is assigned to existing users and cannot be deleted.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role delete failed' });
  }
});

/* ====================================================================
   FINE PERMISSIONS (per-role module/action matrix)
==================================================================== */

const FINE_PERMISSION_FLAGS = ['view', 'create', 'edit', 'delete', 'upload'] as const;

/** Demo-mode scratch copy (development only, never used in production). */
const fallbackFinePermissions: Array<{
  id: string;
  roleId: string;
  roleName: string;
  modules: Record<string, Record<string, boolean>>;
  updatedAt: string;
}> = [];

/**
 * Validates + normalizes the modules matrix to the Permissions contract:
 * { <module>: { view, create, edit, delete, upload } } with booleans.
 * Unknown modules are kept (forward compatible) but their flags are
 * coerced to exactly the five known keys; anything else is a 400.
 */
function sanitizeFinePermissionModules(input: any): Record<string, Record<string, boolean>> | { error: string } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'modules must be an object keyed by module name.' };
  }
  const entries = Object.entries(input);
  if (entries.length > 100) {
    return { error: 'Too many modules supplied (max 100).' };
  }
  const sanitized: Record<string, Record<string, boolean>> = {};
  for (const [moduleKey, flags] of entries) {
    const name = String(moduleKey).trim().slice(0, 60);
    if (!name || flags == null || typeof flags !== 'object' || Array.isArray(flags)) {
      return { error: `Module "${moduleKey}" must map to an object of boolean flags.` };
    }
    const row: Record<string, boolean> = {};
    for (const flag of FINE_PERMISSION_FLAGS) {
      row[flag] = (flags as Record<string, unknown>)[flag] === true;
    }
    sanitized[name] = row;
  }
  return sanitized;
}

function mapFinePermissionRow(row: any) {
  return {
    id: row.id,
    roleId: String(row.role_code || '').toLowerCase(),
    roleName: row.role_name || '',
    modules: jsonbOr(row.modules, {}),
  };
}

router.get('/permissions', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackFinePermissions);
  try {
    const result = await getPool().query('SELECT * FROM fine_permissions ORDER BY role_code ASC');
    return sendJson(res, 200, result.rows.map(mapFinePermissionRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission fetch failed' });
  }
});

router.get('/permissions/:roleId', requireAuth, async (req, res) => {
  const roleCode = clean(req.params.roleId).toUpperCase().slice(0, 30);
  if (!roleCode) return sendJson(res, 400, { success: false, message: 'Role ID is required' });
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const found = fallbackFinePermissions.find(p => p.roleId.toUpperCase() === roleCode);
    if (!found) return sendJson(res, 404, { success: false, message: 'Permissions not found for this role' });
    return sendJson(res, 200, found);
  }
  try {
    const result = await getPool().query(
      'SELECT * FROM fine_permissions WHERE UPPER(role_code) = $1 LIMIT 1',
      [roleCode]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Permissions not found for this role' });
    return sendJson(res, 200, mapFinePermissionRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission fetch failed' });
  }
});

router.post('/permissions', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const roleCode = clean(payload.roleId || payload.role_code || payload.roleCode)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 30);
  if (!roleCode) {
    return sendJson(res, 400, { success: false, message: 'roleId is required' });
  }
  const modules = sanitizeFinePermissionModules(payload.modules);
  if ('error' in modules) {
    return sendJson(res, 400, { success: false, message: modules.error });
  }
  const roleName = clean(payload.roleName || payload.role_name) || roleCode;

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = {
      id: roleCode.toLowerCase(),
      roleId: roleCode.toLowerCase(),
      roleName,
      modules,
      updatedAt: new Date().toISOString(),
    };
    const idx = fallbackFinePermissions.findIndex(p => p.roleId.toUpperCase() === roleCode);
    if (idx >= 0) fallbackFinePermissions[idx] = item;
    else fallbackFinePermissions.push(item);
    return sendJson(res, 200, item);
  }

  try {
    // The FK references roles(role_code): provision the parent row first
    // so saving permissions for a brand-new role code just works.
    await resolveRoleId(roleCode);
    const result = await getPool().query(
      `INSERT INTO fine_permissions (role_code, role_name, modules, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (role_code) DO UPDATE SET
         role_name = EXCLUDED.role_name,
         modules = EXCLUDED.modules,
         updated_at = NOW()
       RETURNING *`,
      [roleCode, roleName, JSON.stringify(modules)]
    );
    return sendJson(res, 200, mapFinePermissionRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission save failed' });
  }
});

router.delete('/permissions/:roleId', requireAuth, requireAdmin, async (req, res) => {
  const roleCode = clean(req.params.roleId).toUpperCase().slice(0, 30);
  if (!roleCode) return sendJson(res, 400, { success: false, message: 'Role ID is required' });
  // The ADMIN matrix is load-bearing for the whole authorization model;
  // it can be edited but never deleted outright.
  if (roleCode === 'ADMIN' || roleCode === 'SUPERADMIN') {
    return sendJson(res, 400, { success: false, message: 'The Super Admin permission matrix cannot be deleted.' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackFinePermissions.findIndex(p => p.roleId.toUpperCase() === roleCode);
    if (idx < 0) return sendJson(res, 404, { success: false, message: 'Permissions not found for this role' });
    fallbackFinePermissions.splice(idx, 1);
    return sendJson(res, 200, { success: true, message: 'Permissions deleted' });
  }
  try {
    const result = await getPool().query(
      'DELETE FROM fine_permissions WHERE UPPER(role_code) = $1 RETURNING id',
      [roleCode]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Permissions not found for this role' });
    return sendJson(res, 200, { success: true, message: 'Permissions deleted' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission delete failed' });
  }
});

/* ====================================================================
   TEAMS
==================================================================== */

async function resolveTeamId(ref: any): Promise<string | null> {
  if (!ref) return null;
  const value = String(ref).trim();
  if (!value) return null;
  const uuid = asUuid(value);
  const result = await getPool().query(
    `SELECT id FROM teams WHERE id::text = $1 OR team_code = $2 OR UPPER(team_name) = UPPER($2) LIMIT 1`,
    [uuid || value, value]
  );
  return result.rows[0]?.id || null;
}

async function managerEmployeeId(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const result = await getPool().query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.employee_id || null;
}

router.get('/teams', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, []);
  try {
    const result = await getPool().query(
      `SELECT t.*, lu.employee_id AS leader_employee_id
       FROM teams t
       LEFT JOIN users lu ON lu.id = t.leader_id
       ORDER BY t.created_at ASC`
    );
    return sendJson(res, 200, result.rows.map(mapTeamRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Team fetch failed' });
  }
});

router.post('/teams', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const name = clean(payload.name || payload.teamName || payload.team_name);
  if (!name) return sendJson(res, 400, { success: false, message: 'Team name is required' });
  const code = clean(payload.code || payload.teamCode || name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 30);

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, {
      id: payload.id || createId('team'),
      name,
      code,
      leaderId: clean(payload.leaderId),
      memberIds: Array.isArray(payload.memberIds) ? payload.memberIds : [],
      departmentId: clean(payload.departmentId),
      isActive: true,
      createdDate: new Date().toISOString(),
    });
  }

  try {
    const pool = getPool();
    const existingId = asUuid(payload.id);
    const departmentId = payload.departmentId ? await resolveDepartmentId(payload.departmentId) : null;
    if (!departmentId) {
      return sendJson(res, 400, { success: false, message: 'A valid department is required for the team.' });
    }
    const leaderId = payload.leaderId ? await resolveUserId(payload.leaderId) : null;
    const memberIds = Array.isArray(payload.memberIds) ? payload.memberIds : [];
    let result;
    if (existingId) {
      result = await pool.query(
        `UPDATE teams SET team_name = $2, department_id = $3, leader_id = $4, member_ids = $5, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [existingId, name, departmentId, leaderId, JSON.stringify(memberIds)]
      );
    }
    if (!result || result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO teams (team_code, team_name, department_id, leader_id, member_ids, description, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
         ON CONFLICT (team_code) DO UPDATE SET
           team_name = EXCLUDED.team_name,
           department_id = EXCLUDED.department_id,
           leader_id = EXCLUDED.leader_id,
           member_ids = EXCLUDED.member_ids,
           description = EXCLUDED.description,
           updated_at = NOW()
         RETURNING *`,
        [code, name, departmentId, leaderId, JSON.stringify(memberIds), clean(payload.description) || null]
      );
    }
    const row = result.rows[0];
    const leaderEmployeeId = await managerEmployeeId(row.leader_id);
    return sendJson(res, 200, mapTeamRow({ ...row, leader_employee_id: leaderEmployeeId }));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Team save failed' });
  }
});

router.delete('/teams/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Team deleted (demo mode)' });
  }
  try {
    const result = await getPool().query('DELETE FROM teams WHERE id::text = $1 OR team_code = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Team not found' });
    return sendJson(res, 200, { success: true, message: 'Team deleted' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Team delete failed' });
  }
});

/* ====================================================================
   HIERARCHIES (department-scoped role trees used by the UI)
==================================================================== */

const fallbackHierarchies: Array<Record<string, any>> = [];

router.get('/hierarchies', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackHierarchies);
  try {
    const result = await getPool().query('SELECT * FROM department_hierarchies ORDER BY updated_at DESC');
    return sendJson(res, 200, result.rows.map(mapHierarchyRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy fetch failed' });
  }
});

router.post('/hierarchies', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const layers = Array.isArray(payload.layers) ? payload.layers : [];

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = { ...payload, id: payload.id || createId('hier'), updatedAt: new Date().toISOString() };
    const idx = fallbackHierarchies.findIndex(h => h.departmentId === payload.departmentId);
    if (idx >= 0) fallbackHierarchies[idx] = item;
    else fallbackHierarchies.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const departmentId = await resolveDepartmentId(payload.departmentId);
    if (!departmentId) {
      return sendJson(res, 400, { success: false, message: 'A valid department is required.' });
    }
    const result = await getPool().query(
      `INSERT INTO department_hierarchies (department_id, layers, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (department_id) DO UPDATE SET
         layers = EXCLUDED.layers,
         updated_at = NOW()
       RETURNING *`,
      [departmentId, JSON.stringify(layers)]
    );
    return sendJson(res, 200, mapHierarchyRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy save failed' });
  }
});

router.delete('/hierarchies/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackHierarchies.findIndex(h => h.id === req.params.id || h.departmentId === req.params.id);
    if (idx >= 0) fallbackHierarchies.splice(idx, 1);
    return sendJson(res, 200, { success: true, message: 'Hierarchy deleted' });
  }
  try {
    const result = await getPool().query(
      'DELETE FROM department_hierarchies WHERE id::text = $1 OR department_id::text = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Hierarchy not found' });
    return sendJson(res, 200, { success: true, message: 'Hierarchy deleted' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy delete failed' });
  }
});

/* ====================================================================
   COMPANY-WIDE REPORTING LADDER (Level 1 = CEO ... Level N)
==================================================================== */

router.get('/hierarchy-config', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 200, {
      levels: [],
      unassignedRoles: [],
      setup: { totalUsers: 0, usersWithManager: 0, usersWithoutManager: 0, invalidLinks: [] },
      rules: { levelGap: 1, sameDepartmentRequired: true, level1CrossesDepartments: true, description: 'Ladder configuration requires a database connection.' },
    });
  }
  try {
    return sendJson(res, 200, await buildHierarchyConfig());
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy config fetch failed' });
  }
});

router.put('/hierarchy-config', requireAuth, requireAdmin, async (req, res) => {
  const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (assignments.length === 0) {
    return sendJson(res, 400, { success: false, message: 'assignments[] with { roleId, level } entries is required.' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, data: { levels: [] }, message: 'Ladder saved (demo mode).' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of assignments) {
      const roleCode = String(clean(entry?.roleId)).toUpperCase();
      const level = Number(entry?.level);
      if (!roleCode) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: 'Every assignment needs a roleId.' });
      }
      if (SYSTEM_ROLES.includes(roleCode)) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: `The ${roleCode} system role cannot be placed in the business ladder.` });
      }
      if (!Number.isInteger(level) || level < 0 || level >= UNASSIGNED_LEVEL) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: `Invalid level for ${roleCode}: use a whole number between 1 and ${UNASSIGNED_LEVEL - 1}, or 0 to remove the role from the ladder.` });
      }
      const storedLevel = level === 0 ? UNASSIGNED_LEVEL : level;
      const updated = await client.query(
        `UPDATE roles SET hierarchy_level = $2, updated_at = NOW()
          WHERE UPPER(role_code) = UPPER($1) RETURNING id`,
        [roleCode, storedLevel]
      );
      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        return sendJson(res, 404, { success: false, message: `Role ${roleCode} not found.` });
      }
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true, data: await buildHierarchyConfig() });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy config save failed' });
  } finally {
    client.release();
  }
});

/* ====================================================================
   ORGANOGRAM (auto-generated from users.manager_id — no manual drawing)
==================================================================== */
router.get('/organogram', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const nodes = fallbackStore.users.map(u => ({
      id: u.id, employeeId: u.employeeId, fullName: u.fullName || u.name, name: u.fullName || u.name,
      designation: u.designation || '', roleId: normalizeRole(u.roleCode || u.role), roleName: u.roleCode || u.role,
      level: 0, departmentId: u.departmentId || '', departmentName: '',
      managerId: u.managerId || null, managerEmployeeId: u.managerId || null,
      isActive: u.isActive !== false, avatarUrl: u.avatarUrl || '', directReports: 0,
    }));
    const byId = new Map(nodes.map(n => [n.employeeId, n]));
    for (const n of nodes) n.directReports = nodes.filter(c => c.managerEmployeeId === n.employeeId).length;
    return sendJson(res, 200, { nodes, roots: nodes.filter(n => !n.managerEmployeeId || !byId.has(n.managerEmployeeId)).map(n => n.employeeId) });
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT u.id, u.employee_id, u.full_name, u.designation, u.is_active, u.profile_photo,
              u.manager_id, m.employee_id AS manager_employee_id,
              u.department_id, d.department_name,
              r.role_code, r.role_name, r.hierarchy_level
         FROM users u
         LEFT JOIN users m ON m.id = u.manager_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE UPPER(COALESCE(r.role_code, '')) NOT IN ('ADMIN', 'SUPERADMIN')`
    );
    const nodes = result.rows.map((row: any) => ({
      id: row.id,
      employeeId: row.employee_id,
      fullName: row.full_name,
      name: row.full_name,
      designation: row.designation || '',
      roleId: row.role_code || '',
      roleName: row.role_name || row.role_code || '',
      level: Number(row.hierarchy_level) > 0 ? Number(row.hierarchy_level) : 0,
      departmentId: row.department_id || '',
      departmentName: row.department_name || '',
      managerId: row.manager_id || null,
      managerEmployeeId: row.manager_employee_id || null,
      isActive: row.is_active !== false,
      avatarUrl: row.profile_photo || '',
      directReports: 0,
    }));
    const byEmployeeId = new Map(nodes.map(n => [n.employeeId, n]));
    for (const n of nodes) {
      n.directReports = nodes.filter(c => c.managerEmployeeId === n.employeeId).length;
    }
    const roots = nodes
      .filter(n => !n.managerEmployeeId || !byEmployeeId.has(n.managerEmployeeId))
      .map(n => n.employeeId);
    return sendJson(res, 200, { nodes, roots });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Organogram fetch failed' });
  }
});

/* ====================================================================
   METADATA TYPES
==================================================================== */

router.get('/metadata-types', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.metadataTypes);
  try {
    const result = await getPool().query('SELECT * FROM metadata_types ORDER BY sort_order ASC, label ASC');
    return sendJson(res, 200, result.rows.map(mapMetadataTypeRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type fetch failed' });
  }
});

router.post('/metadata-types', requireAuth, requireAdmin, async (req, res) => {
  const { key, label, description } = req.body || {};
  const normalizedKey = String(key || label || '').trim().replace(/\s+/g, '_');
  if (!normalizedKey || !label) {
    return sendJson(res, 400, { error: 'Type key and label are required' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.metadataTypes.find(item => item.key.toLowerCase() === normalizedKey.toLowerCase());
    if (existing) return sendJson(res, 200, existing);
    const item = { key: normalizedKey, label: String(label), description: String(description || ''), isSystem: false, sortOrder: fallbackStore.metadataTypes.length + 1 };
    fallbackStore.metadataTypes.push(item);
    return sendJson(res, 201, item);
  }
  try {
    const result = await getPool().query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order, created_at)
       VALUES ($1, $2, $3, FALSE, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM metadata_types), NOW())
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
       RETURNING *`,
      [normalizedKey, String(label), String(description || '')]
    );
    return sendJson(res, 200, mapMetadataTypeRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type save failed' });
  }
});

router.delete('/metadata-types/:key', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackStore.metadataTypes.findIndex(item => item.key === req.params.key);
    if (idx < 0) return sendJson(res, 404, { error: 'Metadata type not found' });
    fallbackStore.metadataTypes.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query('DELETE FROM metadata_types WHERE key = $1 RETURNING key', [req.params.key]);
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Metadata type not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type delete failed' });
  }
});

/* ====================================================================
   OPTIONS (metadata values)
==================================================================== */

router.get('/options', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.options);
  try {
    const result = await getPool().query('SELECT * FROM options ORDER BY sort_order ASC, option_value ASC');
    return sendJson(res, 200, result.rows.map(mapOptionRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option fetch failed' });
  }
});

router.post('/options', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const type = clean(payload.type || payload.fieldKey).slice(0, 100);
  const value = clean(payload.value || payload.optionValue);
  if (!type || !value) {
    return sendJson(res, 400, { error: 'Type and value are required' });
  }
  const label = clean(payload.label || payload.optionLabel) || value;
  const isActive = payload.status === undefined ? true : payload.status !== 'Inactive' && payload.status !== 'INACTIVE';
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.options.find(item => item.type === type && item.value === value);
    const item = existing || { id: createId('option'), type, value, label, status: isActive ? 'Active' : 'Inactive', sortOrder: fallbackStore.options.length + 1, meta: {}, createdDate: new Date().toISOString() };
    Object.assign(item, { type, value, label, status: isActive ? 'Active' : 'Inactive', meta });
    if (!existing) fallbackStore.options.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const result = await getPool().query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM options o WHERE o.field_key = $1)), FALSE, $5, $6, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET
         option_label = EXCLUDED.option_label,
         is_active = EXCLUDED.is_active,
         meta = EXCLUDED.meta,
         updated_at = NOW()
       RETURNING *`,
      [type, value, label, payload.sortOrder != null ? Number(payload.sortOrder) : null, isActive, JSON.stringify(meta)]
    );
    return sendJson(res, 200, mapOptionRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option save failed' });
  }
});

router.delete('/options/:type/:value', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.options = fallbackStore.options.filter(o => !(o.type === req.params.type && o.value === req.params.value));
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query(
      'DELETE FROM options WHERE field_key = $1 AND option_value = $2 RETURNING id',
      [req.params.type, req.params.value]
    );
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Option not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option delete failed' });
  }
});

router.post('/options/reorder', requireAuth, requireAdmin, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) {
    return sendJson(res, 400, { error: 'No option order supplied' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!asUuid(id)) continue;
      await client.query('UPDATE options SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i + 1, id]);
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option reorder failed' });
  } finally {
    client.release();
  }
});

/* ====================================================================
   WORKFLOW RULES
==================================================================== */

router.get('/workflow-rules', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.workflowRules);
  try {
    const result = await getPool().query('SELECT * FROM workflow_rules ORDER BY status ASC');
    return sendJson(res, 200, result.rows.map(mapWorkflowRuleRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule fetch failed' });
  }
});

router.post('/workflow-rules', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const status = clean(payload.status);
  if (!status) return sendJson(res, 400, { error: 'Status is required' });
  const allowed = payload.allowedNextStatuses == null ? null : (Array.isArray(payload.allowedNextStatuses) ? payload.allowedNextStatuses : []);
  const item = {
    id: payload.id || createId('workflow-rule'),
    status,
    allowedNextStatuses: allowed,
    requiresLossReason: !!payload.requiresLossReason,
    requiresMeetingType: !!payload.requiresMeetingType,
    requiresFollowUpType: !!payload.requiresFollowUpType,
    requiresNote: !!payload.requiresNote,
    isSystem: !!payload.isSystem,
  };

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.workflowRules.find(rule => rule.status === status);
    if (existing) Object.assign(existing, item);
    else fallbackStore.workflowRules.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const result = await getPool().query(
      `INSERT INTO workflow_rules (status, allowed_next_statuses, requires_loss_reason, requires_meeting_type,
                                   requires_followup_type, requires_note, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (status) DO UPDATE SET
         allowed_next_statuses = EXCLUDED.allowed_next_statuses,
         requires_loss_reason = EXCLUDED.requires_loss_reason,
         requires_meeting_type = EXCLUDED.requires_meeting_type,
         requires_followup_type = EXCLUDED.requires_followup_type,
         requires_note = EXCLUDED.requires_note,
         updated_at = NOW()
       RETURNING *`,
      [status, allowed ? JSON.stringify(allowed) : null, item.requiresLossReason, item.requiresMeetingType,
        item.requiresFollowUpType, item.requiresNote, item.isSystem]
    );
    return sendJson(res, 200, mapWorkflowRuleRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule save failed' });
  }
});

router.delete('/workflow-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackStore.workflowRules.findIndex(rule => rule.id === req.params.id || rule.status === req.params.id);
    if (idx < 0) return sendJson(res, 404, { error: 'Workflow rule not found' });
    fallbackStore.workflowRules.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query('DELETE FROM workflow_rules WHERE id::text = $1 OR status = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Workflow rule not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule delete failed' });
  }
});

/* ====================================================================
   FORM FIELDS
==================================================================== */

router.get('/form-fields', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, []);
  try {
    const result = await getPool().query('SELECT * FROM form_fields ORDER BY section ASC, sort_order ASC, label ASC');
    return sendJson(res, 200, result.rows.map(mapFormFieldRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field fetch failed' });
  }
});

router.post('/form-fields', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const fieldKey = clean(payload.fieldKey || payload.field_key || payload.label);
  const label = clean(payload.label || payload.fieldKey || payload.field_key);
  if (!fieldKey || !label) {
    return sendJson(res, 400, { error: 'fieldKey and label are required' });
  }
  const fieldType = clean(payload.fieldType || payload.field_type) || 'text';
  const isMandatory = !!payload.isMandatory;
  const isVisible = payload.isVisible === undefined ? true : !!payload.isVisible;
  const isSystem = !!payload.isSystem;
  const sortOrder = payload.sortOrder != null ? Number(payload.sortOrder) : 999;

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, {
      id: createId('field'), fieldKey, label, fieldType, section: clean(payload.section),
      isMandatory, isVisible, sortOrder, metadataTypeKey: payload.metadataTypeKey || null,
      placeholder: clean(payload.placeholder), isSystem, createdDate: new Date().toISOString(),
    });
  }

  try {
    const result = await getPool().query(
      `INSERT INTO form_fields (field_key, label, field_type, section, is_mandatory, is_visible, sort_order,
                                metadata_type_key, placeholder, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (field_key) DO UPDATE SET
         label = EXCLUDED.label,
         field_type = EXCLUDED.field_type,
         section = EXCLUDED.section,
         is_mandatory = EXCLUDED.is_mandatory,
         is_visible = EXCLUDED.is_visible,
         sort_order = EXCLUDED.sort_order,
         metadata_type_key = EXCLUDED.metadata_type_key,
         placeholder = EXCLUDED.placeholder,
         updated_at = NOW()
       RETURNING *`,
      [fieldKey, label, fieldType, clean(payload.section), isMandatory, isVisible, sortOrder,
        clean(payload.metadataTypeKey) || null, clean(payload.placeholder) || null, isSystem]
    );
    return sendJson(res, 200, mapFormFieldRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field save failed' });
  }
});

router.delete('/form-fields/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  try {
    const found = await getPool().query('SELECT is_system FROM form_fields WHERE id::text = $1 OR field_key = $1', [req.params.id]);
    if (!found.rows[0]) return sendJson(res, 404, { error: 'Form field not found' });
    if (found.rows[0].is_system) {
      return sendJson(res, 400, { error: 'System fields cannot be deleted.' });
    }
    await getPool().query('DELETE FROM form_fields WHERE id = $1', [found.rows[0].id]);
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field delete failed' });
  }
});

router.post('/form-fields/reorder', requireAuth, requireAdmin, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) return sendJson(res, 400, { error: 'No field order supplied' });
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!asUuid(id)) continue;
      await client.query('UPDATE form_fields SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i + 1, id]);
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field reorder failed' });
  } finally {
    client.release();
  }
});

/* ====================================================================
   NOTIFICATIONS
==================================================================== */

router.get('/notifications/users/:userId', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const list = fallbackStore.notifications
      .filter(item => item.userId === req.params.userId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return sendJson(res, 200, list);
  }
  try {
    const pool = getPool();
    const uuid = asUuid(req.params.userId);
    const result = await pool.query(
      `${NOTIFICATION_SELECT}
       WHERE n.recipient_key = $1 OR n.user_id::text = $1 OR n.user_id = $2
          OR n.user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1))
       ORDER BY n.created_at DESC`,
      [req.params.userId, uuid || null]
    );
    return sendJson(res, 200, result.rows.map(mapNotificationRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification fetch failed' });
  }
});

router.get('/notifications/leads/:leadId', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const list = fallbackStore.notifications
      .filter(item => item.leadId === req.params.leadId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return sendJson(res, 200, list);
  }
  try {
    const uuid = asUuid(req.params.leadId);
    const result = await getPool().query(
      `${NOTIFICATION_SELECT}
       WHERE n.lead_code = $1 OR n.reference_id::text = $1 OR n.reference_id = $2
       ORDER BY n.created_at DESC`,
      [req.params.leadId, uuid || null]
    );
    return sendJson(res, 200, result.rows.map(mapNotificationRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification fetch failed' });
  }
});

router.post('/notifications', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const userIdRef = clean(payload.userId || payload.user_id);
  const title = clean(payload.title);
  const message = clean(payload.message);
  if (!userIdRef || !title) {
    return sendJson(res, 400, { success: false, message: 'userId and title are required' });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = {
      id: payload.id || createId('notification'),
      userId: userIdRef,
      title,
      message: message || '',
      leadId: clean(payload.leadId),
      read: !!payload.read,
      date: payload.date || new Date().toISOString(),
    };
    fallbackStore.notifications.push(item);
    return sendJson(res, 200, { success: true, data: item });
  }

  try {
    const resolvedUserId = await resolveUserId(userIdRef);
    if (!resolvedUserId) {
      return sendJson(res, 400, { success: false, message: 'Recipient user does not exist.' });
    }
    const result = await getPool().query(
      `INSERT INTO notifications (user_id, recipient_key, title, message, lead_code, reference_id,
                                  is_read, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'info', NOW(), NOW())
       RETURNING *`,
      [resolvedUserId, userIdRef, title, message || null, clean(payload.leadId).slice(0, 50) || null,
        asUuid(payload.leadId), !!payload.read]
    );
    return sendJson(res, 201, { success: true, data: mapNotificationRow(result.rows[0]) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification save failed' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = fallbackStore.notifications.find(n => n.id === req.params.id);
    if (!item) return sendJson(res, 404, { success: false, message: 'Notification not found' });
    item.read = true;
    return sendJson(res, 200, { success: true, data: item });
  }
  try {
    const found = await getPool().query(
      `SELECT n.*, u.employee_id AS user_employee_id, u.email AS user_email
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.id::text = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!found.rows[0]) return sendJson(res, 404, { success: false, message: 'Notification not found' });
    if (!callerIsAdmin(req)) {
      const row = found.rows[0];
      const owned = isSelfRef(req, row.recipient_key) ||
        isSelfRef(req, row.user_id) ||
        isSelfRef(req, row.user_employee_id) ||
        isSelfRef(req, row.user_email);
      if (!owned) {
        return sendJson(res, 403, { success: false, message: 'You can only access your own notifications.' });
      }
    }
    const result = await getPool().query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [found.rows[0].id]
    );
    return sendJson(res, 200, { success: true, data: mapNotificationRow(result.rows[0]) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification update failed' });
  }
});

router.post('/notifications/users/:userId/read-all', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.notifications.filter(n => n.userId === req.params.userId).forEach(n => { n.read = true; });
    return sendJson(res, 200, { success: true });
  }
  try {
    const uuid = asUuid(req.params.userId);
    await getPool().query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE recipient_key = $1 OR user_id::text = $1 OR user_id = $2
          OR user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1))`,
      [req.params.userId, uuid || null]
    );
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification update failed' });
  }
});

router.delete('/notifications/users/:userId', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.notifications = fallbackStore.notifications.filter(n => n.userId !== req.params.userId);
    return sendJson(res, 200, { success: true });
  }
  try {
    const uuid = asUuid(req.params.userId);
    await getPool().query(
      `DELETE FROM notifications
       WHERE recipient_key = $1 OR user_id::text = $1 OR user_id = $2
          OR user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1))`,
      [req.params.userId, uuid || null]
    );
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification delete failed' });
  }
});

/* ====================================================================
   LEADS
==================================================================== */

/* ====================================================================
   LEADS - HARDENED
   - PostgreSQL authoritative
   - Authentication required for all mutations
   - Server-side authorization via hierarchy/data-scope (resolveVisibility)
   - Permission checks (leads.create, leads.edit, leads.delete, leads.import, leads.view)
   - Spoofing prevention: assignedBy/created_by/updated_by derived from session
   - assignedTo validated against caller's visible scope
   - Mobile upsert does NOT bypass authz
==================================================================== */

/** Builds the column set + params for the leads upsert (single/bulk). */
export interface LeadRecord {
  leadCode: string;
  customerName: string;
  mobile: string;
  alternateMobile: string | null;
  email: string | null;
  maritalStatus: string | null;
  occupation: string | null;
  address: string | null;
  area: string | null;
  district: string | null;
  division: string | null;
  source: string | null;
  priority: string;
  projectedNCP: number | null;
  sumAssured: number | null;
  collectedNCP: number | null;
  notes: string | null;
  assignedTo: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  lastFollowUpDate: string | null;
  nextFollowUpDate: string | null;
  currentStatus: string | null;
  statusHistory: unknown[];
  assignmentHistory: unknown[];
  documents: unknown[];
  tags: string[];
  customFields: Record<string, any>;
  createdBy: string | null;
  updatedBy: string | null;
  /** Historical Lead Date - written to created_at on INSERT only. */
  createdAt: string | null;
  /** Resolved Previously Assigned user id (previous_assigned_to FK). */
  previousAssignedTo: string | null;
}

const LEAD_IGNORED_KEYS = new Set([
  'id', 'dbId', 'customerName', 'customer_name', 'prospectName', 'prospect_name',
  'mobile', 'mobileNumber', 'alternateMobile', 'email', 'profession', 'occupation',
  'maritalStatus', 'address', 'area', 'district', 'division', 'thana', 'source',
  'priority', 'notes', 'assignedTo', 'assignedBy', 'assignedDate', 'projectedNCP',
  'expectedPremium', 'sumAssured', 'expectedValue', 'collectedNCP', 'lastFollowUpDate',
  'nextFollowUpDate', 'nextCallDate', 'meetingDate', 'tags', 'creationDate', 'timestamp',
  'statusHistory', 'assignmentHistory', 'documents', 'currentStatus', 'customFields',
  'createdBy', 'updatedBy', 'created_by', 'updated_by', 'assigned_by', 'assigned_to',
  'created_at', 'updated_at', 'is_deleted', 'deleted_at', 'deleted_by',
]);

/** Normalize an incoming lead payload (frontend shape) to DB fields - SECURE version.
 *  Caller identity is derived from session, not client.
 *  options.allowUnassigned         - bulk import: a BLANK assignment stays
 *                                    unassigned (schema allows it) instead of
 *                                    silently self-assigning to the caller.
 *  options.preserveSuppliedDates   - bulk import: never substitute "now" for
 *                                    a blank/supplied date; keep exactly what
 *                                    the row says (null when absent).
 */
export async function buildSecureLeadRecord(
  lead: any,
  caller: CallerDbInfo,
  targetAssigned: { userId: string; employeeId: string } | null,
  options?: { allowUnassigned?: boolean; preserveSuppliedDates?: boolean }
): Promise<LeadRecord | { error: string }> {
  const customerName = clean(lead.customerName || lead.customer_name || lead.prospectName || lead.prospect_name);
  const mobile = clean(lead.mobile || lead.mobileNumber || lead.phone);
  if (!customerName || !mobile) {
    return { error: 'Customer name and mobile are required' };
  }
  const numeric = (v: any): number | null => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const leadCode = String(lead.leadCode || lead.lead_code || lead.id || createId('lead')).slice(0, 50);

  // AssignedTo is a validated target. Single-lead create defaults to the
  // caller; the bulk import path may explicitly leave a lead unassigned.
  const preserveDates = options?.preserveSuppliedDates === true;
  const effectiveAssigned = targetAssigned || (options?.allowUnassigned ? null : { userId: caller.id, employeeId: caller.employee_id });
  const assignedToId = effectiveAssigned ? effectiveAssigned.userId : null;
  // Audit actor: the assigner is ALWAYS the authenticated session user.
  let assignedById = caller.id;
  if (!effectiveAssigned) assignedById = null;

  const reserved: Record<string, any> = {
    assignedTo: effectiveAssigned ? effectiveAssigned.employeeId || '' : '',
    assignedBy: effectiveAssigned ? caller.employee_id || '' : '',
    assignedDate: lead.assignedDate || (preserveDates ? '' : new Date().toISOString()),
    projectedNCP: lead.projectedNCP,
    sumAssured: lead.sumAssured,
    collectedNCP: lead.collectedNCP,
    lastFollowUpDate: lead.lastFollowUpDate || null,
    nextFollowUpDate: lead.nextFollowUpDate || null,
    nextCallDate: lead.nextCallDate || null,
    meetingDate: lead.meetingDate || null,
    meetingType: lead.meetingType || null,
    lossReason: lead.lossReason || null,
    followUpType: lead.followUpType || null,
    familyMember: lead.familyMember || null,
    noOfChildren: lead.noOfChildren || null,
    hasChild: lead.hasChild ?? null,
    residenceAddress: lead.residenceAddress || null,
    officeAddress: lead.officeAddress || null,
    otherInfo: lead.otherInfo || null,
    campaignName: lead.campaignName || null,
    productName: lead.productName || null,
    currentStatus: lead.currentStatus || null,
    thana: lead.thana || null,
  };

  const customFields: Record<string, any> = {};
  // Only allow non-authz keys from top-level payload
  for (const [key, value] of Object.entries(lead)) {
    if (LEAD_IGNORED_KEYS.has(key)) continue;
    if (FORBIDDEN_CUSTOM_KEYS.has(key)) continue;
    if (key.startsWith('_')) continue;
    if (value === undefined || value === null) continue;
    // Strip any nested authz attempt
    if (typeof value === 'object') continue; // keep customFields flat for security, but allow primitives
    customFields[key] = value;
  }
  // Merge sanitized customFields bag if provided
  if (lead.customFields && typeof lead.customFields === 'object') {
    const sanitized = sanitizeCustomFields(lead.customFields as any);
    for (const [k, v] of Object.entries(sanitized)) {
      if (v !== undefined && v !== null && v !== '') customFields[k] = v;
    }
  }
  // Reserved fields override (but with secure assignedTo/By)
  for (const [key, value] of Object.entries(reserved)) {
    if (value !== null && value !== undefined && value !== '') customFields[key] = value;
  }

  // Server-side audit/history handling: NEVER trust client-provided actor identity.
  // For any history entries supplied by client (e.g. during create), override actor to session user.
  // Legitimate historical records preserved from DB are handled separately in update paths
  // and are NOT rewritten here - only client-supplied arrays are sanitized.
  let assignmentHistory: unknown[] = Array.isArray(lead.assignmentHistory) ? [...lead.assignmentHistory] : [];
  assignmentHistory = assignmentHistory.map((entry: any) => {
    if (!entry || typeof entry !== 'object') return entry;
    // Always derive actor from authenticated session, ignore client value
    const { changedBy: _cb, updatedBy: _ub, createdBy: _crb, assignedBy: _ab, deletedBy: _db, ...rest } = entry as any;
    return {
      ...rest,
      changedBy: caller.employee_id,
      // Preserve other fields but ensure actor is session-derived
    };
  });

  let statusHistory: unknown[] = Array.isArray(lead.statusHistory) ? [...lead.statusHistory] : [];
  statusHistory = statusHistory.map((entry: any) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { updatedBy: _ub, changedBy: _cb, createdBy: _crb, assignedBy: _ab, deletedBy: _db, ...rest } = entry as any;
    return {
      ...rest,
      updatedBy: caller.employee_id,
    };
  });

  return {
    leadCode,
    customerName,
    mobile,
    alternateMobile: clean(lead.alternateMobile) || null,
    email: clean(lead.email) || null,
    maritalStatus: clean(lead.maritalStatus) || null,
    occupation: clean(lead.occupation || lead.profession) || null,
    address: clean(lead.address) || null,
    area: clean(lead.area) || null,
    district: clean(lead.district) || null,
    division: clean(lead.division) || null,
    source: clean(lead.source) || null,
    priority: clean(lead.priority || 'NORMAL').toUpperCase().slice(0, 30) || 'NORMAL',
    projectedNCP: numeric(lead.projectedNCP ?? lead.expectedPremium),
    sumAssured: numeric(lead.sumAssured ?? lead.expectedValue),
    collectedNCP: numeric(lead.collectedNCP),
    notes: lead.notes != null && lead.notes !== '' ? String(lead.notes) : null,
    assignedTo: assignedToId,
    assignedBy: assignedById,
    assignedAt: preserveDates ? dateOrNull(lead.assignedDate) : (dateOrNull(lead.assignedDate) || new Date().toISOString()),
    lastFollowUpDate: dateOrNull(lead.lastFollowUpDate || lead.lastContactedAt),
    nextFollowUpDate: dateOrNull(lead.nextFollowUpDate || lead.nextFollowUpAt),
    currentStatus: clean(lead.currentStatus).slice(0, 255) || (preserveDates ? '' : 'Untouched'),
    statusHistory,
    assignmentHistory,
    documents: Array.isArray(lead.documents) ? lead.documents : [],
    tags: Array.isArray(lead.tags) ? lead.tags.map(String) : [],
    customFields,
    createdBy: caller.id,
    updatedBy: caller.id,
    // Historical Lead Date (created_at on INSERT; never overwritten on update)
    createdAt: dateOrNull(lead.leadDate || lead.creationDate),
    // Resolved Previously Assigned reference (uuid) when supplied by the import
    previousAssignedTo: asUuid(lead.previousAssignedTo) || asUuid(lead.previous_assigned_to),
  };
}

/** Legacy buildLeadRecord kept for internal use but now delegates to secure version where possible.
 *  For backward compat, it still exists but should NOT be used for authz-sensitive paths.
 */
async function buildLeadRecord(lead: any, resolveRefs = true): Promise<LeadRecord | { error: string }> {
  // This legacy function is kept but will be overridden by secure version in hardened paths.
  // It still respects FORBIDDEN keys removal.
  const customerName = clean(lead.customerName || lead.customer_name || lead.prospectName || lead.prospect_name);
  const mobile = clean(lead.mobile || lead.mobileNumber || lead.phone);
  if (!customerName || !mobile) {
    return { error: 'Customer name and mobile are required' };
  }
  const numeric = (v: any): number | null => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const leadCode = String(lead.leadCode || lead.lead_code || lead.id || createId('lead')).slice(0, 50);
  const assignedTo = clean(lead.assignedTo);
  const assignedBy = clean(lead.assignedBy);
  const assignedToId = resolveRefs && assignedTo ? await resolveUserId(assignedTo) : null;
  const assignedById = resolveRefs && assignedBy ? await resolveUserId(assignedBy) : null;

  const reserved: Record<string, any> = {
    assignedTo: assignedTo || '',
    assignedBy: assignedBy || '',
    assignedDate: lead.assignedDate || null,
    projectedNCP: lead.projectedNCP,
    sumAssured: lead.sumAssured,
    collectedNCP: lead.collectedNCP,
    lastFollowUpDate: lead.lastFollowUpDate || null,
    nextFollowUpDate: lead.nextFollowUpDate || null,
    nextCallDate: lead.nextCallDate || null,
    meetingDate: lead.meetingDate || null,
    meetingType: lead.meetingType || null,
    lossReason: lead.lossReason || null,
    followUpType: lead.followUpType || null,
    familyMember: lead.familyMember || null,
    noOfChildren: lead.noOfChildren || null,
    hasChild: lead.hasChild ?? null,
    residenceAddress: lead.residenceAddress || null,
    officeAddress: lead.officeAddress || null,
    otherInfo: lead.otherInfo || null,
    campaignName: lead.campaignName || null,
    productName: lead.productName || null,
    currentStatus: lead.currentStatus || null,
    thana: lead.thana || null,
  };
  const customFields: Record<string, any> = {};
  for (const [key, value] of Object.entries(lead)) {
    if (LEAD_IGNORED_KEYS.has(key)) continue;
    if (FORBIDDEN_CUSTOM_KEYS.has(key)) continue;
    if (key.startsWith('_')) continue;
    if (value === undefined || value === null) continue;
    customFields[key] = value;
  }
  for (const [key, value] of Object.entries(reserved)) {
    if (value !== null && value !== undefined && value !== '') customFields[key] = value;
  }
  if (lead.customFields && typeof lead.customFields === 'object') {
    const sanitized = sanitizeCustomFields(lead.customFields as any);
    for (const [key, value] of Object.entries(sanitized)) {
      if (value !== undefined && value !== null && value !== '') customFields[key] = value;
    }
  }

  return {
    leadCode,
    customerName,
    mobile,
    alternateMobile: clean(lead.alternateMobile) || null,
    email: clean(lead.email) || null,
    maritalStatus: clean(lead.maritalStatus) || null,
    occupation: clean(lead.occupation || lead.profession) || null,
    address: clean(lead.address) || null,
    area: clean(lead.area) || null,
    district: clean(lead.district) || null,
    division: clean(lead.division) || null,
    source: clean(lead.source) || null,
    priority: clean(lead.priority || 'NORMAL').toUpperCase().slice(0, 30) || 'NORMAL',
    projectedNCP: numeric(lead.projectedNCP ?? lead.expectedPremium),
    sumAssured: numeric(lead.sumAssured ?? lead.expectedValue),
    collectedNCP: numeric(lead.collectedNCP),
    notes: lead.notes != null && lead.notes !== '' ? String(lead.notes) : null,
    assignedTo: assignedToId,
    assignedBy: assignedById,
    assignedAt: dateOrNull(lead.assignedDate),
    lastFollowUpDate: dateOrNull(lead.lastFollowUpDate || lead.lastContactedAt),
    nextFollowUpDate: dateOrNull(lead.nextFollowUpDate || lead.nextFollowUpAt),
    currentStatus: clean(lead.currentStatus).slice(0, 255) || null,
    statusHistory: Array.isArray(lead.statusHistory) ? lead.statusHistory : [],
    assignmentHistory: Array.isArray(lead.assignmentHistory) ? lead.assignmentHistory : [],
    documents: Array.isArray(lead.documents) ? lead.documents : [],
    tags: Array.isArray(lead.tags) ? lead.tags.map(String) : [],
    customFields,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    previousAssignedTo: null,
  };
}

router.get('/leads', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    // Demo mode: still enforce visibility via fallbackStore
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    }
    const visibility = await resolveCallerVisibility(caller);
    if (visibility.all) {
      return sendJson(res, 200, fallbackStore.leads);
    }
    const filtered = fallbackStore.leads.filter((l: any) => {
      const assigned = String(l.assignedTo || '').toUpperCase();
      const callerEmpUpper = String(caller.employee_id || '').toUpperCase();
      if (assigned && assigned === callerEmpUpper) return true;
      // Also check if assignedTo matches any visible employee
      const visEmpUpper = visibility.employeeIds.map((e: string) => String(e).toUpperCase());
      return assigned && visEmpUpper.includes(assigned);
    });
    return sendJson(res, 200, filtered);
  }
  try {
    const pool = getPool();
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    // Permission check: leads.view
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }

    const params: any[] = [];
    const where: string[] = ['l.is_deleted = FALSE'];
    const { startDate, endDate, status, assignedTo, search } = req.query || {};
    if (startDate) { params.push(dateOrNull(String(startDate))); where.push(`l.created_at >= $${params.length}`); }
    if (endDate) { params.push(dateOrNull(String(endDate))); where.push(`l.created_at <= $${params.length}`); }
    if (status) { params.push(String(status)); where.push(`l.current_status = $${params.length}`); }
    if (assignedTo) {
      const assignedResolved = await resolveAssignedTo(String(assignedTo));
      const filterUserId = assignedResolved?.userId || String(assignedTo);
      const filterEmpId = assignedResolved?.employeeId || String(assignedTo);
      params.push(filterUserId, filterEmpId);
      where.push(`(l.assigned_to::text = $${params.length - 1} OR UPPER(l.custom_fields->>'assignedTo') = UPPER($${params.length}))`);
    }
    if (search) {
      params.push(`%${String(search)}%`);
      where.push(`(l.customer_name ILIKE $${params.length} OR l.mobile ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.occupation ILIKE $${params.length})`);
    }
    const visibility = await resolveCallerVisibility(caller);
    if (!visibility.all) {
      params.push(visibility.userIds, visibility.employeeIds);
      const pUser = params.length - 1;
      const pEmp = params.length;
      where.push(`(l.assigned_to::text = ANY($${pUser}::text[]) OR UPPER(l.custom_fields->>'assignedTo') = ANY(ARRAY(SELECT UPPER(unnest) FROM unnest($${pEmp}::text[]) AS unnest)) OR l.created_by::text = ANY($${pUser}::text[]))`);
    }
    const result = await pool.query(
      `${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 5000`,
      params
    );
    return sendJson(res, 200, result.rows.map(mapLeadRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead fetch failed' });
  }
});

const LEAD_UPSERT_SQL = `
  INSERT INTO leads (
    lead_code, customer_name, mobile, alternate_mobile, email, marital_status, occupation,
    address, area, district, division, source, priority, expected_premium, expected_value,
    notes, assigned_to, assigned_by, assigned_at, last_contacted_at, next_follow_up_at,
    current_status, status_history, assignment_history, documents, custom_fields, tags,
    created_by, updated_by, created_at, updated_at, previous_assigned_to
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, $9, $10, $11, $12, COALESCE(NULLIF($13, ''), 'NORMAL'), $14, $15, $16,
    $17, $18, $19, $20, $21,
    COALESCE(NULLIF($22, ''), 'Untouched'),
    COALESCE($23::jsonb, '[]'::jsonb), COALESCE($24::jsonb, '[]'::jsonb),
    COALESCE($25::jsonb, '[]'::jsonb),
    COALESCE($26::jsonb, '{}'::jsonb), COALESCE($27::jsonb, '[]'::jsonb),
    $28, $29,
    COALESCE($30::timestamp, NOW()), NOW(), $31
  )
  ON CONFLICT (lead_code) DO UPDATE SET
    customer_name = EXCLUDED.customer_name,
    mobile = EXCLUDED.mobile,
    alternate_mobile = EXCLUDED.alternate_mobile,
    email = EXCLUDED.email,
    marital_status = EXCLUDED.marital_status,
    occupation = EXCLUDED.occupation,
    address = EXCLUDED.address,
    area = EXCLUDED.area,
    district = EXCLUDED.district,
    division = EXCLUDED.division,
    source = EXCLUDED.source,
    priority = EXCLUDED.priority,
    expected_premium = EXCLUDED.expected_premium,
    expected_value = EXCLUDED.expected_value,
    notes = EXCLUDED.notes,
    assigned_to = EXCLUDED.assigned_to,
    assigned_by = EXCLUDED.assigned_by,
    assigned_at = EXCLUDED.assigned_at,
    last_contacted_at = EXCLUDED.last_contacted_at,
    next_follow_up_at = EXCLUDED.next_follow_up_at,
    current_status = EXCLUDED.current_status,
    status_history = EXCLUDED.status_history,
    assignment_history = EXCLUDED.assignment_history,
    documents = EXCLUDED.documents,
    custom_fields = leads.custom_fields || EXCLUDED.custom_fields,
    tags = EXCLUDED.tags,
    previous_assigned_to = COALESCE($31::uuid, leads.previous_assigned_to),
    updated_by = EXCLUDED.updated_by,
    created_at = COALESCE($30::timestamp, leads.created_at),
    is_deleted = FALSE,
    deleted_at = NULL,
    updated_at = NOW()
  RETURNING *, (xmax = 0) AS _inserted`;

router.post('/leads', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    const visibility = await resolveCallerVisibility(caller);
    const payload = req.body || {};

    // Determine if this is an update (existing lead) via lead_code or mobile
    let existingLead: any = null;
    const incomingLeadCode = String(payload.leadCode || payload.lead_code || payload.id || '').slice(0, 50).trim();
    const incomingMobile = clean(payload.mobile || payload.mobileNumber || payload.phone);

    if (useDb()) {
      const pool = getPool();
      if (incomingLeadCode) {
        const found = await pool.query(
          `SELECT * FROM leads WHERE (lead_code = $1 OR id::text = $1) AND is_deleted = FALSE LIMIT 1`,
          [incomingLeadCode]
        );
        existingLead = found.rows[0] || null;
      }
      if (!existingLead && incomingMobile) {
        const foundMobile = await pool.query(
          `SELECT * FROM leads WHERE UPPER(mobile) = UPPER($1) AND is_deleted = FALSE LIMIT 1`,
          [incomingMobile]
        );
        existingLead = foundMobile.rows[0] || null;
      }
    } else {
      // Demo mode lookup
      if (incomingLeadCode) {
        existingLead = fallbackStore.leads.find((l: any) => l.id === incomingLeadCode) || null;
      }
      if (!existingLead && incomingMobile) {
        existingLead = fallbackStore.leads.find((l: any) => String(l.mobile || '').toUpperCase() === incomingMobile.toUpperCase()) || null;
      }
    }

    // Permission checks
    if (existingLead) {
      // Must have edit permission and access to existing lead
      if (!(await hasPermissionCode(caller, 'leads.edit'))) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to edit leads.' });
      }
      if (!isLeadAccessible(existingLead, visibility, caller)) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to update this lead. It is outside your authorized scope.' });
      }
    } else {
      if (!(await hasPermissionCode(caller, 'leads.create'))) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to create leads.' });
      }
    }

    // Resolve assignedTo target (prevent spoofing)
    let targetAssigned: { userId: string; employeeId: string } | null = null;
    if (payload.assignedTo) {
      const resolved = await resolveAssignedTo(payload.assignedTo);
      if (!resolved) {
        return sendJson(res, 400, { success: false, message: `Assigned user "${payload.assignedTo}" not found.` });
      }
      targetAssigned = resolved;
    } else if (existingLead) {
      // For updates without assignedTo change, keep existing assignment
      if (existingLead.assigned_to) {
        const empId = await managerEmployeeId(existingLead.assigned_to);
        targetAssigned = { userId: existingLead.assigned_to, employeeId: empId || caller.employee_id };
      } else if ((existingLead as any).assignedTo) {
        // FallbackStore shape
        const empId = String((existingLead as any).assignedTo);
        const resolved = await resolveAssignedTo(empId);
        if (resolved) {
          targetAssigned = resolved;
        } else {
          targetAssigned = { userId: caller.id, employeeId: empId || caller.employee_id };
        }
      } else {
        targetAssigned = { userId: caller.id, employeeId: caller.employee_id };
      }
    } else {
      targetAssigned = { userId: caller.id, employeeId: caller.employee_id };
    }

    // Validate assignedTo is within caller's scope
    if (!isAssignedToAllowed(targetAssigned, visibility, caller)) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to assign leads to that user. Assignment is limited to your authorized scope.' });
    }

    // If reassigning to different user, require assign/transfer permission
    if (existingLead && existingLead.assigned_to && targetAssigned && String(existingLead.assigned_to) !== String(targetAssigned.userId)) {
      const canAssign = await hasPermissionCode(caller, 'leads.assign');
      const canTransfer = await hasPermissionCode(caller, 'leads.transfer');
      if (!canAssign && !canTransfer && !visibility.all) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to reassign this lead to another user.' });
      }
    }

    const record = await buildSecureLeadRecord(payload, caller, targetAssigned);
    if ('error' in record) {
      return sendJson(res, 400, { success: false, message: record.error });
    }

    // For updates, merge assignment history server-side if reassigned
    if (existingLead && targetAssigned && String(existingLead.assigned_to) !== String(targetAssigned.userId)) {
      const existingHistory = Array.isArray(existingLead.assignment_history) ? existingLead.assignment_history : [];
      const newEntry = {
        id: `assign_${Date.now()}`,
        fromEmployeeId: existingLead.custom_fields?.assignedTo || await managerEmployeeId(existingLead.assigned_to) || undefined,
        toEmployeeId: targetAssigned.employeeId,
        changedBy: caller.employee_id,
        date: new Date().toISOString(),
        note: 'Reassigned via API',
      };
      (record as any).assignmentHistory = [...existingHistory, newEntry];
      (record as any).customFields = {
        ...(record as any).customFields,
        assignedTo: targetAssigned.employeeId,
        assignedBy: caller.employee_id,
        assignedDate: new Date().toISOString(),
      };
    }

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      // Demo mode: ensure actor identity is always session-derived, never client payload
      // Preserve existing assignment history from stored lead if updating
      let finalAssignmentHistory = record.assignmentHistory;
      let finalStatusHistory = record.statusHistory;
      if (existingLead) {
        const existingAssignHist = Array.isArray((existingLead as any).assignmentHistory) ? (existingLead as any).assignmentHistory : (Array.isArray((existingLead as any).assignment_history) ? (existingLead as any).assignment_history : []);
        const existingStatusHist = Array.isArray((existingLead as any).statusHistory) ? (existingLead as any).statusHistory : (Array.isArray((existingLead as any).status_history) ? (existingLead as any).status_history : []);
        // If reassignment, we already merged in record above for DB path, but for demo we need to handle
        if (existingAssignHist.length > 0 && !(existingLead as any).assigned_to) {
          // Check if reassignment happened (target differs from existing assignedTo)
          const existingAssignedEmp = String((existingLead as any).assignedTo || '').toUpperCase();
          const newAssignedEmp = String(targetAssigned?.employeeId || '').toUpperCase();
          if (existingAssignedEmp && newAssignedEmp && existingAssignedEmp !== newAssignedEmp) {
            const newEntry = {
              id: `assign_${Date.now()}`,
              fromEmployeeId: existingAssignedEmp || undefined,
              toEmployeeId: targetAssigned?.employeeId,
              changedBy: caller.employee_id,
              date: new Date().toISOString(),
              note: 'Reassigned via API',
            };
            finalAssignmentHistory = [...existingAssignHist, newEntry];
          } else {
            // Preserve existing if not reassigning, but ensure no spoofed actor in preserved history? Keep legitimate history as is
            finalAssignmentHistory = existingAssignHist.length > 0 ? existingAssignHist : record.assignmentHistory;
            finalStatusHistory = existingStatusHist.length > 0 ? existingStatusHist : record.statusHistory;
          }
        }
      }
      const lead: any = {
        id: record.leadCode,
        prospectName: record.customerName,
        customerName: record.customerName,
        mobile: record.mobile,
        alternateMobile: record.alternateMobile,
        email: record.email,
        profession: record.occupation || 'Unknown',
        occupation: record.occupation || 'Unknown',
        area: record.area || 'Unknown',
        source: record.source || 'Unknown',
        currentStatus: record.currentStatus || 'Untouched',
        projectedNCP: record.projectedNCP ?? 0,
        collectedNCP: record.collectedNCP ?? 0,
        assignedTo: targetAssigned?.employeeId || caller.employee_id,
        assignedBy: caller.employee_id,
        timestamp: new Date().toISOString(),
        customFields: record.customFields,
        assignmentHistory: finalAssignmentHistory,
        statusHistory: finalStatusHistory,
        // Explicitly ignore any client-supplied actor fields
        createdBy: (existingLead as any)?.createdBy || caller.id,
        updatedBy: caller.id,
      };
      const existingIndex = fallbackStore.leads.findIndex((item: any) => item.id === lead.id || String(item.mobile || '').toUpperCase() === String(lead.mobile || '').toUpperCase());
      if (existingIndex >= 0) fallbackStore.leads[existingIndex] = { ...fallbackStore.leads[existingIndex], ...lead };
      else fallbackStore.leads.push(lead);
      return sendJson(res, 200, { success: true, data: lead });
    }

    try {
      const result = await getPool().query(LEAD_UPSERT_SQL, leadParams(record, record.leadCode));
      const row = result.rows[0];
      const assigned = row.assigned_to ? await managerEmployeeId(row.assigned_to) : null;
      const assignedByEmp = row.assigned_by ? await managerEmployeeId(row.assigned_by) : null;
      return sendJson(res, 200, { success: true, data: mapLeadRow({ ...row, assigned_to_employee_id: assigned, assigned_by_employee_id: assignedByEmp }) });
    } catch (error: any) {
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead save failed' });
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead save failed' });
  }
});

/* ====================================================================
   POST /leads/bulk — HARDENED BULK IMPORT (spreadsheet current-state)
   - Same single endpoint as before (no second import route).
   - Accepts BOTH the real spreadsheet headers (including "Assigned To",
     "Initial Status", "Follow up", "TAT", ...) AND the historical API
     payload shape — mapping lives in server/routes/leadImport.ts.
   - dryRun:true runs the FULL validation + duplicate-detection pipeline
     without writing anything. This powers the Bulk Upload preview and
     performs zero DB mutations.
   - Reference data (users, statuses, campaigns, existing leads,
     permissions) is resolved in bulk — no per-row N+1 queries.
   - Statuses are resolved against the canonical FollowUpStatus options;
     unknown statuses are row-level errors (never silently "Untouched").
   - "Assigned To" must resolve to an ACTIVE users row via the canonical
     employee identifier (employee_id, e.g. "Monsoor_CTG"); a blank value
     leaves the lead unassigned (the schema allows it) instead of faking
     an assignment to the caller.
   - Row-level partial success inside ONE transaction with SAVEPOINTs;
     any hard failure rolls the whole import back and reports failure —
     success is never reported unless PostgreSQL committed.
   - Audit actors always derive from the authenticated session.
==================================================================== */

const BULK_IMPORT_MAX_ROWS = 5000;

interface PlannedImportRow {
  row: ImportRow;
  assigned: { userId: string; employeeId: string } | null;
  previousAssignedUserId: string | null;
  /** Resolved canonical status (latest known state) or '' when blank. */
  currentStatus: string;
  initialStatus: string;
  followUpStatus: string;
  tatValue: number | null;
  amountValue: number | null;
  customFields: Record<string, any>;
  fingerprint: string;
}

interface PlannedImportAction {
  planned: PlannedImportRow;
  action: 'insert' | 'update' | 'upsertByCode' | 'skip';
  existing: any | null;
  leadCode: string;
  batchDuplicateOf: number | null;
}

/** Build the lead payload for buildSecureLeadRecord from a validated row. */
function importRowPayload(p: PlannedImportRow): any {
  const row = p.row;
  const customFields: Record<string, any> = { ...p.customFields };
  if (row.tat !== '' && p.tatValue === null) customFields.tat = row.tat; // preserve non-numeric TAT as text
  if (row.interestedAmount !== '' && p.amountValue === null) customFields.interestedAmount = row.interestedAmount;
  return {
    leadCode: row.leadCode || '',
    prospectName: row.name,
    mobile: row.phone,
    email: row.email,
    area: row.area,
    source: row.source,
    productName: row.product,
    campaignName: row.campaign,
    otherInfo: row.otherInfo,
    notes: row.finalRemarks, // Final Remarks -> first-class notes column
    assignedDate: row.assignedDate || '',
    leadDate: row.leadDate || '',
    lastFollowUpDate: row.firstCallDate || '',
    nextFollowUpDate: row.followUpDate || '',
    currentStatus: p.currentStatus,
    projectedNCP: p.amountValue,
    previousAssignedTo: p.previousAssignedUserId || '',
    customFields,
  };
}

/**
 * Resolve a set of user references (employee_id / email / uuid) in ONE
 * query against the authoritative users table. The returned map is keyed
 * by UPPER(employee_id), UPPER(email) and raw uuid.
 */
export async function bulkResolveUserRefs(refs: string[]): Promise<Map<string, { userId: string; employeeId: string; isActive: boolean }>> {
  const map = new Map<string, { userId: string; employeeId: string; isActive: boolean }>();
  const values = Array.from(new Set(refs.map(r => String(r).trim()).filter(Boolean)));
  if (values.length === 0) return map;
  if (!useDb()) {
    for (const value of values) {
      const user = fallbackStore.users.find((u: any) =>
        u.id === value ||
        String(u.employeeId || '').toUpperCase() === value.toUpperCase() ||
        String(u.email || '').toLowerCase() === value.toLowerCase()
      );
      if (user) {
        const statusText = String((user as any).status ?? (user as any).employmentStatus ?? 'Active');
        const entry = { userId: user.id, employeeId: String(user.employeeId || ''), isActive: statusText.toLowerCase() !== 'inactive' };
        map.set(value.toUpperCase(), entry);
      }
    }
    return map;
  }
  const upper = values.map(v => v.toUpperCase());
  const uuids = values.map(v => asUuid(v)).filter((v): v is string => !!v);
  const result = await getPool().query(
    `SELECT id, employee_id, email, COALESCE(is_active, TRUE) AS is_active
     FROM users
     WHERE UPPER(employee_id) = ANY($1::text[])
        OR UPPER(email) = ANY($1::text[])
        OR ($2::text[] IS NOT NULL AND id::text = ANY($2::text[]))`,
    [upper, uuids.length ? uuids : null]
  );
  for (const row of result.rows) {
    const entry = { userId: String(row.id), employeeId: String(row.employee_id || ''), isActive: row.is_active === true };
    if (row.employee_id) map.set(String(row.employee_id).toUpperCase(), entry);
    if (row.email) map.set(String(row.email).toUpperCase(), entry);
    map.set(String(row.id), entry);
  }
  return map;
}

/**
 * Bulk-import UPDATE: the sheet is a current-state snapshot, so supplied
 * (non-blank) values overwrite and BLANK values preserve the existing
 * lead - a re-import must never wipe data because a cell was empty.
 */
const LEAD_BULK_UPDATE_SQL = `
  UPDATE leads SET
    customer_name = $2,
    alternate_mobile = COALESCE(NULLIF($3, ''), leads.alternate_mobile),
    email = COALESCE(NULLIF($4, ''), leads.email),
    marital_status = COALESCE(NULLIF($5, ''), leads.marital_status),
    occupation = COALESCE(NULLIF($6, ''), leads.occupation),
    address = COALESCE(NULLIF($7, ''), leads.address),
    area = COALESCE(NULLIF($8, ''), leads.area),
    district = COALESCE(NULLIF($9, ''), leads.district),
    division = COALESCE(NULLIF($10, ''), leads.division),
    source = COALESCE(NULLIF($11, ''), leads.source),
    priority = COALESCE(NULLIF($12, ''), leads.priority),
    expected_premium = COALESCE($13, leads.expected_premium),
    expected_value = COALESCE($14, leads.expected_value),
    notes = COALESCE(NULLIF($15, ''), leads.notes),
    assigned_to = COALESCE($16, leads.assigned_to),
    assigned_by = COALESCE($17, leads.assigned_by),
    assigned_at = COALESCE($18, leads.assigned_at),
    previous_assigned_to = COALESCE($19, leads.previous_assigned_to),
    last_contacted_at = COALESCE($20, leads.last_contacted_at),
    next_follow_up_at = COALESCE($21, leads.next_follow_up_at),
    current_status = COALESCE(NULLIF($22, ''), leads.current_status),
    assignment_history = CASE WHEN jsonb_array_length(COALESCE($23::jsonb, '[]'::jsonb)) > 0 THEN $23::jsonb ELSE leads.assignment_history END,
    status_history = CASE WHEN jsonb_array_length(COALESCE($24::jsonb, '[]'::jsonb)) > 0 THEN $24::jsonb ELSE leads.status_history END,
    documents = CASE WHEN jsonb_array_length(COALESCE($25::jsonb, '[]'::jsonb)) > 0 THEN $25::jsonb ELSE leads.documents END,
    tags = CASE WHEN jsonb_array_length(COALESCE($27::jsonb, '[]'::jsonb)) > 0 THEN $27::jsonb ELSE leads.tags END,
    custom_fields = leads.custom_fields || COALESCE($26::jsonb, '{}'::jsonb),
    updated_by = $28,
    is_deleted = FALSE,
    deleted_at = NULL,
    updated_at = NOW()
  WHERE id = $1
  RETURNING id`;

function bulkUpdateParams(record: LeadRecord, existingId: string): any[] {
  return [
    existingId,
    record.customerName,
    record.alternateMobile || '',
    record.email || '',
    record.maritalStatus || '',
    record.occupation || '',
    record.address || '',
    record.area || '',
    record.district || '',
    record.division || '',
    record.source || '',
    record.priority || '',
    record.projectedNCP,
    record.sumAssured,
    record.notes || '',
    record.assignedTo,
    record.assignedBy,
    record.assignedAt,
    record.previousAssignedTo,
    record.lastFollowUpDate,
    record.nextFollowUpDate,
    record.currentStatus,
    JSON.stringify(record.assignmentHistory || []),
    JSON.stringify(record.statusHistory || []),
    JSON.stringify(record.documents || []),
    JSON.stringify(record.customFields || {}),
    JSON.stringify(record.tags || []),
    record.updatedBy,
  ];
}

router.post('/leads/bulk', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  const body: any = Array.isArray(req.body) ? { leads: req.body } : (req.body || {});
  const incoming: any[] = Array.isArray(body.leads) ? body.leads : Array.isArray(req.body) ? req.body : [];
  const dryRun = body.dryRun === true;
  if (incoming.length === 0) {
    return sendJson(res, 400, { success: false, message: 'No leads supplied for bulk import.' });
  }
  if (incoming.length > BULK_IMPORT_MAX_ROWS) {
    return sendJson(res, 413, { success: false, message: `Bulk import is limited to ${BULK_IMPORT_MAX_ROWS} rows per request.` });
  }

  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    }
    const visibility = await resolveCallerVisibility(caller);

    // Permission checks: fetched ONCE for the whole request (never per row).
    const canImport = await hasPermissionCode(caller, 'leads.import');
    const canCreate = await hasPermissionCode(caller, 'leads.create');
    if (!canImport && !canCreate) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to bulk import leads.' });
    }
    const canEdit = await hasPermissionCode(caller, 'leads.edit');
    const canAssign = await hasPermissionCode(caller, 'leads.assign');
    const canTransfer = await hasPermissionCode(caller, 'leads.transfer');

    /* ---- 1. Map rows (real spreadsheet headers + legacy API shape) ---- */
    const rows: ImportRow[] = incoming.map((raw, index) =>
      mapSpreadsheetRow(raw && typeof raw === 'object' ? raw : {}, index)
    );

    /* ---- 2. Reference data in bulk (no per-row queries) ---- */
    let userMap: Map<string, { userId: string; employeeId: string; isActive: boolean }>;
    try {
      userMap = await bulkResolveUserRefs([
        ...rows.map(r => r.assignedTo),
        ...rows.map(r => r.previouslyAssigned),
      ]);
    } catch (error: any) {
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not resolve assigned users.' });
    }

    // Canonical status dictionary = active FollowUpStatus options. When the
    // options table is not migrated/configured yet, fall back to the app's
    // documented built-in status list (the same defaults the UI uses) so
    // imports still resolve against a well-known taxonomy.
    const DEFAULT_STATUS_DICTIONARY = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted', 'Not Interested'];
    let statusList: string[] = [];
    if (useDb()) {
      try {
        const statusRes = await getPool().query(
          `SELECT option_value FROM options WHERE field_key = 'FollowUpStatus' AND COALESCE(is_active, TRUE) = TRUE`
        );
        statusList = statusRes.rows.map((r: any) => String(r.option_value));
      } catch {
        statusList = [];
      }
    } else {
      statusList = fallbackStore.options
        .filter((o: any) => o.type === 'FollowUpStatus' && o.status !== 'Inactive')
        .map((o: any) => String(o.value));
    }
    if (statusList.length === 0) statusList = DEFAULT_STATUS_DICTIONARY;
    const statusDict = new Map(statusList.map(v => [v.toLowerCase(), v]));

    // Existing Campaign option values (for deterministic registration).
    const existingCampaigns = new Set<string>();
    if (useDb()) {
      try {
        const campRes = await getPool().query(`SELECT option_value FROM options WHERE field_key = 'Campaign'`);
        campRes.rows.forEach((r: any) => existingCampaigns.add(String(r.option_value).toLowerCase()));
      } catch {
        // options table not migrated - treat as empty (see registration below)
      }
    } else {
      fallbackStore.options
        .filter((o: any) => o.type === 'Campaign')
        .forEach((o: any) => existingCampaigns.add(String(o.value).toLowerCase()));
    }

    /* ---- 3. Validate every row (pure, no writes) ---- */
    const errors: Array<{ index: number; message: string }> = [];
    const warnings: Array<{ index: number; message: string }> = [];
    const planned: PlannedImportRow[] = [];

    for (const row of rows) {
      const rowErrors: string[] = [...row.issues];
      const rowWarnings: string[] = [];

      // Assignee resolution against the authoritative users data.
      let assigned: { userId: string; employeeId: string } | null = null;
      if (row.assignedTo) {
        const entry = userMap.get(row.assignedTo.toUpperCase()) || userMap.get(row.assignedTo);
        if (!entry || !entry.isActive) {
          rowErrors.push(`Assigned To "${row.assignedTo}" does not match an active user`);
        } else {
          assigned = { userId: entry.userId, employeeId: entry.employeeId };
        }
      }
      // A blank "Assigned To" stays blank: unassigned lead (schema allows
      // it) - never a fake assignment to the importing user.

      if (assigned && !isAssignedToAllowed(assigned, visibility, caller)) {
        rowErrors.push(`Cannot assign to "${row.assignedTo}" - outside your authorized scope`);
      }

      // Previously Assigned: informational. Link when resolvable, always
      // preserve the sheet text; never invalidate the row over it.
      let previousAssignedUserId: string | null = null;
      if (row.previouslyAssigned) {
        const entry = userMap.get(row.previouslyAssigned.toUpperCase()) || userMap.get(row.previouslyAssigned);
        if (entry) {
          previousAssignedUserId = entry.userId;
          if (!entry.isActive) rowWarnings.push(`Previously Assigned "${row.previouslyAssigned}" is inactive; linked for reference`);
        } else {
          rowWarnings.push(`Previously Assigned "${row.previouslyAssigned}" does not match a user; preserved as text`);
        }
      }

      // Status resolution against the canonical dictionary. Unknown
      // statuses are ERRORS - never silently replaced by "Untouched".
      let initialStatus = '';
      if (row.initialStatus) {
        const resolved = statusDict.get(row.initialStatus.toLowerCase());
        if (!resolved) rowErrors.push(`Initial Status "${row.initialStatus}" is not a valid status`);
        else initialStatus = resolved;
      }
      let followUpStatus = '';
      if (row.followUp) {
        const resolved = statusDict.get(row.followUp.toLowerCase());
        if (!resolved) rowErrors.push(`Follow up "${row.followUp}" is not a valid status`);
        else followUpStatus = resolved;
      }
      // Legacy API-shaped rows carry the status in currentStatus - resolve
      // it against the same dictionary (never accepted blindly).
      let legacyStatus = '';
      if (!initialStatus && !followUpStatus && row.currentStatus) {
        const resolved = statusDict.get(row.currentStatus.toLowerCase());
        if (!resolved) rowErrors.push(`Current Status "${row.currentStatus}" is not a valid status`);
        else legacyStatus = resolved;
      }
      const currentStatus = followUpStatus || initialStatus || legacyStatus; // latest known state wins

      const tatValue = parseTat(row.tat);
      const amountValue = parseAmount(row.interestedAmount);

      if (rowErrors.length === 0) {
        const customFields: Record<string, any> = {};
        if (initialStatus) customFields.initialStatus = initialStatus;
        if (followUpStatus) customFields.followUpStatus = followUpStatus;
        if (row.initialRemarks) customFields.initialRemarks = row.initialRemarks;
        if (row.previouslyAssigned) customFields.previouslyAssigned = row.previouslyAssigned;
        if (row.tat !== '' && tatValue !== null) customFields.tat = tatValue;
        planned.push({
          row,
          assigned,
          previousAssignedUserId,
          currentStatus,
          initialStatus,
          followUpStatus,
          tatValue,
          amountValue,
          customFields,
          fingerprint: rowFingerprint(row, assigned ? assigned.employeeId : ''),
        });
      } else {
        for (const message of rowErrors) errors.push({ index: row.index, message });
        for (const message of rowWarnings) warnings.push({ index: row.index, message });
      }
    }

    /* ---- 4. Existing-lead lookup (one query) + duplicate planning ---- */
    const codeCandidates = Array.from(new Set(planned.map(p => p.row.leadCode).filter(Boolean)));
    const phoneCandidates = Array.from(new Set(planned.map(p => normalizePhoneKey(p.row.phone)).filter(Boolean)));
    const emailCandidates = Array.from(new Set(planned.map(p => p.row.email.toLowerCase()).filter(Boolean)));

      let codeMap = new Map<string, any>();
    let phoneMap = new Map<string, any[]>();
    let emailMap = new Map<string, any[]>();
    if (useDb()) {
      const existingRes = await getPool().query(
        `SELECT l.id, l.lead_code, l.mobile, l.email, l.assigned_to, l.current_status,
                l.custom_fields, l.created_by, au.employee_id AS assigned_employee_id
         FROM leads l
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN LATERAL (SELECT REGEXP_REPLACE(COALESCE(l.mobile, ''), '[^0-9]', '', 'g') AS d) ph ON TRUE
         WHERE l.is_deleted = FALSE
           AND (
             ($1::text[] IS NOT NULL AND l.lead_code = ANY($1::text[]))
             OR ($2::text[] IS NOT NULL AND
                 -- mirrors normalizePhoneKey(): strip 880 country code and
                 -- leading 0 so 01711001122 / 8801711001122 / 1711001122 match
                 CASE
                   WHEN LENGTH(ph.d) IN (13, 14) AND LEFT(ph.d, 3) = '880' THEN SUBSTRING(ph.d FROM 4)
                   WHEN LENGTH(ph.d) = 11 AND LEFT(ph.d, 1) = '0' THEN SUBSTRING(ph.d FROM 2)
                   ELSE ph.d
                 END = ANY($2::text[]))
             OR ($3::text[] IS NOT NULL AND UPPER(l.email) = ANY($3::text[]))
           )`,
        [
          codeCandidates.length ? codeCandidates : null,
          phoneCandidates.length ? phoneCandidates : null,
          emailCandidates.length ? emailCandidates.map(e => e.toUpperCase()) : null,
        ]
      );
      for (const lead of existingRes.rows) {
        if (lead.lead_code) codeMap.set(String(lead.lead_code), lead);
        const pkey = normalizePhoneKey(lead.mobile);
        if (pkey) {
          const list = phoneMap.get(pkey) || [];
          list.push(lead);
          phoneMap.set(pkey, list);
        }
        if (lead.email) {
          const ekey = String(lead.email).toLowerCase();
          const list = emailMap.get(ekey) || [];
          list.push(lead);
          emailMap.set(ekey, list);
        }
      }
    } else {
      for (const lead of fallbackStore.leads) {
        if (lead.id || lead.leadCode) codeMap.set(String(lead.id || lead.leadCode), lead);
        const pkey = normalizePhoneKey(lead.mobile);
        if (pkey) {
          const list = phoneMap.get(pkey) || [];
          list.push(lead);
          phoneMap.set(pkey, list);
        }
        if (lead.email) {
          const ekey = String(lead.email).toLowerCase();
          const list = emailMap.get(ekey) || [];
          list.push(lead);
          emailMap.set(ekey, list);
        }
      }
    }

    const actions: PlannedImportAction[] = [];
    const batchByPhone = new Map<string, number>(); // normalized phone -> index in actions[]

    const planErrorsFor = (p: PlannedImportRow, existing: any | null): string | null => {
      // Shared authorization checks for any action that touches an EXISTING lead.
      if (!existing) return null;
      if (!isLeadAccessible(existing, visibility, caller)) {
        return 'Existing lead with this phone/email is outside your authorized scope';
      }
      if (!canEdit) return 'No permission to edit existing leads';
      if (
        existing.assigned_to && p.assigned &&
        String(existing.assigned_to) !== String(p.assigned.userId) &&
        !canAssign && !canTransfer && !visibility.all
      ) {
        return 'No permission to reassign an existing lead';
      }
      return null;
    };

    for (const p of planned) {
      const pkey = normalizePhoneKey(p.row.phone);
      const priorActionIdx = batchByPhone.get(pkey);

      if (priorActionIdx !== undefined) {
        // Duplicate within the same upload - deterministic handling.
        const prior = actions[priorActionIdx];
        if (prior.planned.fingerprint === p.fingerprint) {
          actions.push({ planned: p, action: 'skip', existing: null, leadCode: '', batchDuplicateOf: prior.planned.row.index });
          warnings.push({ index: p.row.index, message: `Exact duplicate of sheet row ${prior.planned.row.index + 1}; skipped` });
        } else {
          // Different content: deterministic last-wins update of the lead
          // the earlier row targets.
          const conflictError = planErrorsFor(p, prior.existing);
          if (conflictError) {
            errors.push({ index: p.row.index, message: conflictError });
            continue;
          }
          warnings.push({ index: p.row.index, message: `Same phone as sheet row ${prior.planned.row.index + 1} with different data; this row wins` });
          actions.push({
            planned: p,
            action: 'upsertByCode',
            existing: prior.existing,
            leadCode: prior.leadCode || importLeadCode(p.row.phone),
            batchDuplicateOf: prior.planned.row.index,
          });
        }
        batchByPhone.set(pkey, actions.length - 1);
        continue;
      }

      // Match against existing leads: lead_code first, then normalized
      // phone, then email as an additional candidate. Ambiguities fail
      // the row instead of silently overwriting the wrong lead.
      let existing: any | null = null;
      let matchError: string | null = null;
      if (p.row.leadCode && codeMap.has(p.row.leadCode)) {
        existing = codeMap.get(p.row.leadCode);
      }
      if (!existing) {
        const phoneMatches = phoneMap.get(pkey) || [];
        if (phoneMatches.length > 1) {
          matchError = `Phone matches ${phoneMatches.length} existing leads - ambiguous, not imported`;
        } else if (phoneMatches.length === 1) {
          existing = phoneMatches[0];
        }
      }
      if (!matchError && p.row.email) {
        const emailMatches = emailMap.get(p.row.email.toLowerCase()) || [];
        if (emailMatches.length > 1) {
          matchError = `Email matches ${emailMatches.length} existing leads - ambiguous, not imported`;
        } else if (emailMatches.length === 1) {
          if (existing && String(existing.id) !== String(emailMatches[0].id)) {
            matchError = 'Phone and email match two different existing leads - ambiguous, not imported';
          } else if (!existing) {
            existing = emailMatches[0];
          }
        }
      }

      if (matchError) {
        errors.push({ index: p.row.index, message: matchError });
        continue;
      }

      if (existing) {
        const conflictError = planErrorsFor(p, existing);
        if (conflictError) {
          errors.push({ index: p.row.index, message: conflictError });
          continue;
        }
        actions.push({ planned: p, action: 'update', existing, leadCode: String(existing.lead_code || ''), batchDuplicateOf: null });
      } else {
        actions.push({ planned: p, action: 'insert', existing: null, leadCode: p.row.leadCode || importLeadCode(p.row.phone), batchDuplicateOf: null });
      }
      batchByPhone.set(pkey, actions.length - 1);
    }

    const summarize = (extra: Record<string, any> = {}) => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const action of actions) {
        if (action.action === 'insert') inserted++;
        else if (action.action === 'skip') skipped++;
        else if (action.action === 'update' || action.action === 'upsertByCode') updated++;
      }
      const failed = rows.length - inserted - updated - skipped;
      return { inserted, updated, skipped, failed, total: rows.length, errors, warnings, ...extra };
    };

    /* ---- 5. Dry run: report the plan without writing anything ---- */
    if (dryRun) {
      return sendJson(res, 200, { success: true, data: summarize({ dryRun: true }) });
    }

    /* ---- 6. Commit ---- */
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      // Dev-demo in-memory mode: same planning, non-persistent store. Never
      // active in production and never reported as a DB success.
      for (const action of actions) {
        const p = action.planned;
        if (action.action === 'skip') continue;
        try {
          const record = buildDemoImportRecord(p, caller);
          if (action.action === 'insert') {
            fallbackStore.leads.push(record);
          } else if (action.existing) {
            Object.assign(action.existing, record, { id: (action.existing as any).id });
          } else {
            const idx = fallbackStore.leads.findIndex((l: any) => String(l.id) === String(action.leadCode));
            if (idx >= 0) fallbackStore.leads[idx] = { ...fallbackStore.leads[idx], ...record };
            else fallbackStore.leads.push(record);
          }
        } catch (err: any) {
          errors.push({ index: p.row.index, message: err?.message || 'Row failed (demo mode)' });
        }
      }
      return sendJson(res, 200, { success: true, data: summarize() });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deterministic campaign auto-registration AFTER validation, inside
      // the same transaction: no duplicate options, and no side effects if
      // the import rolls back.
      const newCampaigns = Array.from(new Set(planned.map(p => p.row.campaign).filter(Boolean)))
        .filter(c => !existingCampaigns.has(c.toLowerCase()));
      let campaignsRegistered = 0;
      if (newCampaigns.length > 0) {
        try {
          const campRes = await client.query(
            `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
             SELECT 'Campaign', c, c,
                    COALESCE((SELECT MAX(sort_order) FROM options WHERE field_key = 'Campaign'), 0) + ROW_NUMBER() OVER (ORDER BY c),
                    FALSE, TRUE, '{}'::jsonb, NOW(), NOW()
             FROM unnest($1::text[]) AS c
             ON CONFLICT (field_key, option_value) DO NOTHING`,
            [newCampaigns]
          );
          campaignsRegistered = campRes.rowCount ?? 0;
        } catch (campErr: any) {
          // Campaign registration is an option-list side effect; the lead
          // data itself is unaffected. Surface it instead of failing rows.
          warnings.push({ index: -1, message: `Campaign auto-registration skipped: ${campErr?.message || 'options table unavailable'}` });
        }
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const action of actions) {
        const p = action.planned;
        if (action.action === 'skip') { skipped++; continue; }
        try {
          await client.query('SAVEPOINT bulk_row');
          const record = await buildSecureLeadRecord(
            importRowPayload(p),
            caller,
            p.assigned,
            { allowUnassigned: true, preserveSuppliedDates: true }
          );
          if ('error' in record) throw new Error(record.error);

          // Server-side assignment history merge when reassigning an
          // existing lead (actor = authenticated caller).
          if ((action.action === 'update' || action.action === 'upsertByCode') && action.existing) {
            const existing = action.existing;
            if (existing.assigned_to && p.assigned && String(existing.assigned_to) !== String(p.assigned.userId)) {
              const existingHistory = Array.isArray(existing.custom_fields?.assignmentHistory)
                ? existing.custom_fields.assignmentHistory
                : [];
              const fromEmployeeId = existing.assigned_employee_id || existing.custom_fields?.assignedTo || undefined;
              (record as any).assignmentHistory = [
                ...existingHistory,
                {
                  id: `assign_${Date.now()}_${p.row.index}`,
                  fromEmployeeId,
                  toEmployeeId: p.assigned.employeeId,
                  changedBy: caller.employee_id,
                  date: new Date().toISOString(),
                  note: 'Reassigned via bulk import',
                },
              ];
              (record as any).customFields = {
                ...(record as any).customFields,
                assignedTo: p.assigned.employeeId,
                assignedBy: caller.employee_id,
                assignedDate: new Date().toISOString(),
              };
            }
          }

          if (action.action === 'insert') {
            const ins = await client.query(LEAD_UPSERT_SQL, leadParams(record, action.leadCode));
            if (!ins.rows[0]) throw new Error('Insert did not return a row');
            // xmax=0 means the row was truly inserted; a conflict-triggered
            // update (e.g. soft-deleted lead resurrected) counts as updated.
            if (ins.rows[0]._inserted === false) updated++;
            else inserted++;
          } else if (action.action === 'update') {
            const upd = await client.query(LEAD_BULK_UPDATE_SQL, bulkUpdateParams(record, String(action.existing.id)));
            if ((upd.rowCount ?? 0) > 0) updated++;
            else throw new Error('Existing lead no longer exists');
          } else { // upsertByCode - duplicate within the same upload
            const ups = await client.query(LEAD_UPSERT_SQL, leadParams(record, action.leadCode));
            if (!ups.rows[0]) throw new Error('Upsert did not return a row');
            if (ups.rows[0]._inserted === false) updated++;
            else inserted++;
          }
          await client.query('RELEASE SAVEPOINT bulk_row');
        } catch (rowErr: any) {
          try { await client.query('ROLLBACK TO SAVEPOINT bulk_row'); } catch {}
          errors.push({ index: p.row.index, message: rowErr?.message || 'Row failed' });
        }
      }

      await client.query('COMMIT');
      const failed = rows.length - inserted - updated - skipped;
      return sendJson(res, 200, {
        success: true,
        data: {
          inserted,
          updated,
          skipped,
          failed,
          total: rows.length,
          errors,
          warnings,
          campaignsRegistered,
        },
      });
    } catch (error: any) {
      try { await client.query('ROLLBACK'); } catch {}
      // No partial success, no fake success: nothing is committed and the
      // response is an explicit failure.
      return sendJson(res, 500, {
        success: false,
        message: error?.message || 'Bulk import failed - no rows were committed.',
        data: { inserted: 0, updated: 0, skipped: 0, failed: rows.length, total: rows.length, errors, warnings, dryRun: false },
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Bulk import failed' });
  }
});

/** Dev-demo (in-memory) snapshot for one planned import row. Never used when a database is configured. */
function buildDemoImportRecord(p: PlannedImportRow, caller: CallerDbInfo): any {
  const row = p.row;
  const leadCode = row.leadCode || importLeadCode(row.phone) || createId('lead');
  const customFields: Record<string, any> = {
    ...p.customFields,
    otherInfo: row.otherInfo || '',
    campaignName: row.campaign || '',
    productName: row.product || '',
    assignedTo: p.assigned ? p.assigned.employeeId : '',
    assignedBy: p.assigned ? caller.employee_id : '',
    assignedDate: row.assignedDate || '',
    tat: p.tatValue ?? row.tat,
  };
  if (row.interestedAmount !== '' && p.amountValue === null) customFields.interestedAmount = row.interestedAmount;
  return {
    id: leadCode,
    leadCode,
    prospectName: row.name,
    customerName: row.name,
    mobile: row.phone,
    email: row.email,
    area: row.area,
    source: row.source,
    productName: row.product || '',
    campaignName: row.campaign || '',
    otherInfo: row.otherInfo || '',
    notes: row.finalRemarks || '',
    assignedTo: p.assigned ? p.assigned.employeeId : '',
    assignedBy: p.assigned ? caller.employee_id : '',
    assignedDate: row.assignedDate || '',
    creationDate: row.leadDate || new Date().toISOString(),
    currentStatus: p.currentStatus || 'Untouched',
    projectedNCP: p.amountValue ?? 0,
    collectedNCP: 0,
    customFields,
    createdBy: caller.id,
    updatedBy: caller.id,
    timestamp: new Date().toISOString(),
  };
}



/** Param array for the canonical lead upsert (now includes created_by, updated_by, created_at, previous_assigned_to). */
function leadParams(record: LeadRecord, leadCode: string): any[] {
  return [
    leadCode,
    record.customerName,
    record.mobile,
    record.alternateMobile,
    record.email,
    record.maritalStatus,
    record.occupation,
    record.address,
    record.area,
    record.district,
    record.division,
    record.source,
    record.priority,
    record.projectedNCP,
    record.sumAssured,
    record.notes,
    record.assignedTo,
    record.assignedBy,
    record.assignedAt,
    record.lastFollowUpDate,
    record.nextFollowUpDate,
    record.currentStatus,
    JSON.stringify(record.statusHistory),
    JSON.stringify(record.assignmentHistory),
    JSON.stringify(record.documents),
    JSON.stringify(record.customFields),
    JSON.stringify(record.tags),
    record.createdBy,
    record.updatedBy,
    record.createdAt,
    record.previousAssignedTo,
  ];
}

/**
 * Server-side guard for single-lead deletion - HARDENED
 * - Requires authentication
 * - Requires leads.delete permission (admin bypass)
 * - Enforces data-scope: caller must have visibility to the lead
 * - FA can only delete own leads (via visibility Own)
 * - Manager can delete downline leads (via DownTeam visibility)
 * - Admin can delete any
 */
async function checkLeadDeletePermission(req: any, res: any): Promise<boolean> {
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
      return false;
    }
    const role = normalizeRole(caller.role_code);
    if (role === 'ADMIN' || role === 'SUPERADMIN') return true;

    const visibility = await resolveCallerVisibility(caller);

    // Fetch lead
    let leadRow: any = null;
    if (useDb()) {
      const pool = getPool();
      const leadResult = await pool.query(
        `SELECT id, assigned_to, custom_fields, created_by FROM leads
         WHERE (lead_code = $1 OR id::text = $1) AND is_deleted = FALSE
         LIMIT 1`,
        [req.params.id]
      );
      leadRow = leadResult.rows[0] || null;
    } else {
      leadRow = fallbackStore.leads.find((l: any) => l.id === req.params.id) || null;
      if (leadRow) {
        // Adapt demo shape to expected fields
        leadRow = {
          assigned_to: null,
          custom_fields: { assignedTo: leadRow.assignedTo },
          created_by: null,
        };
      }
    }

    if (!leadRow) return true; // let handler return 404

    if (!isLeadAccessible(leadRow, visibility, caller)) {
      sendJson(res, 403, { success: false, message: 'You do not have permission to delete this lead. It is outside your authorized scope.' });
      return false;
    }

    if (!(await hasPermissionCode(caller, 'leads.delete'))) {
      sendJson(res, 403, { success: false, message: 'You do not have permission to delete leads.' });
      return false;
    }

    return true;
  } catch (error: any) {
    sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead delete check failed' });
    return false;
  }
}

router.delete('/leads/:id', requireAuth, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    // Demo mode: enforce scope
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    const visibility = await resolveCallerVisibility(caller);
    const lead = fallbackStore.leads.find((l: any) => l.id === req.params.id);
    if (lead) {
      const fakeRow = { assigned_to: null, custom_fields: { assignedTo: lead.assignedTo }, created_by: null };
      if (!isLeadAccessible(fakeRow, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to delete this lead.' });
      }
    }
    fallbackStore.leads = fallbackStore.leads.filter((l: any) => l.id !== req.params.id);
    return sendJson(res, 200, { success: true, message: 'Lead deleted' });
  }
  if (!(await checkLeadDeletePermission(req, res))) return;
  try {
    const caller = await getCallerDbInfo(req);
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
       WHERE (lead_code = $1 OR id::text = $1) AND is_deleted = FALSE
       RETURNING id`,
      [req.params.id, caller?.id || null]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Lead not found' });
    return sendJson(res, 200, { success: true, message: 'Lead deleted' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead delete failed' });
  }
});

router.delete('/leads/campaign/:campaign', requireAuth, requireAdmin, async (req, res) => {
  const campaign = req.params.campaign;
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.leads = fallbackStore.leads.filter((l: any) => l.campaignName !== campaign);
    return sendJson(res, 200, { success: true, message: 'Campaign leads deleted' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
       WHERE custom_fields->>'campaignName' = $1 AND is_deleted = FALSE
       RETURNING id`,
      [campaign, caller?.id || null]
    );
    return sendJson(res, 200, {
      success: true,
      message: result.rows.length > 0 ? 'Campaign leads deleted' : 'No leads found for that campaign',
      deleted: result.rows.length,
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Campaign leads delete failed' });
  }
});

router.post('/leads/clear-all', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.leads = [];
    return sendJson(res, 200, { success: true, message: 'All leads cleared' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $1, updated_by = $1, updated_at = NOW()
       WHERE is_deleted = FALSE RETURNING id`,
      [caller?.id || null]
    );
    return sendJson(res, 200, { success: true, message: 'All leads cleared', deleted: result.rows.length });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead clear failed' });
  }
});


/* ====================================================================
   DASHBOARD
==================================================================== */

router.get('/dashboard', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 200, { success: true, data: { leadCount: fallbackStore.leads.length, userCount: fallbackStore.users.length } });
  }
  try {
    const pool = getPool();
    // Same server-side visibility scope as the leads list, so dashboard
    // counters can never leak another team's totals.
    const caller = req.currentUser || {};
    const visibility = await resolveVisibility(String(caller.id || ''), String(caller.role || caller.roleCode || ''));
    const [leads, users] = await Promise.all([
      visibility.all
        ? pool.query('SELECT COUNT(*)::int AS count FROM leads WHERE is_deleted = FALSE')
        : pool.query(
            `SELECT COUNT(*)::int AS count FROM leads
              WHERE is_deleted = FALSE
                AND (assigned_to::text = ANY($1::text[]) OR custom_fields->>'assignedTo' = ANY($2::text[]))`,
            [visibility.userIds, visibility.employeeIds]
          ),
      visibility.all
        ? pool.query('SELECT COUNT(*)::int AS count FROM users')
        : pool.query('SELECT COUNT(*)::int AS count FROM users WHERE id = ANY($1::uuid[])', [visibility.userIds]),
    ]);
    return sendJson(res, 200, { success: true, data: { leadCount: leads.rows[0].count, userCount: users.rows[0].count } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Dashboard fetch failed' });
  }
});

export default router;
