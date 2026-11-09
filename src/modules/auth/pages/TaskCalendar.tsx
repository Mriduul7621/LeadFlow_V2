import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Phone,
  Search,
  Plus,
  ExternalLink,
  MapPin,
  X,
  Video,
  CheckCircle,
  FileText,
  Users,
  Bell,
  Trash2,
  Pencil,
  ListFilter,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../store/authStore';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { calendarService, type CalendarHoliday } from '../../calendar/services/calendarService';
import { roadshowService, type Roadshow } from '../../roadshows/services/roadshowService';
import { userService } from '../../users/services/userService';
import { leadService } from '../../leads/services/leadService';
import { usePermissions } from '../../shared/hooks/usePermissions';
import type { Lead, User } from '../../shared/types';
import {
  CALENDAR_CATEGORIES,
  CATEGORY_LABELS,
  FORM_KIND_LABELS,
  REMINDER_OPTIONS,
  apiTypeForKind,
  categoryOfScheduled,
  eventSpan,
  isManagedEntry,
  kindForCategory,
  kindRequiresLead,
  layoutDayEvents,
  minutesOfDay,
  slotPrefill,
  toDateStr,
  visibleWeekDates,
  widenRangeYmd,
  type CalendarCategory,
  type EventFormKind,
} from '../../calendar/utils/calendarLayout';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import BackButton from '../../shared/components/BackButton';

