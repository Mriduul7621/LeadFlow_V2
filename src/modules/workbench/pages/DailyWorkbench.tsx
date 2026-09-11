import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  History,
  Phone,
  Video,
  ClipboardCheck,
  RefreshCw,
  ExternalLink,
  X,
  Ban,
  Edit3,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import { toast } from 'sonner';

/** ------------------------------------------------------------
 * Daily Workbench — focused daily lead execution workspace.
 * Server-authoritative: follow-ups from GET /api/leads/follow-ups,
 * scheduled work from GET /api/scheduled-activities (Asia/Dhaka).
 * No full lead list fetch, no N+1 lead detail fetches.
 * ------------------------------------------------------------ */

// ---- Dhaka business time helpers (reuse Dashboard semantics) ----
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
function isDhakaYmd(iso: string, ymd: string): boolean {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return false;
    const asYmd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    return asYmd === ymd;
  } catch {
    return false;
  }
}
function formatDhakaDue(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso || '—';
  }
}
function parseTimeSort(iso: string | null | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

// ---- Work item composition ----
// No heuristic cross-source deduplication: IDs are namespaced by source.
// Follow-up queue IDs identify leads; scheduled_activities IDs identify
// independent planned activities. Neither contract supplies a shared
// logical link, so equal lead IDs, names or timestamps are NOT proof
// they are the same work item. Only exact shared identifier would merge,
// which does not exist in current APIs. Keep them distinct.

type WorkItemSource = 'follow_up' | 'scheduled';
type WorkItemType = 'call' | 'meeting' | 'follow_up' | 'task';

interface WorkItem {
  key: string; // namespaced: follow_up:<leadId> or scheduled:<activityId>
  id: string; // original id (leadId for follow-up, activityId for scheduled)
  source: WorkItemSource;
  type: WorkItemType;
  leadId: string;
  leadName: string;
  leadStatus: string | null;
  title: string | null;
  scheduledAt: string | null; // ISO for scheduled, nextFollowUpAt for follow-up
  overdue: boolean;
  dueState: string | null;
  assigneeName: string | null;
  raw: FollowUpQueueItem | ScheduledActivity;
  sortTime: number;
}

function toWorkItems(
  followUps: FollowUpQueueItem[],
  scheduledToday: ScheduledActivity[],
  todayYmd: string,
): WorkItem[] {
  const items: WorkItem[] = [];

  for (const fu of followUps) {
    // Only overdue + today should enter today's execution queue.
    // Upcoming (including tomorrow) is excluded from today's queue.
    // The caller must pre-filter to overdue+today.
    const dueState = String(fu.dueState || '').toLowerCase();
    const isOverdue = dueState === 'overdue';
    const iso = fu.nextFollowUpAt || null;
    items.push({
      key: `follow_up:${fu.id}`,
      id: fu.id,
      source: 'follow_up',
      type: 'follow_up',
      leadId: fu.id,
      leadName: fu.prospectName || fu.customerName || 'Follow-up',
      leadStatus: fu.currentStatus || null,
      title: null,
      scheduledAt: iso,
      overdue: isOverdue,
      dueState: fu.dueState || null,
      assigneeName: fu.assignedEmployeeName || fu.assignedTo || null,
      raw: fu,
      sortTime: parseTimeSort(iso),
    });
  }

  for (const sa of scheduledToday) {
    if (String(sa.status).toLowerCase() !== 'scheduled') continue;
    // Ensure it is today in Dhaka (caller should already filter, but double-guard)
    if (!isDhakaYmd(sa.scheduledAt, todayYmd)) continue;
    const type = (sa.activityType || (sa as any).activity_type || 'task') as WorkItemType;
    const normalized: WorkItemType = type === 'call' || type === 'meeting' || type === 'follow_up' || type === 'task' ? type : 'task';
    items.push({
      key: `scheduled:${sa.id}`,
      id: sa.id,
      source: 'scheduled',
      type: normalized,
      leadId: sa.leadId || (sa as any).lead_id,
      leadName: sa.leadCustomerName || sa.title || normalized,
      leadStatus: (sa as any).leadStatus || null,
      title: sa.title || null,
      scheduledAt: sa.scheduledAt || null,
      overdue: false,
      dueState: null,
      assigneeName: null,
      raw: sa,
      sortTime: parseTimeSort(sa.scheduledAt),
    });
  }

  // Sort: overdue first, then chronological today, invalid last
  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
    return 0;
  });

  return items;
}

