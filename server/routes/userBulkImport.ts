/**
 * userBulkImport.ts — Bulk user import validation + provisioning helpers.
 * ------------------------------------------------------------------
 * Pure + DB-aware helpers for the Users bulk import workflow.
 * PostgreSQL remains authoritative; this module never trusts client preview.
 *
 * Design mirrors lead bulk import architecture:
 *  - reference data loaded in bulk (no N+1)
 *  - same-batch manager resolution (order independent)
 *  - hierarchy safety via existing validateReportingLink semantics
 *  - password handling: hash server-side, never store plaintext, return once
 */

import crypto from 'crypto';

export const USER_BULK_MAX_ROWS = 1000;

export type ImportMode = 'createOnly' | 'createAndUpdate';

export interface RawUserBulkRow {
  rowNumber: number; // 1-based data row number (sheet row = rowNumber+1)
  employeeId: string;
  fullName: string;
  email?: string;
  phone?: string;
  designation?: string;
  department: string;
  role: string;
  reportingManagerEmployeeId?: string;
  team?: string;
  temporaryPassword?: string;
  mustChangePassword?: string | boolean;
  status?: string;
}

export interface NormalizedUserBulkRow {
  rowNumber: number;
  employeeId: string; // normalized uppercase
  fullName: string;
  email: string; // normalized lowercase (may be empty, server will fallback)
  phone: string;
  designation: string;
  department: string; // raw input for resolution
  role: string; // raw input for resolution
  reportingManagerEmployeeId: string; // normalized uppercase (may be empty)
  team: string;
  temporaryPassword: string; // raw (may be empty)
  mustChangePasswordRaw: string | boolean | undefined;
  statusRaw: string | undefined;
  // parsed
  mustChangePassword: boolean; // default true
  isActive: boolean; // default true
  statusLabel: 'Active' | 'Inactive';
}

export interface ReferenceMaps {
  roleByCode: Map<string, { id: string; role_code: string; role_name: string; hierarchy_level: number; is_active: boolean }>;
  roleByName: Map<string, { id: string; role_code: string; role_name: string; hierarchy_level: number; is_active: boolean }>;
  deptByCode: Map<string, { id: string; department_code: string; department_name: string; is_active: boolean }>;
  deptByName: Map<string, { id: string; department_code: string; department_name: string; is_active: boolean }>;
  teamByCode: Map<string, { id: string; team_code: string; team_name: string; is_active: boolean }>;
  teamByName: Map<string, { id: string; team_code: string; team_name: string; is_active: boolean }>;
  existingByEmpId: Map<string, { id: string; employee_id: string; email: string; role_id: string | null; department_id: string | null; team_id: string | null; manager_id: string | null; is_active: boolean; role_code: string | null; hierarchy_level: number; department_code?: string | null }>;
  existingByEmail: Map<string, { id: string; employee_id: string; email: string }>;
  allUsersManagerMap: Map<string, string | null>; // employee_id uppercase -> manager employee_id uppercase or null
  allUsersById: Map<string, string>; // user id -> employee_id uppercase
  existingById: Map<string, { id: string; employee_id: string; role_id: string | null; department_id: string | null; hierarchy_level: number; role_code: string | null; is_active: boolean }>;
}

export interface RowValidationResult {
  rowNumber: number;
  employeeId: string;
  fullName: string;
  email: string;
  roleInput: string;
  roleResolved?: string;
  roleId?: string;
  roleLevel?: number;
  departmentInput: string;
  departmentResolved?: string;
  departmentId?: string;
  teamInput: string;
  teamResolved?: string;
  teamId?: string | null;
  managerInput: string;
  managerResolved?: string; // employee_id
  managerId?: string | null; // uuid
  managerIsSameBatch: boolean;
  action: 'Create' | 'Update' | 'Skip' | 'Error';
  isValid: boolean;
  errors: string[];
  warnings: string[];
  // for commit phase
  normalized: NormalizedUserBulkRow;
  isUpdate: boolean;
  existingUserId?: string;
  mustChangePassword: boolean;
  isActive: boolean;
  temporaryPassword?: string; // only for create, may be generated later
}

export interface BulkPreviewResult {
  totalRows: number;
  validRows: number;
  rowsToCreate: number;
  rowsToUpdate: number;
  errorRows: number;
  warningRows: number;
  rows: RowValidationResult[];
  fileName?: string;
  mode: ImportMode;
}

