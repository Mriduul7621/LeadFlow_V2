import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  ChevronDown,
  CalendarClock,
  ArrowRight,
  Info,
  History,
  Plus,
  Phone,
  UsersRound,
  ListChecks,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useTranslation } from '../../shared/utils/translations';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import TaskCalendar from '../../auth/pages/TaskCalendar';

/**
 * Dashboard — role-aligned CRM / sales-execution workspace.
 * ------------------------------------------------------------------
 * Every KPI, pipeline and follow-up figure on this page binds ONLY to the
 * GET /api/dashboard response (PostgreSQL-backed, Asia/Dhaka business dates,
 * Own/DownTeam/FullTeam/Organization visibility). Client lead lists are
 * never used as a source for authoritative totals.
 *
 * The "Today & Tomorrow" panel:
 *   - Follow-ups come from the server follow-up queue (GET /api/leads/follow-ups)
 *   - Calls & meetings come from the server scheduled_activities table
 *     (GET /api/scheduled-activities?from=&to=, Asia/Dhaka) — the calendar
 *     and this panel never fetch the full lead list.
 */

const BUSINESS_TZ = 'Asia/Dhaka';

type PeriodKey = 'TODAY' | 'WTD' | 'MTD' | 'LMTD' | 'YTD' | 'CUSTOM' | 'ALL';

/** Canonical pipeline stages from existing current_status values. */
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

