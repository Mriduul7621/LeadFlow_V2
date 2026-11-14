import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  dangerZoneService,
  type RoleDefaults,
  type RoleDefaultsApplyResult,
  type RoleDefaultsForEdit,
  type RoleDefaultsInput,
} from '../services/dangerZoneService';

/**
 * DangerZoneRoleDefaults.tsx — the DZ-5 role-defaults editor.
 * ------------------------------------------------------------------
 * Settings → Danger Zone (super admin only, 10-minute unlock) holds
 * the defaults table (audit §2.2 B6): which permission codes and
 * which data-visibility scope a standard role holds BEFORE anyone
 * configures it. A change here does NOT rewrite any configured
 * role — it only changes what a role with zero grants receives
 * when the defaults are applied (seed, or the Apply button below).
 *
 * Two things the super admin must understand before touching it:
 *   - ADMIN / SUPERADMIN are not in this table and never can be:
 *     they bypass every check and are forced to Organization scope.
 *   - The UM-1 tree floor still applies on top of any scope in
 *     this table: a role whose default scope is 'Own' still sees
 *     its reporting subtree when it has one. This table cannot
 *     switch the floor off, and it never edits the lead-visibility
 *     rule itself (that rule is a hard invariant, §3.4).
 *
 * The parent mounts this only while unlocked; a `danger_zone_locked`
 * answer (unlock expired mid-edit) drops back to the password
 * prompt via onLocked. Nothing about the unlock is stored here.
 */

type Draft = RoleDefaultsInput;

const VISIBILITY_CHOICES = ['', 'Own', 'DownTeam', 'FullTeam', 'Organization'] as const;

function draftFromLoaded(data: RoleDefaultsForEdit): Draft {
  return {
    grants: Object.fromEntries(
      Object.entries(data.defaults.grants).map(([code, codes]) => [code, [...codes]])
    ),
    visibility: { ...data.defaults.visibility },
  };
}

function draftFromDefaults(data: RoleDefaultsForEdit): Draft {
  return {
    grants: Object.fromEntries(
      Object.entries(data.codeDefaults.grants).map(([code, codes]) => [code, [...codes]])
    ),
    visibility: { ...data.codeDefaults.visibility },
  };
}

function cloneDraft(d: Draft): Draft {
  return {
    grants: Object.fromEntries(Object.entries(d.grants).map(([k, v]) => [k, [...v]])),
    visibility: { ...d.visibility },
  };
}

function roleCodesInOrder(loaded: RoleDefaultsForEdit, draft: Draft): string[] {
  const ordered = Object.keys(loaded.codeDefaults.grants);
  const extra = Object.keys(draft.grants)
    .filter((code) => !ordered.includes(code))
    .sort();
  const visOnly = Object.keys(draft.visibility)
    .filter((code) => !ordered.includes(code) && !extra.includes(code))
    .sort();
  return [...ordered, ...extra, ...visOnly];
}

function visibilityLabel(value: string | undefined): string {
  if (!value) return 'No default (stays Own)';
  return value;
}

function diffLines(oldValue: RoleDefaults | null, newValue: RoleDefaults): string[] {
  if (!oldValue) return ['First saved version — no previous table to compare.'];
  const lines: string[] = [];
  const codes = [...new Set([...Object.keys(oldValue.grants), ...Object.keys(newValue.grants)])].sort();
  for (const code of codes) {
    const oldGrants = new Set(oldValue.grants[code] || []);
    const newGrants = new Set(newValue.grants[code] || []);
    const added = [...newGrants].filter((c) => !oldGrants.has(c)).sort();
    const removed = [...oldGrants].filter((c) => !newGrants.has(c)).sort();
    const oldVis = oldValue.visibility[code];
    const newVis = newValue.visibility[code];
    const parts: string[] = [];
    if (oldVis !== newVis) {
      parts.push(`visibility ${visibilityLabel(oldVis)} → ${visibilityLabel(newVis)}`);
    }
    if (added.length > 0) parts.push(`+${added.join(', +')}`);
    if (removed.length > 0) parts.push(`−${removed.join(', −')}`);
    if (parts.length > 0) lines.push(`${code}: ${parts.join('; ')}`);
  }
  const visOnly = [...new Set([...Object.keys(oldValue.visibility), ...Object.keys(newValue.visibility)])]
    .filter((code) => !codes.includes(code));
  for (const code of visOnly.sort()) {
    const oldVis = oldValue.visibility[code];
    const newVis = newValue.visibility[code];
    if (oldVis !== newVis) {
      lines.push(`${code}: visibility ${visibilityLabel(oldVis)} → ${visibilityLabel(newVis)}`);
    }
  }
  return lines.length > 0 ? lines : ['No role changed.'];
}

