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
 * AdminHome — the Admin workspace overview (Enterprise Preview
 * redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample's Admin overview, rebuilt on real LeadFlow data.
 * KPI substitutions (the sample's numbers have no real source):
 *   "Import success 98.4%"  -> Total leads (organisation-wide)
 *   "System health"         -> Active users (roster read)
 *   "Monthly target"        -> Converted (organisation-wide)
 *   "Open records"          -> Open leads (organisation-wide)
 * All four KPIs come from the scoped team overview (the admin's
 * scope is the whole organisation) plus the user roster. Nothing
 * here is invented, and no demo stage names appear.
 */

const MAX_TABLE_ROWS = 8;

export function AdminHome() {
  const user = useAuthStore(state => state.user);
  const data = useEnterpriseHomeData({ withUsers: true });
  const { callerTeam, metricsLoading, metricsError, forbidden } = data;

  const totals = useMemo(
    () => (callerTeam.overview ? summarizeTeamTotals(callerTeam.overview.people) : null),
    [callerTeam.overview],
  );

  const activeUsers = useMemo(
    () => (data.users ? data.users.filter(u => u.status === 'Active').length : null),
    [data.users],
  );

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

  if (callerTeam.loading || metricsLoading) return <HomeSkeleton label="Loading the Admin workspace" />;

  if (forbidden) return <NoAccessYet module="the workspace overview" />;

  if (callerTeam.error || !callerTeam.overview || !totals) {
    return (
      <EnterpriseErrorPanel
        title="This workspace could not be loaded"
        body="The organisation overview could not be loaded."
        onRetry={data.refresh}
      />
    );
  }

  const attentionRows = [
    {
      title: 'Overdue follow-ups',
      sub: `${totals.overdue} overdue across the organisation`,
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
      title: 'Follow-ups due today',
      sub: `${totals.dueToday} due today across the organisation`,
      actionLabel: 'Review queue',
      to: '/workbench',
      tone: totals.dueToday > 0 ? ('orange' as const) : ('' as const),
    },
    {
      title: 'Open leads',
      sub: `${totals.open} leads currently open`,
      actionLabel: 'Open leads',
      to: '/leads',
      tone: '' as const,
    },
  ];

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow="Admin workspace"
        title="Overview"
        sub={user ? `Welcome back, ${user.name}. This is the whole organisation at a glance.` : 'The whole organisation at a glance.'}
        actions={
          <Link className="ep-btn ep-btn-primary" to="/users">
            ＋ Add user
          </Link>
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} The figures below come from the organisation overview and are unaffected.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="Active users"
          value={activeUsers ?? '–'}
          foot={data.users ? `${data.users.length} user accounts in total` : 'Loading the roster…'}
          to="/users"
        />
        <KpiCard
          label="Total leads"
          value={totals.totalLeads}
          foot={`${peopleCount} people in scope`}
          to={kpiDrilldownUrl('totalLeads')}
        />
        <KpiCard
          label="Open leads"
          value={totals.open}
          foot={`${totals.dueToday} due today`}
          tone={totals.overdue > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('open')}
        />
        <KpiCard label="Converted" value={totals.converted} foot="Across the organisation" to={kpiDrilldownUrl('converted')} />
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
          title="Operational attention"
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
