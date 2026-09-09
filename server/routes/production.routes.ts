import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../database/connection.js';
import { fallbackStore, createId } from '../fallbackStore.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

/* =========================================================
   HELPERS
========================================================= */

function normalizeRole(value?: string): string {
  if (!value) return 'EMPLOYEE';
  return String(value).toUpperCase();
}

function signToken(payload: Record<string, any>) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function getAuthUser(req: any) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET) as any;
  } catch {
    return null;
  }
}

function requireAuth(req: any, res: any, next: any) {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  req.currentUser = user;
  next();
}

function sendJson(res: any, status: number, payload: any) {
  res.status(status).json(payload);
}

const useDb = () => !!process.env.DATABASE_URL;

async function hasAdminUser(): Promise<boolean> {
  if (!useDb()) {
    return fallbackStore.users.some(user => normalizeRole(user.role) === 'ADMIN');
  }
  const pool = getPool();
  const result = await pool.query(
    `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE UPPER(r.role_code) = 'ADMIN' LIMIT 1`
  );
  return result.rows.length > 0;
}

/**
 * Allows unauthenticated access only while bootstrapping the first ADMIN.
 * If a valid token is present, behave like requireAuth.
 * If no token is present and no ADMIN exists, allow the request.
 * Otherwise require authentication.
 */
async function requireAuthOrBootstrap(req: any, res: any, next: any) {
  const user = getAuthUser(req);
  if (user) {
    req.currentUser = user;
    next();
    return;
  }

  try {
    const adminExists = await hasAdminUser();
    if (!adminExists) {
      next();
      return;
    }
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'Auth check failed' });
    return;
  }

  res.status(401).json({ success: false, message: 'Unauthorized' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (value: any): string | null => (value && UUID_RE.test(String(value)) ? String(value) : null);

const DEFAULT_ROLES: Array<{ code: string; name: string; level: number }> = [
  { code: 'ADMIN', name: 'Administrator', level: 1 },
  { code: 'MANAGER', name: 'Manager', level: 2 },
  { code: 'TEAM_LEAD', name: 'Team Lead', level: 3 },
  { code: 'EMPLOYEE', name: 'Employee', level: 4 },
  { code: 'SM', name: 'Sales Manager', level: 2 },
  { code: 'BDM', name: 'Business Development Manager', level: 3 },
  { code: 'SBE', name: 'Senior Business Executive', level: 4 },
  { code: 'BE', name: 'Business Executive', level: 5 },
];

let rolesEnsured = false;

/**
 * Seeds the default roles if the roles table is empty.
 */
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
    console.log('✅ Default roles seeded');
  }
  rolesEnsured = true;
}

