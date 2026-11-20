import React, { useCallback, useEffect, useState } from 'react';
import { Calendar, Clock, Phone, User, AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { leadService, type FollowUpQueueItem, type FollowUpQueueResult } from '../services/leadService';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
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
      className="ep-card ep-kpi-btn flex items-center justify-between gap-4 group"
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
          <span className="ep-pill red inline-flex items-center gap-1 mt-2">
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
    try {
      const result = await leadService.getFollowUpQueue({ bucket, limit: 100 });
      setData(result);
    } catch (err: any) {
      toast.error(err?.message || 'Could not load follow-up queue');
    } finally {
      setLoading(false);
    }
  }, []);

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
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/follow-up"
        actions={(
          <>
            <span className="ep-pill">Asia/Dhaka · {data?.todayDate || '—'}</span>
            <button
              type="button"
              onClick={() => void load(active)}
              className="ep-btn"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </>
        )}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ marginBottom: 18 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectBucket(tab.id)}
            className={cn(
              'ep-card ep-kpi-btn',
              active === tab.id && 'active'
            )}
            aria-pressed={active === tab.id}
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
            <div className="ep-card">
              <p className="ep-empty" style={{ textAlign: 'center' }}>No {active} follow-ups in your visibility</p>
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
