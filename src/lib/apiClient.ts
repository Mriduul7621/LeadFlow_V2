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
import { useAuthStore } from '../store/authStore';

let patched = false;

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

    const token = useAuthStore.getState().token;
    if (!token) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return originalFetch(input, { ...init, headers });
  };
}
