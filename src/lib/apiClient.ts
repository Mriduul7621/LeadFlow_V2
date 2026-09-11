/**
 * apiClient.ts
 * ------------------------------------------------------------------
 * Patches the global `fetch` once, at app boot, so that every existing
 * `fetch('/api/...')` call across the services layer automatically
 * carries the current session's `Authorization: Bearer <token>` header.
 *
 * This was done as a single, centralized patch (rather than editing
 * every one of the ~44 call sites in src/services/*.ts) to add
 * authenticated-API support with minimal risk of missing a spot or
 * introducing inconsistencies. If you add new service files, you do
 * NOT need to do anything special - just call fetch('/api/...') as
 * normal and the token will be attached automatically.
 */
import { useAuthStore } from '../modules/auth/store/authStore';
import {
  recordApiRequestStart,
  recordApiRequestSettled,
  recordApiRequestFailed,
  diagnosticsNowMs,
} from '../modules/shared/api/diagnostics';

let patched = false;

/**
 * TEMPORARY, READ-ONLY performance diagnostics wrapper (mobile latency
 * troubleshooting — see docs/MOBILE_PERFORMANCE_DIAGNOSTICS.md).
 *
 * Wraps ONLY the settled promise of the REAL fetch: the Response/error is
 * passed through untouched, nothing is awaited before the request fires,
 * and the recorder receives just (url, method) at start plus safe
 * response-header metadata at settle — never Authorization headers,
 * tokens, request bodies, or response bodies.
 */
function instrumentedDiagnostics(pending: Promise<Response>, diagId: number, startedPerfMs: number): Promise<Response> {
  return pending.then(
    response => {
      recordApiRequestSettled(diagId, response, diagnosticsNowMs() - startedPerfMs);
      return response;
    },
    error => {
      recordApiRequestFailed(diagId, diagnosticsNowMs() - startedPerfMs, error);
      throw error;
    }
  );
}

export function installAuthenticatedFetch() {
  if (patched) return;
  patched = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const isApiCall = url.startsWith('/api/') || url.includes('/api/');

    if (!isApiCall) {
      return originalFetch(input, init);
    }

    // Diagnostics FIRST-CLASS metadata: only the URL and HTTP method are
    // recorded (the recorder cannot accept headers, tokens, or bodies).
    const diagId = recordApiRequestStart(url, (init.method || (input instanceof Request ? input.method : 'GET') || 'GET'));
    const startedPerfMs = diagnosticsNowMs();

    const token = useAuthStore.getState().token;
    if (!token) {
      return instrumentedDiagnostics(originalFetch(input, init), diagId, startedPerfMs);
    }

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return instrumentedDiagnostics(originalFetch(input, { ...init, headers }), diagId, startedPerfMs);
  };
}
