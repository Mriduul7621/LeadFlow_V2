/**
 * http.ts
 * ------------------------------------------------------------------
 * Centralized API request helper used by every module service.
 *
 * - Authorization header: attached globally by lib/apiClient.ts
 *   (installAuthenticatedFetch). Nothing here should ever embed
 *   credentials.
 * - Response contract: many legacy endpoints return a bare record /
 *   array, newer ones return `{ success, data }`. This helper unwraps
 *   `data` when present and returns the whole body otherwise.
 * - Errors: every non-2xx response becomes an ApiError carrying the
 *   server message + HTTP status, so callers can show meaningful UI
 *   errors. A 401 that was returned *for the active session's token* also
 *   logs the user out (expired/revoked token) so the app never keeps
 *   making unauthenticated requests in the background - see the 401 branch
 *   below for exactly which 401s count.
 */

import { useAuthStore } from '../../auth/store/authStore';

export class ApiError extends Error {
  status: number;
  data: any;

  constructor(status: number, message: string, data?: any) {
    super(message || `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function unwrapBody<T>(body: any): T {
  if (body && typeof body === 'object' && body.success === true && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  // Which session (if any) this request was sent with. lib/apiClient.ts
  // attaches exactly this token, so it identifies the session the server
  // is being asked about.
  const sentWithToken = useAuthStore.getState().token;

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      0,
      'Unable to reach the server. Please check your connection and try again.',
      err
    );
  }

  const text = await response.text().catch(() => '');
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const message =
      (body && (body.message || body.error)) ||
      (response.status === 401
        ? 'Your session has expired. Please log in again.'
        : response.status === 403
          ? 'You do not have permission to perform this action.'
          : response.status === 404
          ? 'The requested record was not found.'
          : response.status === 409
            ? 'A record with the same identity already exists.'
            : response.status === 503
              ? 'The database is currently unavailable. Please try again later.'
              : `Request failed with status ${response.status}.`);

    if (response.status === 401) {
      // The server refused to accept a session. Only end the app's session
      // when THIS request was the session's own (it carried the current
      // token and that token is still the active one).
      //
      // Without that distinction, any request fired while the app is still
      // hydrating/validating - or a plain wrong password on the login form -
      // would wipe out a perfectly good session and bounce a logged-in user
      // back to /login. Real expired/revoked sessions still log out here, so
      // nothing is weakened: the first request that carries the dead token
      // ends the session.
      const state = useAuthStore.getState();
      const rejectedTheActiveSession = Boolean(sentWithToken) && state.token === sentWithToken;
      if (rejectedTheActiveSession) state.logout();
    }

    throw new ApiError(response.status, message, body);
  }

  return unwrapBody<T>(body);
}

/** JSON helper for POST/PUT/PATCH bodies. */
export function jsonBody(data: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
