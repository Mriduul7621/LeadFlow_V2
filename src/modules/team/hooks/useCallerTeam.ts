import { useEffect, useState } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import {
  callerHasTeam,
  loadTeamOverview,
  readCachedTeamOverview,
  type TeamOverviewResponse,
} from '../services/teamOverviewService';

/**
 * useCallerTeam
 * ------------------------------------------------------------------
 * The caller's team overview + the derived UM-1 "has a team" fact,
 * for components that only need to know whether the caller leads a
 * team (the Daily Workbench's Team toggle) or want the payload
 * itself (the TL+ team home). Cache-first through
 * teamOverviewService: when HomeLanding already loaded the overview
 * for the landing decision this is a synchronous cache hit; the
 * network is touched at most once per session otherwise. A failed
 * load settles as `error` with hasTeam=false — callers fail back to
 * the member experience, never to a guessed team view.
 */
export interface CallerTeamState {
  loading: boolean;
  error: boolean;
  overview: TeamOverviewResponse | null;
  hasTeam: boolean;
  refresh: () => void;
}

export function useCallerTeam(): CallerTeamState {
  const userId = useAuthStore(state => state.user?.id);
  const [overview, setOverview] = useState<TeamOverviewResponse | null>(() =>
    userId ? readCachedTeamOverview(userId) : null
  );
  const [loading, setLoading] = useState<boolean>(() => Boolean(userId) && !overview);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!userId) {
      setOverview(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const cached = readCachedTeamOverview(userId);
    if (cached && reloadTick === 0) {
      setOverview(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    loadTeamOverview(userId, { force: reloadTick > 0 })
      .then(res => {
        if (cancelled) return;
        setOverview(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, reloadTick]);

  return {
    loading,
    error,
    overview,
    hasTeam: callerHasTeam(overview?.people),
    refresh: () => setReloadTick(t => t + 1),
  };
}
