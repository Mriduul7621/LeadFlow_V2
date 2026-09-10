import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  Inbox,
  Clock,
  AlertTriangle,
  CheckCircle,
  TrendingUp,
  Banknote,
  Percent,
  Layers,
  Calendar as CalendarIcon,
  RefreshCw,
  ChevronRight,
  CalendarClock,
  ArrowRight,
  Info,
  History,
  Plus,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import TaskCalendar from '../../auth/pages/TaskCalendar';

/**
 * Dashboard (Step 5C) — role-aligned CRM / sales-execution workspace.
 * ------------------------------------------------------------------
 * Every KPI, pipeline and follow-up figure on this page binds ONLY to the
 * server-authoritative GET /api/dashboard response (PostgreSQL + Asia/Dhaka
 * + Own/DownTeam/FullTeam/Organization visibility). Client lead lists are
 * never used as a source for authoritative totals.
 *
 * The "Today & Tomorrow" panel is server-authoritative:
 *   - Follow-ups come from the server follow-up queue (GET /api/leads/follow-ups)
 *   - Calls & meetings come from the server scheduled_activities table
 *     (GET /api/scheduled-activities?from=&to=, Asia/Dhaka) — the calendar
 *     and this panel never fetch the full lead list.
 *
 * Intentionally deferred (see docs/DASHBOARD_UX_STEP5B.md, docs/SCHEDULED_ACTIVITIES.md):
 *  - real trend time-series endpoint
 *  - canonical team performance
 *  - advanced "needs attention" rules / lead scoring
 */

const DEFAULT_TODAY = new Date().toISOString().substring(0, 10);

const PERIODS = ['TODAY', 'THIS MONTH', 'LAST MONTH', 'CUSTOM', 'ALL'] as const;
type PeriodKey = (typeof PERIODS)[number];

/** Canonical pipeline stages from existing current_status values (Step 5). */
const PIPELINE_STAGES = [
  'Untouched',
  'Contacted',
  'Interested',
  'Meeting Fixed',
  'Meeting Completed',
  'Pipeline Locked',
  'Converted',
] as const;

const formatMoney = (n: number) => `৳ ${Number(n || 0).toLocaleString('en-US')}`;
const formatCount = (n: number) => Number(n || 0).toLocaleString('en-US');

/** Format a follow-up timestamp in the business timezone (Asia/Dhaka). */
function formatDhakaDue(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function toQueryPeriod(period: PeriodKey): string {
  if (period === 'THIS MONTH') return 'THIS_MONTH';
  if (period === 'LAST MONTH') return 'LAST_MONTH';
  if (period === 'CUSTOM') return 'CUSTOM';
  if (period === 'TODAY') return 'TODAY';
  return 'ALL';
}

/* ------------------------------------------------------------------ */
/*  Small presentational pieces                                        */
/* ------------------------------------------------------------------ */

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'danger' | 'success' | 'brand';
}

