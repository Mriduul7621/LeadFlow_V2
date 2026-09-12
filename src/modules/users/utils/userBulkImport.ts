/**
 * userBulkImport.ts — Client-side helpers for bulk user import
 * -------------------------------------------------------------
 * Mirrors leadUploadMapping.ts pattern but for Users.
 * - Header alias normalization (case-insensitive, punctuation tolerant)
 * - Template generation with 3 sheets: Users, Reference Values, Instructions
 * - Secure password generation (client fallback, server authoritative)
 * - Client preview mapping
 */

import * as XLSX from 'xlsx';
import type { RolePermission } from '../../shared/types';

export const USER_BULK_MAX_ROWS = 1000;

export interface DepartmentRef {
  id: string;
  name: string;
  code: string;
}

export interface TeamRef {
  id: string;
  name: string;
  code: string;
}

export const USER_TEMPLATE_HEADERS = [
  'Employee ID',
  'Full Name',
  'Email',
  'Phone',
  'Designation',
  'Department',
  'Role',
  'Reporting Manager Employee ID',
  'Team',
  'Temporary Password',
  'Must Change Password',
  'Status',
] as const;

export type UserTemplateHeader = typeof USER_TEMPLATE_HEADERS[number];

export interface ParsedUserBulkRow {
  rowNumber: number; // 1-based data row number (first data row = 1)
  sheetRowNumber: number; // actual sheet row (header row 1 + data row)
  employeeId: string;
  fullName: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  role: string;
  reportingManagerEmployeeId: string;
  team: string;
  temporaryPassword: string;
  mustChangePassword: string;
  status: string;
  raw: Record<string, any>;
  issues: string[]; // client-side issues
}

function clean(value: any): string {
  return String(value == null ? '' : value).trim();
}

function normalizeHeaderKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const FIELD_ALIASES: Record<string, string[]> = {
  employeeId: ['employeeid', 'employee_id', 'empid', 'emp_id', 'employee', 'empcode', 'employeecode'],
  fullName: ['fullname', 'name', 'employeename', 'full_name', 'employeefullname'],
  email: ['email', 'emailaddress', 'email_address', 'mail'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobile_no', 'contact', 'phone_no', 'mobilenumber'],
  designation: ['designation', 'title', 'jobtitle', 'position'],
  department: ['department', 'dept', 'departmentname', 'deptname', 'departmentcode', 'deptcode'],
  role: ['role', 'rolename', 'rolecode', 'designationrole'],
  reportingManagerEmployeeId: [
    'reportingmanageremployeeid',
    'reportingmanager',
    'manager',
    'managerid',
    'reportingmanagerid',
    'manageremployeeid',
    'reports_to',
    'reportsto',
    'manager_emp_id',
  ],
  team: ['team', 'branch', 'teamname', 'branchname', 'teamcode', 'branchcode'],
  temporaryPassword: ['temporarypassword', 'temppassword', 'password', 'temp_password', 'temppass'],
  mustChangePassword: ['mustchangepassword', 'must_change_password', 'forcechangepassword', 'change_password', 'mustchange'],
  status: ['status', 'accountstatus', 'isactive', 'active', 'account_status'],
};

const HEADER_TO_FIELD: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      map[normalizeHeaderKey(alias)] = field;
    }
  }
  // Also map canonical headers
  for (const h of USER_TEMPLATE_HEADERS) {
    map[normalizeHeaderKey(h)] = (() => {
      const lower = h.toLowerCase();
      if (lower.includes('employee id')) return 'employeeId';
      if (lower.includes('full name')) return 'fullName';
      if (lower.includes('email')) return 'email';
      if (lower.includes('phone')) return 'phone';
      if (lower.includes('designation')) return 'designation';
      if (lower.includes('department')) return 'department';
      if (lower.includes('role') && !lower.includes('reporting')) return 'role';
      if (lower.includes('reporting manager')) return 'reportingManagerEmployeeId';
      if (lower.includes('team') || lower.includes('branch')) return 'team';
      if (lower.includes('temporary password')) return 'temporaryPassword';
      if (lower.includes('must change')) return 'mustChangePassword';
      if (lower.includes('status')) return 'status';
      return normalizeHeaderKey(h);
    })();
  }
  return map;
})();

