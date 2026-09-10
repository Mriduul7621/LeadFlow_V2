import { User } from '../../shared/types';

/**
 * loginContract.ts
 * ------------------------------------------------------------------
 * The ONE place that turns an authentication response body into the
 * client's session payload. It exists because the app has two live
 * response shapes for the same operation:
 *
 *   { token, user }                          -> server/routes/production.routes.ts
 *   { success: true, data: { token, user } } -> server/controllers/AuthController.ts
 *
 * `apiRequest()` already unwraps `{ success, data }` (see shared/api/http.ts);
 * this module then validates and normalizes what is left. Callers must NOT
 * re-implement either step - that is exactly how "logged in, but the app
 * stays on /login" happens: a top-level `{ token, user }` destructure against
 * a wrapped body yields `undefined` for both, and vice versa.
 *
 * Hard rule: credential material never enters the client state. Whatever a
 * backend sends back, `password` / `passwordHash` are dropped here before the
 * user object is stored or cached.
 */

export interface LoginPayload {
  token: string;
  user: User;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips credential fields and fills in the identity fields the UI depends on. */
export function normalizeSessionUser(raw: unknown): User {
  const source = (isRecord(raw) ? raw : {}) as Record<string, any>;
  const { password: _password, passwordHash: _passwordHash, password_hash: _snakePasswordHash, ...safe } = source;

  const employeeId = String(safe.employeeId || safe.employee_id || '').trim();
  const name = String(safe.name || safe.fullName || safe.full_name || employeeId || 'User');
  const role = String(safe.role || safe.roleCode || safe.role_code || 'EMPLOYEE');
  const inactive =
    safe.status === 'Inactive' ||
    safe.isActive === false ||
    safe.is_active === false ||
    String(safe.accountStatus || safe.account_status || '').toUpperCase() === 'INACTIVE';

  return {
    ...safe,
    id: String(safe.id ?? ''),
    employeeId: employeeId.toUpperCase(),
    name,
    role,
    status: inactive ? 'Inactive' : 'Active',
  } as User;
}

/**
 * `{ token, user }` or `{ success, data: { token, user } }` (or a body that
 * was already unwrapped by `apiRequest()`) all resolve to the same payload.
 * Throws when the response cannot produce a usable session, so a contract
 * regression fails loudly instead of silently storing `undefined`.
 */
export function extractLoginPayload(body: unknown): LoginPayload {
  const source = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(source)) {
    throw new Error('The server returned an unexpected login response.');
  }

  const token = typeof source.token === 'string' ? source.token.trim() : '';
  if (!token) {
    throw new Error('The server did not return a session token for these credentials.');
  }
  if (!isRecord(source.user)) {
    throw new Error('The server returned a session token without an account profile.');
  }

  return { token, user: normalizeSessionUser(source.user) };
}

/**
 * Session-validation reply: `{ success: true, data: <user> }` (or the bare
 * user when `apiRequest()` already unwrapped it). Returns `null` when the
 * reply carries no account identity, which the caller treats as "cannot
 * confirm this session" rather than "session is fine".
 */
export function extractSessionUser(body: unknown): User | null {
  const source = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(source)) return null;
  const hasIdentity = Boolean(source.id || source.employeeId || source.employee_id || source.email);
  if (!hasIdentity) return null;
  return normalizeSessionUser(source);
}
