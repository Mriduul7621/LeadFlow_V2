import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { adminService, EffectiveAccess, EffectiveAccessPermission } from '../../admin/services/adminService';
import { invalidateSessionCache } from '../../shared/api/sessionCache';
import { useAuthStore } from '../../auth/store/authStore';

/**
 * EnterpriseAccessPanel — F16 Phase F "Effective Access".
 * ------------------------------------------------------------------
 * One question, one screen: **what can this person actually do right now?**
 *
 * This file previously held a panel that nobody imported: it fetched
 * `/api/users/:id/permissions` plus the whole audit log, showed a ROLE/ALLOW/
 * DENY select per row and saved them — three ways to answer "what is the
 * effective permission" and no statement of which layer won. It has been
 * rewritten around the ONE precedence the server already enforces
 * (`hasPermissionCode()`): per-person override → role grant → deny, evaluated
 * server-side by `resolveEffectivePermissions()` and mirrored by
 * `permissionSheet.ts` on the client (the parity test keeps all three equal).
 *
 * The screen therefore does not compute authority — it REPORTS it, and lets an
 * administrator fix the layer that actually decided, which is the whole point
 * of an access review: "allow, deny, or inherited, and from where".
 */

type Filter = 'all' | 'allowed' | 'denied' | 'overrides' | 'deny-over-allow';

interface Props {
  /** The person whose access is being reviewed. */
  userId: string;
  /** Shown in the header while the payload loads. */
  userName?: string;
  onClose: () => void;
}

const SOURCE_LABEL: Record<EffectiveAccessPermission['source'], string> = {
  'user-override': 'Person override',
  'role-grant': 'Role grant',
  'deny-default': 'Denied by default',
};

/** A role row can also explicitly DENY — say which, the two mean different things. */
function sourceLabel(row: EffectiveAccessPermission): string {
  if (row.source === 'role-grant' && row.roleAllowed === false) return 'Role denies';
  return SOURCE_LABEL[row.source];
}