async function resolveRoleId(roleCode: string): Promise<string | null> {
  const pool = getPool();
  await ensureDefaultRoles();
  const code = normalizeRole(roleCode);
  let result = await pool.query('SELECT id FROM roles WHERE UPPER(role_code) = $1 LIMIT 1', [code]);
  if (result.rows[0]) return result.rows[0].id;
  // Unknown role code -> create it on the fly so users can still be saved
  result = await pool.query(
    `INSERT INTO roles (role_code, role_name, hierarchy_level, is_active, created_at, updated_at)
     VALUES ($1, $2, 99, TRUE, NOW(), NOW())
     ON CONFLICT (role_code) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [code, code]
  );
  return result.rows[0]?.id || null;
}

function mapUserRow(row: any) {
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
    status: row.is_active === false ? 'Inactive' : 'Active',
    accountStatus: row.is_active === false ? 'Inactive' : 'Active',
    isActive: row.is_active !== false,
    designation: row.designation || '',
    departmentId: row.department_id || '',
    teamId: row.team_id || '',
    managerId: row.manager_id || '',
    reportingManagerId: row.manager_id || '',
    avatarUrl: row.profile_photo || '',
    joiningDate: row.joining_date || null,
    lastLogin: row.last_login || null,
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
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

function mapLeadRow(row: any) {
  const custom = row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {};
  return {
    ...custom,
    id: row.lead_code || row.id,
    dbId: row.id,
    prospectName: row.customer_name,
    customerName: row.customer_name,
    mobile: row.mobile,
    alternateMobile: row.alternate_mobile || '',
    email: row.email || '',
    profession: row.occupation || '',
    occupation: row.occupation || '',
    maritalStatus: row.marital_status || '',
    address: row.address || '',
    area: row.area || '',
    district: row.district || '',
    division: row.division || '',
    source: row.source || '',
    priority: row.priority || 'NORMAL',
    notes: row.notes || '',
    assignedTo: row.assigned_to || custom.assignedTo || '',
    assignedBy: row.assigned_by || custom.assignedBy || '',
    projectedNCP: row.expected_premium != null ? Number(row.expected_premium) : (custom.projectedNCP ?? 0),
    sumAssured: row.expected_value != null ? Number(row.expected_value) : (custom.sumAssured ?? 0),
    lastFollowUpDate: row.last_contacted_at || custom.lastFollowUpDate || '',
    nextFollowUpDate: row.next_follow_up_at || custom.nextFollowUpDate || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    creationDate: row.created_at,
    timestamp: row.updated_at || row.created_at,
  };
}

function mapHierarchyRow(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    managerId: row.manager_id || null,
    level: row.level,
    path: row.path || '',
    createdDate: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* =========================================================
   DB STATUS
========================================================= */

router.get('/db-status', async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, { connected: false, message: 'Database not configured. Using local fallback mode.' });
  }
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return sendJson(res, 200, { connected: true, message: 'Database connected.' });
  } catch (error: any) {
    return sendJson(res, 503, { connected: false, message: error.message || 'Database unavailable.' });
  }
});

/* =========================================================
   USERS
========================================================= */

router.get('/users/check-admin', async (_req, res) => {
  if (!useDb()) {
    const exists = fallbackStore.users.some(user => normalizeRole(user.role) === 'ADMIN');
    return res.status(200).json({ exists });
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE UPPER(r.role_code) = 'ADMIN' LIMIT 1`
    );
    return res.status(200).json({ exists: result.rows.length > 0 });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Admin check failed' });
  }
});

router.get('/users', requireAuth, async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, fallbackStore.users);
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT u.*, r.role_code, r.role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       ORDER BY u.created_at DESC`
    );
    return sendJson(res, 200, result.rows.map(mapUserRow));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'User fetch failed' });
  }
});

router.post('/users', requireAuthOrBootstrap, async (req, res) => {
  const payload = req.body || {};
  const user = {
    id: payload.id || createId('user'),
    employeeId: payload.employeeId || payload.employee_id || createId('emp'),
    fullName: payload.fullName || payload.name || 'New User',
    name: payload.name || payload.fullName || 'New User',
    email: payload.email || '',
    phone: payload.phone || '',
    role: normalizeRole(payload.role || payload.roleCode),
    roleCode: normalizeRole(payload.roleCode || payload.role),
    status: (payload.status === 'Inactive' ? 'Inactive' : 'Active') as 'Active' | 'Inactive',
    accountStatus: payload.status || 'Active',
    isActive: payload.status !== 'Inactive',
    designation: payload.designation || '',
    departmentId: payload.departmentId || '',
    teamId: payload.teamId || '',
    managerId: payload.managerId || payload.reportingManagerId || '',
    reportingManagerId: payload.reportingManagerId || payload.managerId || '',
    avatarUrl: payload.avatarUrl || '',
    createdDate: new Date().toISOString(),
    password: payload.password || '',
    mustChangePassword: !!payload.mustChangePassword,
  };

  if (!useDb()) {
    const existing = fallbackStore.users.find(
      item => item.id === user.id || item.employeeId === user.employeeId || (user.email && item.email === user.email)
    );
    if (payload.password) {
      user.password = await bcrypt.hash(payload.password, 10);
    } else if (existing?.password) {
      user.password = existing.password;
    }
    if (existing) {
      Object.assign(existing, user);
    } else {
      fallbackStore.users.push(user);
    }
    const { password: _pw, ...safeUser } = user;
    return sendJson(res, 200, { success: true, data: safeUser });
  }

  try {
    const pool = getPool();
    const hash = payload.password ? await bcrypt.hash(payload.password, 10) : null;
    const roleId = await resolveRoleId(user.roleCode);
    if (!roleId) {
      return sendJson(res, 400, { success: false, message: `Unknown role: ${user.roleCode}` });
    }

    const result = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, phone, password, role_id, department_id, team_id, manager_id, designation, profile_photo, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,COALESCE($5, ''),$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
       ON CONFLICT (employee_id) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         password = COALESCE($5, users.password),
         role_id = EXCLUDED.role_id,
         department_id = EXCLUDED.department_id,
         team_id = EXCLUDED.team_id,
         manager_id = EXCLUDED.manager_id,
         designation = EXCLUDED.designation,
         profile_photo = EXCLUDED.profile_photo,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING *`,
      [
        user.employeeId,
        user.fullName,
        user.email || `${String(user.employeeId).toLowerCase()}@leadflow.local`,
        user.phone || null,
        hash,
        roleId,
        asUuid(user.departmentId),
        asUuid(user.teamId),
        asUuid(user.managerId),
        user.designation || null,
        user.avatarUrl || null,
        user.isActive !== false,
      ]
    );

    const row = result.rows[0];
    const mapped = mapUserRow({ ...row, role_code: user.roleCode, role_name: user.roleCode });
    return sendJson(res, 200, { success: true, data: mapped });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Create user failed' });
  }
});

