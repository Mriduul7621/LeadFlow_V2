import React, { useCallback, useEffect, useState } from 'react';
import { Calendar, Clock, History, Phone, User, AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { leadService, type FollowUpQueueItem, type FollowUpQueueResult } from '../services/leadService';
import { toast } from 'sonner';

type Bucket = 'overdue' | 'today' | 'upcoming';

function formatDue(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function QueueRow({ item }: { item: FollowUpQueueItem }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/leads/${encodeURIComponent(item.id)}`)}
      className="w-full text-left flex items-center justify-between gap-4 p-5 bg-[#FBFAF8] rounded-sm border border-slate-50 hover:border-[#978C21]/40 hover:bg-white hover:shadow-md transition-all group"
    >
      <div className="flex items-center gap-4 min-w-0">
        <div className="w-11 h-11 rounded-sm bg-white border border-slate-100 flex items-center justify-center text-slate-300 group-hover:bg-[#978C21] group-hover:text-white">
          <User className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-slate-800 truncate">{item.prospectName || item.customerName}</p>
          <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-2">
            <Phone className="w-3 h-3" />
            {item.mobile || '—'}
            <span className="text-slate-200">·</span>
            {item.assignedEmployeeName || item.assignedTo || 'Unassigned'}
          </p>
          {(item.campaign || item.product || item.area) && (
            <p className="text-[10px] text-slate-300 mt-1 uppercase tracking-wider truncate">
              {[item.campaign, item.product, item.area].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-semibold text-slate-700">{item.currentStatus}</p>
        <p className="text-[10px] text-slate-400 mt-1">{formatDue(item.nextFollowUpAt)}</p>
        {item.dueState === 'overdue' && (
          <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 bg-red-50 text-red-600 text-[9px] font-black uppercase tracking-widest">
            <AlertTriangle className="w-3 h-3" />
            Overdue {item.overdueDays ? `${item.overdueDays}d` : ''}
          </span>
        )}
        <p className="text-[10px] text-[#978C21] mt-2 inline-flex items-center gap-1 font-medium">
          Lead360 <ChevronRight className="w-3 h-3" />
        </p>
      </div>
    </button>
  );
}

const VALID_BUCKETS: Bucket[] = ['overdue', 'today', 'upcoming'];

function readBucketFromSearch(search: string): Bucket {
  const params = new URLSearchParams(search);
  const requested = params.get('bucket');
  return (VALID_BUCKETS as string[]).includes(requested || '') ? (requested as Bucket) : 'overdue';
}

export default function FollowUpStrategy() {
  const location = useLocation();
  // Dashboard "Follow-up Health" cards deep-link here via ?bucket=overdue|today|upcoming.
  const [active, setActive] = useState<Bucket>(() => readBucketFromSearch(location.search));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FollowUpQueueResult | null>(null);

  const load = useCallback(async (bucket: Bucket) => {
    setLoading(true);
    try {
      const result = await leadService.getFollowUpQueue({ bucket, limit: 100 });
      setData(result);
    } catch (err: any) {
      toast.error(err?.message || 'Could not load follow-up queue');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-sync the active tab whenever the deep-link query param changes
  // (e.g. clicking a different Follow-up Health card while already on this page).
  useEffect(() => {
    setActive(readBucketFromSearch(location.search));
  }, [location.search]);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  const counts = data?.counts || { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const tabs: Array<{ id: Bucket; label: string; icon: typeof Clock; count: number }> = [
    { id: 'overdue', label: 'Overdue', icon: AlertTriangle, count: counts.overdue },
    { id: 'today', label: 'Due Today', icon: Clock, count: counts.today },
    { id: 'upcoming', label: 'Upcoming', icon: Calendar, count: counts.upcoming },
  ];

  return (
    <div className="space-y-8 pb-24 bg-white font-sans">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-100 pb-8">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 bg-[#F9F9F4] rounded-sm flex items-center justify-center text-[#978C21] border border-slate-100">
            <History className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">Follow-up Queue</h1>
            <p className="text-slate-400 text-[10px] uppercase tracking-[0.25em] mt-2 italic">
              Asia/Dhaka · server visibility · {data?.todayDate || '—'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(active)}
          className="inline-flex items-center gap-2 px-4 py-2 border border-slate-100 text-[11px] font-semibold uppercase tracking-widest text-slate-500 hover:text-[#978C21]"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={cn(
              'p-5 border text-left transition-all',
              active === tab.id ? 'border-[#978C21] bg-[#978C21]/5' : 'border-slate-100 hover:border-slate-200'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <tab.icon className="w-4 h-4 text-[#978C21]" />
                {tab.label}
              </span>
              <span className="text-2xl font-black italic text-slate-800">{tab.count}</span>
            </div>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.items || []).length === 0 ? (
            <div className="text-center py-16 text-slate-400 text-[11px] uppercase tracking-widest border border-dashed border-slate-200">
              No {active} follow-ups in your visibility
            </div>
          ) : (
            (data?.items || []).map(item => (
              <div key={item.id}>
                <QueueRow item={item} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
