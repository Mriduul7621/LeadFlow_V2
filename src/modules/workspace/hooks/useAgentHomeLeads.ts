import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { leadService } from '../../leads/services/leadService';
import type { Lead } from '../../shared/types';
import { waitForCriticalStartup } from '../../shared/api/startupPriority';

/**
 * useAgentHomeLeads — the Agent home's own lead list (Agent
 * workspace rebuild, 2026-11-20).
 * ------------------------------------------------------------------
 * The Recent leads strip and the Weekly activity chart need
 * lead-level data (timestamps, statusHistory) that neither the
 * dashboard metrics nor the queue buckets carry — so the Agent
 * home loads the caller's visible leads once, through the same
 * scoped read the lead pages use (the server enforces visibility;
 * nothing here can widen it).
 *
 * Deliberately NOT in useEnterpriseHomeData: that hook is shared
 * by all four homes and is pinned (by test) to never call
 * getLeads. This load waits for the critical startup gate (GET
 * /api/dashboard) so it never competes with the home's KPIs on a
 * slow connection.
 */
export interface AgentHomeLeads {
  leads: Lead[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

export function useAgentHomeLeads(): AgentHomeLeads {
  const user = useAuthStore(state => state.user);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const refresh = useCallback(() => setReloadTick(tick => tick + 1), []);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        await waitForCriticalStartup();
        const visible = await leadService.getLeads();
        if (cancelled) return;
        setLeads(visible ?? []);
      } catch {
        if (cancelled) return;
        setLeads([]);
        setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, reloadTick]);

  return { leads, loading, error, refresh };
}