const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UNASSIGNED_LEVEL = 99;

function clean(value: any): string {
  return String(value == null ? '' : value).trim();
}

export function normalizeEmployeeId(value: any): string {
  return clean(value).toUpperCase();
}

export function normalizeEmail(value: any): string {
  return clean(value).toLowerCase();
}

export function generateTempPassword(length = 10): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  // crypto secure
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

export function validatePasswordPolicy(pw: string): string | null {
  if (!pw) return null; // blank allowed, will be generated
  if (pw.length < 6) return 'Temporary password must be at least 6 characters';
  // Could enforce more rules, but keep minimal to match current policy (>=5/6)
  return null;
}

export function parseMustChangePassword(raw: any): { value: boolean; error?: string } {
  if (raw === undefined || raw === null || clean(raw) === '') {
    return { value: true }; // default TRUE
  }
  if (typeof raw === 'boolean') return { value: raw };
  const s = clean(raw).toLowerCase();
  if (['yes', 'y', 'true', '1', 't'].includes(s)) return { value: true };
  if (['no', 'n', 'false', '0', 'f'].includes(s)) return { value: false };
  return { value: true, error: `Must Change Password value \"${raw}\" is not Yes/No` };
}

export function parseStatus(raw: any): { isActive: boolean; label: 'Active' | 'Inactive'; error?: string } {
  if (raw === undefined || raw === null || clean(raw) === '') {
    return { isActive: true, label: 'Active' };
  }
  const s = clean(raw).toLowerCase();
  if (['active', '1', 'true', 'yes', 'enabled'].includes(s)) return { isActive: true, label: 'Active' };
  if (['inactive', '0', 'false', 'no', 'disabled'].includes(s)) return { isActive: false, label: 'Inactive' };
  return { isActive: true, label: 'Active', error: `Status \"${raw}\" must be Active or Inactive` };
}

export function normalizeUserBulkRow(raw: RawUserBulkRow): NormalizedUserBulkRow {
  const empId = normalizeEmployeeId(raw.employeeId);
  const email = normalizeEmail(raw.email || '');
  const managerEmp = normalizeEmployeeId(raw.reportingManagerEmployeeId || '');
  const mustParsed = parseMustChangePassword(raw.mustChangePassword);
  const statusParsed = parseStatus(raw.status);

  return {
    rowNumber: raw.rowNumber,
    employeeId: empId,
    fullName: clean(raw.fullName),
    email,
    phone: clean(raw.phone || ''),
    designation: clean(raw.designation || ''),
    department: clean(raw.department),
    role: clean(raw.role),
    reportingManagerEmployeeId: managerEmp,
    team: clean(raw.team || ''),
    temporaryPassword: clean(raw.temporaryPassword || ''),
    mustChangePasswordRaw: raw.mustChangePassword,
    statusRaw: raw.status,
    mustChangePassword: mustParsed.value,
    isActive: statusParsed.isActive,
    statusLabel: statusParsed.label,
  };
}

/**
 * Build reference maps from DB rows.
 * Expects:
 *  roles: { id, role_code, role_name, hierarchy_level, is_active }
 *  departments: { id, department_code, department_name, is_active }
 *  teams: { id, team_code, team_name, is_active }
 *  existingUsers: users with role info
 */
