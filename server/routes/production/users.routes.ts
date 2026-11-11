/**
 * production/users.routes.ts — USERS / ACCESS domain of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the thirty-nine handlers
 * that used to live inline in production.routes.ts — users (incl.
 * bulk import, effective access and per-user permissions), audit
 * logs, departments, role templates, roles, fine permissions, teams,
 * hierarchies, hierarchy config and the organogram — moved verbatim,
 * together with their exclusive helpers (the reporting-ladder
 * machinery, user/role/team/department/hierarchy row mappers and the
 * payload validators). Helpers shared with the remaining monolith
 * domains live in ./shared.js (one definition, imported by both
 * sides); managerEmployeeId / employeeIdsFor moved there in this
 * step because the leads domain also calls them.
 *
 * validateReportingLink / recomputeReportingChains stay importable
 * from production.routes.ts via a re-export (the test suite imports
 * them from there). validateReportingLink is defined here;
 * recomputeReportingChains is defined in database/reportingChains.ts
 * (shared with migration 053) and re-exported from here.
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPool } from '../../database/connection.js';
import { recomputeReportingChains } from '../../database/reportingChains.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import {
  computeDepartmentHealth,
  computeHierarchyHealth,
  emptyDepartmentHealth,
} from '../../utils/hierarchyHealth.js';
import {
  UNASSIGNED_LEVEL,
  resolveRoleLevel,
  reportingManagerRequiredError,
} from '../../utils/reportingRules.js';
import {
  closeUserMemberships,
  getMembershipDepartmentMap,
  hasDepartmentMirrorLayer,
  setDepartmentHeads,
  setUserExtraMemberships,
  syncMirrorTeam,
  syncUserDepartmentMembership,
} from '../../utils/departmentMirror.js';
import {
  listRoleTemplates,
  saveRoleTemplate,
  deleteRoleTemplate,
} from '../../utils/roleTemplates.js';
import {
  buildAccessWarnings,
  resolveEffectivePermissions,
} from '../../utils/effectiveAccess.js';
import {
  fetchInactiveOwnersWithOpenLeads,
  fetchOpenLeadCountMap,
  hasLeadsTable,
  summarizeOpenLeads,
  transferOpenLeads,
  TERMINAL_STATUSES,
} from '../../utils/userDeactivation.js';
import {
  USER_BULK_MAX_ROWS,
  generateTempPassword,
  validatePasswordPolicy,
  normalizeUserBulkRow,
  buildReferenceMaps,
  validateBulkRows,
  type RawUserBulkRow,
  type NormalizedUserBulkRow,
  type ImportMode,
} from '../userBulkImport.js';
import { logAuthAdminPasswordReset } from '../../observability/events.js';
import { getDhakaBusinessDayBounds, TERMINAL_LEAD_STATUSES } from '../../utils/businessTime.js';
import { revokeDangerZoneUnlocks } from '../../services/DangerZoneService.js';
import {
  AUDIT_CHANGE_CAP,
  EMPLOYEE_ID_RE,
  USER_SELECT,
  adminExistsInDb,
  asUuid,
  callerIsAdmin,
  clean,
  dbErrorStatus,
  demoModeAllowed,
  employeeIdsFor,
  ensureDefaultRoles,
  getCallerDbInfo,
  hasPermissionCode,
  isSelfRef,
  jsonbOr,
  logAccessChange,
  managerEmployeeId,
  mapUserRow,
  normalizeRole,
  requireAdmin,
  requireAuth,
  requirePermissionCode,
  requireSelfOrAdmin,
  resolveCallerVisibility,
  resolveRoleId,
  resolveUserId,
  sendDbUnavailable,
  sendJson,
  summarizeAccessChanges,
  useDb,
  withMembershipDepartments,
} from './shared.js';

const router = Router();

/** System roles that exist for platform administration and never take part
 *  in the business reporting ladder (Level 1..N company-wide hierarchy). */
const SYSTEM_ROLES = ['ADMIN', 'SUPERADMIN'];