/* =========================================================
   AUTH
========================================================= */

router.post('/auth/login', async (req, res) => {
  const employeeId = String(req.body?.employeeId || req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!employeeId || !password) {
    return sendJson(res, 400, { success: false, message: 'Employee ID and password are required' });
  }

  if (!useDb()) {
    const user = fallbackStore.users.find(
      item => item.employeeId.toUpperCase() === employeeId.toUpperCase() || (item.email && item.email.toLowerCase() === employeeId.toLowerCase())
    );
    if (!user || !user.password) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const ok = user.password.startsWith('$2') ? await bcrypt.compare(password, user.password) : user.password === password;
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email, name: user.fullName });
    const { password: _pw, ...safeUser } = user;
    return res.status(200).json({ token, user: { ...safeUser, name: user.fullName || user.name } });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT u.*, r.role_code, r.role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE UPPER(u.employee_id) = UPPER($1) OR UPPER(u.email) = UPPER($1)
       LIMIT 1`,
      [employeeId]
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
    const token = signToken({ id: user.id, employeeId: user.employee_id, role: user.role_code || 'EMPLOYEE', email: user.email, name: user.full_name });
    return res.status(200).json({ token, user: mapUserRow(user) });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Login failed' });
  }
});

router.post('/auth/change-password', requireAuth, async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body || {};
  if (!userId || !currentPassword || !newPassword) {
    return sendJson(res, 400, { success: false, message: 'All password fields are required' });
  }

  if (!useDb()) {
    const user = fallbackStore.users.find(item => item.id === userId || item.employeeId === userId);
    if (!user || !user.password) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    const ok = user.password.startsWith('$2') ? await bcrypt.compare(currentPassword, user.password) : user.password === currentPassword;
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM users WHERE id::text = $1 OR employee_id = $1 LIMIT 1',
      [String(userId)]
    );
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
    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, user.id]);
    return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Password update failed' });
  }
});

/* =========================================================
   DEPARTMENTS
========================================================= */

const fallbackDepartments: Array<{ id: string; name: string; code?: string; createdDate: string }> = [];

router.get('/departments', async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, fallbackDepartments);
  }
  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM departments ORDER BY created_at ASC');
    return sendJson(res, 200, result.rows.map(mapDepartmentRow));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Department fetch failed' });
  }
});

router.post('/departments', async (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || payload.departmentName || payload.department_name || '').trim();
  if (!name) {
    return sendJson(res, 400, { success: false, message: 'Department name is required' });
  }
  const code = String(payload.code || payload.departmentCode || payload.department_code || name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 30);

  if (!useDb()) {
    const existing = fallbackDepartments.find(d => d.id === payload.id || d.code === code);
    const item = { id: payload.id || createId('dept'), name, code, createdDate: new Date().toISOString() };
    if (existing) Object.assign(existing, item);
    else fallbackDepartments.push(item);
    return sendJson(res, 200, existing || item);
  }

  try {
    const pool = getPool();
    const existingId = asUuid(payload.id);
    let result;
    if (existingId) {
      result = await pool.query(
        `UPDATE departments
         SET department_name = $2, department_code = $3, description = $4, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existingId, name, code, payload.description || null]
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
        [code, name, payload.description || null]
      );
    }
    return sendJson(res, 200, mapDepartmentRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Department save failed' });
  }
});

