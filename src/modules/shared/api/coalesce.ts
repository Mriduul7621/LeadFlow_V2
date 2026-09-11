/**
 * coalesce.ts
 * ------------------------------------------------------------------
 * In-flight request coalescing for shared GET reads — SESSION-SCOPED.
 *
 * Why this exists: several startup paths can issue the exact same read
 * twice before the first response lands —
 *   - React StrictMode double-mounts effects in development (roles,
 *     notifications, dashboard data, daily execution, calendar window),
 *   - fast route mount/unmount races re-run page effects,
 *   - two components (e.g. Dashboard + an embedded child) read the same
 *     endpoint on the same tick.
 * Every duplicate is a full round-trip to PostgreSQL for no UI change.
 *
 * Session boundary (hard guarantee):
 * - The in-flight map is keyed by `<sessionScope>::<requestUrl>`, where
 *   `sessionScope` is derived on EVERY call from the live auth store:
 *   the authenticated `user.id` plus a short non-cryptographic
 *   fingerprint of the current session token. Two requests can only be
 *   joined when they belong to the SAME authenticated session, so:
 *     * a request started under user A can never be joined by user B,
 *     * logout + login (even of the SAME user, who then holds a new
 *       token) starts a fresh scope and cannot join the prior session's
 *       in-flight request,
 *     * unauthenticated calls collapse to one stable anonymous scope —
 *       the six coalesced readers are all behind requireAuth anyway.
 * - The raw token NEVER appears in the key, in logs, or in debug output:
 *   only its 32-bit FNV-1a fingerprint (base36, ~7 chars) is used.
 *
 * Rules (keep this a read-only optimization):
 * - ONLY idempotent GET reads may be coalesced. Mutations must never go
 *   through this helper.
 * - The request key is the fully-qualified request URL (path + query),
 *   so two callers with different parameters always get separate
 *   requests, and path/query distinctions are preserved exactly.
 * - An in-flight promise is shared, then dropped as soon as it settles.
 *   Nothing here caches results across requests: TTLs and invalidation
 *   stay the domain of the existing session cache
 *   (src/modules/shared/api/sessionCache.ts) — this file only collapses
 *   concurrent duplicates of the SAME logical request in the SAME
 *   session.
 * - Nothing is persisted anywhere: the map is in-memory, per page load.
 * - Failures are not swallowed: every waiter in the same session
 *   receives the same rejection the original caller would have.
 */

import { useAuthStore } from '../../auth/store/authStore';

const inFlight = new Map<string, Promise<unknown>>();

/**
 * 32-bit FNV-1a fingerprint of a string (deterministic, non-cryptographic).
 * Used to bind coalescing to the current session token WITHOUT storing or
 * exposing the raw token anywhere.
 */
function tokenFingerprint(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Current session identity for coalescing keys. Derived on every call
 * from the live auth store (single source of truth used by the http
 * layer and the apiClient token patch).
 *
 * Shape: `u:<user.id|anon>|t:<token-fingerprint|anon>`
 */
function currentSessionScope(): string {
  const state = useAuthStore.getState();
  const uid = state.user?.id ? `u:${String(state.user.id)}` : 'u:anon';
  const tf = state.token ? `t:${tokenFingerprint(String(state.token))}` : 't:anon';
  return `${uid}|${tf}`;
}

/**
 * Run `fn` for `key`, or join the in-flight request already running for
 * the SAME session under that key. `fn` is responsible for performing
 * the actual (GET) request.
 */
export function coalesceGet<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const scopedKey = `${currentSessionScope()}::${key}`;
  const existing = inFlight.get(scopedKey);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      // Drop the entry as soon as it settles (success OR failure) so the
      // next call always issues a fresh request — no stale results, no
      // poisoned cache after an error.
      inFlight.delete(scopedKey);
    }
  })();
  inFlight.set(scopedKey, promise);
  return promise;
}

/**
 * Clear any still-in-flight entries. Called on logout so a request that
 * was started for the signed-out user can no longer be joined (or write
 * shared state for) a fresh session; also used as a test seam. (With
 * session-scoped keys this is defense in depth — a new session gets a
 * new scope even if an entry is still around.)
 */
export function clearCoalescing(): void {
  inFlight.clear();
}
