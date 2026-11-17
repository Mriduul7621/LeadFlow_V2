import React, { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  Layers,
  Plus,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import type { Lead } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { dashboardService, type DashboardMetrics } from '../../dashboard/services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { markCriticalStartupSettled, waitForCriticalStartup } from '../../shared/api/startupPriority';
import { localDb } from '../../../services/localDb';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { loadTeamTree, selfTreeRow } from '../services/teamTreeService';
import HomeViewSwitch from '../../team/components/HomeViewSwitch';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { isForbiddenError } from '../../shared/api/forbidden';
import {
  BarChart,
  EmptyState,
  FollowUpRow,
  HomeSkeleton,
  KpiCard,
  PageHead,
  PipelineBar,
  WorkspaceCard,
} from '../components/WorkspacePrimitives';
import {
  buildNext7Days,
  formatDhakaShort,
  greetingForHour,
  resolvePipelineSegments,
  type DayBucket,
  type PipelineSegment,
} from '../utils/workspaceData';

/**
 * MemberHome — the "My Work" home (role-dashboard redesign, Phase 1)
 * ------------------------------------------------------------------
 * The member workspace at `/`: greeting, four KPIs, priority
 * follow-ups, the pipeline, the week's follow-up chart, and recent
 * leads. Every figure is server-authoritative:
 *
 *   KPIs        the scoped team overview's own row (the same numbers
 *               the KPI drill-down shows — card and drill-down agree
 *               by construction) + converted-this-month from the
 *               team tree (converted_at, not created_at)
 *   Pipeline    GET /api/dashboard statusCounts (real statuses;
 *               terminal flags from the FollowUpStatus dictionary)
 *   Priority +  the server follow-up queue (overdue / today /
 *   chart       upcoming buckets — never a bucket=all read)
 *   Recent      the local mirror first, else one bounded read of 5
 *
 * The KPI read (GET /api/dashboard) is the session's critical
 * startup request: it releases the startup gate in `finally`
 * (success or failure) and every deferred read waits for it.
 * Scheduled work lives on the Task Calendar page, not here.
 */

function dhakaHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false }).format(now),
  );
}

