import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  dangerZoneService,
  type StageRulesForEdit,
  type StageRulesInput,
  type StageRuleField,
} from '../services/dangerZoneService';

/**
 * DangerZoneStageRules.tsx — the DZ-6 stage rules + terminal editor.
 * ------------------------------------------------------------------
 * Settings → Danger Zone (super admin only, 10-minute unlock) holds
 * the per-status required fields and the terminal flags (audit §2.4
 * D2/D3, §5 Finding 5). Rules attach to the status entry itself
 * (option id), never its name: renaming a status keeps its rule and
 * its terminal behaviour. Ticking a status terminal closes leads in
 * it everywhere — follow-up queue, dashboard, SLA, calendar sync,
 * transfers, quality scoring — because every "open lead" definition
 * reads the same dictionary flag. At least one terminal status must
 * always stay ticked, and at least one status must keep a required
 * field: the server refuses a save that would leave the pipeline
 * unguarded.
 *
 * The parent mounts this only while unlocked; a `danger_zone_locked`
 * answer (unlock expired mid-edit) drops back to the password
 * prompt via onLocked. Nothing about the unlock is stored here.
 */

interface Draft {
  /** statusId -> the field keys that status requires on follow-up. */
  requiredByStatus: Record<string, string[]>;
  terminalStatusIds: string[];
}

function draftFromLoaded(data: StageRulesForEdit): Draft {
  const requiredByStatus: Record<string, string[]> = {};
  for (const opt of data.statusOptions) {
    requiredByStatus[opt.id] = (opt.required ?? []).map(f => f.field);
  }
  return { requiredByStatus, terminalStatusIds: [...data.terminalStatusIds] };
}

function draftFromDefaults(data: StageRulesForEdit): Draft {
  const requiredByStatus: Record<string, string[]> = {};
  const byValue = new Map<string, string>(data.statusOptions.map(o => [o.value, o.id]));
  for (const opt of data.statusOptions) {
    requiredByStatus[opt.id] = [];
  }
  for (const rule of data.defaults) {
    const id = byValue.get(rule.status);
    if (id) requiredByStatus[id] = rule.required.map(f => f.field);
  }
  // The code-default terminal set is the canonical won/lost pair
  // (Converted / Not Interested, resolved through the dictionary's
  // own won/lost flags so a renamed status still maps).
  const terminalStatusIds = data.statusOptions
    .filter(o => o.isWon || o.isLost)
    .map(o => o.id);
  return { requiredByStatus, terminalStatusIds };
}

function cloneDraft(d: Draft): Draft {
  return JSON.parse(JSON.stringify(d)) as Draft;
}

