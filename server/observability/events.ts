/**
 * server/observability/events.ts — the structured event catalog
 * ------------------------------------------------------------------
 * Every structured event the backend emits, in one place, each with its
 * field allowlist. Keeping the catalog central means:
 *
 *   - event names stay stable (log queries / runbooks depend on them),
 *   - each helper documents WHY its fields are safe,
 *   - no call site can accidentally widen an event with arbitrary data —
 *     the allowlist is chosen here, next to the event name.
 *
 * Safety rules shared by ALL helpers (enforced by logger.ts + redaction.ts):
 *   - requestId attaches automatically from the request context,
 *   - allowlisted fields only, then key-redaction as a second layer,
 *   - NEVER: passwords, tokens/JWT, Authorization header, cookies,
 *     request/response bodies, emails, phone numbers, submitted login
 *     identifiers, raw SQL, connection strings, raw client IPs.
 *
 * Event names emitted here:
 *   auth_login_success                         (info)
 *   auth_login_failed                          (info)
 *   auth_token_rejected                        (info)
 *   auth_forced_password_change_completed      (info)
 *   auth_admin_password_reset                  (info)
 *   rate_limit_rejected                        (warn)
 *   readiness_check                            (debug when ready / warn when not)
 *   http_request_error                         (error >=500 / warn <500)
 */

import { logEvent } from './logger.js';

/* ==================================================================== */
/* Auth events                                                          */
/* ==================================================================== */

const AUTH_LOGIN_SUCCESS_ALLOWLIST = ['userId', 'role'] as const;
const AUTH_LOGIN_FAILED_ALLOWLIST = ['reason'] as const;
const AUTH_TOKEN_REJECTED_ALLOWLIST = ['reason'] as const;
const AUTH_PASSWORD_EVENT_ALLOWLIST = ['userId', 'actorUserId', 'targetUserId'] as const;

/** Login succeeded. userId = users.id (uuid); role = role code. No token. */
export function logAuthLoginSuccess(fields: { userId?: string; role?: string }): void {
  logEvent('info', 'auth_login_success', { ...fields }, AUTH_LOGIN_SUCCESS_ALLOWLIST);
}

/**
 * Login failed. `reason` is a coarse category only ('invalid_credentials',
 * 'unavailable') — NEVER the submitted employee id / email, which would
 * turn logs into a credential-stuffing ledger.
 */
export function logAuthLoginFailed(fields: { reason: string }): void {
  logEvent('info', 'auth_login_failed', { ...fields }, AUTH_LOGIN_FAILED_ALLOWLIST);
}

/**
 * A Bearer token was presented but rejected. `reason` is 'expired' or
 * 'invalid' — never the token bytes. Only emitted when a token was
 * actually presented (anonymous 401s are ordinary completion logs).
 */
export function logAuthTokenRejected(fields: { reason: 'expired' | 'invalid' }): void {
  logEvent('info', 'auth_token_rejected', { ...fields }, AUTH_TOKEN_REJECTED_ALLOWLIST);
}

/** Forced first-login password change completed (no password material). */
export function logAuthForcedPasswordChangeCompleted(fields: { userId?: string }): void {
  logEvent(
    'info',
    'auth_forced_password_change_completed',
    { ...fields },
    AUTH_PASSWORD_EVENT_ALLOWLIST
  );
}

/** Admin reset another user's password (actor + target uuids only). */
export function logAuthAdminPasswordReset(fields: {
  actorUserId?: string;
  targetUserId?: string;
}): void {
  logEvent('info', 'auth_admin_password_reset', { ...fields }, AUTH_PASSWORD_EVENT_ALLOWLIST);
}

/* ==================================================================== */
/* Rate limiting                                                        */
/* ==================================================================== */

const RATE_LIMIT_ALLOWLIST = ['limiter', 'method', 'route'] as const;

/**
 * A limiter rejected the request (HTTP 429). Carries the limiter class
 * ('general' | 'auth') and the normalized route. The raw client IP is
 * intentionally NOT logged (privacy default); operators correlate on the
 * requestId echoed in the 429 response.
 */
export function logRateLimitRejected(fields: {
  limiter: 'general' | 'auth';
  method: string;
  route: string;
}): void {
  logEvent('warn', 'rate_limit_rejected', { ...fields }, RATE_LIMIT_ALLOWLIST);
}

/* ==================================================================== */
/* Readiness probes                                                     */
/* ==================================================================== */

const READINESS_ALLOWLIST = ['status', 'summary'] as const;

/**
 * Readiness outcome. A passing probe is routine noise → DEBUG (invisible
 * at the production default level). A failing probe stays visible → WARN.
 * `summary` is the existing secret-free describeReadiness() line.
 */
export function logReadinessCheck(fields: { status: string; summary: string }): void {
  logEvent(
    fields.status === 'ready' ? 'debug' : 'warn',
    'readiness_check',
    { ...fields },
    READINESS_ALLOWLIST
  );
}

/* ==================================================================== */
/* API error events (used by the central error handler)                 */
/* ==================================================================== */

export const HTTP_REQUEST_ERROR_ALLOWLIST = [
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'errorName',
  'errorCode',
  'errorType',
  'message',
  'stack',
] as const;

/**
 * Central API failure. In production the caller passes ONLY sanitized
 * metadata (error name, safe pg-style error code, body-parser error type);
 * raw messages/stack frames are included solely in development, where the
 * caller adds `message`/`stack` to the fields. The allowlist admits those
 * keys but production call sites never populate them.
 */
export function logHttpRequestError(fields: {
  requestId?: string;
  method: string;
  route: string;
  status: number;
  durationMs?: number;
  errorName?: string;
  errorCode?: string;
  errorType?: string;
  message?: string;
  stack?: string;
}): void {
  const status = fields.status >= 400 && fields.status < 600 ? fields.status : 500;
  logEvent(
    status >= 500 ? 'error' : 'warn',
    'http_request_error',
    { ...fields, status },
    HTTP_REQUEST_ERROR_ALLOWLIST
  );
}
