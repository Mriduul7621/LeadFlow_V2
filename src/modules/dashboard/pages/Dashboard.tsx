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
import TaskCalendar from '../../auth/pages/TaskCalendar';

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

// ---- Pipeline stages ------------------------------------------------
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

// ---- Follow-up Discipline compact card -----------------------------
function FollowUpDiscipline({ overdue, dueToday, upcoming, total }: { overdue: number; dueToday: number; upcoming: number; total: number }) {
  const overdueShare = total > 0 ? Math.round((overdue / total) * 100) : 0;
  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading title="Follow-up Discipline" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-[12px] border p-5 flex items-center justify-between group-hover:shadow-md group-hover:-translate-y-0.5 transition-all duration-150">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600" />
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-red-600">Overdue</p>
              <p className="text-2xl font-black text-red-600 mt-1">{formatCount(overdue)}</p>
            </div>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-400">{overdueShare}% share</span>
        </div>
        <div className="rounded-[12px] border p-5 flex items-center justify-between group-hover:shadow-md group-hover:-translate-y-0.5 transition-all duration-150">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-amber-600" />
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-amber-600">Due Today</p>
              <p className="text-2xl font-black text-amber-600 mt-1">{formatCount(dueToday)}</p>
            </div>
          </div>
        </div>
        <div className="rounded-[12px] border p-5 flex items-center justify-between group-hover:shadow-md group-hover:-translate-y-0.5 transition-all duration-150">
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-blue-600" />
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-blue-600">Upcoming</p>
              <p className="text-2xl font-black text-blue-600 mt-1">{formatCount(upcoming)}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 text-right">
        <Link to="/follow-up" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
          <History className="w-3.5 h-3.5" /> Open Full Queue <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  );
}

// ---- Needs Attention compact rows ----------------------------------
function NeedsAttention({ untouched, overdueFollowUps }: { untouched: number; overdueFollowUps: number }) {
  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading title="Needs Attention" />
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
              <p className="text-sm font-semibold text-stone-800">Untouched Leads</p>
              <p className="text-[12px] text-stone-400">Leads with no engagement yet</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black text-brand-text">{formatCount(untouched)}</p>
            <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">Open Lead Tracking</span>
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
              <p className="text-sm font-semibold text-stone-800">Overdue Follow-ups</p>
              <p className="text-[12px] text-stone-400">Follow-ups past due date</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black text-red-600">{formatCount(overdueFollowUps)}</p>
            <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">Open Overdue Queue</span>
          </div>
        </Link>
      </div>
      <p className="flex items-center gap-2 text-[12px] text-stone-400 mt-4 border-t border-stone-100 pt-4">
        <Info className="w-3.5 h-3.5 shrink-0" /> Additional attention rules coming in a later phase.
      </p>
    </section>
  );
}