export default function DangerZoneRoleDefaults({ onLocked }: { onLocked: () => void }) {
  const [loaded, setLoaded] = useState<RoleDefaultsForEdit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [applyResult, setApplyResult] = useState<RoleDefaultsApplyResult | null>(null);

  const refresh = async () => {
    const data = await dangerZoneService.getRoleDefaults();
    setLoaded(data);
    const d = draftFromLoaded(data);
    setDraft(d);
    setSavedDraft(cloneDraft(d));
    return data;
  };

  useEffect(() => {
    let cancelled = false;
    refresh()
      .then(() => { if (!cancelled) setLoading(false); })
      .catch((err: any) => {
        if (cancelled) return;
        if (err?.data?.error === 'danger_zone_locked') {
          onLocked();
          return;
        }
        setLoadError(err?.message || 'Could not load the role defaults.');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleCodes = useMemo(
    () => (loaded && draft ? roleCodesInOrder(loaded, draft) : []),
    [loaded, draft]
  );

  if (loading) {
    return <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Loading role defaults...</p>;
  }
  if (loadError || !loaded || !draft) {
    return (
      <div className="p-6 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-3">
        <p className="text-[12px] font-bold text-slate-600">{loadError || 'Role defaults are unavailable.'}</p>
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
  const setGrants = (roleCode: string, codes: string[]) =>
    setDraft((prev) => (prev ? { ...prev, grants: { ...prev.grants, [roleCode]: codes } } : prev));
  const setVisibility = (roleCode: string, value: string) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const visibility = { ...prev.visibility };
      if (value === '') delete visibility[roleCode];
      else visibility[roleCode] = value;
      return { ...prev, visibility };
    });
  const toggleCode = (roleCode: string, code: string) => {
    const current = new Set<string>(draft.grants[roleCode] || []);
    if (current.has(code)) current.delete(code);
    else current.add(code);
    setGrants(roleCode, [...current].sort());
  };

  // Presets are the four named sets of the CODE defaults, read from the
  // loaded code table (a representative role each) — never retyped.
  const presetFor = (name: 'FIELD_EXEC' | 'TEAM_LEAD' | 'MANAGER' | 'EXECUTIVE'): string[] => {
    const rep = { FIELD_EXEC: 'EMPLOYEE', TEAM_LEAD: 'TEAM_LEAD', MANAGER: 'MANAGER', EXECUTIVE: 'CEO' } as const;
    return [...(loaded.codeDefaults.grants[rep[name]] || [])];
  };

  const handleSave = async () => {
    if (!draft || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const saved = await dangerZoneService.saveRoleDefaults({ ...draft });
      const next = draftFromLoaded(saved);
      setLoaded(saved);
      setDraft(next);
      setSavedDraft(cloneDraft(next));
      setApplyResult(null);
      toast.success(`Role defaults saved — version ${saved.version}. Nothing changes until you press Apply.`);
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        onLocked();
        return;
      }
      setError(err?.message || err?.data?.message || 'Could not save the role defaults.');
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setError('');
    try {
      const result = await dangerZoneService.applyRoleDefaults();
      setApplyResult(result);
      await refresh();
      const changed = result.report.applied.length;
      toast.success(
        changed === 0
          ? 'Nothing to apply — every role already holds grants.'
          : `Applied defaults to ${changed} role${changed === 1 ? '' : 's'}.`
      );
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        onLocked();
        return;
      }
      setError(err?.message || err?.data?.message || 'Could not apply the role defaults.');
    } finally {
      setApplying(false);
    }
  };

  const handleResetToDefaults = () => {
    setDraft(draftFromDefaults(loaded));
  };

  const handleRevert = () => {
    if (savedDraft) setDraft(cloneDraft(savedDraft));
  };

  const lastChange = loaded.lastChange;
  const unconfigured = loaded.unconfiguredRoles;

  return (
    <div className="space-y-6 p-6 bg-red-50/40 rounded-sm border border-red-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[11px] font-black uppercase tracking-widest text-red-600">Role defaults (B6)</h4>
          <p className="text-[11px] text-slate-500 font-bold leading-relaxed mt-2 max-w-2xl">
            What a standard role holds before anyone configures it. Saving this table changes no role on
            its own — press Apply below and only roles holding zero grants receive it. A role that already
            holds any grant is never touched, and its visibility only moves while it still holds &lsquo;Own&rsquo;.
            ADMIN / SUPERADMIN are not in this table: they bypass every check and always see the whole
            organisation. And the team-lead floor still applies on top of any scope here — an &lsquo;Own&rsquo;
            role with reports still sees its subtree; this table cannot switch that off.
          </p>
        </div>
        <span className="px-2 py-1 bg-white border border-red-100 text-red-600 text-[10px] font-black uppercase tracking-widest rounded">
          Version {loaded.version}{loaded.version === 0 ? ' — code defaults' : ''}
        </span>
      </div>

      {lastChange && (
        <div className="space-y-1">
          <p className="text-[11px] font-bold text-slate-500">
            Last change: version {lastChange.version} — {new Date(lastChange.createdAt).toLocaleString('en-GB')}.
          </p>
          <ul className="space-y-0.5">
            {diffLines(lastChange.oldValue, lastChange.newValue).map((line, i) => (
              <li key={i} className="text-[11px] font-bold text-slate-500 leading-relaxed">• {line}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="p-4 bg-white border border-red-200 rounded-[10px]">
          <p className="text-[12px] font-bold text-red-600 leading-relaxed">{error}</p>
        </div>
      )}

      {loaded.permissionCodes.length === 0 && (
        <div className="p-4 bg-white border border-red-200 rounded-[10px]">
          <p className="text-[12px] font-bold text-red-600 leading-relaxed">
            No permission codes were found in the database, so grants cannot be saved right now.
          </p>
        </div>
      )}

      <div className="space-y-3 p-4 bg-white border border-slate-200 rounded-[10px]">
        <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">
          Apply to unconfigured roles
        </h5>
        <p className="text-[11px] text-slate-500 font-bold leading-relaxed">
          {unconfigured.length === 0
            ? 'Every role already holds grants — there is nothing for Apply to change.'
            : `These roles hold zero grants and would receive the saved table: ${unconfigured.map((r) => `${r.roleCode} (${r.roleName})`).join(', ')}.`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={applying || dirty}
            className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
          >
            {applying ? 'Applying...' : 'Apply to unconfigured roles'}
          </button>
          {dirty && (
            <span className="text-[11px] font-bold text-red-500">Save the table first — Apply uses the saved version.</span>
          )}
        </div>
        {applyResult && (
          <div className="space-y-1">
            <p className="text-[11px] font-bold text-slate-500">
              Applied version {applyResult.version}: {applyResult.report.applied.length} role
              {applyResult.report.applied.length === 1 ? '' : 's'} changed
              {applyResult.report.skipped.length > 0 ? `, ${applyResult.report.skipped.length} already configured (skipped)` : ''}.
            </p>
            <ul className="space-y-0.5">
              {applyResult.report.applied.map((entry) => (
                <li key={entry.roleCode} className="text-[11px] font-bold text-slate-500 leading-relaxed">
                  • {entry.roleCode}: {entry.grantsAdded.length > 0 ? `${entry.grantsAdded.length} grant${entry.grantsAdded.length === 1 ? '' : 's'} added` : 'no grants added'}
                  {entry.visibilityChanged ? `; visibility ${entry.visibilityFrom} → ${entry.visibilityTo}` : '; visibility unchanged'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {roleCodes.map((roleCode) => {
          const codes = draft.grants[roleCode] || [];
          const codeDefaultCodes = loaded.codeDefaults.grants[roleCode] || [];
          const codeDefaultVis = loaded.codeDefaults.visibility[roleCode];
          return (
            <details key={roleCode} className="bg-white border border-slate-200 rounded-[10px] p-4 space-y-3">
              <summary className="cursor-pointer text-sm font-black text-slate-700">
                {roleCode} — {codes.length} permission{codes.length === 1 ? '' : 's'} · {visibilityLabel(draft.visibility[roleCode])}
                <span className="block text-[10px] font-bold text-slate-400 mt-1">
                  Code default: {codeDefaultCodes.length} permissions · {visibilityLabel(codeDefaultVis)}
                </span>
              </summary>
              <div className="space-y-3 pt-2">
                <label className="block space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Data visibility default</span>
                  <select
                    value={draft.visibility[roleCode] || ''}
                    onChange={(e) => setVisibility(roleCode, e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-[10px] px-3 py-2 text-sm font-bold text-slate-700"
                  >
                    {VISIBILITY_CHOICES.map((choice) => (
                      <option key={choice || 'none'} value={choice}>
                        {visibilityLabel(choice || undefined)}
                      </option>
                    ))}
                  </select>
                  <span className="block text-[10px] font-bold text-slate-400">
                    Only moves a role while it still holds &lsquo;Own&rsquo;. A role with reports still sees its
                    subtree even on &lsquo;Own&rsquo; (the team-lead floor).
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Set grants to:</span>
                  {(['FIELD_EXEC', 'TEAM_LEAD', 'MANAGER', 'EXECUTIVE'] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setGrants(roleCode, presetFor(preset))}
                      className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-[11px] font-bold"
                    >
                      {preset === 'FIELD_EXEC' ? 'Field exec' : preset === 'TEAM_LEAD' ? 'Team lead' : preset === 'MANAGER' ? 'Manager' : 'Executive'}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setGrants(roleCode, [])}
                    className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-[11px] font-bold"
                  >
                    None
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {loaded.permissionCodes.map((perm) => {
                    const checked = codes.includes(perm.code);
                    return (
                      <label
                        key={perm.code}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 border rounded-[10px] text-[11px] font-bold cursor-pointer ${checked ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-slate-200 text-slate-500'}`}
                        title={perm.name || perm.code}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCode(roleCode, perm.code)}
                          className="accent-red-600"
                        />
                        {perm.code}
                      </label>
                    );
                  })}
                </div>
              </div>
            </details>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save role defaults'}
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
