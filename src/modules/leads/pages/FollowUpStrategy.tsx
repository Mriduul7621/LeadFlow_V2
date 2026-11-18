import React, { useCallback, useEffect, useState } from 'react';
import { Calendar, Clock, History, Phone, User, AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { leadService, type FollowUpQueueItem, type FollowUpQueueResult } from '../services/leadService';
import { toast } from 'sonner';
import BackButton from '../../shared/components/BackButton';

type Bucket = 'overdue' | 'today' | 'upcoming';

const isValidBucket = (value: string | null): value is Bucket =>
  value === 'overdue' || value === 'today' || value === 'upcoming';

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

export default function FollowUpStrategy() {
  const [searchParams, setSearchParams] = useSearchParams();
  const bucketFromUrl = searchParams.get('bucket');
  const [active, setActive] = useState<Bucket>(isValidBucket(bucketFromUrl) ? bucketFromUrl : 'overdue');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [data, setData] = useState<FollowUpQueueResult | null>(null);

  // Keep the selected bucket in the URL so dashboard deep links
  // (/follow-up?bucket=overdue|today|upcoming) open the right tab, and the
  // browser back/forward buttons still work.
  const selectBucket = (bucket: Bucket) => {
    setActive(bucket);
    setSearchParams({ bucket }, { replace: true });
  };

  useEffect(() => {
    const next = searchParams.get('bucket');
    if (isValidBucket(next) && next !== active) setActive(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const load = useCallback(async (bucket: Bucket) => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await leadService.getFollowUpQueue({ bucket, limit: 100 });
      setData(result);
    } catch (err: any) {
      setLoadError(true);
      // Clear stale data: without this, a failed bucket switch (or refresh)
      // leaves the previous bucket's items on screen under the newly selected
      // tab, with only a transient toast as signal. Clearing makes the error
      // banner (rendered when loadError && !data) show with its retry action.
      setData(null);
      toast.error(err?.message || 'Could not load follow-up queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  const counts = data?.counts || null;
  const tabs: Array<{ id: Bucket; label: string; icon: typeof Clock; count: number | null }> = [
    { id: 'overdue', label: 'Overdue', icon: AlertTriangle, count: counts?.overdue ?? null },
    { id: 'today', label: 'Due Today', icon: Clock, count: counts?.today ?? null },
    { id: 'upcoming', label: 'Upcoming', icon: Calendar, count: counts?.upcoming ?? null },
  ];

  return (
    <div className="space-y-6 pb-24 bg-[#FDFBF7] font-sans">
      <BackButton fallback="/" />
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 border-b border-stone-200 pb-6">
        <div className="flex items-center gap-5">
          <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-[#978C21] border border-stone-200">
            <History className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">Follow-up Queue</h1>
            <p className="text-stone-500 text-xs mt-1">
              Asia/Dhaka · server visibility · {data?.todayDate || '—'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(active)}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-stone-600 transition hover:border-[#978C21]/50 hover:text-[#706817] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#978C21]"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectBucket(tab.id)}
            aria-pressed={active === tab.id}
            className={cn(
              'rounded-xl border bg-white p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#978C21] focus-visible:ring-offset-2',
              active === tab.id ? 'border-[#978C21] bg-[#978C21]/5 shadow-sm' : 'border-stone-200 hover:border-[#978C21]/40'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-600 flex items-center gap-2">
                <tab.icon className="w-4 h-4 text-[#978C21]" />
                {tab.label}
              </span>
              <span className="text-2xl font-bold tabular-nums text-stone-900">{tab.count ?? '—'}</span>
            </div>
          </button>
        ))}
      </div>

      {loadError && !data ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-semibold text-amber-900">We could not load your follow-up queue.</p>
          <p className="mt-1 text-xs text-amber-800">Your follow-up counts are unavailable. Try again to refresh the queue.</p>
          <button type="button" onClick={() => void load(active)} className="mt-4 rounded-lg bg-[#978C21] px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#978C21] focus-visible:ring-offset-2">Try again</button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-16" aria-label="Loading follow-up queue" role="status">
          <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.items || []).length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white py-16 text-center text-sm text-stone-500">
              No {active} follow-ups found
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
