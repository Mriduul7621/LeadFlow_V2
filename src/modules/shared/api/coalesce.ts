/**
 * coalesce.ts
 * ------------------------------------------------------------------
 * In-flight request coalescing for shared GET reads.
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
 * Rules (keep this a read-only optimization):
 * - ONLY idempotent GET reads may be coalesced. Mutations must never go
 *   through this helper.
 * - The key is the fully-qualified request URL (path + query), so two
 *   callers with different parameters always get separate requests.
 * - An in-flight promise is shared, then dropped as soon as it settles.
 *   Nothing here caches results across requests: TTLs and invalidation
 *   stay the domain of the existing session cache
 *   (src/modules/shared/api/sessionCache.ts) — this file only collapses
 *   concurrent duplicates of the SAME logical request.
 * - Failures are not swallowed: every waiter receives the same rejection
 *   the original caller would have.
 * - Never crosses users: keys are plain URLs, entries live only for the
 *   lifetime of the in-flight request, and the map is cleared on logout
 *   via the same hook the rest of session state uses (defense in depth —
 *   entries normally settle long before any logout).
 */

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` for `key`, or join the in-flight request already running under
 * that key. `fn` is responsible for performing the actual (GET) request.
 */
export function coalesceGet<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
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
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Clear any still-in-flight entries. Called on logout so a request that
 * was started for the signed-out user can no longer be joined (or write
 * shared state for) a fresh session; also used as a test seam.
 */
export function clearCoalescing(): void {
  inFlight.clear();
}