function dhakaDateLine(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

export interface MemberHomeContentProps {
  userName: string;
  dateLine: string;
  greeting: string;
  assigned: number;
  dueToday: number;
  overdue: number;
  /** Converted this month; null while the tree read is still pending. */
  convertedThisMonth: number | null;
  priority: FollowUpQueueItem[];
  priorityTotal: number;
  dailyLoading: boolean;
  chartDays: DayBucket[];
  chartTruncated: boolean;
  pipeline: PipelineSegment[];
  recentLeads: Lead[];
  recentLeadsLoading: boolean;
  canCreateLead: boolean;
  hasTeam: boolean;
  onRefresh?: () => void;
}

export function MemberHomeContent(props: MemberHomeContentProps) {
  const firstName = props.userName.split(' ')[0] || props.userName;
  return (
    <div className="space-y-6 text-left">
      <PageHead
        eyebrow="My Work"
        title={`${props.greeting}, ${firstName}`}
        sub={`${props.dateLine} · ${props.dueToday} due today · ${props.overdue} overdue`}
        actions={
          <div className="flex items-center gap-2">
            {props.hasTeam && <HomeViewSwitch active="work" />}
            {props.canCreateLead && (
              <Link to="/leads/new" className="lf-primary-action" aria-label="Add Lead">
                <Plus size={16} /> Add Lead
              </Link>
            )}
            {props.onRefresh && (
              <button
                type="button"
                onClick={props.onRefresh}
                className="inline-flex items-center gap-2 px-3 py-2.5 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors bg-white"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            )}
          </div>
        }
      />

      <div className="lf-kpi-grid">
        <KpiCard label="Assigned leads" value={props.assigned} icon={Layers} to="/team/kpi/totalLeads" foot="All leads assigned to you" />
        <KpiCard label="Due today" value={props.dueToday} icon={CalendarClock} tone="orange" to="/team/kpi/dueToday" foot="Follow-ups due today" />
        <KpiCard label="Overdue" value={props.overdue} icon={AlertTriangle} tone="red" to="/team/kpi/overdue" foot="Follow-ups past their date" />
        <KpiCard
          label="Converted"
          value={props.convertedThisMonth === null ? '–' : props.convertedThisMonth}
          icon={TrendingUp}
          tone="green"
          foot="Converted this month"
        />
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="Priority follow-ups"
          sub="Overdue first, then today's — worst first"
          action={
            <Link to="/workbench" className="lf-card-link">
              Open queue
            </Link>
          }
          foot={props.priorityTotal > props.priority.length ? `Showing ${props.priority.length} of ${props.priorityTotal} follow-ups.` : undefined}
        >
          {props.dailyLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading follow-ups">
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
            </div>
          ) : props.priority.length === 0 ? (
            <EmptyState>Nothing due — no follow-ups are overdue or due today.</EmptyState>
          ) : (
            <div className="lf-list">
              {props.priority.map(item => (
                <Fragment key={item.id}>
                  <FollowUpRow item={item} />
                </Fragment>
              ))}
            </div>
          )}
        </WorkspaceCard>

        <WorkspaceCard
          title="My pipeline"
          sub="Your leads across the real sales stages"
          action={
            <Link to="/leads" className="lf-card-link">
              All my leads
            </Link>
          }
        >
          <PipelineBar segments={props.pipeline} />
        </WorkspaceCard>
      </div>

      <div className="lf-grid-2">
        <WorkspaceCard
          title="Follow-ups due · next 7 days"
          sub="From the follow-up queue, grouped by Dhaka day"
          foot={props.chartTruncated ? 'Showing the first 100 follow-ups; the full queue lives on the Follow-up Queue page.' : undefined}
        >
          {props.dailyLoading ? (
            <div className="h-[104px] bg-stone-100 rounded-[10px] animate-pulse" role="status" aria-label="Loading activity chart" />
          ) : (
            <BarChart days={props.chartDays} />
          )}
        </WorkspaceCard>

        <WorkspaceCard
          title="Recent leads"
          sub="The five most recently updated"
          action={
            <Link to="/leads" className="lf-card-link">
              All my leads
            </Link>
          }
        >
          {props.recentLeadsLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading recent leads">
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
              <div className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
            </div>
          ) : props.recentLeads.length === 0 ? (
            <EmptyState>
              No recent leads yet.
              {props.canCreateLead && (
                <>
                  {' '}
                  <Link to="/leads/new" className="lf-card-link">
                    Add your first lead
                  </Link>
                </>
              )}
            </EmptyState>
          ) : (
            <div className="lf-recent-list">
              {props.recentLeads.map(lead => (
                <Link key={lead.id} to={`/leads/${lead.id}`} className="lf-list-row">
                  <span className="lf-list-main">
                    <strong className="lf-list-name">{lead.prospectName || 'Unnamed lead'}</strong>
                    <span className="lf-list-sub">{lead.currentStatus || ''}</span>
                  </span>
                  <span className="lf-list-sub">{lead.nextFollowUpDate ? formatDhakaShort(lead.nextFollowUpDate) : ''}</span>
                </Link>
              ))}
            </div>
          )}
        </WorkspaceCard>
      </div>
    </div>
  );
}

