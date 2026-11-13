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
  // A fresh login also forgets the Team/My-work view choice: the
  // landing re-decides from the TL+ default, never from a stale toggle.
  invalidateSessionCache(homeViewKey(userId));
}

/* ------------------------------------------------------------------ */
/* TL+ Home — team-first landing (owner-approved 2026-11-11)          */
/* ------------------------------------------------------------------ */

/**
 * Decision token for the team-first home. Deliberately NOT a route:
 * the team home renders in place at `/` (inside HomeLanding, under the
 * root route's existing gate), so no new route exists to guard, link
 * or land on by mistake.
 */
export const TEAM_HOME_PATH = '/team-home';

/**
 * The session-scoped Team / My-work view choice. Same lifetime as the
 * landing marker (in-memory session cache, keyed by user, cleared on
 * logout and on a fresh login via resetHomeLanding).
 *
 *   'team' -> `/` renders the team-first home (TL+ users only);
 *   'work' -> the user opted into their own My Day: the landing falls
 *             back to the member decision (Workbench/Dashboard);
 *   unset  -> the default applies: TL+ users get the team home,
 *             everyone else the member decision.
 */
export type HomeViewPreference = 'team' | 'work';

export function homeViewKey(userId: string): string {
  return `homeView:${userId}`;
}

/** The user's session view choice, or null when they never toggled. */
export function getHomeViewPreference(userId: string): HomeViewPreference | null {
  const value = readSessionCache<HomeViewPreference>(homeViewKey(userId))?.value;
  return value === 'team' || value === 'work' ? value : null;
}

/** Record the user's Team / My-work choice for this session. */
export function setHomeViewPreference(userId: string, view: HomeViewPreference): void {
  writeSessionCache<HomeViewPreference>(homeViewKey(userId), view);
}

/**
 * The TL+-aware landing decision (pure; HomeLanding applies it).
 *
 * "Has a team" is the "sees a team" fact (callerSeesTeam in
 * teamOverviewService): the scoped overview's scope is not 'Own'
 * (Organization or Team), OR the caller has >= 1 direct report
 * (the UM-1 tree fact). Admin / CEO / administration roles land on
 * the team home even with no reports, because their scope is not
 * 'Own'; a leaf member (scope 'Own', no reports) keeps the member
 * landing. The caller's choice to toggle to My work still wins for
 * the session.
 *
 * Returns TEAM_HOME_PATH (render the team home at `/`), or the member
 * decision unchanged (WORKBENCH_HOME_PATH / DASHBOARD_HOME_PATH as
 * computed by `resolveHomePath`).
 */
export function resolveHomeLandingDecision(input: {
  hasTeam: boolean;
  preference: HomeViewPreference | null;
  memberHomePath: string;
}): string {
  if (input.hasTeam && input.preference !== 'work') return TEAM_HOME_PATH;
  return input.memberHomePath;
}
