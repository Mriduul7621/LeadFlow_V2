import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { Lead } from '../../shared/types';
import {
  Users,
  AlertTriangle,
  History,
  TrendingUp,
  Banknote,
  Percent,
  Layers,
  Calendar as CalendarIcon,
  RefreshCw,
  ChevronRight,
  ArrowRight,
  Phone,
  Video,
  ClipboardCheck,
  CalendarDays,
  ChevronDown,
  Plus,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import { markCriticalStartupSettled, waitForCriticalStartup } from '../../shared/api/startupPriority';
import { localDb } from '../../../services/localDb';
import { roadshowService, type Roadshow } from '../../roadshows/services/roadshowService';

/** -------------------------------------------------------------
 * Dashboard — role-aligned CRM / sales-execution workspace.
 * Server-authoritative: every KPI, pipeline and follow-up figure binds
 * ONLY to GET /api/dashboard (PostgreSQL + Asia/Dhaka + visibility).
 * Client lead lists are never used as a source for authoritative totals.
 * ------------------------------------------------------------- */

// ---- Dhaka business time helpers ---------------------------------
function getDhakaNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
}
function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getDhakaTodayYmd(): string {
  return formatYmd(getDhakaNow());
}
function parseYmdToDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}
function formatShortRange(startYmd: string, endYmd: string): string {
  try {
    const s = parseYmdToDate(startYmd);
    const e = parseYmdToDate(endYmd);
    if (!s || !e) return `${startYmd} – ${endYmd}`;
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    const fmt = (d: Date) => d.toLocaleDateString('en-GB', opts);
    if (startYmd === endYmd) return fmt(s);
    if (s.getFullYear() !== e.getFullYear()) {
      const optsY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
      return `${s.toLocaleDateString('en-GB', optsY)} – ${e.toLocaleDateString('en-GB', optsY)}`;
    }
    return `${fmt(s)} – ${fmt(e)}`;
  } catch {
    return `${startYmd} – ${endYmd}`;
  }
}
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

// ---- Date filter: Today / WTD / MTD / LMTD / YTD / Custom / All ----
type PeriodKey = 'TODAY' | 'WTD' | 'MTD' | 'LMTD' | 'YTD' | 'CUSTOM' | 'ALL';

interface ResolvedRange {
  label: PeriodKey;
  startYmd: string | null;
  endYmd: string | null;
  display: string;
}

export function resolveRange(period: PeriodKey, customStart?: string, customEnd?: string): ResolvedRange {
  const dhakaNow = getDhakaNow();
  const y = dhakaNow.getFullYear();
  const m = dhakaNow.getMonth();
  const d = dhakaNow.getDate();
  const todayYmd = formatYmd(dhakaNow);

  if (period === 'TODAY') {
    return { label: period, startYmd: todayYmd, endYmd: todayYmd, display: formatShortRange(todayYmd, todayYmd) };
  }
  if (period === 'WTD') {
    const day = dhakaNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    const monday = new Date(dhakaNow);
    monday.setDate(d - daysSinceMonday);
    const startYmd = formatYmd(monday);
    return { label: period, startYmd, endYmd: todayYmd, display: formatShortRange(startYmd, todayYmd) };
  }
  if (period === 'MTD') {
    const startYmd = formatYmd(new Date(y, m, 1));
    return { label: period, startYmd, endYmd: todayYmd, display: formatShortRange(startYmd, todayYmd) };
  }
  if (period === 'LMTD') {
    const lastMonth = m === 0 ? 11 : m - 1;
    const lastYear = m === 0 ? y - 1 : y;
    const startYmd = formatYmd(new Date(lastYear, lastMonth, 1));
    const lastMonthDays = new Date(lastYear, lastMonth + 1, 0).getDate();
    const cappedDay = Math.min(d, lastMonthDays);
    const endYmd = formatYmd(new Date(lastYear, lastMonth, cappedDay));
    return { label: period, startYmd, endYmd, display: formatShortRange(startYmd, endYmd) };
  }
  if (period === 'YTD') {
    const startYmd = formatYmd(new Date(y, 0, 1));
    return { label: period, startYmd: startYmd, endYmd: todayYmd, display: formatShortRange(startYmd, todayYmd) };
  }
  if (period === 'CUSTOM') {
    const s = customStart && parseYmdToDate(customStart) ? customStart : formatYmd(new Date(y, m, 1));
    const e = customEnd && parseYmdToDate(customEnd) ? customEnd : todayYmd;
    return { label: period, startYmd: s, endYmd: e, display: formatShortRange(s, e) };
  }
  return { label: period, startYmd: null, endYmd: null, display: 'All time' };
}

