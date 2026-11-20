/**
 * RequestDeleteDialog — the delete-request dialog (migration 062).
 * ------------------------------------------------------------------
 * ONE component for both entry points (the lead list and Lead360):
 * it files a REQUEST for admin review — it never deletes the lead
 * at once. The caller passes the target lead (null = closed) and
 * marks the lead pending in `onRequested`; the dialog owns the
 * reason text, the busy state, the submit call and the toasts.
 *
 * A 409 means a request is already pending (filed from another
 * device, or from the other entry point) — the dialog marks the
 * lead pending and says so instead of showing an error.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';

export interface DeleteDialogLead {
  id: string;
  prospectName?: string;
  mobile?: string;
}

interface RequestDeleteDialogProps {
  lead: DeleteDialogLead | null;
  onClose: () => void;
  onRequested: (leadId: string) => void;
}

export default function RequestDeleteDialog({ lead, onClose, onRequested }: RequestDeleteDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    setReason('');
    onClose();
  };

  const submit = async () => {
    if (!lead) return;
    setBusy(true);
    try {
      await leadService.requestDelete(lead.id, reason.trim() || undefined);
      toast.success('Delete request sent — an admin will review it.');
      onRequested(lead.id);
      setReason('');
      onClose();
    } catch (err: any) {
      if (err?.status === 409) {
        onRequested(lead.id);
        toast.info('A delete request for this lead is already pending.');
        setReason('');
        onClose();
      } else {
        toast.error(err?.message || 'Could not send the delete request. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {lead && (
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
                <h3 className="text-white text-lg font-black uppercase tracking-tight">Request Deletion</h3>
                <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">{lead.prospectName || 'Unknown Prospect'} · {lead.mobile || 'No mobile'}</p>
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
              <p className="text-sm text-slate-600 leading-relaxed">
                This does <span className="font-bold text-slate-800">not</span> delete the lead right away.
                An admin will review your request — only their approval deletes the lead.
              </p>
              <div className="space-y-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason (optional)</p>
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  maxLength={500}
                  placeholder="Why should this lead be deleted?"
                  className="w-full border border-slate-200 rounded-sm px-3 py-2 text-sm text-slate-700"
                />
              </div>
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
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