export default function EnterpriseAccessPanel({ userId, userName, onClose }: Props) {
  const { user: currentUser } = useAuthStore();
  const [data, setData] = useState<EffectiveAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  /** code -> the override the administrator is about to save (null = follow role) */
  const [edits, setEdits] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);

  const isSelf = currentUser?.id === userId;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminService.getEffectiveAccess(userId);
      setData(result);
      setEdits({});
    } catch (err: any) {
      setData(null);
      setError(err?.message || 'Could not load this person’s access.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const overridesSet = useMemo(
    () => new Set((data?.permissions || []).filter(p => p.overrideAllowed !== null).map(p => p.code)),
    [data],
  );

  const deniedOverAllowCodes = useMemo(() => {
    // Derived from the rows rather than from a server-side list, so the filter
    // can never disagree with the table it filters.
    return new Set((data?.permissions || [])
      .filter(p => p.overrideAllowed === false && p.roleAllowed === true)
      .map(p => p.code));
  }, [data]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.permissions || []).filter(row => {
      if (term && !`${row.code} ${row.module} ${row.action}`.toLowerCase().includes(term)) return false;
      switch (filter) {
        case 'allowed': return row.allowed;
        case 'denied': return !row.allowed;
        case 'overrides': return row.overrideAllowed !== null;
        case 'deny-over-allow': return deniedOverAllowCodes.has(row.code);
        default: return true;
      }
    });
  }, [data, filter, search, deniedOverAllowCodes]);

  const pendingEdits = useMemo(
    () => Object.entries(edits).filter(([code, value]) => {
      const row = data?.permissions.find(p => p.code === code);
      if (!row) return false;
      return row.overrideAllowed !== value;
    }),
    [edits, data],
  );

  const handleSave = async () => {
    if (pendingEdits.length === 0) return;
    setSaving(true);
    try {
      await adminService.saveUserOverrides(
        userId,
        pendingEdits.map(([code, allowed]) => ({
          code,
          allowed,
          reason: allowed === null ? undefined : `Configured from Effective Access by an administrator`,
        })),
      );
      // If an administrator edits their OWN overrides, the cached sheet the app
      // runs on is now stale — drop it so the next check re-reads the server.
      if (isSelf) invalidateSessionCache(`userPermissions:${userId}`);
      toast.success(
        `${pendingEdits.length} override${pendingEdits.length === 1 ? '' : 's'} saved.`,
        { description: 'Effective access has been re-read from the server.' },
      );
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the overrides.');
    } finally {
      setSaving(false);
    }
  };

  const summary = data?.summary;
  const groupedModules = useMemo(() => {
    const map = new Map<string, EffectiveAccessPermission[]>();
    rows.forEach(row => {
      const key = row.module || 'other';
      map.set(key, [...(map.get(key) || []), row]);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-0 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-4xl bg-white sm:rounded-2xl shadow-xl border border-slate-200 my-0 sm:my-4">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#978C21]" />
              <h2 className="text-lg font-semibold text-slate-900">Effective Access</h2>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              {data?.user?.fullName || userName || 'This person'}
              {data?.role?.roleCode && (
                <>
                  {' · '}
                  <span className="font-medium text-slate-700">{data.role.roleName}</span>
                  {' · data scope '}
                  <span className="font-medium text-slate-700">{data.role.dataVisibility}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              title="Re-read from the server"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={onClose}
              className="px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="px-6 py-16 flex items-center justify-center text-slate-400 text-sm gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the permission layers…
          </div>
        ) : error ? (
          <div className="px-6 py-10">
            <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl p-4">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              <span>{error}</span>
            </div>
          </div>
        ) : data ? (
          <div className="px-6 py-5 space-y-5">
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Actions allowed', value: `${summary?.allowed ?? 0}/${summary?.total ?? 0}`, tone: 'text-emerald-600' },
                { label: 'From the role', value: summary?.roleGrants ?? 0, tone: 'text-slate-700' },
                { label: 'Person allows', value: summary?.overridesAllow ?? 0, tone: 'text-amber-600' },
                { label: 'Person denies', value: summary?.overridesDeny ?? 0, tone: 'text-red-600' },
              ].map(tile => (
                <div key={tile.label} className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{tile.label}</p>
                  <p className={`text-lg font-semibold mt-0.5 ${tile.tone}`}>{tile.value}</p>
                </div>
              ))}
            </div>

            {/* Findings */}
            {data.warnings.length > 0 && (
              <div className="space-y-2">
                {data.warnings.map((warning, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span className="leading-relaxed">{warning}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Pages */}
            <div>
              <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2 mb-2">
                <Layers className="w-4 h-4 text-slate-400" /> Pages this role opens
              </h3>
              {data.pages.length === 0 ? (
                <p className="text-xs text-slate-400">
                  This role has no page set configured, so page access follows the shipped defaults for the role.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.pages.map(page => (
                    <span
                      key={page.path}
                      className={`px-2 py-1 rounded-lg text-[11px] font-medium border ${
                        page.allowed
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                          : 'bg-slate-50 text-slate-400 border-slate-100 line-through'
                      }`}
                    >
                      {page.path}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex flex-wrap gap-1.5">
                {([
                  ['all', `All (${data.permissions.length})`],
                  ['allowed', `Allowed (${summary?.allowed ?? 0})`],
                  ['denied', `Denied (${summary?.denied ?? 0})`],
                  ['overrides', `Person overrides (${overridesSet.size})`],
                  ['deny-over-allow', `Deny over allow (${deniedOverAllowCodes.size})`],
                ] as Array<[Filter, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      filter === key
                        ? 'bg-[#978C21] text-white border-[#978C21]'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search a permission code…"
                className="flex-1 min-w-[180px] px-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none focus:border-[#978C21]"
              />
            </div>

            {/* The matrix */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="grid grid-cols-12 bg-slate-50 px-4 py-2 text-[11px] uppercase tracking-wide text-slate-400 font-medium">
                <div className="col-span-5">Permission</div>
                <div className="col-span-2">Effective</div>
                <div className="col-span-3">Decided by</div>
                <div className="col-span-2 text-right">Person override</div>
              </div>
              <div className="divide-y divide-slate-100 max-h-[45vh] overflow-y-auto">
                {rows.length === 0 && (
                  <p className="px-4 py-8 text-center text-xs text-slate-400">Nothing matches this filter.</p>
                )}
                {groupedModules.map(([module, moduleRows]) => (
                  <div key={module}>
                    <div className="px-4 py-1.5 bg-slate-50/60 text-[11px] font-semibold text-slate-500 capitalize">
                      {module.replace(/[_.]/g, ' ')}
                    </div>
                    {moduleRows.map(row => {
                      const edited = edits[row.code];
                      const pending = pendingEdits.some(([code]) => code === row.code);
                      return (
                        <div key={row.code} className={`grid grid-cols-12 px-4 py-2.5 items-center text-xs ${pending ? 'bg-amber-50/40' : ''}`}>
                          <div className="col-span-5 pr-2">
                            <p className="text-slate-700 font-medium">{row.action || row.code}</p>
                            <p className="text-[10px] text-slate-400 font-mono">{row.code}</p>
                          </div>
                          <div className="col-span-2">
                            {row.allowed ? (
                              <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Allowed
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
                                <XCircle className="w-3.5 h-3.5" /> Denied
                              </span>
                            )}
                          </div>
                          <div className="col-span-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                row.source === 'user-override'
                                  ? 'bg-amber-50 text-amber-700'
                                  : row.source === 'role-grant'
                                    ? 'bg-slate-100 text-slate-600'
                                    : 'bg-slate-100 text-slate-400'
                              }`}
                            >
                              {sourceLabel(row)}
                            </span>
                            {row.overrideIsNoop && (
                              <span className="ml-1 text-[10px] text-slate-400" title="Repeats the role grant — changes nothing today, matters if the role changes.">
                                no-op
                              </span>
                            )}
                          </div>
                          <div className="col-span-2 flex justify-end">
                            <select
                              value={edited === undefined ? (row.overrideAllowed === null ? 'role' : row.overrideAllowed ? 'allow' : 'deny') : edited === null ? 'role' : edited ? 'allow' : 'deny'}
                              onChange={e => {
                                const value = e.target.value;
                                setEdits(prev => ({ ...prev, [row.code]: value === 'role' ? null : value === 'allow' }));
                              }}
                              className="w-full max-w-[110px] px-2 py-1 border border-slate-200 rounded-lg text-[11px] text-slate-600 outline-none focus:border-[#978C21]"
                            >
                              <option value="role">Follow role</option>
                              <option value="allow">Allow</option>
                              <option value="deny">Deny</option>
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Save bar */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-xs text-slate-400">
                Deny beats allow: a person-level deny overrides the role grant, and a role that holds
                nothing denies everything by default.
              </p>
              <button
                onClick={handleSave}
                disabled={saving || pendingEdits.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-40"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {pendingEdits.length > 0 ? `Save ${pendingEdits.length} override${pendingEdits.length === 1 ? '' : 's'}` : 'No changes'}
              </button>
            </div>

            {Object.keys(edits).length > 0 && (
              <button
                onClick={() => setEdits({})}
                className="inline-flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Discard unsaved changes
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
