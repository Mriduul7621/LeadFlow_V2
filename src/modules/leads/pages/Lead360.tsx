import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Phone, Mail, MapPin, Briefcase, User as UserIcon,
  Clock, UserCog, FileText, Bell, Plus
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { leadService } from '../services/leadService';
import { scheduledActivityService, type ScheduledActivity } from '../../scheduledActivities/services/scheduledActivityService';
import { notificationService } from '../../notifications/services/notificationService';
import { useAuthStore } from '../../auth/store/authStore';
import { useTranslation } from '../../shared/utils/translations';
import { Lead, SystemNotification } from '../../shared/types';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';

type TimelineEventType = 'status' | 'assignment' | 'document' | 'notification';

interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  date: string;
  title: string;
  detail?: string;
  by?: string;
}

const TYPE_CONFIG: Record<TimelineEventType, { icon: any; color: string }> = {
  status: { icon: Clock, color: 'text-[#978C21] bg-[#978C21]/10' },
  assignment: { icon: UserCog, color: 'text-blue-600 bg-blue-50' },
  document: { icon: FileText, color: 'text-purple-600 bg-purple-50' },
  notification: { icon: Bell, color: 'text-amber-600 bg-amber-50' },
};

export default function Lead360() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { t, activityLabel } = useTranslation();
  const [lead, setLead] = useState<Lead | null>(null);
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TimelineEventType | 'all'>('all');
  const [docName, setDocName] = useState('');
  const [docNote, setDocNote] = useState('');
  const [addingDoc, setAddingDoc] = useState(false);

  const [activities, setActivities] = useState<any[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledActivity[]>([]);
  const [schedForm, setSchedForm] = useState<{ activityType: 'call' | 'meeting' | 'follow_up' | 'task'; scheduledAt: string; title: string; remarks: string; durationMinutes: string; priority: string; meetingType: string; location: string }>({ activityType: 'call', scheduledAt: '', title: '', remarks: '', durationMinutes: '30', priority: 'NORMAL', meetingType: '', location: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; remarks: string; scheduledAt: string; durationMinutes: string; priority: string; meetingType: string; location: string }>({ title: '', remarks: '', scheduledAt: '', durationMinutes: '', priority: 'NORMAL', meetingType: '', location: '' });
  const [schedSaving, setSchedSaving] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [l, n, a, s] = await Promise.all([
        leadService.getLead(id),
        notificationService.getNotificationsForLead(id),
        (leadService as any).getLeadActivities ? (leadService as any).getLeadActivities(id) : Promise.resolve([]),
        scheduledActivityService.getByLead(id).catch(() => []),
      ]);
      setLead(l);
      setNotifications(n);
      setActivities(Array.isArray(a) ? a : []);
      setScheduled(Array.isArray(s) ? s : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !schedForm.scheduledAt) {
      toast.error(t('scheduledDateTimeRequired'));
      return;
    }
    setSchedSaving(true);
    try {
      const d = new Date(schedForm.scheduledAt);
      if (!Number.isFinite(d.getTime())) throw new Error('Invalid date');
      const created = await scheduledActivityService.create({
        leadId: id,
        activityType: schedForm.activityType as any,
        scheduledAt: d.toISOString(),
        title: schedForm.title || null,
        remarks: schedForm.remarks || null,
        durationMinutes: schedForm.durationMinutes ? Number(schedForm.durationMinutes) : null,
        priority: (schedForm.priority as any) || 'NORMAL',
        meetingType: schedForm.meetingType || null,
        location: schedForm.location || null,
      });
      toast.success(t('scheduledActivityCreated'));
      setSchedForm({ activityType: 'call', scheduledAt: '', title: '', remarks: '', durationMinutes: '30', priority: 'NORMAL', meetingType: '', location: '' });
      // Authoritative patch — append without full refetch if possible, else fallback to fetch
      if (created && (created as any).id) {
        setScheduled(prev => [...prev, created as ScheduledActivity].sort((a,b)=> new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()));
      } else {
        const s = await scheduledActivityService.getByLead(id).catch(() => []);
        setScheduled(Array.isArray(s) ? s : []);
      }
    } catch (err: any) {
      toast.error(err?.message || t('scheduleActivityFailed'));
    } finally {
      setSchedSaving(false);
    }
  };

  const handleCompleteScheduled = async (saId: string) => {
    try {
      const res: any = await scheduledActivityService.complete(saId);
      const updated = res?.scheduled || res?.data?.scheduled;
      if (updated) {
        setScheduled(prev => prev.map(s => s.id === saId ? { ...s, ...updated } : s));
      } else {
        // fallback: patch locally
        setScheduled(prev => prev.map(s => s.id === saId ? { ...s, status: 'completed' as any, completedAt: new Date().toISOString() } : s));
      }
      toast.success(t('activityMarkedCompleted'));
      // Optionally refresh timeline
      const a = await (leadService as any).getLeadActivities?.(id!).catch(()=>[]);
      if (Array.isArray(a)) setActivities(a);
    } catch (err: any) {
      toast.error(err?.message || t('completeFailed'));
    }
  };

  const handleCancelScheduled = async (saId: string) => {
    try {
      const updated: any = await scheduledActivityService.cancel(saId);
      const data = updated?.data || updated;
      // data may be scheduled activity or wrapper
      const patched = (data && data.id) ? data : (data?.scheduled || data);
      if (patched && patched.id) {
        setScheduled(prev => prev.map(s => s.id === saId ? { ...s, ...patched } : s));
      } else {
        setScheduled(prev => prev.map(s => s.id === saId ? { ...s, status: 'cancelled' as any } : s));
      }
      toast.success(t('activityCancelledOk'));
    } catch (err: any) {
      toast.error(err?.message || t('cancelFailed'));
    }
  };

  const startEditScheduled = (sa: ScheduledActivity) => {
    if (String(sa.status).toLowerCase() !== 'scheduled') {
      toast.error(t('cannotEditActivity', { status: sa.status }));
      return;
    }
    setEditingId(sa.id);
    const dt = sa.scheduledAt ? new Date(sa.scheduledAt) : null;
    // Convert to datetime-local value (Asia/Dhaka not needed, keep local)
    let localVal = '';
    if (dt && !isNaN(dt.getTime())) {
      const pad = (n:number)=> String(n).padStart(2,'0');
      localVal = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    }
    setEditForm({
      title: sa.title || '',
      remarks: sa.remarks || '',
      scheduledAt: localVal,
      durationMinutes: sa.durationMinutes != null ? String(sa.durationMinutes) : (sa as any).duration_minutes != null ? String((sa as any).duration_minutes) : '',
      priority: (sa as any).priority || 'NORMAL',
      meetingType: (sa as any).meetingType || (sa as any).meeting_type || '',
      location: (sa as any).location || '',
    });
  };

  const handleUpdateScheduled = async (saId: string) => {
    try {
      const payload: any = {};
      if (editForm.title !== undefined) payload.title = editForm.title || null;
      if (editForm.remarks !== undefined) payload.remarks = editForm.remarks || null;
      if (editForm.scheduledAt) {
        const d = new Date(editForm.scheduledAt);
        if (!Number.isFinite(d.getTime())) throw new Error('Invalid date');
        payload.scheduledAt = d.toISOString();
      }
      if (editForm.durationMinutes !== undefined) payload.durationMinutes = editForm.durationMinutes ? Number(editForm.durationMinutes) : null;
      if (editForm.priority) payload.priority = editForm.priority;
      if (editForm.meetingType !== undefined) payload.meetingType = editForm.meetingType || null;
      if (editForm.location !== undefined) payload.location = editForm.location || null;
      const updated = await scheduledActivityService.update(saId, payload);
      setScheduled(prev => prev.map(s => s.id === saId ? { ...s, ...updated } : s));
      setEditingId(null);
      toast.success(t('activityUpdated'));
    } catch (err: any) {
      toast.error(err?.message || t('updateFailed'));
    }
  };

  const handleDeleteScheduled = async (saId: string) => {
    try {
      await scheduledActivityService.remove(saId);
      toast.success(t('activityRemoved'));
      setScheduled(prev => prev.filter(s => s.id !== saId));
    } catch (err: any) {
      toast.error(err?.message || t('deleteFailed'));
    }
  };

  const timeline: TimelineEvent[] = useMemo(() => {
    if (!lead) return [];
    const events: TimelineEvent[] = [];

    // Prefer server-authoritative lead_activities when available (NEW LeadFlow events);
    // otherwise fall back to embedded statusHistory for backward compat / legacy leads.
    const authoritativeActivities = activities && activities.length > 0 ? activities : null;
    if (authoritativeActivities) {
      authoritativeActivities.forEach((act: any, i: number) => {
        const status = act.status || act.currentStatus || 'Unknown';
        const date = act.createdAt || act.created_at || act.date || new Date().toISOString();
        const parts: string[] = [];
        const remarks = act.remarks || '';
        if (remarks) parts.push(remarks);
        if (act.lossReason || act.loss_reason) parts.push(`Loss Reason: ${act.lossReason || act.loss_reason}`);
        if (act.meetingType || act.meeting_type) parts.push(`Meeting Type: ${act.meetingType || act.meeting_type}`);
        const nfd = act.nextFollowUpAt || act.next_follow_up_at || act.nextFollowUpDate;
        if (nfd) {
          try { parts.push(`Next follow-up: ${new Date(nfd).toLocaleDateString()}`); } catch {}
        }
        const ncd = act.nextCallAt || act.next_call_at || act.nextCallDate;
        if (ncd) {
          try { parts.push(`Next call: ${new Date(ncd).toLocaleDateString()}`); } catch {}
        }
        const md = act.meetingAt || act.meeting_at || act.meetingDate;
        if (md) {
          try { parts.push(`Meeting: ${new Date(md).toLocaleDateString()}`); } catch {}
        }
        const pn = act.productName || act.product_name;
        if (pn) parts.push(`Product: ${pn}`);
        const sa = act.sumAssured ?? act.sum_assured;
        if (sa) parts.push(`Sum Assured: ${sa}`);
        const pncp = act.projectedNcp ?? act.projected_ncp ?? act.projectedNCP;
        if (pncp) parts.push(`Projected NCP: ${pncp}`);
        const cncp = act.collectedNcp ?? act.collected_ncp ?? act.collectedNCP;
        if (cncp) parts.push(`Collected NCP: ${cncp}`);
        const by = act.actorEmployeeId || act.actor_employee_id || act.actor || act.updatedBy || act.createdBy || act.created_by || act.created_by_employee;
        events.push({
          id: `activity_${act.id || i}_${date}`,
          type: 'status',
          date,
          title: `Status changed to "${status}"`,
          detail: parts.join(' · '),
          by,
        });
      });
      // Also include any legacy statusHistory entries that pre-date the activities table
      // (imported snapshot) so history is not lost — dedupe by date+status when overlapping.
      const seen = new Set(events.map(e => `${e.title}|${e.date}`));
      (lead.statusHistory || []).forEach((h, i) => {
        const key = `Status changed to "${h.status}"|${h.date}`;
        if (seen.has(key)) return;
        const parts: string[] = [];
        if (h.remarks) parts.push(h.remarks);
        if (h.lossReason) parts.push(`Loss Reason: ${h.lossReason}`);
        if (h.meetingType) parts.push(`Meeting Type: ${h.meetingType}`);
        if (h.nextFollowUpDate) parts.push(`Next follow-up: ${new Date(h.nextFollowUpDate).toLocaleDateString()}`);
        if (h.nextCallDate) parts.push(`Next call: ${new Date(h.nextCallDate).toLocaleDateString()}`);
        if (h.meetingDate) parts.push(`Meeting: ${new Date(h.meetingDate).toLocaleDateString()}`);
        if (h.productName) parts.push(`Product: ${h.productName}`);
        if (h.sumAssured) parts.push(`Sum Assured: ${h.sumAssured}`);
        events.push({
          id: `status_${i}_${h.date}`,
          type: 'status',
          date: h.date,
          title: `Status changed to "${h.status}"`,
          detail: parts.join(' · '),
          by: h.updatedBy,
        });
      });
    } else {
      (lead.statusHistory || []).forEach((h, i) => {
        const parts: string[] = [];
        if (h.remarks) parts.push(h.remarks);
        if (h.lossReason) parts.push(`Loss Reason: ${h.lossReason}`);
        if (h.meetingType) parts.push(`Meeting Type: ${h.meetingType}`);
        if (h.nextFollowUpDate) parts.push(`Next follow-up: ${new Date(h.nextFollowUpDate).toLocaleDateString()}`);
        if (h.nextCallDate) parts.push(`Next call: ${new Date(h.nextCallDate).toLocaleDateString()}`);
        if (h.meetingDate) parts.push(`Meeting: ${new Date(h.meetingDate).toLocaleDateString()}`);
        if (h.productName) parts.push(`Product: ${h.productName}`);
        if (h.sumAssured) parts.push(`Sum Assured: ${h.sumAssured}`);
        events.push({
          id: `status_${i}_${h.date}`,
          type: 'status',
          date: h.date,
          title: `Status changed to "${h.status}"`,
          detail: parts.join(' · '),
          by: h.updatedBy,
        });
      });
    }

    (lead.assignmentHistory || []).forEach((a, i) => {
      events.push({
        id: `assign_${i}_${a.date}`,
        type: 'assignment',
        date: a.date,
        title: a.fromEmployeeId
          ? `Reassigned from ${a.fromEmployeeId} to ${a.toEmployeeId}`
          : `Assigned to ${a.toEmployeeId}`,
        detail: a.note,
        by: a.changedBy,
      });
    });

    (lead.documents || []).forEach((d, i) => {
      events.push({
        id: `doc_${i}_${d.date}`,
        type: 'document',
        date: d.date,
        title: `Document added: ${d.name}`,
        detail: d.note,
        by: d.uploadedBy,
      });
    });

    notifications.forEach(n => {
      events.push({
        id: `notif_${n.id}`,
        type: 'notification',
        date: n.date,
        title: n.title,
        detail: n.message,
      });
    });

    return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [lead, notifications, activities]);

  const filteredTimeline = filter === 'all' ? timeline : timeline.filter(e => e.type === filter);

  const handleAddDocument = async () => {
    if (!docName.trim() || !id || !user) return;
    try {
      await leadService.addDocument(id, docName.trim(), docNote.trim() || undefined, user.name);
      toast.success(t('documentAdded'));
      setDocName('');
      setDocNote('');
      setAddingDoc(false);
      load();
    } catch {
      toast.error(t('documentAddFailed'));
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">{t('loadingLead')}</div>;
  }

  if (!lead) {
    return (
      <div className="p-10 text-center space-y-4">
        <p className="text-[11px] text-slate-400 uppercase tracking-widest italic">{t('leadNotFound')}</p>
        <button onClick={() => navigate(-1)} className="text-sm font-medium text-[#978C21] hover:underline">{t('goBack')}</button>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto space-y-8">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#978C21] transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> {t('back')}
      </button>

      {/* Header */}
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm p-8">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-800">{lead.prospectName}</h1>
            <div className="flex items-center gap-4 mt-2 flex-wrap text-[11px] text-slate-500 font-bold">
              <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> {lead.mobile}</span>
              {lead.email && <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> {lead.email}</span>}
              {lead.profession && <span className="flex items-center gap-1"><Briefcase className="w-3.5 h-3.5" /> {lead.profession}</span>}
              {(lead.district || lead.thana) && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {[lead.thana, lead.district].filter(Boolean).join(', ')}</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn("px-3 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-widest border", getLeadStatusColorClasses(lead.currentStatus))}>
              {lead.currentStatus}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-50">
          <div>
            <p className="text-xs font-medium text-slate-500">{t('assignedTo')}</p>
            <p className="text-[12px] font-black text-brand-text flex items-center gap-1 mt-1"><UserIcon className="w-3.5 h-3.5" /> {lead.assignedTo || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">{t('product')}</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.productName || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">{t('source')}</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.source || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">{t('created')}</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.creationDate ? new Date(lead.creationDate).toLocaleDateString() : '-'}</p>
          </div>
        </div>
      </div>

      {/* Scheduled Activities — server-authoritative calendar (Step 5C) */}
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm p-6">
        <h3 className="text-sm font-black uppercase tracking-[0.14em] text-slate-700 mb-4">{t('scheduledActivities')}</h3>
        <p className="text-[11px] text-slate-400 mb-4">{t('scheduledActivitiesDesc')}</p>
        <form onSubmit={handleSchedule} className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-6 bg-[#FBFAF8] border border-slate-100 p-4 rounded-sm">
          <select value={schedForm.activityType} onChange={e => setSchedForm({ ...schedForm, activityType: e.target.value as any })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs bg-white">
            <option value="call">{t('activityCall')}</option>
            <option value="meeting">{t('activityMeeting')}</option>
            <option value="follow_up">{t('activityFollowUp')}</option>
            <option value="task">{t('activityTask')}</option>
          </select>
          <input type="datetime-local" value={schedForm.scheduledAt} onChange={e => setSchedForm({ ...schedForm, scheduledAt: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs" required />
          <input type="text" placeholder={t('titleOptional')} value={schedForm.title} onChange={e => setSchedForm({ ...schedForm, title: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs" />
          <input type="number" placeholder={t('durationMin')} value={schedForm.durationMinutes} onChange={e => setSchedForm({ ...schedForm, durationMinutes: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs" min={1} max={1440} />
          <select value={schedForm.priority} onChange={e => setSchedForm({ ...schedForm, priority: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs bg-white">
            <option value="LOW">{t('priorityLow')}</option>
            <option value="NORMAL">{t('priorityNormal')}</option>
            <option value="MEDIUM">{t('priorityMedium')}</option>
            <option value="HIGH">{t('priorityHigh')}</option>
          </select>
          <input type="text" placeholder={t('meetingTypeOptional')} value={schedForm.meetingType} onChange={e => setSchedForm({ ...schedForm, meetingType: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs" />
          <input type="text" placeholder={t('locationOptional')} value={schedForm.location} onChange={e => setSchedForm({ ...schedForm, location: e.target.value })} className="border border-slate-200 rounded-sm px-2 py-2 text-xs" />
          <input type="text" placeholder={t('remarksOptional')} value={schedForm.remarks} onChange={e => setSchedForm({ ...schedForm, remarks: e.target.value })} className="md:col-span-5 border border-slate-200 rounded-sm px-2 py-2 text-xs" />
          <button type="submit" disabled={schedSaving} className="bg-[#978C21] text-white text-xs font-bold px-3 py-2 rounded-sm disabled:opacity-50 md:col-span-2">{t('schedule')}</button>
        </form>
        {scheduled.length === 0 ? (
          <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-sm px-4 py-6 text-center">{t('noScheduledActivities')}</p>
        ) : (
          <div className="space-y-2">
            {scheduled.map(sa => {
              const isScheduled = String(sa.status).toLowerCase() === 'scheduled';
              const isEditing = editingId === sa.id;
              return (
              <div key={sa.id} className="border border-slate-100 rounded-sm px-3 py-2.5">
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <input type="text" value={editForm.title} onChange={e=> setEditForm({...editForm, title:e.target.value})} placeholder={t('titleOptional')} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs" />
                      <input type="datetime-local" value={editForm.scheduledAt} onChange={e=> setEditForm({...editForm, scheduledAt:e.target.value})} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs" />
                      <input type="number" value={editForm.durationMinutes} onChange={e=> setEditForm({...editForm, durationMinutes:e.target.value})} placeholder={t('durationMin')} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs" min={1} max={1440} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <select value={editForm.priority} onChange={e=> setEditForm({...editForm, priority:e.target.value})} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs bg-white">
                        <option value="LOW">{t('priorityLow')}</option><option value="NORMAL">{t('priorityNormal')}</option><option value="MEDIUM">{t('priorityMedium')}</option><option value="HIGH">{t('priorityHigh')}</option>
                      </select>
                      <input type="text" value={editForm.meetingType} onChange={e=> setEditForm({...editForm, meetingType:e.target.value})} placeholder={t('meetingTypeOptional')} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs" />
                      <input type="text" value={editForm.location} onChange={e=> setEditForm({...editForm, location:e.target.value})} placeholder={t('locationOptional')} className="border border-slate-200 rounded-sm px-2 py-1.5 text-xs" />
                    </div>
                    <input type="text" value={editForm.remarks} onChange={e=> setEditForm({...editForm, remarks:e.target.value})} placeholder={t('remarksOptional')} className="w-full border border-slate-200 rounded-sm px-2 py-1.5 text-xs" />
                    <div className="flex gap-2 justify-end">
                      <button onClick={()=> setEditingId(null)} className="text-[11px] font-bold text-slate-500 border border-slate-200 px-3 py-1 rounded-sm">{t('cancel')}</button>
                      <button onClick={()=> handleUpdateScheduled(sa.id)} className="text-[11px] font-bold text-white bg-[#978C21] px-3 py-1 rounded-sm">{t('save')}</button>
                    </div>
                  </div>
                ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800 truncate">{sa.title || activityLabel(sa.activityType)} · {sa.activityType} {(sa as any).priority ? `· ${(sa as any).priority}` : ''}</p>
                    <p className="text-[11px] text-slate-400">{new Date(sa.scheduledAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {sa.status} {(sa as any).meetingType ? `· ${(sa as any).meetingType}` : ''} {(sa as any).location ? `· ${(sa as any).location}` : ''} {sa.remarks ? `· ${sa.remarks}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {isScheduled ? (
                      <>
                        <button onClick={() => handleCompleteScheduled(sa.id)} className="text-[11px] font-bold text-emerald-600 hover:text-emerald-800 border border-emerald-100 px-2 py-1 rounded-sm">{t('complete')}</button>
                        <button onClick={() => handleCancelScheduled(sa.id)} className="text-[11px] font-bold text-amber-600 hover:text-amber-800 border border-amber-100 px-2 py-1 rounded-sm">{t('cancel')}</button>
                        <button onClick={() => startEditScheduled(sa)} className="text-[11px] font-bold text-slate-600 hover:text-slate-800 border border-slate-200 px-2 py-1 rounded-sm">{t('edit')}</button>
                        <button onClick={() => handleDeleteScheduled(sa.id)} className="text-[11px] font-bold text-red-500 hover:text-red-700 border border-red-100 px-2 py-1 rounded-sm">{t('delete')}</button>
                      </>
                    ) : (
                      <>
                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-sm border ${String(sa.status).toLowerCase()==='completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>{sa.status}</span>
                        <button disabled className="text-[11px] font-bold text-slate-300 border border-slate-100 px-2 py-1 rounded-sm cursor-not-allowed">{t('edit')}</button>
                      </>
                    )}
                  </div>
                </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-50 bg-[#FBFAF8] flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-[12px] font-black text-brand-text uppercase tracking-[0.15em]">{t('leadTimeline')}</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'status', 'assignment', 'document', 'notification'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-3 py-1.5 rounded-sm text-[9px] font-black uppercase tracking-widest border transition-all",
                  filter === f ? "bg-[#978C21] text-white border-[#978C21]" : "bg-white text-slate-400 border-slate-200"
                )}
              >
                {f === 'all' ? t('all') : f}
              </button>
            ))}
            <button
              onClick={() => setAddingDoc(v => !v)}
              className="px-3 py-1.5 rounded-sm text-[9px] font-black uppercase tracking-widest border border-[#978C21]/30 text-[#978C21] flex items-center gap-1 hover:bg-[#978C21]/5"
            >
              <Plus className="w-3 h-3" /> {t('addDocument')}
            </button>
          </div>
        </div>

        {addingDoc && (
          <div className="px-6 py-4 border-b border-slate-50 bg-slate-50 flex flex-col md:flex-row gap-3 items-end">
            <div className="flex-1 w-full space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{t('documentNameRef')}</label>
              <input value={docName} onChange={e => setDocName(e.target.value)} placeholder={t('docNamePlaceholder')}
                className="w-full bg-white border border-slate-200 rounded-sm px-4 py-2.5 text-[11px] font-bold outline-none focus:ring-2 focus:ring-[#978C21]/10" />
            </div>
            <div className="flex-1 w-full space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{t('documentNoteOptional')}</label>
              <input value={docNote} onChange={e => setDocNote(e.target.value)} placeholder={t('docNotePlaceholder')}
                className="w-full bg-white border border-slate-200 rounded-sm px-4 py-2.5 text-[11px] font-bold outline-none focus:ring-2 focus:ring-[#978C21]/10" />
            </div>
            <button onClick={handleAddDocument} className="bg-[#978C21] text-white px-6 py-2.5 rounded-sm font-black text-[10px] uppercase tracking-widest hover:bg-black transition-all whitespace-nowrap">
              {t('save')}
            </button>
          </div>
        )}

        <div className="p-6 space-y-1">
          {filteredTimeline.length === 0 ? (
            <p className="text-[11px] text-slate-300 uppercase tracking-widest italic text-center py-10">{t('noTimelineEvents')}</p>
          ) : (
            filteredTimeline.map((event, idx) => {
              const config = TYPE_CONFIG[event.type];
              const Icon = config.icon;
              return (
                <div key={event.id} className="flex gap-4 relative pb-6 last:pb-0">
                  {idx !== filteredTimeline.length - 1 && (
                    <div className="absolute left-[15px] top-8 bottom-0 w-px bg-slate-100" />
                  )}
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10", config.color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex items-center justify-between flex-wrap gap-1">
                      <p className="text-[11px] font-black text-brand-text">{event.title}</p>
                      <span className="text-[9px] text-slate-300 font-bold uppercase tracking-widest shrink-0">{new Date(event.date).toLocaleString()}</span>
                    </div>
                    {event.detail && <p className="text-[10px] text-slate-500 mt-1">{event.detail}</p>}
                    {event.by && <p className="text-[9px] text-slate-300 uppercase tracking-widest mt-1 font-bold">by {event.by}</p>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