const formatMoney = (n: number) => `৳ ${Number(n || 0).toLocaleString('en-US')}`;
const formatCount = (n: number) => Number(n || 0).toLocaleString('en-US');

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  variant?: 'default' | 'blue' | 'orange' | 'emerald' | 'red' | 'olive' | 'slate';
}

function KpiCard({ label, value, sub, icon: Icon, variant = 'default' }: KpiCardProps) {
  const variantClass: Record<string, string> = {
    default: 'kpi-card',
    blue: 'kpi-card kpi-card-blue',
    orange: 'kpi-card kpi-card-orange',
    emerald: 'kpi-card kpi-card-emerald',
    red: 'kpi-card kpi-card-red',
    olive: 'kpi-card kpi-card-olive',
    slate: 'kpi-card',
  };
  const iconClass: Record<string, string> = {
    default: 'icon-capsule icon-capsule-slate',
    blue: 'icon-capsule icon-capsule-blue',
    orange: 'icon-capsule icon-capsule-orange',
    emerald: 'icon-capsule icon-capsule-emerald',
    red: 'icon-capsule icon-capsule-red',
    olive: 'icon-capsule icon-capsule-olive',
    slate: 'icon-capsule icon-capsule-slate',
  };
  return (
    <div className={cn(variantClass[variant] || variantClass.default, 'group')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500">{label}</p>
        <div className={cn(iconClass[variant] || iconClass.default)}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="mt-4">
        <p className="text-2xl md:text-[28px] font-black tracking-tight leading-none text-brand-text">{value}</p>
        {sub && <p className="text-[11px] font-medium text-stone-400 mt-2">{sub}</p>}
      </div>
    </div>
  );
}

function SectionHeading({ title, desc, action }: { title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">{title}</h2>
        {desc && <p className="text-[12px] text-stone-500 mt-1.5 leading-relaxed">{desc}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-[12px] border border-stone-100 p-5 min-h-[118px] animate-pulse" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <div className="h-3 w-24 bg-stone-100 rounded mb-4" />
      <div className="h-7 w-20 bg-stone-100 rounded" />
    </div>
  );
}

// ---- Today & Tomorrow panel -----------------------------------------
const ACTIVITY_TYPES = ['call', 'meeting', 'follow_up', 'task'] as const;
const ACTIVITY_META = {
  call: { label: 'Call', summary: 'Calls', icon: Phone, tone: 'bg-sky-50 border-sky-200 text-sky-700' },
  meeting: { label: 'Meeting', summary: 'Meetings', icon: Video, tone: 'bg-amber-50 border-amber-200 text-amber-700' },
  follow_up: { label: 'Follow-up', summary: 'Follow-ups', icon: History, tone: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  task: { label: 'Task', summary: 'Tasks', icon: ClipboardCheck, tone: 'bg-purple-50 border-purple-200 text-purple-700' },
};

interface DailyActivity {
  key: string;
  leadId: string;
  activityType: ScheduledActivity['activityType'];
  scheduledAt: string;
  name: string;
  title?: string | null;
  leadStatus?: string | null;
}

function getDailyActivities(followUps: FollowUpQueueItem[], scheduled: ScheduledActivity[]): DailyActivity[] {
  const activities: DailyActivity[] = [
    ...followUps.map((item): DailyActivity => ({
      key: `follow-up:${item.id}`,
      leadId: item.id,
      activityType: 'follow_up',
      scheduledAt: item.nextFollowUpAt,
      name: item.prospectName || item.customerName || 'Follow-up',
      leadStatus: item.currentStatus,
    })),
    ...scheduled.map((item): DailyActivity => ({
      key: `scheduled:${item.id}`,
      leadId: item.leadId,
      activityType: item.activityType,
      scheduledAt: item.scheduledAt,
      name: item.leadCustomerName || item.title || ACTIVITY_META[item.activityType].label,
      title: item.title,
    })),
  ];

  // Exact IDs only, namespaced by source: queue IDs identify leads, whereas
  // scheduled_activities IDs identify independent planned activities. Neither
  // loaded contract supplies an item-level link between the two, so matching
  // lead IDs, names or due times cannot safely collapse cross-source follow-ups.
  const uniqueActivities = new Map(activities.map((item) => [item.key, item]));
  const time = (item: DailyActivity) => {
    const timestamp = new Date(item.scheduledAt).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  };
  return [...uniqueActivities.values()].sort((a, b) => time(a) - time(b));
}

export function TodayTomorrowPanel({ todayFollowUps, tomorrowFollowUps, todayScheduled, tomorrowScheduled, dailyLoading, roadshowCounts }: {
  todayFollowUps: FollowUpQueueItem[];
  tomorrowFollowUps: FollowUpQueueItem[];
  todayScheduled: ScheduledActivity[];
  tomorrowScheduled: ScheduledActivity[];
  dailyLoading: boolean;
  /**
   * Roadshow alerts for the two days. `null`/absent (no roadshow access, or
   * the read failed) hides the row entirely instead of claiming a false 0.
   */
  roadshowCounts?: { today: number; tomorrow: number } | null;
}) {
  const showRoadshows = !!roadshowCounts;
  const groups = [
    { label: 'Today', items: getDailyActivities(todayFollowUps, todayScheduled), roadshows: roadshowCounts?.today ?? 0 },
    { label: 'Tomorrow', items: getDailyActivities(tomorrowFollowUps, tomorrowScheduled), roadshows: roadshowCounts?.tomorrow ?? 0 },
  ];

  return (
    <section aria-busy={dailyLoading} className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading
        title="Today & Tomorrow"
        desc="Planned activities for today and tomorrow"
        action={
          <Link to="/task-calendar" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
            <CalendarIcon className="w-3.5 h-3.5" /> Open Calendar <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        }
      />

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-stone-400">{group.label}</h3>
              {!dailyLoading && (
                <span aria-label={`${group.items.length} activities`} className="text-[11px] font-bold text-stone-400 bg-stone-50 px-2 py-0.5 rounded-full border border-stone-100">
                  {formatCount(group.items.length)}
                </span>
              )}
            </div>
            {dailyLoading ? (
              <div role="status" aria-label={`Loading ${group.label.toLowerCase()} activities`} className="space-y-3 animate-pulse">
                <span className="sr-only">Loading {group.label.toLowerCase()} activities...</span>
                <div className="h-10 bg-stone-100 rounded-[10px]" aria-hidden="true" />
                <div className="h-16 bg-stone-100 rounded-[10px]" aria-hidden="true" />
                <div className="h-16 bg-stone-100 rounded-[10px]" aria-hidden="true" />
              </div>
            ) : (
              <>
                <dl
                  aria-label={`${group.label} activity counts`}
                  className={cn('grid gap-2 mb-3', showRoadshows ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4')}
                >
                  {ACTIVITY_TYPES.map((type) => (
                    <div key={type} className="flex items-center justify-between gap-2 rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-3 py-2">
                      <dt className="text-[11px] font-semibold text-stone-500">{ACTIVITY_META[type].summary}</dt>
                      <dd className="text-sm font-bold text-brand-text">{formatCount(group.items.filter((item) => item.activityType === type).length)}</dd>
                    </div>
                  ))}
                  {showRoadshows && (
                    <div className="flex items-center justify-between gap-2 rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-3 py-2" data-roadshow-count={group.roadshows}>
                      <dt className="text-[11px] font-semibold text-stone-500">Roadshows</dt>
                      <dd className="text-sm font-bold text-brand-text">{formatCount(group.roadshows)}</dd>
                    </div>
                  )}
                </dl>
                {group.items.length === 0 ? (
                  <div className="rounded-[12px] border border-dashed border-stone-200 px-4 py-6 text-[13px] text-stone-400 text-center bg-[#FFFCF8]">
                    {group.label === 'Today' ? 'No activities scheduled for today' : 'No activities scheduled for tomorrow'}
                  </div>
                ) : (
                  <ol aria-label={`${group.label} activities`} className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                    {group.items.map((item) => {
                      const { label, icon: Icon, tone } = ACTIVITY_META[item.activityType];
                      return (
                        <li key={item.key}>
                          <Link
                            to={`/leads/${encodeURIComponent(item.leadId)}`}
                            className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-stone-100 hover:border-[#978C21]/30 hover:bg-[#FFFCF8] hover:shadow-sm transition-all duration-150 group"
                          >
                            <div className={cn('w-9 h-9 rounded-[10px] border flex items-center justify-center shrink-0', tone)}>
                              <Icon className="w-4 h-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-stone-800 truncate">{item.name}</p>
                              <p className="text-[11px] text-stone-400">
                                {label} · {formatDhakaDue(item.scheduledAt)}
                                {item.title ? ` · ${item.title}` : ''}
                              </p>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1 max-w-[40%]">
                              <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', tone)}>
                                {label}
                              </span>
                              {item.leadStatus && (
                                <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', getLeadStatusColorClasses(item.leadStatus))}>
                                  {item.leadStatus}
                                </span>
                              )}
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

// ---- Executive Snapshot ---------------------------------------------
export function ExecutiveSnapshot({ totalLeads, conversionRate, collectedNCP, projectedNCP, activeLeads, pipelineLocked, overdueFollowUps }: {
  totalLeads: number;
  conversionRate: string;
  collectedNCP: string;
  projectedNCP: string;
  activeLeads: number;
  pipelineLocked: number;
  overdueFollowUps: number;
}) {
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="Total Leads" value={formatCount(totalLeads)} icon={Users} variant="blue" />
        <KpiCard label="Conversion Rate" value={conversionRate} icon={Percent} variant="slate" />
        <KpiCard label="Collected NCP" value={collectedNCP} icon={Banknote} variant="emerald" />
        <KpiCard label="Projected NCP" value={projectedNCP} icon={TrendingUp} variant="olive" />
        <KpiCard label="Active Leads" value={formatCount(activeLeads)} icon={Layers} variant="blue" sub={`${pipelineLocked} Pipeline Locked`} />
        {/* Overdue Follow-ups is a first-class KPI card (same design language as
            the rest of Core Performance) sitting beside Active Leads — it is no
            longer a red callout under the grid. */}
        <KpiCard label="Overdue Follow-ups" value={formatCount(overdueFollowUps)} icon={AlertTriangle} variant="red" sub="Due before today" />
      </div>
    </>
  );
}

// ---- Performance Insights -------------------------------------------
function PerformanceInsights({ trendData, teamStats }: { trendData: Array<{ date: string; value: number }> | undefined; teamStats: Array<{ team: string; assigned: number; collected: number; projected: number }> | undefined }) {
  return (
    <div className="space-y-4">
      {/* Trend section - compact unavailable state when no data */}
      {(trendData ?? []).length > 0 ? (
        <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <SectionHeading title="Trend" desc="Historical lead volume over time" />
          <div className="space-y-2">
            {(trendData ?? []).map((point) => (
              <div key={point.date} className="flex items-center justify-between border-b border-stone-50 py-2">
                <span className="text-xs text-stone-500">{point.date}</span>
                <span className="text-sm font-bold text-brand-text">{formatCount(point.value)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="text-center py-8">
          <AlertTriangle className="w-6 h-6 text-stone-300 mx-auto mb-3 opacity-50" />
          <p className="text-[12px] text-stone-500">No trend data available</p>
        </div>
      )}

      {/* Team Performance - compact or hidden */}
      {(teamStats ?? []).length > 0 ? (
        <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <SectionHeading title="Team Performance" desc="Team metrics for the selected period" />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#FFFCF8] text-[11px] font-black text-stone-500 uppercase tracking-widest border-b border-stone-100">
                <tr>
                  <th className="px-4 py-3">Team</th>
                  <th className="px-4 py-3 text-center">Assigned</th>
                  <th className="px-4 py-3 text-center">Collected NCP</th>
                  <th className="px-4 py-3 text-center">Projected NCP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-50">
                {(teamStats ?? []).map((row) => (
                  <tr key={row.team}>
                    <td className="px-4 py-3 font-semibold text-stone-700">{row.team}</td>
                    <td className="px-4 py-3 text-center text-stone-500">{formatCount(row.assigned)}</td>
                    <td className="px-4 py-3 text-center text-stone-500">{formatMoney(row.collected)}</td>
                    <td className="px-4 py-3 text-center text-stone-500">{formatMoney(row.projected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ============================================================
// Dashboard main component
// ============================================================
export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const canCreateLead = canAccess('lead_generate', 'create');
  // Roadshow alerts are only rendered for users who may open the roadshow
  // page at all — the same gate the workbench uses.
  const canViewRoadshows = canAccess('roadshow_follow_up', 'view');

  const [period, setPeriod] = useState<PeriodKey>('TODAY');
  const [customStart, setCustomStart] = useState<string>(() => {
    const now = getDhakaNow();
    return formatYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  const [customEnd, setCustomEnd] = useState<string>(() => getDhakaTodayYmd());
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);

  const resolved = useMemo(() => resolveRange(period, customStart, customEnd), [period, customStart, customEnd]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) setDateOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDateOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  const [todayFollowUps, setTodayFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [tomorrowFollowUps, setTomorrowFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [todayScheduled, setTodayScheduled] = useState<ScheduledActivity[]>([]);
  const [tomorrowScheduled, setTomorrowScheduled] = useState<ScheduledActivity[]>([]);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [roadshowCounts, setRoadshowCounts] = useState<{ today: number; tomorrow: number } | null>(null);
  const [recentLeads, setRecentLeads] = useState<Lead[]>([]);
  const [recentLeadsLoading, setRecentLeadsLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    if (!user) {
      markCriticalStartupSettled();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = resolveRange(period, customStart, customEnd);
      let query: { period: string; selectedDate?: string; startDate?: string; endDate?: string } = { period: 'ALL' };
      if (r.label === 'TODAY' && r.startYmd) {
        query = { period: 'TODAY', selectedDate: r.startYmd };
      } else if (r.label === 'ALL') {
        query = { period: 'ALL' };
      } else if (r.startYmd && r.endYmd) {
        query = { period: 'CUSTOM', startDate: r.startYmd, endDate: r.endYmd };
      }
      const data = await dashboardService.getDashboard(query);
      setMetrics(data);
    } catch {
      setMetrics(null);
      setError('Dashboard data could not be loaded.');
    } finally {
      setLoading(false);
      // STARTUP_CRITICAL = GET /api/dashboard — release Tier 2/3 waiters
      // whether the KPI read succeeded or failed so they cannot hang.
      markCriticalStartupSettled();
    }
  }, [user, period, customStart, customEnd]);

  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setDailyLoading(true);
    try {
      // Tier 2/3 must not start until the critical KPI request has
      // settled — otherwise they share the mobile connection pool with
      // GET /api/dashboard (the 45–47 s client waits in production).
      await waitForCriticalStartup();

      const dhakaToday = getDhakaTodayYmd();
      const tomorrowYmd = (() => {
        const base = parseYmdToDate(dhakaToday)!;
        const next = new Date(base);
        next.setDate(base.getDate() + 1);
        return formatYmd(next);
      })();

      // Today/Tomorrow cannot be derived from one bucket without changing
      // limits/semantics (bucket=all at limit 50 would truncate). Keep the
      // two server-authoritative reads, but start them only after KPIs.
      const [todayRes, upcomingRes] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
      ]);

      setTodayFollowUps(todayRes.items ?? []);
      const tomorrowStartMs = new Date(upcomingRes.bounds.tomorrowStart).getTime();
      const tomorrowEndMs = tomorrowStartMs + 86_400_000;
      setTomorrowFollowUps(
        (upcomingRes.items ?? []).filter((item) => {
          const t = new Date(item.nextFollowUpAt).getTime();
          return t >= tomorrowStartMs && t < tomorrowEndMs;
        }),
      );

      const isDhakaDate = (iso: string, ymd: string): boolean => {
        try {
          const d = new Date(iso);
          const asYmd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
          return asYmd === ymd;
        } catch {
          return false;
        }
      };

      // Tier 3 — scheduled activities and the (permission-gated) roadshow
      // alerts start together only after the follow-ups settled, so they can
      // never join the first-login connection burst.
      const [scheduledRes, roadshowRes] = await Promise.all([
        scheduledActivityService.list({ from: dhakaToday, to: tomorrowYmd, limit: 100 }),
        canViewRoadshows
          ? roadshowService.list({ from: dhakaToday, to: tomorrowYmd, mine: true })
          : Promise.resolve([] as Roadshow[]),
      ]);

      setTodayScheduled((scheduledRes ?? []).filter((a) => isDhakaDate(a.scheduledAt, dhakaToday)));
      setTomorrowScheduled((scheduledRes ?? []).filter((a) => isDhakaDate(a.scheduledAt, tomorrowYmd)));

      if (canViewRoadshows) {
        // Same rule as the workbench: only open roadshows are alerts.
        const open = (roadshowRes ?? []).filter((item) => item.status === 'pending' || item.status === 'reschedule');
        setRoadshowCounts({
          today: open.filter((item) => isDhakaDate(item.scheduledAt, dhakaToday)).length,
          tomorrow: open.filter((item) => isDhakaDate(item.scheduledAt, tomorrowYmd)).length,
        });
      } else {
        setRoadshowCounts(null);
      }
    } catch {
      setTodayFollowUps([]);
      setTomorrowFollowUps([]);
      setTodayScheduled([]);
      setTomorrowScheduled([]);
      // Never show a fabricated 0 when the read failed.
      setRoadshowCounts(null);
    } finally {
      setDailyLoading(false);
    }
  }, [user, canViewRoadshows]);

  /**
   * Recent Leads — the five most recent rows from the LOCAL MIRROR of server
   * data (`localDb`), which the lead screens refresh on every successful
   * read. Deliberately not a network call: this section must not add a
   * 5000-row request (or any request) to the first dashboard paint. On a
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

    const followUpCounts = metrics?.followUpCounts ?? { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const totalLeads = metrics?.totalLeads ?? 0;

  // The embedded Task Calendar is only mounted (chunk fetch + its own
  // scheduled-activities request) after the primary content has settled,
  // so the KPI area never waits on it.

  const refreshAll = () => {
    void loadDashboardData();
    void loadDailyExecution();
  };

  const periodMeta: Record<PeriodKey, { label: string; tooltip: string }> = {
    TODAY: { label: 'Today', tooltip: 'Today' },
    WTD: { label: 'WTD', tooltip: 'Week to date' },
    MTD: { label: 'MTD', tooltip: 'Month to date' },
    LMTD: { label: 'LMTD', tooltip: 'Last month to date (same elapsed days)' },
    YTD: { label: 'YTD', tooltip: 'Year to date' },
    CUSTOM: { label: 'Custom', tooltip: 'Custom range' },
    ALL: { label: 'All Time', tooltip: 'All Time' },
  };

  const collapsedLabel = useMemo(() => {
    const meta = periodMeta[period] || periodMeta.TODAY;
    if (period === 'ALL') return `Date Range: ${meta.label}`;
    if (period === 'CUSTOM') return `Date Range: ${meta.label} · ${resolved.display}`;
    return `Date Range: ${meta.label} · ${resolved.display}`;
  }, [period, resolved.display]);

  return (
    <div className="space-y-6 pb-12 font-sans">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-white p-6 rounded-[12px] border border-stone-100" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div>
          <h1 className="text-2xl font-black tracking-tight leading-none text-brand-text">Hello, {user?.name?.trim().split(/\s+/)[0] || 'there'}</h1>
          <p className="text-[13px] text-stone-500 mt-2 leading-relaxed">Sales performance and daily execution overview</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative" ref={dateRef}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={dateOpen}
              aria-label={collapsedLabel}
              onClick={() => setDateOpen((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm font-semibold text-brand-text hover:bg-white hover:border-stone-300 transition-all duration-150 shadow-sm min-w-[260px] justify-between"
              title={collapsedLabel}
            >
              <span className="flex items-center gap-2 truncate">
                <CalendarDays className="w-4 h-4 text-[#978C21] shrink-0" />
                <span className="truncate">{collapsedLabel}</span>
              </span>
              <ChevronDown className={cn('w-4 h-4 text-stone-400 transition-transform duration-150 shrink-0', dateOpen && 'rotate-180')} />
            </button>

            {dateOpen && (
              <div
                role="dialog"
                aria-label="Date Range"
                className="absolute right-0 mt-2 w-[360px] max-w-[92vw] bg-white border border-stone-200 rounded-[12px] shadow-xl z-40 overflow-hidden animate-slideDown"
                style={{ boxShadow: '0 12px 32px rgba(0,0,0,0.12)' }}
              >
                <div className="p-4">
                  <p className="text-[11px] font-black uppercase tracking-widest text-stone-400 mb-3">Date Range</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(['TODAY', 'WTD', 'MTD', 'LMTD', 'YTD', 'CUSTOM'] as PeriodKey[]).map((p) => {
                      const meta = periodMeta[p];
                      const active = period === p;
                      return (
                        <button
                          key={p}
                          type="button"
                          title={meta.tooltip}
                          aria-label={`${meta.label} — ${meta.tooltip}`}
                          onClick={() => {
                            setPeriod(p);
                            if (p !== 'CUSTOM') setDateOpen(false);
                          }}
                          className={cn(
                            'px-3 py-2.5 rounded-[10px] text-xs font-bold border transition-all duration-150',
                            active
                              ? 'bg-[#978C21] text-white border-[#978C21] shadow-sm'
                              : 'bg-[#FFFCF8] text-stone-600 border-stone-200 hover:bg-white hover:border-stone-300',
                          )}
                        >
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>

                  {period === 'CUSTOM' && (
                    <div className="mt-4 pt-4 border-t border-stone-100 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="space-y-1.5">
                          <span className="text-[11px] font-semibold text-stone-500">Start Date</span>
                          <input
                            type="date"
                            value={customStart}
                            onChange={(e) => setCustomStart(e.target.value)}
                            className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3]"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] font-semibold text-stone-500">End Date</span>
                          <input
                            type="date"
                            value={customEnd}
                            onChange={(e) => setCustomEnd(e.target.value)}
                            className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3]"
                          />
                        </label>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-stone-500 truncate">{resolved.display}</span>
                        <button
                          type="button"
                          onClick={() => setDateOpen(false)}
                          className="px-4 py-2 bg-[#978C21] text-white rounded-[10px] text-xs font-bold hover:bg-[#8a7f1e] transition-colors"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        setPeriod('ALL');
                        setDateOpen(false);
                      }}
                      className={cn(
                        'text-xs font-semibold hover:underline',
                        period === 'ALL' ? 'text-[#978C21]' : 'text-stone-500',
                      )}
                    >
                      All Time
                    </button>
                    <span className="text-[11px] text-stone-400">{resolved.display}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {canCreateLead && (
            <Link
              to="/leads/new"
              title="Add Lead"
              aria-label="Add Lead"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-[10px] bg-[#978C21] text-white text-xs font-bold shadow-sm hover:bg-[#8a7f1e] focus:outline-none focus:ring-2 focus:ring-[#978C21]/30 transition-all duration-150"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Add Lead</span>
            </Link>
          )}

          <button
            type="button"
            onClick={refreshAll}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2.5 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors disabled:opacity-50 bg-white"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {error && (
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

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        </div>
      ) : (
        <>

          <section className="lf-dashboard-kpis">
            <div className="lf-section-title">
              <div><h2>Core Performance</h2></div>
              <span className="lf-period-chip">{resolved.display}</span>
            </div>
            <ExecutiveSnapshot
              totalLeads={totalLeads}
              conversionRate={metrics?.conversionRate || '0.0%'}
              collectedNCP={formatMoney(metrics?.collected ?? 0)}
              projectedNCP={formatMoney(metrics?.projected ?? 0)}
              activeLeads={metrics?.activeLeads ?? 0}
              pipelineLocked={metrics?.pipelineLocked ?? 0}
              overdueFollowUps={followUpCounts.overdue}
            />
          </section>

          <section className="lf-mobile-day-snapshot" aria-busy={dailyLoading}>
            <div className="lf-section-title">
              <div>
                <h2>Today's Focus</h2>
                <p className="lf-section-subtitle">Your next steps, at a glance</p>
              </div>
              <Link to="/workbench" className="lf-view-all">My Work <ChevronRight size={16} /></Link>
            </div>
            {/* Server-authoritative Today/Tomorrow panel: overdue/today/
                upcoming COUNTS come from GET /api/dashboard, while the two
                lists come from the follow-up queue (bucket=today) and the
                2-day scheduled-activity window. Skeletons (aria-busy) stay
                until both settle — never a false zero. */}
            <TodayTomorrowPanel
              todayFollowUps={todayFollowUps}
              tomorrowFollowUps={tomorrowFollowUps}
              todayScheduled={todayScheduled}
              tomorrowScheduled={tomorrowScheduled}
              dailyLoading={dailyLoading}
              roadshowCounts={roadshowCounts}
            />
          </section>

          <section className="lf-recent-leads">
            <div className="lf-section-title">
              <div><h2>Recent Leads</h2><p className="lf-section-subtitle">Your five most recently added leads</p></div>
              <Link to="/leads" className="lf-view-all">View all <ChevronRight size={16} /></Link>
            </div>
            {recentLeadsLoading ? (
              <div className="lf-recent-empty">Loading recent leads…</div>
            ) : recentLeads.length === 0 ? (
              <div className="lf-recent-empty">
                <Users size={26} />
                <strong>No recent leads yet</strong>
                <span>Newly added leads will appear here.</span>
                {canCreateLead && <Link to="/leads/new" className="lf-primary-action"><Plus size={16} /> Add your first lead</Link>}
              </div>
            ) : (
              <div className="lf-recent-list">
                {recentLeads.map((lead) => (
                  <Link to={`/leads/${lead.id}`} key={lead.id} className="lf-recent-row">
                    <div className="lf-lead-avatar">{(lead.prospectName || lead.customerName || 'L').trim().charAt(0).toUpperCase()}</div>
                    <div className="lf-lead-main">
                      <strong>{lead.prospectName || lead.customerName || 'Unnamed lead'}</strong>
                      <span>{lead.mobile || 'No phone number'}{lead.area ? ` · ${lead.area}` : ''}</span>
                    </div>
                    <div className="lf-lead-meta">
                      <span className="lf-status-pill">{lead.status || 'New'}</span>
                      <small>{lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—'}</small>
                    </div>
                    <ChevronRight className="lf-row-chevron" size={17} />
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Remaining analysis — the same GET /api/dashboard payload that
              already loaded (trendData, teamStats). Sales Pipeline, Follow-up
              Discipline, Needs Attention and the Task Calendar moved off Home:
              the pipeline board is its own sidebar page (/sales-pipeline) and
              the calendar lives at /task-calendar (sidebar → Workspace). */}
          <PerformanceInsights trendData={metrics?.trendData} teamStats={metrics?.teamStats} />

        </>
      )}
    </div>
  );
}