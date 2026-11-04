import {
  invalidateSessionCache,
  readSessionCache,
  writeSessionCache,
} from '../../shared/api/sessionCache';

/**
 * homeLanding.ts
 * ------------------------------------------------------------------
 * The once-per-auth-session marker for the Workbench-first landing
 * (see `resolveHomePath` in layouts/featureRouteAccess.ts and the
 * HomeLanding component). The landing redirect may fire only ONCE per
 * session: afterwards the root route `/` must render the Dashboard, or
 * the sidebar's Home item could never reach it.
 *
 * The marker lives in the in-memory session cache, keyed by user, which
 * gives exactly the right lifetime for free:
 *   - cold load / new tab -> cache is empty, the landing fires;
 *   - logout               -> authStore clears the whole cache;
 *   - fresh login          -> `activateSession` resets the marker
 *                             explicitly (resetHomeLanding below), so a
 *                             login that did not pass through a logout
 *                             still lands;
 *   - in-app navigation    -> the marker survives, Home renders the
 *                             Dashboard.
 */
export function homeLandingKey(userId: string): string {
  return `homeLanding:${userId}`;
}

/** True once this session has already made (and applied) the landing decision. */
export function hasConsumedHomeLanding(userId: string): boolean {
  return readSessionCache<boolean>(homeLandingKey(userId))?.value === true;
}

/** Record that the landing decision has been applied for this session. */
export function consumeHomeLanding(userId: string): void {
  writeSessionCache<boolean>(homeLandingKey(userId), true);
}

/** Forget the marker (fresh login) so the landing decision runs again. */
export function resetHomeLanding(userId: string): void {
  invalidateSessionCache(homeLandingKey(userId));
}