// ---- UI helpers ----
const TYPE_META: Record<WorkItemType, { label: string; icon: any; badge: string; tone: string }> = {
  call: { label: 'Call', icon: Phone, badge: 'Call', tone: 'bg-sky-50 border-sky-200 text-sky-700' },
  meeting: { label: 'Meeting', icon: Video, badge: 'Meeting', tone: 'bg-amber-50 border-amber-200 text-amber-700' },
  follow_up: { label: 'Follow-up', icon: History, badge: 'Follow-up', tone: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  task: { label: 'Task', icon: ClipboardCheck, badge: 'Task', tone: 'bg-purple-50 border-purple-200 text-purple-700' },
};

function SummaryCard({
  label,
  value,
  icon: Icon,
  variant = 'default',
  sub,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  variant?: 'default' | 'blue' | 'orange' | 'emerald' | 'red' | 'olive' | 'slate';
  sub?: string;
}) {
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
    <div className={cn(variantClass[variant] || variantClass.default)}>
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

type FilterKey = 'all' | 'overdue' | 'call' | 'meeting' | 'follow_up' | 'task';

export default function DailyWorkbench() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [scheduledError, setScheduledError] = useState<string | null>(null);

  const [overdueFollowUps, setOverdueFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [todayFollowUps, setTodayFollowUps] = useState<FollowUpQueueItem[]>([]);
  const [tomorrowFollowUps, setTomorrowFollowUps] = useState<FollowUpQueueItem[]>([]);

  const [scheduledToday, setScheduledToday] = useState<ScheduledActivity[]>([]);
  const [scheduledTomorrow, setScheduledTomorrow] = useState<ScheduledActivity[]>([]);
  const [completedToday, setCompletedToday] = useState<ScheduledActivity[]>([]);
  const [completedTodayError, setCompletedTodayError] = useState<string | null>(null);

  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Edit modal state
  const [editing, setEditing] = useState<ScheduledActivity | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; scheduledAt: string; remarks: string }>({ title: '', scheduledAt: '', remarks: '' });

  // Permission: scheduled activity mutations (Complete/Cancel/Edit/Reschedule)
  // Server boundary is `leads.edit` (checked in production.routes.ts for
  // POST /scheduled-activities/:id/complete, /cancel, PUT /:id, DELETE /:id).
  // UI mapping is lead_tracking.edit -> leads.edit (via usePermissions
  // featurePathMapping + permissionModule mapping). Dashboard view must NOT
  // grant mutation capability. No new permission architecture.
  const canEditScheduled = canAccess('lead_tracking', 'edit');

  const todayYmd = useMemo(() => getDhakaTodayYmd(), []);
  const tomorrowYmd = useMemo(() => {
    const base = parseYmdToDate(todayYmd);
    if (!base) return todayYmd;
    const next = new Date(base);
    next.setDate(base.getDate() + 1);
    return formatYmd(next);
  }, [todayYmd]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    setFollowUpError(null);
    setScheduledError(null);
    setCompletedTodayError(null);
    try {
      // Bounded authoritative sources: follow-ups + scheduled activities
      // No full lead list fetch, no N+1.
      const [followUpAllRes, scheduledRangeRes, completedRes] = await Promise.allSettled([
        // Follow-ups: all buckets (overdue/today/upcoming) in one bounded request
        leadService.getFollowUpQueue({ bucket: 'all', limit: 200 }),
        // Scheduled: today + tomorrow (scheduled_at range, all statuses)
        scheduledActivityService.list({ from: todayYmd, to: tomorrowYmd, limit: 200 }),
        // Completed today: status completed, filter completed_at client-side
        scheduledActivityService.list({ status: 'completed', limit: 100 }),
      ]);

      // Follow-ups
      if (followUpAllRes.status === 'fulfilled') {
        const allItems = followUpAllRes.value.items || [];
        const overdue = allItems.filter(i => String(i.dueState).toLowerCase() === 'overdue');
        const today = allItems.filter(i => String(i.dueState).toLowerCase() === 'today');
        // Tomorrow: upcoming items whose nextFollowUpAt falls on tomorrowYmd in Dhaka
        const upcoming = allItems.filter(i => String(i.dueState).toLowerCase() === 'upcoming' || String(i.dueState).toLowerCase() === 'today' || String(i.dueState).toLowerCase() === 'overdue');
        // For tomorrow, use bounds if available, else Dhaka YMD check
        const tomorrowStart = followUpAllRes.value.bounds?.tomorrowStart ? new Date(followUpAllRes.value.bounds.tomorrowStart).getTime() : null;
        let tomorrow: FollowUpQueueItem[] = [];
        if (tomorrowStart != null) {
          const tomorrowEnd = tomorrowStart + 86_400_000;
          tomorrow = upcoming.filter(item => {
            const t = new Date(item.nextFollowUpAt).getTime();
            return t >= tomorrowStart && t < tomorrowEnd;
          });
        } else {
          tomorrow = upcoming.filter(item => isDhakaYmd(item.nextFollowUpAt, tomorrowYmd));
        }
        setOverdueFollowUps(overdue);
        setTodayFollowUps(today);
        setTomorrowFollowUps(tomorrow);
      } else {
        setOverdueFollowUps([]);
        setTodayFollowUps([]);
        setTomorrowFollowUps([]);
        setFollowUpError('Follow-ups could not be loaded.');
      }

      // Scheduled
      if (scheduledRangeRes.status === 'fulfilled') {
        const allSched = scheduledRangeRes.value || [];
        const todaySched = allSched.filter(a => isDhakaYmd(a.scheduledAt, todayYmd) && String(a.status).toLowerCase() === 'scheduled');
        const tomorrowSched = allSched.filter(a => isDhakaYmd(a.scheduledAt, tomorrowYmd) && String(a.status).toLowerCase() === 'scheduled');
        setScheduledToday(todaySched);
        setScheduledTomorrow(tomorrowSched);
      } else {
        setScheduledToday([]);
        setScheduledTomorrow([]);
        setScheduledError('Scheduled activities could not be loaded.');
      }

      // Completed today: from completed list, filter completedAt today
      // Must differentiate success-empty (show 0) vs failure (show unavailable, not 0)
      if (completedRes.status === 'fulfilled') {
        const comp = completedRes.value || [];
        const todayCompleted = comp.filter(a => {
          const iso = (a as any).completedAt || (a as any).completed_at;
          if (!iso) return false;
          return isDhakaYmd(iso, todayYmd);
        });
        setCompletedToday(todayCompleted);
        setCompletedTodayError(null);
      } else {
        setCompletedToday([]);
        setCompletedTodayError('Completed summary unavailable');
        // Do not treat completed fetch failure as fatal — it's optional summary
        // Primary workbench (follow-ups + scheduled) must still load.
      }

      if (followUpAllRes.status === 'rejected' && scheduledRangeRes.status === 'rejected') {
        setError('Daily work could not be loaded.');
      }
    } catch {
      setError('Daily work could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [user, todayYmd, tomorrowYmd]);

  useEffect(() => {
    void load();
  }, [load]);

  const workItems = useMemo(() => {
    // Today's execution queue: overdue follow-ups + today follow-ups + today scheduled (pending)
    const queueFollowUps = [...overdueFollowUps, ...todayFollowUps];
    return toWorkItems(queueFollowUps, scheduledToday, todayYmd);
  }, [overdueFollowUps, todayFollowUps, scheduledToday, todayYmd]);

  const filteredItems = useMemo(() => {
    if (activeFilter === 'all') return workItems;
    if (activeFilter === 'overdue') return workItems.filter(i => i.overdue);
    return workItems.filter(i => i.type === activeFilter);
  }, [workItems, activeFilter]);

  const filterCounts = useMemo(() => {
    return {
      all: workItems.length,
      overdue: workItems.filter(i => i.overdue).length,
      call: workItems.filter(i => i.type === 'call').length,
      meeting: workItems.filter(i => i.type === 'meeting').length,
      follow_up: workItems.filter(i => i.type === 'follow_up').length,
      task: workItems.filter(i => i.type === 'task').length,
    };
  }, [workItems]);

  const summary = useMemo(() => {
    const callsToday = scheduledToday.filter(a => (a.activityType || (a as any).activity_type) === 'call').length;
    const meetingsToday = scheduledToday.filter(a => (a.activityType || (a as any).activity_type) === 'meeting').length;
    const tasksToday = scheduledToday.filter(a => (a.activityType || (a as any).activity_type) === 'task').length;
    const followUpSchedToday = scheduledToday.filter(a => (a.activityType || (a as any).activity_type) === 'follow_up').length;
    const followUpsTodayCount = todayFollowUps.length + followUpSchedToday;
    return {
      overdue: overdueFollowUps.length,
      callsToday,
      meetingsToday,
      followUpsToday: followUpsTodayCount,
      tasksToday,
      completedToday: completedToday.length,
      completedTodayUnavailable: !!completedTodayError,
    };
  }, [overdueFollowUps, scheduledToday, todayFollowUps, completedToday, completedTodayError]);

  const tomorrowSummary = useMemo(() => {
    const calls = scheduledTomorrow.filter(a => (a.activityType || (a as any).activity_type) === 'call').length;
    const meetings = scheduledTomorrow.filter(a => (a.activityType || (a as any).activity_type) === 'meeting').length;
    const tasks = scheduledTomorrow.filter(a => (a.activityType || (a as any).activity_type) === 'task').length;
    const followUpSched = scheduledTomorrow.filter(a => (a.activityType || (a as any).activity_type) === 'follow_up').length;
    const followUps = tomorrowFollowUps.length + followUpSched;
    return { calls, meetings, tasks, followUps };
  }, [scheduledTomorrow, tomorrowFollowUps]);

  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return workItems.find(i => i.key === selectedKey) || null;
  }, [workItems, selectedKey]);

  // ---- Actions: scheduled complete/cancel/edit (reuse existing service) ----
  const handleComplete = async (item: WorkItem) => {
    if (item.source !== 'scheduled') return;
    setActionLoading(item.key);
    try {
      const res: any = await scheduledActivityService.complete(item.id);
      const updated = res?.scheduled || res?.data?.scheduled || res?.data;
      if (updated && updated.id) {
        // Remove from today's pending list efficiently
        setScheduledToday(prev => prev.filter(s => s.id !== item.id));
        // Add to completed today if completed today — and clear unavailable state if it was set
        const compAt = (updated as any).completedAt || (updated as any).completed_at;
        if (compAt && isDhakaYmd(compAt, todayYmd)) {
          setCompletedToday(prev => [...prev, updated as ScheduledActivity]);
          setCompletedTodayError(null);
        }
      } else {
        setScheduledToday(prev => prev.filter(s => s.id !== item.id));
      }
      toast.success('Activity completed');
      setSelectedKey(null);
    } catch (err: any) {
      toast.error(err?.message || 'Complete failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (item: WorkItem) => {
    if (item.source !== 'scheduled') return;
    setActionLoading(item.key);
    try {
      const res: any = await scheduledActivityService.cancel(item.id);
      const updated = res?.data || res?.scheduled || res;
      void updated;
      setScheduledToday(prev => prev.filter(s => s.id !== item.id));
      toast.success('Activity cancelled');
      setSelectedKey(null);
    } catch (err: any) {
      toast.error(err?.message || 'Cancel failed');
    } finally {
      setActionLoading(null);
    }
  };

  const openEdit = (item: WorkItem) => {
    if (item.source !== 'scheduled') return;
    const sa = item.raw as ScheduledActivity;
    if (String(sa.status).toLowerCase() !== 'scheduled') {
      toast.error(`Cannot edit a ${sa.status} activity.`);
      return;
    }
    setEditing(sa);
    const dt = sa.scheduledAt ? new Date(sa.scheduledAt) : null;
    let localVal = '';
    if (dt && !isNaN(dt.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      localVal = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }
    setEditForm({ title: sa.title || '', scheduledAt: localVal, remarks: sa.remarks || '' });
  };

  const handleEditSave = async () => {
    if (!editing) return;
    setActionLoading(`edit:${editing.id}`);
    try {
      const payload: any = {};
      if (editForm.title !== undefined) payload.title = editForm.title || null;
      if (editForm.remarks !== undefined) payload.remarks = editForm.remarks || null;
      if (editForm.scheduledAt) {
        const d = new Date(editForm.scheduledAt);
        if (!Number.isFinite(d.getTime())) throw new Error('Invalid date');
        payload.scheduledAt = d.toISOString();
      }
      const updated = await scheduledActivityService.update(editing.id, payload);
      setScheduledToday(prev => prev.map(s => s.id === editing.id ? { ...s, ...updated } : s));
      toast.success('Activity updated');
      setEditing(null);
    } catch (err: any) {
      toast.error(err?.message || 'Update failed');
    } finally {
      setActionLoading(null);
    }
  };

  const dhakaDisplay = useMemo(() => {
    try {
      const now = getDhakaNow();
      return now.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return todayYmd;
    }
  }, [todayYmd]);

  const filterChips: Array<{ key: FilterKey; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'call', label: 'Calls' },
    { key: 'meeting', label: 'Meetings' },
    { key: 'follow_up', label: 'Follow-ups' },
    { key: 'task', label: 'Tasks' },
  ];

  return (
    <div className="space-y-6 pb-12 font-sans max-w-[1280px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-[12px] border border-stone-100" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div>
          <h1 className="text-2xl font-black tracking-tight leading-none text-brand-text">Daily Workbench</h1>
          <p className="text-[13px] text-stone-500 mt-2 leading-relaxed">Manage today's calls, meetings, follow-ups and tasks from one place.</p>
          <p className="text-[11px] font-semibold text-stone-400 mt-1">Asia/Dhaka · {dhakaDisplay}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors disabled:opacity-50 bg-white"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
          <Link
            to="/task-calendar"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#978C21] text-white rounded-[10px] text-xs font-bold hover:bg-[#8a7f1e] transition-colors shadow-sm"
          >
            <CalendarIcon className="w-3.5 h-3.5" />
            Open Calendar
          </Link>
        </div>
      </div>

      {/* Partial failure banners */}
      {(followUpError || scheduledError) && !error && (
        <div className="space-y-2">
          {followUpError && (
            <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-[12px] px-5 py-3 text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-[12px] font-medium">{followUpError} Scheduled activities may still be available.</p>
            </div>
          )}
          {scheduledError && (
            <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-[12px] px-5 py-3 text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-[12px] font-medium">{scheduledError} Follow-ups may still be available.</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-[12px] px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-xs text-red-500 mt-0.5">Please try again.</p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-[10px]">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white rounded-[12px] border border-stone-100 p-5 min-h-[118px] animate-pulse" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div className="h-3 w-24 bg-stone-100 rounded mb-4" />
                <div className="h-7 w-20 bg-stone-100 rounded" />
              </div>
            ))}
          </div>
          <div className="bg-white rounded-[12px] border border-stone-100 p-6 space-y-3 animate-pulse">
            <div className="h-4 w-32 bg-stone-100 rounded" />
            <div className="h-10 bg-stone-100 rounded-[10px]" />
            <div className="h-16 bg-stone-100 rounded-[10px]" />
            <div className="h-16 bg-stone-100 rounded-[10px]" />
          </div>
        </div>
      ) : (
        <>
          {/* Daily Summary */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Daily Summary</h2>
              <span className="text-[11px] font-semibold text-stone-400 bg-stone-50 px-2.5 py-1 rounded-full border border-stone-100">{todayYmd}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <SummaryCard label="Overdue Follow-ups" value={String(summary.overdue)} icon={AlertTriangle} variant="red" sub="Due before today" />
              <SummaryCard label="Calls Today" value={String(summary.callsToday)} icon={Phone} variant="blue" />
              <SummaryCard label="Meetings Today" value={String(summary.meetingsToday)} icon={Video} variant="orange" />
              <SummaryCard label="Follow-ups Today" value={String(summary.followUpsToday)} icon={History} variant="emerald" />
              <SummaryCard label="Tasks Today" value={String(summary.tasksToday)} icon={ClipboardCheck} variant="olive" />
              <SummaryCard
                label="Completed Today"
                value={summary.completedTodayUnavailable ? '—' : String(summary.completedToday)}
                icon={CheckCircle2}
                variant="slate"
                sub={summary.completedTodayUnavailable ? 'Unavailable' : 'Scheduled completed'}
              />
            </div>
          </section>

          {/* Quick Filters */}
          <div className="flex flex-wrap items-center gap-2 bg-white border border-stone-100 rounded-[12px] p-3" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            {filterChips.map(chip => {
              const count = (filterCounts as any)[chip.key] ?? 0;
              const active = activeFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setActiveFilter(chip.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold border transition-all duration-150',
                    active ? 'bg-[#978C21] text-white border-[#978C21] shadow-sm' : 'bg-[#FFFCF8] text-stone-600 border-stone-200 hover:bg-white hover:border-stone-300',
                  )}
                >
                  {chip.label}
                  <span className={cn('ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black', active ? 'bg-white/20 text-white' : 'bg-stone-100 text-stone-500')}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Execution Queue */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <div className="flex items-end justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Execution Queue</h2>
                <p className="text-[12px] text-stone-500 mt-1.5 leading-relaxed">Overdue follow-ups first, then today's work by scheduled time. Tomorrow does not enter this queue.</p>
              </div>
              <span className="text-[11px] font-bold text-stone-400 bg-stone-50 px-2.5 py-1 rounded-full border border-stone-100">{filteredItems.length} items</span>
            </div>

            {filteredItems.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-stone-200 bg-[#FFFCF8] px-6 py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-white border border-stone-100 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                </div>
                <h3 className="text-sm font-bold text-stone-700">You're clear for today</h3>
                <p className="text-[12px] text-stone-500 mt-2 max-w-md mx-auto">No overdue follow-ups or scheduled activities are currently due.</p>
                <Link to="/task-calendar" className="inline-flex items-center gap-1.5 mt-4 text-xs font-semibold text-[#978C21] hover:underline">
                  Open Calendar <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            ) : (
              <div className="space-y-2 max-h-[720px] overflow-y-auto pr-1">
                {filteredItems.map(item => {
                  const meta = TYPE_META[item.type];
                  const Icon = meta.icon;
                  const isSelected = selectedKey === item.key;
                  return (
                    <div
                      key={item.key}
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 rounded-[10px] border transition-all duration-150',
                        isSelected ? 'border-[#978C21] bg-[#978C21]/[0.04] shadow-sm' : 'border-stone-100 bg-[#FFFCF8] hover:bg-white hover:border-stone-200 hover:shadow-sm',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedKey(isSelected ? null : item.key)}
                        className="flex items-center gap-3 min-w-0 flex-1 text-left"
                      >
                        <div className={cn('w-9 h-9 rounded-[10px] border flex items-center justify-center shrink-0', meta.tone)}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-stone-800 truncate">{item.leadName}</p>
                            {item.overdue && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-[10px] font-bold text-red-700">
                                <AlertTriangle className="w-3 h-3" />
                                Overdue
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-stone-500 truncate">
                            {item.title ? `${item.title} · ` : ''}
                            {formatDhakaDue(item.scheduledAt || '')}
                            {item.leadStatus ? ` · ${item.leadStatus}` : ''}
                          </p>
                        </div>
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className={cn('px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', meta.tone)}>{meta.badge}</span>
                        {item.source === 'follow_up' ? (
                          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-stone-50 border-stone-200 text-stone-600">Follow-up</span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-white border-stone-200 text-stone-600">{(item.raw as ScheduledActivity).activityType}</span>
                        )}
                        {item.leadStatus && (
                          <span className={cn('hidden md:inline-flex px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border', getLeadStatusColorClasses(item.leadStatus))}>
                            {item.leadStatus}
                          </span>
                        )}
                        <Link
                          to={`/leads/${encodeURIComponent(item.leadId)}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[10px] border border-stone-200 bg-white text-[11px] font-semibold text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 transition-colors"
                        >
                          Open <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Selected Item / Quick Action Area */}
          {selectedItem && (
            <section className="bg-white rounded-[12px] border border-[#978C21]/20 p-6" style={{ boxShadow: '0 4px 12px rgba(151,140,33,0.08)' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Quick Actions</h3>
                <button type="button" onClick={() => setSelectedKey(null)} className="p-1.5 rounded-full hover:bg-stone-50 border border-stone-100">
                  <X className="w-4 h-4 text-stone-400" />
                </button>
              </div>
              <div className="flex flex-col md:flex-row gap-6">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-stone-800">{selectedItem.leadName}</p>
                  <p className="text-[12px] text-stone-500 mt-1">
                    {TYPE_META[selectedItem.type].label} · {formatDhakaDue(selectedItem.scheduledAt || '')}
                    {selectedItem.title ? ` · ${selectedItem.title}` : ''}
                    {selectedItem.leadStatus ? ` · ${selectedItem.leadStatus}` : ''}
                  </p>
                  {selectedItem.overdue && (
                    <p className="text-[11px] font-bold text-red-600 mt-2 inline-flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Overdue — due {formatDhakaDue(selectedItem.scheduledAt || '')}
                    </p>
                  )}
                  {selectedItem.assigneeName && (
                    <p className="text-[11px] text-stone-400 mt-2">Assignee: {selectedItem.assigneeName}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <Link
                    to={`/leads/${encodeURIComponent(selectedItem.leadId)}`}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-[#978C21] text-white text-xs font-bold hover:bg-[#8a7f1e] transition-colors"
                  >
                    Open Lead <ExternalLink className="w-3.5 h-3.5" />
                  </Link>
                  {selectedItem.source === 'scheduled' && canEditScheduled && (
                    <>
                      <button
                        type="button"
                        disabled={actionLoading === selectedItem.key}
                        onClick={() => void handleComplete(selectedItem)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50 transition-colors"
                      >
                        {actionLoading === selectedItem.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Complete
                      </button>
                      <button
                        type="button"
                        disabled={actionLoading === selectedItem.key}
                        onClick={() => void handleCancel(selectedItem)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-white border border-amber-200 text-amber-700 hover:bg-amber-50 text-xs font-bold disabled:opacity-50 transition-colors"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(selectedItem)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[10px] bg-white border border-stone-200 text-stone-600 hover:text-[#978C21] hover:border-[#978C21]/30 text-xs font-bold transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit / Reschedule
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Completed Today summary (optional) */}
          {completedToday.length > 0 && (
            <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <h3 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700 mb-3">Completed Today</h3>
              <p className="text-[11px] text-stone-500 mb-3">Scheduled activities completed today in Asia/Dhaka (authoritative completed_at). Historical lead_activities are immutable; this counts planned work marked completed.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {completedToday.slice(0, 8).map(sa => (
                  <div key={sa.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-[10px] border border-stone-100 bg-[#FFFCF8]">
                    <span className="text-xs font-semibold text-stone-700 truncate">{sa.leadCustomerName || sa.title || sa.activityType}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">Completed</span>
                  </div>
                ))}
              </div>
              {completedToday.length > 8 && <p className="text-[11px] text-stone-400 mt-2">+{completedToday.length - 8} more</p>}
            </section>
          )}

          {/* Tomorrow Preview (lightweight counts) */}
          <section className="bg-white rounded-[12px] border border-stone-100 p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Tomorrow Preview</h3>
              <Link to="/task-calendar" className="inline-flex items-center gap-1 text-xs font-semibold text-[#978C21] hover:underline">
                Open Calendar <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-stone-500">Calls</span>
                <span className="text-sm font-bold text-brand-text">{tomorrowSummary.calls}</span>
              </div>
              <div className="rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-stone-500">Meetings</span>
                <span className="text-sm font-bold text-brand-text">{tomorrowSummary.meetings}</span>
              </div>
              <div className="rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-stone-500">Follow-ups</span>
                <span className="text-sm font-bold text-brand-text">{tomorrowSummary.followUps}</span>
              </div>
              <div className="rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-stone-500">Tasks</span>
                <span className="text-sm font-bold text-brand-text">{tomorrowSummary.tasks}</span>
              </div>
            </div>
            <p className="text-[11px] text-stone-400 mt-3">Today remains the core workbench. Task Calendar is the detailed planning view.</p>
          </section>
        </>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[14px] shadow-2xl border border-stone-100 w-full max-w-md overflow-hidden animate-slideUp" style={{ boxShadow: '0 12px 32px rgba(0,0,0,0.12)' }}>
            <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
              <h4 className="text-sm font-black uppercase tracking-widest text-stone-700">Edit Activity</h4>
              <button type="button" onClick={() => setEditing(null)} className="p-1.5 rounded-full hover:bg-stone-50">
                <X className="w-4 h-4 text-stone-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <label className="space-y-1.5 block">
                <span className="text-[11px] font-semibold text-stone-500">Title</span>
                <input type="text" value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3]" />
              </label>
              <label className="space-y-1.5 block">
                <span className="text-[11px] font-semibold text-stone-500">Scheduled At</span>
                <input type="datetime-local" value={editForm.scheduledAt} onChange={e => setEditForm({ ...editForm, scheduledAt: e.target.value })} className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3]" />
              </label>
              <label className="space-y-1.5 block">
                <span className="text-[11px] font-semibold text-stone-500">Remarks</span>
                <textarea value={editForm.remarks} onChange={e => setEditForm({ ...editForm, remarks: e.target.value })} rows={3} className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#0359B3]/10 focus:border-[#0359B3] resize-none" />
              </label>
            </div>
            <div className="px-6 py-4 bg-[#FFFCF8] border-t border-stone-100 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 border border-stone-200 rounded-[10px] text-xs font-semibold text-stone-600 hover:bg-white">Cancel</button>
              <button
                type="button"
                disabled={!!actionLoading}
                onClick={() => void handleEditSave()}
                className="px-4 py-2 bg-[#978C21] text-white rounded-[10px] text-xs font-bold hover:bg-[#8a7f1e] disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