function KpiCard({ label, value, sub, icon: Icon, tone = 'default' }: KpiCardProps) {
  return (
    <div
      className={cn(
        'bg-white rounded-sm border p-5 shadow-sm flex flex-col justify-between min-h-[118px]',
        tone === 'danger' ? 'border-red-100 bg-red-50/30' : tone === 'success' ? 'border-emerald-100' : 'border-slate-100',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
        <Icon
          className={cn(
            'w-4 h-4',
            tone === 'danger' ? 'text-red-500' : tone === 'success' ? 'text-emerald-600' : tone === 'brand' ? 'text-[#978C21]' : 'text-slate-300',
          )}
        />
      </div>
      <div className="mt-3">
        <p
          className={cn(
            'text-2xl md:text-3xl font-black tracking-tight leading-none',
            tone === 'danger' ? 'text-red-600' : tone === 'success' ? 'text-emerald-700' : 'text-brand-text',
          )}
        >
          {value}
        </p>
        {sub && <p className="text-[10px] font-semibold text-slate-400 mt-2">{sub}</p>}
      </div>
    </div>
  );
}

function SectionHeading({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <h2 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700">{title}</h2>
        {desc && <p className="text-[11px] text-slate-400 mt-1">{desc}</p>}
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, note }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 bg-[#FBFAF8] border border-dashed border-slate-200 rounded-sm">
      <div className="w-11 h-11 rounded-sm bg-white border border-slate-100 flex items-center justify-center text-slate-300 mb-3">
        <Icon className="w-5 h-5" />
      </div>
      <p className="text-[11px] font-black uppercase tracking-widest text-slate-500">{title}</p>
      {note && <p className="text-[10px] text-slate-400 font-medium mt-2 max-w-sm leading-relaxed">{note}</p>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-sm border border-slate-100 p-5 shadow-sm min-h-[118px] animate-pulse">
      <div className="h-3 w-24 bg-slate-100 rounded mb-4" />
      <div className="h-7 w-20 bg-slate-100 rounded" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                          */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();

  // Lead-create capability (leads.create when the server permission exists,
  // otherwise the role featurePermissions/menuAccess fallback). Same check the
  // Add New Lead page itself enforces, so the button never out-runs the route.
  const canCreateLead = canAccess('lead_generate', 'create');

  const [period, setPeriod] = useState<PeriodKey>('TODAY');
  const [selectedDate, setSelectedDate] = useState<string>(DEFAULT_TODAY);
  const [customDates, setCustomDates] = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: DEFAULT_TODAY,
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  // Today/Tomorrow follow-ups + scheduled activities (informational only — see file header).
  // Sourced from server follow-up queue and server scheduled_activities, never from a full client lead list.
  const [todayFollowUps, setTodayFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [tomorrowFollowUps, setTomorrowFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [todayScheduled, setTodayScheduled] = useState<ScheduledActivity[]>([]);
  const [tomorrowScheduled, setTomorrowScheduled] = useState<ScheduledActivity[]>([]);
  const [dailyLoading, setDailyLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      // Authoritative metrics from GET /api/dashboard (server-side visibility + Asia/Dhaka).
      // KPI cards, pipeline and follow-up health bind only to this response.
      const metrics = await dashboardService.getDashboard({
        period: toQueryPeriod(period),
        selectedDate: period === 'TODAY' ? selectedDate : undefined,
        startDate: period === 'CUSTOM' ? customDates.start : undefined,
        endDate: period === 'CUSTOM' ? customDates.end : undefined,
      });
      setMetrics(metrics);
    } catch (err) {
      // Prefer an explicit error over silently presenting stale totals as current.
      setMetrics(null);
      setError('Dashboard synchronization failure. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, period, selectedDate, customDates]);

  /**
   * Daily Execution (Today & Tomorrow) — server-authoritative, performance-safe.
   *
   * Follow-ups use the server follow-up queue (GET /api/leads/follow-ups).
   * Calls & meetings use the server scheduled_activities calendar
   * (GET /api/scheduled-activities?from=&to=, Asia/Dhaka, visibility-enforced).
   * The panel never fetches the full lead list.
   */
  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setDailyLoading(true);
    try {
      // Dhaka calendar date for "today" (Asia/Dhaka is UTC+6, no DST).
      const dhakaToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
      const dhakaTodayDate = new Date(dhakaToday + 'T00:00:00.000Z');
      // Compute tomorrow's YMD in Dhaka by adding one UTC day to dhakaToday's UTC midnight minus 6h offset handling
      // Simpler: interpret dhakaToday as UTC-midnight and add 1 day, then re-format.
      const tomorrowYmd = (() => {
        const base = new Date(dhakaToday + 'T00:00:00.000Z');
        const next = new Date(base.getTime() + 86_400_000);
        return next.toISOString().slice(0, 10);
      })();

      const [todayRes, upcomingRes, scheduledRes] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
        scheduledActivityService.list({ from: dhakaToday, to: tomorrowYmd, limit: 100 }),
      ]);
      setTodayFollowUps(todayRes.items ?? []);
      // "Tomorrow" is the first Dhaka day inside the server's `upcoming` bucket.
      const tomorrowStartMs = new Date(upcomingRes.bounds.tomorrowStart).getTime();
      const tomorrowEndMs = tomorrowStartMs + 86_400_000;
      setTomorrowFollowUps(
        (upcomingRes.items ?? []).filter((item) => {
          const t = new Date(item.nextFollowUpAt).getTime();
          return t >= tomorrowStartMs && t < tomorrowEndMs;
        }),
      );

      // Split scheduled activities by Dhaka calendar date (Asia/Dhaka).
      const isDhakaDate = (iso: string, ymd: string): boolean => {
        try {
          const d = new Date(iso);
          const asYmd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
          return asYmd === ymd;
        } catch {
          return false;
        }
      };
      setTodayScheduled((scheduledRes ?? []).filter((a) => isDhakaDate(a.scheduledAt, dhakaToday)));
      setTomorrowScheduled((scheduledRes ?? []).filter((a) => isDhakaDate(a.scheduledAt, tomorrowYmd)));
    } catch {
      setTodayFollowUps([]);
      setTomorrowFollowUps([]);
      setTodayScheduled([]);
      setTomorrowScheduled([]);
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

  const formattedDateRange = () => {
    const now = new Date();
    if (period === 'TODAY') return new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (period === 'THIS MONTH') return `1 ${now.toLocaleDateString('en-GB', { month: 'short' })} - ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (period === 'LAST MONTH') {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
      return `${lastMonth.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${lastDay.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (period === 'CUSTOM') {
      return `${new Date(customDates.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${new Date(customDates.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return 'All time';
  };

  const statusCounts = metrics?.statusCounts ?? {};
  const followUpCounts = metrics?.followUpCounts ?? { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const totalLeads = metrics?.totalLeads ?? 0;

  const pipelineStages = PIPELINE_STAGES.map((stage) => {
    const count = Number(statusCounts[stage] || 0);
    const pct = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
    return { stage, count, pct };
  });

  const distribution = (metrics?.campaignStats ?? []).filter((row) => row && typeof row.name === 'string');
  const distributionMax = Math.max(1, ...distribution.map((row) => Number(row.value) || 0));

  const refreshAll = () => {
    void loadDashboardData();
    void loadDailyExecution();
  };

  return (
    <div className="space-y-6 pb-12 bg-white font-sans">
      {/* ============ A. Header / Controls ============ */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-[#F9F9F4] p-6 rounded-sm border border-slate-100 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight leading-none">Dashboard</h1>
          <p className="text-[11px] text-slate-500 mt-2 uppercase tracking-wider">
            Sales execution overview · server-authoritative · {metrics?.timezone || 'Asia/Dhaka'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-sm border border-slate-200">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded transition-all',
                  period === p ? 'bg-[#978C21] text-white shadow-sm' : 'text-slate-500 hover:text-slate-800',
                )}
              >
                {p}
              </button>
            ))}
          </div>

          {period === 'TODAY' && (
            <div className="flex items-center gap-2 bg-white p-1 rounded-sm border border-slate-200 shadow-sm">
              <span className="text-xs font-medium text-slate-500 pl-1.5">Date:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-white border border-slate-200 text-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[#978C21]/20"
              />
            </div>
          )}

          {period === 'CUSTOM' && (
            <div className="flex items-center gap-3 bg-white p-1 rounded-sm border border-slate-200 shadow-sm">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-slate-500 pl-1.5">Start:</span>
                <input
                  type="date"
                  value={customDates.start}
                  onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
                  className="bg-white border border-slate-200 text-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[#978C21]/20"
                />
              </div>
              <div className="flex items-center gap-1.5 border-l border-slate-100 pl-3">
                <span className="text-xs font-medium text-slate-500">End:</span>
                <input
                  type="date"
                  value={customDates.end}
                  onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
                  className="bg-white border border-slate-200 text-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-[#978C21]/20"
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#978C21]/5 border border-[#978C21]/10 rounded-sm">
            <CalendarIcon className="w-3.5 h-3.5 text-[#978C21]" />
            <span className="text-xs font-semibold text-[#978C21]">{formattedDateRange()}</span>
          </div>

          {canCreateLead && (
            <Link
              to="/leads/new"
              title="Add Lead"
              aria-label="Add Lead"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-sm bg-[#978C21] text-white text-xs font-semibold shadow-sm hover:bg-[#8a7f1e] focus:outline-none focus:ring-2 focus:ring-[#978C21]/40 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Add Lead</span>
            </Link>
          )}

          <button
            type="button"
            onClick={refreshAll}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-sm text-xs font-semibold text-slate-600 hover:text-[#978C21] hover:border-[#978C21]/40 transition-colors disabled:opacity-50"
            title="Refresh dashboard data"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-sm px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-xs text-red-500 mt-0.5">Could not load server metrics. Your data is unchanged.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadDashboardData()}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-sm"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        </div>
      ) : (
        <>
          {/* ============ B. Primary KPI row ============ */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <KpiCard label="Total Leads" value={formatCount(totalLeads)} icon={Users} />
            <KpiCard label="Untouched" value={formatCount(statusCounts.Untouched)} icon={Inbox} tone="brand" />
            <KpiCard label="Due Today" value={formatCount(followUpCounts.today)} icon={Clock} sub="follow-ups due" />
            <KpiCard label="Overdue" value={formatCount(followUpCounts.overdue)} icon={AlertTriangle} tone="danger" sub="follow-ups overdue" />
            <KpiCard label="Converted" value={formatCount(metrics?.converted ?? 0)} icon={CheckCircle} tone="success" />
          </div>

          {/* ============ C. Secondary KPI row ============ */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label="Projected NCP" value={formatMoney(metrics?.projected ?? 0)} icon={TrendingUp} tone="brand" />
            <KpiCard label="Collected NCP" value={formatMoney(metrics?.collected ?? 0)} icon={Banknote} tone="success" />
            <KpiCard label="Conversion Rate" value={metrics?.conversionRate || '0.0%'} icon={Percent} />
            <KpiCard label="Active Leads" value={formatCount(metrics?.activeLeads ?? 0)} icon={Layers} sub={`${formatCount(metrics?.pipelineLocked ?? 0)} pipeline locked`} />
          </div>

          {/* ============ D. Sales Pipeline ============ */}
          <section className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
            <SectionHeading
              title="Sales Pipeline"
              desc="Canonical lead stages from current_status values · server-authoritative statusCounts"
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {pipelineStages.map((s, i) => (
                <div key={s.stage} className="relative bg-[#FBFAF8] border border-slate-100 rounded-sm p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 truncate">{s.stage}</span>
                    {i < pipelineStages.length - 1 && (
                      <ChevronRight className="hidden lg:block w-3.5 h-3.5 text-slate-300 shrink-0" />
                    )}
                  </div>
                  <p className="text-2xl font-black text-brand-text mt-2 leading-none">{formatCount(s.count)}</p>
                  <div className="h-1.5 bg-slate-200 rounded-full mt-3 overflow-hidden">
                    <div className="h-full bg-[#978C21]" style={{ width: `${s.pct}%` }} />
                  </div>
                  <p className="text-[10px] font-semibold text-slate-400 mt-2">{s.pct}% of leads</p>
                </div>
              ))}
            </div>
          </section>

          {/* ============ E. Daily Execution ============ */}
          <section className="space-y-4">
            <SectionHeading
              title="Daily Execution"
              desc="Today & Tomorrow activity and the task calendar · follow-ups + scheduled_activities (server-authoritative, Asia/Dhaka)"
            />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              {/* LEFT: Today & Tomorrow */}
              <div className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
                <div className="flex items-center gap-2 mb-5">
                  <CalendarClock className="w-4 h-4 text-[#978C21]" />
                  <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-700">Today &amp; Tomorrow</h3>
                </div>

                {dailyLoading ? (
                  <div className="space-y-3">
                    <div className="h-12 bg-slate-100 rounded animate-pulse" />
                    <div className="h-12 bg-slate-100 rounded animate-pulse" />
                  </div>
                ) : (
                  <div className="space-y-6">
                    {[
                      { label: 'Today', followUps: todayFollowUps, scheduled: todayScheduled },
                      { label: 'Tomorrow', followUps: tomorrowFollowUps, scheduled: tomorrowScheduled },
                    ].map((group) => (
                      <div key={group.label}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{group.label}</p>
                          <span className="text-[10px] font-bold text-slate-400">{group.followUps.length + group.scheduled.length}</span>
                        </div>
                        {group.followUps.length === 0 && group.scheduled.length === 0 ? (
                          <div className="rounded-sm border border-dashed border-slate-200 px-4 py-4 text-[11px] text-slate-400">
                            No activities due {group.label.toLowerCase()}.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {group.followUps.slice(0, 6).map((item) => (
                              <Link
                                key={item.id}
                                to={`/leads/${encodeURIComponent(item.id)}`}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-sm border border-slate-100 hover:border-[#978C21]/40 hover:bg-white hover:shadow-sm transition-all group"
                              >
                                <div className="w-8 h-8 rounded-sm bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                                  <History className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#978C21]" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-slate-800 truncate">{item.prospectName || item.customerName}</p>
                                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">
                                    Follow-up · {formatDhakaDue(item.nextFollowUpAt)}
                                  </p>
                                </div>
                                <span className={cn('px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-wider border shrink-0', getLeadStatusColorClasses(item.currentStatus))}>
                                  {item.currentStatus}
                                </span>
                              </Link>
                            ))}
                            {group.scheduled.slice(0, 6).map((sa) => (
                              <Link
                                key={sa.id}
                                to={`/leads/${encodeURIComponent(sa.leadId)}`}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-sm border border-slate-100 hover:border-[#978C21]/40 hover:bg-white hover:shadow-sm transition-all group"
                              >
                                <div className={cn('w-8 h-8 rounded-sm border flex items-center justify-center shrink-0', sa.activityType === 'meeting' ? 'bg-amber-50 border-amber-100 text-amber-600' : sa.activityType === 'call' ? 'bg-sky-50 border-sky-100 text-sky-600' : sa.activityType === 'task' ? 'bg-purple-50 border-purple-100 text-purple-600' : 'bg-emerald-50 border-emerald-100 text-emerald-600')}>
                                  <CalendarIcon className="w-3.5 h-3.5" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-semibold text-slate-800 truncate">{sa.leadCustomerName || sa.title || 'Scheduled activity'}</p>
                                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">
                                    {sa.activityType === 'call' ? 'Call' : sa.activityType === 'meeting' ? 'Meeting' : sa.activityType === 'task' ? 'Task' : 'Follow-up'} · {formatDhakaDue(sa.scheduledAt)}
                                    {sa.title ? ` · ${sa.title}` : ''}
                                  </p>
                                </div>
                                <span className="px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-wider border shrink-0 bg-white border-slate-200 text-slate-500">
                                  {sa.activityType}
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="text-[10px] text-slate-400 border-t border-slate-100 pt-3">
                      Follow-ups from the server follow-up queue and calls/meetings/tasks from server <span className="font-semibold">scheduled_activities</span> (Asia/Dhaka, visibility-enforced) — no full lead-list fetch runs for this panel.
                    </p>
                  </div>
                )}
              </div>

              {/* RIGHT: Calendar */}
              <div className="bg-white rounded-sm border border-slate-100 shadow-sm p-6 overflow-hidden">
                <div className="flex items-center gap-2 mb-5">
                  <CalendarIcon className="w-4 h-4 text-[#978C21]" />
                  <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-700">Calendar</h3>
                </div>
                <TaskCalendar embedded={true} />
              </div>
            </div>
          </section>

          {/* ============ F. Follow-up Health ============ */}
          <section className="space-y-4">
            <SectionHeading title="Follow-up Health" desc="Authoritative follow-up counts from Step 4B / Step 5" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: 'Overdue', count: followUpCounts.overdue, bucket: 'overdue', tone: 'text-red-600 border-red-200 bg-red-50/40', icon: AlertTriangle },
                { label: 'Due Today', count: followUpCounts.today, bucket: 'today', tone: 'text-amber-600 border-amber-200 bg-amber-50/40', icon: Clock },
                { label: 'Upcoming', count: followUpCounts.upcoming, bucket: 'upcoming', tone: 'text-blue-600 border-blue-200 bg-blue-50/40', icon: CalendarClock },
              ].map((card) => (
                <Link
                  key={card.bucket}
                  to={`/follow-up?bucket=${card.bucket}`}
                  className={cn('rounded-sm border p-5 flex items-center justify-between group transition-all hover:shadow-sm', card.tone)}
                >
                  <div className="flex items-center gap-4">
                    <card.icon className="w-6 h-6" />
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest">{card.label}</p>
                      <p className="text-3xl font-black leading-none mt-1">{formatCount(card.count)}</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider opacity-70 group-hover:opacity-100">
                    Open <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                </Link>
              ))}
            </div>
            <div className="flex justify-end">
              <Link to="/follow-up" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
                <History className="w-3.5 h-3.5" /> Open full follow-up queue <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </section>

          {/* ============ G. Needs Attention ============ */}
          <section className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
            <SectionHeading
              title="Needs Attention"
              desc="Derived only from authoritative fields already available"
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Link
                to="/leads"
                className="rounded-sm border border-slate-100 p-5 hover:border-[#978C21]/40 hover:shadow-sm transition-all group flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-sm bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                    <Inbox className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Untouched leads</p>
                    <p className="text-[11px] text-slate-400">Leads with no engagement yet</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-brand-text">{formatCount(statusCounts.Untouched)}</p>
                  <span className="text-[10px] font-bold text-slate-400 group-hover:text-[#978C21]">Open lead tracking</span>
                </div>
              </Link>
              <Link
                to="/follow-up?bucket=overdue"
                className="rounded-sm border border-slate-100 p-5 hover:border-[#978C21]/40 hover:shadow-sm transition-all group flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-sm bg-red-50 border border-red-100 flex items-center justify-center text-red-500">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Overdue follow-ups</p>
                    <p className="text-[11px] text-slate-400">Follow-ups past their due date</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-red-600">{formatCount(followUpCounts.overdue)}</p>
                  <span className="text-[10px] font-bold text-slate-400 group-hover:text-[#978C21]">Open overdue queue</span>
                </div>
              </Link>
            </div>
            <p className="flex items-center gap-2 text-[11px] text-slate-400 mt-4 border-t border-slate-100 pt-4">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Additional attention rules coming in a later phase.
            </p>
          </section>

          {/* ============ H. Trend ============ */}
          <section className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
            <SectionHeading title="Trend" desc="Historical lead volume over time" />
            {(metrics?.trendData ?? []).length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title="No trend data available"
                note="Historical time-series is not published by the server yet. A real trend endpoint will replace this empty state in a later phase."
              />
            ) : (
              <div className="space-y-2">
                {(metrics?.trendData ?? []).map((point) => (
                  <div key={point.date} className="flex items-center justify-between border-b border-slate-50 py-1.5">
                    <span className="text-xs text-slate-500">{point.date}</span>
                    <span className="text-sm font-bold text-brand-text">{formatCount(point.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ============ I. Team Performance ============ */}
          <section className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
            <SectionHeading title="Team Performance" desc="Team-level execution metrics" />
            {(metrics?.teamStats ?? []).length === 0 ? (
              <EmptyState
                icon={Users}
                title="Team performance unavailable"
                note="Canonical team metrics are not published yet. Area text is not a team identity, so no team breakdown is shown until real team/hierarchy joins land."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#FBFAF8] text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-3">Team</th>
                      <th className="px-4 py-3 text-center">Assigned</th>
                      <th className="px-4 py-3 text-center">Collected</th>
                      <th className="px-4 py-3 text-center">Projected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(metrics?.teamStats ?? []).map((row) => (
                      <tr key={row.team}>
                        <td className="px-4 py-3 font-semibold text-slate-700">{row.team}</td>
                        <td className="px-4 py-3 text-center text-slate-500">{row.assigned}</td>
                        <td className="px-4 py-3 text-center text-slate-500">{row.collected}</td>
                        <td className="px-4 py-3 text-center text-slate-500">{row.projected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ============ J. Lead Status Distribution ============ */}
          <section className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
            <SectionHeading
              title="Lead Status Distribution"
              desc="Distribution of visible leads by current_status (server-authoritative)"
            />
            {distribution.length === 0 ? (
              <EmptyState icon={Layers} title="No status distribution available" />
            ) : (
              <div className="space-y-3">
                {distribution.map((row) => {
                  const value = Number(row.value) || 0;
                  const pct = totalLeads > 0 ? Math.round((value / totalLeads) * 100) : 0;
                  return (
                    <div key={row.name} className="flex items-center gap-4">
                      <span className="w-36 shrink-0 text-xs font-semibold text-slate-600 truncate">{row.name}</span>
                      <div className="flex-1 h-4 bg-slate-100 rounded-sm overflow-hidden">
                        <div
                          className="h-full rounded-sm"
                          style={{ width: `${Math.max(2, (value / distributionMax) * 100)}%`, backgroundColor: row.color || '#978C21' }}
                        />
                      </div>
                      <span className="w-20 shrink-0 text-right text-xs font-bold text-slate-500">{formatCount(value)}</span>
                      <span className="w-12 shrink-0 text-right text-[10px] font-semibold text-slate-400">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
