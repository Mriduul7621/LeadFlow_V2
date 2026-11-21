/**
 * DirectDeleteDialog — the ADMIN direct-delete confirmation dialog
 * (Mahadi, 2026-11-21: an admin deleting a lead needs NO approval —
 * only a confirm click).
 * ------------------------------------------------------------------
 * ONE component for both entry points (the lead list and Lead360),
 * mirroring RequestDeleteDialog: the trash click only OPENS this
 * dialog — nothing is deleted until the admin clicks "Confirm
 * delete". Non-admins never see it (they get RequestDeleteDialog);
 * the server enforces the role anyway (POST /leads/:id/delete is
 * ADMIN/SUPERADMIN-only, 403 otherwise). The caller passes the
 * target lead (null = closed) and removes the lead in `onDeleted`;
 * the dialog owns the busy state, the delete call and the toasts.
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import type { DeleteDialogLead } from './RequestDeleteDialog';

interface DirectDeleteDialogProps {
  lead: DeleteDialogLead | null;
  onClose: () => void;
  onDeleted: (leadId: string) => void;
}

export default function DirectDeleteDialog({ lead, onClose, onDeleted }: DirectDeleteDialogProps) {
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    onClose();
  };

  const confirm = async () => {
    if (!lead) return;
    setBusy(true);
    try {
      await leadService.deleteLeadDirect(lead.id);
      toast.success('Lead deleted.');
      onDeleted(lead.id);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete the lead. Please try again.');
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
                <h3 className="text-white text-lg font-black uppercase tracking-tight">Delete Lead</h3>
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
                This deletes the lead <span className="font-bold text-slate-800">right away</span> —
                there is no approval step for admins. The lead will no longer appear in any list.
              </p>
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
                onClick={confirm}
                disabled={busy}
                className="flex items-center gap-2 px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-[11px] font-black uppercase tracking-widest rounded-sm shadow-md transition-all disabled:opacity-60"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {busy ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
