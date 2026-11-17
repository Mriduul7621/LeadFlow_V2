import React, { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Banknote,
  FolderOpen,
  Layers,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { useAuthStore } from '../../auth/store/authStore';
import { dashboardService, type DashboardMetrics } from '../../dashboard/services/dashboardService';
import { leadService } from '../../leads/services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { markCriticalStartupSettled, waitForCriticalStartup } from '../../shared/api/startupPriority';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { loadTeamTree, treeRoots, type WorkspaceTreePerson } from '../services/teamTreeService';
import { summarizeTeamTotals, type TeamOverviewPerson } from '../../team/services/teamOverviewService';
import HomeViewSwitch from '../../team/components/HomeViewSwitch';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { isForbiddenError } from '../../shared/api/forbidden';
import {
  EmptyState,
  HomeSkeleton,
  KpiCard,
  MemberRow,
  PageHead,
  PipelineBar,
  WorkspaceCard,
} from '../components/WorkspacePrimitives';
import {
  countStalled,
  dhakaDayStartMs,
  money,
  resolvePipelineSegments,
  type PipelineSegment,
} from '../utils/workspaceData';

/**
 * ManagerHome — the "Business Overview" home (role-dashboard redesign, Phase 1)
 * ------------------------------------------------------------------
 * The manager / admin workspace at `/`: four KPIs, team comparison,
 * pipeline health, top performers, and business alerts. Every figure
 * is server-authoritative:
 *
 *   KPIs        Total / Converted from the scoped team overview
 *               (the same numbers the KPI drill-down shows);
 *               NCP from GET /api/dashboard (collected + projected);
 *               pipeline value = SUM(expected_premium) of open leads
 *               in scope, from the team tree's subtree rollups
 *   Team comp.  the tree roots with their subtree rollups
 *   Pipeline    GET /api/dashboard statusCounts (real statuses;
 *               terminal flags from the FollowUpStatus dictionary)
 *   Performers  GET /api/dashboard agentStats (top 5 by converted,
 *               then collected) — there is no server lead-source
 *               aggregation, so the sample's "Lead source
 *               performance" card is omitted, not faked
 *   Alerts      overdue + no-action counts from the overview, and
 *               stalled leads (> 14 days overdue) from the server
 *               follow-up queue — labelled as a floor when the
 *               queue read was truncated
 *
 * Currency is ৳ (BDT) everywhere. The KPI read (GET /api/dashboard)
 * is the session's critical startup request: it releases the startup
 * gate in `finally` (success or failure) and every deferred read
 * waits for it.
 */

export interface BusinessAlerts {
  overdue: number;
  noAction: number;
  stalled14: number;
  stalledTruncated: boolean;
  oldestOverdueDays: number | null;
}

export interface ManagerHomeContentProps {
  people: TeamOverviewPerson[];
  scope: string;
  metrics: DashboardMetrics | null;
  roots: WorkspaceTreePerson[];
  pipeline: PipelineSegment[];
  alerts: BusinessAlerts;
  /** The tree + queue reads are still pending — show skeletons, not empty states. */
  dailyLoading: boolean;
  onRefresh?: () => void;
}

export function ManagerHomeContent(props: ManagerHomeContentProps) {
  const { people, scope, metrics, roots } = props;
  const totals = summarizeTeamTotals(people);
  const pipelineValue = roots.reduce((sum, root) => sum + (Number(root.subtree?.pipelineValue) || 0), 0);
  const collected = metrics?.collected ?? 0;
  const projected = metrics?.projected ?? 0;
  const ncpPct = projected > 0 ? Math.round((collected / projected) * 100) : null;
  const performers = [...(metrics?.agentStats ?? [])]
    .sort((a, b) => b.converted - a.converted || b.collected - a.collected || a.name.localeCompare(b.name))
    .slice(0, 5);
  const { alerts } = props;
  const allClear = alerts.overdue === 0 && alerts.noAction === 0 && alerts.stalled14 === 0;

  return (
    <div className="space-y-6 text-left">
      <PageHead
        eyebrow="Business Overview"
        title="Business Overview"
        sub={`${people.length} people in scope${scope ? ` · ${scope} scope` : ''}`}
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
        <KpiCard label="Total Lead" value={totals.totalLeads} icon={Layers} to="/team/kpi/totalLeads" foot="All leads in scope" />
        <KpiCard label="Converted" value={totals.converted} icon={TrendingUp} tone="green" to="/team/kpi/converted" foot="Leads converted so far" />
        <KpiCard
          label="NCP progress"
          value={money(collected)}
          icon={Banknote}
          tone="orange"
          foot={ncpPct === null ? `Projected ${money(projected)}` : `Projected ${money(projected)} · ${ncpPct}% collected`}
        />
        <KpiCard label="Pipeline value" value={money(pipelineValue)} icon={FolderOpen} tone="blue" foot="Open pipeline across the organisation" />
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="Team comparison"
          sub="Top-level teams with their whole-team rollups"
          action={
            <Link to="/team" className="lf-card-link">
              Full team
            </Link>
          }
        >
          {props.dailyLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading team comparison">
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
            </div>
          ) : roots.length === 0 ? (
            <EmptyState>No teams in scope yet.</EmptyState>
          ) : (
            <div className="lf-list">
              {roots.map(root => (
                <Fragment key={root.userId}>
                  <MemberRow
                    name={root.name}
                    employeeId={root.employeeId}
                    designation={root.designation}
                    isSelf={root.isSelf}
                    to="/team"
                  >
                    <span className="lf-member-stats">
                      <span className="lf-member-stat">{root.subtree.people} people · {root.subtree.openLeads} open · {root.subtree.converted} converted</span>
                      <span className="lf-member-stat lf-member-stat--strong">{money(root.subtree.pipelineValue)}</span>
                    </span>
                  </MemberRow>
                </Fragment>
              ))}
            </div>
          )}
        </WorkspaceCard>

        <WorkspaceCard
          title="Pipeline health"
          sub="All leads in scope across the real sales stages"
          action={
            <Link to="/sales-pipeline" className="lf-card-link">
              Pipeline board
            </Link>
          }
        >
          <PipelineBar segments={props.pipeline} />
        </WorkspaceCard>
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="Top performers"
          sub="By converted leads, then collected NCP"
          action={
            <Link to="/execution-intelligence" className="lf-card-link">
              Performance
            </Link>
          }
        >
          {performers.length === 0 ? (
            <EmptyState>No agent activity yet.</EmptyState>
          ) : (
            <div className="lf-list">
              {performers.map((agent, index) => (
                <div key={`${agent.employeeId ?? agent.name}-${index}`} className="lf-list-row lf-list-row--static">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">{agent.name}</strong>
                    <span className="lf-list-sub">{[agent.employeeId, `${agent.assigned} assigned`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="lf-list-side">
                    <span className="lf-member-stat">{agent.converted} converted · {money(agent.collected)} collected</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </WorkspaceCard>

        <WorkspaceCard title="Business alerts" sub="Real counts from the live data — honestly labelled">
          {props.dailyLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading business alerts">
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
            </div>
          ) : allClear ? (
            <EmptyState>All clear — no overdue follow-ups, no at-risk leads, nothing stalled.</EmptyState>
          ) : (
            <div className="lf-list">
              {alerts.overdue > 0 && (
                <Link to="/team/kpi/overdue" className="lf-list-row">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">{alerts.overdue} overdue follow-ups</strong>
                    <span className="lf-list-sub">Across the organisation</span>
                  </span>
                  <span className="lf-pill lf-pill--red">Overdue</span>
                </Link>
              )}
              {alerts.noAction > 0 && (
                <Link to="/team/kpi/noAction" className="lf-list-row">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">{alerts.noAction} leads with no first action</strong>
                    <span className="lf-list-sub">No action within 48 hours of entry</span>
                  </span>
                  <span className="lf-pill lf-pill--red">At risk</span>
                </Link>
              )}
              {alerts.stalled14 > 0 && (
                <Link to="/team/kpi/overdue" className="lf-list-row">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">
                      {alerts.stalledTruncated ? `At least ${alerts.stalled14}` : alerts.stalled14} leads stalled over 14 days
                    </strong>
                    <span className="lf-list-sub">Follow-up more than 14 days overdue</span>
                  </span>
                  <span className="lf-pill lf-pill--red">Stalled</span>
                </Link>
              )}
              {alerts.oldestOverdueDays !== null && alerts.oldestOverdueDays > 0 && (
                <div className="lf-list-row lf-list-row--static">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">Oldest overdue follow-up is {alerts.oldestOverdueDays} days old</strong>
                    <span className="lf-list-sub">The most overdue lead in scope</span>
                  </span>
                  <span className="lf-pill lf-pill--orange">Oldest</span>
                </div>
              )}
            </div>
          )}
        </WorkspaceCard>
      </div>
    </div>
  );
}

export default function ManagerHome() {
  const { user } = useAuthStore();
  const callerTeam = useCallerTeam();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  const [dailyLoading, setDailyLoading] = useState(true);
  const [roots, setRoots] = useState<WorkspaceTreePerson[]>([]);
  const [pipelineOptions, setPipelineOptions] = useState<Array<{ value: string; label?: string; meta?: Record<string, any> }>>([]);
  // Stalled-alert facts from the overdue queue (the overdue / no-action
  // counts come from the overview totals at render time).
  const [stalled, setStalled] = useState<{ stalled14: number; stalledTruncated: boolean; oldestOverdueDays: number | null }>({
    stalled14: 0,
    stalledTruncated: false,
    oldestOverdueDays: null,
  });

  const loadDashboardData = useCallback(async () => {
    if (!user) {
      markCriticalStartupSettled();
      return;
    }
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      // Authoritative metrics from GET /api/dashboard (all time — the
      // manager home reads the full status counts, the NCP sums and
      // the agent stats from one response).
      const data = await dashboardService.getDashboard({ period: 'ALL' });
      setMetrics(data);
    } catch (err) {
      setMetrics(null);
      if (isForbiddenError(err)) {
        setForbidden(true);
      } else {
        setError('Dashboard data could not be loaded.');
      }
    } finally {
      setLoading(false);
      // STARTUP_CRITICAL = GET /api/dashboard — release Tier 2/3 waiters
      // whether the KPI read succeeded or failed so they cannot hang.
      markCriticalStartupSettled();
    }
  }, [user]);

  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setDailyLoading(true);
    try {
      // Tier 2/3 must not start until the critical KPI request has
      // settled — otherwise they share the mobile connection pool with
      // GET /api/dashboard (the 45–47 s client waits in production).
      await waitForCriticalStartup();

      // The tree (roots + rollups), the overdue queue (stalled alerts)
      // and the status dictionary (pipeline terminal flags) ride
      // together, after the critical request.
      const [tree, overdueRes, statusOptions] = await Promise.all([
        loadTeamTree(),
        leadService.getFollowUpQueue({ bucket: 'overdue', limit: 200 }),
        metadataService.getAllValues('FollowUpStatus'),
      ]);

      setRoots(treeRoots(tree));
      setPipelineOptions(statusOptions ?? []);
      const overdueItems = overdueRes.items ?? [];
      const first = overdueItems[0];
      const firstMs = first ? new Date(first.nextFollowUpAt).getTime() : NaN;
      setStalled({
        stalled14: countStalled(overdueItems, 14),
        stalledTruncated: (overdueRes.pagination?.total ?? 0) > overdueItems.length,
        oldestOverdueDays:
          Number.isNaN(firstMs) ? null : Math.max(0, Math.floor((dhakaDayStartMs(new Date()) - firstMs) / 86_400_000)),
      });
    } catch {
      setRoots([]);
      setPipelineOptions([]);
      setStalled({ stalled14: 0, stalledTruncated: false, oldestOverdueDays: null });
    } finally {
      setDailyLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    void loadDailyExecution();
  }, [loadDailyExecution]);

  const pipeline = resolvePipelineSegments(metrics?.statusCounts ?? {}, pipelineOptions);
  const overviewTotals = callerTeam.overview ? summarizeTeamTotals(callerTeam.overview.people) : null;
  const alerts: BusinessAlerts = {
    overdue: overviewTotals?.overdue ?? 0,
    noAction: overviewTotals?.noAction ?? 0,
    stalled14: stalled.stalled14,
    stalledTruncated: stalled.stalledTruncated,
    oldestOverdueDays: stalled.oldestOverdueDays,
  };

  const refreshAll = useCallback(() => {
    callerTeam.refresh();
    void loadDashboardData();
    void loadDailyExecution();
  }, [callerTeam, loadDashboardData, loadDailyExecution]);

  if (loading || callerTeam.loading) {
    return <HomeSkeleton label="Loading business overview" />;
  }

  if (callerTeam.error || !callerTeam.overview) {
    // The KPI cards read the overview totals — without them they would
    // show false 0s, so a failed overview is an error state, not an
    // empty home.
    return (
      <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3 text-left">
        <p className="text-sm text-red-600 font-bold">Failed to load the business overview.</p>
        <button
          type="button"
          onClick={() => callerTeam.refresh()}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {forbidden ? (
        <NoAccessYet
          module="the business overview"
          hint="The KPIs, the pipeline and the team comparison all read the dashboard endpoint."
        />
      ) : error && (
        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-[12px] px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-xs text-red-500 mt-0.5">Your saved data is unchanged. Please try again.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadDashboardData()}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-[10px]"
          >
            Retry
          </button>
        </div>
      )}

      {forbidden || error ? null : (
        <ManagerHomeContent
          people={callerTeam.overview.people}
          scope={callerTeam.overview.scope}
          metrics={metrics}
          roots={roots}
          pipeline={pipeline}
          alerts={alerts}
          dailyLoading={dailyLoading}
          onRefresh={refreshAll}
        />
      )}
    </div>
  );
}
