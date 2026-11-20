/**
 * DeleteRequests — the admin review page for lead delete requests
 * (migration 062, owner decision 2026-11-18; ported from PR #158)
 * ------------------------------------------------------------------
 * Deleting a lead from the Leads page files a REQUEST, not a delete:
 * the requester sees a "delete requested" marker, every active admin
 * gets an in-app notification, and the lead is soft-deleted ONLY
 * when an admin approves here. A rejection leaves the lead untouched.
 * Counts change only after approval ("admin check kore submit korle
 * then main count hobe").
 *
 * Reached from the Administration directory, and from a
 * delete-request notification (bell + Notifications page). The route
 * is AdminRoute-gated and the endpoints re-check requireAdmin, so
 * this page never renders for a non-admin.
 *
 * Adapted to the current enterprise design: EnterprisePageHeader
 * (heading derives from the FALLBACK_LABELS entry — this page has
 * no sidebar item by design) with Refresh as the header action.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, RefreshCw, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { apiRequest } from '../../shared/api/http';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';

interface DeleteRequestItem {
  id: string;
  leadId: string;
  leadName: string;
  leadMobile: string;
  leadCode: string | null;
  leadStatus: string;
  leadDeleted: boolean;
  requestedBy: string;
  requestedByName: string;
  requestedByEmployeeId: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

function dhakaDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusPill({ status }: { status: DeleteRequestItem['status'] }) {
  const cls =
    status === 'pending'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : status === 'approved'
        ? 'bg-red-50 text-red-600 border-red-200'
        : 'bg-stone-100 text-stone-500 border-stone-200';
  const label = status === 'pending' ? 'Pending review' : status === 'approved' ? 'Approved — lead deleted' : 'Rejected — lead kept';
  return (
    <span className={cn('text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full border', cls)}>
      {label}
    </span>
  );
}

export default function DeleteRequests() {
  const [requests, setRequests] = useState<DeleteRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('pending');
  // The request currently being confirmed: { id, action } + the
  // optional review note typed in the inline confirm row.
  const [confirming, setConfirming] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ success: boolean; requests: DeleteRequestItem[] }>('/api/leads/delete-requests');
      setRequests(Array.isArray(res?.requests) ? res.requests : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load delete requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = {
    pending: requests.filter(r => r.status === 'pending').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
    all: requests.length,
  };
  const visible = filter === 'all' ? requests : requests.filter(r => r.status === filter);

  const submitReview = async () => {
    if (!confirming) return;
    setReviewing(true);
    try {
      const res = await apiRequest<{ success: boolean; status: string; leadAlreadyDeleted?: boolean }>(
        `/api/leads/delete-requests/${encodeURIComponent(confirming.id)}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: confirming.action, note: note.trim() || undefined }),
        }
      );
      if (confirming.action === 'approve') {
        toast.success(
          res.leadAlreadyDeleted
            ? 'Request approved — the lead had already been deleted.'
            : 'Request approved — the lead is now deleted.'
        );
      } else {
        toast.success('Request rejected — the lead is untouched.');
      }
      setConfirming(null);
      setNote('');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the review. Please try again.');
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div className="ep-page" style={{ maxWidth: 768 }}>
      <EnterprisePageHeader
        path="/leads/delete-requests"
        actions={(
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ep-btn"
            aria-label="Refresh delete requests"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </button>
        )}
      />

      <p className="max-w-prose text-sm leading-6 text-stone-600" style={{ marginBottom: 16 }}>
        A lead is deleted only when you approve its request here. Approving soft-deletes the lead
        immediately; rejecting leaves it exactly as it was. {counts.pending} pending · {counts.all} total.
      </p>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter delete requests by status" style={{ marginBottom: 16 }}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-4 py-2 rounded-full text-[11px] font-black uppercase tracking-widest border transition-colors',
              filter === f.key
                ? 'bg-[#978C21] text-white border-[#978C21]'
                : 'bg-white text-stone-500 border-stone-200 hover:border-[#978C21]/50'
            )}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading delete requests">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-24 bg-stone-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3">
          <p className="text-sm text-red-600 font-bold">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-stone-200/80 rounded-2xl p-6 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
          <p className="text-sm font-bold text-stone-600">
            {filter === 'pending'
              ? 'No pending delete requests — nothing needs your review.'
              : `No ${filter} delete requests.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(req => (
            <div key={req.id} className="bg-white border border-stone-200/80 rounded-2xl p-5 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {req.leadDeleted ? (
                    <p className="text-sm font-black text-stone-800">{req.leadName}</p>
                  ) : (
                    <Link
                      to={`/leads/${encodeURIComponent(req.leadId)}`}
                      className="text-sm font-black text-stone-800 hover:text-[#978C21] hover:underline"
                    >
                      {req.leadName}
                    </Link>
                  )}
                  <p className="text-[11px] font-bold uppercase tracking-widest text-stone-400 mt-0.5">
                    {[req.leadCode, req.leadMobile, req.leadStatus].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <StatusPill status={req.status} />
              </div>

              <div className="text-xs text-stone-600 space-y-1">
                <p>
                  Requested by <span className="font-bold text-stone-800">{req.requestedByName || req.requestedByEmployeeId}</span>
                  {req.requestedByEmployeeId && req.requestedByName ? ` (${req.requestedByEmployeeId})` : ''}
                  {' · '}{dhakaDateTime(req.requestedAt)}
                </p>
                {req.reason && (
                  <p className="text-stone-500">
                    <span className="font-bold text-stone-700">Reason: </span>{req.reason}
                  </p>
                )}
                {req.status !== 'pending' && (
                  <p className="text-stone-500">
                    Reviewed by <span className="font-bold text-stone-700">{req.reviewedByName || '—'}</span>
                    {' · '}{dhakaDateTime(req.reviewedAt)}
                    {req.reviewNote && (
                      <>
                        {' · '}
                        <span className="font-bold text-stone-700">Note: </span>{req.reviewNote}
                      </>
                    )}
                  </p>
                )}
              </div>

              {req.status === 'pending' && (
                confirming?.id === req.id ? (
                  <div className="border-t border-stone-100 pt-3 space-y-3">
                    <p className="text-xs font-bold text-stone-700 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
                      {confirming.action === 'approve'
                        ? 'Approve this request? The lead will be deleted immediately.'
                        : 'Reject this request? The lead stays exactly as it is.'}
                    </p>
                    <input
                      type="text"
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      maxLength={500}
                      placeholder="Optional note for the record"
                      className="w-full px-3 py-2 bg-[#FFFCF8] border border-stone-200 rounded-[10px] text-sm focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={submitReview}
                        disabled={reviewing}
                        className={cn(
                          'px-4 py-2 rounded-full text-[11px] font-black uppercase tracking-widest text-white disabled:opacity-50',
                          confirming.action === 'approve' ? 'bg-red-600 hover:bg-red-700' : 'bg-stone-700 hover:bg-stone-800'
                        )}
                      >
                        {reviewing ? 'Saving…' : confirming.action === 'approve' ? 'Confirm approve' : 'Confirm reject'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setConfirming(null); setNote(''); }}
                        disabled={reviewing}
                        className="px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-stone-100 pt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => { setConfirming({ id: req.id, action: 'approve' }); setNote(''); }}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-black uppercase tracking-widest bg-red-600 text-white hover:bg-red-700"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Approve — delete lead
                    </button>
                    <button
                      type="button"
                      onClick={() => { setConfirming({ id: req.id, action: 'reject' }); setNote(''); }}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-600 hover:border-stone-300"
                    >
                      <XCircle className="w-3.5 h-3.5" /> Reject — keep lead
                    </button>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
