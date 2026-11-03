/**
 * production/auth.routes.ts — AUTH domain of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the seven auth handlers
 * that used to live inline in production.routes.ts — first-admin
 * bootstrap, login, session validation, profile update and both
 * password-change flows — moved verbatim. Shared helpers are imported
 * from ./shared.js (one definition, shared with the monolith).
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPool } from '../../database/connection.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import { createPerf } from '../../utils/perf.js';
import {
  logAuthForcedPasswordChangeCompleted,
  logAuthLoginFailed,
  logAuthLoginSuccess,
} from '../../observability/events.js';
import {
  EMPLOYEE_ID_RE,
  USER_SELECT,
  adminExistsInDb,
  callerIsAdmin,
  clean,
  dbErrorStatus,
  demoModeAllowed,
  isSelfRef,
  mapUserRow,
  normalizeRole,
  requireAuth,
  resolveRoleId,
  sendDbUnavailable,
  sendJson,
  signToken,
  useDb,
  withMembershipDepartments,
} from './shared.js';

const router = Router();

/* ====================================================================
   FIRST-ADMIN BOOTSTRAP (secure, unauthenticated, guarded)
==================================================================== */

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
      logAuthLoginFailed({ reason: 'invalid_credentials' });
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const ok = user.password.startsWith('$2')
      ? await bcrypt.compare(password, user.password)
      : user.password === password;
    if (!ok) {
      logAuthLoginFailed({ reason: 'invalid_credentials' });
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const token = signToken({ id: user.id, employeeId: user.employeeId, role: normalizeRole(user.role), email: user.email, name: user.fullName || user.name });
    logAuthLoginSuccess({ userId: user.id, role: normalizeRole(user.role) });
    const { password: _pw, ...safeUser } = user;
    return res.status(200).json({ token, user: { ...safeUser, name: user.fullName || user.name } });
  }

  const perf = createPerf('auth.login');
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
    perf.span('db.userLookup');
    const user = result.rows[0];
    if (!user) {
      logAuthLoginFailed({ reason: 'invalid_credentials' });
      perf.finish(res);
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    const valid = user.password && String(user.password).startsWith('$2')
      ? await bcrypt.compare(password, user.password)
      : user.password === password;
    perf.span('auth.bcryptVerify');
    if (!valid) {
      logAuthLoginFailed({ reason: 'invalid_credentials' });
      perf.finish(res);
      return sendJson(res, 401, { success: false, message: 'Invalid credentials' });
    }
    // last_login is bookkeeping: its semantics are preserved (the update is
    // still issued for every successful login) but it no longer delays the
    // authenticated response — authentication is already confirmed.
    void pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(() => undefined);
    const role = user.role_code || 'EMPLOYEE';
    const token = signToken({ id: user.id, employeeId: user.employee_id, role, email: user.email, name: user.full_name });
    logAuthLoginSuccess({ userId: user.id, role });
    perf.finish(res);
    // The session profile carries the caller's own memberships: the client
    // mirrors the server's FullTeam scope from this payload.
    const sessionRow = await withMembershipDepartments(pool, user);
    return sendJson(res, 200, { token, user: mapUserRow(sessionRow, sessionRow.manager_employee_id) });
  } catch (error: any) {
    perf.finish(res);
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
  const perf = createPerf('auth.session');
  const claim = req.currentUser as { id?: string; employeeId?: string; email?: string } | undefined;
  const claimId = String(claim?.id || '').trim();
  const claimEmployeeId = String(claim?.employeeId || '').trim();
  const claimEmail = String(claim?.email || '').trim();

  if (!claimId && !claimEmployeeId && !claimEmail) {
    perf.finish(res);
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
      perf.span('db.userLookup');
      const row = result.rows[0];
      if (!row) {
        perf.finish(res);
        return sendJson(res, 401, { success: false, message: 'Your account no longer exists. Please log in again.' });
      }
      if (row.is_active === false || String(row.account_status || '').toUpperCase() === 'INACTIVE') {
        perf.finish(res);
        return sendJson(res, 401, { success: false, message: 'Your account is inactive. Please contact an administrator.' });
      }
      perf.finish(res);
      const sessionRow = await withMembershipDepartments(getPool(), row);
      return sendJson(res, 200, { success: true, data: mapUserRow(sessionRow, sessionRow.manager_employee_id) });
    } catch (error: any) {
      perf.finish(res);
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

router.put('/auth/profile', requireAuth, async (req, res) => {
  const body = req.body || {};
  const allowedFields = new Set(['name', 'email', 'phone']);
  if (Object.keys(body).some(key => !allowedFields.has(key))) {
    return sendJson(res, 400, { success: false, message: 'Only name, email, and phone can be changed here.' });
  }

  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const phone = String(body.phone ?? '').trim();
  if (!name || name.length > 120) {
    return sendJson(res, 400, { success: false, message: 'Name is required and must be 120 characters or fewer.' });
  }
  if (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(res, 400, { success: false, message: 'Enter a valid email address.' });
  }
  if (phone.length > 20) {
    return sendJson(res, 400, { success: false, message: 'Mobile number must be 20 characters or fewer.' });
  }

  const claim = req.currentUser as { id?: string; employeeId?: string; email?: string } | undefined;
  const claimId = String(claim?.id || '').trim();
  const claimEmployeeId = String(claim?.employeeId || '').trim();
  const claimEmail = String(claim?.email || '').trim();
  if (!claimId && !claimEmployeeId && !claimEmail) {
    return sendJson(res, 401, { success: false, message: 'Your session does not identify a user.' });
  }

  if (!useDb()) {
    if (!demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    }
    const user = fallbackStore.users.find(item =>
      (claimId && String(item.id) === claimId) ||
      (claimEmployeeId && String(item.employeeId).toUpperCase() === claimEmployeeId.toUpperCase()) ||
      (claimEmail && String(item.email).toLowerCase() === claimEmail.toLowerCase())
    );
    if (!user) return sendJson(res, 404, { success: false, message: 'User not found.' });
    const duplicate = fallbackStore.users.some(item =>
      item.id !== user.id && String(item.email).toLowerCase() === email
    );
    if (duplicate) return sendJson(res, 409, { success: false, message: 'That email address is already in use.' });
    user.name = name;
    user.fullName = name;
    user.email = email;
    user.phone = phone;
    const { password: _password, ...safeUser } = user;
    return sendJson(res, 200, { success: true, data: safeUser });
  }

  try {
    const pool = getPool();
    const existingResult = await pool.query(
      `${USER_SELECT}
       WHERE u.id::text = $1 OR UPPER(u.employee_id) = UPPER($2) OR LOWER(u.email) = LOWER($3)
       LIMIT 1`,
      [claimId || claimEmployeeId || claimEmail, claimEmployeeId || claimId, claimEmail || claimId]
    );
    const existing = existingResult.rows[0];
    if (!existing) return sendJson(res, 404, { success: false, message: 'User not found.' });

    const updated = await pool.query(
      `UPDATE users
       SET full_name = $1, email = $2, phone = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id`,
      [name, email, phone, existing.id]
    );
    const saved = await pool.query(`${USER_SELECT} WHERE u.id = $1 LIMIT 1`, [updated.rows[0].id]);
    return sendJson(res, 200, { success: true, data: mapUserRow(saved.rows[0]) });
  } catch (error: any) {
    if (error?.code === '23505') {
      return sendJson(res, 409, { success: false, message: 'That email address is already in use.' });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Profile update failed.' });
  }
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

/**
 * POST /auth/change-required-password — forced first-login password change.
 * -------------------------------------------------------------------------
 * The third, deliberately distinct password flow. A user provisioned (or
 * admin-reset) with a temporary password has `must_change_password = TRUE`
 * in PostgreSQL; the app blocks them behind the forced-change modal until
 * they set a real one. This endpoint is SEPARATE from the other two flows:
 *
 *   1. POST /users/:id/reset-password   — ADMIN-only reset of ANOTHER user
 *   2. POST /auth/change-password        — voluntary self-service, verifies
 *                                          the CURRENT password first
 *
 * Contract (fail closed everywhere):
 *   - authenticated session only; the target is ALWAYS the caller, derived
 *     from the verified bearer token — a client-supplied id is ignored, so
 *     no `users.edit` / admin capability / Settings Feature Access is ever
 *     required, and another user's password can never be changed here
 *   - the caller must exist AND currently have must_change_password = TRUE;
 *     otherwise 409 and this endpoint does NOT touch the password
 *   - password strength follows the forced-change UI minimum (>= 6 chars),
 *     hashed with the existing bcrypt policy (10 rounds)
 *   - the hash update and the flag clear happen in ONE UPDATE (atomic)
 *   - no plaintext password is logged and the hash is never returned
 */
router.post('/auth/change-required-password', requireAuth, async (req: any, res) => {
  const newPassword = String(req.body?.newPassword ?? req.body?.password ?? '');
  if (newPassword.length < 6) {
    return sendJson(res, 400, { success: false, message: 'Password must be at least 6 characters' });
  }

  // The caller's identity comes from the verified bearer token, never from
  // the request body (which may not carry a target id at all).
  const claim = req.currentUser || {};
  const claimId = String(claim.id || '').trim();
  const claimEmployeeId = String(claim.employeeId || '').trim();
  const claimEmail = String(claim.email || '').trim();

  if (!useDb()) {
    if (!demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    }
    const demoUser = fallbackStore.users.find(u =>
      (claimId && String(u.id) === claimId) ||
      (claimEmployeeId && String(u.employeeId).toUpperCase() === claimEmployeeId.toUpperCase()) ||
      (claimEmail && String(u.email).toLowerCase() === claimEmail.toLowerCase())
    );
    if (!demoUser) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    if (demoUser.mustChangePassword !== true) {
      return sendJson(res, 409, { success: false, message: 'No forced password change is required.' });
    }
    demoUser.password = await bcrypt.hash(newPassword, 10);
    demoUser.mustChangePassword = false;
    logAuthForcedPasswordChangeCompleted({ userId: demoUser.id });
    const { password: _pw, ...safeUser } = demoUser;
    return sendJson(res, 200, { success: true, data: { ...safeUser, name: demoUser.fullName || demoUser.name } });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM users
       WHERE id::text = $1 OR UPPER(employee_id) = UPPER($2) OR UPPER(email) = UPPER($3)
       LIMIT 1`,
      [claimId || claimEmployeeId || claimEmail, claimEmployeeId || claimId, claimEmail || claimId]
    );
    const user = result.rows[0];
    if (!user) {
      return sendJson(res, 404, { success: false, message: 'User not found' });
    }
    if (user.must_change_password !== true) {
      return sendJson(res, 409, { success: false, message: 'No forced password change is required.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [hashed, user.id]
    );

    logAuthForcedPasswordChangeCompleted({ userId: user.id });

    // Security-safe audit event (no password material). Best-effort: a
    // missing/readonly audit table must never fail the password change.
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor_user_id, target_user_id, action_code, entity_type, entity_id, metadata)
         VALUES ($1, $1, 'required-password-change-completed', 'user', $1, '{}'::jsonb)`,
        [user.id]
      );
    } catch { /* best-effort audit */ }

    const fresh = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [user.id]);
    const row = fresh.rows[0] || user;
    return sendJson(res, 200, { success: true, data: mapUserRow(row, row.manager_employee_id) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Password change failed' });
  }
});

export default router;
