/**
 * AuditLogPage — the admin audit viewer (2026-11-20, ported from the
 * enterprise UX chain's Admin Audit Log page on PR #161).
 * ------------------------------------------------------------------
 * Admin-only (route gated to ADMIN/SUPERADMIN, endpoint gated on the
 * canonical `audit.view` grant): who did what, when, to whom — actor
 * and target names + Employee IDs come from the enriched /audit-logs
 * endpoint, times render in Asia/Dhaka. Search filters client-side
 * across actor, action, record and details; Refresh re-reads the
 * latest 200 events. Read-only: nothing here writes or deletes.
 *
 * Adapted to the current enterprise design: EnterprisePageHeader
 * (heading derives from the sidebar label + description), .ep-page /
 * .ep-card shell, .ep-btn actions. The table itself keeps the
 * source's columns (Date & time, Action, Actor, Target, Record,
 * Details) — the data shape is unchanged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { apiRequest } from '../../shared/api/http';
import { cn } from '../../../lib/utils';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';

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
    <div className="ep-page">
      <EnterprisePageHeader
        path="/audit-log"
        actions={(
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ep-btn"
            aria-label="Refresh audit events"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </button>
        )}
      />

      <section className="ep-card">
        <div className="ep-cardhead">
          <div>
            <h2 className="ep-cardtitle">Activity history</h2>
            <p className="ep-muted">Latest events returned by the secured audit service.</p>
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
                      <th className="px-4 py-3">Date &amp; time</th>
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