async function roleCodeOf(roleId: string | null): Promise<string | null> {
  if (!roleId) return null;
  const pool = getPool();
  const result = await pool.query('SELECT role_code FROM roles WHERE id = $1', [roleId]);
  return result.rows[0]?.role_code || null;
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

/** Role display-name lookup (UM-1): the default job title for a new user. */
async function roleDisplayNameOf(exec: { query: Function }, roleId: string | null): Promise<string> {
  if (!roleId) return '';
  const result = await exec.query(
    'SELECT role_name, role_code FROM roles WHERE id = $1 LIMIT 1',
    [roleId]
  );
  const row = result.rows[0];
  return clean(row?.role_name) || clean(row?.role_code) || '';
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
 * Validates a reporting link (UM-1 — owner's role-model fix, 2026-11-11).
 * The manager may be ANY active user; the hard rules are only:
 *   - Level-1 (CEO) employees report to nobody.
 *   - The manager must exist and be active, and must not be the
 *     employee themself.
 *   - Cycles are rejected (an employee can never manage their own ancestor).
 *   - Roles not placed in the ladder (level 99) may omit the manager;
 *     in-ladder Level 2+ employees still REQUIRE one
 *     (`managerIsRequired` MUST be true on create and update).
 *
 * The level-gap and same-department rules that used to reject here
 * (PR #107) are ADVISORY since UM-1: unusual shapes are accepted and
 * surfaced as warnings by the hierarchy-health screen via the shared
 * pure helper `reportingLinkWarnings` (server/utils/reportingRules).
 * (Exported for regression tests; the HTTP routes remain the only callers
 * in production code.)
 */
export async function validateReportingLink(
  exec: { query: Function },
  opts: { selfId: string | null; roleId: string | null; departmentId: string | null; managerId: string | null; managerIsRequired: boolean }
): Promise<string | null> {
  const { selfId, roleId, departmentId, managerId, managerIsRequired } = opts;
  const level = await roleLevelOf(exec, roleId);

  if (level === 1) {
    if (managerId) {
      return 'A Level-1 (CEO) employee cannot report to anyone. Leave the reporting manager empty.';
    }
    return null;
  }

  if (!managerId) {
    const requiredError = reportingManagerRequiredError({
      employeeLevel: level,
      managerIsRequired,
      hasManager: false,
    });
    if (requiredError) return requiredError;
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

  // UM-1: no level-gap / same-department rejection here any more. Any
  // active user may be the manager; unusual link shapes are warnings
  // on the hierarchy-health screen, not write-path blocks.

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
 * The reporting-chain recompute itself lives in
 * database/reportingChains.ts — the database layer owns the derivation
 * so migration 053's one-time repair runs the exact same code as the
 * create / update / delete handlers below. It is re-exported here so
 * the historical import surface (production.routes.ts re-export, the
 * regression tests that import it from there) is unchanged.
 */
export { recomputeReportingChains };

/**
 * Ladder + setup status for the admin hierarchy screen.
 * Reports links whose manager no longer matches the ladder rules
 * (e.g. after levels were changed) without blocking the save.
 */
async function buildHierarchyConfig(
  callerVisibility?: { all: boolean; userIds: string[]; employeeIds: string[] }
) {
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
  // stored manager_id values. Each row carries the person's active
  // department memberships so a link via a manager's ADDITIONAL department
  // seat is judged by the same rule the write path enforces (never flagged
  // as a wrong-department problem).
  const membershipMap = await getMembershipDepartmentMap(pool);
  const healthUsers = (usersResult.rows as any[]).map((row: any) => ({
    ...row,
    department_ids: membershipMap.get(String(row.id)) || [],
  }));
  const health = computeHierarchyHealth(healthUsers as any, levelMap);

  // F16 Phase D — department health. One department = one mirror team, a
  // roster that equals its memberships and a leader that equals its primary
  // head; plus the questions an admin asks first: which departments have
  // nobody in charge, which are empty, who belongs to no department at all.
  // A database without migration 046 reports the block as unavailable
  // instead of inventing zeros that look like "all good".
  let departmentHealth = emptyDepartmentHealth(0);
  if (await hasDepartmentMirrorLayer(pool)) {
    const [deptRows, membershipRows, teamRows] = await Promise.all([
      pool.query(`SELECT id, department_name AS name, is_active FROM departments ORDER BY department_name ASC`),
      pool.query(`SELECT department_id, user_id, is_active, is_primary_head, is_head FROM department_members`),
      pool.query(`SELECT id, department_id, leader_id, member_ids FROM teams WHERE is_department_mirror`),
    ]);
    departmentHealth = computeDepartmentHealth({
      departments: deptRows.rows as any,
      memberships: membershipRows.rows as any,
      mirrorTeams: teamRows.rows as any,
      users: usersResult.rows as any,
      levelByRoleCode: levelMap,
    });
  } else {
    const countRows = await pool.query(`SELECT COUNT(*)::int AS count FROM departments WHERE is_active IS NOT FALSE`);
    departmentHealth = emptyDepartmentHealth(countRows.rows[0]?.count ?? 0);
  }

  // Phase E — lead ownership health: people who are already switched off yet
  // still own open leads. The deactivation guard stops NEW cases; this list is
  // how pre-existing ones (legacy data, an import that archived somebody) are
  // found and fixed from the same screen.
  let ownership: {
    available: boolean;
    inactiveOwnersWithOpenLeads: Array<{ employeeId: string; fullName: string; openLeadCount: number }>;
    totalOpenLeads: number;
  } = { available: false, inactiveOwnersWithOpenLeads: [], totalOpenLeads: 0 };
  try {
    if (await hasLeadsTable(pool)) {
      const inactiveOwners = await fetchInactiveOwnersWithOpenLeads(pool);
      const openTotal = await pool.query(
        `SELECT COUNT(*)::int AS count FROM leads l
          WHERE l.is_deleted = FALSE AND l.current_status <> ALL($1::text[])`,
        [TERMINAL_STATUSES]
      );
      ownership = {
        available: true,
        inactiveOwnersWithOpenLeads: inactiveOwners,
        totalOpenLeads: openTotal.rows[0]?.count ?? 0,
      };
    }
  } catch (error: any) {
    console.warn('Ownership health unavailable:', error?.message || error);
  }

  // Peer lead-visibility (same rule as the roster counts): the per-person
  // stranded-owner list names individuals with their open-lead counts, so a
  // caller only sees the owners inside their own data-visibility scope.
  // Admins / Organization scope keep the full list — this screen is the
  // cleanup tool for exactly those stranded leads. (`totalOpenLeads` is an
  // organisation-level setup total, not attributable to any person, and is
  // left as computed.)
  if (callerVisibility && !callerVisibility.all) {
    const visibleEmployees = new Set(
      (callerVisibility.employeeIds || []).map(e => String(e).toUpperCase())
    );
    ownership = {
      ...ownership,
      inactiveOwnersWithOpenLeads: ownership.inactiveOwnersWithOpenLeads.filter(o =>
        visibleEmployees.has(String(o.employeeId).toUpperCase())
      ),
    };
  }

  return {
    levels,
    unassignedRoles,
    departments: departmentHealth,
    ownership,
    setup: {
      totalUsers: health.totalUsers,
      usersWithManager: health.usersWithManager,
      usersWithoutManager: health.usersWithoutManager,
      invalidLinks: health.invalidLinks,
      warnings: health.warnings,
    },
    rules: {
      levelGap: 2,
      sameDepartmentRequired: false,
      level1CrossesDepartments: true,
      description: 'Level 1 = CEO (company-wide) and reports to no one. Every other employee needs exactly one reporting manager, who may be any active employee (UM-1). Links more than two levels up, or across departments, are allowed and flagged below as warnings.',
    },
  };
}

/* ====================================================================
   ROW MAPPERS  (database rows -> frontend contract)
==================================================================== */


/**
 * Phase E: attach each person's open-lead count to a whole roster in ONE
 * aggregate query (never one query per row), so the client can warn about a
 * deactivation before it is submitted. A database without a `leads` table
 * simply leaves the counts at null.
 */
async function withOpenLeadCounts(exec: any, rows: any[]): Promise<any[]> {
  if (!rows || rows.length === 0) return rows;
  const ids = rows.map(r => String(r.id)).filter(Boolean);
  const counts = await fetchOpenLeadCountMap(exec, ids);
  return rows.map(r => ({ ...r, open_lead_count: counts.get(String(r.id)) ?? 0 }));
}

/**
 * Peer lead-visibility rule (Mahadi's decision, 2026-11-09): an employee
 * must not see ANOTHER employee's lead data — per-person open-lead counts
 * included. A roster row keeps its count only when that person sits inside
 * the CALLER's data-visibility scope (the same scope set that drives lead
 * access: Own / DownTeam / FullTeam / Organization from PRs #103/#104).
 * Out-of-scope rows carry `open_lead_count: null`, which mapUserRow already
 * renders as "counts not loaded for this caller" — the roster itself
 * (names, structure) stays visible for pickers and the org chart, and
 * admins / Organization scope keep every count (the deactivation-handover
 * warning on the Users screen reads them).
 */
function maskOpenLeadCountsForCaller(rows: any[], visibility: { all: boolean; userIds: string[] }): any[] {
  if (!rows || visibility?.all) return rows;
  const visible = new Set((visibility?.userIds || []).map(String));
  return rows.map(r => (visible.has(String(r.id)) ? r : { ...r, open_lead_count: null }));
}

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
    /**
     * Phase C: this team is a DEPARTMENT MIRROR — created, renamed and
     * re-rostered by the department it belongs to. It is listed like any
     * other team (the team a department head leads is a real team), but the
     * generic team endpoints refuse to edit or delete it.
     */
    isDepartmentMirror: row.is_department_mirror === true,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHierarchyRow(row: any) {
  return {
    id: row.id,
    departmentId: row.department_id,
    layers: jsonbOr(row.layers, []),
    updatedAt: row.updated_at,
  };
}

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

router.get('/users', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const users = fallbackStore.users.map(({ password: _pw, ...safe }) => safe);
    return sendJson(res, 200, users);
  }
  try {
    const pool = getPool();
    const result = await pool.query(`${USER_SELECT} ORDER BY u.created_at DESC`);
    // One bulk membership query for the whole roster (never N+1): the client
    // needs each person's member departments to mirror the server's scope.
    const memberships = await getMembershipDepartmentMap(pool);
    const withCounts = await withOpenLeadCounts(pool, result.rows);
    // Peer lead-visibility: counts ride along only for people inside the
    // caller's own data-visibility scope (see maskOpenLeadCountsForCaller).
    const caller = await getCallerDbInfo(req as any);
    const visibility = await resolveCallerVisibility(caller as any);
    const masked = maskOpenLeadCountsForCaller(withCounts, visibility);
    return sendJson(res, 200, masked.map(row => mapUserRow(
      { ...row, department_ids: memberships.get(String(row.id)) || [] },
      row.manager_employee_id
    )));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'User fetch failed' });
  }
});

/* Team overview (FIX-1 item 5): the caller's people from the reporting
   tree, grouped Manager -> Team Leader -> Team Member by the CLIENT,
   each row carrying open / converted / due-today lead counts.
   Visibility is EXACTLY the caller's existing scope
   (resolveCallerVisibility, UM-1 tree floor included): the people list
   is the scoped employee set — nobody outside it is named, and lead
   counts are only attached to people inside it. Tier is structural:
   "manager" = has reports who themselves have reports (or sits at
   ladder level <= 2 with reports), "teamLead" = has direct reports,
   otherwise "teamMember". Counts mirror the roster's definitions
   (open = assigned, not deleted, non-terminal). */
router.get('/team/overview', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req as any);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    const visibility = await resolveCallerVisibility(caller as any);
    const scopeIds = visibility.all
      ? null
      : new Set(visibility.employeeIds.map(e => String(e).toUpperCase()));
    const scopeLabel = visibility.all ? 'Organization' : (scopeIds && scopeIds.size > 1 ? 'Team' : 'Own');

    if (!useDb()) {
      const users = (fallbackStore.users as any[]).filter(u => u.isActive !== false && u.status !== 'Inactive');
      const inScope = (u: any) => !scopeIds || scopeIds.has(String(u.employeeId).toUpperCase());
      const scoped = users.filter(inScope);
      const byKey = new Map<string, any>();
      for (const u of users) { byKey.set(String(u.id), u); byKey.set(String(u.employeeId).toUpperCase(), u); }
      const managerOf = (u: any) => (u.managerId ? byKey.get(String(u.managerId)) : undefined);
      const scopedKeys = new Set<string>();
      for (const u of scoped) { scopedKeys.add(String(u.id)); scopedKeys.add(String(u.employeeId).toUpperCase()); }
      const reportsOf = (u: any) => scoped.filter(r => {
        const m = managerOf(r);
        return m && (String(m.id) === String(u.id));
      });
      const todayBounds = getDhakaBusinessDayBounds(new Date());
      const people = scoped.map(u => {
        const reports = reportsOf(u);
        const tier = reports.length > 0 && reports.some((r: any) => reportsOf(r).length > 0)
          ? 'manager'
          : reports.length > 0 ? 'teamLead' : 'teamMember';
        const mine = (fallbackStore.leads as any[]).filter(l => String(l.assignedTo).toUpperCase() === String(u.employeeId).toUpperCase() && !l.isDeleted);
        const dueToday = mine.filter(l => {
          if (!l.nextFollowUpDate) return false;
          const t = new Date(l.nextFollowUpDate).getTime();
          return t >= new Date(todayBounds.todayStartIso).getTime() && t < new Date(todayBounds.tomorrowStartIso).getTime();
        }).length;
        const mgr = managerOf(u);
        return {
          userId: String(u.id),
          employeeId: u.employeeId,
          name: u.fullName || u.name,
          designation: u.designation || u.roleName || u.role || null,
          roleName: u.roleName || null,
          department: null,
          managerEmployeeId: mgr?.employeeId || null,
          managerName: mgr ? (mgr.fullName || mgr.name) : null,
          tier,
          directReports: reports.length,
          openLeads: mine.filter(l => !(TERMINAL_LEAD_STATUSES as readonly string[]).includes(l.currentStatus)).length,
          convertedLeads: mine.filter(l => l.currentStatus === 'Converted').length,
          dueToday,
          isSelf: String(u.id) === String(caller.id),
        };
      });
      return sendJson(res, 200, { success: true, scope: scopeLabel, people });
    }

    const pool = getPool();
    const peopleRes = await pool.query(
      `SELECT u.id, u.employee_id, u.full_name, u.designation, u.manager_id,
              r.role_code, r.role_name, r.hierarchy_level, d.department_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.is_active = TRUE
       ORDER BY u.full_name ASC`
    );
    const all = peopleRes.rows as any[];
    const inScope = (row: any) => !scopeIds || scopeIds.has(String(row.employee_id).toUpperCase());
    const scoped = all.filter(inScope);
    const scopedIds = new Set(scoped.map(r => String(r.id)));
    const byId = new Map(all.map(r => [String(r.id), r]));
    const childrenCount = new Map<string, number>();
    for (const row of scoped) {
      if (row.manager_id && scopedIds.has(String(row.manager_id))) {
        childrenCount.set(String(row.manager_id), (childrenCount.get(String(row.manager_id)) || 0) + 1);
      }
    }
    const { todayStartIso: startIso, tomorrowStartIso: endIso } = getDhakaBusinessDayBounds(new Date());
    const countsRes = await pool.query(
      `SELECT assigned_to,
              COUNT(*) FILTER (WHERE status NOT IN ('Converted', 'Not Interested'))::int AS open_count,
              COUNT(*) FILTER (WHERE status = 'Converted')::int AS converted_count,
              COUNT(*) FILTER (WHERE next_follow_up_at >= $1 AND next_follow_up_at < $2)::int AS due_today_count
       FROM leads
       WHERE is_deleted = FALSE AND assigned_to IS NOT NULL
       GROUP BY assigned_to`,
      [startIso, endIso]
    );
    const counts = new Map((countsRes.rows as any[]).map(r => [String(r.assigned_to).toUpperCase(), r]));
    const people = scoped.map(row => {
      const directReports = childrenCount.get(String(row.id)) || 0;
      const reportIds = scoped
        .filter(r => r.manager_id && String(r.manager_id) === String(row.id))
        .map(r => String(r.id));
      const hasGrandReports = reportIds.some(id => (childrenCount.get(id) || 0) > 0);
      const level = row.hierarchy_level != null ? Number(row.hierarchy_level) : null;
      const tier = directReports > 0 && (hasGrandReports || (level != null && level <= 2))
        ? 'manager'
        : directReports > 0 ? 'teamLead' : 'teamMember';
      const c = counts.get(String(row.employee_id).toUpperCase()) || {};
      const manager = row.manager_id ? byId.get(String(row.manager_id)) : null;
      return {
        userId: String(row.id),
        employeeId: row.employee_id,
        name: row.full_name,
        designation: row.designation || row.role_name || null,
        roleName: row.role_name || null,
        department: row.department_name || null,
        managerEmployeeId: manager?.employee_id || null,
        managerName: manager?.full_name || null,
        tier,
        directReports,
        openLeads: c.open_count || 0,
        convertedLeads: c.converted_count || 0,
        dueToday: c.due_today_count || 0,
        isSelf: String(row.id) === String(caller.id),
      };
    });
    return sendJson(res, 200, { success: true, scope: scopeLabel, people });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Team overview failed' });
  }
});

/* Reporting-manager candidates for an employee form (UM-1): EVERY
   active user — the manager may be any active employee; the level-gap
   and same-department filters that used to shrink this list (PR #107)
   are gone, because they hid the real line manager whenever the org
   did not match the textbook ladder. Only two exclusions remain, both
   enforced again at save time: the employee themself
   (`excludeEmployeeId`, when editing) and — for a Level-1 (CEO) role —
   everybody (the CEO reports to no one, so the list is empty).
   Rows carry department + ladder level so the form can group and
   search them.
   NOTE: registered BEFORE /users/:id so "reporting-options" is not
   captured as an :id path parameter. */
