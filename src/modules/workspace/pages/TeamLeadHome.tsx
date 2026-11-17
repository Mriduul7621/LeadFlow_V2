import React, { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BellRing,
  FolderOpen,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { leadService } from '../../leads/services/leadService';
import { markCriticalStartupSettled, waitForCriticalStartup } from '../../shared/api/startupPriority';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import {
  summarizeTeamTotals,
  type TeamOverviewPerson,
} from '../../team/services/teamOverviewService';
import HomeViewSwitch from '../../team/components/HomeViewSwitch';
import {
  BarChart,
  EmptyState,
  HomeSkeleton,
  KpiCard,
  MemberRow,
  PageHead,
  WorkspaceCard,
} from '../components/WorkspacePrimitives';
import {
  buildNext7Days,
  conversionShare,
  type DayBucket,
} from '../utils/workspaceData';

/**
 * TeamLeadHome — the "Team Overview" home (role-dashboard redesign, Phase 1)
 * ------------------------------------------------------------------
 * The team-lead workspace at `/`: four KPIs, member performance,
 * follow-up health, at-risk leads, and the team's activity chart.
 * Everything renders from the ONE scoped payload (GET
 * /api/team/overview via teamOverviewService) plus the server
 * follow-up queue for the chart (today + upcoming buckets — never a
 * bucket=all read). No parallel KPI queries: the overview IS the
 * source, the same data the My Team page shows. All four cards
 * always render — a 0 is shown, never hidden (never-empty rule).
 * No Action Alert is styled as an alert (red, like Overdue): leads
 * with no first action within 48 hours of entry.
 *
 * The overview is this home's critical read: the startup gate is
 * released when it settles (success or failure) and the chart read
 * waits for it.
 */

export interface TeamLeadHomeContentProps {
  people: TeamOverviewPerson[];
  scope: string;
  chartDays: DayBucket[];
  chartTruncated: boolean;
  chartLoading: boolean;
  onRefresh?: () => void;
}

export function TeamLeadHomeContent(props: TeamLeadHomeContentProps) {
  const { people, scope } = props;
  const totals = summarizeTeamTotals(people);
  const withOverdue = people.filter(p => p.overdue > 0).length;
  const performance = [...people]
    .sort((a, b) => b.convertedLeads - a.convertedLeads || b.openLeads - a.openLeads || a.name.localeCompare(b.name))
    .slice(0, 8);
  const atRisk = [...people]
    .filter(p => p.noActionLeads > 0)
    .sort((a, b) => b.noActionLeads - a.noActionLeads || a.name.localeCompare(b.name))
    .slice(0, 5);
  const healthMax = Math.max(1, totals.open, totals.dueToday, totals.overdue);

  return (
    <div className="space-y-6 text-left">
      <PageHead
        eyebrow="Team Overview"
        title="Team Overview"
        sub={`${people.length} people in your team${scope ? ` · ${scope} scope` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <HomeViewSwitch active="team" />
            {props.onRefresh && (
              <button
                type="button"
                onClick={props.onRefresh}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500 hover:border-[#978C21]/50"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            )}
          </div>
        }
      />

      <div className="lf-kpi-grid">
        <KpiCard label="Open leads" value={totals.open} icon={FolderOpen} to="/team/kpi/open" foot="Leads still in progress" />
        <KpiCard label="Overdue" value={totals.overdue} icon={AlertTriangle} tone="red" to="/team/kpi/overdue" foot="Follow-ups past their date" />
        <KpiCard label="No Action Alert" value={totals.noAction} icon={BellRing} tone="red" to="/team/kpi/noAction" foot="No first action within 48 hours" />
        <KpiCard label="Converted" value={totals.converted} icon={TrendingUp} tone="green" to="/team/kpi/converted" foot="Leads converted so far" />
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="Member performance"
          sub="Converted share per member — best first"
          action={
            <Link to="/team" className="lf-card-link">
              Full team
            </Link>
          }
          foot={people.length > performance.length ? `Showing ${performance.length} of ${people.length} members — the full team lives on the Team page.` : undefined}
        >
          {performance.length === 0 ? (
            <EmptyState>No team members in scope yet.</EmptyState>
          ) : (
            <div className="lf-list">
              {performance.map(person => {
                const share = conversionShare(person.convertedLeads, person.openLeads);
                return (
                  <Fragment key={person.userId}>
                    <MemberRow
                      name={person.name}
                      employeeId={person.employeeId}
                      designation={person.designation}
                      isSelf={person.isSelf}
                      to="/team"
                    >
                      <span className="lf-member-stats">
                        <span className="lf-progress" aria-label={`Converted share ${Math.round(share * 100)}%`}>
                          <span className="lf-progress-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                        </span>
                        <span className="lf-member-stat">{person.convertedLeads} converted · {person.openLeads} open</span>
                      </span>
                    </MemberRow>
                  </Fragment>
                );
              })}
            </div>
          )}
        </WorkspaceCard>

        <WorkspaceCard
          title="Follow-up health"
          sub="Open, due today and overdue across the team"
          action={
            <Link to="/workbench" className="lf-card-link">
              Open queue
            </Link>
          }
        >
          <div className="lf-health-bars">
            {([
              { label: 'Open leads', value: totals.open, tone: 'default' },
              { label: 'Due today', value: totals.dueToday, tone: 'orange' },
              { label: 'Overdue', value: totals.overdue, tone: 'red' },
            ] as const).map(row => (
              <div key={row.label} className="lf-health-row">
                <span className="lf-health-label">{row.label}</span>
                <span className="lf-progress lf-progress--wide">
                  <span
                    className={cn('lf-progress-fill', row.tone === 'orange' && 'is-orange', row.tone === 'red' && 'is-red')}
                    style={{ width: `${Math.round((row.value / healthMax) * 100)}%` }}
                  />
                </span>
                <span className="lf-health-value">{row.value}</span>
              </div>
            ))}
          </div>
          <p className="lf-card-foot">
            {withOverdue === 0
              ? 'Nobody has an overdue follow-up right now.'
              : `${withOverdue} of ${people.length} ${people.length === 1 ? 'person has' : 'people have'} overdue follow-ups.`}
          </p>
        </WorkspaceCard>
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="At-risk leads"
          sub="No first action within 48 hours of entry"
          action={
            <Link to="/team/kpi/noAction" className="lf-card-link">
              All at-risk
            </Link>
          }
        >
          {atRisk.length === 0 ? (
            <EmptyState>No at-risk leads — every lead had a first action within 48 hours.</EmptyState>
          ) : (
            <div className="lf-list">
              {atRisk.map(person => (
                <Fragment key={person.userId}>
                  <MemberRow
                    name={person.name}
                    employeeId={person.employeeId}
                    designation={person.designation}
                    isSelf={person.isSelf}
                    to={`/team/kpi/noAction?person=${person.employeeId}`}
                  >
                    <span className="lf-pill lf-pill--red">{person.noActionLeads} no action</span>
                  </MemberRow>
                </Fragment>
              ))}
            </div>
          )}
        </WorkspaceCard>

        <WorkspaceCard
          title="Team activity"
          sub="Follow-ups due · next 7 days, across the team"
          foot={props.chartTruncated ? 'Showing the first 100 follow-ups; the full queue lives on the Follow-up Queue page.' : undefined}
        >
          {props.chartLoading ? (
            <div className="h-[104px] bg-stone-100 rounded-[10px] animate-pulse" role="status" aria-label="Loading activity chart" />
          ) : (
            <BarChart days={props.chartDays} />
          )}
        </WorkspaceCard>
      </div>

      <p className="text-[11px] font-bold text-stone-400">
        Full team detail lives on{' '}
        <Link to="/team" className="text-[#978C21] hover:underline">
          My Team
        </Link>
        .
      </p>
    </div>
  );
}

export default function TeamLeadHome() {
  const { user } = useAuthStore();
  const { loading, error, overview, hasTeam, refresh } = useCallerTeam();

  const [chartDays, setChartDays] = useState<DayBucket[]>(() => buildNext7Days([]));
  const [chartTruncated, setChartTruncated] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);

  // The overview is this home's critical read: release the startup
  // gate when it settles (success or failure) so the shell waiters
  // (notifications, options) and the chart read can proceed.
  useEffect(() => {
    if (!loading) markCriticalStartupSettled();
  }, [loading]);

  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setChartLoading(true);
    try {
      // The chart read waits for the critical overview, like the
      // member home's queue reads wait for its KPI request.
      await waitForCriticalStartup();
      const [todayRes, upcomingRes] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
      ]);
      const todayItems = todayRes.items ?? [];
      const upcomingItems = upcomingRes.items ?? [];
      setChartDays(buildNext7Days([...todayItems, ...upcomingItems]));
      const fetched = todayItems.length + upcomingItems.length;
      const available = (todayRes.pagination?.total ?? 0) + (upcomingRes.pagination?.total ?? 0);
      setChartTruncated(available > fetched);
    } catch {
      setChartDays(buildNext7Days([]));
      setChartTruncated(false);
    } finally {
      setChartLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadDailyExecution();
  }, [loadDailyExecution]);

  if (loading) {
    return <HomeSkeleton label="Loading team overview" />;
  }

  if (error || !overview) {
    return (
      <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3 text-left">
        <p className="text-sm text-red-600 font-bold">Failed to load your team home.</p>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  if (!hasTeam) {
    // Defensive: HomeLanding only renders this for callers who see
    // a team, but the roster can change mid-session — fall back to
    // the switch and a plain explanation instead of an empty view.
    return (
      <div className="space-y-4 text-left">
        <div className="flex justify-end">
          <HomeViewSwitch active="team" />
        </div>
        <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center space-y-2">
          <p className="text-sm font-black text-stone-700">No team to show right now</p>
          <p className="text-xs text-stone-400">
            When people report to you — or your role can see the wider team — your day will start with their follow-ups here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TeamLeadHomeContent
      people={overview.people}
      scope={overview.scope}
      chartDays={chartDays}
      chartTruncated={chartTruncated}
      chartLoading={chartLoading}
      onRefresh={refresh}
    />
  );
}