router.delete('/departments/:id', async (req, res) => {
  if (!useDb()) {
    const idx = fallbackDepartments.findIndex(d => d.id === req.params.id);
    if (idx >= 0) fallbackDepartments.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const pool = getPool();
    await pool.query('DELETE FROM departments WHERE id::text = $1 OR department_code = $1', [req.params.id]);
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Department delete failed' });
  }
});

/* =========================================================
   HIERARCHIES
========================================================= */

const fallbackHierarchies: Array<Record<string, any>> = [];

router.get('/hierarchies', async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, fallbackHierarchies);
  }
  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM hierarchies ORDER BY level ASC, created_at ASC');
    return sendJson(res, 200, result.rows.map(mapHierarchyRow));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Hierarchy fetch failed' });
  }
});

router.post('/hierarchies', async (req, res) => {
  const payload = req.body || {};

  if (!useDb()) {
    const item = { ...payload, id: payload.id || createId('hier'), updatedAt: new Date().toISOString() };
    const idx = fallbackHierarchies.findIndex(h => h.id === item.id);
    if (idx >= 0) fallbackHierarchies[idx] = item;
    else fallbackHierarchies.push(item);
    return sendJson(res, 200, item);
  }

  const userId = asUuid(payload.userId || payload.user_id);
  const managerId = asUuid(payload.managerId || payload.manager_id);
  const level = Number(payload.level) > 0 ? Number(payload.level) : 1;

  if (!userId) {
    return sendJson(res, 400, { success: false, message: 'A valid user_id is required' });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO hierarchies (user_id, manager_id, level, path, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         manager_id = EXCLUDED.manager_id,
         level = EXCLUDED.level,
         path = EXCLUDED.path,
         updated_at = NOW()
       RETURNING *`,
      [userId, managerId, level, payload.path || null]
    );
    return sendJson(res, 200, mapHierarchyRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Hierarchy save failed' });
  }
});

router.delete('/hierarchies/:id', async (req, res) => {
  if (!useDb()) {
    const idx = fallbackHierarchies.findIndex(h => h.id === req.params.id);
    if (idx >= 0) fallbackHierarchies.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const pool = getPool();
    await pool.query('DELETE FROM hierarchies WHERE id::text = $1 OR user_id::text = $1', [req.params.id]);
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Hierarchy delete failed' });
  }
});

/* =========================================================
   METADATA / OPTIONS / WORKFLOW (in-memory)
========================================================= */

router.get('/metadata-types', async (_req, res) => {
  return sendJson(res, 200, fallbackStore.metadataTypes);
});

router.post('/metadata-types', async (req, res) => {
  const { key, label, description } = req.body || {};
  const normalizedKey = String(key || label || '').trim().replace(/\s+/g, '_');
  if (!normalizedKey || !label) return sendJson(res, 400, { error: 'Type key and label are required' });
  const existing = fallbackStore.metadataTypes.find(item => item.key.toLowerCase() === normalizedKey.toLowerCase());
  if (existing) return sendJson(res, 200, existing);
  const item = { key: normalizedKey, label: String(label), description: String(description || ''), isSystem: false, sortOrder: fallbackStore.metadataTypes.length + 1 };
  fallbackStore.metadataTypes.push(item);
  return sendJson(res, 201, item);
});

router.get('/options', async (_req, res) => {
  return sendJson(res, 200, fallbackStore.options);
});

router.post('/options', async (req, res) => {
  const { type, value, label, status, meta } = req.body || {};
  if (!type || !value) return sendJson(res, 400, { error: 'Type and value are required' });
  const existing = fallbackStore.options.find(item => item.type === type && item.value === value);
  const item = existing || { id: createId('option'), type, value, label: label || String(value), status: status || 'Active', meta: meta || {} };
  if (existing) Object.assign(existing, item);
  else fallbackStore.options.push(item);
  return sendJson(res, 200, item);
});

router.get('/workflow-rules', async (_req, res) => {
  return sendJson(res, 200, fallbackStore.workflowRules);
});

router.post('/workflow-rules', async (req, res) => {
  const payload = req.body || {};
  const item = {
    id: payload.id || createId('workflow-rule'),
    status: payload.status || 'Untouched',
    allowedNextStatuses: payload.allowedNextStatuses || null,
    requiresLossReason: !!payload.requiresLossReason,
    requiresMeetingType: !!payload.requiresMeetingType,
    requiresFollowUpType: !!payload.requiresFollowUpType,
    requiresNote: !!payload.requiresNote,
    isSystem: !!payload.isSystem,
    createdDate: new Date().toISOString(),
  };
  const existing = fallbackStore.workflowRules.find(rule => rule.id === item.id || rule.status === item.status);
  if (existing) Object.assign(existing, item);
  else fallbackStore.workflowRules.push(item);
  return sendJson(res, 200, item);
});

/* =========================================================
   NOTIFICATIONS (in-memory)
========================================================= */

router.get('/notifications/users/:userId', async (req, res) => {
  const list = fallbackStore.notifications.filter(item => item.userId === req.params.userId);
  return sendJson(res, 200, list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
});

router.get('/notifications/leads/:leadId', async (req, res) => {
  const list = fallbackStore.notifications.filter(item => item.leadId === req.params.leadId);
  return sendJson(res, 200, list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
});

router.post('/notifications', async (req, res) => {
  const payload = req.body || {};
  const item = {
    id: payload.id || createId('notification'),
    userId: payload.userId,
    title: payload.title || 'Notification',
    message: payload.message || '',
    leadId: payload.leadId || '',
    read: !!payload.read,
    date: payload.date || new Date().toISOString(),
  };
  fallbackStore.notifications.push(item);
  return sendJson(res, 200, item);
});

router.post('/notifications/:id/read', async (req, res) => {
  const item = fallbackStore.notifications.find(n => n.id === req.params.id);
  if (!item) return sendJson(res, 404, { success: false, message: 'Notification not found' });
  item.read = true;
  return sendJson(res, 200, { success: true, data: item });
});

router.post('/notifications/users/:userId/read-all', async (req, res) => {
  fallbackStore.notifications.filter(n => n.userId === req.params.userId).forEach(n => { n.read = true; });
  return sendJson(res, 200, { success: true });
});

router.delete('/notifications/users/:userId', async (req, res) => {
  fallbackStore.notifications = fallbackStore.notifications.filter(n => n.userId !== req.params.userId);
  return sendJson(res, 200, { success: true });
});

/* =========================================================
   LEADS
========================================================= */

router.get('/leads', async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, fallbackStore.leads);
  }
  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM leads WHERE is_deleted = FALSE ORDER BY created_at DESC');
    return sendJson(res, 200, result.rows.map(mapLeadRow));
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Lead fetch failed' });
  }
});

router.post('/leads', async (req, res) => {
  const lead = req.body || {};
  const customerName = String(lead.customerName || lead.customer_name || lead.prospectName || lead.prospect_name || '').trim();
  const mobile = String(lead.mobile || lead.phone || '').trim();

  if (!useDb()) {
    if (!lead.id) lead.id = createId('lead');
    const existingIndex = fallbackStore.leads.findIndex(item => item.id === lead.id);
    if (existingIndex >= 0) fallbackStore.leads[existingIndex] = { ...fallbackStore.leads[existingIndex], ...lead };
    else fallbackStore.leads.push({ ...lead, timestamp: lead.timestamp || new Date().toISOString() });
    return sendJson(res, 200, { success: true, data: lead });
  }

  if (!customerName || !mobile) {
    return sendJson(res, 400, { success: false, message: 'Customer name and mobile are required' });
  }

  // Client-side ids are stored in lead_code; the DB generates the UUID primary key.
  const leadCode = String(lead.leadCode || lead.lead_code || lead.id || createId('lead')).slice(0, 50);

  const {
    id: _id, dbId: _dbId, customerName: _cn, customer_name: _cn2, prospectName: _pn, prospect_name: _pn2,
    mobile: _m, alternateMobile: _am, email: _e, profession: _p, occupation: _o, maritalStatus: _ms,
    address: _addr, area: _area, district: _dist, division: _div, source: _src, priority: _prio, notes: _notes,
    assignedTo: _at, assignedBy: _ab, projectedNCP: _pncp, sumAssured: _sa, lastFollowUpDate: _lf,
    nextFollowUpDate: _nf, tags: _tags, creationDate: _cd, timestamp: _ts,
    ...customFields
  } = lead;

  const numeric = (v: any) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const dateOrNull = (v: any) => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null);
  const tags = Array.isArray(lead.tags) ? lead.tags : [];

  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO leads (
         lead_code, customer_name, mobile, alternate_mobile, email, marital_status, occupation,
         address, area, district, division, source, priority, expected_premium, expected_value, notes,
         assigned_to, assigned_by, last_contacted_at, next_follow_up_at, custom_fields, tags,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, COALESCE(NULLIF($13, ''), 'NORMAL'), $14, $15, $16,
         $17, $18, $19, $20, COALESCE($21::jsonb, '{}'::jsonb), COALESCE($22::jsonb, '[]'::jsonb),
         NOW(), NOW()
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
         last_contacted_at = EXCLUDED.last_contacted_at,
         next_follow_up_at = EXCLUDED.next_follow_up_at,
         custom_fields = leads.custom_fields || EXCLUDED.custom_fields,
         tags = EXCLUDED.tags,
         is_deleted = FALSE,
         deleted_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        leadCode,
        customerName,
        mobile,
        lead.alternateMobile || null,
        lead.email || null,
        lead.maritalStatus || null,
        lead.occupation || lead.profession || null,
        lead.address || null,
        lead.area || null,
        lead.district || null,
        lead.division || null,
        lead.source || null,
        lead.priority ? String(lead.priority).toUpperCase() : 'NORMAL',
        numeric(lead.projectedNCP ?? lead.expectedPremium),
        numeric(lead.sumAssured ?? lead.expectedValue),
        lead.notes || null,
        asUuid(lead.assignedTo),
        asUuid(lead.assignedBy),
        dateOrNull(lead.lastFollowUpDate),
        dateOrNull(lead.nextFollowUpDate),
        JSON.stringify({ ...customFields, assignedTo: lead.assignedTo || '', assignedBy: lead.assignedBy || '' }),
        JSON.stringify(tags),
      ]
    );
    return sendJson(res, 200, { success: true, data: mapLeadRow(result.rows[0]) });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Lead save failed' });
  }
});

router.delete('/leads/:id', async (req, res) => {
  if (!useDb()) {
    fallbackStore.leads = fallbackStore.leads.filter(lead => lead.id !== req.params.id);
    return sendJson(res, 200, { success: true });
  }
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
       WHERE lead_code = $1 OR id::text = $1`,
      [req.params.id]
    );
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Lead delete failed' });
  }
});

router.post('/leads/clear-all', async (_req, res) => {
  if (!useDb()) {
    fallbackStore.leads = [];
    return sendJson(res, 200, { success: true });
  }
  try {
    const pool = getPool();
    await pool.query(`UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW() WHERE is_deleted = FALSE`);
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Lead clear failed' });
  }
});

/* =========================================================
   DASHBOARD
========================================================= */

router.get('/dashboard', async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, { success: true, data: { leadCount: fallbackStore.leads.length, userCount: fallbackStore.users.length } });
  }
  try {
    const pool = getPool();
    const [leads, users] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM leads WHERE is_deleted = FALSE'),
      pool.query('SELECT COUNT(*)::int AS count FROM users'),
    ]);
    return sendJson(res, 200, { success: true, data: { leadCount: leads.rows[0].count, userCount: users.rows[0].count } });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Dashboard fetch failed' });
  }
});

export default router;
