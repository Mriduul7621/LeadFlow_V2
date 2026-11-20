import React, { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead } from '../../shared/types';
import { leadService } from '../../leads/services/leadService';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { AgentPerformance } from '../components/AgentPerformance';
import BackButton from '../../shared/components/BackButton';

/**
 * SelfPerformance — Self Performance (Team Lead) / My
 * Performance (Manager) (2026-11-20, Mahadi).
 * ------------------------------------------------------------------
 * A SEPARATE sidebar page (his listing order implies a page —
 * flagged as an interpretation in the PR report): the Agent
 * performance layout on the caller's OWN leads only (assigned to
 * self). Team Lead and Manager only — every other role is
 * redirected to /execution-intelligence (the route gate cannot
 * express a display-role rule, so the page gates itself, only
 * once the display role has settled).
 */
export default function SelfPerformance() {
  const { user } = useAuthStore();
  const { role, loading: displayLoading } = useEnterpriseDisplayRole();
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({
        employeeId: user.employeeId,
        role: user.role,
      });
      setLeads(allLeads);
    } catch (err) {
      toast.error('Performance data retrieval failure');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const ownLeads = useMemo(() => {
    const selfId = String(user?.employeeId || '').toUpperCase();
    if (!selfId) return [];
    return leads.filter(lead => String(lead.assignedTo || '').toUpperCase() === selfId);
  }, [leads, user?.employeeId]);

  if (!displayLoading && role !== 'teamLead' && role !== 'manager') {
    return <Navigate to="/execution-intelligence" replace />;
  }

  const title = role === 'manager' ? 'My Performance' : 'Self Performance';

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/performance/self"
        actions={(
          <button
            type="button"
            onClick={loadData}
            className="ep-btn"
            aria-label="Refresh performance"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            Refresh
          </button>
        )}
      />

      <AgentPerformance
        leads={ownLeads}
        loading={loading || displayLoading}
        title={title}
        scopeNote="all figures are your own leads"
      />
    </div>
  );
}
