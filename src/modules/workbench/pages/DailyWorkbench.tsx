import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  History,
  ListTodo,
  Phone,
  RefreshCw,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { scheduledActivityService } from '../../scheduledActivities/services/scheduledActivityService';
import {
  WORKBENCH_SOURCE_LABEL,
  applyCancelledMutation,
  applyCompletedMutation,
  applyRescheduleMutation,
  filterWorkbenchItems,
  getWorkbenchFilterCounts,
  loadWorkbench,
  type WorkbenchData,
  type WorkbenchFilter,
  type WorkbenchItem,
} from '../services/workbenchService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';

/** -------------------------------------------------------------
 * Daily Workbench — focused daily lead execution workspace.
 *
 * "What do I need to execute today, and what can I complete quickly
 * from one place?" — NOT a dashboard, NOT a calendar, NOT a lead list.
 *
 * Data authority (three bounded parallel requests, no full lead list):
 *   GET /api/leads/follow-ups                     (bucket=all, limit 200)
 *   GET /api/scheduled-activities?from=today&to=tomorrow (limit 200)
 *   GET /api/scheduled-activities/completed-today
 * The server owns visibility and Asia/Dhaka business-day boundaries.
 * ------------------------------------------------------------- */

const TYPE_META = {
  call: { label: 'Call', icon: Phone, capsule: 'icon-capsule icon-capsule-blue' },
  meeting: { label: 'Meeting', icon: Video, capsule: 'icon-capsule icon-capsule-orange' },
  follow_up: { label: 'Follow-up', icon: History, capsule: 'icon-capsule icon-capsule-emerald' },
  task: { label: 'Task', icon: ClipboardCheck, capsule: 'icon-capsule icon-capsule-slate' },
} as const;

function formatDhakaTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '—';
  }
}

function formatDhakaDateLine(ymd: string | null): string {
  if (!ymd) return '';
  try {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 6)).toLocaleDateString('en-GB', {
      timeZone: 'Asia/Dhaka',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return ymd;
  }
}

/* ------------------------------------------------------------------
   Summary — compact actionable counts. Follow-up figures bind to the
   server's authoritative bucket counts; scheduled-type figures count
   the loaded daily page; Completed Today binds to the dedicated
   server count (null renders "—", never a fabricated zero).
------------------------------------------------------------------- */

export interface WorkbenchSummaryProps {
  overdueFollowUps: number;
  callsToday: number;
  meetingsToday: number;
  followUpsToday: number;
  tasksToday: number;
  /** null = source unavailable — renders "—" instead of a fake zero. */
  completedToday: number | null;
}

