import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Phone, Mail, MapPin, Briefcase, User as UserIcon,
  Clock, UserCog, FileText, Bell, Plus
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { leadService } from '../services/leadService';
import { notificationService } from '../../notifications/services/notificationService';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead, LeadActivityEntry, StatusHistoryEntry, SystemNotification } from '../../shared/types';
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
  const [lead, setLead] = useState<Lead | null>(null);
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  // Server-authoritative activity stream (lead_activities). Legacy
  // status_history entries are only shown for events this table predates.
  const [activities, setActivities] = useState<LeadActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TimelineEventType | 'all'>('all');
  const [docName, setDocName] = useState('');
  const [docNote, setDocNote] = useState('');
  const [addingDoc, setAddingDoc] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      // The lead itself comes from the dedicated single-lead endpoint, and
      // its follow-up/status activity from the authoritative activity
      // stream - not from a full lead-list fetch. Activity is allowed to
      // fail independently: the lead profile must still render.
      const [l, n, a] = await Promise.all([
        leadService.getLead(id),
        notificationService.getNotificationsForLead(id),
        leadService.getLeadActivities(id).catch(() => [] as LeadActivityEntry[]),
      ]);
      setLead(l);
      setNotifications(n);
      setActivities(a || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const timeline: TimelineEvent[] = useMemo(() => {
    if (!lead) return [];
    const events: TimelineEvent[] = [];

    // Status/follow-up events come from the SERVER-AUTHORITATIVE activity
    // stream (lead_activities). entries in lead.statusHistory that carry an
    // `activityId` are the same events mirrored for backward compatibility,
    // so they are skipped to avoid double-rendering; the ones without it
    // predate the activity table and stay visible as legacy history.
    const activityDates = new Set(activities.map(a => String(a.date)));
    const statusEvents: StatusHistoryEntry[] = [
      ...activities,
      ...(lead.statusHistory || []).filter(
        h => !h.activityId && !activityDates.has(String(h.date))
      ),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    statusEvents.forEach((h, i) => {
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
        id: (h as LeadActivityEntry).id || `status_${i}_${h.date}`,
        type: 'status',
        date: h.date,
        title: `Status changed to "${h.status}"`,
        detail: parts.join(' · '),
        by: h.updatedBy,
      });
    });

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
      toast.success('Document reference added to timeline');
      setDocName('');
      setDocNote('');
      setAddingDoc(false);
      load();
    } catch {
      toast.error('Failed to add document');
    }
  };

  if (loading) {
    return <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">Loading lead...</div>;
  }

  if (!lead) {
    return (
      <div className="p-10 text-center space-y-4">
        <p className="text-[11px] text-slate-400 uppercase tracking-widest italic">Lead not found, or you don't have access to it.</p>
        <button onClick={() => navigate(-1)} className="text-sm font-medium text-[#978C21] hover:underline">Go Back</button>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto space-y-8">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#978C21] transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back
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
            <p className="text-xs font-medium text-slate-500">Assigned To</p>
            <p className="text-[12px] font-black text-brand-text flex items-center gap-1 mt-1"><UserIcon className="w-3.5 h-3.5" /> {lead.assignedTo || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Product</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.productName || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Source</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.source || '-'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Created</p>
            <p className="text-[12px] font-black text-brand-text mt-1">{lead.creationDate ? new Date(lead.creationDate).toLocaleDateString() : '-'}</p>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-50 bg-[#FBFAF8] flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-[12px] font-black text-brand-text uppercase tracking-[0.15em]">Lead Timeline</h3>
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
                {f === 'all' ? 'All' : f}
              </button>
            ))}
            <button
              onClick={() => setAddingDoc(v => !v)}
              className="px-3 py-1.5 rounded-sm text-[9px] font-black uppercase tracking-widest border border-[#978C21]/30 text-[#978C21] flex items-center gap-1 hover:bg-[#978C21]/5"
            >
              <Plus className="w-3 h-3" /> Add Document
            </button>
          </div>
        </div>

        {addingDoc && (
          <div className="px-6 py-4 border-b border-slate-50 bg-slate-50 flex flex-col md:flex-row gap-3 items-end">
            <div className="flex-1 w-full space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Document Name / Reference</label>
              <input value={docName} onChange={e => setDocName(e.target.value)} placeholder="e.g. NID copy, Signed proposal form"
                className="w-full bg-white border border-slate-200 rounded-sm px-4 py-2.5 text-[11px] font-bold outline-none focus:ring-2 focus:ring-[#978C21]/10" />
            </div>
            <div className="flex-1 w-full space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Note / Link (optional)</label>
              <input value={docNote} onChange={e => setDocNote(e.target.value)} placeholder="Drive link or note"
                className="w-full bg-white border border-slate-200 rounded-sm px-4 py-2.5 text-[11px] font-bold outline-none focus:ring-2 focus:ring-[#978C21]/10" />
            </div>
            <button onClick={handleAddDocument} className="bg-[#978C21] text-white px-6 py-2.5 rounded-sm font-black text-[10px] uppercase tracking-widest hover:bg-black transition-all whitespace-nowrap">
              Save
            </button>
          </div>
        )}

        <div className="p-6 space-y-1">
          {filteredTimeline.length === 0 ? (
            <p className="text-[11px] text-slate-300 uppercase tracking-widest italic text-center py-10">No timeline events yet</p>
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
