import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../../shared/api/http';
import { cn } from '../../../lib/utils';

interface AuditLogEntry {
  id: string;
  action_code: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_name?: string | null;
  actor_employee_id?: string | null;
  target_user_id?: string | null;
  target_name?: string | null;
  target_employee_id?: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function formatAuditDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || '—';
  return date.toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function searchableText(row: AuditLogEntry): string {
  return [
    row.action_code,
    row.entity_type,
    row.entity_id,
    row.actor_user_id,
    row.actor_name,
    row.actor_employee_id,
    row.target_user_id,
    row.target_name,
    row.target_employee_id,
    row.created_at,
    JSON.stringify(row.metadata || {}),
  ].join(' ').toLowerCase();
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<AuditLogEntry[]>('/api/audit-logs?limit=200');
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load audit events.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row => searchableText(row).includes(query));
  }, [rows, search]);

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 pb-12 font-sans">
      <header className="flex flex-col gap-4 rounded-[14px] border border-[#E5E2D9] bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between md:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[#858515]/10 text-[#596B35]">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#858515]">Administration · Governance</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-[#263238]">Audit Log</h1>
            <p className="mt-1 text-sm text-stone-500">Review administrative and sensitive system activity.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-stone-200 bg-white px-4 py-2 text-xs font-bold text-stone-700 transition-colors hover:border-[#858515]/40 hover:text-[#596B35] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </button>
      </header>

      <section className="rounded-[14px] border border-[#E5E2D9] bg-white p-4 shadow-sm md:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-black text-[#263238]">Activity history</h2>
            <p className="mt-1 text-xs text-stone-500">Latest events returned by the secured audit service.</p>
          </div>
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search actor, action, record or details"
              aria-label="Search audit events"
              className="min-h-11 w-full rounded-[10px] border border-stone-200 bg-[#F8F7F2] pl-9 pr-3 text-sm text-stone-800 outline-none transition focus:border-[#858515] focus:ring-2 focus:ring-[#858515]/15"
            />
          </div>
        </div>

        {error && (
          <div role="alert" className="mt-5 flex items-start gap-3 rounded-[10px] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{error}</p>
              <p className="mt-1 text-xs text-red-600">No audit data has been changed. Retry the read when the service is available.</p>
              <button type="button" onClick={() => void load()} className="mt-3 min-h-9 rounded-lg bg-red-600 px-3 text-xs font-bold text-white hover:bg-red-700">Retry</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="mt-5 space-y-3" role="status" aria-label="Loading audit events">
            {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-16 animate-pulse rounded-[10px] bg-stone-100" />)}
          </div>
        ) : !error && filteredRows.length === 0 ? (
          <div className="mt-5 flex flex-col items-center justify-center rounded-[12px] border border-dashed border-stone-200 bg-[#F8F7F2] px-5 py-12 text-center">
            <Activity className="h-7 w-7 text-stone-400" />
            <p className="mt-3 text-sm font-bold text-stone-700">{search ? 'No matching audit events' : 'No audit events available'}</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-stone-500">{search ? 'Try another actor, action code or record identifier.' : 'New administrative events will appear here after they are recorded.'}</p>
          </div>
        ) : !error ? (
          <>
            <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-stone-500">
              <span>{filteredRows.length.toLocaleString('en-US')} events shown</span>
              <span>Times shown in Asia/Dhaka</span>
            </div>
            <div className="mt-3 overflow-hidden rounded-[10px] border border-stone-100">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[940px] border-collapse text-left">
                  <thead className="bg-[#F8F7F2] text-[10px] font-black uppercase tracking-wider text-stone-500">
                    <tr>
                      <th className="px-4 py-3">Date & time</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Actor</th>
                      <th className="px-4 py-3">Target</th>
                      <th className="px-4 py-3">Record</th>
                      <th className="px-4 py-3">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {filteredRows.map(row => (
                      <tr key={row.id} className="align-top transition-colors hover:bg-[#F8F7F2]/70">
                        <td className="whitespace-nowrap px-4 py-4 text-xs text-stone-600">{formatAuditDate(row.created_at)}</td>
                        <td className="px-4 py-4">
                          <span className="inline-flex rounded-full border border-[#858515]/20 bg-[#858515]/10 px-2.5 py-1 text-[10px] font-bold text-[#596B35]">{row.action_code || 'Unknown action'}</span>
                        </td>
                        <td className="px-4 py-4 text-xs text-stone-700">
                          <span className="font-semibold">{row.actor_name || 'Unknown actor'}</span>
                          <span className="mt-1 block break-all font-mono text-[10px] text-stone-400">{row.actor_employee_id || row.actor_user_id || '—'}</span>
                        </td>
                        <td className="px-4 py-4 text-xs text-stone-700">
                          <span className="font-semibold">{row.target_name || (row.target_user_id ? 'Unavailable user' : '—')}</span>
                          {row.target_user_id && <span className="mt-1 block break-all font-mono text-[10px] text-stone-400">{row.target_employee_id || row.target_user_id}</span>}
                        </td>
                        <td className="px-4 py-4 text-xs text-stone-600">
                          <span className="font-semibold text-stone-700">{row.entity_type || '—'}</span>
                          {row.entity_id && <span className="mt-1 block max-w-[180px] break-all font-mono text-[10px] text-stone-400">{row.entity_id}</span>}
                        </td>
                        <td className="px-4 py-4">
                          {row.metadata && Object.keys(row.metadata).length > 0 ? (
                            <details className="max-w-[340px]">
                              <summary className="cursor-pointer text-xs font-semibold text-[#596B35] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#858515]">View details</summary>
                              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#F8F7F2] p-3 text-[10px] leading-4 text-stone-600">{JSON.stringify(row.metadata, null, 2)}</pre>
                            </details>
                          ) : <span className="text-xs text-stone-400">No additional details</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