export function WorkbenchSummaryCards(props: WorkbenchSummaryProps) {
  const cards: Array<{ label: string; value: number | string; icon: React.ComponentType<{ className?: string }>; capsule: string }> = [
    { label: 'Overdue Follow-ups', value: props.overdueFollowUps, icon: AlertTriangle, capsule: 'icon-capsule icon-capsule-red' },
    { label: 'Calls Today', value: props.callsToday, icon: Phone, capsule: 'icon-capsule icon-capsule-blue' },
    { label: 'Meetings Today', value: props.meetingsToday, icon: Video, capsule: 'icon-capsule icon-capsule-orange' },
    { label: 'Follow-ups Today', value: props.followUpsToday, icon: History, capsule: 'icon-capsule icon-capsule-emerald' },
    { label: 'Tasks Today', value: props.tasksToday, icon: ClipboardCheck, capsule: 'icon-capsule icon-capsule-slate' },
    {
      label: 'Completed Today',
      value: props.completedToday === null ? '—' : props.completedToday,
      icon: CheckCircle2,
      capsule: 'icon-capsule icon-capsule-olive',
    },
  ];
  return (
    <section aria-label="Daily summary" className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="kpi-card" style={{ minHeight: 0 }}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-stone-500 truncate">{card.label}</p>
            <div className={card.capsule}>
              <card.icon className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-black tracking-tight leading-none text-brand-text">{card.value}</p>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------
   Quick filters — pure client-side over the loaded daily work set.
------------------------------------------------------------------- */

const FILTER_ORDER: Array<{ id: WorkbenchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'call', label: 'Calls' },
  { id: 'meeting', label: 'Meetings' },
  { id: 'follow_up', label: 'Follow-ups' },
  { id: 'task', label: 'Tasks' },
];

export function WorkbenchFilterChips({
  active,
  counts,
  onChange,
}: {
  active: WorkbenchFilter;
  counts: Record<WorkbenchFilter, number>;
  onChange: (filter: WorkbenchFilter) => void;
}) {
  return (
    <div role="tablist" aria-label="Quick filters" className="flex flex-wrap items-center gap-2">
      {FILTER_ORDER.map((f) => {
        const isActive = active === f.id;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(f.id)}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-bold border transition-all duration-150',
              isActive
                ? 'bg-[#978C21] text-white border-[#978C21] shadow-sm'
                : 'bg-white text-stone-600 border-stone-200 hover:border-[#978C21]/40 hover:text-[#978C21]'
            )}
          >
            {f.label}
            <span
              className={cn(
                'min-w-[20px] text-center px-1.5 py-0.5 rounded-full text-[10px] font-black',
                isActive ? 'bg-white/20 text-white' : 'bg-stone-100 text-stone-500'
              )}
            >
              {counts[f.id] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------
   Queue rows — compact; tap a row to expand its quick-action area.
------------------------------------------------------------------- */

export interface WorkbenchRowActions {
  onComplete: (item: WorkbenchItem) => void;
  onCancel: (item: WorkbenchItem) => void;
  onReschedule: (item: WorkbenchItem) => void;
  onOpenLead: (item: WorkbenchItem) => void;
}

export function WorkbenchQueueRow({
  item,
  selected,
  canEdit,
  acting,
  onSelect,
  actions,
}: {
  item: WorkbenchItem;
  selected: boolean;
  canEdit: boolean;
  acting: boolean;
  onSelect: (item: WorkbenchItem) => void;
  actions: WorkbenchRowActions;
}) {
  const meta = TYPE_META[item.activityType] || TYPE_META.task;
  const isOverdue = item.dueState === 'overdue';
  const isScheduledSource = item.source === 'scheduled_activity';
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-selected={selected}
        aria-expanded={selected}
        data-workbench-item={item.key}
        onClick={() => onSelect(item)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(item);
          }
        }}
        className={cn(
          'w-full text-left flex items-center gap-3 px-4 py-3 rounded-[10px] border cursor-pointer transition-all duration-150',
          selected ? 'border-[#978C21]/50 bg-[#FFFCF8]' : 'border-stone-100 hover:border-[#978C21]/30 hover:bg-[#FFFCF8]',
          isOverdue && !selected && 'border-red-200/70 bg-red-50/40'
        )}
      >
        <div className={meta.capsule}>
          <meta.icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-semibold text-stone-800 truncate">{item.name}</p>
            {isOverdue && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 border border-red-200 text-red-700 text-[10px] font-black uppercase tracking-wider shrink-0">
                <AlertTriangle className="w-3 h-3" />
                Overdue{typeof item.overdueDays === 'number' && item.overdueDays > 0 ? ` ${item.overdueDays}d` : ''}
              </span>
            )}
          </div>
          <p className="text-[11px] text-stone-400 mt-0.5 truncate">
            {meta.label}
            {item.title ? ` · ${item.title}` : ''}
            {item.assignee ? ` · ${item.assignee}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn('hidden sm:inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', meta.capsule)}>
            {WORKBENCH_SOURCE_LABEL[item.activityType]}
          </span>
          {item.leadStatus && (
            <span className={cn('hidden md:inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', getLeadStatusColorClasses(item.leadStatus))}>
              {item.leadStatus}
            </span>
          )}
          <span className="text-[11px] font-bold text-stone-500 tabular-nums w-14 text-right" title="Due time (Asia/Dhaka)">
            {formatDhakaTime(item.scheduledAt)}
          </span>
          <ChevronRight className={cn('w-4 h-4 text-stone-300 transition-transform duration-150', selected && 'rotate-90 text-[#978C21]')} />
        </div>
      </div>

      {selected && (
        <div className="mx-1 mb-1 px-4 py-3 rounded-b-[10px] border border-t-0 border-[#978C21]/30 bg-[#FFFCF8] flex flex-wrap items-center gap-2" data-workbench-actions={item.key}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.onOpenLead(item);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-[#978C21] text-white text-xs font-bold hover:bg-[#8a7f1e] transition-colors"
          >
            Open Lead <ChevronRight className="w-3.5 h-3.5" />
          </button>
          {isScheduledSource && canEdit && (
            <>
              <button
                type="button"
                disabled={acting}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onComplete(item);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Complete
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onReschedule(item);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-white border border-stone-200 text-stone-600 text-xs font-bold hover:border-[#978C21]/40 hover:text-[#978C21] transition-colors disabled:opacity-50"
              >
                <Clock className="w-3.5 h-3.5" /> Reschedule
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onCancel(item);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-white border border-red-200 text-red-600 text-xs font-bold hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </>
          )}
          {!isScheduledSource && (
            <p className="text-[11px] text-stone-400">Complete or update this follow-up from Lead360.</p>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------
   Neutral states — honest copy, no fabricated congratulations.
------------------------------------------------------------------- */

export function WorkbenchEmptyState() {
  return (
    <div className="empty-state" data-testid="workbench-empty">
      <div className="icon-capsule icon-capsule-olive mb-3">
        <CheckCircle2 className="w-5 h-5" />
      </div>
      <p className="text-sm font-bold text-stone-700">You're clear for today</p>
      <p className="text-[12px] text-stone-500 mt-1.5">No overdue follow-ups or scheduled activities are currently due.</p>
      <Link
        to="/task-calendar"
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-[#978C21] text-white text-xs font-bold hover:bg-[#8a7f1e] transition-colors"
      >
        <CalendarIcon className="w-3.5 h-3.5" /> Open Calendar
      </Link>
    </div>
  );
}

export function WorkbenchErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-[12px] px-5 py-4" data-testid="workbench-error">
      <div className="flex items-center gap-3 text-red-700">
        <AlertTriangle className="w-5 h-5" />
        <div>
          <p className="text-sm font-semibold">Daily work could not be loaded.</p>
          <p className="text-xs text-red-500 mt-0.5">Please try again.</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-[10px]"
      >
        Retry
      </button>
    </div>
  );
}

export function WorkbenchPartialDataBanner({ errors }: { errors: WorkbenchData['errors'] }) {
  const failed: string[] = [];
  if (errors.followUps) failed.push('the follow-up queue');
  if (errors.scheduled) failed.push('scheduled activities');
  if (errors.completedToday) failed.push('the completed-today count');
  if (failed.length === 0) return null;
  return (
    <div role="status" className="bg-amber-50 border border-amber-200 rounded-[12px] px-5 py-3 text-[12px] text-amber-800" data-testid="workbench-partial">
      <span className="font-bold">Partial data.</span> Could not load {failed.join(' and ')} — the missing
      {failed.length > 1 ? ' sources are' : ' source is'} shown as unavailable, not as zero.
    </div>
  );
}

export function WorkbenchTomorrowPreview({ preview }: { preview: WorkbenchData['tomorrow'] }) {
  const entries: Array<{ label: string; value: number; icon: React.ComponentType<{ className?: string }> }> = [
    { label: 'Calls', value: preview.calls, icon: Phone },
    { label: 'Meetings', value: preview.meetings, icon: Video },
    { label: 'Follow-ups', value: preview.followUps, icon: History },
    { label: 'Tasks', value: preview.tasks, icon: ClipboardCheck },
  ];
  return (
    <section className="bg-white rounded-[12px] border border-stone-100 p-5" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }} aria-label="Tomorrow preview">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] font-black uppercase tracking-widest text-stone-400">Tomorrow Preview</h2>
        <Link to="/task-calendar" className="text-[11px] font-semibold text-[#978C21] hover:underline">
          Open Calendar
        </Link>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {entries.map((entry) => (
          <div key={entry.label} className="flex items-center justify-between gap-2 rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-3 py-2">
            <dt className="text-[11px] font-semibold text-stone-500 flex items-center gap-1.5">
              <entry.icon className="w-3.5 h-3.5 text-[#978C21]" />
              {entry.label}
            </dt>
            <dd className="text-sm font-bold text-brand-text">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------
   Reschedule — reuses scheduledActivityService.update (PUT), the same
   datetime-local → ISO semantics as Lead360. No second write path.
------------------------------------------------------------------- */

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WorkbenchRescheduleModal({
  item,
  saving,
  onSave,
  onClose,
}: {
  item: WorkbenchItem;
  saving: boolean;
  onSave: (iso: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => toDatetimeLocalValue(item.scheduledAt));
  return (
    <div className="modal-overlay" role="dialog" aria-label="Reschedule activity" data-testid="workbench-reschedule" onClick={onClose}>
      <div className="modal-content w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-stone-800">Reschedule {WORKBENCH_SOURCE_LABEL[item.activityType]}</h3>
            <p className="text-[11px] text-stone-400 mt-0.5 truncate">{item.name}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-stone-50" aria-label="Close">
            <X className="w-4 h-4 text-stone-400" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold text-stone-500">New date &amp; time</span>
            <input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="input-standard"
              autoFocus
            />
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !value}
              onClick={() => {
                const d = new Date(value);
                if (!Number.isNaN(d.getTime())) onSave(d.toISOString());
              }}
              className="btn-primary"
            >
              {saving ? 'Saving…' : 'Save New Time'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Loading state — skeletons with role=status. Distinct from the empty
   state so a still-loading page can never read as "clear for today".
------------------------------------------------------------------- */

export function WorkbenchLoadingState() {
  return (
    <div role="status" aria-label="Loading daily work" className="space-y-4" data-testid="workbench-loading">
      <span className="sr-only">Loading daily work…</span>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="kpi-card animate-pulse" style={{ minHeight: 0 }}>
            <div className="h-3 w-16 bg-stone-100 rounded mb-3" />
            <div className="h-6 w-10 bg-stone-100 rounded" />
          </div>
        ))}
      </div>
      <div className="bg-white rounded-[12px] border border-stone-100 p-5 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 bg-stone-100 rounded-[10px] animate-pulse" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Page
------------------------------------------------------------------- */

export default function DailyWorkbench() {
  const navigate = useNavigate();
  const { canAccess } = usePermissions();
  // The server requires leads.edit for complete/cancel/update of scheduled
  // activities — only surface those actions when the user holds the same
  // capability. Follow-up items always keep their Open Lead action.
  const canEditActivities = canAccess('lead_tracking', 'edit');

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [filter, setFilter] = useState<WorkbenchFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const [rescheduleItem, setRescheduleItem] = useState<WorkbenchItem | null>(null);
  const [rescheduleSaving, setRescheduleSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await loadWorkbench();
      setData(result);
      const bothPrimaryFailed = result.errors.followUps && result.errors.scheduled;
      setLoadFailed(bothPrimaryFailed);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleItems = useMemo(() => (data ? filterWorkbenchItems(data.queue, filter) : []), [data, filter]);
  const filterCounts = useMemo(() => (data ? getWorkbenchFilterCounts(data.queue) : null), [data]);
  const todayScheduledByType = useMemo(() => {
    const counts = { call: 0, meeting: 0, follow_up: 0, task: 0 } as Record<string, number>;
    for (const item of data?.queue ?? []) {
      if (item.source === 'scheduled_activity' && item.dueState !== 'invalid-time') counts[item.activityType] += 1;
    }
    return counts;
  }, [data]);

  const selectItem = (item: WorkbenchItem) => {
    setSelectedKey((prev) => (prev === item.key ? null : item.key));
  };

  const openLead = (item: WorkbenchItem) => {
    navigate(`/leads/${encodeURIComponent(item.leadId)}`);
  };

  const handleComplete = async (item: WorkbenchItem) => {
    setActingKey(item.key);
    try {
      const res: any = await scheduledActivityService.complete((item.raw as any).id);
      const updated = res?.scheduled || res?.data?.scheduled;
      const completedAt = updated?.completedAt || updated?.completed_at || null;
      // Efficient local update from the SERVER-confirmed response — no refetch.
      setData((prev) => (prev ? applyCompletedMutation(prev, item.key, completedAt) : prev));
      setSelectedKey((prev) => (prev === item.key ? null : prev));
      toast.success('Activity completed');
    } catch (err: any) {
      toast.error(err?.message || 'Complete failed');
    } finally {
      setActingKey(null);
    }
  };

  const handleCancel = async (item: WorkbenchItem) => {
    setActingKey(item.key);
    try {
      await scheduledActivityService.cancel((item.raw as any).id);
      setData((prev) => (prev ? applyCancelledMutation(prev, item.key) : prev));
      setSelectedKey((prev) => (prev === item.key ? null : prev));
      toast.success('Activity cancelled');
    } catch (err: any) {
      toast.error(err?.message || 'Cancel failed');
    } finally {
      setActingKey(null);
    }
  };

  const handleRescheduleSave = async (iso: string) => {
    if (!rescheduleItem) return;
    setRescheduleSaving(true);
    try {
      const updated: any = await scheduledActivityService.update((rescheduleItem.raw as any).id, { scheduledAt: iso });
      const row = updated?.data || updated;
      const nextAt = row?.scheduledAt || row?.scheduled_at || iso;
      setData((prev) => (prev ? applyRescheduleMutation(prev, rescheduleItem.key, nextAt) : prev));
      setRescheduleItem(null);
      toast.success('Activity rescheduled');
    } catch (err: any) {
      toast.error(err?.message || 'Reschedule failed');
    } finally {
      setRescheduleSaving(false);
    }
  };

  const primaryLoading = loading;
  const hasData = Boolean(data);
  const queueEmpty = Boolean(data && data.queue.length === 0);

  return (
    <div className="space-y-6 pb-16 font-sans">
      {/* ---- Page header ---- */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white p-6 rounded-[12px] border border-stone-100" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div className="flex items-center gap-4">
          <div className="icon-capsule icon-capsule-olive w-12 h-12">
            <ListTodo className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight leading-none text-brand-text">Daily Workbench</h1>
            <p className="text-[13px] text-stone-500 mt-2 leading-relaxed">Manage today's calls, meetings, follow-ups and tasks from one place.</p>
            {data?.todayYmd && (
              <p className="text-[11px] text-stone-400 mt-1.5 font-medium">{formatDhakaDateLine(data.todayYmd)}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/task-calendar"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-stone-200 rounded-[10px] text-xs font-bold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors"
          >
            <CalendarIcon className="w-3.5 h-3.5" /> Open Calendar
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors disabled:opacity-50 bg-white"
            aria-label="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {primaryLoading ? (
        <WorkbenchLoadingState />
      ) : loadFailed || !hasData ? (
        <WorkbenchErrorState onRetry={() => void load()} />
      ) : (
        <>
          {data && <WorkbenchPartialDataBanner errors={data.errors} />}

          {/* ---- Daily summary ---- */}
          <WorkbenchSummaryCards
            overdueFollowUps={data?.followUpCounts.overdue ?? 0}
            callsToday={todayScheduledByType.call}
            meetingsToday={todayScheduledByType.meeting}
            followUpsToday={data?.followUpCounts.today ?? 0}
            tasksToday={todayScheduledByType.task}
            completedToday={data?.completedToday ?? null}
          />

          {/* ---- Quick filters ---- */}
          {filterCounts && <WorkbenchFilterChips active={filter} counts={filterCounts} onChange={setFilter} />}

          {/* ---- Execution queue ---- */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-5" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }} aria-label="Execution queue">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-black uppercase tracking-widest text-stone-400">Execution Queue</h2>
              <span className="text-[11px] font-bold text-stone-400 bg-stone-50 px-2 py-0.5 rounded-full border border-stone-100">
                {visibleItems.length}{filter !== 'all' ? ` of ${data?.queue.length ?? 0}` : ''}
              </span>
            </div>
            {queueEmpty ? (
              <WorkbenchEmptyState />
            ) : visibleItems.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-stone-200 px-4 py-6 text-[13px] text-stone-400 text-center bg-[#FFFCF8]">
                No items match this filter.
              </div>
            ) : (
              <ol className="space-y-2" aria-label="Daily execution queue">
                {visibleItems.map((item) => (
                  <li key={item.key}>
                    <WorkbenchQueueRow
                      item={item}
                      selected={selectedKey === item.key}
                      canEdit={canEditActivities}
                      acting={actingKey === item.key}
                      onSelect={selectItem}
                      actions={{
                        onComplete: (i) => void handleComplete(i),
                        onCancel: (i) => void handleCancel(i),
                        onReschedule: setRescheduleItem,
                        onOpenLead: openLead,
                      }}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ---- Tomorrow preview (counts only — Task Calendar owns planning) ---- */}
          {data && <WorkbenchTomorrowPreview preview={data.tomorrow} />}
        </>
      )}

      {rescheduleItem && (
        <WorkbenchRescheduleModal
          item={rescheduleItem}
          saving={rescheduleSaving}
          onSave={(iso) => void handleRescheduleSave(iso)}
          onClose={() => setRescheduleItem(null)}
        />
      )}
    </div>
  );
}