export default function MemberHome() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const canCreateLead = canAccess('lead_generate', 'create');
  const callerTeam = useCallerTeam();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  const [dailyLoading, setDailyLoading] = useState(true);
  const [priority, setPriority] = useState<FollowUpQueueItem[]>([]);
  const [priorityTotal, setPriorityTotal] = useState(0);
  const [chartDays, setChartDays] = useState<DayBucket[]>(() => buildNext7Days([]));
  const [chartTruncated, setChartTruncated] = useState(false);
  const [convertedThisMonth, setConvertedThisMonth] = useState<number | null>(null);
  const [pipelineOptions, setPipelineOptions] = useState<Array<{ value: string; label?: string; meta?: Record<string, any> }>>([]);

  const [recentLeads, setRecentLeads] = useState<Lead[]>([]);
  const [recentLeadsLoading, setRecentLeadsLoading] = useState(true);

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
      // member home has no period filter; the pipeline reads the full
      // status counts and the KPI cards read the overview self row).
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

      // Three server-authoritative bucket reads (overdue / today /
      // upcoming, 50 each) — never one bucket=all read, which would
      // truncate. The tree read (converted-this-month) and the status
      // dictionary (pipeline terminal flags) ride along.
      const [overdueRes, todayRes, upcomingRes, tree, statusOptions] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'overdue', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
        loadTeamTree(),
        metadataService.getAllValues('FollowUpStatus'),
      ]);

      const overdueItems = overdueRes.items ?? [];
      const todayItems = todayRes.items ?? [];
      const upcomingItems = upcomingRes.items ?? [];
      // Priority: overdue first (the queue is already worst-first
      // within each bucket), then today's, capped at eight rows.
      setPriority([...overdueItems, ...todayItems].slice(0, 8));
      setPriorityTotal((overdueRes.counts?.overdue ?? 0) + (todayRes.counts?.today ?? 0));
      setChartDays(buildNext7Days([...todayItems, ...upcomingItems]));
      const fetched = todayItems.length + upcomingItems.length;
      const available = (todayRes.pagination?.total ?? 0) + (upcomingRes.pagination?.total ?? 0);
      setChartTruncated(available > fetched);
      setConvertedThisMonth(selfTreeRow(tree)?.convertedThisMonth ?? 0);
      setPipelineOptions(statusOptions ?? []);
    } catch {
      setPriority([]);
      setPriorityTotal(0);
      setChartDays(buildNext7Days([]));
      setChartTruncated(false);
      setConvertedThisMonth(0);
      setPipelineOptions([]);
    } finally {
      setDailyLoading(false);
    }
  }, [user]);

  /**
   * Recent Leads — the five most recent rows from the LOCAL MIRROR of server
   * data (`localDb`), which the lead screens refresh on every successful
   * read. Deliberately not a network call: this section must not add a
   * 5000-row request (or any request) to the first home paint. On a
   * first-ever visit the mirror is empty and the section shows its designed
   * empty state — it never claims data it does not have.
   */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const readMirror = () => {
      try {
        return localDb.getRecentLeads(5);
      } catch {
        return [] as Lead[];
      }
    };

    const mirrored = readMirror();
    if (mirrored.length > 0) {
      setRecentLeads(mirrored);
      setRecentLeadsLoading(false);
      return;
    }

    /**
     * First visit on this device: the mirror is still empty, so the section
     * would show "no leads yet" even though the account has leads. Fetch the
     * five newest rows ONCE — explicitly bounded (limit 5), issued only after
     * the critical startup has settled so it can never compete with the KPI
     * request, and never written into the mirror by this call (see
     * leadService.getRecentLeads). From the next load onward the mirror — or
     * this same bounded request — answers instantly.
     */
    const load = async () => {
      try {
        const newest = await leadService.getRecentLeads(5);
        if (!cancelled) setRecentLeads((newest || []).slice(0, 5));
      } catch {
        if (!cancelled) setRecentLeads([]);
      } finally {
        if (!cancelled) setRecentLeadsLoading(false);
      }
    };

    waitForCriticalStartup()
      .then(load)
      .catch(() => { void load(); });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    void loadDailyExecution();
  }, [loadDailyExecution]);

  const self = callerTeam.overview?.people.find(p => p.isSelf) ?? null;
  const assigned = self?.totalLeads ?? 0;
  const dueToday = self?.dueToday ?? 0;
  const overdue = self?.overdue ?? 0;
  // The pipeline reads the caller's own status counts from the
  // dashboard response; the dictionary flags mark the terminals.
  const pipeline = resolvePipelineSegments(metrics?.statusCounts ?? {}, pipelineOptions);
  const now = new Date();

  const refreshAll = useCallback(() => {
    callerTeam.refresh();
    void loadDashboardData();
    void loadDailyExecution();
  }, [callerTeam, loadDashboardData, loadDailyExecution]);

  if (loading || callerTeam.loading) {
    return <HomeSkeleton label="Loading your work" />;
  }

  if (callerTeam.error || !callerTeam.overview) {
    // The KPI cards read the overview self row — without it they would
    // show false 0s, so a failed overview is an error state, not an
    // empty home.
    return (
      <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3 text-left">
        <p className="text-sm text-red-600 font-bold">Failed to load your work.</p>
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
          module="your work"
          hint="The KPIs, the pipeline and the follow-up queue all read the dashboard endpoint."
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
        <MemberHomeContent
          userName={user?.name ?? ''}
          dateLine={dhakaDateLine(now)}
          greeting={greetingForHour(dhakaHour(now))}
          assigned={assigned}
          dueToday={dueToday}
          overdue={overdue}
          convertedThisMonth={convertedThisMonth}
          priority={priority}
          priorityTotal={priorityTotal}
          dailyLoading={dailyLoading}
          chartDays={chartDays}
          chartTruncated={chartTruncated}
          pipeline={pipeline}
          recentLeads={recentLeads}
          recentLeadsLoading={recentLeadsLoading}
          canCreateLead={canCreateLead}
          hasTeam={callerTeam.hasTeam}
          onRefresh={refreshAll}
        />
      )}
    </div>
  );
}