function extractField(row: Record<string, any>, field: string): string {
  // Try direct alias lookup via normalized keys
  for (const [rawKey, value] of Object.entries(row)) {
    const normalized = normalizeHeaderKey(rawKey);
    const mapped = HEADER_TO_FIELD[normalized];
    if (mapped === field) {
      return clean(value);
    }
  }
  // Fallback: case-insensitive direct match
  for (const [rawKey, value] of Object.entries(row)) {
    if (String(rawKey).trim().toLowerCase() === field.toLowerCase()) {
      return clean(value);
    }
  }
  return '';
}

export function generateSecurePassword(length = 10): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const array = new Uint8Array(length);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < length; i++) array[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += chars[array[i] % chars.length];
  return out;
}

export interface ReferenceDataForTemplate {
  roles: RolePermission[];
  departments: DepartmentRef[];
  teams: TeamRef[];
}

export function buildUserImportTemplate(refData: ReferenceDataForTemplate): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Users
  const exampleRows = [
    {
      'Employee ID': 'EMP001',
      'Full Name': 'John Doe',
      'Email': 'john.doe@company.com',
      'Phone': '+8801XXXXXXXXX',
      'Designation': 'Business Executive',
      'Department': refData.departments[0]?.name || 'Sales',
      'Role': refData.roles[0]?.roleName || 'BE',
      'Reporting Manager Employee ID': 'MGR001',
      'Team': refData.teams[0]?.name || '',
      'Temporary Password': '',
      'Must Change Password': 'Yes',
      'Status': 'Active',
    },
    {
      'Employee ID': 'EMP002',
      'Full Name': 'Jane Smith',
      'Email': 'jane.smith@company.com',
      'Phone': '',
      'Designation': 'Senior Business Executive',
      'Department': refData.departments[0]?.name || 'Sales',
      'Role': refData.roles[1]?.roleName || 'SBE',
      'Reporting Manager Employee ID': 'MGR001',
      'Team': '',
      'Temporary Password': 'MyTemp123',
      'Must Change Password': 'Yes',
      'Status': 'Active',
    },
  ];

  const wsUsers = XLSX.utils.json_to_sheet(exampleRows, { header: [...USER_TEMPLATE_HEADERS] });
  // Set column widths
  (wsUsers as any)['!cols'] = [
    { wch: 16 }, // Employee ID
    { wch: 22 }, // Full Name
    { wch: 28 }, // Email
    { wch: 16 }, // Phone
    { wch: 20 }, // Designation
    { wch: 18 }, // Department
    { wch: 16 }, // Role
    { wch: 28 }, // Reporting Manager Employee ID
    { wch: 16 }, // Team
    { wch: 20 }, // Temporary Password
    { wch: 20 }, // Must Change Password
    { wch: 12 }, // Status
  ];
  XLSX.utils.book_append_sheet(wb, wsUsers, 'Users');

  // Sheet 2: Reference Values
  const refRows: any[] = [];
  refRows.push({ Category: 'Valid Roles (use exact name or code)', Value: '', Description: '' });
  for (const r of refData.roles) {
    refRows.push({ Category: 'Role', Value: r.roleName, Description: `Code: ${r.roleId}, Level: ${r.hierarchyLevel}` });
  }
  refRows.push({ Category: '', Value: '', Description: '' });
  refRows.push({ Category: 'Valid Departments (use exact name or code)', Value: '', Description: '' });
  for (const d of refData.departments) {
    refRows.push({ Category: 'Department', Value: d.name, Description: `Code: ${d.code}` });
  }
  refRows.push({ Category: '', Value: '', Description: '' });
  refRows.push({ Category: 'Valid Teams / Branches', Value: '', Description: '' });
  for (const t of refData.teams) {
    refRows.push({ Category: 'Team', Value: t.name, Description: `Code: ${t.code}` });
  }
  refRows.push({ Category: '', Value: '', Description: '' });
  refRows.push({ Category: 'Allowed Status Values', Value: 'Active', Description: 'User is active' });
  refRows.push({ Category: 'Allowed Status Values', Value: 'Inactive', Description: 'User is inactive' });
  refRows.push({ Category: '', Value: '', Description: '' });
  refRows.push({ Category: 'Must Change Password', Value: 'Yes', Description: 'Default - user must change password on first login (recommended)' });
  refRows.push({ Category: 'Must Change Password', Value: 'No', Description: 'User can keep temporary password' });
  refRows.push({ Category: '', Value: '', Description: '' });
  refRows.push({ Category: 'Password Rules', Value: 'Min 6 chars', Description: 'If blank, server generates securely and returns once' });

  const wsRef = XLSX.utils.json_to_sheet(refRows);
  (wsRef as any)['!cols'] = [{ wch: 36 }, { wch: 28 }, { wch: 42 }];
  XLSX.utils.book_append_sheet(wb, wsRef, 'Reference Values');

  // Sheet 3: Instructions
  const instructions = [
    { Instruction: 'BULK USER IMPORT & PROVISIONING — Instructions', Details: '' },
    { Instruction: '', Details: '' },
    { Instruction: '1. Identity', Details: 'Employee ID is primary and must be unique. Email must also be unique if provided. Duplicates within file are errors.' },
    { Instruction: '2. Required Fields', Details: 'Employee ID*, Full Name*, Department*, Role* are required.' },
    { Instruction: '3. Normalization', Details: 'Employee ID is normalized to UPPERCASE. Email to lowercase. Role/Department/Team matched exactly (case-insensitive) against database — unknown values are row errors, not auto-created.' },
    { Instruction: '4. Role & Department', Details: 'Use exact Role name or code from Reference Values sheet. Same for Department and Team. Inactive values are rejected.' },
    { Instruction: '5. Reporting Manager', Details: 'Resolved by Employee ID only. Supports same-batch managers (row order irrelevant). Validates hierarchy: manager must hold a valid higher-authority role, normally one or two hierarchy levels above the employee, subject to department and cycle rules. Level 1 (CEO) crosses departments. No self-manager, no cycles. Active employees only.' },
    { Instruction: '6. Modes', Details: 'CREATE ONLY (default): fails if Employee ID exists. CREATE + UPDATE: updates existing users profile/org fields, never password.' },
    { Instruction: '7. Password Rules', Details: 'For new users: if Temporary Password supplied, min 6 chars, hashed server-side, never stored plaintext. If blank, server generates securely and returns once in final result. Existing user passwords are NEVER changed via bulk update — use admin reset.' },
    { Instruction: '8. Must Change Password', Details: 'Default TRUE (Yes). Persists to must_change_password and integrates with forced first-login flow. Use Yes/No, True/False, 1/0.' },
    { Instruction: '9. Status', Details: 'Active / Inactive only. Default Active.' },
    { Instruction: '10. Dry Run', Details: 'Upload/parse → server validation (no DB mutation) → preview with totals and row table → cancel or commit. Server revalidates on commit.' },
    { Instruction: '11. Transaction', Details: 'Validated partial success: each row uses savepoint, one bad row does not corrupt batch. Reporting chains recomputed once after batch.' },
    { Instruction: '12. Security', Details: 'Authorization requires users.create for creates, users.edit for updates. Feature Access alone never authorizes. Admin/Superadmin bypass per PR32. Audit logs batch metadata, never plaintext passwords.' },
    { Instruction: '13. Template', Details: 'Do not rename columns. Keep Users sheet first. You may delete example rows. Reference Values and Instructions are for guidance only and not imported.' },
    { Instruction: '', Details: '' },
    { Instruction: 'Columns', Details: 'Employee ID*, Full Name*, Email, Phone, Designation, Department*, Role*, Reporting Manager Employee ID, Team, Temporary Password, Must Change Password, Status' },
  ];

  const wsInstr = XLSX.utils.json_to_sheet(instructions);
  (wsInstr as any)['!cols'] = [{ wch: 18 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, wsInstr, 'Instructions');

  return wb;
}