export function buildReferenceMaps(opts: {
  roles: Array<{ id: string; role_code: string; role_name: string; hierarchy_level: number; is_active?: boolean; status?: string }>;
  departments: Array<{ id: string; department_code: string; department_name: string; is_active?: boolean; status?: string }>;
  teams: Array<{ id: string; team_code: string; team_name: string; is_active?: boolean; status?: string }>;
  existingUsers: Array<{ id: string; employee_id: string; email: string; role_id: string | null; department_id: string | null; team_id: string | null; manager_id: string | null; is_active?: boolean; account_status?: string; role_code?: string | null; hierarchy_level?: number | null }>;
  allUsers: Array<{ id: string; employee_id: string; manager_id: string | null }>;
}): ReferenceMaps {
  const roleByCode = new Map<string, any>();
  const roleByName = new Map<string, any>();
  for (const r of opts.roles) {
    const active = r.is_active !== false && String(r.status || '').toUpperCase() !== 'INACTIVE';
    const entry = {
      id: r.id,
      role_code: r.role_code,
      role_name: r.role_name,
      hierarchy_level: Number(r.hierarchy_level) > 0 ? Number(r.hierarchy_level) : UNASSIGNED_LEVEL,
      is_active: active,
    };
    if (r.role_code) roleByCode.set(String(r.role_code).toUpperCase(), entry);
    if (r.role_name) roleByName.set(String(r.role_name).toUpperCase(), entry);
  }

  const deptByCode = new Map<string, any>();
  const deptByName = new Map<string, any>();
  for (const d of opts.departments) {
    const active = (d as any).is_active !== false && String((d as any).status || '').toUpperCase() !== 'INACTIVE';
    const entry = {
      id: d.id,
      department_code: (d as any).department_code || d.id,
      department_name: (d as any).department_name || (d as any).name || d.id,
      is_active: active,
    };
    if ((d as any).department_code) deptByCode.set(String((d as any).department_code).toUpperCase(), entry);
    if ((d as any).department_name) deptByName.set(String((d as any).department_name).toUpperCase(), entry);
    else if ((d as any).name) deptByName.set(String((d as any).name).toUpperCase(), entry);
  }

  const teamByCode = new Map<string, any>();
  const teamByName = new Map<string, any>();
  for (const t of opts.teams) {
    const active = (t as any).is_active !== false && String((t as any).status || '').toUpperCase() !== 'INACTIVE';
    const entry = {
      id: t.id,
      team_code: (t as any).team_code || t.id,
      team_name: (t as any).team_name || (t as any).name || t.id,
      is_active: active,
    };
    if ((t as any).team_code) teamByCode.set(String((t as any).team_code).toUpperCase(), entry);
    if ((t as any).team_name) teamByName.set(String((t as any).team_name).toUpperCase(), entry);
    else if ((t as any).name) teamByName.set(String((t as any).name).toUpperCase(), entry);
  }

  const existingByEmpId = new Map<string, any>();
  const existingByEmail = new Map<string, any>();
  const existingById = new Map<string, any>();
  for (const u of opts.existingUsers) {
    const active = u.is_active !== false && String(u.account_status || '').toUpperCase() !== 'INACTIVE';
    const empUpper = String(u.employee_id).toUpperCase();
    const entry = {
      id: u.id,
      employee_id: u.employee_id,
      email: String(u.email || '').toLowerCase(),
      role_id: u.role_id,
      department_id: u.department_id,
      team_id: u.team_id,
      manager_id: u.manager_id,
      is_active: active,
      role_code: u.role_code || null,
      hierarchy_level: Number(u.hierarchy_level) > 0 ? Number(u.hierarchy_level) : UNASSIGNED_LEVEL,
    };
    existingByEmpId.set(empUpper, entry);
    if (u.email) existingByEmail.set(String(u.email).toLowerCase(), entry);
    existingById.set(u.id, entry);
  }

  const allUsersById = new Map<string, string>();
  const allUsersManagerMap = new Map<string, string | null>();
  for (const u of opts.allUsers) {
    const empUpper = String(u.employee_id).toUpperCase();
    allUsersById.set(u.id, empUpper);
  }
  for (const u of opts.allUsers) {
    const empUpper = String(u.employee_id).toUpperCase();
    let managerEmp: string | null = null;
    if (u.manager_id) {
      managerEmp = allUsersById.get(u.manager_id) || null;
    }
    allUsersManagerMap.set(empUpper, managerEmp);
  }

  return {
    roleByCode,
    roleByName,
    deptByCode,
    deptByName,
    teamByCode,
    teamByName,
    existingByEmpId,
    existingByEmail,
    allUsersManagerMap,
    allUsersById,
    existingById,
  };
}

function resolveRole(input: string, maps: ReferenceMaps): { role?: any; error?: string } {
  if (!input) return { error: 'Role is required' };
  const upper = input.toUpperCase();
  let role = maps.roleByCode.get(upper) || maps.roleByName.get(upper);
  if (!role) {
    // try exact code match case-insensitive already done; also try trimmed
    return { error: `Unknown Role \"${input}\"` };
  }
  if (!role.is_active) return { error: `Role \"${input}\" is inactive` };
  return { role };
}