export default function DangerZoneStageRules(props: { onLocked: () => void }) {
  const { onLocked } = props;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState<StageRulesForEdit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    dangerZoneService
      .getStageRules()
      .then(data => {
        if (cancelled) return;
        const next = draftFromLoaded(data);
        setLoaded(data);
        setDraft(next);
        setSavedDraft(cloneDraft(next));
        setLoading(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        if (err?.data?.error === 'danger_zone_locked') {
          onLocked();
          return;
        }
        setLoadError(err?.message || 'Could not load the stage rules.');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Loading stage rules...</p>;
  }
  if (loadError || !loaded || !draft) {
    return (
      <div className="p-6 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-3">
        <p className="text-[12px] font-bold text-slate-600">{loadError || 'Stage rules are unavailable.'}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-xs font-bold"
        >
          Reload the page
        </button>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const set = (patch: Partial<Draft>) => setDraft(prev => (prev ? { ...prev, ...patch } : prev));

  const toggleTerminal = (id: string) => {
    setDraft(prev => {
      if (!prev) return prev;
      const has = prev.terminalStatusIds.includes(id);
      return {
        ...prev,
        terminalStatusIds: has
          ? prev.terminalStatusIds.filter(x => x !== id)
          : [...prev.terminalStatusIds, id],
      };
    });
  };

  const toggleField = (statusId: string, field: string) => {
    setDraft(prev => {
      if (!prev) return prev;
      const current = prev.requiredByStatus[statusId] ?? [];
      const next = current.includes(field)
        ? current.filter(x => x !== field)
        : [...current, field];
      return { ...prev, requiredByStatus: { ...prev.requiredByStatus, [statusId]: next } };
    });
  };

  const handleSave = async () => {
    if (!draft || !dirty) return;
    const byField = new Map(loaded.fieldVocabulary.map(f => [f.field, f]));
    const rules: StageRulesInput['rules'] = [];
    for (const opt of loaded.statusOptions) {
      const fields = (draft.requiredByStatus[opt.id] ?? [])
        .map(key => byField.get(key))
        .filter((f): f is StageRuleField => !!f);
      if (fields.length === 0) continue; // omit the status to carry no rule
      rules.push({ statusId: opt.id, required: fields });
    }
    if (rules.length === 0) {
      setError('At least one status must keep a required field — a pipeline with no stage rules is never saved.');
      return;
    }
    if (draft.terminalStatusIds.length === 0) {
      setError('At least one status must stay terminal — an empty terminal set would re-open every closed lead.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await dangerZoneService.saveStageRules({
        rules,
        terminalStatusIds: draft.terminalStatusIds,
      });
      const next = draftFromLoaded(saved);
      setLoaded(saved);
      setDraft(next);
      setSavedDraft(cloneDraft(next));
      toast.success(`Stage rules saved — version ${saved.version}. Follow-ups now enforce these rules from the next request.`);
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        onLocked();
        return;
      }
      setError(err?.message || err?.data?.message || 'Could not save the stage rules.');
    } finally {
      setSaving(false);
    }
  };

  const handleResetToDefaults = () => {
    setDraft(draftFromDefaults(loaded));
  };

  const handleRevert = () => {
    if (savedDraft) setDraft(cloneDraft(savedDraft));
  };

  const lastChange = loaded.lastChange;
  const defaultByStatus = new Map<string, string[]>();
  {
    const byValue = new Map<string, string>(loaded.statusOptions.map(o => [o.value, o.id]));
    for (const rule of loaded.defaults) {
      const id = byValue.get(rule.status);
      if (id) defaultByStatus.set(id, rule.required.map(f => f.label));
    }
  }

  return (
    <div className="space-y-6 p-6 bg-red-50/40 rounded-sm border border-red-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[11px] font-black uppercase tracking-widest text-red-600">Stage rules &amp; terminal statuses (D2/D3)</h4>
          <p className="text-[11px] text-slate-500 font-bold leading-relaxed mt-2 max-w-2xl">
            Which fields a follow-up must carry before a lead can move to each status, and which statuses close a
            lead. Both attach to the status entry itself — renaming a status keeps its rule and its terminal
            behaviour. A terminal tick closes leads in that status everywhere: follow-up queue, dashboard, SLA,
            calendar sync, transfers and quality scoring all read the same flag.
          </p>
        </div>
        <span className="px-2 py-1 bg-white border border-red-100 text-red-600 text-[10px] font-black uppercase tracking-widest rounded">
          Version {loaded.version}{loaded.version === 0 ? ' — code defaults' : ''}
        </span>
      </div>

      {lastChange && (
        <p className="text-[11px] font-bold text-slate-500">
          Last change: version {lastChange.version} — {new Date(lastChange.createdAt).toLocaleString('en-GB')}.
          {lastChange.oldValue ? ' The previous values are in the audit log.' : ' First save.'}
        </p>
      )}

      {error && (
        <div className="p-4 bg-white border border-red-200 rounded-[10px]">
          <p className="text-[12px] font-bold text-red-600 leading-relaxed">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Terminal statuses — closing a lead</h5>
        <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
          At least one status must stay terminal. “Won” closes the lead as a win (calendar entry completes);
          “Lost” closes it as a loss (calendar entry cancels). Un-ticking a status re-opens its leads.
        </p>
        <div className="space-y-2">
          {loaded.statusOptions.map(opt => (
            <div key={opt.id} className="flex flex-wrap items-center gap-3 bg-white border border-slate-100 rounded-[10px] px-3 py-2">
              <span className="text-[12px] font-black text-slate-700 w-36">{opt.label}</span>
              <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.terminalStatusIds.includes(opt.id)}
                  onChange={() => toggleTerminal(opt.id)}
                />
                Terminal
              </label>
              {opt.isWon && <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600">Won</span>}
              {opt.isLost && <span className="text-[10px] font-black uppercase tracking-widest text-red-500">Lost</span>}
              {!opt.isActive && <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Inactive</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Required fields per status — what a follow-up must carry</h5>
        <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
          A follow-up that moves a lead to one of these statuses is refused until every ticked field is filled.
          Un-tick every field for a status to carry no rule for it. The server enforces the same list, so the
          form and the API can never drift.
        </p>
        <div className="space-y-2">
          {loaded.statusOptions.map(opt => {
            const current = draft.requiredByStatus[opt.id] ?? [];
            const defaults = defaultByStatus.get(opt.id) ?? [];
            return (
              <div key={opt.id} className="bg-white border border-slate-100 rounded-[10px] px-3 py-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-black text-slate-700 w-36">{opt.label}</span>
                  {current.length === 0 && (
                    <span className="text-[10px] font-bold text-slate-400">No rule — a follow-up to this status needs nothing extra</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 pl-1">
                  {loaded.fieldVocabulary.map(field => (
                    <label key={field.field} className="flex items-center gap-1 text-[11px] font-bold text-slate-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={current.includes(field.field)}
                        onChange={() => toggleField(opt.id, field.field)}
                      />
                      {field.label}
                    </label>
                  ))}
                </div>
                {defaults.length > 0 && (
                  <p className="text-[10px] font-bold text-slate-300 pl-1">code default: {defaults.join(', ')}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save stage rules'}
        </button>
        <button
          type="button"
          onClick={handleRevert}
          disabled={!dirty || saving}
          className="px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          Revert changes
        </button>
        <button
          type="button"
          onClick={handleResetToDefaults}
          disabled={saving}
          className="px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          Reset to code defaults
        </button>
        {!dirty && <span className="text-[11px] font-bold text-slate-400">No unsaved changes.</span>}
      </div>
    </div>
  );
}