router.get('/users/reporting-options', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  const roleCode = clean(req.query?.role).toUpperCase();
  if (!roleCode) return sendJson(res, 400, { success: false, message: 'role query parameter is required.' });
  const excludeEmployeeId = clean(req.query?.excludeEmployeeId).toUpperCase();
  if (!useDb()) {
    // Demo mode: the same rule over the in-memory roster (before UM-1
    // this returned [] and the picker was unusable without a database).
    // The store carries no role-level table, so the Level-1 empty list
    // is the client's job here (its form already replaces the picker
    // with "reports to no one" for Level-1 roles); the DB path above
    // enforces it server-side.
    const options = (fallbackStore.users as any[])
      .filter(u => u.isActive !== false && u.status !== 'Inactive'
        && String(u.employeeId || '').toUpperCase() !== excludeEmployeeId)
      .map(u => ({
        id: u.id,
        employeeId: u.employeeId,
        fullName: u.fullName || u.name || '',
        designation: u.designation || '',
        departmentId: u.departmentId || null,
        departmentName: u.departmentName || '',
        hierarchyLevel: UNASSIGNED_LEVEL,
        roleCode: u.roleCode || u.role || '',
        roleName: u.roleName || u.roleCode || u.role || '',
      }))
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    return sendJson(res, 200, options);
  }
  try {
    const pool = getPool();
    const roles = await getRoleRows(pool);
    const role = roles.find(r => String(r.role_code).toUpperCase() === roleCode);
    const level = role ? resolveRoleLevel(role.hierarchy_level) : UNASSIGNED_LEVEL;
    if (level === 1) return sendJson(res, 200, []); // CEO reports to nobody

    const result = await pool.query(
      `SELECT u.id, u.employee_id, u.full_name, u.designation,
              u.department_id, d.department_name,
              r.role_code AS role_code, r.role_name AS role_name, r.hierarchy_level
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.is_active = TRUE
          AND ($1 = '' OR UPPER(u.employee_id) <> $1)
        ORDER BY d.department_name ASC NULLS LAST, u.full_name ASC`,
      [excludeEmployeeId]
    );
    return sendJson(res, 200, result.rows.map((row: any) => ({
      id: row.id,
      employeeId: row.employee_id,
      fullName: row.full_name,
      designation: row.designation || '',
      departmentId: row.department_id || null,
      departmentName: row.department_name || '',
      hierarchyLevel: resolveRoleLevel(row.hierarchy_level),
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
    const row = await withMembershipDepartments(getPool(), result.rows[0]);
    const [withCount] = await withOpenLeadCounts(getPool(), [row]);
    // Same peer rule as the roster: another person's open-lead count is
    // only exposed when they sit inside the caller's visibility scope.
    const caller = await getCallerDbInfo(req as any);
    const visibility = await resolveCallerVisibility(caller as any);
    const [masked] = maskOpenLeadCountsForCaller([withCount || row], visibility);
    return sendJson(res, 200, mapUserRow(masked || row, row.manager_employee_id));
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

router.post('/users', requireAuth, requirePermissionCode('users.create'), async (req, res) => {
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
      // UM-1: title defaults to the role's display name when the caller
      // sent one, else the role code — never the old 'Officer' blanket.
      designation: clean(payload.designation) || clean(payload.roleName) || role,
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
    // UM-1: designation is the job title, separate from the access role.
    // A new user with no title typed gets the role's display name until
    // an admin edits it (before UM-1 everyone silently became 'Officer').
    const roleDisplayName = await roleDisplayNameOf(client, roleId);
    const departmentId = await resolveDepartmentId(payload.departmentId);
    const extraDepartments = await normalizeExtraDepartmentIds(payload.departmentIds);
    if (extraDepartments.error) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: extraDepartments.error });
    }
    // Unknown team references must fail loudly instead of being silently
    // dropped to NULL (the UI would otherwise show a team that the
    // database does not have).
    const teamRef = clean(payload.teamId);
    const teamId = teamRef ? await resolveTeamId(teamRef) : null;
    if (teamRef && !teamId) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: `Unknown team "${teamRef}". Please select a valid team.` });
    }
    let managerId = await resolveUserId(payload.managerId || payload.reportingManagerId || null);

    // Level-1 (CEO) is the org root: a stray manager value sent for a CEO
    // create is normalised away instead of rejected — the form offers no
    // manager picker for Level 1, so there is nothing for the caller to
    // fix. (Bulk import deliberately keeps its explicit per-row error:
    // a spreadsheet CAN be corrected by a human.)
    if ((await roleLevelOf(client, roleId)) === 1) managerId = null;

    // Reporting link (UM-1): the manager may be any active user; only
    // self / cycle / inactive / Level-1-with-manager reject, and an
    // in-ladder Level 2+ employee must have one.
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
        clean(payload.designation) || roleDisplayName,
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
    // Phase C: membership in the department's team follows the assignment,
    // in the SAME transaction — a user can never exist "in" a department
    // without being on its roster.
    await syncUserDepartmentMembership(client, row.id, departmentId || null);
    // Extra seats (a person may belong to more than one department) are
    // written in the same transaction: the roster, the mirror team and the
    // visibility answer all move together or not at all.
    await setUserExtraMemberships(client, row.id, departmentId || null, extraDepartments.ids || []);
    await client.query('COMMIT');
    const fresh = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [row.id]);
    const freshRow = fresh.rows[0] || row;
    const roleCode = await roleCodeOf(freshRow.role_id);
    const created = await withMembershipDepartments(pool, freshRow);
    const mapped = mapUserRow({ ...created, role_code: roleCode, role_name: roleCode });
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

router.put('/users/:id', requireAuth, requirePermissionCode('users.edit'), async (req, res) => {
  const payload = req.body || {};

  // Credential boundary (security fix): the editor's Users → Edit action
  // grants employee-detail edits, NOT password resets. The inline password
  // field on this route would otherwise let a users.edit holder reset
  // another account's password through the side door. Reject it for
  // non-admin callers; admins keep the previous behavior (and also have
  // POST /users/:id/reset-password).
  if (payload.password && String(payload.password).length > 0 && !callerIsAdmin(req)) {
    return sendJson(res, 403, { success: false, message: 'Password reset is restricted to administrators.' });
  }

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

    // Phase E: nobody may be switched off while they still own open leads.
    // The check runs BEFORE any write, so a refused deactivation leaves the
    // account (and every membership) exactly as it was.
    const deactivation = await resolveDeactivationTransfer(client, {
      userId: existing.id,
      employeeId: existing.employee_id,
      departmentId,
      managerId: existing.manager_id,
      willBeActive: status,
      transferRef: payload.transferLeadsTo,
      actingUserId: req.currentUser?.id,
      actingEmployeeId: req.currentUser?.employeeId,
    });
    if (deactivation.error) {
      await client.query('ROLLBACK');
      return sendJson(res, deactivation.error.status, deactivation.error.body);
    }
    const extraDepartments = payload.departmentIds !== undefined
      ? await normalizeExtraDepartmentIds(payload.departmentIds)
      : { ids: null as string[] | null, error: null as string | null };
    if (extraDepartments.error) {
      await client.query('ROLLBACK');
      return sendJson(res, 400, { success: false, message: extraDepartments.error });
    }
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
    // Level-1 self-heal: a CEO row can carry a STALE manager_id (set before
    // a promotion, or by legacy data — migration 053 deliberately never
    // rewrote source links). Echoing it into validateReportingLink would
    // reject EVERY edit of that account forever, and the form offers no
    // picker to clear it (Level 1 shows static "reports to no one" text):
    // a permanent deadlock. A Level-1 save therefore clears the link here,
    // and the recompute below removes the ghost from every derived chain.
    if ((await roleLevelOf(client, nextRoleId)) === 1) managerId = null;
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
    // Phase C: product membership follows the department assignment, in the
    // SAME transaction as the update. Deactivating somebody closes every
    // membership they hold (their mirror teams lose the member, and a head
    // seat is released); any other edit re-points the PRIMARY membership at
    // the new department — the previous one is closed with `left_at`, never
    // deleted. Without this the department column and the team roster could
    // disagree, which is the "one user, two answers" class of bug.
    if (status === false) {
      await closeUserMemberships(client, existing.id);
    } else {
      await syncUserDepartmentMembership(client, row.id, departmentId || null);
      if (extraDepartments.ids !== null) {
        await setUserExtraMemberships(client, row.id, departmentId || null, extraDepartments.ids);
      }
    }
    // Phase E: the hand-over rides in the SAME transaction as the
    // deactivation — either the person is off and their book has a new owner,
    // or nothing happened at all.
    const transfer = deactivation.target
      ? await transferOpenLeads(client, {
          fromUserId: existing.id,
          fromEmployeeId: existing.employee_id,
          toUserId: deactivation.target.id,
          toEmployeeId: deactivation.target.employeeId,
          actorUserId: req.currentUser?.id || null,
          actorEmployeeId: req.currentUser?.employeeId || 'SYSTEM',
          note: status === false
            ? `Transferred when ${existing.employee_id} was deactivated`
            : `Transferred while editing ${existing.employee_id}`,
        })
      : null;
    await client.query('COMMIT');
    const fresh = await getPool().query(`${USER_SELECT} WHERE u.id = $1`, [row.id]);
    const freshRow = fresh.rows[0] || row;
    const roleCode = await roleCodeOf(freshRow.role_id);
    const freshWithMemberships = await withMembershipDepartments(getPool(), freshRow);
    const [freshWithCount] = await withOpenLeadCounts(getPool(), [freshWithMemberships]);
    const mapped = mapUserRow({ ...(freshWithCount || freshWithMemberships), role_code: roleCode, role_name: roleCode });
    // Danger Zone re-lock triggers (DZ-0): a role change, an active-
    // status change or a password set through this route ends any
    // Danger Zone unlock the edited user holds. Best-effort, after
    // the commit, like the ledger entry below.
    if (roleId !== existing.role_id || status !== (existing.is_active !== false) || hash !== existing.password) {
      try { await revokeDangerZoneUnlocks(existing.id); } catch { /* best-effort re-lock */ }
    }
    // The ledger entry lands AFTER the commit (best-effort, like the other
    // access changes): a deactivation is an access event, and the number of
    // leads that moved with it belongs in the record.
    if (status === false && existing.is_active !== false) {
      await logAccessChange({
        actorId: req.currentUser?.id,
        targetUserId: existing.id,
        actionCode: 'user-deactivated',
        entityType: 'user',
        entityId: existing.id,
        metadata: {
          employeeId: existing.employee_id,
          transferredLeads: transfer?.transferred ?? 0,
          transferTargetEmployeeId: deactivation.target?.employeeId || null,
        },
      });
    }
    return sendJson(res, 200, {
      success: true,
      data: mapped,
      ...(transfer
        ? {
            transfer: {
              transferred: transfer.transferred,
              toEmployeeId: deactivation.target?.employeeId || '',
              notified: transfer.notified,
            },
          }
        : {}),
    });
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

router.delete('/users/:id', requireAuth, requirePermissionCode('users.delete'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    if (isSelfRef(req, req.params.id)) {
      return sendJson(res, 400, { success: false, message: 'You cannot delete your own account. Ask another administrator.' });
    }
    // Demo parity for organogram fix 3: the demo upline walk follows
    // managerId live, so re-pointing the reports' links to the deleted
    // user's own manager (skip-level) is the whole chain maintenance.
    const demoTarget = fallbackStore.users.find(u => u.id === req.params.id || u.employeeId === req.params.id);
    if (demoTarget) {
      const inheritedManager = demoTarget.managerId || demoTarget.reportingManagerId || '';
      for (const u of fallbackStore.users) {
        if (u === demoTarget) continue;
        const mgrRef = String(u.managerId || u.reportingManagerId || '');
        if (mgrRef && (mgrRef === demoTarget.employeeId || mgrRef === demoTarget.id)) {
          u.managerId = inheritedManager;
          u.reportingManagerId = inheritedManager;
        }
      }
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
    // Phase E: a removed account must not leave live leads behind. Same rule
    // and same hand-over path as a deactivation (the request may carry
    // `transferLeadsTo` in the body, or ?transferLeadsTo= for a plain DELETE).
    const removal = await resolveDeactivationTransfer(client, {
      userId: existing.id,
      employeeId: existing.employee_id,
      departmentId: existing.department_id,
      managerId: existing.manager_id,
      willBeActive: false,
      transferRef: req.body?.transferLeadsTo ?? req.query?.transferLeadsTo,
      actingUserId: req.currentUser?.id,
      actingEmployeeId: req.currentUser?.employeeId,
    });
    if (removal.error) {
      await client.query('ROLLBACK');
      return sendJson(res, removal.error.status, removal.error.body);
    }
    const removalTransfer = removal.target
      ? await transferOpenLeads(client, {
          fromUserId: existing.id,
          fromEmployeeId: existing.employee_id,
          toUserId: removal.target.id,
          toEmployeeId: removal.target.employeeId,
          actorUserId: req.currentUser?.id || null,
          actorEmployeeId: req.currentUser?.employeeId || 'SYSTEM',
          note: `Transferred when ${existing.employee_id} was removed`,
        })
      : null;
    // Organogram fix 3: a deleted manager must not strand their
    // reports. The edit path recomputes the tree after every write,
    // but the delete path historically relied on the manager_id FK
    // (ON DELETE SET NULL) — reports were left manager-less and every
    // DERIVED chain (reporting_chain / subordinates / hierarchies)
    // kept naming the deleted employee, so chain consumers resolved
    // wrongly (SLA escalation prefers the stored chain and silently
    // skipped the dead level). So, before the row goes, the direct
    // reports inherit the deleted user's own manager (skip-level —
    // the chain stays connected; the reports of a deleted top-level
    // user become top-level). The ladder's 1–2 level rule governs
    // links an admin PICKS; an inherited link that spans more is
    // surfaced by the hierarchy health screen for tidying, exactly
    // like links left out-of-ladder by a role-level change.
    const reportsResult = await client.query(
      'SELECT id, employee_id FROM users WHERE manager_id = $1 ORDER BY employee_id ASC',
      [existing.id]
    );
    const directReports = reportsResult.rows as Array<{ id: string; employee_id: string }>;
    let reportsNewManagerEmployeeId: string | null = null;
    if (directReports.length > 0 && existing.manager_id) {
      const mgrRow = await client.query('SELECT employee_id FROM users WHERE id = $1', [existing.manager_id]);
      reportsNewManagerEmployeeId = mgrRow.rows[0]?.employee_id || null;
    }
    if (directReports.length > 0) {
      await client.query(
        'UPDATE users SET manager_id = $2, updated_at = NOW() WHERE manager_id = $1',
        [existing.id, existing.manager_id || null]
      );
    }
    await client.query('DELETE FROM hierarchies WHERE user_id = $1', [existing.id]).catch(() => undefined);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [existing.id]).catch(() => undefined);
    // Phase C: close memberships FIRST so the mirror teams lose the member
    // cleanly (a cascade would erase the row without updating the teams).
    await closeUserMemberships(client, existing.id);
    await client.query('DELETE FROM users WHERE id = $1', [existing.id]);
    // Same server-authoritative recompute the edit path runs: every
    // derived chain now reflects the post-delete tree (the deleted
    // employee drops out of their former manager's subordinates, the
    // re-pointed reports' chains start at their new manager, and the
    // hierarchies sync rows follow). Runs inside the transaction, so
    // a recompute failure rolls the whole delete back.
    await recomputeReportingChains(client);
    await client.query('COMMIT');
    // target_user_id is left NULL on purpose: the row it pointed at is gone
    // (the FK is ON DELETE SET NULL anyway), so the employee id is recorded
    // in the metadata where it stays readable.
    if (removalTransfer || directReports.length > 0) {
      await logAccessChange({
        actorId: req.currentUser?.id,
        targetUserId: null,
        actionCode: 'user-deleted',
        entityType: 'user',
        entityId: existing.id,
        metadata: {
          employeeId: existing.employee_id,
          transferredLeads: removalTransfer?.transferred ?? 0,
          transferTargetEmployeeId: removal.target?.employeeId || null,
          reportsRepointed: directReports.length,
          reportsNewManagerEmployeeId,
        },
      });
    }
    return sendJson(res, 200, {
      success: true,
      message: 'User deleted',
      ...(removalTransfer
        ? {
            transfer: {
              transferred: removalTransfer.transferred,
              toEmployeeId: removal.target?.employeeId || '',
              notified: removalTransfer.notified,
            },
          }
        : {}),
    });
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

// Credential boundary (security fix): the migration-025 catalog has NO
// dedicated password-reset / credential-management code, and none may be
// invented here. Admin password reset therefore stays ADMIN-only via the
// pre-existing requireAdmin guard — generic users.edit must never be able
// to set another account's password. (Self-service password change is
// POST /auth/change-password and never requires any admin capability.)
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
    logAuthAdminPasswordReset({ actorUserId: req.currentUser?.id, targetUserId: user.id });
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
    // Danger Zone re-lock trigger (DZ-0): an admin reset ends any
    // Danger Zone unlock the target holds. Best-effort.
    try { await revokeDangerZoneUnlocks(found.rows[0].id); } catch { /* best-effort re-lock */ }
    logAuthAdminPasswordReset({ actorUserId: req.currentUser?.id, targetUserId: found.rows[0].id });
    return sendJson(res, 200, { success: true, message: 'Password reset successfully' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Password reset failed' });
  }
});

/* ===================================================================
   BULK USER IMPORT & PROVISIONING
   -------------------------------------------------------------------
   Endpoints:
     POST /users/bulk/validate — dry run, no mutation
     POST /users/bulk/commit   — revalidate + create/update with savepoints
   Security:
     - requires users.create for creates, users.edit for updates
     - ADMIN/SUPERADMIN bypass via hasPermissionCode
     - Feature Access alone never authorizes
     - password never stored plaintext, never logged, returned once only
     - existing user password NEVER changed via bulk
   Performance:
     - bulk reference loads, no N+1, recompute chains once after batch
   =================================================================== */

async function loadUserBulkReferenceData(pool: any, batchEmployeeIds: string[], batchEmails: string[], managerEmployeeIds: string[]) {
  // Bulk load roles, departments, teams, existing users, all users for cycle detection
  const rolesRes = await pool.query(`SELECT id, role_code, role_name, hierarchy_level, is_active FROM roles ORDER BY hierarchy_level ASC`);
  const deptsRes = await pool.query(`SELECT id, department_code, department_name, is_active FROM departments ORDER BY department_name ASC`);
  const teamsRes = await pool.query(`SELECT id, team_code, team_name, is_active FROM teams ORDER BY team_name ASC`);

  // Existing users that match batch employee_ids or emails
  const empUpperList = batchEmployeeIds.map(id => id.toUpperCase()).filter(Boolean);
  const emailLowerList = batchEmails.map(e => e.toLowerCase()).filter(Boolean);
  const mgrUpperList = managerEmployeeIds.map(id => id.toUpperCase()).filter(Boolean);

  const allLookupIds = Array.from(new Set([...empUpperList, ...mgrUpperList]));

  let existingUsers: any[] = [];
  if (allLookupIds.length > 0 || emailLowerList.length > 0) {
    // Build query with ANY for employee_id and email
    const existingRes = await pool.query(
      `SELECT u.id, u.employee_id, u.email, u.role_id, u.department_id, u.team_id, u.manager_id, u.is_active, u.account_status,
              r.role_code, r.hierarchy_level
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE UPPER(u.employee_id) = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[])`,
      [allLookupIds.length ? allLookupIds : ['__none__'], emailLowerList.length ? emailLowerList : ['__none__']]
    );
    existingUsers = existingRes.rows;
    // Attach each existing user's active department memberships so the
    // import validator can honour a manager's ADDITIONAL department seats
    // with the same rule as manual create/edit. Without the membership
    // layer the map is empty and the primary department stands alone.
    const membershipMap = await getMembershipDepartmentMap(pool);
    for (const u of existingUsers) {
      u.department_ids = membershipMap.get(String(u.id)) || [];
    }
  }

  // All users for cycle detection (id, employee_id, manager_id)
  const allUsersRes = await pool.query(`SELECT id, employee_id, manager_id FROM users`);
  const allUsers = allUsersRes.rows;

  return {
    roles: rolesRes.rows,
    departments: deptsRes.rows,
    teams: teamsRes.rows,
    existingUsers,
    allUsers,
  };
}

router.post('/users/bulk/validate', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 200, {
      success: true,
      data: {
        totalRows: 0,
        validRows: 0,
        rowsToCreate: 0,
        rowsToUpdate: 0,
        errorRows: 0,
        warningRows: 0,
        rows: [],
        mode: 'createOnly',
        message: 'Bulk import validation is not available in demo mode',
      },
    });
  }

  const body = req.body || {};
  const rawRows: RawUserBulkRow[] = Array.isArray(body.rows) ? body.rows : [];
  const mode: ImportMode = body.mode === 'createAndUpdate' ? 'createAndUpdate' : 'createOnly';
  const fileName = body.fileName ? String(body.fileName) : undefined;

  try {
    /* F15: authorization comes FIRST. Validating the payload before the
       permission check answered 400 to a caller who was never allowed to make
       the request at all — a shape oracle that also made the documented
       "users.create required" answer depend on how much the caller sent. */
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }

    // Independent codes: one round trip of latency instead of two.
    const [canCreate, canEdit] = await Promise.all([
      hasPermissionCode(caller, 'users.create'),
      hasPermissionCode(caller, 'users.edit'),
    ]);

    // For validate, we check at least one permission, but per-row errors will surface missing perms
    if (mode === 'createOnly' && !canCreate) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to create users (users.create required).' });
    }
    if (mode === 'createAndUpdate' && !canCreate && !canEdit) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to bulk import users (users.create or users.edit required).' });
    }

    // Only an authorised caller gets told what is wrong with the payload.
    if (!rawRows.length) {
      return sendJson(res, 400, { success: false, message: 'No rows supplied for validation' });
    }
    if (rawRows.length > USER_BULK_MAX_ROWS) {
      return sendJson(res, 400, { success: false, message: `Too many rows: ${rawRows.length} exceeds maximum ${USER_BULK_MAX_ROWS}` });
    }

    // Normalize rows
    const normalized: NormalizedUserBulkRow[] = rawRows.map((r: any) => {
      return normalizeUserBulkRow({
        rowNumber: Number(r.rowNumber) || 0,
        employeeId: r.employeeId || r.employee_id || '',
        fullName: r.fullName || r.full_name || r.name || '',
        email: r.email || '',
        phone: r.phone || '',
        designation: r.designation || '',
        department: r.department || r.departmentId || '',
        role: r.role || r.roleId || '',
        reportingManagerEmployeeId: r.reportingManagerEmployeeId || r.managerId || r.manager || '',
        team: r.team || r.teamId || '',
        temporaryPassword: r.temporaryPassword || r.password || '',
        mustChangePassword: r.mustChangePassword,
        status: r.status || '',
      });
    });

    const batchEmpIds = normalized.map(n => n.employeeId).filter(Boolean);
    const batchEmails = normalized.map(n => n.email).filter(Boolean);
    const batchMgrIds = normalized.map(n => n.reportingManagerEmployeeId).filter(Boolean);

    const pool = getPool();
    const refData = await loadUserBulkReferenceData(pool, batchEmpIds, batchEmails, batchMgrIds);
    const maps = buildReferenceMaps(refData);

    const preview = validateBulkRows({
      rows: normalized,
      maps,
      mode,
      permissions: { canCreate, canEdit },
    });

    preview.fileName = fileName;

    return sendJson(res, 200, { success: true, data: preview });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Bulk validation failed' });
  }
});

