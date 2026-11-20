import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { getSelfPerson } from '../../team/services/teamOverviewService';
import { groupLeadsByTl, teamLeadsForRole } from '../../workspace/utils/teamWorkspaceData';
import { agentPerformanceKpis } from '../../workspace/utils/agentWorkspaceData';
import { money } from '../../workspace/utils/enterpriseData';

/**
 * ExecutionIntelligence — Team Performance / My Performance
 * (Team Lead / Manager / Admin workspace rebuild, 2026-11-20).
 * ------------------------------------------------------------------
 * ALL roles now render the performance layout (AgentPerformance,
 * Mahadi's KPI set) on scope-driven leads — the Agent's own
 * leads, the TL's team leads, the Manager's downline, the
 * Admin's org-wide leads minus admin-assigned ones. The old
 * Analytics layout (KPI drill-down popups, leads-over-time area
 * chart, stage pie, NCP-by-area bars, rates card, the hardcoded
 * Gulshan/Banani/Dhanmondi/Uttara/Mirpur area table) was REMOVED
 * with this rebuild — no role renders it anymore, and keeping
 * ~600 lines of unreachable code would rot. It is restorable
 * from git (the pre-rebuild file) if Mahadi ever asks for it
 * back. Reported in the PR.
 *
 * Manager TL grouping (Mahadi: every list page groups by Team
 * Lead first): below the performance layout, Managers see a
 * TL-grouped member breakdown table — one row per Team Lead
 * with their leads, response %, converted and collected
 * figures. The table is ALL-TIME (the period dropdown lives
 * inside AgentPerformance, so the table cannot follow it) and
 * says so plainly. TL/Admin keep the Agent layout as-is; their
 * member breakdown lives on Team Members.
 */
export default function ExecutionIntelligence() {
  const { user } = useAuthStore();
  const { role } = useEnterpriseDisplayRole();
  const callerTeam = useCallerTeam();
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
      toast.error('Execution intelligence retrieval failure');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );
  const people = useMemo(() => callerTeam.overview?.people ?? [], [callerTeam.overview]);

  // Scope-driven leads (never widens): the Agent's list is
  // unchanged (server scope is own-only); TL/Manager/Admin
  // narrow via the Team Leads scope split.
  const scopedLeads = useMemo(() => {
    if (!self) return role === 'agent' ? leads : [];
    return teamLeadsForRole(leads, people, self, role);
  }, [leads, people, self, role]);

  const title = role === 'agent' ? 'My Performance' : 'Team Performance';
  const scopeNote = role === 'agent'
    ? 'all figures are your own scoped leads'
    : role === 'teamLead'
      ? 'all figures are your team\u2019s scoped leads'
      : role === 'manager'
        ? 'all figures are your downline\u2019s scoped leads'
        : 'all figures are the organisation\u2019s scoped leads (admins excluded)';

  // Manager TL-grouped breakdown (all-time — see the header note).
  const tlGroups = useMemo(() => {
    if (role !== 'manager' || !self) return [];
    return groupLeadsByTl(scopedLeads, people, self).map(group => ({
      tl: group.tl,
      leads: group.leads,
      kpis: agentPerformanceKpis(group.leads),
    }));
  }, [role, scopedLeads, people, self]);

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/execution-intelligence"
        actions={(
          <button
            type="button"
            onClick={loadData}
            className="ep-btn"
            aria-label="Refresh analytics"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            Refresh
          </button>
        )}
      />

      <AgentPerformance leads={scopedLeads} loading={loading || callerTeam.loading} title={title} scopeNote={scopeNote} />

      {role === 'manager' && (
        <div className="ep-card ep-tablecard" style={{ marginTop: 18 }}>
          <div className="ep-tablehead">
            <div>
              <h3>Performance by team lead</h3>
              <div className="ep-muted">All time · all scoped leads · click a team lead to see their members</div>
            </div>
          </div>
          <div className="ep-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Team Lead</th>
                  <th style={{ textAlign: 'center' }}>Leads</th>
                  <th style={{ textAlign: 'center' }}>Response</th>
                  <th style={{ textAlign: 'center' }}>Converted</th>
                  <th style={{ textAlign: 'center' }}>Collected Premium</th>
                </tr>
              </thead>
              <tbody>
                {tlGroups.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ep-td-empty">No team leads in scope yet</td>
                  </tr>
                ) : (
                  tlGroups.map(group => (
                    <tr key={group.tl.employeeId}>
                      <td>
                        <Link to={`/team?tl=${encodeURIComponent(group.tl.employeeId)}`} className="ep-viewall" style={{ fontSize: 13 }}>
                          <strong>{group.tl.name}</strong>
                        </Link>
                        <div className="ep-cellsub">{group.tl.employeeId}</div>
                      </td>
                      <td style={{ textAlign: 'center' }}>{group.kpis.assigned}</td>
                      <td style={{ textAlign: 'center' }}>{group.kpis.contactedRate}% ({group.kpis.contacted})</td>
                      <td style={{ textAlign: 'center' }}>{group.kpis.convertedRate}% ({group.kpis.converted})</td>
                      <td style={{ textAlign: 'center' }}><strong>{money(group.kpis.collectedPremium)}</strong></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
