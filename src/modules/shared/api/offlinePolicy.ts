/**
 * offlinePolicy.ts
 * ------------------------------------------------------------------
 * The single, explicit rule for when a READ may fall back to the
 * browser's read-only local cache (see localDb.ts):
 *
 *   - status 0        -> transport failure (network offline)
 *   - status >= 500   -> server / database unavailable
 *
 * In both cases the server gave NO answer, so a read-only fallback of
 * the CURRENT user's previously server-confirmed data is acceptable
 * (the cache is user-scoped and is refreshed on every successful read).
 *
 * 4xx responses — and therefore 401 / 403 / 404 in particular — are
 * AUTHORITATIVE answers from the server (unauthorized, forbidden, not
 * found). They must ALWAYS propagate to the caller and must NEVER be
 * masked by stale cached business data: a 401 must not "succeed" with
 * cached leads, a 403 must not "succeed" with a cached lead another
 * user's scope hid, and a 404 must not resurrect a deleted/foreign
 * record from cache.
 *
 * Writes have NO offline policy at all: every mutation is API-first and
 * a failed write throws — no local cache ever reports a false success.
 */

/** True only for "no server answer" failures (network / 5xx). */
export function shouldFallBackToCache(status: number): boolean {
  return status === 0 || status >= 500;
}

/** True for authoritative client answers (4xx) that must never fall back. */
export function isAuthoritativeClientError(status: number): boolean {
  return status >= 400 && status < 500;
}