function resolveDepartment(input: string, maps: ReferenceMaps): { dept?: any; error?: string } {
  if (!input) return { error: 'Department is required' };
  const upper = input.toUpperCase();
  let dept = maps.deptByCode.get(upper) || maps.deptByName.get(upper);
  if (!dept) return { error: `Unknown Department \"${input}\"` };
  if (!dept.is_active) return { error: `Department \"${input}\" is inactive` };
  return { dept };
}

function resolveTeam(input: string, maps: ReferenceMaps): { team?: any; error?: string } {
  if (!input) return { team: undefined }; // optional
  const upper = input.toUpperCase();
  let team = maps.teamByCode.get(upper) || maps.teamByName.get(upper);
  if (!team) return { error: `Unknown Team \"${input}\"` };
  if (!team.is_active) return { error: `Team \"${input}\" is inactive` };
  return { team };
}

/**
 * Main validation function.
 * - rows: normalized rows
 * - maps: reference maps
 * - mode: createOnly or createAndUpdate
 * - permissions: { canCreate, canEdit }
 */
export function validateBulkRows(opts: {
  rows: NormalizedUserBulkRow[];
  maps: ReferenceMaps;
  mode: ImportMode;
  permissions: { canCreate: boolean; canEdit: boolean };
}): BulkPreviewResult {
  const { rows, maps, mode, permissions } = opts;

  // duplicate detection within file
  const empIdCount = new Map<string, number[]>();
  const emailCount = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.employeeId) {
      const arr = empIdCount.get(r.employeeId) || [];
      arr.push(i);
      empIdCount.set(r.employeeId, arr);
    }
    if (r.email) {
      const arr = emailCount.get(r.email) || [];
      arr.push(i);
      emailCount.set(r.email, arr);
    }
  }

  // Build batch manager map for cycle detection: employeeId -> managerEmployeeId (from batch)
  const batchManagerMap = new Map<string, string | null>();
  for (const r of rows) {
    batchManagerMap.set(r.employeeId, r.reportingManagerEmployeeId || null);
  }

  // Combined manager map for cycle detection: batch overrides existing
  const combinedManagerMap = new Map<string, string | null>(maps.allUsersManagerMap);
  for (const [emp, mgr] of batchManagerMap.entries()) {
    combinedManagerMap.set(emp, mgr);
  }

  const results: RowValidationResult[] = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!row.employeeId) errors.push('Employee ID is required');
    else if (!EMPLOYEE_ID_RE.test(row.employeeId)) errors.push(`Employee ID \"${row.employeeId}\" is invalid (2-30 chars, letters/numbers/dot/dash/underscore)`);
    if (!row.fullName) errors.push('Full Name is required');
    if (!row.department) errors.push('Department is required');
    if (!row.role) errors.push('Role is required');

    // Email format
    if (row.email && !EMAIL_RE.test(row.email)) errors.push(`Email \"${row.email}\" is not a valid email address`);

    // Duplicate within file
    if (row.employeeId && (empIdCount.get(row.employeeId)?.length || 0) > 1) {
      errors.push(`Duplicate Employee ID \"${row.employeeId}\" within the file`);
    }
    if (row.email && (emailCount.get(row.email)?.length || 0) > 1) {
      errors.push(`Duplicate Email \"${row.email}\" within the file`);
    }

    // Must Change Password parsing
    const mustParsed = parseMustChangePassword(row.mustChangePasswordRaw);
    if (mustParsed.error) errors.push(mustParsed.error);
    const mustChangePassword = mustParsed.value;

    // Status parsing
    const statusParsed = parseStatus(row.statusRaw);
    if (statusParsed.error) errors.push(statusParsed.error);

    // Temporary password validation
    const pwError = validatePasswordPolicy(row.temporaryPassword);
    if (pwError) errors.push(pwError);

    // Resolve Role
    let resolvedRole: any = null;
    let roleId: string | undefined;
    let roleLevel: number | undefined;
    if (row.role) {
      const res = resolveRole(row.role, maps);
      if (res.error) errors.push(res.error);
      else {
        resolvedRole = res.role;
        roleId = resolvedRole.id;
        roleLevel = resolvedRole.hierarchy_level;
      }
    }

    // Resolve Department
    let resolvedDept: any = null;
    let deptId: string | undefined;
    if (row.department) {
      const res = resolveDepartment(row.department, maps);
      if (res.error) errors.push(res.error);
      else {
        resolvedDept = res.dept;
        deptId = resolvedDept.id;
      }
    }

    // Resolve Team
    let resolvedTeam: any = null;
    let teamId: string | null | undefined = undefined;
    if (row.team) {
      const res = resolveTeam(row.team, maps);
      if (res.error) errors.push(res.error);
      else {
        resolvedTeam = res.team;
        teamId = resolvedTeam ? resolvedTeam.id : null;
      }
    } else {
      teamId = null;
    }

    // Existing user lookup
    const existingByEmp = row.employeeId ? maps.existingByEmpId.get(row.employeeId) : undefined;
    const existingByEmail = row.email ? maps.existingByEmail.get(row.email) : undefined;

    // Email conflict: email belongs to another user
    if (row.email && existingByEmail && existingByEmp && existingByEmail.id !== existingByEmp.id) {
      errors.push(`Email \"${row.email}\" already belongs to another user (${existingByEmail.employee_id})`);
    } else if (row.email && !existingByEmp && existingByEmail) {
      errors.push(`Email \"${row.email}\" already belongs to another user (${existingByEmail.employee_id})`);
    }

    // Determine action based on mode
    let action: RowValidationResult['action'] = 'Create';
    let isUpdate = false;
    let existingUserId: string | undefined;
    if (existingByEmp) {
      existingUserId = existingByEmp.id;
      if (mode === 'createOnly') {
        errors.push(`Employee ID \"${row.employeeId}\" already exists (Create Only mode)`);
        action = 'Error';
      } else {
        action = 'Update';
        isUpdate = true;
      }
    } else {
      action = 'Create';
      isUpdate = false;
    }

    // Permission checks per row
    if (action === 'Create' && !permissions.canCreate) {
      errors.push('You do not have permission to create users (users.create required)');
    }
    if (action === 'Update' && !permissions.canEdit) {
      errors.push('You do not have permission to update users (users.edit required)');
    }

    // For update rows, temporary password should be ignored (safe policy)
    if (isUpdate && row.temporaryPassword) {
      warnings.push('Temporary Password is ignored for existing users — use admin password reset for credential changes');
    }

    // Manager resolution
    let managerResolved: string | undefined;
    let managerId: string | null | undefined = null;
    let managerIsSameBatch = false;
    const managerInput = row.reportingManagerEmployeeId;

    if (managerInput) {
      if (managerInput === row.employeeId) {
        errors.push('User cannot report to self');
      } else {
        // Check if manager exists in batch
        const batchManagerRow = rows.find(r => r.employeeId === managerInput);
        if (batchManagerRow) {
          managerIsSameBatch = true;
          managerResolved = managerInput;
          // For same-batch, we need to ensure that batch manager row is not itself error? But we allow order independent.
          // We'll resolve managerId later during commit after creation.
          // For validation, we need manager's role level and department from batch row
          const managerBatchNormalized = batchManagerRow;
          // Resolve manager's role level from its own role input (if valid)
          let mgrRoleLevel: number | undefined;
          let mgrDeptId: string | undefined;
          // Try to resolve manager's role and dept from maps using batch row's inputs
          if (managerBatchNormalized.role) {
            const mgrRoleRes = resolveRole(managerBatchNormalized.role, maps);
            if (!mgrRoleRes.error) mgrRoleLevel = mgrRoleRes.role.hierarchy_level;
          }
          if (managerBatchNormalized.department) {
            const mgrDeptRes = resolveDepartment(managerBatchNormalized.department, maps);
            if (!mgrDeptRes.error) mgrDeptId = mgrDeptRes.dept.id;
          }

          // Hierarchy validation for same-batch manager
          if (roleLevel !== undefined && roleLevel !== UNASSIGNED_LEVEL) {
            if (roleLevel === 1) {
              errors.push('A Level-1 (CEO) employee cannot have a reporting manager');
            } else {
              if (mgrRoleLevel !== undefined) {
                if (mgrRoleLevel !== roleLevel - 1) {
                  errors.push(`Invalid reporting manager: this role sits at Level ${roleLevel}, so the manager must hold a Level ${roleLevel - 1} role (manager is Level ${mgrRoleLevel})`);
                }
                if (mgrRoleLevel !== 1 && deptId && mgrDeptId && deptId !== mgrDeptId) {
                  errors.push('Invalid reporting manager: the manager must belong to the same department');
                }
              }
            }
          }

          // Manager must be active: for same-batch, check its status parsed
          const mgrStatusParsed = parseStatus(batchManagerRow.statusRaw);
          if (!mgrStatusParsed.isActive) {
            errors.push(`Reporting manager \"${managerInput}\" must be an active employee`);
          }
        } else {
          // Check existing DB
          const existingMgr = maps.existingByEmpId.get(managerInput);
          if (!existingMgr) {
            errors.push(`Reporting manager \"${managerInput}\" not found (must exist in database or in the same file)`);
          } else {
            if (!existingMgr.is_active) errors.push(`Reporting manager \"${managerInput}\" must be an active employee`);
            managerResolved = existingMgr.employee_id.toUpperCase();
            managerId = existingMgr.id;

            // Hierarchy validation for existing manager
            if (roleLevel !== undefined && roleLevel !== UNASSIGNED_LEVEL) {
              if (roleLevel === 1) {
                errors.push('A Level-1 (CEO) employee cannot have a reporting manager');
              } else {
                const mgrLevel = existingMgr.hierarchy_level;
                if (mgrLevel !== roleLevel - 1) {
                  errors.push(`Invalid reporting manager: this role sits at Level ${roleLevel}, so the manager must hold a Level ${roleLevel - 1} role`);
                }
                if (mgrLevel !== 1 && deptId && existingMgr.department_id && deptId !== existingMgr.department_id) {
                  errors.push('Invalid reporting manager: the manager must belong to the same department');
                }
              }
            }
          }
        }
      }
    } else {
      // No manager supplied
      if (roleLevel !== undefined && roleLevel !== UNASSIGNED_LEVEL && roleLevel !== 1) {
        // In current model, Level 2+ requires manager
        errors.push('A reporting manager is required: select the employee this person reports to (one level up, same department)');
      }
    }

    // Cycle detection (only if no prior errors about manager existence)
    if (managerInput && !errors.some(e => e.includes('not found') || e.includes('cannot report to self'))) {
      // Walk up combined manager map
      const visited = new Set<string>();
      let cursor: string | null = managerInput;
      visited.add(row.employeeId);
      while (cursor) {
        if (visited.has(cursor)) {
          errors.push(`Invalid reporting manager: that would create a circular reporting chain (${row.employeeId} -> ... -> ${cursor})`);
          break;
        }
        visited.add(cursor);
        const next = combinedManagerMap.get(cursor) || null;
        // If next is in batch, use batch's manager; else use combined map already
        cursor = next;
        // Prevent infinite loop
        if (visited.size > 100) break;
      }
    }

    const isValid = errors.length === 0;
    if (!isValid) action = 'Error';

    results.push({
      rowNumber: row.rowNumber,
      employeeId: row.employeeId,
      fullName: row.fullName,
      email: row.email,
      roleInput: row.role,
      roleResolved: resolvedRole ? resolvedRole.role_name : undefined,
      roleId,
      roleLevel,
      departmentInput: row.department,
      departmentResolved: resolvedDept ? resolvedDept.department_name : undefined,
      departmentId: deptId,
      teamInput: row.team,
      teamResolved: resolvedTeam ? resolvedTeam.team_name : undefined,
      teamId,
      managerInput,
      managerResolved,
      managerId: managerId || null,
      managerIsSameBatch,
      action: isValid ? action : 'Error',
      isValid,
      errors,
      warnings,
      normalized: row,
      isUpdate,
      existingUserId,
      mustChangePassword,
      isActive: statusParsed.isActive,
      temporaryPassword: row.temporaryPassword,
    });
  }

  const totalRows = rows.length;
  const validRows = results.filter(r => r.isValid).length;
  const rowsToCreate = results.filter(r => r.isValid && r.action === 'Create').length;
  const rowsToUpdate = results.filter(r => r.isValid && r.action === 'Update').length;
  const errorRows = results.filter(r => !r.isValid).length;
  const warningRows = results.filter(r => r.isValid && r.warnings.length > 0).length;

  return {
    totalRows,
    validRows,
    rowsToCreate,
    rowsToUpdate,
    errorRows,
    warningRows,
    rows: results,
    mode,
  };
}
