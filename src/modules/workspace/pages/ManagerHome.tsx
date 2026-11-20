import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useEnterpriseHomeData } from '../hooks/useEnterpriseHomeData';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { summarizeTeamTotals } from '../../team/services/teamOverviewService';
import { kpiDrilldownUrl } from '../../team/utils/kpiDrilldown';
import { EnterpriseErrorPanel } from '../components/EnterpriseErrorPanel';
import NoAccessYet from '../../shared/components/NoAccessYet';
import {
  formatPercent,
  largestOpenStatus,
  money,
} from '../utils/enterpriseData';
import {
  AttentionCard,
  ChartCard,
  DataTableCard,
  HomeSkeleton,
  KpiCard,
  OverviewHeading,
  type TableRow,
} from '../components/EnterprisePrimitives';

/**
 * ManagerHome — the Manager workspace overview (Enterprise Preview
 * redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample's Manager overview, rebuilt on real LeadFlow data.
 * KPI substitutions (the sample's numbers have no real source):
 *   "Target progress 62%"    -> Conversion (real dashboard rate)
 *   "NCP achievement ৳28.4L" -> Collected NCP (real dashboard total, ৳)
 *   "Active leads 1,284"     -> Managed leads (scoped overview total)
 *   "At-risk leads 46"       -> At-risk leads (overdue, scoped overview)
 * There is no targets data model in LeadFlow, so no target percent
 * is shown anywhere — the real conversion rate and the real
 * collected NCP stand in. The pipeline bottleneck comes from the
 * real status counts, with terminal statuses resolved from the
 * FollowUpStatus dictionary (DZ-6 flags), never hardcoded.
 */

export function ManagerHome() {
  const user = useAuthStore(state => state.user);
  const { canAccess } = usePermissions();
  const data = useEnterpriseHomeData();
  const { callerTeam, metrics, metricsLoading, metricsError, forbidden } = data;

  const totals = useMemo(
    () => (callerTeam.overview ? summarizeTeamTotals(callerTeam.overview.people) : null),
    [callerTeam.overview],
  );

  const bottleneck = useMemo(
    () => (metrics ? largestOpenStatus(metrics.statusCounts, data.statusOptions) : null),
    [metrics, data.statusOptions],
  );

  const tableRows = useMemo<TableRow[]>(() => {
    if (!metrics) return [];
    return [...(metrics.teamStats ?? [])]
      .sort((a, b) => b.assigned - a.assigned || a.team.localeCompare(b.team))
      .map(team => ({
        key: team.team,
        searchText: team.team,
        cells: [
          <Link key="team" className="ep-teamlink" to="/team">
            {team.team}
          </Link>,
          team.assigned,
          money(team.collected),
          team.followUps,
        ],
      }));
  }, [metrics]);

  if (callerTeam.loading || metricsLoading) return <HomeSkeleton label="Loading the Manager workspace" />;

  if (forbidden) return <NoAccessYet module="the workspace overview" />;

  if (callerTeam.error || !callerTeam.overview || !totals) {
    return (
      <EnterpriseErrorPanel
        title="This workspace could not be loaded"
        body="The team overview could not be loaded."
        onRetry={data.refresh}
      />
    );
  }

  const attentionRows = [
    {
      title: 'Overdue follow-ups',
      sub: `${totals.overdue} overdue across your teams`,
      actionLabel: 'Review queue',
      to: '/workbench',
      tone: totals.overdue > 0 ? ('red' as const) : ('' as const),
    },
    {
      title: 'No Action Alert',
      sub: `${totals.noAction} leads without a first action in 48h`,
      actionLabel: 'Open drill-down',
      to: kpiDrilldownUrl('noAction'),
      tone: totals.noAction > 0 ? ('red' as const) : ('' as const),
    },
    {
      title: bottleneck ? `Pipeline bottleneck · ${bottleneck.name}` : 'Pipeline bottleneck',
      sub: bottleneck
        ? `${bottleneck.count} open leads sit in ${bottleneck.name} — the largest open stage`
        : 'No open leads in the pipeline',
      actionLabel: 'Open pipeline',
      to: '/sales-pipeline',
      tone: bottleneck ? ('orange' as const) : ('' as const),
    },
    {
      title: 'Follow-ups due today',
      sub: `${totals.dueToday} due today across your teams`,
      actionLabel: 'Review queue',
      to: '/workbench',
      tone: totals.dueToday > 0 ? ('orange' as const) : ('' as const),
    },
  ];

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow="Manager workspace"
        title="Overview"
        sub={user ? `Welcome back, ${user.name}. Your teams, pipeline and progress at a glance.` : 'Your teams, pipeline and progress at a glance.'}
        actions={
          <Link className="ep-btn ep-btn-primary" to="/team">
            ＋ View workspace
          </Link>
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} Conversion and NCP figures are unavailable until it loads again.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="Managed leads"
          value={totals.totalLeads}
          foot={`${callerTeam.overview.people.length} people in scope`}
          to={kpiDrilldownUrl('totalLeads')}
        />
        <KpiCard
          label="Conversion"
          value={metrics ? formatPercent(metrics.conversionRateValue) : '–'}
          foot={metrics ? `${metrics.converted} of ${metrics.totalLeads} leads converted` : 'Waiting for dashboard data'}
        />
        <KpiCard
          label="Collected NCP"
          value={metrics ? money(metrics.collected) : '–'}
          foot={metrics ? `${money(metrics.projected)} projected` : 'Waiting for dashboard data'}
          to={canAccess('ncp_progress', 'view') ? '/ncp-progress' : undefined}
        />
        <KpiCard
          label="At-risk leads"
          value={totals.overdue}
          foot="Overdue follow-ups across your teams"
          tone={totals.overdue > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('overdue')}
        />
      </div>

      <div className="ep-layout2">
        <ChartCard
          title="Follow-ups due · next 7 days"
          sub="From the follow-up queue, grouped by Dhaka day"
          days={data.chartDays}
          loading={data.queueLoading}
          foot={data.chartTruncated ? 'Showing the first 50 due today and 50 upcoming — the queue holds more.' : undefined}
        />
        <AttentionCard
          title="Business attention needed"
          sub="Action list"
          rows={attentionRows}
          emptyText="Nothing needs attention right now."
        />
      </div>

      <DataTableCard
        title="Team performance"
        sub="Team breakdown from the dashboard"
        headers={['Team', 'Leads', 'Collected NCP', 'Follow-ups']}
        rows={tableRows}
        emptyText={metricsError ? 'Team performance could not be loaded.' : 'No team breakdown available for your scope.'}
        searchPlaceholder="Search by team name…"
      />
    </div>
  );
}
