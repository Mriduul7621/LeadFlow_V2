import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool, isDatabaseConfigured } from '../database/connection';
import { fallbackStore, createId } from '../fallbackStore';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function normalizeRole(value?: string): string {
  if (!value) return 'RO';
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

const useDb = () => isDatabaseConfigured() && !!getPool();

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

router.get('/users', requireAuth, async (_req, res) => {
  if (!useDb()) {
    return sendJson(res, 200, fallbackStore.users);
  }
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT u.*, r.role_code, r.role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.created_at DESC`);
    return sendJson(res, 200, result.rows);
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'User fetch failed' });
  }
});

router.post('/users', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const user = {
    id: payload.id || createId('user'),
    employeeId: payload.employeeId || payload.employee_id || createId('emp'),
    fullName: payload.fullName || payload.name || 'New User',
    name: payload.name || payload.fullName || 'New User',
    email: payload.email || '',
    phone: payload.phone || '',
    role: normalizeRole(payload.role || payload.roleCode),
    roleCode: payload.roleCode || payload.role || 'RO',
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
    const existing = fallbackStore.users.find(item => item.id === user.id || item.employeeId === user.employeeId || item.email === user.email);
    if (existing) {
      Object.assign(existing, user);
    } else {
      fallbackStore.users.push(user);
    }
    return sendJson(res, 200, { success: true, data: user });
  }

  try {
    const pool = getPool();
    const hash = payload.password ? await bcrypt.hash(payload.password, 10) : undefined;
    const result = await pool.query(
      `INSERT INTO users (id, employee_id, full_name, email, phone, password, role_id, department_id, team_id, manager_id, designation, profile_photo, is_active, account_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET
         employee_id = EXCLUDED.employee_id,
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         password = COALESCE(EXCLUDED.password, users.password),
         role_id = EXCLUDED.role_id,
         department_id = EXCLUDED.department_id,
         team_id = EXCLUDED.team_id,
         manager_id = EXCLUDED.manager_id,
         designation = EXCLUDED.designation,
         profile_photo = EXCLUDED.profile_photo,
         is_active = EXCLUDED.is_active,
         account_status = EXCLUDED.account_status,
         updated_at = NOW()
       RETURNING *`,
      [
        user.id,
        user.employeeId,
        user.fullName,
        user.email,
        user.phone,
        hash || payload.password || null,
        null,
        user.departmentId || null,
        user.teamId || null,
        user.managerId || null,
        user.designation || null,
        user.avatarUrl || null,
        user.isActive !== false,
        user.accountStatus || 'ACTIVE',
      ]
    );
    return sendJson(res, 200, { success: true, data: result.rows[0] || user });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error.message || 'Create user failed' });
  }
});

router.post('/auth/login', async (req, res) => {
  const employeeId = String(req.body?.employeeId || req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!employeeId || !password) {
    return sendJson(res, 400, { success: false, message: 'Employee ID and password are required' });
  }

  if (!useDb()) {
    const user = fallbackStore.users.find(item => item.employeeId.toUpperCase() === employeeId.toUpperCase() || item.email.toLowerCase() === employeeId.toLowerCase());
    if (!user || !user.password) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email, name: user.fullName });
    return sendJson(res, 200, { success: true, token, user: { ...user, name: user.fullName || user.name } });
  }

  try {
    const pool = getPool();
    const result = await pool.query(`SELECT u.*, r.role_code, r.role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE UPPER(u.employee_id) = UPPER($1) OR UPPER(u.email) = UPPER($1) LIMIT 1`, [employeeId]);
    const user = result.rows[0];
    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const valid = user.password ? await bcrypt.compare(password, user.password) : user.password === password;
    if (!valid) {
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: user.id, employeeId: user.employee_id, role: user.role_code || user.role || 'RO', email: user.email, name: user.full_name });
    return sendJson(res, 200, { success: true, token, user: { id: user.id, employeeId: user.employee_id, fullName: user.full_name, name: user.full_name, email: user.email, role: user.role_code || 'RO', roleCode: user.role_code || 'RO' } });
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
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) {
      return sendJson(res, 401, { success: false, message: 'Current password is incorrect' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
  }

  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM users WHERE id = $1 OR employee_id = $1 LIMIT 1', [userId]);
    const user = result.rows[0];
    if (!user) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    const ok = user.password ? await bcrypt.compare(currentPassword, user.password) : user.password === currentPassword;
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

router.post('/leads', async (req, res) => {
  const lead = req.body || {};
  if (!lead.id) return sendJson(res, 400, { success: false, message: 'Lead id required' });
  const existingIndex = fallbackStore.leads.findIndex(item => item.id === lead.id);
  if (existingIndex >= 0) fallbackStore.leads[existingIndex] = { ...fallbackStore.leads[existingIndex], ...lead };
  else fallbackStore.leads.push({ ...lead, timestamp: lead.timestamp || new Date().toISOString() });
  return sendJson(res, 200, { success: true, data: lead });
});

router.get('/leads', async (_req, res) => {
  return sendJson(res, 200, fallbackStore.leads);
});

router.delete('/leads/:id', async (req, res) => {
  fallbackStore.leads = fallbackStore.leads.filter(lead => lead.id !== req.params.id);
  return sendJson(res, 200, { success: true });
});

router.post('/leads/clear-all', async (_req, res) => {
  fallbackStore.leads = [];
  return sendJson(res, 200, { success: true });
});

router.get('/users/check-admin', requireAuth, async (_req, res) => {
  const exists = fallbackStore.users.some(user => normalizeRole(user.role) === 'ADMIN');
  return sendJson(res, 200, { exists });
});

router.get('/dashboard', async (_req, res) => {
  return sendJson(res, 200, { success: true, data: { leadCount: fallbackStore.leads.length, userCount: fallbackStore.users.length } });
});

export default router;
