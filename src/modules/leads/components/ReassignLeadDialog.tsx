import React, { useEffect, useMemo, useState } from 'react';
import { Check, UserCog, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '../../auth/store/authStore';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { downlineOf } from '../../team/services/teamOverviewService';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { isAdminPerson } from '../../workspace/utils/teamWorkspaceData';
import { leadService } from '../services/leadService';

/**
 * ReassignLeadDialog — move a lead to another member of the caller's
 * team (2026-11-19, extended 2026-11-20, Mahadi).
 * ------------------------------------------------------------------
 * A team lead may reassign ANY lead in their team scope — their own
 * or any subordinate's (A → B allowed) — to ANYONE in their full
 * downline (the whole subtree, not just direct reports). A Manager
 * or Admin may reassign to anyone in their visible set (the
 * server's visibility check bounds the target). The picker always
 * excludes the current assignee and admin-role users (an admin is
 * never a seller). The server re-checks the same rule
 * (callerHasTeamScope + target in scope) on every request, so this
 * UI can never widen access. After the move the lead leaves the
 * TL's My Leads and appears under the new owner; the TL still sees
 * it via team scope. No approval flow — the TL/Manager decides
 * directly. The target rule follows the REAL role, never the
 * super-admin preview — the server enforces the real rule.
 *
 * Shared by Lead360 and the lead list; the caller owns the open
 * state and refreshes its own data via `onReassigned`.
 */
export interface ReassignLeadTarget {
  id: string;
  prospectName: string;
  assignedTo?: string | null;
}

interface ReassignLeadDialogProps {
  /** Null = closed. */
  lead: ReassignLeadTarget | null;
  onClose: () => void;
  /** Called after a successful reassign (the caller refreshes). */
  onReassigned: () => void;
}

export default function ReassignLeadDialog({ lead, onClose, onReassigned }: ReassignLeadDialogProps) {
  const user = useAuthStore(state => state.user);
  const callerTeam = useCallerTeam();
  const { realRole } = useEnterpriseDisplayRole();
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Fresh selection every time a different lead opens.
  useEffect(() => {
    setSelected(null);
    setSaving(false);
  }, [lead?.id]);

  const targets = useMemo(() => {
    if (!lead) return [];
    const people = callerTeam.overview?.people ?? [];
    const current = String(lead.assignedTo || '').toUpperCase();
    // Team Lead: the full downline only. Manager / Admin: everyone
    // visible (the server's visibility check bounds the target).
    // Either way: never the current assignee, never an admin-role
    // user. Self stays listed — reassigning a lead back to
    // yourself always passes the server rule.
    const pool = realRole === 'teamLead'
      ? downlineOf(people, user?.employeeId)
      : people;
    return pool
      .filter(person => !isAdminPerson(person))
      .filter(person => String(person.employeeId).toUpperCase() !== current)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [lead, callerTeam.overview, user?.employeeId, realRole]);

  const currentAssigneeName = useMemo(() => {
    if (!lead?.assignedTo) return null;
    const match = callerTeam.overview?.people.find(
      p => String(p.employeeId).toUpperCase() === String(lead.assignedTo).toUpperCase()
    );
    return match ? match.name : lead.assignedTo;
  }, [lead, callerTeam.overview]);

  if (!lead) return null;

  const handleConfirm = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      // updateLead records the assignment history client-side and
      // the server records it authoritatively ("Reassigned via
      // API") — the move shows in Lead360's timeline either way.
      await leadService.updateLead(lead.id, { assignedTo: selected });
      const target = targets.find(t => t.employeeId === selected);
      toast.success(`Lead reassigned to ${target?.name || selected}.`);
      onReassigned();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not reassign this lead.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="Reassign lead">
      <div className="ep-card max-w-md w-full animate-in fade-in zoom-in-95 duration-200" style={{ padding: 24 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-3 bg-blue-50 text-blue-600 rounded-sm shrink-0">
              <UserCog className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-black text-brand-text tracking-tight">Reassign lead</h3>
              <p className="text-xs text-stone-500 mt-1">
                {lead.prospectName || 'Lead'}
                {currentAssigneeName ? ` · currently with ${currentAssigneeName}` : ' · currently unassigned'}
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
          Choose a member of your team. The lead moves to them — you still see it in your team view.
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
            {saving ? 'Reassigning…' : 'Reassign'}
          </button>
        </div>
      </div>
    </div>
  );
}