/** Format a timestamp in the business timezone (Asia/Dhaka). */
function formatDhakaDue(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: BUSINESS_TZ,
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

/** Today's calendar date in Asia/Dhaka as { y, m, d, ymd }. */
function dhakaTodayParts(): { y: number; m: number; d: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  return { y, m, d, ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function toYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Resolve WTD / MTD / LMTD / YTD to explicit Dhaka date bounds. The server
 * only knows TODAY / THIS_MONTH / LAST_MONTH / CUSTOM / ALL natively, so the
 * "to date" periods are sent through the existing CUSTOM query with resolved
 * startDate/endDate. All KPI aggregation remains server-side; the UI only
 * resolves which explicit bounds to request.
 */
function resolveRange(period: PeriodKey): { start: string; end: string } | null {
  const { y, m, d } = dhakaTodayParts();
  if (period === 'WTD') {
    const asUtc = new Date(Date.UTC(y, m - 1, d));
    const dow = asUtc.getUTCDay(); // 0 = Sunday (Bangladesh week start)
    const sunday = new Date(Date.UTC(y, m - 1, d - dow));
    return {
      start: toYmd(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate()),
      end: toYmd(y, m, d),
    };
  }
  if (period === 'MTD') return { start: toYmd(y, m, 1), end: toYmd(y, m, d) };
  if (period === 'LMTD') {
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const lastDayOfPrev = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
    const day = Math.min(d, lastDayOfPrev);
    return { start: toYmd(prevY, prevM, 1), end: toYmd(prevY, prevM, day) };
  }
  if (period === 'YTD') return { start: toYmd(y, 1, 1), end: toYmd(y, m, d) };
  return null;
}

/** Format a Y-M-D calendar date with locale-appropriate month names. */
function fmtYmd(ymd: string, lang: 'en' | 'bn'): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const month = new Intl.DateTimeFormat(lang === 'bn' ? 'bn-BD' : 'en-GB', {
    month: 'short',
    timeZone: 'UTC',
  }).format(dt);
  return `${d} ${month} ${y}`;
}

/* ------------------------------------------------------------------ */
/*  Small presentational pieces                                        */
/* ------------------------------------------------------------------ */

type KpiTone = 'blue' | 'success' | 'danger' | 'warning' | 'gold' | 'neutral';

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: KpiTone;
}

const KPI_TONES: Record<KpiTone, { card: string; icon: string; value: string; bar: string }> = {
  blue: {
    card: 'border-brand-blue/15 bg-brand-blue/[0.04]',
    icon: 'bg-brand-blue/10 text-brand-blue',
    value: 'text-brand-blue',
    bar: 'from-brand-blue to-brand-blue/60',
  },
  success: {
    card: 'border-emerald-200/70 bg-emerald-50/40',
    icon: 'bg-emerald-100 text-emerald-700',
    value: 'text-emerald-700',
    bar: 'from-emerald-500 to-emerald-300',
  },
  danger: {
    card: 'border-red-200/70 bg-red-50/40',
    icon: 'bg-red-100 text-red-600',
    value: 'text-red-600',
    bar: 'from-red-500 to-red-300',
  },
  warning: {
    card: 'border-amber-200/70 bg-amber-50/40',
    icon: 'bg-amber-100 text-amber-700',
    value: 'text-amber-700',
    bar: 'from-amber-500 to-amber-300',
  },
  gold: {
    card: 'border-brand-primary/15 bg-brand-primary/[0.05]',
    icon: 'bg-brand-primary/10 text-brand-primary',
    value: 'text-brand-primary',
    bar: 'from-brand-primary to-brand-primary/60',
  },
  neutral: {
    card: 'border-border bg-card',
    icon: 'bg-slate-100 text-slate-500',
    value: 'text-brand-text',
    bar: 'from-slate-400 to-slate-300',
  },
};

function KpiCard({ label, value, sub, icon: Icon, tone = 'neutral' }: KpiCardProps) {
  const tones = KPI_TONES[tone];
  return (
    <div className={cn('relative overflow-hidden rounded-card border p-5 shadow-card flex flex-col justify-between min-h-[120px]', tones.card)}>
      <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', tones.bar)} aria-hidden="true" />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-500">{label}</p>
        <span className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', tones.icon)}>
          <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
        </span>
      </div>
      <div className="mt-2">
        <p className={cn('text-2xl md:text-[28px] font-bold tracking-tight leading-none tabular-nums', tones.value)}>{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-1.5">{sub}</p>}
      </div>
    </div>
  );
}

function SectionHeading({ title, desc, action }: { title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        {desc && <p className="text-xs text-slate-400 mt-0.5">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

function EmptyState({ icon: Icon, title, note }: { icon: React.ComponentType<{ className?: string }>; title: string; note?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 bg-surface-soft border border-dashed border-border rounded-card">
      <div className="w-11 h-11 rounded-lg bg-white border border-border flex items-center justify-center text-slate-300 mb-3">
        <Icon className="w-5 h-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-semibold text-slate-600">{title}</p>
      {note && <p className="text-xs text-slate-400 mt-2 max-w-sm leading-relaxed">{note}</p>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-card rounded-card border border-border p-5 shadow-card min-h-[120px] animate-pulse">
      <div className="h-3 w-24 bg-slate-100 rounded mb-4" />
      <div className="h-7 w-20 bg-slate-100 rounded" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Unified date-range control                                         */
/* ------------------------------------------------------------------ */

interface DateRangeControlProps {
  period: PeriodKey;
  onPeriodChange: (p: PeriodKey) => void;
  customStart: string;
  customEnd: string;
  onCustomStart: (v: string) => void;
  onCustomEnd: (v: string) => void;
  onApply: () => void;
  label: string;
}

function DateRangeControl({
  period,
  onPeriodChange,
  customStart,
  customEnd,
  onCustomStart,
  onCustomEnd,
  onApply,
  label,
}: DateRangeControlProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(customStart);
  const [draftEnd, setDraftEnd] = useState(customEnd);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraftStart(customStart);
      setDraftEnd(customEnd);
    }
  }, [open, customStart, customEnd]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const quickPeriods: Array<{ key: PeriodKey; label: string; tooltip: string }> = [
    { key: 'TODAY', label: t('periodToday'), tooltip: t('periodTodayTooltip') },
    { key: 'WTD', label: t('periodWtd'), tooltip: t('periodWtdTooltip') },
    { key: 'MTD', label: t('periodMtd'), tooltip: t('periodMtdTooltip') },
    { key: 'LMTD', label: t('periodLmtd'), tooltip: t('periodLmtdTooltip') },
    { key: 'YTD', label: t('periodYtd'), tooltip: t('periodYtdTooltip') },
    { key: 'CUSTOM', label: t('periodCustom'), tooltip: t('periodCustomTooltip') },
  ];

  const pick = (p: PeriodKey) => {
    onPeriodChange(p);
    if (p !== 'CUSTOM') setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-2 h-10 px-3.5 rounded-control bg-card border border-border shadow-card hover:border-brand-primary/50 text-sm font-semibold text-brand-text transition-colors duration-150"
      >
        <CalendarIcon className="w-4 h-4 text-brand-primary" aria-hidden="true" />
        <span className="text-slate-500 font-medium">{t('dateRange')}:</span>
        <span className="tabular-nums">{label}</span>
        <ChevronDown className={cn('w-4 h-4 text-slate-400 transition-transform duration-150', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('dateRange')}
          className="absolute right-0 z-40 mt-2 w-[320px] bg-card border border-border rounded-card shadow-popover p-3"
        >
          <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t('dateRange')}</p>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('dateRange')}>
            {quickPeriods.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.tooltip}
                aria-label={p.tooltip}
                onClick={() => pick(p.key)}
                className={cn(
                  'px-3 py-2 rounded-control text-sm font-semibold text-left transition-colors duration-150',
                  period === p.key
                    ? 'bg-brand-primary text-white'
                    : 'text-slate-600 hover:bg-surface-soft',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            title={t('periodAllTimeTooltip')}
            onClick={() => pick('ALL')}
            className={cn(
              'mt-1.5 w-full px-3 py-2 rounded-control text-sm font-semibold text-left border-t border-border transition-colors duration-150',
              period === 'ALL' ? 'text-brand-primary' : 'text-slate-500 hover:text-brand-primary',
            )}
          >
            {t('periodAllTime')}
          </button>

          {period === 'CUSTOM' && (
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <div>
                <label htmlFor="dash-custom-start" className="block text-xs font-semibold text-slate-500 mb-1">{t('startDate')}</label>
                <input
                  id="dash-custom-start"
                  type="date"
                  value={draftStart}
                  onChange={(e) => setDraftStart(e.target.value)}
                  className="input-standard text-sm"
                />
              </div>
              <div>
                <label htmlFor="dash-custom-end" className="block text-xs font-semibold text-slate-500 mb-1">{t('endDate')}</label>
                <input
                  id="dash-custom-end"
                  type="date"
                  value={draftEnd}
                  onChange={(e) => setDraftEnd(e.target.value)}
                  className="input-standard text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  onCustomStart(draftStart);
                  onCustomEnd(draftEnd);
                  onApply();
                  setOpen(false);
                }}
                className="btn-primary w-full"
              >
                {t('applyRange')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                          */
/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const { t, language, activityLabel } = useTranslation();

  // Lead-create capability (leads.create when the server permission exists,
  // otherwise the role featurePermissions/menuAccess fallback).
  const canCreateLead = canAccess('lead_generate', 'create');

  const [period, setPeriod] = useState<PeriodKey>('TODAY');
  const [customDates, setCustomDates] = useState(() => {
    const { ymd } = dhakaTodayParts();
    const firstOfMonth = `${ymd.slice(0, 8)}01`;
    return { start: firstOfMonth, end: ymd };
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  // Today/Tomorrow follow-ups + scheduled activities (informational only — see file header).
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
      let query: Parameters<typeof dashboardService.getDashboard>[0] = {};
      if (period === 'TODAY') {
        query = { period: 'TODAY' };
      } else if (period === 'CUSTOM') {
        query = { period: 'CUSTOM', startDate: customDates.start, endDate: customDates.end };
      } else if (period === 'ALL') {
        query = { period: 'ALL' };
      } else {
        // WTD / MTD / LMTD / YTD resolve to explicit Dhaka bounds and reuse
        // the server CUSTOM query. KPI aggregation stays server-side.
        const range = resolveRange(period);
        if (range) query = { period: 'CUSTOM', startDate: range.start, endDate: range.end };
        else query = { period: 'TODAY' };
      }
      const metrics = await dashboardService.getDashboard(query);
      setMetrics(metrics);
    } catch (err) {
      setMetrics(null);
      setError(t('dashboardLoadError'));
    } finally {
      setLoading(false);
    }
  }, [user, period, customDates, t]);

  const loadDailyExecution = useCallback(async () => {
    if (!user) return;
    setDailyLoading(true);
    try {
      // Dhaka calendar date for "today".
      const dhakaToday = new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
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
          return d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }) === ymd;
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

  const formattedDateRange = (): string => {
    const { ymd } = dhakaTodayParts();
    if (period === 'TODAY') return fmtYmd(ymd, language);
    if (period === 'CUSTOM') return `${fmtYmd(customDates.start, language)} – ${fmtYmd(customDates.end, language)}`;
    if (period === 'ALL') return t('periodAllTime');
    const range = resolveRange(period);
    if (range) return `${fmtYmd(range.start, language)} – ${fmtYmd(range.end, language)}`;
    return fmtYmd(ymd, language);
  };

  const periodLabel = (): string => {
    switch (period) {
      case 'TODAY': return t('periodToday');
      case 'WTD': return t('periodWtd');
      case 'MTD': return t('periodMtd');
      case 'LMTD': return t('periodLmtd');
      case 'YTD': return t('periodYtd');
      case 'CUSTOM': return t('periodCustom');
      case 'ALL': return t('periodAllTime');
      default: return period;
    }
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
    <div className="space-y-6 pb-12">
      {/* ============ A. Header / date control ============ */}
      <div className="card p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-brand-text tracking-tight leading-none">{t('dashboardTitle')}</h1>
            <p className="text-sm text-slate-500 mt-1.5">{t('dashboardSubtitle')}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <DateRangeControl
              period={period}
              onPeriodChange={setPeriod}
              customStart={customDates.start}
              customEnd={customDates.end}
              onCustomStart={(v) => setCustomDates((c) => ({ ...c, start: v }))}
              onCustomEnd={(v) => setCustomDates((c) => ({ ...c, end: v }))}
              onApply={() => undefined}
              label={`${periodLabel()} · ${formattedDateRange()}`}
            />

            {canCreateLead && (
              <Link
                to="/leads/new"
                title={t('addLead')}
                aria-label={t('addLead')}
                className="btn-primary h-10"
              >
                <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">{t('addLead')}</span>
              </Link>
            )}

            <button
              type="button"
              onClick={refreshAll}
              disabled={loading}
              title={t('refreshDataTooltip')}
              className="btn-secondary h-10"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} aria-hidden="true" />
              {t('refreshData')}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-card px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-xs text-red-500 mt-0.5">{t('dashboardLoadErrorNote')}</p>
            </div>
          </div>
          <button type="button" onClick={() => void loadDashboardData()} className="btn-danger">
            {t('retry')}
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
            <KpiCard label={t('totalLeads')} value={formatCount(totalLeads)} icon={Users} tone="blue" />
            <KpiCard label={t('untouched')} value={formatCount(statusCounts.Untouched)} icon={Inbox} tone="gold" />
            <KpiCard label={t('dueToday')} value={formatCount(followUpCounts.today)} icon={Clock} sub={t('followUpsDue')} tone="warning" />
            <KpiCard label={t('overdue')} value={formatCount(followUpCounts.overdue)} icon={AlertTriangle} sub={t('followUpsOverdue')} tone="danger" />
            <KpiCard label={t('converted')} value={formatCount(metrics?.converted ?? 0)} icon={CheckCircle} tone="success" />
          </div>

          {/* ============ C. Secondary KPI row ============ */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label={t('projectedNCP')} value={formatMoney(metrics?.projected ?? 0)} icon={TrendingUp} tone="gold" />
            <KpiCard label={t('collectedNCP')} value={formatMoney(metrics?.collected ?? 0)} icon={Banknote} tone="success" />
            <KpiCard label={t('conversionRate')} value={metrics?.conversionRate || '0.0%'} icon={Percent} tone="blue" />
            <KpiCard
              label={t('activeLeads')}
              value={formatCount(metrics?.activeLeads ?? 0)}
              icon={Layers}
              sub={t('pipelineLockedSub', { count: formatCount(metrics?.pipelineLocked ?? 0) })}
              tone="neutral"
            />
          </div>

          {/* ============ D. Sales Pipeline ============ */}
          <section className="card p-6">
            <SectionHeading title={t('salesPipeline')} desc={t('salesPipelineDesc')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {pipelineStages.map((s, i) => (
                <div key={s.stage} className="relative bg-surface-soft border border-border rounded-control p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-500 truncate">{s.stage}</span>
                    {i < pipelineStages.length - 1 && (
                      <ChevronRight className="hidden lg:block w-3.5 h-3.5 text-slate-300 shrink-0" aria-hidden="true" />
                    )}
                  </div>
                  <p className="text-2xl font-bold text-brand-text mt-2 leading-none tabular-nums">{formatCount(s.count)}</p>
                  <div className="h-1.5 bg-slate-200 rounded-full mt-3 overflow-hidden">
                    <div className="h-full bg-brand-primary" style={{ width: `${s.pct}%` }} />
                  </div>
                  <p className="text-[11px] font-medium text-slate-400 mt-2">
                    {s.pct}% {t('ofLeads')}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* ============ E. Today & Tomorrow Actions ============ */}
          <section className="card p-6">
            <SectionHeading
              title={t('dailyExecution')}
              desc={t('dailyExecutionDesc')}
              action={
                <Link
                  to="/task-calendar"
                  title={t('openCalendarTooltip')}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-primary hover:underline"
                >
                  <CalendarIcon className="w-4 h-4" aria-hidden="true" />
                  {t('openCalendar')}
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              }
            />

            {dailyLoading ? (
              <div className="space-y-3">
                <div className="h-12 bg-slate-100 rounded animate-pulse" />
                <div className="h-12 bg-slate-100 rounded animate-pulse" />
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[
                  { label: t('today'), followUps: todayFollowUps, scheduled: todayScheduled },
                  { label: t('tomorrow'), followUps: tomorrowFollowUps, scheduled: tomorrowScheduled },
                ].map((group) => (
                  <div key={group.label} className="rounded-control border border-border p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{group.label}</p>
                      <span className="text-xs font-bold text-slate-400 tabular-nums">{group.followUps.length + group.scheduled.length}</span>
                    </div>
                    {group.followUps.length === 0 && group.scheduled.length === 0 ? (
                      <div className="rounded-control border border-dashed border-border px-4 py-5 text-sm text-slate-400">
                        {t('noActivitiesDue', { day: group.label })}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {group.followUps.slice(0, 6).map((item) => (
                          <Link
                            key={`fu-${item.id}`}
                            to={`/leads/${encodeURIComponent(item.id)}`}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-control border border-border hover:border-brand-primary/40 hover:bg-surface-soft hover:shadow-card transition-all duration-150 group"
                          >
                            <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0">
                              <History className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-slate-800 truncate">{item.prospectName || item.customerName}</p>
                              <p className="text-[11px] text-slate-400">
                                {t('activityFollowUp')} · {formatDhakaDue(item.nextFollowUpAt)}
                              </p>
                            </div>
                            <span className={cn('badge border', getLeadStatusColorClasses(item.currentStatus))}>
                              {item.currentStatus}
                            </span>
                          </Link>
                        ))}
                        {group.scheduled.slice(0, 6).map((sa) => {
                          const type = sa.activityType;
                          const toneCls =
                            type === 'meeting'
                              ? 'bg-amber-50 border-amber-100 text-amber-600'
                              : type === 'call'
                                ? 'bg-sky-50 border-sky-100 text-sky-600'
                                : type === 'task'
                                  ? 'bg-purple-50 border-purple-100 text-purple-600'
                                  : 'bg-emerald-50 border-emerald-100 text-emerald-600';
                          return (
                            <Link
                              key={`sa-${sa.id}`}
                              to={`/leads/${encodeURIComponent(sa.leadId)}`}
                              className="flex items-center gap-3 px-3 py-2.5 rounded-control border border-border hover:border-brand-primary/40 hover:bg-surface-soft hover:shadow-card transition-all duration-150 group"
                            >
                              <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', toneCls)}>
                                <CalendarIcon className="w-3.5 h-3.5" aria-hidden="true" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-slate-800 truncate">
                                  {sa.leadCustomerName || sa.title || t('scheduledActivity')}
                                </p>
                                <p className="text-[11px] text-slate-400">
                                  {activityLabel(type)} · {formatDhakaDue(sa.scheduledAt)}
                                  {sa.title ? ` · ${sa.title}` : ''}
                                </p>
                              </div>
                              <span className="badge bg-white border border-border text-slate-500">
                                {activityLabel(type)}
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
            <p className="text-xs text-slate-400 mt-4 border-t border-border pt-4">{t('dailyExecutionSourceNote')}</p>
          </section>

          {/* ============ F. Follow-up Health ============ */}
          <section className="space-y-4">
            <SectionHeading title={t('followUpHealth')} desc={t('followUpHealthDesc')} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: t('overdue'), count: followUpCounts.overdue, bucket: 'overdue', tone: 'text-red-600 border-red-200 bg-red-50/40', icon: AlertTriangle },
                { label: t('dueToday'), count: followUpCounts.today, bucket: 'today', tone: 'text-amber-600 border-amber-200 bg-amber-50/40', icon: Clock },
                { label: t('upcoming'), count: followUpCounts.upcoming, bucket: 'upcoming', tone: 'text-blue-600 border-blue-200 bg-blue-50/40', icon: CalendarClock },
              ].map((card) => (
                <Link
                  key={card.bucket}
                  to={`/follow-up?bucket=${card.bucket}`}
                  className={cn('rounded-card border p-5 flex items-center justify-between group transition-all duration-150 hover:shadow-card', card.tone)}
                >
                  <div className="flex items-center gap-4">
                    <card.icon className="w-6 h-6" aria-hidden="true" />
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider">{card.label}</p>
                      <p className="text-3xl font-bold leading-none mt-1 tabular-nums">{formatCount(card.count)}</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold opacity-70 group-hover:opacity-100">
                    {t('openQueue')} <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
            <div className="flex justify-end">
              <Link to="/follow-up" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-primary hover:underline">
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                {t('openFullFollowUpQueue')} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            </div>
          </section>

          {/* ============ G. Needs Attention ============ */}
          <section className="card p-6">
            <SectionHeading title={t('needsAttention')} desc={t('needsAttentionDesc')} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Link
                to="/leads"
                className="rounded-card border border-border p-5 hover:border-brand-primary/40 hover:shadow-card transition-all duration-150 group flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-brand-blue/10 border border-brand-blue/15 flex items-center justify-center text-brand-blue">
                    <Inbox className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{t('untouchedLeads')}</p>
                    <p className="text-xs text-slate-400">{t('untouchedLeadsDesc')}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-brand-text tabular-nums">{formatCount(statusCounts.Untouched)}</p>
                  <span className="text-xs font-semibold text-slate-400 group-hover:text-brand-primary">{t('openLeadTracking')}</span>
                </div>
              </Link>
              <Link
                to="/follow-up?bucket=overdue"
                className="rounded-card border border-border p-5 hover:border-brand-primary/40 hover:shadow-card transition-all duration-150 group flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center text-red-500">
                    <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{t('overdueFollowUps')}</p>
                    <p className="text-xs text-slate-400">{t('overdueFollowUpsDesc')}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-red-600 tabular-nums">{formatCount(followUpCounts.overdue)}</p>
                  <span className="text-xs font-semibold text-slate-400 group-hover:text-brand-primary">{t('openOverdueQueue')}</span>
                </div>
              </Link>
            </div>
            <p className="flex items-center gap-2 text-xs text-slate-400 mt-4 border-t border-border pt-4">
              <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {t('attentionRulesLater')}
            </p>
          </section>

          {/* ============ H. Trend ============ */}
          <section className="card p-6">
            <SectionHeading title={t('trend')} desc={t('trendDesc')} />
            {(metrics?.trendData ?? []).length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title={t('noTrendData')}
                note={t('noTrendDataNote')}
              />
            ) : (
              <div className="space-y-2">
                {(metrics?.trendData ?? []).map((point) => (
                  <div key={point.date} className="flex items-center justify-between border-b border-border py-1.5">
                    <span className="text-sm text-slate-500">{point.date}</span>
                    <span className="text-sm font-bold text-brand-text tabular-nums">{formatCount(point.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ============ I. Team Performance ============ */}
          <section className="card p-6">
            <SectionHeading title={t('teamPerformance')} desc={t('teamPerformanceDesc')} />
            {(metrics?.teamStats ?? []).length === 0 ? (
              <EmptyState
                icon={Users}
                title={t('teamPerformanceUnavailable')}
                note={t('teamPerformanceNote')}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('team')}</th>
                      <th className="text-center">{t('assigned')}</th>
                      <th className="text-center">{t('collected')}</th>
                      <th className="text-center">{t('projected')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(metrics?.teamStats ?? []).map((row) => (
                      <tr key={row.team}>
                        <td className="font-semibold text-slate-700">{row.team}</td>
                        <td className="text-center text-slate-500 tabular-nums">{row.assigned}</td>
                        <td className="text-center text-slate-500 tabular-nums">{row.collected}</td>
                        <td className="text-center text-slate-500 tabular-nums">{row.projected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ============ J. Lead Status Distribution ============ */}
          <section className="card p-6">
            <SectionHeading title={t('leadStatusDistribution')} desc={t('leadStatusDistributionDesc')} />
            {distribution.length === 0 ? (
              <EmptyState icon={Layers} title={t('noStatusDistribution')} />
            ) : (
              <div className="space-y-3">
                {distribution.map((row) => {
                  const value = Number(row.value) || 0;
                  const pct = totalLeads > 0 ? Math.round((value / totalLeads) * 100) : 0;
                  return (
                    <div key={row.name} className="flex items-center gap-4">
                      <span className="w-36 shrink-0 text-sm font-semibold text-slate-600 truncate">{row.name}</span>
                      <div className="flex-1 h-4 bg-slate-100 rounded-control overflow-hidden">
                        <div
                          className="h-full rounded-control"
                          style={{ width: `${Math.max(2, (value / distributionMax) * 100)}%`, backgroundColor: row.color || '#978C21' }}
                        />
                      </div>
                      <span className="w-20 shrink-0 text-right text-sm font-bold text-slate-500 tabular-nums">{formatCount(value)}</span>
                      <span className="w-12 shrink-0 text-right text-xs font-semibold text-slate-400 tabular-nums">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ============ K. Task Calendar — final section ============ */}
          {canAccess('dashboard', 'view_task_calendar') && (
            <section className="card p-6 overflow-hidden">
              <SectionHeading title={t('taskCalendarTitle')} desc={t('taskCalendarSubtitle')} />
              <TaskCalendar embedded={true} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
