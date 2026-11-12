import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  dangerZoneService,
  type LeadQualityConfigForEdit,
  type LeadQualityConfigInput,
  type LeadQualityLadderRung,
} from '../services/dangerZoneService';

/**
 * DangerZoneLeadQuality.tsx — the DZ-3 Lead Quality editor.
 * ------------------------------------------------------------------
 * Settings → Danger Zone (super admin only, 10-minute unlock) holds
 * the Lead Quality scoring weights (audit §2.6 F1–F6). This editor
 * loads the current effective config + the code defaults, lets the
 * super admin change them, and saves one versioned config. Status
 * points are edited per dictionary entry (option id) — renaming a
 * status never detaches its points. Terminal statuses take no
 * points: they bypass the scale with fixed scores (DZ-6 owns them).
 *
 * The parent mounts this only while unlocked; a `danger_zone_locked`
 * answer (unlock expired mid-edit) drops back to the password
 * prompt via onLocked. Nothing about the unlock is stored here.
 */

interface Draft {
  baseScore: number;
  thresholds: { hot: number; warm: number; developing: number };
  statusPoints: Record<string, number>;
  advancedStatusIds: string[];
  recency: LeadQualityLadderRung[];
  engagement: { pointsPerEvent: number; maxEvents: number };
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  investment: { points: number };
}

function draftFromLoaded(data: LeadQualityConfigForEdit): Draft {
  const statusPoints: Record<string, number> = {};
  const advancedStatusIds: string[] = [];
  for (const opt of data.statusOptions) {
    statusPoints[opt.id] = opt.points;
    if (opt.advanced) advancedStatusIds.push(opt.id);
  }
  const c = data.config;
  return {
    baseScore: c.baseScore,
    thresholds: { ...c.thresholds },
    statusPoints,
    advancedStatusIds,
    recency: c.recency.map(r => ({ ...r })),
    engagement: { ...c.engagement },
    failedContact: { ...c.failedContact },
    followUp: { scheduledPoints: c.followUp.scheduledPoints, overdue: c.followUp.overdue.map(r => ({ ...r })) },
    investment: { ...c.investment },
  };
}

function draftFromDefaults(data: LeadQualityConfigForEdit): Draft {
  const statusPoints: Record<string, number> = {};
  const advancedStatusIds: string[] = [];
  for (const opt of data.statusOptions) {
    statusPoints[opt.id] = opt.defaultPoints;
    if (opt.defaultAdvanced) advancedStatusIds.push(opt.id);
  }
  const d = data.defaults;
  return {
    baseScore: d.baseScore,
    thresholds: { ...d.thresholds },
    statusPoints,
    advancedStatusIds,
    recency: d.recency.map(r => ({ ...r })),
    engagement: { ...d.engagement },
    failedContact: { ...d.failedContact },
    followUp: { scheduledPoints: d.followUp.scheduledPoints, overdue: d.followUp.overdue.map(r => ({ ...r })) },
    investment: { ...d.investment },
  };
}

function cloneDraft(d: Draft): Draft {
  return JSON.parse(JSON.stringify(d)) as Draft;
}

