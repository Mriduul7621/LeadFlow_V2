/**
 * BulkDeleteDialog — delete or request deletion of several leads
 * at once (2026-11-22, Mahadi: anyone who can delete must be able
 * to mark one or more leads and delete them in bulk).
 * ------------------------------------------------------------------
 * ONE component for both roles, mirroring the single-lead dialogs:
 * an ADMIN gets the direct-delete confirm (DirectDeleteDialog
 * wording — deletes right away, no approval); everyone else files
 * delete REQUESTS (RequestDeleteDialog wording — one reason,
 * entered once, applied to every selected lead; an admin reviews
 * each request). The server enforces the same rule per lead
 * (POST /api/leads/bulk-delete: ADMIN/SUPERADMIN role → direct
 * soft-delete + leads.delete.direct audit per lead; anyone else →
 * one request row per lead + admin notification), so this UI can
 * never widen access.
 *
 * The dialog owns the reason text, the busy state, the bulk call
 * and the result toast (counts, LeadUpload-style: success when
 * all go through, warning on partial success, error when none
 * do). The caller refreshes its own data and clears the selection
 * via `onDone`. Leads that already have a pending request come
 * back in the failed list — they are never double-filed.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { leadService, type BulkDeleteResult } from '../services/leadService';
import type { DeleteDialogLead } from './RequestDeleteDialog';

interface BulkDeleteDialogProps {
  /** Null or empty = closed. */
  leads: DeleteDialogLead[] | null;
  /** True for ADMIN/SUPERADMIN (real role) — direct delete; everyone else files requests. */
  isAdmin: boolean;
  onClose: () => void;
  /** Called after the bulk call returns (the caller refreshes + clears the selection). */
  onDone: (result: BulkDeleteResult) => void;
}

export default function BulkDeleteDialog({ leads, isAdmin, onClose, onDone }: BulkDeleteDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    setReason('');
    onClose();
  };

  const submit = async () => {
    if (!leads || leads.length === 0) return;
    setBusy(true);
    try {
      const result = await leadService.bulkDelete(
        leads.map(l => l.id),
        isAdmin ? undefined : (reason.trim() || undefined),
      );
      const done = isAdmin ? (result.deleted || []).length : (result.requested || []).length;
      const failedCount = result.failed.length;
      const verb = isAdmin ? 'deleted' : 'delete request(s) sent';
      if (done > 0 && failedCount === 0) {
        toast.success(isAdmin
          ? `Deleted ${done} lead${done === 1 ? '' : 's'}.`
          : `${done} ${verb} — an admin will review them.`);
      } else if (done > 0) {
        toast.warning(isAdmin
          ? `Deleted ${done} lead${done === 1 ? '' : 's'}, ${failedCount} failed.`
          : `${done} ${verb}, ${failedCount} failed — an admin will review the sent ones.`);
      } else {
        toast.error(isAdmin ? `Could not delete — ${failedCount} failed.` : `Could not send the requests — ${failedCount} failed.`);
      }
      setReason('');
      onDone(result);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete these leads. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const previewNames = (leads || []).slice(0, 5).map(l => l.prospectName || 'Lead');
  const extraCount = (leads || []).length - previewNames.length;

  return (
    <AnimatePresence>
      {leads && leads.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            className="relative bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-slate-100 flex flex-col max-h-[90vh]"
          >
            <div className="bg-[#3C3C3C] px-6 py-5 flex items-center justify-between">
              <div>
                <h3 className="text-white text-lg font-black uppercase tracking-tight">
                  {isAdmin ? `Delete ${leads.length} Lead${leads.length === 1 ? '' : 's'}` : 'Request Deletion'}
                </h3>
                <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">
                  {previewNames.join(', ')}
                  {extraCount > 0 ? ` and ${extraCount} more` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-2 hover:bg-white/5 rounded-sm text-slate-400 hover:text-white transition-all"
                aria-label="Close"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {isAdmin ? (
                <p className="text-sm text-slate-600 leading-relaxed">
                  This deletes {leads.length} lead{leads.length === 1 ? '' : 's'} <span className="font-bold text-slate-800">right away</span> —
                  there is no approval step for admins. The leads will no longer appear in any list.
                </p>
              ) : (
                <p className="text-sm text-slate-600 leading-relaxed">
                  This does <span className="font-bold text-slate-800">not</span> delete the leads right away.
                  An admin will review your requests — only their approval deletes a lead.
                </p>
              )}
              {!isAdmin && (
                <div className="space-y-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason (optional — applies to all {leads.length})</p>
                  <input
                    type="text"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    maxLength={500}
                    placeholder="Why should these leads be deleted?"
                    className="w-full border border-slate-200 rounded-sm px-3 py-2 text-sm text-slate-700"
                  />
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="px-4 py-2 border border-slate-200 text-slate-600 text-[11px] font-black uppercase tracking-widest rounded-sm hover:bg-slate-50 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="flex items-center gap-2 px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-[11px] font-black uppercase tracking-widest rounded-sm shadow-md transition-all disabled:opacity-60"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {busy
                  ? (isAdmin ? 'Deleting…' : 'Sending…')
                  : (isAdmin ? 'Confirm delete' : 'Send requests')}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
