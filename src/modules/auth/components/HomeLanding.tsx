import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { adminService } from '../../admin/services/adminService';
import { readSessionCache, writeSessionCache } from '../../shared/api/sessionCache';
import { ROLES_CACHE_CHANGED_EVENT } from '../../shared/utils/localCacheEvents';
import type { RolePermission } from '../../shared/types';
import {
  DASHBOARD_HOME_PATH,
  WORKBENCH_HOME_PATH,
  resolveHomePath,
} from '../../../layouts/featureRouteAccess';
import {
  TEAM_HOME_PATH,
  consumeHomeLanding,
  getHomeViewPreference,
  hasConsumedHomeLanding,
  resolveHomeLandingDecision,
  setHomeViewPreference,
} from '../services/homeLanding';
import {
  callerHasTeam,
  loadTeamOverview,
  readCachedTeamOverview,
  type TeamOverviewResponse,
} from '../../team/services/teamOverviewService';

const TeamHome = lazy(() => import('../../team/pages/TeamHome'));

/**
 * HomeLanding.tsx
 * ------------------------------------------------------------------
 * The root route's landing decision (Phase 2 — Workbench-first;
 * TL+ Home team-first since 2026-11-11).
 *
 * `/` is both the post-login destination (activateSession navigates
 * here, as it always has) and the sidebar Home item's target, i.e. the
 * Dashboard. Those two jobs conflict once a dedicated day-start page
 * exists, so this wrapper separates them by TIME, once per auth
 * session (see services/homeLanding.ts for the marker lifetime):
 *
 *   first arrival this session -> decide:
 *       caller HAS a team (UM-1: >= 1 report, from the scoped
 *         GET /api/team/overview payload — never a role label) and
 *         did not toggle to My work
 *                           -> render the team-first home (TeamHome)
 *       Workbench access    -> redirect to /workbench
 *       no Workbench access -> render the Dashboard (children)
 *   every later arrival     -> render the Dashboard (children), so
 *       Home stays fully reachable from navigation, unchanged — with
 *       ONE exception: a TL+ user whose session view preference is
 *       'team' keeps landing on the team home, because that is the
 *       home they chose (the Team/My-work switch flips it).
 *
 * Both inputs are loaded the way the rest of the shell loads them and
 * the decision waits for them to settle instead of guessing: the role
 * matrix EXACTLY like FeatureGate (same session cache key
 * `roles:<userId>`, same coalesced GET /api/roles, same roles-cache-
 * changed event), and the team overview through teamOverviewService
 * (same session-cache lifetime). When a fetch fails, the settled
 * decision falls back to the static model, mirroring FeatureGate's
 * failure semantics: a failed overview load simply means "no team
 * known", i.e. the member landing.
 *
 * Denied-route fallbacks stay safe: FeatureGate redirects denied pages
 * to `/`, where the (already consumed) landing renders the Dashboard —
 * no redirect loop is possible, because this component redirects only
 * on the session's first arrival and only to a route the same access
 * model just granted. The team home renders in place at `/`, under
 * this route's existing gate, so it adds no new route to protect.
 */

/** Identical matcher to FeatureGate's (role id, case-insensitive). */
function matchRole(roles: RolePermission[], user: { role?: string; id: string } | null): RolePermission | undefined {
  if (!user) return undefined;
  const role = String(user.role || '');
  const normalized = role.toUpperCase();
  return roles.find(rp => rp.roleId === role || rp.roleId === normalized);
}