router.post('/users/bulk/commit', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 503, { success: false, message: 'Bulk import is not available in demo mode' });
  }

  const body = req.body || {};
  const rawRows: RawUserBulkRow[] = Array.isArray(body.rows) ? body.rows : [];
  const mode: ImportMode = body.mode === 'createAndUpdate' ? 'createAndUpdate' : 'createOnly';
  const fileName = body.fileName ? String(body.fileName) : undefined;

  /* F15: the authorization decision must not depend on the payload. An
     unprivileged caller gets 403 whether they send zero rows, ten rows or a
     malformed body — the empty-body 400 used to come first. */
  const caller = await getCallerDbInfo(req);
  if (!caller) {
    return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
  }

  const [canCreate, canEdit] = await Promise.all([
    hasPermissionCode(caller, 'users.create'),
    hasPermissionCode(caller, 'users.edit'),
  ]);

  if (mode === 'createOnly' && !canCreate) {
    return sendJson(res, 403, { success: false, message: 'You do not have permission to create users (users.create required).' });
  }
  if (mode === 'createAndUpdate' && !canCreate && !canEdit) {
    return sendJson(res, 403, { success: false, message: 'You do not have permission to bulk import users (users.create or users.edit required).' });
  }

  if (!rawRows.length) {
    return sendJson(res, 400, { success: false, message: 'No rows supplied for commit' });
  }
  if (rawRows.length > USER_BULK_MAX_ROWS) {
    return sendJson(res, 400, { success: false, message: `Too many rows: ${rawRows.length} exceeds maximum ${USER_BULK_MAX_ROWS}` });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {

    // Normalize rows (fresh)
    const normalized: NormalizedUserBulkRow[] = rawRows.map((r: any) => {
      return normalizeUserBulkRow({
        rowNumber: Number(r.rowNumber) || 0,
        employeeId: r.employeeId || r.employee_id || '',
        fullName: r.fullName || r.full_name || r.name || '',
        email: r.email || '',
        phone: r.phone || '',
        designation: r.designation || '',
        department: r.department || r.departmentId || '',
        role: r.role || r.roleId || '',
        reportingManagerEmployeeId: r.reportingManagerEmployeeId || r.managerId || r.manager || '',
        team: r.team || r.teamId || '',
        temporaryPassword: r.temporaryPassword || r.password || '',
        mustChangePassword: r.mustChangePassword,
        status: r.status || '',
      });
    });

    const batchEmpIds = normalized.map(n => n.employeeId).filter(Boolean);
    const batchEmails = normalized.map(n => n.email).filter(Boolean);
    const batchMgrIds = normalized.map(n => n.reportingManagerEmployeeId).filter(Boolean);

    await client.query('BEGIN');

    const refData = await loadUserBulkReferenceData(client, batchEmpIds, batchEmails, batchMgrIds);
    const maps = buildReferenceMaps(refData);

    const preview = validateBulkRows({
      rows: normalized,
      maps,
      mode,
      permissions: { canCreate, canEdit },
    });

    const validRows = preview.rows.filter(r => r.isValid);
    const invalidRows = preview.rows.filter(r => !r.isValid);

    // Errors from validation phase
    const errors: Array<{ rowNumber: number; employeeId: string; message: string }> = invalidRows.map(r => ({
      rowNumber: r.rowNumber,
      employeeId: r.employeeId,
      message: r.errors.join('; '),
    }));

    // Track failed employeeIds for cascade (uppercase)
    const failedEmpIds = new Set<string>();
    for (const ir of invalidRows) {
      if (ir.employeeId) failedEmpIds.add(ir.employeeId.toUpperCase());
    }

    // For row-atomicity, we need original states for updates
    const updateRows = validRows.filter(r => r.action === 'Update' && r.existingUserId);
    const updateIds = updateRows.map(r => r.existingUserId!).filter(Boolean);
    const originalUserMap = new Map<string, any>(); // employeeIdUpper -> full original row
    const originalById = new Map<string, any>(); // id -> original row
    if (updateIds.length > 0) {
      const origRes = await client.query(
        `SELECT u.*, r.hierarchy_level FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ANY($1::uuid[])`,
        [updateIds]
      );
      for (const row of origRes.rows) {
        const empUpper = String(row.employee_id).toUpperCase();
        originalUserMap.set(empUpper, row);
        originalById.set(row.id, row);
      }
    }

    // Phase A tracking
    const createdIds = new Map<string, string>(); // empUpper -> id
    const createdCredentials = new Map<string, { employeeId: string; fullName: string; temporaryPassword: string; mustChangePassword: boolean; generated: boolean }>(); // empUpper -> cred
    const succeededRows = new Map<string, typeof validRows[0]>(); // empUpper -> row (only those that passed Phase A)
    let skipped = 0;

    // Phase A: create/update base users WITHOUT manager (manager_id preserved or NULL)
    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      const empUpper = row.employeeId.toUpperCase();
      const spName = `bulk_row_${i}`;
      await client.query(`SAVEPOINT ${spName}`);
      try {
        if (row.action === 'Create') {
          let plainPassword = row.temporaryPassword;
          const generated = !plainPassword;
          if (!plainPassword) {
            plainPassword = generateTempPassword(10);
          }
          const pwErr = validatePasswordPolicy(plainPassword);
          if (pwErr) throw new Error(pwErr);

          const hash = await bcrypt.hash(plainPassword, 10);
          const roleId = row.roleId!;
          const deptId = row.departmentId!;
          const teamId = row.teamId || null;
          const isActive = row.isActive;
          const mustChange = row.mustChangePassword;
          const emailToUse = row.email || `${row.employeeId.toLowerCase()}@leadflow.local`;

          const insertRes = await client.query(
            `INSERT INTO users (employee_id, full_name, email, phone, password, role_id, department_id, team_id,
                                manager_id, designation, is_active, account_status,
                                must_change_password, reporting_chain, subordinates, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,
                     CASE WHEN $10 THEN 'ACTIVE' ELSE 'INACTIVE' END,
                     $11, '[]'::jsonb, '[]'::jsonb, NOW(), NOW())
             RETURNING id`,
            [
              row.employeeId,
              row.fullName,
              emailToUse,
              row.normalized.phone || null,
              hash,
              roleId,
              deptId,
              teamId,
              row.normalized.designation || (await roleDisplayNameOf(client, roleId)),
              isActive,
              mustChange,
            ]
          );

          const newId = insertRes.rows[0].id;
          createdIds.set(empUpper, newId);
          succeededRows.set(empUpper, row);

          // Credential hardening: only return one-time credentials for server-generated passwords
          // If operator supplied Temporary Password, do NOT echo it back
          if (generated) {
            createdCredentials.set(empUpper, {
              employeeId: row.employeeId,
              fullName: row.fullName,
              temporaryPassword: plainPassword,
              mustChangePassword: mustChange,
              generated,
            });
          }
        } else if (row.action === 'Update') {
          const roleId = row.roleId!;
          const deptId = row.departmentId!;
          const teamId = row.teamId || null;
          const isActive = row.isActive;
          const emailToUse = row.email || null;

          // Update profile/org fields, but keep manager_id unchanged for now (will be handled in Phase B)
          await client.query(
            `UPDATE users SET
               full_name = $1,
               email = COALESCE($2, email),
               phone = COALESCE($3, phone),
               role_id = $4,
               department_id = $5,
               team_id = $6,
               designation = COALESCE(NULLIF($7, ''), designation),
               is_active = $8,
               account_status = CASE WHEN $8 THEN 'ACTIVE' ELSE 'INACTIVE' END,
               updated_at = NOW()
             WHERE id = $9`,
            [
              row.fullName,
              emailToUse,
              row.normalized.phone || null,
              roleId,
              deptId,
              teamId,
              row.normalized.designation || '',
              isActive,
              row.existingUserId,
            ]
          );

          succeededRows.set(empUpper, row);
        } else {
          skipped++;
        }

        await client.query(`RELEASE SAVEPOINT ${spName}`);
      } catch (e: any) {
        await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
        await client.query(`RELEASE SAVEPOINT ${spName}`);
        failedEmpIds.add(empUpper);
        errors.push({
          rowNumber: row.rowNumber,
          employeeId: row.employeeId,
          message: e?.message || 'Row failed during commit',
        });
        // Ensure no credential left
        createdCredentials.delete(empUpper);
        createdIds.delete(empUpper);
        succeededRows.delete(empUpper);
      }
    }

    // Build fresh emp->id map after Phase A (including newly created)
    const allUsersAfterRes = await client.query(`SELECT id, employee_id FROM users`);
    const empToIdMap = new Map<string, string>();
    for (const u of allUsersAfterRes.rows) {
      empToIdMap.set(String(u.employee_id).toUpperCase(), u.id);
    }

    // Phase B: resolve and apply manager_id links with row-atomicity
    // We will attempt linking for each succeeded row; on failure, we rollback that row fully

    const managerLinkAttempts = Array.from(succeededRows.values());

    for (let i = 0; i < managerLinkAttempts.length; i++) {
      const row = managerLinkAttempts[i];
      const empUpper = row.employeeId.toUpperCase();
      // If row already failed in cascade or previous manager link, skip
      if (failedEmpIds.has(empUpper)) continue;
      if (!succeededRows.has(empUpper)) continue;

      const spName = `bulk_mgr_${i}`;
      await client.query(`SAVEPOINT ${spName}`);
      try {
        const userId = empToIdMap.get(empUpper);
        if (!userId) throw new Error(`User ${row.employeeId} not found after creation`);

        let managerId: string | null = null;

        if (!row.managerInput) {
          // No manager supplied: must be Level-1 (CEO) — set NULL and validate
          const roleId = row.roleId!;
          const deptId = row.departmentId!;
          const linkError = await validateReportingLink(client, {
            selfId: userId,
            roleId,
            departmentId: deptId,
            managerId: null,
            managerIsRequired: true,
          });
          if (linkError) throw new Error(linkError);
          await client.query(`UPDATE users SET manager_id = NULL, updated_at = NOW() WHERE id = $1`, [userId]);
        } else {
          const mgrUpper = row.managerInput.toUpperCase();
          // If manager already failed, this row must fail too
          if (failedEmpIds.has(mgrUpper)) {
            throw new Error(`Reporting manager "${row.managerInput}" failed to be provisioned`);
          }
          const resolvedMgrId = empToIdMap.get(mgrUpper);
          if (!resolvedMgrId) throw new Error(`Manager ${row.managerInput} not found after creation`);

          const roleId = row.roleId!;
          const deptId = row.departmentId!;
          const linkError = await validateReportingLink(client, {
            selfId: userId,
            roleId,
            departmentId: deptId,
            managerId: resolvedMgrId,
            managerIsRequired: true,
          });
          if (linkError) throw new Error(linkError);

          await client.query(`UPDATE users SET manager_id = $1, updated_at = NOW() WHERE id = $2`, [resolvedMgrId, userId]);
          managerId = resolvedMgrId;
        }

        await client.query(`RELEASE SAVEPOINT ${spName}`);
      } catch (e: any) {
        await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
        await client.query(`RELEASE SAVEPOINT ${spName}`);

        // Row-atomicity: rollback the entire row
        const rollbackSp = `bulk_rollback_${i}`;
        await client.query(`SAVEPOINT ${rollbackSp}`);
        try {
          if (row.action === 'Create') {
            const createdId = createdIds.get(empUpper);
            if (createdId) {
              await client.query(`DELETE FROM users WHERE id = $1`, [createdId]);
              empToIdMap.delete(empUpper);
            }
          } else if (row.action === 'Update') {
            const orig = originalUserMap.get(empUpper);
            if (orig) {
              await client.query(
                `UPDATE users SET
                   full_name = $1,
                   email = $2,
                   phone = $3,
                   role_id = $4,
                   department_id = $5,
                   team_id = $6,
                   manager_id = $7,
                   designation = $8,
                   is_active = $9,
                   account_status = $10,
                   must_change_password = $11,
                   updated_at = NOW()
                 WHERE id = $12`,
                [
                  orig.full_name,
                  orig.email,
                  orig.phone,
                  orig.role_id,
                  orig.department_id,
                  orig.team_id,
                  orig.manager_id,
                  orig.designation,
                  orig.is_active,
                  orig.account_status,
                  orig.must_change_password,
                  orig.id,
                ]
              );
            }
          }
          await client.query(`RELEASE SAVEPOINT ${rollbackSp}`);
        } catch (rbErr: any) {
          await client.query(`ROLLBACK TO SAVEPOINT ${rollbackSp}`);
          await client.query(`RELEASE SAVEPOINT ${rollbackSp}`);
          // If rollback itself fails, we still mark row as failed and continue
        }

        failedEmpIds.add(empUpper);
        createdCredentials.delete(empUpper);
        createdIds.delete(empUpper);
        succeededRows.delete(empUpper);

        errors.push({
          rowNumber: row.rowNumber,
          employeeId: row.employeeId,
          message: `Manager link failed: ${e?.message || 'unknown'}`,
        });
      }
    }

    // Cascade: if a manager failed, any succeeded row that reports to it must also fail (transitive)
    let cascadeChanged = true;
    let cascadeIter = 0;
    while (cascadeChanged && cascadeIter < 10) {
      cascadeChanged = false;
      cascadeIter++;
      const currentSucceeded = Array.from(succeededRows.values());
      for (let i = 0; i < currentSucceeded.length; i++) {
        const row = currentSucceeded[i];
        const empUpper = row.employeeId.toUpperCase();
        if (failedEmpIds.has(empUpper)) continue;
        const mgrInput = row.managerInput ? row.managerInput.toUpperCase() : '';
        if (mgrInput && failedEmpIds.has(mgrInput)) {
          const spName = `bulk_cascade_${cascadeIter}_${i}`;
          await client.query(`SAVEPOINT ${spName}`);
          try {
            if (row.action === 'Create') {
              const createdId = createdIds.get(empUpper);
              if (createdId) {
                await client.query(`DELETE FROM users WHERE id = $1`, [createdId]);
                empToIdMap.delete(empUpper);
              }
            } else if (row.action === 'Update') {
              const orig = originalUserMap.get(empUpper);
              if (orig) {
                await client.query(
                  `UPDATE users SET
                     full_name = $1,
                     email = $2,
                     phone = $3,
                     role_id = $4,
                     department_id = $5,
                     team_id = $6,
                     manager_id = $7,
                     designation = $8,
                     is_active = $9,
                     account_status = $10,
                     must_change_password = $11,
                     updated_at = NOW()
                   WHERE id = $12`,
                  [
                    orig.full_name,
                    orig.email,
                    orig.phone,
                    orig.role_id,
                    orig.department_id,
                    orig.team_id,
                    orig.manager_id,
                    orig.designation,
                    orig.is_active,
                    orig.account_status,
                    orig.must_change_password,
                    orig.id,
                  ]
                );
              }
            }
            await client.query(`RELEASE SAVEPOINT ${spName}`);
          } catch (e: any) {
            await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
            await client.query(`RELEASE SAVEPOINT ${spName}`);
          }

          failedEmpIds.add(empUpper);
          createdCredentials.delete(empUpper);
          createdIds.delete(empUpper);
          succeededRows.delete(empUpper);

          errors.push({
            rowNumber: row.rowNumber,
            employeeId: row.employeeId,
            message: `Manager dependency failed: reporting manager "${row.managerInput}" was not provisioned`,
          });
          cascadeChanged = true;
        }
      }
    }

    // Final successful set established — recompute reporting chains once
    try {
      await recomputeReportingChains(client);
    } catch (e: any) {
      await client.query('ROLLBACK');
      return sendJson(res, 500, { success: false, message: `Failed to recompute reporting chains: ${e?.message || 'unknown'}` });
    }

    await client.query('COMMIT');

    // Final counters must match committed DB state
    const finalCreated = Array.from(succeededRows.values()).filter(r => r.action === 'Create').length;
    const finalUpdated = Array.from(succeededRows.values()).filter(r => r.action === 'Update').length;
    const finalFailed = rawRows.length - finalCreated - finalUpdated - skipped;

    // Credentials: only for server-generated temporary passwords, and only for final successful creates
    const finalCredentials = Array.from(createdCredentials.values()).map(c => ({
      employeeId: c.employeeId,
      fullName: c.fullName,
      temporaryPassword: c.temporaryPassword,
      mustChangePassword: c.mustChangePassword,
    }));

    // Audit log batch-level (no plaintext passwords, no binary)
    try {
      const auditPool = getPool();
      await auditPool.query(
        `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, entity_id, metadata)
         VALUES ($1, $1, 'users-bulk-import', 'user', $1, $2)`,
        [caller.id, JSON.stringify({ fileName: fileName || null, mode, totalRows: rawRows.length, created: finalCreated, updated: finalUpdated, failed: finalFailed, skipped, timestamp: new Date().toISOString() })]
      );
    } catch {
      // best-effort audit
    }

    return sendJson(res, 200, {
      success: true,
      data: {
        totalRows: rawRows.length,
        created: finalCreated,
        updated: finalUpdated,
        failed: finalFailed,
        skipped,
        errors,
        credentials: finalCredentials,
        fileName: fileName || null,
        mode,
        summary: {
          total: rawRows.length,
          valid: validRows.length,
          created: finalCreated,
          updated: finalUpdated,
          failed: finalFailed,
          skipped,
          errorRows: finalFailed,
        },
      },
    });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Bulk commit failed' });
  } finally {
    client.release();
  }
});

