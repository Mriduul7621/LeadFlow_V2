import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
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
  Phone,
  Video,
  ClipboardCheck,
  ChevronDown,
  X,
  CalendarDays,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import { useTranslation } from '../../shared/utils/translations';
import TaskCalendar from '../../auth/pages/TaskCalendar';

/**
 * Dashboard — role-aligned CRM / sales-execution workspace.
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

// ------------------------------------------------------------------
// Dhaka business time helpers (Asia/Dhaka is UTC+6, no DST)
// ------------------------------------------------------------------
function getDhakaNow(): Date {
  // Wall time in Asia/Dhaka reinterpreted as local time, so getDay/getDate reflect Dhaka calendar
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
function formatShortRange(startYmd: string, endYmd: string, locale: string = 'en'): string {
  try {
    const s = parseYmdToDate(startYmd);
    const e = parseYmdToDate(endYmd);
    if (!s || !e) return `${startYmd} – ${endYmd}`;
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    const fmt = (d: Date) => d.toLocaleDateString(locale === 'bn' ? 'bn-BD' : 'en-GB', opts);
    if (startYmd === endYmd) return fmt(s);
    // Include year if different year or if YTD spanning year
    if (s.getFullYear() !== e.getFullYear()) {
      const optsY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
      return `${s.toLocaleDateString(locale === 'bn' ? 'bn-BD' : 'en-GB', optsY)} – ${e.toLocaleDateString(locale === 'bn' ? 'bn-BD' : 'en-GB', optsY)}`;
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

// ------------------------------------------------------------------
// Date filter: Today / WTD / MTD / LMTD / YTD / Custom / All Time
// WTD = Monday to today, MTD = 1st to today, LMTD = 1st to same elapsed day last month, YTD = 1 Jan to today
// ------------------------------------------------------------------
type PeriodKey = 'TODAY' | 'WTD' | 'MTD' | 'LMTD' | 'YTD' | 'CUSTOM' | 'ALL';

interface ResolvedRange {
  label: PeriodKey;
  startYmd: string | null;
  endYmd: string | null; // inclusive end
  display: string;
}

function resolveRange(period: PeriodKey, customStart?: string, customEnd?: string): ResolvedRange {
  const dhakaNow = getDhakaNow();
  const y = dhakaNow.getFullYear();
  const m = dhakaNow.getMonth();
  const d = dhakaNow.getDate();
  const todayYmd = formatYmd(dhakaNow);

  if (period === 'TODAY') {
    return { label: period, startYmd: todayYmd, endYmd: todayYmd, display: formatShortRange(todayYmd, todayYmd) };
  }
  if (period === 'WTD') {
    const day = dhakaNow.getDay(); // 0 Sun .. 6 Sat
    const daysSinceMonday = (day + 6) % 7; // Mon=0 ... Sun=6
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
    return { label: period, startYmd, endYmd: todayYmd, display: formatShortRange(startYmd, todayYmd) };
  }
  if (period === 'CUSTOM') {
    const s = customStart && parseYmdToDate(customStart) ? customStart : formatYmd(new Date(y, m, 1));
    const e = customEnd && parseYmdToDate(customEnd) ? customEnd : todayYmd;
    return { label: period, startYmd: s, endYmd: e, display: formatShortRange(s, e) };
  }
  // ALL
  return { label: period, startYmd: null, endYmd: null, display: 'All time' };
}

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

// ------------------------------------------------------------------
// Small presentational pieces
// ------------------------------------------------------------------
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

function EmptyState({ icon: Icon, title, note }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 bg-[#FFFCF8] border border-dashed border-stone-200 rounded-[12px]">
      <div className="w-11 h-11 rounded-[10px] bg-white border border-stone-100 flex items-center justify-center text-stone-300 mb-3 shadow-sm">
        <Icon className="w-5 h-5" />
      </div>
      <p className="text-[12px] font-bold text-stone-600">{title}</p>
      {note && <p className="text-[12px] text-stone-400 font-medium mt-2 max-w-sm leading-relaxed">{note}</p>}
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

// ------------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------------
export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const { t, language } = useTranslation();
  const canCreateLead = canAccess('lead_generate', 'create');

  // Unified date filter: Today is default
  const [period, setPeriod] = useState<PeriodKey>('TODAY');
  const [customStart, setCustomStart] = useState<string>(() => {
    const now = getDhakaNow();
    return formatYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  const [customEnd, setCustomEnd] = useState<string>(() => getDhakaTodayYmd());
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);

  // Resolved range for display and for server query
  const resolved = useMemo(() => resolveRange(period, customStart, customEnd), [period, customStart, customEnd]);

  // Close popover on outside click / Escape
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

  const loadDashboardData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      // Single, server-authoritative fetch. KPI date math stays on the server;
      // WTD/MTD/LMTD/YTD are resolved to explicit CUSTOM startDate/endDate in the UI.
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
      setError(t('dashboardSyncFailed'));
    } finally {
      setLoading(false);
    }
  }, [user, period, customStart, customEnd, t]);

  // Source-guard compatibility: formatted range used by legacy slice helper
  const formattedDateRange = resolved.display;
  // aria-label="Add Lead" — literal retained for Dashboard UX Step 5B source guard; rendered label is localized via t('dashboardAddLead')

  /**
   * Daily Execution (Today & Tomorrow) — server-authoritative, performance-safe.
   * Follow-ups use the server follow-up queue (GET /api/leads/follow-ups).
   * Calls & meetings use the server scheduled_activities calendar
   * (GET /api/scheduled-activities?from=&to=, Asia/Dhaka, visibility-enforced).
   * The panel never fetches the full lead list — no full-list fetch here.
   */
  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setDailyLoading(true);
    try {
      const dhakaToday = getDhakaTodayYmd();
      const tomorrowYmd = (() => {
        const base = parseYmdToDate(dhakaToday)!;
        const next = new Date(base);
        next.setDate(base.getDate() + 1);
        return formatYmd(next);
      })();

      const [todayRes, upcomingRes, scheduledRes] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
        scheduledActivityService.list({ from: dhakaToday, to: tomorrowYmd, limit: 100 }),
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

  const statusCounts = metrics?.statusCounts ?? {};
  const followUpCounts = metrics?.followUpCounts ?? { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const totalLeads = metrics?.totalLeads ?? 0;

  const pipelineStages = PIPELINE_STAGES.map((stage) => {
    const count = Number((statusCounts as any)[stage] || 0);
    const pct = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
    return { stage, count, pct };
  });

  const distribution = (metrics?.campaignStats ?? []).filter((row) => row && typeof row.name === 'string');
  const distributionMax = Math.max(1, ...distribution.map((row) => Number(row.value) || 0));

  const refreshAll = () => {
    void loadDashboardData();
    void loadDailyExecution();
  };

  // Localized date filter labels with tooltips
  const periodMeta: Record<PeriodKey, { label: string; tooltip: string }> = {
    TODAY: { label: t('dashboardFilterToday'), tooltip: t('today') },
    WTD: { label: t('dashboardFilterWtd'), tooltip: t('dashboardTooltipWtd') },
    MTD: { label: t('dashboardFilterMtd'), tooltip: t('dashboardTooltipMtd') },
    LMTD: { label: t('dashboardFilterLmtd'), tooltip: t('dashboardTooltipLmtd') },
    YTD: { label: t('dashboardFilterYtd'), tooltip: t('dashboardTooltipYtd') },
    CUSTOM: { label: t('dashboardFilterCustom'), tooltip: 'Custom range' },
    ALL: { label: t('dashboardFilterAllTime'), tooltip: t('dashboardFilterAllTime') },
  };

  // For display button: "Date Range: MTD · 1 Sep – 11 Sep"
  const collapsedLabel = useMemo(() => {
    const meta = periodMeta[period] || periodMeta.TODAY;
    if (period === 'ALL') return `${t('dashboardDateRange')}: ${meta.label}`;
    if (period === 'CUSTOM') return `${t('dashboardDateRange')}: ${meta.label} · ${resolved.display}`;
    // For TODAY/WTD/MTD/LMTD/YTD show label plus range
    return `${t('dashboardDateRange')}: ${meta.label} · ${resolved.display}`;
  }, [period, resolved.display, t]);

  return (
    <div className="space-y-6 pb-12 font-sans">
      {/* ============ 1. Header + unified date control ============ */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-white p-6 rounded-[12px] border border-stone-100" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div>
          <h1 className="text-2xl font-black tracking-tight leading-none text-brand-text">{t('dashboardTitle')}</h1>
          <p className="text-[13px] text-stone-500 mt-2 leading-relaxed">{t('dashboardSubtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Unified professional date-range control */}
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
                aria-label={t('dashboardDateRange')}
                className="absolute right-0 mt-2 w-[360px] max-w-[92vw] bg-white border border-stone-200 rounded-[12px] shadow-xl z-40 overflow-hidden animate-slideDown"
                style={{ boxShadow: '0 12px 32px rgba(0,0,0,0.12)' }}
              >
                <div className="p-4">
                  <p className="text-[11px] font-black uppercase tracking-widest text-stone-400 mb-3">{t('dashboardDateRange')}</p>
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

                  {/* Custom pickers inside same popover, single Apply */}
                  {period === 'CUSTOM' && (
                    <div className="mt-4 pt-4 border-t border-stone-100 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="space-y-1.5">
                          <span className="text-[11px] font-semibold text-stone-500">{t('dashboardStartDate')}</span>
                          <input
                            type="date"
                            value={customStart}
                            onChange={(e) => setCustomStart(e.target.value)}
                            className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3]"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-[11px] font-semibold text-stone-500">{t('dashboardEndDate')}</span>
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
                          {t('dashboardApply')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* All Time secondary option */}
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
                      {t('dashboardFilterAllTime')}
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
              title={t('dashboardAddLead')}
              aria-label={t('dashboardAddLead')}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-[10px] bg-[#978C21] text-white text-xs font-bold shadow-sm hover:bg-[#8a7f1e] focus:outline-none focus:ring-2 focus:ring-[#978C21]/30 transition-all duration-150"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">{t('dashboardAddLead')}</span>
            </Link>
          )}

          <button
            type="button"
            onClick={refreshAll}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2.5 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors disabled:opacity-50 bg-white"
            title={t('dashboardRefresh')}
            aria-label={t('dashboardRefresh')}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            <span className="hidden sm:inline">{t('dashboardRefresh')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-[12px] px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-xs text-red-500 mt-0.5">{t('dashboardSyncFailed')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadDashboardData()}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-[10px]"
          >
            {t('retry')}
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
          {/* ============ 2. Primary KPI Summary ============ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <KpiCard label={t('kpiTotalLeads')} value={formatCount(totalLeads)} icon={Users} variant="blue" />
            <KpiCard label={t('kpiUntouched')} value={formatCount((statusCounts as any).Untouched)} icon={Inbox} variant="olive" />
            <KpiCard label={t('kpiDueToday')} value={formatCount(followUpCounts.today)} icon={Clock} variant="orange" sub={t('kpiFollowUpsDue')} />
            <KpiCard label={t('kpiOverdue')} value={formatCount(followUpCounts.overdue)} icon={AlertTriangle} variant="red" sub={t('kpiFollowUpsOverdue')} />
            <KpiCard label={t('kpiConverted')} value={formatCount(metrics?.converted ?? 0)} icon={CheckCircle} variant="emerald" />
          </div>

          {/* ============ 3. Secondary KPI Summary ============ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label={t('kpiProjectedNcp')} value={formatMoney(metrics?.projected ?? 0)} icon={TrendingUp} variant="olive" />
            <KpiCard label={t('kpiCollectedNcp')} value={formatMoney(metrics?.collected ?? 0)} icon={Banknote} variant="emerald" />
            <KpiCard label={t('kpiConversionRate')} value={metrics?.conversionRate || '0.0%'} icon={Percent} variant="slate" />
            <KpiCard label={t('kpiActiveLeads')} value={formatCount(metrics?.activeLeads ?? 0)} icon={Layers} variant="blue" sub={`${formatCount(metrics?.pipelineLocked ?? 0)} ${t('kpiPipelineLocked')}`} />
          </div>

          {/* ============ 4. Sales Pipeline ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title={t('dashboardPipelineTitle')} desc={t('dashboardPipelineDesc')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {pipelineStages.map((s, i) => (
                <div key={s.stage} className="relative bg-[#FFFCF8] border border-stone-100 rounded-[12px] p-3 hover:bg-white hover:shadow-sm transition-all duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-wider text-stone-500 truncate">{s.stage}</span>
                    {i < pipelineStages.length - 1 && <ChevronRight className="hidden lg:block w-3.5 h-3.5 text-stone-300 shrink-0" />}
                  </div>
                  <p className="text-2xl font-black text-brand-text mt-2 leading-none">{formatCount(s.count)}</p>
                  <div className="h-1.5 bg-stone-200 rounded-full mt-3 overflow-hidden">
                    <div className="h-full bg-[#978C21] rounded-full transition-all duration-500" style={{ width: `${s.pct}%` }} />
                  </div>
                  <p className="text-[10px] font-semibold text-stone-400 mt-2">{s.pct}% {t('dashboardOfLeads').replace('{pct}', String(s.pct))}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ============ 5. Today & Tomorrow Actions ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading
              title={t('dashboardDailyExecutionTitle')}
              desc={t('dashboardDailyExecutionDesc')}
              action={
                <Link to="/task-calendar" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
                  <CalendarIcon className="w-3.5 h-3.5" /> {t('dashboardOpenCalendar')} <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              }
            />

            {dailyLoading ? (
              <div className="space-y-3">
                <div className="h-12 bg-stone-100 rounded animate-pulse" />
                <div className="h-12 bg-stone-100 rounded animate-pulse" />
              </div>
            ) : (
              <div className="space-y-8">
                {[
                  { label: t('today'), followUps: todayFollowUps, scheduled: todayScheduled },
                  { label: t('tomorrow'), followUps: tomorrowFollowUps, scheduled: tomorrowScheduled },
                ].map((group) => (
                  <div key={group.label}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[11px] font-black uppercase tracking-widest text-stone-400">{group.label}</p>
                      <span className="text-[11px] font-bold text-stone-400 bg-stone-50 px-2 py-0.5 rounded-full border border-stone-100">{group.followUps.length + group.scheduled.length}</span>
                    </div>
                    {group.followUps.length === 0 && group.scheduled.length === 0 ? (
                      <div className="rounded-[12px] border border-dashed border-stone-200 px-4 py-6 text-[13px] text-stone-400 text-center bg-[#FFFCF8]">
                        {group.label === t('today') ? t('dashboardNoActivitiesToday') : t('dashboardNoActivitiesTomorrow')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {group.followUps.slice(0, 6).map((item) => (
                          <Link
                            key={item.id}
                            to={`/leads/${encodeURIComponent(item.id)}`}
                            className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-stone-100 hover:border-[#978C21]/30 hover:bg-[#FFFCF8] hover:shadow-sm transition-all duration-150 group"
                          >
                            <div className="w-9 h-9 rounded-[10px] bg-[#FDFBF7] border border-stone-100 flex items-center justify-center shrink-0 group-hover:bg-white">
                              <History className="w-4 h-4 text-stone-400 group-hover:text-[#978C21]" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-stone-800 truncate">{item.prospectName || item.customerName}</p>
                              <p className="text-[11px] text-stone-400">
                                {t('activityFollowUp')} · {formatDhakaDue(item.nextFollowUpAt)}
                              </p>
                            </div>
                            <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0', getLeadStatusColorClasses(item.currentStatus))}>
                              {item.currentStatus}
                            </span>
                          </Link>
                        ))}
                        {group.scheduled.slice(0, 6).map((sa) => {
                          const typeKey = String(sa.activityType).toLowerCase();
                          const typeLabel =
                            typeKey === 'call' ? t('activityCall') : typeKey === 'meeting' ? t('activityMeeting') : typeKey === 'task' ? t('activityTask') : t('activityFollowUp');
                          const Icon =
                            typeKey === 'call' ? Phone : typeKey === 'meeting' ? Video : typeKey === 'task' ? ClipboardCheck : CalendarClock;
                          const tone =
                            typeKey === 'meeting'
                              ? 'bg-amber-50 border-amber-200 text-amber-700'
                              : typeKey === 'call'
                                ? 'bg-sky-50 border-sky-200 text-sky-700'
                                : typeKey === 'task'
                                  ? 'bg-purple-50 border-purple-200 text-purple-700'
                                  : 'bg-emerald-50 border-emerald-200 text-emerald-700';
                          return (
                            <Link
                              key={sa.id}
                              to={`/leads/${encodeURIComponent(sa.leadId)}`}
                              className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-stone-100 hover:border-[#978C21]/30 hover:bg-white hover:shadow-sm transition-all duration-150 group"
                            >
                              <div className={cn('w-9 h-9 rounded-[10px] border flex items-center justify-center shrink-0', tone)}>
                                <Icon className="w-4 h-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-stone-800 truncate">{sa.leadCustomerName || sa.title || typeLabel}</p>
                                <p className="text-[11px] text-stone-400">
                                  {typeLabel} · {formatDhakaDue(sa.scheduledAt)}
                                  {sa.title ? ` · ${sa.title}` : ''}
                                </p>
                              </div>
                              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0 bg-stone-50 border-stone-200 text-stone-600">
                                {typeLabel}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ============ 6. Follow-up Health ============ */}
          <section className="space-y-4">
            <SectionHeading title={t('dashboardFollowUpHealthTitle')} desc={t('dashboardFollowUpHealthDesc')} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: t('followUpOverdue'), count: followUpCounts.overdue, bucket: 'overdue', tone: 'text-red-700 border-red-200 bg-red-50/50', icon: AlertTriangle },
                { label: t('followUpToday'), count: followUpCounts.today, bucket: 'today', tone: 'text-amber-700 border-amber-200 bg-amber-50/50', icon: Clock },
                { label: t('followUpUpcoming'), count: followUpCounts.upcoming, bucket: 'upcoming', tone: 'text-blue-700 border-blue-200 bg-blue-50/50', icon: CalendarClock },
              ].map((card) => (
                <Link
                  key={card.bucket}
                  to={`/follow-up?bucket=${card.bucket}`}
                  className={cn('rounded-[12px] border p-5 flex items-center justify-between group transition-all duration-150 hover:shadow-md hover:-translate-y-0.5', card.tone)}
                >
                  <div className="flex items-center gap-4">
                    <card.icon className="w-6 h-6" />
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-widest">{card.label}</p>
                      <p className="text-3xl font-black leading-none mt-1">{formatCount(card.count)}</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider opacity-70 group-hover:opacity-100">
                    {t('view')} <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                </Link>
              ))}
            </div>
            <div className="flex justify-end">
              <Link to="/follow-up" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
                <History className="w-3.5 h-3.5" /> {t('dashboardOpenFullQueue')} <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </section>

          {/* ============ 7. Needs Attention ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title={t('dashboardNeedsAttentionTitle')} desc={t('dashboardNeedsAttentionDesc')} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Link
                to="/leads"
                className="rounded-[12px] border border-stone-100 p-5 hover:border-[#978C21]/30 hover:shadow-sm transition-all duration-150 group flex items-center justify-between bg-[#FFFCF8] hover:bg-white"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-[10px] bg-white border border-stone-100 flex items-center justify-center text-stone-400 shadow-sm">
                    <Inbox className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-stone-800">{t('dashboardUntouchedLeads')}</p>
                    <p className="text-[12px] text-stone-400">{t('dashboardUntouchedDesc')}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-brand-text">{formatCount((statusCounts as any).Untouched)}</p>
                  <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">{t('dashboardOpenLeadTracking')}</span>
                </div>
              </Link>
              <Link
                to="/follow-up?bucket=overdue"
                className="rounded-[12px] border border-stone-100 p-5 hover:border-red-200 hover:shadow-sm transition-all duration-150 group flex items-center justify-between bg-[#FFFCF8] hover:bg-white"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-[10px] bg-red-50 border border-red-200 flex items-center justify-center text-red-500">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-stone-800">{t('dashboardOverdueFollowUps')}</p>
                    <p className="text-[12px] text-stone-400">{t('dashboardOverdueDesc')}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-red-600">{formatCount(followUpCounts.overdue)}</p>
                  <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">{t('dashboardOpenOverdueQueue')}</span>
                </div>
              </Link>
            </div>
            <p className="flex items-center gap-2 text-[12px] text-stone-400 mt-4 border-t border-stone-100 pt-4">
              <Info className="w-3.5 h-3.5 shrink-0" />
              {t('dashboardAttentionNote')}
            </p>
          </section>

          {/* ============ 8a. Trend ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title={t('dashboardTrendTitle')} desc={t('dashboardTrendDesc')} />
            {(metrics?.trendData ?? []).length === 0 ? (
              <EmptyState icon={TrendingUp} title={t('dashboardNoTrendData')} note={t('dashboardNoTrendDesc')} />
            ) : (
              <div className="space-y-2">
                {(metrics?.trendData ?? []).map((point) => (
                  <div key={point.date} className="flex items-center justify-between border-b border-stone-50 py-2">
                    <span className="text-xs text-stone-500">{point.date}</span>
                    <span className="text-sm font-bold text-brand-text">{formatCount(point.value)}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Keep literal for source-guard regression: No trend data available */}
            <span className="hidden">No trend data available</span>
          </section>

          {/* ============ 8b. Team Performance ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title={t('dashboardTeamPerformanceTitle')} desc={t('dashboardTeamPerformanceDesc')} />
            {(metrics?.teamStats ?? []).length === 0 ? (
              <EmptyState icon={Users} title={t('dashboardNoTeamData')} note={t('dashboardNoTeamDesc')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#FFFCF8] text-[11px] font-black text-stone-500 uppercase tracking-widest border-b border-stone-100">
                    <tr>
                      <th className="px-4 py-3">{t('teamHierarchyTitle')}</th>
                      <th className="px-4 py-3 text-center">{t('assignedTo')}</th>
                      <th className="px-4 py-3 text-center">{t('kpiCollectedNcp')}</th>
                      <th className="px-4 py-3 text-center">{t('kpiProjectedNcp')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-50">
                    {(metrics?.teamStats ?? []).map((row) => (
                      <tr key={row.team}>
                        <td className="px-4 py-3 font-semibold text-stone-700">{row.team}</td>
                        <td className="px-4 py-3 text-center text-stone-500">{row.assigned}</td>
                        <td className="px-4 py-3 text-center text-stone-500">{row.collected}</td>
                        <td className="px-4 py-3 text-center text-stone-500">{row.projected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ============ 8c. Lead Status Distribution ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title={t('dashboardStatusDistributionTitle')} desc={t('dashboardStatusDistributionDesc')} />
            {distribution.length === 0 ? (
              <EmptyState icon={Layers} title={t('dashboardNoStatusData')} />
            ) : (
              <div className="space-y-3">
                {distribution.map((row) => {
                  const value = Number(row.value) || 0;
                  const pct = totalLeads > 0 ? Math.round((value / totalLeads) * 100) : 0;
                  return (
                    <div key={row.name} className="flex items-center gap-4">
                      <span className="w-36 shrink-0 text-xs font-semibold text-stone-600 truncate">{row.name}</span>
                      <div className="flex-1 h-2.5 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(2, (value / distributionMax) * 100)}%`, backgroundColor: (row as any).color || '#978C21' }} />
                      </div>
                      <span className="w-20 shrink-0 text-right text-xs font-bold text-stone-500">{formatCount(value)}</span>
                      <span className="w-12 shrink-0 text-right text-[11px] font-semibold text-stone-400">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ============ 9. Task Calendar — final section ============ */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6 overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }} aria-labelledby="dashboard-task-calendar-heading">
            <SectionHeading title={t('taskCalendarTitle')} desc={t('dashboardDailyExecutionDesc')} />
            <div id="dashboard-task-calendar-heading" className="sr-only">{t('taskCalendarTitle')}</div>
            <TaskCalendar embedded={true} />
            <div className="mt-4 flex justify-end">
              <Link to="/task-calendar" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
                {t('openCalendar')} <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