// ---- Today & Tomorrow panel -----------------------------------------
function TodayTomorrowPanel({ todayFollowUps, tomorrowFollowUps, todayScheduled, tomorrowScheduled }: {
  todayFollowUps: FollowUpQueueItem[];
  tomorrowFollowUps: FollowUpQueueItem[];
  todayScheduled: ScheduledActivity[];
  tomorrowScheduled: ScheduledActivity[];
}) {
  const dhakaToday = getDhakaTodayYmd();
  const tomorrowYmd = (() => {
    const base = parseYmdToDate(dhakaToday)!;
    const next = new Date(base);
    next.setDate(base.getDate() + 1);
    return formatYmd(next);
  })();

  const renderActivityList = (items: FollowUpQueueItem[], title: string) => {
    if (items.length === 0 && title === 'Today' && todayScheduled.length === 0) return null;
    if (items.length === 0 && title === 'Tomorrow' && tomorrowScheduled.length === 0) return null;
    return (
      <div className="space-y-3">
        {items.slice(0, 6).map((item) => (
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
                Follow-up · {formatDhakaDue(item.nextFollowUpAt)}
              </p>
            </div>
            <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0', getLeadStatusColorClasses(item.currentStatus))}>
              {item.currentStatus}
            </span>
          </Link>
        ))}
        {(title === 'Today' ? todayScheduled : tomorrowScheduled).slice(0, 6).map((sa) => {
          const typeKey = String(sa.activityType).toLowerCase();
          const typeLabel =
            typeKey === 'call' ? 'Call' : typeKey === 'meeting' ? 'Meeting' : typeKey === 'task' ? 'Task' : 'Follow-up';
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
    );
  };

  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
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
        {[
          { label: 'Today', followUps: todayFollowUps, scheduled: todayScheduled },
          { label: 'Tomorrow', followUps: tomorrowFollowUps, scheduled: tomorrowScheduled },
        ].map((group) => (
          <div key={group.label}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-black uppercase tracking-widest text-stone-400">{group.label}</p>
              <span className="text-[11px] font-bold text-stone-400 bg-stone-50 px-2 py-0.5 rounded-full border border-stone-100">
                {group.followUps.length + group.scheduled.length}
              </span>
            </div>
            {group.followUps.length === 0 && group.scheduled.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-stone-200 px-4 py-6 text-[13px] text-stone-400 text-center bg-[#FFFCF8]">
                {group.label === 'Today' ? 'No activities scheduled for today' : 'No activities scheduled for tomorrow'}
              </div>
            ) : (
              <div className="space-y-2">
                {renderActivityList(group.followUps, group.label)}
                {group.scheduled.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-stone-100">
                    <p className="text-[11px] font-black uppercase tracking-widest text-stone-400">Scheduled Activities</p>
                    {group.scheduled.slice(0, 6).map((sa) => {
                      const typeKey = String(sa.activityType).toLowerCase();
                      const typeLabel =
                        typeKey === 'call' ? 'Call' : typeKey === 'meeting' ? 'Meeting' : typeKey === 'task' ? 'Task' : 'Follow-up';
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
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Sales Pipeline -------------------------------------------------
function SalesPipeline({ statusCounts, totalLeads }: { statusCounts: Record<string, number>; totalLeads: number }) {
  const pipelineStages = PIPELINE_STAGES.map((stage) => {
    const count = Number((statusCounts as any)[stage] || 0);
    const pct = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
    return { stage, count, pct };
  });

  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading title="Sales Pipeline" desc="Track leads across each sales stage" />
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
            <p className="text-[10px] font-semibold text-stone-400 mt-2">{s.pct}% of leads</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Executive Snapshot ---------------------------------------------
function ExecutiveSnapshot({ totalLeads, conversionRate, collectedNCP, projectedNCP, activeLeads, overdueFollowUps }: {
  totalLeads: number;
  conversionRate: string;
  collectedNCP: string;
  projectedNCP: string;
  activeLeads: number;
  overdueFollowUps: number;
}) {
  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading title="Executive Snapshot" />
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Total Leads" value={formatCount(totalLeads)} icon={Users} variant="blue" />
        <KpiCard label="Conversion Rate" value={conversionRate} icon={Percent} variant="slate" />
        <KpiCard label="Collected NCP" value={collectedNCP} icon={Banknote} variant="emerald" />
        <KpiCard label="Projected NCP" value={projectedNCP} icon={TrendingUp} variant="olive" />
        <KpiCard label="Active Leads" value={formatCount(activeLeads)} icon={Layers} variant="blue" sub={`${formatCount(activeLeads > 0 ? 0 : 0)} Pipeline Locked`} />
      </div>
      {/* Overdue Follow-ups shown as a compact callout under the KPI grid */}
      <div className="mt-4 rounded-[12px] border border-red-200 bg-red-50 p-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-red-600">Overdue Follow-ups</p>
            <p className="text-2xl font-black text-red-600 mt-1">{formatCount(overdueFollowUps)}</p>
          </div>
        </div>
      </div>
    </section>
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

// ---- Needs Attention ------------------------------------------------
function NeedsAttentionSection({ untouched, overdueFollowUps }: { untouched: number; overdueFollowUps: number }) {
  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <SectionHeading title="Needs Attention" />
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
              <p className="text-sm font-semibold text-stone-800">Untouched Leads</p>
              <p className="text-[12px] text-stone-400">Leads with no engagement yet</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black text-brand-text">{formatCount(untouched)}</p>
            <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">Open Lead Tracking</span>
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
              <p className="text-sm font-semibold text-stone-800">Overdue Follow-ups</p>
              <p className="text-[12px] text-stone-400">Follow-ups past due date</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black text-red-600">{formatCount(overdueFollowUps)}</p>
            <span className="text-[11px] font-bold text-stone-400 group-hover:text-[#978C21]">Open Overdue Queue</span>
          </div>
        </Link>
      </div>
      <p className="flex items-center gap-2 text-[12px] text-stone-400 mt-4 border-t border-stone-100 pt-4">
        <Info className="w-3.5 h-3.5 shrink-0" /> Additional attention rules coming in a later phase.
      </p>
    </section>
  );
}

// ============================================================
// Dashboard main component
// ============================================================
export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const canCreateLead = canAccess('lead_generate', 'create');

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

  const loadDashboardData = useCallback(async () => {
    if (!user) return;
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
    }
  }, [user, period, customStart, customEnd]);

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
          <h1 className="text-2xl font-black tracking-tight leading-none text-brand-text">Dashboard</h1>
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
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-[10x] bg-[#978C21] text-white text-xs font-bold shadow-sm hover:bg-[#8a7f1e] focus:outline-none focus:ring-2 focus:ring-[#978C21]/30 transition-all duration-150"
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

          {/* ==== Executive Snapshot ==== */}
          <ExecutiveSnapshot
            totalLeads={totalLeads}
            conversionRate={metrics?.conversionRate || '0.0%'}
            collectedNCP={formatMoney(metrics?.collected ?? 0)}
            projectedNCP={formatMoney(metrics?.projected ?? 0)}
            activeLeads={metrics?.activeLeads ?? 0}
            overdueFollowUps={followUpCounts.overdue}
          />

          {/* ==== Today & Tomorrow ==== */}
          <TodayTomorrowPanel
            todayFollowUps={todayFollowUps}
            tomorrowFollowUps={tomorrowFollowUps}
            todayScheduled={todayScheduled}
            tomorrowScheduled={tomorrowScheduled}
          />

          {/* ==== Sales Pipeline ==== */}
          <SalesPipeline statusCounts={statusCounts} totalLeads={totalLeads} />

          {/* ==== Follow-up Discipline ==== */}
          <FollowUpDiscipline
            overdue={followUpCounts.overdue}
            dueToday={followUpCounts.today}
            upcoming={followUpCounts.upcoming}
            total={followUpCounts.all}
          />

          {/* ==== Needs Attention ==== */}
          <NeedsAttentionSection
            untouched={(statusCounts as any).Untouched}
            overdueFollowUps={followUpCounts.overdue}
          />

          {/* ==== Performance Insights ==== */}
          <PerformanceInsights
            trendData={metrics?.trendData}
            teamStats={metrics?.teamStats}
          />

          {/* ==== Task Calendar (last section) ==== */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6 overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <SectionHeading title="Task Calendar" desc="Planned activities for today and tomorrow" />
            <div className="sr-only">Task Calendar</div>
            <TaskCalendar embedded={true} />
            <div className="mt-4 flex justify-end">
              <Link to="/task-calendar" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
                Open Calendar <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </section>

        </>
      )}
    </div>
  );
}