/**
 * TaskCalendar.tsx — Microsoft-style rebuild (calendar upgrade PR D)
 * ------------------------------------------------------------------
 * Day / Work week / Week time-grid + Month grid over the server-
 * authoritative scheduled activities (PR B data model: lead-less
 * team meetings, attendees + RSVP, reminders) and roadshows.
 *
 *   - Work week columns derive from the configured weekend
 *     (Calendar Settings PR C; BD default Fri+Sat → Sun–Thu).
 *   - Holidays come from GET /calendar/config and mark cells and
 *     day columns (EN name primary; BN in the title/day detail).
 *   - Status-update next-step entries (PR A, source_activity_id
 *     set) are READ-ONLY here: the lead follow-up owns their time,
 *     so the detail view links to the lead instead of editing.
 *   - Embedded mode (Dashboard) renders a compact month + agenda.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const CATEGORY_HEX: Record<CalendarCategory, string> = {
  followup: '#10B981',
  call: '#3B82F6',
  customer_meeting: '#F59E0B',
  team_meeting: '#6366F1',
  task: '#8B5CF6',
  roadshow: '#E11D48',
};

const PILL_CLASS: Record<CalendarCategory, string> = {
  followup: 'lf-cal-pill--followup',
  call: 'lf-cal-pill--call',
  customer_meeting: 'lf-cal-pill--meeting',
  team_meeting: 'lf-cal-pill--team',
  task: 'lf-cal-pill--task',
  roadshow: 'lf-cal-pill--roadshow',
};

type ViewMode = 'day' | 'workweek' | 'week' | 'month';

interface CalendarEvent {
  id: string;
  kind: 'scheduled' | 'roadshow';
  category: CalendarCategory;
  title: string;
  date: Date;
  durationMin: number | null;
  status: string;
  remarks?: string;
  location?: string | null;
  priority?: string | null;
  leadId?: string | null;
  leadName?: string | null;
  leadMobile?: string | null;
  leadStatus?: string | null;
  managed: boolean;
  raw?: ScheduledActivity;
  roadshow?: Roadshow;
}

interface EventFormState {
  mode: 'create' | 'edit';
  eventId?: string;
  kind: EventFormKind;
  title: string;
  leadId: string;
  leadLabel: string;
  attendeeIds: string[];
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  remarks: string;
  reminder: string; // 'none' | '15' | '30' | '60'
  priority: string;
}

const fmtTime = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDateLong = (d: Date) => `${DAYS_OF_WEEK[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const isSameDay = (a: Date, b: Date) =>
  a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();

function mapScheduled(sa: ScheduledActivity): CalendarEvent {
  const iso = (sa.scheduledAt || (sa as any).scheduled_at) as string;
  const type = String(sa.activityType || (sa as any).activity_type || 'follow_up');
  const leadId = (sa.leadId ?? (sa as any).lead_id ?? null) as string | null;
  const leadName = ((sa as any).leadCustomerName ?? null) as string | null;
  const category = categoryOfScheduled(sa);
  const fallbackTitle = leadName
    ? `${type === 'call' ? 'Call' : type === 'meeting' ? 'Meeting' : type === 'task' ? 'Task' : 'Follow-up'}: ${leadName}`
    : type === 'meeting'
      ? 'Team meeting'
      : type === 'task'
        ? 'Task'
        : 'Scheduled activity';
  return {
    id: sa.id,
    kind: 'scheduled',
    category,
    title: sa.title || fallbackTitle,
    date: new Date(iso),
    durationMin: sa.durationMinutes ?? (sa as any).duration_minutes ?? null,
    status: String(sa.status || 'scheduled'),
    remarks: sa.remarks || undefined,
    location: sa.location ?? null,
    priority: (sa.priority as string) ?? null,
    leadId,
    leadName,
    leadMobile: ((sa as any).leadMobile ?? null) as string | null,
    leadStatus: ((sa as any).leadStatus ?? null) as string | null,
    managed: isManagedEntry(sa),
    raw: sa,
  };
}

function mapRoadshow(r: Roadshow): CalendarEvent {
  return {
    id: `roadshow:${r.id}`,
    kind: 'roadshow',
    category: 'roadshow',
    title: r.organization || 'Roadshow',
    date: new Date(r.scheduledAt),
    durationMin: 60,
    status: String(r.status || 'pending'),
    location: r.location || null,
    managed: false,
    roadshow: r,
  };
}

export default function TaskCalendar({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const { canAccess } = usePermissions();
  const canEditScheduled = canAccess('lead_tracking', 'edit');

  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<Record<CalendarCategory, boolean>>({
    followup: true, call: true, customer_meeting: true, team_meeting: true, task: true, roadshow: true,
  });

  // Calendar Settings (PR C): weekend days + government holidays.
  const [weekendDays, setWeekendDays] = useState<number[]>([5, 6]);
  const [holidaysByDate, setHolidaysByDate] = useState<Record<string, CalendarHoliday[]>>({});

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [form, setForm] = useState<EventFormState | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [miniCursor, setMiniCursor] = useState<Date>(new Date());
  const [embeddedDay, setEmbeddedDay] = useState<Date>(new Date());
  const [now, setNow] = useState<Date>(new Date());
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // Current-time line ticker (30s is plenty for a 48px/hour grid).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    calendarService.getConfig()
      .then(cfg => {
        if (cancelled) return;
        setWeekendDays(cfg.weekendDays);
        const byDate: Record<string, CalendarHoliday[]> = {};
        for (const h of cfg.holidays) (byDate[h.date] = byDate[h.date] || []).push(h);
        setHolidaysByDate(byDate);
      })
      .catch(() => { /* defaults stay in place */ });
    return () => { cancelled = true; };
  }, [user]);

  // Keep the mini calendar on the anchor's month after main navigation.
  useEffect(() => {
    setMiniCursor(prev =>
      prev.getFullYear() === currentDate.getFullYear() && prev.getMonth() === currentDate.getMonth()
        ? prev
        : new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
    );
  }, [currentDate]);

  /** Visible date range for the current view (server-filtered fetch). */
  const range = useMemo(() => {
    const toYmd = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (embedded) {
      const start = new Date(); start.setDate(start.getDate() - 30);
      const end = new Date(); end.setDate(end.getDate() + 60);
      return { from: toYmd(start), to: toYmd(end) };
    }
    if (viewMode === 'month') {
      const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const gridStart = new Date(first); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
      const gridEnd = new Date(gridStart); gridEnd.setDate(gridEnd.getDate() + 41);
      return { from: toYmd(gridStart), to: toYmd(gridEnd) };
    }
    if (viewMode === 'day') {
      const d = toYmd(currentDate);
      return { from: d, to: d };
    }
    const days = visibleWeekDates(currentDate, weekendDays, false);
    return { from: toYmd(days[0]), to: toYmd(days[6]) };
  }, [embedded, viewMode, currentDate, weekendDays]);

  // Server-authoritative scheduled activities + roadshows for the range.
  // The fetch window is widened ±1 day (see widenRangeYmd): the range
  // above is in Asia/Dhaka dates but the server filters stored UTC
  // timestamps by those literal days, so an event in the first six
  // hours of the first visible Dhaka day would otherwise be missed.
  // Placement below is by local day, so the extra rows never render
  // on a wrong day.
  const fetchRange = useMemo(() => widenRangeYmd(range), [range]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      scheduledActivityService.list({ from: fetchRange.from, to: fetchRange.to, limit: 500 }).catch(() => [] as ScheduledActivity[]),
      roadshowService.list({ from: fetchRange.from, to: fetchRange.to }).catch(() => [] as Roadshow[]),
    ])
      .then(([activities, roadshows]) => {
        if (cancelled) return;
        const mapped = [
          ...(activities || []).map(mapScheduled),
          ...(roadshows || []).filter(r => String(r.status) !== 'cancel').map(mapRoadshow),
        ];
        mapped.sort((a, b) => a.date.getTime() - b.date.getTime());
        setEvents(mapped);
      })
      .catch(err => {
        console.error('Error fetching calendar events:', err);
        if (!cancelled) setEvents([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user, fetchRange, refreshKey]);

  const filteredEvents = useMemo(() => {
    let result = events.filter(e => String(e.status).toLowerCase() !== 'cancelled');
    result = result.filter(e => filters[e.category]);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(e =>
        e.title.toLowerCase().includes(q) ||
        (e.leadName || '').toLowerCase().includes(q) ||
        (e.leadMobile || '').toLowerCase().includes(q) ||
        (e.location || '').toLowerCase().includes(q) ||
        (e.remarks || '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [events, filters, searchQuery]);

  const getEventsForDay = (date: Date) => filteredEvents.filter(e => isSameDay(e.date, date));
  const holidaysFor = (date: Date): CalendarHoliday[] => holidaysByDate[toDateStr(date)] || [];
  const isToday = (date: Date) => isSameDay(date, new Date());

  /* ---------------- navigation ---------------- */

  const navigatePeriod = (direction: 'prev' | 'next') => {
    const d = new Date(currentDate);
    if (viewMode === 'month') d.setMonth(d.getMonth() + (direction === 'prev' ? -1 : 1));
    else if (viewMode === 'day') d.setDate(d.getDate() + (direction === 'prev' ? -1 : 1));
    else d.setDate(d.getDate() + (direction === 'prev' ? -7 : 7));
    setCurrentDate(d);
  };

  const rangeTitle = useMemo(() => {
    if (viewMode === 'month') return `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    if (viewMode === 'day') return fmtDateLong(currentDate);
    const days = visibleWeekDates(currentDate, weekendDays, viewMode === 'workweek');
    const first = days[0]; const last = days[days.length - 1];
    return `${first.getDate()} ${MONTHS[first.getMonth()]} – ${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
  }, [viewMode, currentDate, weekendDays]);

  const jumpToDay = (day: Date) => {
    setCurrentDate(day);
    if (!embedded) setViewMode('day');
    else setEmbeddedDay(day);
  };

  /* ---------------- mutations ---------------- */

  const refresh = () => setRefreshKey(k => k + 1);

  const handleComplete = async (ev: CalendarEvent) => {
    try {
      await scheduledActivityService.complete(ev.id);
      toast.success('Activity completed');
      setSelectedEvent(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Complete failed');
    }
  };

  const handleCancel = async (ev: CalendarEvent) => {
    try {
      await scheduledActivityService.cancel(ev.id);
      toast.success('Activity cancelled');
      setSelectedEvent(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Cancel failed');
    }
  };

  const handleDelete = async (ev: CalendarEvent) => {
    try {
      await scheduledActivityService.remove(ev.id);
      toast.success('Activity deleted');
      setSelectedEvent(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Delete failed');
    }
  };

  const handleRsvp = async (ev: CalendarEvent, response: 'accepted' | 'declined') => {
    try {
      await scheduledActivityService.rsvp(ev.id, response);
      toast.success(response === 'accepted' ? 'You accepted this meeting' : 'You declined this meeting');
      setSelectedEvent(null);
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'RSVP failed');
    }
  };

  const openEvent = async (ev: CalendarEvent) => {
    setSelectedEvent(ev);
    if (ev.kind !== 'scheduled') return;
    // Refresh the detail (attendees / RSVP state) from the server.
    try {
      const fresh = await scheduledActivityService.getById(ev.id);
      if (fresh && fresh.id) setSelectedEvent(prev => (prev && prev.id === ev.id ? mapScheduled(fresh) : prev));
    } catch { /* list data is already shown */ }
  };

  /* ---------------- create / edit form ---------------- */

  const openCreate = (prefill?: { date: string; startTime: string; endTime: string }, kind: EventFormKind = 'follow_up') => {
    const fallback = slotPrefill(new Date(), 10);
    setForm({
      mode: 'create',
      kind,
      title: '',
      leadId: '',
      leadLabel: '',
      attendeeIds: [],
      date: prefill?.date || fallback.date,
      startTime: prefill?.startTime || fallback.startTime,
      endTime: prefill?.endTime || fallback.endTime,
      location: '',
      remarks: '',
      reminder: 'none',
      priority: 'NORMAL',
    });
  };

  const openEdit = (ev: CalendarEvent) => {
    if (!ev.raw) return;
    const sa = ev.raw;
    const start = ev.date;
    const span = eventSpan(start, ev.durationMin);
    const endTotal = span.endMin;
    setForm({
      mode: 'edit',
      eventId: ev.id,
      kind: kindForCategory(ev.category),
      title: sa.title || '',
      leadId: ev.leadId || '',
      leadLabel: ev.leadName || '',
      attendeeIds: (sa.attendees || []).map(a => a.userId),
      date: toDateStr(start),
      startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      endTime: endTotal >= 1440 ? '23:59' : `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`,
      location: sa.location || '',
      remarks: sa.remarks || '',
      reminder: sa.reminderMinutes != null ? String(sa.reminderMinutes) : 'none',
      priority: (sa.priority as string) || 'NORMAL',
    });
    setSelectedEvent(null);
  };

  const handleFormSubmit = async (f: EventFormState): Promise<boolean> => {
    if (kindRequiresLead(f.kind) && !f.leadId) {
      toast.error('Please pick a lead — this type of event needs one.');
      return false;
    }
    if (!kindRequiresLead(f.kind) && !f.leadId && !f.title.trim()) {
      toast.error('Please give this event a title.');
      return false;
    }
    const start = new Date(`${f.date}T${f.startTime}`);
    const end = new Date(`${f.date}T${f.endTime}`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      toast.error('Please pick a valid date and time.');
      return false;
    }
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (durationMinutes <= 0) {
      toast.error('End time must be after start time.');
      return false;
    }
    const reminderMinutes = f.reminder === 'none' ? null : Number(f.reminder);
    const showAttendees = f.kind === 'customer_meeting' || f.kind === 'team_meeting' || f.kind === 'task';
    try {
      if (f.mode === 'create') {
        await scheduledActivityService.create({
          leadId: f.leadId || null,
          activityType: apiTypeForKind(f.kind),
          scheduledAt: start.toISOString(),
          title: f.title.trim() || null,
          remarks: f.remarks.trim() || null,
          durationMinutes,
          priority: f.priority,
          location: f.location.trim() || null,
          attendeeIds: showAttendees ? f.attendeeIds : undefined,
          reminderMinutes,
        });
        toast.success('Event created');
      } else if (f.eventId) {
        await scheduledActivityService.update(f.eventId, {
          activityType: apiTypeForKind(f.kind),
          scheduledAt: start.toISOString(),
          title: f.title.trim() || null,
          remarks: f.remarks.trim() || null,
          durationMinutes,
          priority: f.priority,
          location: f.location.trim() || null,
          attendeeIds: showAttendees ? f.attendeeIds : undefined,
          reminderMinutes,
        });
        toast.success('Event updated');
      }
      setForm(null);
      refresh();
      return true;
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the event.');
      return false;
    }
  };

  /* ---------------- time-grid auto-scroll ---------------- */

  useEffect(() => {
    const el = gridScrollRef.current;
    if (el) el.scrollTop = 7 * HOUR_PX - 4;
  }, [viewMode, rangeTitle, embedded]);

  /* ---------------- mini month (left rail) ---------------- */

  const renderMiniMonth = () => {
    const y = miniCursor.getFullYear();
    const m = miniCursor.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }
    return (
      <div className="bg-white border border-slate-200/70 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-black uppercase tracking-widest text-slate-700">{MONTHS[m]} {y}</span>
          <div className="flex gap-1">
            <button type="button" aria-label="Previous month" onClick={() => setMiniCursor(new Date(y, m - 1, 1))} className="p-1 border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"><ChevronLeft className="w-3.5 h-3.5" /></button>
            <button type="button" aria-label="Next month" onClick={() => setMiniCursor(new Date(y, m + 1, 1))} className="p-1 border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"><ChevronRight className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 text-center mb-1">
          {DAYS_OF_WEEK.map(d => (
            <span key={d} className="text-[9px] font-black text-slate-400 uppercase">{d.charAt(0)}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map(day => {
            const dayHolidays = holidaysFor(day);
            const hasEvents = getEventsForDay(day).length > 0;
            const title = [
              dayHolidays.length ? dayHolidays.map(h => h.nameBn ? `${h.name} · ${h.nameBn}` : h.name).join(' · ') : '',
              hasEvents ? `${getEventsForDay(day).length} event(s)` : '',
            ].filter(Boolean).join(' — ');
            return (
              <button
                key={day.toISOString()}
                type="button"
                title={title || undefined}
                onClick={() => { setCurrentDate(day); if (embedded) setEmbeddedDay(day); }}
                className={cn(
                  'lf-mini-day',
                  day.getMonth() !== m && 'is-outside',
                  weekendDays.includes(day.getDay()) && 'is-weekend',
                  isSameDay(day, currentDate) && 'is-selected',
                  isToday(day) && 'is-today',
                )}
              >
                {day.getDate()}
                {dayHolidays.length > 0
                  ? <span className="lf-mini-dot is-holiday" />
                  : hasEvents ? <span className="lf-mini-dot" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  /* ---------------- rail: mini month + "My calendars" filters ---------------- */

  const renderRailContent = () => (
    <div className="space-y-4">
      {renderMiniMonth()}
      <div className="bg-white border border-slate-200/70 rounded-xl p-3">
        <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
          <ListFilter className="w-3.5 h-3.5" /> My calendars
        </span>
        <div className="space-y-1">
          {CALENDAR_CATEGORIES.map(cat => (
            <label key={cat} className="flex items-center gap-2 py-1 px-1 rounded-md hover:bg-slate-50 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filters[cat]}
                onChange={e => setFilters(prev => ({ ...prev, [cat]: e.target.checked }))}
                className="w-3.5 h-3.5"
                style={{ accentColor: CATEGORY_HEX[cat] }}
              />
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: CATEGORY_HEX[cat] }} />
              <span className="text-[11px] font-bold text-slate-700">{CATEGORY_LABELS[cat]}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  /* ---------------- month grid ---------------- */

  const renderMonthView = (compact = false) => {
    const y = currentDate.getFullYear();
    const m = currentDate.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }
    const maxChips = compact ? 2 : 3;
    return (
      <div className="lf-cal" role="grid" aria-label={`${MONTHS[m]} ${y}`}>
        <div className="lf-cal-headrow" role="row">
          {DAYS_OF_WEEK.map(day => (
            <div key={day} className="lf-cal-headcell" role="columnheader">
              <span className="lf-cal-headcell-long">{day}</span>
              <span className="lf-cal-headcell-short" aria-hidden="true">{day.charAt(0)}</span>
            </div>
          ))}
        </div>
        <div className="lf-cal-body">
          {cells.map(day => {
            const dayHolidays = holidaysFor(day);
            const dayEvents = getEventsForDay(day);
            const rendered = dayEvents.slice(0, maxChips);
            const holidayTitle = dayHolidays.map(h => (h.nameBn ? `${h.name} · ${h.nameBn}` : h.name)).join(' · ');
            return (
              <div
                key={day.toISOString()}
                role="gridcell"
                className={cn(
                  'lf-cal-cell',
                  day.getMonth() !== m && 'is-outside',
                  weekendDays.includes(day.getDay()) && 'is-weekend',
                  dayHolidays.length > 0 && 'is-holiday',
                  isToday(day) && 'is-today',
                )}
                onClick={() => jumpToDay(day)}
              >
                <div className="lf-cal-cell-top">
                  <span className={cn('lf-cal-daynum', isToday(day) && 'is-today')}>{day.getDate()}</span>
                  {dayEvents.length > 0 && <span className="lf-cal-cell-count" aria-hidden="true">{dayEvents.length}</span>}
                </div>
                {dayHolidays.length > 0 && (
                  <div className="lf-cal-holiday" title={holidayTitle}>{dayHolidays.map(h => h.name).join(' · ')}</div>
                )}
                <div className="lf-cal-events">
                  {rendered.map(event => (
                    <button
                      key={event.id}
                      type="button"
                      onClick={e => { e.stopPropagation(); void openEvent(event); }}
                      className={cn('lf-cal-pill', PILL_CLASS[event.category], String(event.status).toLowerCase() === 'completed' && 'opacity-60')}
                      title={`${event.title} · ${fmtTime(event.date)}`}
                    >
                      <span className="lf-cal-pill-time">{fmtTime(event.date)}</span>
                      <span className="lf-cal-pill-title">{event.title}</span>
                    </button>
                  ))}
                  {dayEvents.length > rendered.length && (
                    <button
                      type="button"
                      className="lf-cal-more"
                      onClick={e => { e.stopPropagation(); jumpToDay(day); }}
                    >
                      +{dayEvents.length - rendered.length} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  /* ---------------- time grid (Day / Work week / Week) ---------------- */

  const handleSlotClick = (day: Date) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const totalMin = Math.max(0, Math.min(1439, Math.floor((y / HOUR_PX) * 60)));
    const hour = Math.floor(totalMin / 60);
    const minute = totalMin % 60 >= 30 ? 30 : 0;
    openCreate(slotPrefill(day, hour, minute));
  };

  const renderTimeGrid = (days: Date[]) => {
    const template = `56px repeat(${days.length}, minmax(${days.length > 1 ? '118px' : '0'}, 1fr))`;
    return (
      <div className="lf-tg">
        <div className="lf-tg-scroll" ref={gridScrollRef}>
          <div style={{ minWidth: days.length > 1 ? `${56 + days.length * 118}px` : undefined }}>
            <div className="lf-tg-head" style={{ gridTemplateColumns: template }}>
              <div className="lf-tg-headcell" />
              {days.map(day => {
                const dayHolidays = holidaysFor(day);
                return (
                  <div
                    key={day.toISOString()}
                    className={cn('lf-tg-headcell', weekendDays.includes(day.getDay()) && 'is-weekend', isToday(day) && 'is-today')}
                  >
                    <span className="lf-tg-dayname">{DAYS_OF_WEEK[day.getDay()]}</span>
                    <span className={cn('lf-tg-daynum', isToday(day) && 'is-today')}>{day.getDate()}</span>
                    {dayHolidays.length > 0 && (
                      <span className="lf-tg-holiday" title={dayHolidays.map(h => (h.nameBn ? `${h.name} · ${h.nameBn}` : h.name)).join(' · ')}>
                        {dayHolidays.map(h => h.name).join(' · ')}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="lf-tg-body" style={{ gridTemplateColumns: template, height: `${24 * HOUR_PX}px` }}>
              <div className="lf-tg-gutter">
                {HOURS.slice(1).map(h => (
                  <span key={h} className="lf-tg-hourlabel" style={{ top: `${h * HOUR_PX}px` }}>
                    {`${String(h).padStart(2, '0')}:00`}
                  </span>
                ))}
              </div>
              {days.map(day => {
                const dayEvents = getEventsForDay(day);
                const laid = layoutDayEvents(dayEvents.map(e => ({ id: e.id, ...eventSpan(e.date, e.durationMin) })));
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'lf-tg-col',
                      weekendDays.includes(day.getDay()) && 'is-weekend',
                      holidaysFor(day).length > 0 && 'is-holiday',
                      isToday(day) && 'is-today',
                    )}
                    onClick={handleSlotClick(day)}
                    title="Click an empty slot to create an event"
                  >
                    {isToday(day) && (
                      <div className="lf-tg-now" style={{ top: `${(minutesOfDay(now) / 60) * HOUR_PX}px` }} />
                    )}
                    {dayEvents.map(event => {
                      const span = eventSpan(event.date, event.durationMin);
                      const pos = laid.get(event.id) || { column: 0, columns: 1 };
                      const top = (span.startMin / 60) * HOUR_PX;
                      const height = Math.max(20, ((span.endMin - span.startMin) / 60) * HOUR_PX - 2);
                      return (
                        <button
                          key={event.id}
                          type="button"
                          onClick={e => { e.stopPropagation(); void openEvent(event); }}
                          className={cn('lf-tg-event', `lf-tg-event--${event.category}`, String(event.status).toLowerCase() === 'completed' && 'is-completed')}
                          style={{
                            top: `${top}px`,
                            height: `${height}px`,
                            left: `calc(${(pos.column / pos.columns) * 100}% + 2px)`,
                            width: `calc(${100 / pos.columns}% - 4px)`,
                          }}
                          title={`${event.title} · ${fmtTime(event.date)}`}
                        >
                          <span className="lf-tg-event-time">{fmtTime(event.date)}</span>
                          <span className="lf-tg-event-title">{event.title}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ---------------- agenda list (mobile Day + embedded) ---------------- */

  const renderAgendaList = (list: CalendarEvent[], emptyText: string) => (
    <div className="space-y-2">
      {list.length === 0 ? (
        <div className="py-10 border border-dashed border-slate-200 rounded-xl text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest italic bg-[#FBFAF8]">
          {emptyText}
        </div>
      ) : (
        list.map(event => (
          <button
            key={event.id}
            type="button"
            onClick={() => void openEvent(event)}
            className="w-full flex items-stretch gap-3 bg-white border border-slate-200/70 rounded-xl p-3 text-left hover:shadow-md transition-shadow cursor-pointer"
          >
            <span className="w-1.5 rounded-full shrink-0" style={{ background: CATEGORY_HEX[event.category] }} />
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-black text-slate-900 truncate">{event.title}</span>
                {String(event.status).toLowerCase() === 'completed' && (
                  <span className="text-[8px] font-black uppercase tracking-widest text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5">Completed</span>
                )}
              </span>
              <span className="block text-[10px] text-slate-500 font-semibold mt-0.5">
                {CATEGORY_LABELS[event.category]}
                {event.leadName ? ` · ${event.leadName}` : ''}
                {event.location ? ` · ${event.location}` : ''}
              </span>
            </span>
            <span className="text-right shrink-0">
              <span className="block text-[11px] font-black font-mono text-slate-800">{fmtTime(event.date)}</span>
              <span className="block text-[9px] font-bold text-slate-400">{event.date.getDate()} {MONTHS[event.date.getMonth()].slice(0, 3)}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );

  const renderDayView = () => {
    const dayEvents = getEventsForDay(currentDate);
    const dayHolidays = holidaysFor(currentDate);
    return (
      <div>
        {dayHolidays.length > 0 && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-[#F5F1DE] border border-[#E7E0BC] text-[11px] font-bold text-[#756C1B]">
            Holiday: {dayHolidays.map(h => (h.nameBn ? `${h.name} (${h.nameBn})` : h.name)).join(' · ')}
          </div>
        )}
        <div className="hidden md:block">{renderTimeGrid([currentDate])}</div>
        <div className="md:hidden">{renderAgendaList(dayEvents, 'No events scheduled for this day.')}</div>
      </div>
    );
  };

  /* ---------------- embedded (Dashboard) ---------------- */

  if (embedded) {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const upcoming = filteredEvents.filter(e => e.date >= startOfToday).slice(0, 6);
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-lg font-black text-brand-text tracking-tight flex items-center gap-2">
            <CalendarIcon className="w-5 h-5 text-[#978C21]" /> Task Calendar
          </h4>
          <button
            type="button"
            onClick={() => navigate('/task-calendar')}
            className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#978C21] hover:underline cursor-pointer"
          >
            Open Calendar <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
        {loading ? (
          <div className="py-16 flex justify-center"><div className="w-8 h-8 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" /></div>
        ) : (
          <>
            {renderMonthView(true)}
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 block mb-2">
                {isSameDay(embeddedDay, new Date()) ? 'Upcoming' : `${embeddedDay.getDate()} ${MONTHS[embeddedDay.getMonth()]} — day agenda`}
              </span>
              {renderAgendaList(
                isSameDay(embeddedDay, new Date()) ? upcoming : getEventsForDay(embeddedDay),
                'Nothing scheduled.',
              )}
            </div>
          </>
        )}
        <AnimatePresence>
          {selectedEvent && (
            <EventDetailModal
              ev={selectedEvent}
              currentUser={user}
              canEdit={canEditScheduled}
              onClose={() => setSelectedEvent(null)}
              onComplete={() => void handleComplete(selectedEvent)}
              onCancel={() => void handleCancel(selectedEvent)}
              onDelete={() => void handleDelete(selectedEvent)}
              onRsvp={r => void handleRsvp(selectedEvent, r)}
              onEdit={() => openEdit(selectedEvent)}
              onOpenLead={() => { const id = selectedEvent.leadId; setSelectedEvent(null); if (id) navigate(`/leads?leadId=${id}`); }}
              onOpenRoadshows={() => { setSelectedEvent(null); navigate('/roadshows'); }}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {form && (
            <EventFormModal
              initial={form}
              currentUserId={user?.id}
              onClose={() => setForm(null)}
              onSubmit={handleFormSubmit}
            />
          )}
        </AnimatePresence>
      </div>
    );
  }

  /* ---------------- full page ---------------- */

  const weekDays = visibleWeekDates(currentDate, weekendDays, viewMode === 'workweek');

  return (
    <div className="max-w-[1440px] mx-auto pb-24 space-y-4">
      <BackButton fallback="/" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-100 bg-[#F9F9F4] text-[#978C21] shadow-sm">
            <CalendarIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 leading-none">Task Calendar</h1>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.25em] mt-1.5">Follow-ups · Meetings · Tasks · Roadshows</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => openCreate()}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-[11px] font-black uppercase tracking-widest rounded-lg shadow-md shadow-[#978C21]/20 cursor-pointer"
        >
          <Plus className="w-4 h-4" /> New event
        </button>
      </div>

      <div className="flex gap-4 items-start">
        <aside className="hidden lg:block w-[248px] shrink-0 sticky top-4">{renderRailContent()}</aside>

        <section className="flex-1 min-w-0 space-y-3">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 bg-[#FBFAF8] border border-slate-200/70 rounded-xl p-2.5">
            <button
              type="button"
              onClick={() => setRailOpen(true)}
              className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-2 border border-slate-200 bg-white text-[10px] font-black uppercase tracking-widest text-slate-600 cursor-pointer rounded-lg"
            >
              <ListFilter className="w-3.5 h-3.5" /> Calendars
            </button>
            <div className="flex items-center gap-1.5">
              <button type="button" aria-label="Previous" onClick={() => navigatePeriod('prev')} className="p-2 border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer rounded-lg"><ChevronLeft className="w-4 h-4" /></button>
              <button type="button" onClick={() => setCurrentDate(new Date())} className="px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-600 cursor-pointer rounded-lg">Today</button>
              <button type="button" aria-label="Next" onClick={() => navigatePeriod('next')} className="p-2 border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer rounded-lg"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <span className="text-[12px] font-black text-slate-800 min-w-[150px] text-center flex-1 sm:flex-none">{rangeTitle}</span>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex-1 sm:flex-none sm:ml-auto min-w-[150px]">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search events…"
                className="outline-none bg-transparent w-full text-[11px] font-semibold placeholder:text-slate-300"
              />
            </div>
            <div className="flex items-center gap-1 border border-slate-200 p-1 rounded-lg bg-white">
              {([
                ['day', 'Day'],
                ['workweek', 'Work week'],
                ['week', 'Week'],
                ['month', 'Month'],
              ] as [ViewMode, string][]).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    'px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider cursor-pointer rounded-md transition-all',
                    viewMode === mode ? 'bg-[#978C21] text-white shadow' : 'text-slate-400 hover:text-slate-800 hover:bg-slate-100',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          {loading ? (
            <div className="py-32 flex flex-col justify-center items-center gap-4">
              <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" />
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic animate-pulse">Syncing calendar…</p>
            </div>
          ) : (
            <div className="min-h-[400px]">
              {viewMode === 'month' && renderMonthView()}
              {viewMode === 'day' && renderDayView()}
              {(viewMode === 'week' || viewMode === 'workweek') && renderTimeGrid(weekDays)}
            </div>
          )}
        </section>
      </div>

      {/* Mobile rail slide-over */}
      <AnimatePresence>
        {railOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-slate-900/40" onClick={() => setRailOpen(false)} />
            <motion.div
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              className="absolute left-0 top-0 bottom-0 w-[272px] bg-[#FBFAF8] p-3 overflow-y-auto shadow-2xl"
            >
              <div className="flex justify-end mb-2">
                <button type="button" onClick={() => setRailOpen(false)} className="p-1.5 border border-slate-200 bg-white cursor-pointer rounded-lg"><X className="w-4 h-4" /></button>
              </div>
              {renderRailContent()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedEvent && (
          <EventDetailModal
            ev={selectedEvent}
            currentUser={user}
            canEdit={canEditScheduled}
            onClose={() => setSelectedEvent(null)}
            onComplete={() => void handleComplete(selectedEvent)}
            onCancel={() => void handleCancel(selectedEvent)}
            onDelete={() => void handleDelete(selectedEvent)}
            onRsvp={r => void handleRsvp(selectedEvent, r)}
            onEdit={() => openEdit(selectedEvent)}
            onOpenLead={() => { const id = selectedEvent.leadId; setSelectedEvent(null); if (id) navigate(`/leads?leadId=${id}`); }}
            onOpenRoadshows={() => { setSelectedEvent(null); navigate('/roadshows'); }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {form && (
          <EventFormModal
            initial={form}
            currentUserId={user?.id}
            onClose={() => setForm(null)}
            onSubmit={handleFormSubmit}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ================================================================== */
/* Event detail modal                                                  */
/* ================================================================== */

interface DetailProps {
  ev: CalendarEvent;
  currentUser: User | null;
  canEdit: boolean;
  onClose: () => void;
  onComplete: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onRsvp: (response: 'accepted' | 'declined') => void;
  onEdit: () => void;
  onOpenLead: () => void;
  onOpenRoadshows: () => void;
}

function EventDetailModal({ ev, currentUser, canEdit, onClose, onComplete, onCancel, onDelete, onRsvp, onEdit, onOpenLead, onOpenRoadshows }: DetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sa = ev.raw;
  const attendees = sa?.attendees || [];
  const mine = currentUser
    ? attendees.find(a => a.userId === currentUser.id || (currentUser.employeeId && a.employeeId === currentUser.employeeId))
    : undefined;
  const myPending = Boolean(mine && mine.response === 'pending' && String(ev.status).toLowerCase() === 'scheduled');
  const isScheduled = String(ev.status).toLowerCase() === 'scheduled';
  const span = eventSpan(ev.date, ev.durationMin);
  const endDate = new Date(ev.date);
  endDate.setMinutes(endDate.getMinutes() + (span.endMin - span.startMin));
  const reminder = sa?.reminderMinutes ?? sa?.reminder_minutes ?? null;

  const responseChip = (r: string) =>
    r === 'accepted'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : r === 'declined'
        ? 'bg-rose-50 text-rose-700 border-rose-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 15 }}
        className="bg-white border border-slate-200 w-full max-w-lg shadow-2xl overflow-hidden max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl"
      >
        <div className="bg-[#FBFAF8] p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-white rounded-md" style={{ background: CATEGORY_HEX[ev.category] }}>
                {ev.category === 'customer_meeting' || ev.category === 'team_meeting' ? <Video className="w-3 h-3" /> : ev.category === 'call' ? <Phone className="w-3 h-3" /> : ev.category === 'task' ? <FileText className="w-3 h-3" /> : <CalendarIcon className="w-3 h-3" />}
                {CATEGORY_LABELS[ev.category]}
              </span>
              <span className={cn(
                'px-2 py-1 border text-[9px] font-black uppercase tracking-widest rounded-md',
                isScheduled && 'bg-sky-50 border-sky-200 text-sky-700',
                String(ev.status).toLowerCase() === 'completed' && 'bg-emerald-50 border-emerald-200 text-emerald-700',
                !isScheduled && String(ev.status).toLowerCase() !== 'completed' && 'bg-slate-100 border-slate-200 text-slate-500',
              )}>
                {ev.status}
              </span>
            </div>
            <h3 className="text-base font-black tracking-tight text-slate-900 mt-2 break-words">{ev.title}</h3>
            <p className="text-[11px] font-bold text-slate-500 mt-1 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#978C21]" />
              {fmtDateLong(ev.date)} · {fmtTime(ev.date)} – {fmtTime(endDate)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer border border-slate-100 bg-white rounded-lg shrink-0"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {ev.managed && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-semibold text-amber-800 leading-relaxed">
              From lead follow-up — this entry is kept in sync with the lead's next step, so its time is managed from the lead, not here. Open the lead to change it.
            </div>
          )}

          {ev.leadId && (
            <div className="flex items-center justify-between gap-3 p-3 bg-slate-50 border border-slate-100 rounded-lg">
              <div className="min-w-0">
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Lead</span>
                <span className="text-[12px] font-black text-slate-800 block truncate">{ev.leadName || 'Lead'}</span>
                <span className="text-[10px] font-mono font-bold text-slate-400 block">
                  {ev.leadMobile || ''}{ev.leadStatus ? ` · ${ev.leadStatus}` : ''}
                </span>
              </div>
              <button type="button" onClick={onOpenLead} className="px-3 py-2 bg-[#978C21] hover:bg-[#83781C] text-white text-[10px] font-black uppercase tracking-widest rounded-lg flex items-center gap-1 cursor-pointer shrink-0">
                Open lead <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-[11px]">
            {ev.location && (
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1">Location</span>
                <span className="font-bold text-slate-700 flex items-center gap-1"><MapPin className="w-3 h-3 text-slate-300" />{ev.location}</span>
              </div>
            )}
            {ev.priority && (
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1">Priority</span>
                <span className="font-bold text-slate-700">{ev.priority}</span>
              </div>
            )}
            {reminder != null && (
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1">Reminder</span>
                <span className="font-bold text-slate-700 flex items-center gap-1"><Bell className="w-3 h-3 text-slate-300" />{reminder} min before</span>
              </div>
            )}
            {ev.kind === 'roadshow' && ev.roadshow && (
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg col-span-2">
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1">Assigned team</span>
                <span className="font-bold text-slate-700">{ev.roadshow.assignedUsers.map(p => p.name).join(', ') || 'No assignees'}</span>
              </div>
            )}
          </div>

          {attendees.length > 0 && (
            <div>
              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1 mb-2"><Users className="w-3 h-3" /> Attendees</span>
              <div className="flex flex-wrap gap-1.5">
                {attendees.map(a => (
                  <span key={a.userId} className={cn('inline-flex items-center gap-1.5 px-2 py-1 border rounded-full text-[10px] font-bold', responseChip(String(a.response)))}>
                    {a.fullName || a.employeeId || 'Colleague'}
                    <span className="uppercase text-[8px] font-black">{String(a.response)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {ev.remarks && (
            <div className="p-3 bg-[#FBFAF8] border border-slate-200/60 rounded-lg">
              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block mb-1">Remarks</span>
              <p className="text-[11px] text-slate-600 font-medium leading-relaxed">{ev.remarks}</p>
            </div>
          )}
        </div>

        <div className="p-4 bg-[#FBFAF8] border-t border-slate-100 flex gap-2 justify-end flex-wrap">
          {ev.kind === 'roadshow' ? (
            <button type="button" onClick={onOpenRoadshows} className="px-4 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer flex items-center gap-1.5">
              Open Roadshows <ExternalLink className="w-3 h-3" />
            </button>
          ) : ev.managed ? (
            <button type="button" onClick={onOpenLead} className="px-4 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer flex items-center gap-1.5">
              Open lead <ExternalLink className="w-3 h-3" />
            </button>
          ) : (
            <>
              {myPending && (
                <>
                  <button type="button" onClick={() => onRsvp('accepted')} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Accept</button>
                  <button type="button" onClick={() => onRsvp('declined')} className="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Decline</button>
                </>
              )}
              {isScheduled && (canEdit ? (
                <>
                  <button type="button" onClick={onEdit} className="px-4 py-2.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer flex items-center gap-1.5"><Pencil className="w-3 h-3" /> Edit</button>
                  <button type="button" onClick={onComplete} className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer flex items-center gap-1.5"><CheckCircle className="w-3 h-3" /> Complete</button>
                  <button type="button" onClick={onCancel} className="px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Cancel</button>
                  {confirmDelete ? (
                    <button type="button" onClick={onDelete} className="px-4 py-2.5 bg-rose-700 hover:bg-rose-800 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Confirm delete</button>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)} className="px-4 py-2.5 border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer flex items-center gap-1.5"><Trash2 className="w-3 h-3" /> Delete</button>
                  )}
                </>
              ) : (
                <span className="text-[10px] font-bold text-slate-400 self-center">View only — editing needs the leads.edit permission.</span>
              ))}
            </>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-500 font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Close</button>
        </div>
      </motion.div>
    </div>
  );
}

/* ================================================================== */
/* Create / edit event form modal                                      */
/* ================================================================== */

interface FormProps {
  initial: EventFormState;
  currentUserId?: string;
  onClose: () => void;
  onSubmit: (f: EventFormState) => Promise<boolean>;
}

function EventFormModal({ initial, currentUserId, onClose, onSubmit }: FormProps) {
  const [f, setF] = useState<EventFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadQuery, setLeadQuery] = useState('');
  const [attendeeQuery, setAttendeeQuery] = useState('');

  const needsLead = kindRequiresLead(f.kind);
  const showAttendees = f.kind === 'customer_meeting' || f.kind === 'team_meeting' || f.kind === 'task';
  const isEdit = f.mode === 'edit';

  useEffect(() => {
    let cancelled = false;
    userService.getAllUsers()
      .then(list => { if (!cancelled) setUsers(list || []); })
      .catch(() => { /* attendee picker simply stays empty */ });
    leadService.getRecentLeads(200)
      .then(list => { if (!cancelled) setLeads(list || []); })
      .catch(() => { /* lead picker simply stays empty */ });
    return () => { cancelled = true; };
  }, []);

  const activeUsers = useMemo(
    () => users.filter(p => (p.status === 'Active' || p.employmentStatus === 'Active') && p.id !== currentUserId),
    [users, currentUserId],
  );
  const attendeeResults = useMemo(() => {
    const q = attendeeQuery.trim().toLowerCase();
    const pool = q
      ? activeUsers.filter(p => (p.name || p.fullName || '').toLowerCase().includes(q) || (p.employeeId || '').toLowerCase().includes(q))
      : activeUsers;
    return pool.slice(0, 30);
  }, [activeUsers, attendeeQuery]);

  const leadResults = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    if (!q) return [];
    return leads
      .filter(l => (l.prospectName || '').toLowerCase().includes(q) || (l.mobile || '').includes(q))
      .slice(0, 8);
  }, [leads, leadQuery]);

  const set = (patch: Partial<EventFormState>) => setF(prev => ({ ...prev, ...patch }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const ok = await onSubmit(f);
      if (!ok) setSaving(false);
    } catch {
      setSaving(false);
    }
  };

  const inputCls = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-[12px] font-semibold outline-none focus:border-[#978C21] bg-white';
  const labelCls = 'text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1';

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 15 }}
        className="bg-white border border-slate-200 w-full max-w-xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl"
      >
        <div className="bg-[#FBFAF8] p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-base font-black tracking-tight text-slate-900">{isEdit ? 'Edit event' : 'New event'}</h3>
          <button type="button" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer border border-slate-100 bg-white rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Type */}
          <div>
            <span className={labelCls}>Type</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(FORM_KIND_LABELS) as EventFormKind[]).map(kind => (
                <button
                  key={kind}
                  type="button"
                  disabled={isEdit}
                  onClick={() => set({ kind })}
                  className={cn(
                    'px-3 py-2 text-[10px] font-black uppercase tracking-wider rounded-lg border cursor-pointer',
                    f.kind === kind ? 'text-white border-transparent' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50',
                    isEdit && 'opacity-60 cursor-not-allowed',
                  )}
                  style={f.kind === kind ? { background: CATEGORY_HEX[kind === 'follow_up' ? 'followup' : kind === 'customer_meeting' ? 'customer_meeting' : kind === 'team_meeting' ? 'team_meeting' : kind] } : undefined}
                >
                  {FORM_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
            {isEdit && <p className="text-[10px] text-slate-400 font-semibold mt-1.5">Type can't be changed after creation.</p>}
          </div>

          {/* Title */}
          <div>
            <span className={labelCls}>Title {needsLead ? '(optional — defaults from the lead)' : ''}</span>
            <input value={f.title} onChange={e => set({ title: e.target.value })} placeholder={f.kind === 'team_meeting' ? 'e.g. Weekly sales sync' : 'Event title'} className={inputCls} maxLength={255} />
          </div>

          {/* Lead picker */}
          {(needsLead || f.kind === 'customer_meeting' || f.leadId) && (
            <div>
              <span className={labelCls}>Lead {needsLead ? '(required)' : ''}</span>
              {f.leadId ? (
                <div className="flex items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[12px] font-black text-slate-800 truncate">{f.leadLabel || 'Selected lead'}</span>
                  {!isEdit && (
                    <button type="button" onClick={() => set({ leadId: '', leadLabel: '' })} className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ) : (
                <div className="relative">
                  <input
                    value={leadQuery}
                    onChange={e => setLeadQuery(e.target.value)}
                    placeholder="Search leads by name or mobile…"
                    className={inputCls}
                  />
                  {leadResults.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-10 overflow-hidden">
                      {leadResults.map(l => (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => { set({ leadId: l.id, leadLabel: l.prospectName }); setLeadQuery(''); }}
                          className="w-full text-left px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center justify-between gap-2"
                        >
                          <span className="text-[12px] font-bold text-slate-800 truncate">{l.prospectName}</span>
                          <span className="text-[10px] font-mono text-slate-400 shrink-0">{l.mobile} · {l.currentStatus}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Date / time */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <span className={labelCls}>Date</span>
              <input type="date" value={f.date} onChange={e => set({ date: e.target.value })} className={inputCls} />
            </div>
            <div>
              <span className={labelCls}>Start</span>
              <input type="time" value={f.startTime} onChange={e => set({ startTime: e.target.value })} className={inputCls} />
            </div>
            <div>
              <span className={labelCls}>End</span>
              <input type="time" value={f.endTime} onChange={e => set({ endTime: e.target.value })} className={inputCls} />
            </div>
          </div>

          {/* Attendees */}
          {showAttendees && (
            <div>
              <span className={labelCls}>Attendees (active colleagues)</span>
              {f.attendeeIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {f.attendeeIds.map(id => {
                    const person = users.find(u => u.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1.5 px-2 py-1 bg-[#EFECCE] border border-[#E0D9A8] rounded-full text-[10px] font-bold text-slate-700">
                        {person ? (person.name || person.fullName) : 'Colleague'}
                        <button type="button" onClick={() => set({ attendeeIds: f.attendeeIds.filter(x => x !== id) })} className="text-slate-400 hover:text-rose-600 cursor-pointer"><X className="w-3 h-3" /></button>
                      </span>
                    );
                  })}
                </div>
              )}
              <input value={attendeeQuery} onChange={e => setAttendeeQuery(e.target.value)} placeholder="Search colleagues…" className={inputCls} />
              <div className="mt-2 max-h-36 overflow-y-auto border border-slate-100 rounded-lg divide-y divide-slate-50">
                {attendeeResults.length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-slate-400 font-semibold">No active colleagues found.</p>
                ) : (
                  attendeeResults.map(p => (
                    <label key={p.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={f.attendeeIds.includes(p.id)}
                        onChange={e => set({ attendeeIds: e.target.checked ? [...f.attendeeIds, p.id] : f.attendeeIds.filter(x => x !== p.id) })}
                        className="w-3.5 h-3.5 accent-[#978C21]"
                      />
                      <span className="text-[12px] font-bold text-slate-700 truncate">{p.name || p.fullName} <span className="text-slate-400 font-semibold">· {p.employeeId}</span></span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-[10px] text-slate-400 font-semibold mt-1.5">You are the organiser and are always included.</p>
            </div>
          )}

          {/* Location / reminder / priority */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <span className={labelCls}>Location</span>
              <input value={f.location} onChange={e => set({ location: e.target.value })} placeholder="Office, client site…" className={inputCls} maxLength={255} />
            </div>
            <div>
              <span className={labelCls}>Reminder</span>
              <select value={f.reminder} onChange={e => set({ reminder: e.target.value })} className={inputCls}>
                {REMINDER_OPTIONS.map(o => (
                  <option key={o.label} value={o.value == null ? 'none' : String(o.value)}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={labelCls}>Priority</span>
              <select value={f.priority} onChange={e => set({ priority: e.target.value })} className={inputCls}>
                {['LOW', 'NORMAL', 'MEDIUM', 'HIGH'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {/* Remarks */}
          <div>
            <span className={labelCls}>Remarks</span>
            <textarea value={f.remarks} onChange={e => set({ remarks: e.target.value })} rows={3} placeholder="Notes for this event…" className={cn(inputCls, 'resize-none')} />
          </div>
        </div>

        <div className="p-4 bg-[#FBFAF8] border-t border-slate-100 flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2.5 border border-slate-200 bg-white hover:bg-slate-50 text-slate-500 font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">Cancel</button>
          <button type="button" disabled={saving} onClick={() => void handleSave()} className="px-5 py-2.5 bg-[#978C21] hover:bg-[#83781C] disabled:opacity-60 text-white font-black text-[10px] uppercase tracking-widest rounded-lg cursor-pointer">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
