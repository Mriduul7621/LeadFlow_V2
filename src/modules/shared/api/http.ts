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
 *   errors. A 401 also logs the user out (token expired/invalid) so the
 *   app never keeps making unauthenticated requests in the background.
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

  if (response.status === 401) {
    // Token missing/expired - force a clean re-login.
    useAuthStore.getState().logout();
    throw new ApiError(401, 'Your session has expired. Please log in again.');
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
      (response.status === 403
        ? 'You do not have permission to perform this action.'
        : response.status === 404
          ? 'The requested record was not found.'
          : response.status === 409
            ? 'A record with the same identity already exists.'
            : response.status === 503
              ? 'The database is currently unavailable. Please try again later.'
              : `Request failed with status ${response.status}.`);
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
