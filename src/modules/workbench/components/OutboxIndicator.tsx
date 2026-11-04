/**
 * OutboxIndicator.tsx
 * ------------------------------------------------------------------
 * Pending-sync indicator for the offline follow-up outbox
 * (Phase 3 PR #2), living in the Daily Workbench header — where
 * field agents start their day.
 *
 * Renders NOTHING when the current user has no queued follow-ups.
 * Otherwise a compact chip: "N pending" and, when the server has
 * definitively rejected a submission, "N needs attention". Tapping
 * opens a panel (AppLayout-style backdrop + anchored panel) listing
 * each entry with its lead, queue time and — for attention items —
 * the server's reason, plus the only two actions that may remove an
 * attention item: Retry (back into the queue + flush) and Discard
 * (explicit, two-step confirm). Entries are never auto-discarded.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CloudOff, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  FOLLOWUP_OUTBOX_CHANGED,
  discardOutboxEntry,
  getOutboxCounts,
  listOutboxEntries,
  retryOutboxEntry,
  type FollowUpOutboxEntry,
  type OutboxCounts,
} from '../../leads/services/followUpOutbox';
import { syncFollowUpsNow } from '../../leads/services/followUpSync';

function formatQueuedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function OutboxIndicator() {
  const [counts, setCounts] = useState<OutboxCounts>(() => getOutboxCounts());
  const [entries, setEntries] = useState<FollowUpOutboxEntry[]>(() => listOutboxEntries());
  const [open, setOpen] = useState(false);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setCounts(getOutboxCounts());
    setEntries(listOutboxEntries());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(FOLLOWUP_OUTBOX_CHANGED, refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(FOLLOWUP_OUTBOX_CHANGED, refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  if (counts.total === 0) return null;

  const hasAttention = counts.attention > 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-2 px-4 py-2.5 border rounded-[10px] text-xs font-semibold transition-colors bg-white',
          hasAttention
            ? 'border-red-200 text-red-700 hover:border-red-300'
            : 'border-amber-200 text-amber-700 hover:border-amber-300'
        )}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <CloudOff className="w-3.5 h-3.5" />
        {counts.pending > 0 && <span>{counts.pending} pending sync</span>}
        {hasAttention && <span>{counts.attention} needs attention</span>}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-2 w-[340px] max-w-[90vw] rounded-[12px] border border-stone-200 bg-white shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100">
              <p className="text-xs font-bold text-stone-700">Offline follow-ups</p>
              {counts.pending > 0 && (
                <button
                  type="button"
                  onClick={() => syncFollowUpsNow()}
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#978C21] hover:underline"
                >
                  <RefreshCw className="w-3 h-3" />
                  Sync now
                </button>
              )}
            </div>
            <div className="max-h-[320px] overflow-y-auto divide-y divide-stone-100">
              {entries.map(entry => (
                <div key={entry.mutationId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-stone-800 truncate">{entry.leadLabel}</p>
                      <p className="text-[11px] text-stone-400 mt-0.5">
                        {entry.payload?.status ? `${entry.payload.status} · ` : ''}
                        Saved {formatQueuedAt(entry.queuedAt)}
                        {entry.attempts > 0 ? ` · ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}` : ''}
                      </p>
                    </div>
                    {entry.state === 'attention' ? (
                      <span className="inline-flex items-center gap-1 shrink-0 text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                        <AlertTriangle className="w-3 h-3" />
                        Needs attention
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        Pending
                      </span>
                    )}
                  </div>
                  {entry.state === 'attention' && entry.lastError && (
                    <p className="text-[11px] text-red-600 mt-1.5 leading-relaxed">{entry.lastError}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    {entry.state === 'attention' && (
                      <button
                        type="button"
                        onClick={() => {
                          retryOutboxEntry(entry.mutationId);
                          syncFollowUpsNow();
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-[#978C21] border border-[#978C21]/30 rounded-[8px] px-2.5 py-1.5 hover:bg-[#978C21]/5"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry
                      </button>
                    )}
                    {confirmDiscardId === entry.mutationId ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            discardOutboxEntry(entry.mutationId);
                            setConfirmDiscardId(null);
                          }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-red-600 rounded-[8px] px-2.5 py-1.5 hover:bg-red-700"
                        >
                          Confirm discard
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDiscardId(null)}
                          className="text-[11px] font-bold text-stone-500 px-2 py-1.5"
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDiscardId(entry.mutationId)}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-stone-500 border border-stone-200 rounded-[8px] px-2.5 py-1.5 hover:text-red-600 hover:border-red-200"
                      >
                        <Trash2 className="w-3 h-3" />
                        Discard
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {entries.length === 0 && (
                <p className="px-4 py-3 text-[11px] text-stone-400">Nothing waiting to sync.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