/* ---------- user permission overrides + audit ---------- */
/* ---------- user permission overrides + audit ---------- */

/**
 * GET /users/:id/effective-access (F16 Phase F) — the whole access review for
 * ONE person in one answer: every canonical permission with the layer that
 * decided it, the page set, the data scope, and the findings a reviewer cares
 * about (explicit deny over an allow, no-op overrides, fail-closed roles).
 *
 * Admin-only: this is the screen an administrator uses to check somebody
 * else's access, and it exposes the complete matrix.
 */
router.get('/users/:id/effective-access', requireAuth, requireAdmin, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, { success: false, available: false, message: 'Database is not configured.' });
  try {
    const pool = getPool();
    const uuid = asUuid(req.params.id);
    const userResult = await pool.query(
      `SELECT u.id, u.employee_id, u.full_name, u.is_active, u.must_change_password,
              u.role_id, r.role_code, r.role_name, r.data_visibility, r.hierarchy_level,
              r.menu_access
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($1) OR u.id = $2 LIMIT 1`,
      [req.params.id, uuid || null]
    );
    const user = userResult.rows[0];
    if (!user) return sendJson(res, 404, { success: false, message: 'User not found' });

    const rows = await pool.query(
      `SELECT p.permission_code, p.module_name, p.action_name,
              COALESCE(rp.is_allowed, FALSE) AS is_allowed,
              (rp.permission_id IS NOT NULL) AS has_role_grant,
              up.is_allowed AS user_override,
              up.reason AS override_reason,
              up.updated_at AS override_updated_at
         FROM permissions p
         LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $2
         LEFT JOIN user_permissions up ON up.permission_id = p.id AND up.user_id = $1
         ORDER BY p.module_name, p.action_name, p.permission_code`,
      [user.id, user.role_id]
    );

    const effective = resolveEffectivePermissions(rows.rows as any);
    // The override reason/updated_at are attached AFTER the pure resolver (the
    // precedence itself must stay a function of the trio it is tested on).
    const reasonByCode = new Map<string, string>();
    const updatedByCode = new Map<string, string>();
    for (const row of rows.rows as any[]) {
      if (row?.user_override === null || row?.user_override === undefined) continue;
      const code = String(row.permission_code);
      if (row.override_reason) reasonByCode.set(code, String(row.override_reason));
      if (row.override_updated_at) updatedByCode.set(code, String(row.override_updated_at));
    }
    const permissions = effective.permissions.map(p => ({
      ...p,
      overrideReason: reasonByCode.get(p.code) || null,
      overrideUpdatedAt: updatedByCode.get(p.code) || null,
    }));

    const menuAccess = user.menu_access && typeof user.menu_access === 'object' && !Array.isArray(user.menu_access)
      ? user.menu_access as Record<string, unknown>
      : {};
    const pages = Object.entries(menuAccess)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([path, value]) => ({ path, allowed: value === true }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const menuAccessConfigured = pages.filter(p => p.allowed).length;

    const roleCode = String(user.role_code || 'EMPLOYEE').toUpperCase();
    const isAdminBypass = roleCode === 'ADMIN' || roleCode === 'SUPERADMIN';
    const dataVisibility = isAdminBypass ? 'Organization' : (user.data_visibility || 'Own');

    const warnings = buildAccessWarnings({
      effective,
      roleCode,
      roleName: user.role_name || roleCode,
      isActive: user.is_active !== false,
      mustChangePassword: user.must_change_password === true,
      isAdminBypass,
      menuAccessConfigured,
      dataVisibility,
    });

    return sendJson(res, 200, {
      success: true,
      data: {
        user: {
          id: user.id,
          employeeId: user.employee_id,
          fullName: user.full_name,
          isActive: user.is_active !== false,
        },
        role: {
          roleCode,
          roleName: user.role_name || roleCode,
          hierarchyLevel: Number(user.hierarchy_level) || 0,
          dataVisibility,
          isAdminBypass,
        },
        permissions,
        pages,
        warnings,
        summary: effective.summary,
      },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Effective access fetch failed' });
  }
});

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

router.put('/users/:id/permissions', requireAuth, requirePermissionCode('permissions.manage'), async (req, res) => {
  const overrides = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const applied: Array<{ code: string; allowed: boolean }> = [];
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
      applied.push({ code, allowed: override.allowed === true });
      if (override.allowed === null || override.allowed === undefined) {
        await client.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission_id = $2', [userId, permResult.rows[0].id]);
      } else {
        // Column list MUST match migration 027 (the only creator of this
        // table): user_id, permission_id, is_allowed, reason, created_at,
        // updated_at. A `granted_at` column was named here for years while
        // no migration ever created it, so EVERY override save answered
        // 500 ("column granted_at ... does not exist") on real databases —
        // the older integration suites missed it because each hand-wrote a
        // fixture that happened to include the column. `created_at` already
        // records when the override was first stored.
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (user_id, permission_id) DO UPDATE SET
             is_allowed = EXCLUDED.is_allowed,
             reason = EXCLUDED.reason,
             updated_at = NOW()`,
          [userId, permResult.rows[0].id, !!override.allowed, clean(override.reason) || 'Configured from User Management']
        );
      }
    }
    await client.query('COMMIT');
    // The per-user override is the sharpest access tool in the product
    // (it beats the role grant); the ledger records who used it, on whom.
    await logAccessChange({
      actorId: req.currentUser?.id,
      targetUserId: userId,
      actionCode: 'user-permission-overrides-update',
      entityType: 'user',
      entityId: userId,
      metadata: { ...summarizeAccessChanges(applied) },
    });
    return sendJson(res, 200, { success: true, message: 'User permission overrides saved' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission override save failed' });
  } finally {
    client.release();
  }
});

/**
 * Org-wide audit trail (actors, targets, action codes, metadata such as
 * bulk-import file names). This is management telemetry, not user-scoped
 * data, so it is gated by the canonical `audit.view` grant — fail closed
 * for anyone without it, ADMIN/SUPERADMIN bypass as everywhere else.
 * (Previously plain requireAuth: every authenticated employee could read
 * the whole org's audit trail.)
 */
router.get('/audit-logs', requireAuth, requirePermissionCode('audit.view'), async (req, res) => {
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

/**
 * The EXTRA department seats of a person (`departmentIds` on the user
 * payload) — every department besides the primary one. A person may hold a
 * seat in more than one department (design decision (2)), which is what lets
 * one head lead several departments (decision (1)) and lets their "my team"
 * visibility span every department they actually belong to.
 *
 * `undefined` means the field was not sent at all: existing extra seats are
 * then left alone (so an older client, or any partial update, can never
 * silently drop a seat). A sent list — including an empty one — REPLACES the
 * extra seats. References are resolved exactly like `departmentId` (uuid,
 * code or name) so the UI may send whichever it has.
 */
async function normalizeExtraDepartmentIds(
  raw: any
): Promise<{ ids: string[] | null; error: string | null }> {
  if (raw === undefined) return { ids: null, error: null };
  if (raw === null) return { ids: [], error: null };
  if (!Array.isArray(raw)) {
    return { ids: null, error: 'Department memberships must be sent as a list of departments.' };
  }
  const ids: string[] = [];
  for (const ref of raw) {
    const value = clean(ref);
    if (!value) continue;
    const resolved = await resolveDepartmentId(value);
    if (!resolved) {
      return { ids: null, error: `Unknown department "${value}" in the department membership list.` };
    }
    ids.push(resolved);
  }
  return { ids: Array.from(new Set(ids)), error: null };
}

/**
 * Phase E — the mandatory-transfer rule, in ONE place, used by both the
 * update and the delete path.
 *
 * A person may not end up switched off (or removed) while they still own OPEN
 * leads: ownership would keep pointing at an account nobody can log in with,
 * so the leads would be followed up by nobody and the follow-up queue would
 * quietly lose them. Every deactivation checklist runs freeze -> export ->
 * reassign -> deactivate, and the industry rule is that the reassignment is a
 * human decision — the system never picks a new owner on its own.
 *
 * Call it BEFORE writing. Three outcomes:
 *
 *   - the person owns no open leads            -> { target: null }, the write
 *                                                 proceeds untouched;
 *   - they own leads and no target was chosen   -> 409 + `code:
 *     LEADS_REQUIRE_TRANSFER` with the count, a sample of the leads and the
 *     suggested replacements, so the client can ask the administrator;
 *   - a target was chosen                       -> the target is validated
 *     (must exist, must be ACTIVE, cannot be the departing person) and handed
 *     back for `transferOpenLeads`.
 *
 * An explicitly chosen target is honoured even when the person stays active
 * (an administrator may legitimately hand over a book of business).
 */
async function resolveDeactivationTransfer(
  client: any,
  opts: {
    userId: string;
    employeeId: string;
    departmentId?: string | null;
    managerId?: string | null;
    willBeActive: boolean;
    transferRef: any;
    actingUserId?: string | null;
    actingEmployeeId?: string | null;
  }
): Promise<{
  target: { id: string; employeeId: string; fullName: string } | null;
  summary: { count: number; sample: any[] };
  error: { status: number; body: any } | null;
}> {
  const empty = { count: 0, sample: [] as any[] };
  const ref = clean(opts.transferRef);
  const summary = await summarizeOpenLeads(client, opts.userId);

  if (!ref) {
    if (opts.willBeActive) return { target: null, summary, error: null };
    if (summary.count === 0) return { target: null, summary, error: null };

    // Suggestions: the people best placed to take the book over — the same
    // department first (they already see these customers' region of the
    // business), then the departing person's own manager.
    const suggested = summary.available
      ? await client.query(
          `SELECT u.id, u.employee_id, u.full_name, r.role_code
             FROM users u
             LEFT JOIN roles r ON r.id = u.role_id
            WHERE u.is_active = TRUE
              AND u.id <> $1
              AND (u.department_id = $2::uuid OR u.id = $3::uuid)
            ORDER BY (u.id = $3::uuid) DESC, u.employee_id ASC
            LIMIT 8`,
          [opts.userId, opts.departmentId || null, opts.managerId || null]
        )
      : { rows: [] as any[] };

    return {
      target: null,
      summary,
      error: {
        status: 409,
        body: {
          success: false,
          code: 'LEADS_REQUIRE_TRANSFER',
          message:
            `This person still owns ${summary.count} open lead${summary.count === 1 ? '' : 's'}. ` +
            'Choose who takes them over before deactivating the account.',
          leadCount: summary.count,
          leads: summary.sample,
          suggestions: suggested.rows.map((r: any) => ({
            userId: r.id,
            employeeId: r.employee_id,
            fullName: r.full_name,
            roleCode: r.role_code || '',
            isManager: opts.managerId ? String(r.id) === String(opts.managerId) : false,
          })),
        },
      },
    };
  }

  const targetId = await resolveUserId(ref);
  if (!targetId) {
    return { target: null, summary, error: { status: 400, body: { success: false, message: `Unknown user "${ref}" to transfer leads to.` } } };
  }
  if (String(targetId) === String(opts.userId)) {
    return { target: null, summary, error: { status: 400, body: { success: false, message: 'Leads cannot be transferred to the person being deactivated.' } } };
  }
  const targetRow = await client.query(
    `SELECT u.id, u.employee_id, u.full_name, u.is_active FROM users u WHERE u.id = $1 LIMIT 1`,
    [targetId]
  );
  const target = targetRow.rows[0];
  if (!target) {
    return { target: null, summary, error: { status: 400, body: { success: false, message: 'The selected user could not be found.' } } };
  }
  if (target.is_active === false) {
    return {
      target: null,
      summary,
      error: {
        status: 400,
        body: { success: false, message: `${target.full_name} is deactivated — pick an active colleague to take these leads over.` },
      },
    };
  }

  return {
    target: { id: String(target.id), employeeId: String(target.employee_id), fullName: String(target.full_name) },
    summary,
    error: null,
  };
}

const fallbackDepartments: Array<{ id: string; name: string; code?: string; description?: string; isActive?: boolean; createdDate: string }> = [];

router.get('/departments', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackDepartments);
  try {
    const pool = getPool();
    // The head/count/team enrichment needs migration 046. Minimal schemas
    // (regression fixtures) keep the base department row: same response
    // shape, no display value invented.
    const enriched = await hasDepartmentMirrorLayer(pool);
    const result = await pool.query(enriched
      ? `SELECT d.*,
              ph.user_id        AS primary_head_user_id,
              phu.employee_id   AS primary_head_employee_id,
              phu.full_name     AS primary_head_full_name,
              (SELECT COUNT(*)::int FROM department_members m
                WHERE m.department_id = d.id AND m.is_active) AS member_count,
              (SELECT COUNT(*)::int FROM department_members m
                WHERE m.department_id = d.id AND m.is_active AND m.is_head) AS head_count,
              (SELECT t.id FROM teams t
                WHERE t.department_id = d.id AND t.is_department_mirror LIMIT 1) AS mirror_team_id
         FROM departments d
         LEFT JOIN department_members ph
                ON ph.department_id = d.id AND ph.is_primary_head AND ph.is_active
         LEFT JOIN users phu ON phu.id = ph.user_id
        ORDER BY d.created_at ASC`
      : `SELECT * FROM departments ORDER BY created_at ASC`
    );
    return sendJson(res, 200, result.rows.map(row => ({
      ...mapDepartmentRow(row),
      primaryHead: row.primary_head_user_id
        ? {
            id: row.primary_head_user_id,
            employeeId: row.primary_head_employee_id || null,
            fullName: row.primary_head_full_name || null,
          }
        : null,
      headCount: row.head_count ?? 0,
      memberCount: row.member_count ?? 0,
      mirrorTeamId: row.mirror_team_id || null,
    })));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department fetch failed' });
  }
});

router.post('/departments', requireAuth, requirePermissionCode('departments.manage'), async (req, res) => {
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
    // One department = one mirror team (Phase C): created with the
    // department, renamed with it, roster synced from memberships.
    const savedDepartment = result.rows[0];
    let mirrorTeamId: string | null = null;
    try {
      mirrorTeamId = (await syncMirrorTeam(pool, savedDepartment.id)).teamId;
    } catch (mirrorError: any) {
      console.warn('Department mirror-team sync failed:', mirrorError?.message || mirrorError);
    }
    return sendJson(res, 200, { ...mapDepartmentRow(savedDepartment), mirrorTeamId });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department save failed' });
  }
});

/**
 * Set a department's heads (Phase C). `primaryUserId` may be null (a
 * department is allowed to be headless — the health screen lists it), any
 * number of co-heads may accompany the primary. Every head must already be
 * an active member of the department; the mirror team's leader follows the
 * primary head, and the change is written to the audit trail.
 */
router.put('/departments/:id/heads', requireAuth, requirePermissionCode('departments.manage'), async (req, res) => {
  const departmentId = asUuid(req.params.id);
  if (!departmentId) return sendJson(res, 400, { success: false, message: 'A valid department id is required.' });
  const primaryRaw = clean(req.body?.primaryUserId);
  const coHeadRaw = Array.isArray(req.body?.coHeadUserIds) ? req.body.coHeadUserIds : [];
  const coHeadUserIds = coHeadRaw.map((id: any) => asUuid(clean(id))).filter(Boolean) as string[];

  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Department heads saved (demo mode)' });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const department = await client.query('SELECT id FROM departments WHERE id = $1 LIMIT 1', [departmentId]);
    if (!department.rows[0]) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { success: false, message: 'Department not found' });
    }

    let primaryUserId: string | null = null;
    if (primaryRaw) {
      const found = await client.query(
        `SELECT u.id FROM users u
          WHERE (u.id::text = $1 OR UPPER(u.employee_id) = UPPER($1)) AND u.is_active LIMIT 1`,
        [primaryRaw]
      );
      if (!found.rows[0]) {
        await client.query('ROLLBACK');
        return sendJson(res, 400, { success: false, message: 'The primary head must be an active user.' });
      }
      primaryUserId = found.rows[0].id;
    }

    const result = await setDepartmentHeads(client, departmentId, { primaryUserId, coHeadUserIds });
    await client.query('COMMIT');

    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'department-heads-update',
      entityType: 'department',
      entityId: departmentId,
      metadata: {
        primaryUserId,
        coHeadCount: coHeadUserIds.length,
        teamId: result.teamId,
        memberCount: result.memberCount,
      },
    });

    return sendJson(res, 200, { success: true, ...result });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (error?.statusCode) {
      return sendJson(res, error.statusCode, { success: false, message: error?.message || 'Invalid head assignment' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Department head save failed' });
  } finally {
    client.release();
  }
});

router.delete('/departments/:id', requireAuth, requirePermissionCode('departments.manage'), async (req, res) => {
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

/**
 * Does this role bypass the permission matrix outright? (mirrors the very first
 * branch of `hasPermissionCode()` — ADMIN and SUPERADMIN are allowed everything
 * before any grant row is consulted). Takes a pool OR a transaction client.
 */
async function roleBypassesMatrix(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  roleCodeOrId: string,
): Promise<boolean> {
  try {
    const res: any = await client.query(
      'SELECT role_code FROM roles WHERE UPPER(role_code) = UPPER($1) OR id::text = $1 LIMIT 1',
      [roleCodeOrId],
    );
    const code = normalizeRole(res?.rows?.[0]?.role_code);
    return code === 'ADMIN' || code === 'SUPERADMIN';
  } catch {
    // Fail closed on the coercion question too: an unreadable role is NOT
    // treated as a bypassing role.
    return false;
  }
}

/* ====================================================================
   ROLE TEMPLATES  (F16 Phase F)
   --------------------------------------------------------------------
   GET    /role-templates        – the templates administrators saved
   POST   /role-templates        – save a role's CURRENT access under a name
   DELETE /role-templates/:id    – remove a saved template

   There are NO built-in templates: the list is exactly what an administrator
   chose to keep, so nothing here can disagree with a role. Applying one is a
   CLIENT action on purpose — it fills the role editor, every toggle stays
   visible, and the save goes through the one existing write path. Nothing in
   this block grants access by itself.
==================================================================== */
router.get('/role-templates', requireAuth, requirePermissionCode('roles.manage'), async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 200, { success: true, available: false, templates: [] });
  }
  try {
    const result = await listRoleTemplates(getPool());
    return sendJson(res, 200, { success: true, ...result });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role templates fetch failed' });
  }
});

router.post('/role-templates', requireAuth, requirePermissionCode('roles.manage'), async (req, res) => {
  const payload = req.body || {};
  const name = clean(payload.name || payload.templateName);
  const fromRole = clean(payload.fromRole || payload.fromRoleCode || payload.roleId);
  if (!name) return sendJson(res, 400, { success: false, message: 'A template name is required.' });
  if (name.length > 150) return sendJson(res, 400, { success: false, message: 'The template name must be 150 characters or fewer.' });
  if (!fromRole) {
    return sendJson(res, 400, { success: false, message: 'Choose the role whose access should be saved as a template.' });
  }
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Template saved (demo mode)' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const template = await saveRoleTemplate(client, {
      name,
      description: clean(payload.description) || undefined,
      fromRoleCode: fromRole,
      createdBy: req.currentUser?.id || null,
    });
    await client.query('COMMIT');
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'role-template-save',
      entityType: 'role_template',
      entityId: template.id,
      metadata: {
        name: template.name,
        sourceRoleCode: template.roleCode,
        dataVisibility: template.dataVisibility,
        grantCount: template.grants.length,
        pageCount: Object.values(template.menuAccess).filter(Boolean).length,
      },
    });
    return sendJson(res, 201, { success: true, data: template });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (error?.code === '23505') {
      return sendJson(res, 409, { success: false, message: 'A template with that name already exists.' });
    }
    if (error?.statusCode) {
      return sendJson(res, error.statusCode, { success: false, message: error?.message });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Template save failed' });
  } finally {
    client.release();
  }
});

router.delete('/role-templates/:id', requireAuth, requirePermissionCode('roles.manage'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Template removed (demo mode)' });
  }
  try {
    const removed = await deleteRoleTemplate(getPool(), String(req.params.id));
    if (!removed) {
      return sendJson(res, 404, {
        success: false,
        message: 'No saved template with that id.',
      });
    }
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'role-template-delete',
      entityType: 'role_template',
      entityId: String(req.params.id),
      metadata: {},
    });
    return sendJson(res, 200, { success: true, message: 'Template removed' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Template delete failed' });
  }
});

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

router.post('/roles', requireAuth, requirePermissionCode('roles.manage'), async (req, res) => {
  const payload = req.body || {};
  const roleIdRaw = clean(payload.roleId || payload.role_code || payload.code);
  const roleName = clean(payload.roleName || payload.role_name || payload.name);
  if (!roleIdRaw || !roleName) {
    return sendJson(res, 400, { success: false, message: 'Role ID and role name are required' });
  }
  const roleCode = roleIdRaw.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
  if (!roleCode) return sendJson(res, 400, { success: false, message: 'Invalid role ID' });
  // A bypassing role (ADMIN / SUPERADMIN) sees the whole organization whatever
  // the dropdown says — storing "Own" next to it would leave a row that
  // describes the opposite of reality, so the truth is what gets stored.
  const bypassesMatrix = roleCode === 'ADMIN' || roleCode === 'SUPERADMIN';
  const dataVisibility = bypassesMatrix
    ? 'Organization'
    : ['Own', 'DownTeam', 'FullTeam', 'Organization'].includes(payload.dataVisibility)
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
    // Ledger: a role save moves page visibility, data visibility and the
    // feature matrix in one shot — the widest access change in the editor.
    const menuPaths = menuAccess && typeof menuAccess === 'object'
      ? Object.entries(menuAccess).filter(([, value]) => value === true).map(([path]) => path)
      : [];
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'role-save',
      entityType: 'role',
      entityId: result.rows[0]?.id || null,
      metadata: {
        roleId: roleCode,
        dataVisibility,
        menuPathsGranted: menuPaths.slice(0, AUDIT_CHANGE_CAP),
        menuPathsTruncated: menuPaths.length > AUDIT_CHANGE_CAP,
        featurePermissionsProvided: featurePermissions !== null,
      },
    });
    return sendJson(res, 200, mapRoleRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role save failed' });
  }
});

router.delete('/roles/:roleId', requireAuth, requirePermissionCode('roles.manage'), async (req, res) => {
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
    // Ledger: deleting a role drops every grant it carried.
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'role-delete',
      entityType: 'role',
      entityId: result.rows[0]?.id || null,
      metadata: { roleId: roleIdRaw },
    });
    return sendJson(res, 200, { success: true, message: 'Role deleted' });
  } catch (error: any) {
    if (error?.code === '23503') {
      return sendJson(res, 409, { success: false, message: 'Role is assigned to existing users and cannot be deleted.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role delete failed' });
  }
});

/* ====================================================================
   CANONICAL ROLE ACTION PERMISSIONS (permissions × role_permissions)
   --------------------------------------------------------------------
   The granular action model edited in Role Feature Access. Codes are the
   canonical permission codes seeded by migration 025 (`permissions`);
   grants are persisted in `role_permissions` (migration 026) and are the
   same rows `hasPermissionCode()` enforces server-side. Reads list every
   canonical code with its effective allowance; writes upsert only codes
   that already exist in `permissions` — unknown codes are ignored so a
   forged payload can never mint a permission (fail closed).
==================================================================== */

router.get('/roles/:roleId/permissions', requireAuth, requireAdmin, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, { success: true, data: [] });
  try {
    const pool = getPool();
    // Reads must never manufacture a role row: a plain lookup (no
    // resolveRoleId side effect) returns 404 for an unknown role.
    const roleResult = await pool.query(
      'SELECT id FROM roles WHERE UPPER(role_code) = UPPER($1) OR id::text = $1 LIMIT 1',
      [req.params.roleId]
    );
    const roleId = roleResult.rows[0]?.id;
    if (!roleId) return sendJson(res, 404, { success: false, message: 'Role not found' });

    // ADMIN / SUPERADMIN bypass the permission matrix entirely (see
    // hasPermissionCode), so every action of such a role is ALLOWED for real —
    // reporting the stored rows would draw a screen full of unchecked boxes
    // that describes the opposite of what happens. The answer is derived, and
    // derived from the same rule the boundary uses.
    const adminBypass = await roleBypassesMatrix(pool, req.params.roleId);

    const result = await pool.query(
      `SELECT p.permission_code, p.module_name, p.action_name,
              COALESCE(rp.is_allowed, FALSE) AS is_allowed
       FROM permissions p
       LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $1
       ORDER BY p.module_name, p.action_name, p.permission_code`,
      [roleId]
    );
    return sendJson(res, 200, {
      success: true,
      adminBypass,
      data: result.rows.map((r: any) => ({
        code: r.permission_code,
        module: r.module_name,
        action: r.action_name,
        allowed: adminBypass ? true : r.is_allowed === true,
      })),
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission fetch failed' });
  }
});

router.put('/roles/:roleId/permissions', requireAuth, requireAdmin, async (req, res) => {
  const grants = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const applied: Array<{ code: string; allowed: boolean }> = [];
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Role permissions saved (demo mode)' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roleResult = await client.query(
      'SELECT id FROM roles WHERE UPPER(role_code) = UPPER($1) OR id::text = $1 LIMIT 1',
      [req.params.roleId]
    );
    const roleId = roleResult.rows[0]?.id;
    if (!roleId) {
      await client.query('ROLLBACK');
      return sendJson(res, 404, { success: false, message: 'Role not found' });
    }
    // A bypassing role cannot hold a deny: accepting `allowed: false` here would
    // store a row that says "refused" while the boundary allows everything —
    // exactly the false answer this layer must never produce. The write is
    // coerced to the truth instead of being rejected (the admin's screen has
    // these toggles locked anyway).
    const adminBypass = await roleBypassesMatrix(client, req.params.roleId);
    for (const grant of grants) {
      const code = clean(grant?.code || grant?.permissionCode);
      if (!code) continue;
      // Only canonical, existing permission codes may be granted. Unknown
      // codes are skipped (never invented) — fail closed by construction.
      const perm = await client.query('SELECT id FROM permissions WHERE permission_code = $1', [code]);
      if (!perm.rows[0]) continue;
      const allowed = adminBypass ? true : grant.allowed === true;
      applied.push({ code, allowed });
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id, is_allowed, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (role_id, permission_id) DO UPDATE SET
           is_allowed = EXCLUDED.is_allowed,
           updated_at = NOW()`,
        [roleId, perm.rows[0].id, allowed]
      );
    }
    await client.query('COMMIT');
    // Ledger AFTER the commit: only an applied change is worth auditing, and
    // a failed audit write must not roll back a successful one.
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'role-permissions-update',
      entityType: 'role',
      entityId: roleId,
      metadata: { roleId: req.params.roleId, ...summarizeAccessChanges(applied) },
    });
    return sendJson(res, 200, { success: true, adminBypass, message: 'Role permissions saved' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Permission save failed' });
  } finally {
    client.release();
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

router.post('/teams', requireAuth, requirePermissionCode('teams.manage'), async (req, res) => {
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
      // Phase C: a department's mirror team is not a hand-managed team. The
      // probe is schema-tolerant (older databases have no mirror column) and
      // never throws: a missing column simply means "no mirror teams here".
      const managed = await pool
        .query('SELECT is_department_mirror FROM teams WHERE id = $1 LIMIT 1', [existingId])
        .catch(() => ({ rows: [] as any[] }));
      if (managed.rows[0]?.is_department_mirror) {
        return sendJson(res, 400, {
          success: false,
          message: 'This team is managed by its department. Rename the department to rename its team.',
        });
      }
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

router.delete('/teams/:id', requireAuth, requirePermissionCode('teams.manage'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true, message: 'Team deleted (demo mode)' });
  }
  try {
    // Phase C: deleting a mirror team would leave its department without the
    // team every membership sync writes into — the department is the thing to
    // delete. Schema-tolerant probe (a database without the mirror column
    // simply has no mirror teams).
    const managed = await getPool()
      .query('SELECT is_department_mirror FROM teams WHERE id::text = $1 OR team_code = $1 LIMIT 1', [req.params.id])
      .catch(() => ({ rows: [] as any[] }));
    if (managed.rows[0]?.is_department_mirror) {
      return sendJson(res, 400, {
        success: false,
        message: 'This team is managed by its department. Delete the department to remove its team.',
      });
    }
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

router.post('/hierarchies', requireAuth, requirePermissionCode('hierarchy.manage'), async (req, res) => {
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

router.delete('/hierarchies/:id', requireAuth, requirePermissionCode('hierarchy.manage'), async (req, res) => {
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

router.get('/hierarchy-config', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    return sendJson(res, 200, {
      levels: [],
      unassignedRoles: [],
      setup: { totalUsers: 0, usersWithManager: 0, usersWithoutManager: 0, invalidLinks: [], warnings: [] },
      rules: { levelGap: 1, sameDepartmentRequired: true, level1CrossesDepartments: true, description: 'Ladder configuration requires a database connection.' },
    });
  }
  try {
    const caller = await getCallerDbInfo(req as any);
    const visibility = await resolveCallerVisibility(caller as any);
    return sendJson(res, 200, await buildHierarchyConfig(visibility));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Hierarchy config fetch failed' });
  }
});

router.put('/hierarchy-config', requireAuth, requirePermissionCode('hierarchy.manage'), async (req, res) => {
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
    const caller = await getCallerDbInfo(req as any);
    const visibility = await resolveCallerVisibility(caller as any);
    return sendJson(res, 200, { success: true, data: await buildHierarchyConfig(visibility) });
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

export default router;
