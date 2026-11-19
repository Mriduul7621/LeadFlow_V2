import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useEnterpriseHomeData } from '../hooks/useEnterpriseHomeData';
import { useAuthStore } from '../../auth/store/authStore';
import { summarizeTeamTotals } from '../../team/services/teamOverviewService';
import { kpiDrilldownUrl } from '../../team/utils/kpiDrilldown';
import { EnterpriseErrorPanel } from '../components/EnterpriseErrorPanel';
import NoAccessYet from '../../shared/components/NoAccessYet';
import {
  AttentionCard,
  ChartCard,
  DataTableCard,
  HomeSkeleton,
  KpiCard,
  OverviewHeading,
  PersonCell,
  type TableRow,
} from '../components/EnterprisePrimitives';

/**
 * TeamLeadHome — the Team Lead workspace overview (Enterprise
 * Preview redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample's Team Lead overview, rebuilt on real LeadFlow data.
 * KPI substitutions (the sample's numbers have no real source):
 *   "Team leads 342"         -> Team leads (scoped overview total)
 *   "Due today 28"           -> Due today (scoped overview)
 *   "Overdue 19"             -> Overdue (scoped overview)
 *   "Follow-up completion"   -> No Action Alert (scoped overview)
 * Follow-up completion has no real source (no completion-rate
 * metric exists), so the No Action Alert — the real 48h
 * first-action alert — stands in. Every KPI drills into the real
 * KPI drill-down; the workload table lists every member, never
 * blank (never-empty rule).
 */

const MAX_TABLE_ROWS = 8;

export function TeamLeadHome() {
  const user = useAuthStore(state => state.user);
  const data = useEnterpriseHomeData();
  const { callerTeam, metricsLoading, metricsError, forbidden } = data;

  const totals = useMemo(
    () => (callerTeam.overview ? summarizeTeamTotals(callerTeam.overview.people) : null),
    [callerTeam.overview],
  );

  const mostOverdue = useMemo(() => {
    if (!callerTeam.overview) return null;
    return [...callerTeam.overview.people]
      .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name))
      .at(0) ?? null;
  }, [callerTeam.overview]);

  const tableRows = useMemo<TableRow[]>(() => {
    if (!callerTeam.overview) return [];
    return [...callerTeam.overview.people]
      .sort((a, b) => b.totalLeads - a.totalLeads || a.name.localeCompare(b.name))
      .slice(0, MAX_TABLE_ROWS)
      .map(person => ({
        key: person.userId,
        searchText: `${person.name} ${person.employeeId}`,
        cells: [
          <PersonCell
            name={person.name}
            sub={person.employeeId}
            to={kpiDrilldownUrl('totalLeads', person.employeeId)}
          />,
          person.totalLeads,
          person.overdue,
          person.convertedLeads,
        ],
      }));
  }, [callerTeam.overview]);

  const peopleCount = callerTeam.overview?.people.length ?? 0;

  if (callerTeam.loading || metricsLoading) return <HomeSkeleton label="Loading the Team Lead workspace" />;

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
      sub: `${totals.overdue} overdue across your team`,
      actionLabel: 'Review queue',
      to: '/workbench',
      tone: totals.overdue > 0 ? ('red' as const) : ('' as const),
    },
    {
      title: mostOverdue ? `${mostOverdue.name} · most overdue` : 'Most overdue member',
      sub: mostOverdue
        ? `${mostOverdue.overdue} overdue follow-up${mostOverdue.overdue === 1 ? '' : 's'}`
        : 'No members in scope',
      actionLabel: 'Open team',
      to: '/team',
      tone: mostOverdue && mostOverdue.overdue > 0 ? ('orange' as const) : ('' as const),
    },
    {
      title: 'No Action Alert',
      sub: `${totals.noAction} leads without a first action in 48h`,
      actionLabel: 'Open drill-down',
      to: kpiDrilldownUrl('noAction'),
      tone: totals.noAction > 0 ? ('red' as const) : ('' as const),
    },
    {
      title: 'Follow-ups due today',
      sub: `${totals.dueToday} due today across your team`,
      actionLabel: 'Review queue',
      to: '/workbench',
      tone: totals.dueToday > 0 ? ('orange' as const) : ('' as const),
    },
  ];

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow="Team Lead workspace"
        title="Overview"
        sub={user ? `Welcome back, ${user.name}. Your team, queue and follow-ups at a glance.` : 'Your team, queue and follow-ups at a glance.'}
        actions={
          <Link className="ep-btn ep-btn-primary" to="/team">
            ＋ View workspace
          </Link>
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} The figures below come from the team overview and are unaffected.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="Team leads"
          value={totals.totalLeads}
          foot={`${peopleCount} people in scope`}
          to={kpiDrilldownUrl('totalLeads')}
        />
        <KpiCard
          label="Due today"
          value={totals.dueToday}
          foot="Follow-ups due today across your team"
          to={kpiDrilldownUrl('dueToday')}
        />
        <KpiCard
          label="Overdue"
          value={totals.overdue}
          foot="Follow-ups past their due date"
          tone={totals.overdue > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('overdue')}
        />
        <KpiCard
          label="No Action Alert"
          value={totals.noAction}
          foot="Leads without a first action in 48h"
          tone={totals.noAction > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('noAction')}
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
          title="Team attention needed"
          sub="Action list"
          rows={attentionRows}
          emptyText="Nothing needs attention right now."
        />
      </div>

      <DataTableCard
        title="Team workload"
        sub={peopleCount > MAX_TABLE_ROWS ? `Top ${MAX_TABLE_ROWS} of ${peopleCount} people by total leads` : 'Everyone in scope, by total leads'}
        headers={['Member', 'Leads', 'Overdue', 'Converted']}
        rows={tableRows}
        emptyText="No people in scope yet."
        searchPlaceholder="Search by name or employee ID…"
      />
    </div>
  );
}
