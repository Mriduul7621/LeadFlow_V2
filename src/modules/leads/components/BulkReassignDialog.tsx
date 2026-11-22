import React, { useEffect, useMemo, useState } from 'react';
import { Check, UserCog, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '../../auth/store/authStore';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { downlineOf } from '../../team/services/teamOverviewService';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { isAdminPerson } from '../../workspace/utils/teamWorkspaceData';
import { leadService, type BulkReassignResult } from '../services/leadService';
import type { ReassignLeadTarget } from './ReassignLeadDialog';

/**
 * BulkReassignDialog — move several leads to one team member at
 * once (2026-11-22, Mahadi: anyone who can reassign must be able
 * to mark one or more leads and reassign them in bulk).
 * ------------------------------------------------------------------
 * Mirrors ReassignLeadDialog: the same target pool (a Team Lead's
 * full downline; Manager / Admin see everyone visible), the same
 * exclusions (never an admin-role user — an admin is never a
 * seller; self stays listed), the same server re-check on every
 * lead (POST /api/leads/bulk-reassign authorises each lead
 * server-side, so this UI can never widen access). It does NOT
 * exclude a "current assignee" — the selected leads may sit with
 * different owners; a lead already with the chosen member comes
 * back in the failed list instead.
 *
 * The dialog owns the target selection, the busy state, the bulk
 * call and the result toast (counts, LeadUpload-style: success
 * when all move, warning on partial success, error when none do).
 * The caller refreshes its own data and clears the selection via
 * `onDone`.
 */
interface BulkReassignDialogProps {
  /** Null or empty = closed. */
  leads: ReassignLeadTarget[] | null;
  onClose: () => void;
  /** Called after the bulk call returns (the caller refreshes + clears the selection). */
  onDone: (result: BulkReassignResult) => void;
}

export default function BulkReassignDialog({ leads, onClose, onDone }: BulkReassignDialogProps) {
  const user = useAuthStore(state => state.user);
  const callerTeam = useCallerTeam();
  const { realRole } = useEnterpriseDisplayRole();
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const leadKey = (leads || []).map(l => l.id).join(',');
  // Fresh selection every time a different set of leads opens.
  useEffect(() => {
    setSelected(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadKey]);

  const targets = useMemo(() => {
    if (!leads || leads.length === 0) return [];
    const people = callerTeam.overview?.people ?? [];
    // Team Lead: the full downline only. Manager / Admin: everyone
    // visible (the server's visibility check bounds the target).
    // Either way: never an admin-role user. Self stays listed —
    // reassigning leads back to yourself always passes the server
    // rule. No current-assignee exclusion: the selected leads may
    // have different owners, and a lead already with the chosen
    // member is reported in the failed list, not hidden here.
    const pool = realRole === 'teamLead'
      ? downlineOf(people, user?.employeeId)
      : people;
    return pool
      .filter(person => !isAdminPerson(person))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [leads, callerTeam.overview, user?.employeeId, realRole]);

  if (!leads || leads.length === 0) return null;

  const handleConfirm = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const result = await leadService.bulkReassign(leads.map(l => l.id), selected);
      const target = targets.find(t => t.employeeId === selected);
      const moved = result.reassigned.length;
      const failedCount = result.failed.length;
      if (moved > 0 && failedCount === 0) {
        toast.success(`Reassigned ${moved} lead${moved === 1 ? '' : 's'} to ${target?.name || selected}.`);
      } else if (moved > 0) {
        toast.warning(`Reassigned ${moved} lead${moved === 1 ? '' : 's'} to ${target?.name || selected}, ${failedCount} failed.`);
      } else {
        toast.error(`Could not reassign — ${failedCount} failed.`);
      }
      onDone(result);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not reassign these leads.');
      setSaving(false);
    }
  };

  const previewNames = leads.slice(0, 3).map(l => l.prospectName || 'Lead');
  const extraCount = leads.length - previewNames.length;

  return (
    <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="Reassign leads in bulk">
      <div className="ep-card max-w-md w-full animate-in fade-in zoom-in-95 duration-200" style={{ padding: 24 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-3 bg-blue-50 text-blue-600 rounded-sm shrink-0">
              <UserCog className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-black text-brand-text tracking-tight">Reassign {leads.length} lead{leads.length === 1 ? '' : 's'}</h3>
              <p className="text-xs text-stone-500 mt-1">
                {previewNames.join(', ')}
                {extraCount > 0 ? ` and ${extraCount} more` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-50 rounded-sm shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-stone-500 mt-4">
          Choose a member of your team. Every selected lead moves to them — you still see them in your team view.
        </p>

        {callerTeam.loading ? (
          <div className="mt-4 space-y-2" role="status" aria-label="Loading team">
            <div className="h-11 bg-stone-100 rounded-[10px] animate-pulse" />
            <div className="h-11 bg-stone-100 rounded-[10px] animate-pulse" />
          </div>
        ) : targets.length === 0 ? (
          <p className="text-xs font-semibold text-stone-500 mt-4 py-6 text-center border border-dashed border-stone-200 rounded-[10px]">
            No team members available to reassign to.
          </p>
        ) : (
          <div className="mt-4 max-h-64 overflow-y-auto space-y-1.5 pr-1" role="radiogroup" aria-label="Team members">
            {targets.map(person => {
              const active = selected === person.employeeId;
              return (
                <button
                  key={person.employeeId}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelected(person.employeeId)}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-[10px] border text-left transition-colors ${
                    active ? 'border-[#978C21] bg-[#978C21]/5' : 'border-stone-100 hover:border-stone-200 hover:bg-stone-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold text-stone-800 truncate">{person.name}</span>
                    <span className="block text-[11px] text-stone-400 truncate">
                      {person.designation || person.roleName || 'Team member'} · {person.employeeId}
                      {person.directReports > 0 ? ` · ${person.directReports} report${person.directReports === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                  {active && <Check className="w-4 h-4 text-[#978C21] shrink-0" />}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
          <button type="button" onClick={onClose} className="ep-btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!selected || saving || targets.length === 0}
            className="ep-btn ep-btn-primary disabled:opacity-40"
          >
            {saving ? 'Reassigning…' : `Reassign ${leads.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
