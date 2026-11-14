import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  dangerZoneService,
  type SecurityPolicy,
  type SecurityPolicyForEdit,
  type SecurityPolicyInput,
} from '../services/dangerZoneService';

/**
 * DangerZoneSecurityPolicy.tsx — the DZ-4 security policy editor.
 * ------------------------------------------------------------------
 * Settings → Danger Zone (super admin only, 10-minute unlock) holds
 * the security policy (audit §2.1 A1/A5/A8/A9): minimum password
 * length, per-account lockout, token lifetime and the login rate
 * limit. Every value is enforced live by the server — a change
 * applies to the very next sign-in, password set or token issued.
 * Length-only: no complexity toggles (owner decision Q3).
 *
 * The parent mounts this only while unlocked; a `danger_zone_locked`
 * answer (unlock expired mid-edit) drops back to the password
 * prompt via onLocked. Nothing about the unlock is stored here.
 */

type Draft = SecurityPolicyInput;

function draftFromLoaded(data: SecurityPolicyForEdit): Draft {
  const p = data.policy;
  return {
    passwordMinLength: p.passwordMinLength,
    lockoutEnabled: p.lockoutEnabled,
    lockoutThreshold: p.lockoutThreshold,
    lockoutMinutes: p.lockoutMinutes,
    tokenLifetimeDays: p.tokenLifetimeDays,
    authRateLimitAttempts: p.authRateLimitAttempts,
  };
}

function draftFromDefaults(data: SecurityPolicyForEdit): Draft {
  const d = data.defaults;
  return {
    passwordMinLength: d.passwordMinLength,
    lockoutEnabled: d.lockoutEnabled,
    lockoutThreshold: d.lockoutThreshold,
    lockoutMinutes: d.lockoutMinutes,
    tokenLifetimeDays: d.tokenLifetimeDays,
    authRateLimitAttempts: d.authRateLimitAttempts,
  };
}