function parseIntInput(raw: string, fallback: number): number {
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function NumField(props: {
  label: string;
  hint: string;
  value: number;
  defaultValue: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onChange={e => props.onChange(parseIntInput(e.target.value, props.value))}
        className="w-full bg-white border border-slate-200 rounded-[10px] px-3 py-2 text-sm font-bold text-slate-700 disabled:opacity-40"
      />
      <span className="block text-[10px] font-bold text-slate-400">{props.hint} (code default: {props.defaultValue})</span>
    </label>
  );
}

function LadderEditor(props: {
  title: string;
  intro: string;
  rungs: LeadQualityLadderRung[];
  defaultRungs: LeadQualityLadderRung[];
  pointMin: number;
  pointMax: number;
  onChange: (rungs: LeadQualityLadderRung[]) => void;
}) {
  const { rungs, defaultRungs } = props;
  const setRung = (i: number, patch: Partial<LeadQualityLadderRung>) => {
    const next = rungs.map((r, j) => (j === i ? { ...r, ...patch } : r));
    props.onChange(next);
  };
  return (
    <div className="space-y-3">
      <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{props.title}</h5>
      <p className="text-[11px] font-bold text-slate-400 leading-relaxed">{props.intro}</p>
      <div className="space-y-2">
        {rungs.map((rung, i) => {
          const isLast = i === rungs.length - 1;
          const prevMax = i === 0 ? -1 : (rungs[i - 1].maxDays ?? 0);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 bg-white border border-slate-100 rounded-[10px] px-3 py-2">
              <span className="text-[11px] font-bold text-slate-500 w-32">
                {isLast ? `More than ${prevMax} days` : `Within ${rung.maxDays ?? '—'} days`}
              </span>
              {!isLast && (
                <label className="flex items-center gap-1 text-[10px] font-bold text-slate-400">
                  up to
                  <input
                    type="number"
                    value={rung.maxDays ?? 0}
                    min={0}
                    onChange={e => setRung(i, { maxDays: parseIntInput(e.target.value, rung.maxDays ?? 0) })}
                    className="w-16 bg-white border border-slate-200 rounded px-2 py-1 text-xs font-bold text-slate-700"
                  />
                  days
                </label>
              )}
              <label className="flex items-center gap-1 text-[10px] font-bold text-slate-400">
                points
                <input
                  type="number"
                  value={rung.points}
                  min={props.pointMin}
                  max={props.pointMax}
                  onChange={e => setRung(i, { points: parseIntInput(e.target.value, rung.points) })}
                  className="w-16 bg-white border border-slate-200 rounded px-2 py-1 text-xs font-bold text-slate-700"
                />
              </label>
              <span className="text-[10px] font-bold text-slate-300">
                default: {defaultRungs[i] ? `${defaultRungs[i].maxDays === null ? `>${prevMax}d` : `≤${defaultRungs[i].maxDays}d`} → ${defaultRungs[i].points}` : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DangerZoneLeadQuality({ onLocked }: { onLocked: () => void }) {
  const [loaded, setLoaded] = useState<LeadQualityConfigForEdit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    dangerZoneService.getLeadQuality()
      .then(data => {
        if (cancelled) return;
        setLoaded(data);
        const d = draftFromLoaded(data);
        setDraft(d);
        setSavedDraft(cloneDraft(d));
        setLoading(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        if (err?.data?.error === 'danger_zone_locked') {
          onLocked();
          return;
        }
        setLoadError(err?.message || 'Could not load the Lead Quality config.');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Loading Lead Quality config...</p>;
  }
  if (loadError || !loaded || !draft) {
    return (
      <div className="p-6 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-3">
        <p className="text-[12px] font-bold text-slate-600">{loadError || 'Lead Quality config is unavailable.'}</p>
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

  const handleSave = async () => {
    if (!draft || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const input: LeadQualityConfigInput = {
        baseScore: draft.baseScore,
        thresholds: draft.thresholds,
        statusPoints: draft.statusPoints,
        advancedStatusIds: draft.advancedStatusIds,
        recency: draft.recency,
        engagement: draft.engagement,
        failedContact: draft.failedContact,
        followUp: draft.followUp,
        investment: draft.investment,
      };
      const saved = await dangerZoneService.saveLeadQuality(input);
      const next = draftFromLoaded(saved);
      setLoaded(saved);
      setDraft(next);
      setSavedDraft(cloneDraft(next));
      toast.success(`Lead Quality config saved — version ${saved.version}. Every lead is now scored with these weights.`);
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        onLocked();
        return;
      }
      setError(err?.message || err?.data?.message || 'Could not save the Lead Quality config.');
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

  const toggleAdvanced = (id: string) => {
    setDraft(prev => {
      if (!prev) return prev;
      const has = prev.advancedStatusIds.includes(id);
      return {
        ...prev,
        advancedStatusIds: has ? prev.advancedStatusIds.filter(x => x !== id) : [...prev.advancedStatusIds, id],
      };
    });
  };

  const lastChange = loaded.lastChange;

  return (
    <div className="space-y-6 p-6 bg-red-50/40 rounded-sm border border-red-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[11px] font-black uppercase tracking-widest text-red-600">Lead Quality scoring (F1–F6)</h4>
          <p className="text-[11px] text-slate-500 font-bold leading-relaxed mt-2 max-w-2xl">
            How every active lead is scored 0–{loaded.scale.max}. Changing a weight re-bands the whole pipeline
            overnight — scores are computed live from these values, so there is nothing to re-run. Terminal
            outcomes (Converted = 100, Not Interested = 0) are fixed and are not part of this config.
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumField
          label="Base score (F1)"
          hint="Every active lead starts here"
          value={draft.baseScore}
          defaultValue={loaded.defaults.baseScore}
          min={0}
          max={100}
          onChange={n => set({ baseScore: n })}
        />
        <div className="grid grid-cols-3 gap-3">
          <NumField
            label="Hot ≥ (F2)"
            hint="Hot band"
            value={draft.thresholds.hot}
            defaultValue={loaded.defaults.thresholds.hot}
            min={0}
            max={100}
            onChange={n => set({ thresholds: { ...draft.thresholds, hot: n } })}
          />
          <NumField
            label="Warm ≥ (F2)"
            hint="Warm band"
            value={draft.thresholds.warm}
            defaultValue={loaded.defaults.thresholds.warm}
            min={0}
            max={100}
            onChange={n => set({ thresholds: { ...draft.thresholds, warm: n } })}
          />
          <NumField
            label="Developing ≥ (F2)"
            hint="Developing band"
            value={draft.thresholds.developing}
            defaultValue={loaded.defaults.thresholds.developing}
            min={0}
            max={100}
            onChange={n => set({ thresholds: { ...draft.thresholds, developing: n } })}
          />
        </div>
      </div>

      <div className="space-y-3">
        <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Status points (F3) — per dictionary entry</h5>
        <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
          Points attach to the status entry itself, not its name: renaming a status keeps its points.
          “Advanced” means a missing next action raises an attention flag for leads on that status.
          Terminal statuses take no points.
        </p>
        <div className="space-y-2">
          {loaded.statusOptions.map(opt => (
            <div key={opt.id} className="flex flex-wrap items-center gap-3 bg-white border border-slate-100 rounded-[10px] px-3 py-2">
              <span className="text-[12px] font-black text-slate-700 w-36">{opt.label}</span>
              {opt.isTerminal ? (
                <span className="text-[11px] font-bold text-slate-400">Terminal — fixed score, no points</span>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-[10px] font-bold text-slate-400">
                    points
                    <input
                      type="number"
                      value={draft.statusPoints[opt.id] ?? 0}
                      min={-100}
                      max={100}
                      onChange={e => set({ statusPoints: { ...draft.statusPoints, [opt.id]: parseIntInput(e.target.value, draft.statusPoints[opt.id] ?? 0) } })}
                      className="w-16 bg-white border border-slate-200 rounded px-2 py-1 text-xs font-bold text-slate-700"
                    />
                  </label>
                  <span className="text-[10px] font-bold text-slate-300">default: {opt.defaultPoints}</span>
                  <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.advancedStatusIds.includes(opt.id)}
                      onChange={() => toggleAdvanced(opt.id)}
                    />
                    Advanced
                  </label>
                </>
              )}
              {!opt.isActive && <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Inactive</span>}
            </div>
          ))}
        </div>
      </div>

      <LadderEditor
        title="Recency ladder (F4) — days since last touch"
        intro="Dhaka calendar days since the last contact, activity or creation. The first rung whose window covers the lead applies; the last rung is open-ended."
        rungs={draft.recency}
        defaultRungs={loaded.defaults.recency}
        pointMin={-100}
        pointMax={100}
        onChange={rungs => set({ recency: rungs })}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Engagement (F5)</h5>
          <NumField
            label="Points per meaningful interaction"
            hint="Bonus per event, up to the cap"
            value={draft.engagement.pointsPerEvent}
            defaultValue={loaded.defaults.engagement.pointsPerEvent}
            min={0}
            max={20}
            onChange={n => set({ engagement: { ...draft.engagement, pointsPerEvent: n } })}
          />
          <NumField
            label="Max counted events"
            hint="Anti-gaming cap"
            value={draft.engagement.maxEvents}
            defaultValue={loaded.defaults.engagement.maxEvents}
            min={0}
            max={10}
            onChange={n => set({ engagement: { ...draft.engagement, maxEvents: n } })}
          />
        </div>
        <div className="space-y-3">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Failed contact (F5)</h5>
          <NumField
            label="Points per unanswered attempt"
            hint="Penalty per event (0 or negative)"
            value={draft.failedContact.pointsPerEvent}
            defaultValue={loaded.defaults.failedContact.pointsPerEvent}
            min={-20}
            max={0}
            onChange={n => set({ failedContact: { ...draft.failedContact, pointsPerEvent: n } })}
          />
          <NumField
            label="Max counted attempts"
            hint="Anti-gaming cap"
            value={draft.failedContact.maxEvents}
            defaultValue={loaded.defaults.failedContact.maxEvents}
            min={0}
            max={10}
            onChange={n => set({ failedContact: { ...draft.failedContact, maxEvents: n } })}
          />
          <NumField
            label="Attention flag from (attempts)"
            hint="Repeated unanswered contact flag"
            value={draft.failedContact.attentionAt}
            defaultValue={loaded.defaults.failedContact.attentionAt}
            min={1}
            max={10}
            onChange={n => set({ failedContact: { ...draft.failedContact, attentionAt: n } })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Follow-up discipline (F6)</h5>
          <NumField
            label="Next action scheduled"
            hint="Bonus while the next action is not overdue"
            value={draft.followUp.scheduledPoints}
            defaultValue={loaded.defaults.followUp.scheduledPoints}
            min={-100}
            max={100}
            onChange={n => set({ followUp: { ...draft.followUp, scheduledPoints: n } })}
          />
        </div>
        <div className="space-y-3">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Investment (F6)</h5>
          <NumField
            label="Customer shared an investment interest"
            hint="Flat bonus, never a penalty"
            value={draft.investment.points}
            defaultValue={loaded.defaults.investment.points}
            min={0}
            max={100}
            onChange={n => set({ investment: { points: n } })}
          />
        </div>
      </div>

      <LadderEditor
        title="Overdue ladder (F6) — days overdue"
        intro="Penalty by how many days the next action is overdue. The first rung whose window covers the lead applies; the last rung is open-ended."
        rungs={draft.followUp.overdue}
        defaultRungs={loaded.defaults.followUp.overdue}
        pointMin={-100}
        pointMax={0}
        onChange={overdue => set({ followUp: { ...draft.followUp, overdue } })}
      />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save Lead Quality config'}
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