export function downloadUserImportTemplate(refData: ReferenceDataForTemplate, fileName = 'User_Import_Template.xlsx'): void {
  const wb = buildUserImportTemplate(refData);
  XLSX.writeFile(wb, fileName);
}

export function parseUserImportFile(file: File): Promise<{ rows: ParsedUserBulkRow[]; headerRow: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary', cellDates: true });
        // Prefer Users sheet, else first sheet
        let sheetName = 'Users';
        if (!workbook.SheetNames.includes(sheetName)) sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
          reject(new Error('No sheet found in workbook'));
          return;
        }

        const jsonRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
        if (jsonRows.length === 0) {
          // Try header:1 to get headers
          const headerRows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1 }) as any[][];
          const headerRow = (headerRows[0] || []).map((h: any) => clean(h));
          resolve({ rows: [], headerRow });
          return;
        }

        const headerRow = Object.keys(jsonRows[0] || {});
        const parsed: ParsedUserBulkRow[] = jsonRows.map((raw, idx) => {
          const employeeId = extractField(raw, 'employeeId');
          const fullName = extractField(raw, 'fullName');
          const email = extractField(raw, 'email');
          const phone = extractField(raw, 'phone');
          const designation = extractField(raw, 'designation');
          const department = extractField(raw, 'department');
          const role = extractField(raw, 'role');
          const reportingManagerEmployeeId = extractField(raw, 'reportingManagerEmployeeId');
          const team = extractField(raw, 'team');
          const temporaryPassword = extractField(raw, 'temporaryPassword');
          const mustChangePassword = extractField(raw, 'mustChangePassword');
          const status = extractField(raw, 'status');

          const issues: string[] = [];
          if (!employeeId) issues.push('Employee ID is required');
          if (!fullName) issues.push('Full Name is required');
          if (!department) issues.push('Department is required');
          if (!role) issues.push('Role is required');
          if (temporaryPassword && temporaryPassword.length > 0 && temporaryPassword.length < 6) {
            issues.push('Temporary password must be at least 6 characters');
          }

          return {
            rowNumber: idx + 1,
            sheetRowNumber: idx + 2,
            employeeId,
            fullName,
            email,
            phone,
            designation,
            department,
            role,
            reportingManagerEmployeeId,
            team,
            temporaryPassword,
            mustChangePassword,
            status,
            raw,
            issues,
          };
        });

        resolve({ rows: parsed, headerRow });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsBinaryString(file);
  });
}

export function mapToServerRows(parsedRows: ParsedUserBulkRow[]): Array<{
  rowNumber: number;
  employeeId: string;
  fullName: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  role: string;
  reportingManagerEmployeeId: string;
  team: string;
  temporaryPassword: string;
  mustChangePassword: string;
  status: string;
}> {
  return parsedRows.map(r => ({
    rowNumber: r.rowNumber,
    employeeId: r.employeeId,
    fullName: r.fullName,
    email: r.email,
    phone: r.phone,
    designation: r.designation,
    department: r.department,
    role: r.role,
    reportingManagerEmployeeId: r.reportingManagerEmployeeId,
    team: r.team,
    temporaryPassword: r.temporaryPassword,
    mustChangePassword: r.mustChangePassword,
    status: r.status,
  }));
}