function cloneDraft(d: Draft): Draft {
  return { ...d };
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

function policyLine(label: string, value: string | number | boolean): React.ReactNode {
  return (
    <li className="flex justify-between gap-3 text-[11px] font-bold text-slate-500">
      <span>{label}</span>
      <span className="text-slate-700">{typeof value === 'boolean' ? (value ? 'On' : 'Off') : value}</span>
    </li>
  );
}

export default function DangerZoneSecurityPolicy({ onLocked }: { onLocked: () => void }) {
  const [loaded, setLoaded] = useState<SecurityPolicyForEdit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    dangerZoneService.getSecurityPolicy()
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
        setLoadError(err?.message || 'Could not load the security policy.');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Loading security policy...</p>;
  }
  if (loadError || !loaded || !draft) {
    return (
      <div className="p-6 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-3">
        <p className="text-[12px] font-bold text-slate-600">{loadError || 'Security policy is unavailable.'}</p>
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
  const b = loaded.bounds;

  const handleSave = async () => {
    if (!draft || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const input: SecurityPolicyInput = { ...draft };
      const saved = await dangerZoneService.saveSecurityPolicy(input);
      const next = draftFromLoaded(saved);
      setLoaded(saved);
      setDraft(next);
      setSavedDraft(cloneDraft(next));
      toast.success(`Security policy saved — version ${saved.version}. It applies to the next sign-in and password set.`);
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        onLocked();
        return;
      }
      setError(err?.message || err?.data?.message || 'Could not save the security policy.');
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

  return (
    <div className="space-y-6 p-6 bg-red-50/40 rounded-sm border border-red-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[11px] font-black uppercase tracking-widest text-red-600">Security policy (A1, A5, A8, A9)</h4>
          <p className="text-[11px] text-slate-500 font-bold leading-relaxed mt-2 max-w-2xl">
            Passwords, sign-ins and lockouts for the whole app. A change applies immediately to the next
            sign-in, password set or token issued — sessions already signed in keep the lifetime they were
            issued with. Lockout is per account and sits beside the per-IP sign-in limit, never instead of it.
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
          {lastChange.oldValue && (
            <ul className="space-y-0.5">
              {policyLine('Minimum password length', `${lastChange.oldValue.passwordMinLength} → ${lastChange.newValue.passwordMinLength} characters`)}
              {policyLine('Account lockout', `${lastChange.oldValue.lockoutEnabled ? 'On' : 'Off'} → ${lastChange.newValue.lockoutEnabled ? 'On' : 'Off'}`)}
              {policyLine('Lockout threshold', `${lastChange.oldValue.lockoutThreshold} → ${lastChange.newValue.lockoutThreshold} failed sign-ins`)}
              {policyLine('Lockout duration', `${lastChange.oldValue.lockoutMinutes} → ${lastChange.newValue.lockoutMinutes} minutes`)}
              {policyLine('Token lifetime', `${lastChange.oldValue.tokenLifetimeDays} → ${lastChange.newValue.tokenLifetimeDays} days`)}
              {policyLine('Sign-in limit per IP', `${lastChange.oldValue.authRateLimitAttempts} → ${lastChange.newValue.authRateLimitAttempts} failed / 15 min`)}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="p-4 bg-white border border-red-200 rounded-[10px]">
          <p className="text-[12px] font-bold text-red-600 leading-relaxed">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumField
          label="Minimum password length (A1)"
          hint={`One floor for first-admin setup, password changes, forced changes and admin resets. Never below ${b.passwordMinLength.min}.`}
          value={draft.passwordMinLength}
          defaultValue={loaded.defaults.passwordMinLength}
          min={b.passwordMinLength.min}
          max={b.passwordMinLength.max}
          onChange={n => set({ passwordMinLength: n })}
        />
        <NumField
          label="Sign-in token lifetime, days (A5)"
          hint="Newly issued tokens only — a session already signed in keeps its own expiry."
          value={draft.tokenLifetimeDays}
          defaultValue={loaded.defaults.tokenLifetimeDays}
          min={b.tokenLifetimeDays.min}
          max={b.tokenLifetimeDays.max}
          onChange={n => set({ tokenLifetimeDays: n })}
        />
        <NumField
          label="Failed sign-ins per IP, per 15 min (A8)"
          hint="Only failed attempts count; successful sign-ins are never limited. The 15-minute window is fixed."
          value={draft.authRateLimitAttempts}
          defaultValue={loaded.defaults.authRateLimitAttempts}
          min={b.authRateLimitAttempts.min}
          max={b.authRateLimitAttempts.max}
          onChange={n => set({ authRateLimitAttempts: n })}
        />
        <div className="space-y-3">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Account lockout (A9)</h5>
          <label className="flex items-center gap-2 text-[12px] font-bold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.lockoutEnabled}
              onChange={e => set({ lockoutEnabled: e.target.checked })}
            />
            Lock an account after repeated failed sign-ins
          </label>
          <p className="text-[10px] font-bold text-slate-400 leading-relaxed">
            Switching it off takes effect at once. A locked account answers “locked” until its time is up;
            an admin can unlock it early from the user&apos;s edit screen. The last super admin is never
            exempt — a lock is time-bounded and heals itself, it is not a removal.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumField
              label="Failed sign-ins that lock"
              hint="Attempts on one account"
              value={draft.lockoutThreshold}
              defaultValue={loaded.defaults.lockoutThreshold}
              min={b.lockoutThreshold.min}
              max={b.lockoutThreshold.max}
              disabled={!draft.lockoutEnabled}
              onChange={n => set({ lockoutThreshold: n })}
            />
            <NumField
              label="Lock lasts (minutes)"
              hint="Then the account opens again"
              value={draft.lockoutMinutes}
              defaultValue={loaded.defaults.lockoutMinutes}
              min={b.lockoutMinutes.min}
              max={b.lockoutMinutes.max}
              disabled={!draft.lockoutEnabled}
              onChange={n => set({ lockoutMinutes: n })}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save security policy'}
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
