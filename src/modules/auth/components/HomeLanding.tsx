import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { DASHBOARD_HOME_PATH } from '../../../layouts/featureRouteAccess';
import { deriveWorkspaceRole, type WorkspaceRole } from '../../../layouts/workspaceRole';
import {
  TEAM_HOME_PATH,
  consumeHomeLanding,
  getHomeViewPreference,
  hasConsumedHomeLanding,
  resolveHomeLandingDecision,
  setHomeViewPreference,
} from '../services/homeLanding';
import {
  callerSeesTeam,
  loadTeamOverview,
  readCachedTeamOverview,
  type TeamOverviewResponse,
} from '../../team/services/teamOverviewService';

const TeamLeadHome = lazy(() => import('../../workspace/pages/TeamLeadHome'));
const ManagerHome = lazy(() => import('../../workspace/pages/ManagerHome'));

/**
 * HomeLanding.tsx
 * ------------------------------------------------------------------
 * The root route's landing decision (role homes, Phase 1, 2026-11-17;
 * TL+ Home team-first since 2026-11-11).
 *
 * `/` is both the post-login destination (activateSession navigates
 * here, as it always has) and the sidebar home item's target. The
 * wrapper separates those two jobs by TIME, once per auth session
 * (see services/homeLanding.ts for the marker lifetime):
 *
 *   first arrival this session -> decide:
 *       caller SEES a team (KPI drill-down, 2026-11-13: the scoped
 *         GET /api/team/overview payload's `scope` is not 'Own' —
 *         Organization or Team — OR the caller has >= 1 report) and
 *         did not toggle to My work
 *                           -> render the team-first home in place:
 *                              the Manager home for Organization
 *                              scope, the Team Lead home otherwise
 *       everyone else       -> render the member home (children)
 *   every later arrival     -> render the member home (children), so
 *       Home stays fully reachable from navigation, unchanged — with
 *       ONE exception: a TL+ user whose session view preference is
 *       'team' keeps landing on the team home, because that is the
 *       home they chose (the Team/My-work switch flips it).
 *
 * The decision needs only the team overview (through
 * teamOverviewService, same session-cache lifetime as the shell).
 * When the fetch fails, the settled decision falls back to the
 * member landing: a failed overview load simply means "no team
 * known". The member home is always `/` now — the old
 * Workbench-first redirect is gone (the workbench is a sidebar page,
 * Follow-up Queue, not a landing).
 *
 * Denied-route fallbacks stay safe: FeatureGate redirects denied pages
 * to `/`, where the (already consumed) landing renders the member
 * home — no redirect loop is possible, because this component never
 * redirects. The team homes render in place at `/`, under this
 * route's existing gate, so they add no new route to protect.
 */

/** Neutral, shell-preserving placeholder (same markup as FeatureGate's). */
function AccessResolving() {
  return (
    <div className="space-y-4" role="status" aria-label="Checking access">
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}

function RoleHomePage({ role }: { role: WorkspaceRole }) {
  return (
    <Suspense fallback={<AccessResolving />}>
      {role === 'manager' ? <ManagerHome /> : <TeamLeadHome />}
    </Suspense>
  );
}

export default function HomeLanding({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  // The marker is read during render from the session cache: once the
  // decision has been consumed, Home is just the member home again —
  // no overview load, no placeholder, no redirect. The view preference
  // is read the same way (the Team/My-work switch writes it, then
  // navigates, so the next mount of this wrapper sees the new value).
  const alreadyLanded = userId ? hasConsumedHomeLanding(userId) : false;
  const preference = userId ? getHomeViewPreference(userId) : null;
  // Later arrivals only need the team overview when the user pinned
  // the Team view; the first arrival always needs it (TL+ default).
  const needsOverview = Boolean(userId) && (!alreadyLanded || preference === 'team');

  const [overview, setOverview] = useState<TeamOverviewResponse | null>(() =>
    userId ? readCachedTeamOverview(userId) : null
  );
  const [overviewSettled, setOverviewSettled] = useState<boolean>(() =>
    Boolean(!needsOverview || (userId && readCachedTeamOverview(userId)))
  );
  const [decision, setDecision] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !needsOverview || overviewSettled) return;
    let cancelled = false;
    loadTeamOverview(userId)
      .then(res => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {
        // A failed overview load settles as "no team known": the
        // member landing decides.
      })
      .finally(() => {
        if (!cancelled) setOverviewSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, needsOverview, overviewSettled]);

  useEffect(() => {
    if (decision !== null || !overviewSettled || !user || !userId || alreadyLanded) return;
    const home = resolveHomeLandingDecision({
      hasTeam: callerSeesTeam(overview),
      preference: getHomeViewPreference(userId),
      memberHomePath: DASHBOARD_HOME_PATH,
    });
    // A team decision also pins the session view preference to Team:
    // later arrivals at `/` then keep showing the team home until the
    // user actively switches to My work (which sets 'work').
    if (home === TEAM_HOME_PATH) setHomeViewPreference(userId, 'team');
    // Consume BEFORE rendering so any bounce back to `/` (e.g. a
    // FeatureGate denial elsewhere) renders the member home instead
    // of deciding again.
    consumeHomeLanding(userId);
    setDecision(home);
  }, [decision, overviewSettled, overview, user, userId, alreadyLanded]);

  if (!user || !userId) {
    // No user cannot happen above ProtectedRoute; falling through to
    // the member home keeps this wrapper invisible in that case.
    return <>{children}</>;
  }
  const roleUpper = String(user.role || '').toUpperCase();
  const isAdminBypass = roleUpper === 'ADMIN' || roleUpper === 'SUPERADMIN';
  const teamRole = deriveWorkspaceRole(overview, isAdminBypass);
  if (alreadyLanded) {
    // Later arrivals: the member home — except a TL+ user who pinned
    // the Team view, whose home IS the team home.
    if (preference === 'team') {
      if (!overviewSettled) return <AccessResolving />;
      if (callerSeesTeam(overview)) return <RoleHomePage role={teamRole} />;
    }
    return <>{children}</>;
  }
  if (decision === TEAM_HOME_PATH) {
    return <RoleHomePage role={teamRole} />;
  }
  if (decision === DASHBOARD_HOME_PATH) {
    return <>{children}</>;
  }
  // Undecided (team overview still in flight) or decided-but-not-yet
  // committed: one neutral frame instead of a guessed page.
  return <AccessResolving />;
}