/** Neutral, shell-preserving placeholder (same markup as FeatureGate's). */
function AccessResolving() {
  return (
    <div className="space-y-4" role="status" aria-label="Checking access">
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}

function TeamHomePage() {
  return (
    <Suspense fallback={<AccessResolving />}>
      <TeamHome />
    </Suspense>
  );
}

export default function HomeLanding({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  // The marker is read during render from the session cache: once the
  // decision has been consumed, Home is just the Dashboard again — no
  // role load, no placeholder, no redirect. The view preference is
  // read the same way (the Team/My-work switch writes it, then
  // navigates, so the next mount of this wrapper sees the new value).
  const alreadyLanded = userId ? hasConsumedHomeLanding(userId) : false;
  const preference = userId ? getHomeViewPreference(userId) : null;
  // Later arrivals only need the team overview when the user pinned
  // the Team view; the first arrival always needs it (TL+ default).
  const needsOverview = Boolean(userId) && (!alreadyLanded || preference === 'team');

  const [roles, setRoles] = useState<RolePermission[]>(() => {
    if (!userId || alreadyLanded) return [];
    return readSessionCache<RolePermission[]>(`roles:${userId}`)?.value ?? [];
  });
  const [settled, setSettled] = useState(() =>
    Boolean(!userId || alreadyLanded || readSessionCache<RolePermission[]>(`roles:${userId}`))
  );
  const [overview, setOverview] = useState<TeamOverviewResponse | null>(() =>
    userId ? readCachedTeamOverview(userId) : null
  );
  const [overviewSettled, setOverviewSettled] = useState<boolean>(() =>
    Boolean(!needsOverview || (userId && readCachedTeamOverview(userId)))
  );
  const [decision, setDecision] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || alreadyLanded) return;
    let cancelled = false;
    const cacheKey = `roles:${userId}`;

    const cached = readSessionCache<RolePermission[]>(cacheKey);
    if (cached) {
      setRoles(cached.value);
      // A cache hit is a real answer — no need to wait for the network.
      setSettled(true);
    }

    const load = async () => {
      try {
        const rp = await adminService.getRoles();
        if (cancelled) return;
        writeSessionCache(cacheKey, rp);
        setRoles(rp);
      } catch {
        // Network/5xx: keep whatever is on screen; once the attempt
        // settles, the static fallback decides, exactly as FeatureGate.
      } finally {
        if (!cancelled) setSettled(true);
      }
    };

    if (!cached) void load();
    window.addEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    };
  }, [userId, alreadyLanded]);

  useEffect(() => {
    if (!userId || !needsOverview || overviewSettled) return;
    let cancelled = false;
    loadTeamOverview(userId)
      .then(res => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {
        // A failed overview load settles as "no team known": the
        // member landing decides, exactly like the roles fallback.
      })
      .finally(() => {
        if (!cancelled) setOverviewSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, needsOverview, overviewSettled]);

  useEffect(() => {
    if (decision !== null || !settled || !overviewSettled || !user || !userId || alreadyLanded) return;
    const memberHome = resolveHomePath(user.role, matchRole(roles, user));
    const home = resolveHomeLandingDecision({
      hasTeam: callerHasTeam(overview?.people),
      preference: getHomeViewPreference(userId),
      memberHomePath: memberHome,
    });
    // A team decision also pins the session view preference to Team:
    // later arrivals at `/` then keep showing the team home until the
    // user actively switches to My work (which sets 'work').
    if (home === TEAM_HOME_PATH) setHomeViewPreference(userId, 'team');
    // Consume BEFORE navigating/rendering so any bounce back to `/`
    // (e.g. a FeatureGate denial elsewhere) renders the Dashboard
    // instead of deciding again.
    consumeHomeLanding(userId);
    setDecision(home);
  }, [decision, settled, overviewSettled, overview, roles, user, userId, alreadyLanded]);

  if (!user || !userId) {
    // No user cannot happen above ProtectedRoute; falling through to
    // the Dashboard keeps this wrapper invisible in that case.
    return <>{children}</>;
  }
  if (alreadyLanded) {
    // Later arrivals: the Dashboard — except a TL+ user who pinned
    // the Team view, whose home IS the team home.
    if (preference === 'team') {
      if (!overviewSettled) return <AccessResolving />;
      if (callerHasTeam(overview?.people)) return <TeamHomePage />;
    }
    return <>{children}</>;
  }
  if (decision === TEAM_HOME_PATH) {
    return <TeamHomePage />;
  }
  if (decision === WORKBENCH_HOME_PATH) {
    return <Navigate to={WORKBENCH_HOME_PATH} replace />;
  }
  if (decision === DASHBOARD_HOME_PATH) {
    return <>{children}</>;
  }
  // Undecided (role matrix / team overview still in flight) or
  // decided-but-not-yet committed: one neutral frame instead of a
  // guessed page.
  return <AccessResolving />;
}
