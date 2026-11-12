import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FolderOpen,
  Home,
  RefreshCcw,
  Users,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useCallerTeam } from '../hooks/useCallerTeam';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { ApiError, apiRequest } from '../../shared/api/http';
import type { TeamOverviewPerson } from '../services/teamOverviewService';
import {
  KPI_META,
  isKpiKey,
  kpiDrilldownUrl,
  kpiExportUrl,
  kpiLeadsUrl,
  kpiValueFor,
  resolveKpiLevel,
  type KpiKey,
  type KpiLevel,
} from '../utils/kpiDrilldown';

/**
 * TeamKpiDrilldown — the TL+ KPI drill-down page (owner-approved
 * 2026-11-13)
 * ------------------------------------------------------------------
 * Route: /team/kpi/:kpi?person=<employeeId>
 *
 * A KPI card (team home, or the My Day strip) lands here. People
 * levels list the current person's direct reports with their KPI
 * numbers — each name drills one level deeper, down to team-member
 * level. A leaf level lists that person's actual leads for the KPI,
 * each linking to Lead360. A leaf member with no person param sees
 * their OWN leads directly (the member self-view); `person=self`
 * forces the caller's own leads even for a team holder.
 *
 * Levels come from the ONE scoped overview payload (client-side
 * resolveKpiLevel); only the leaf list is fetched
 * (GET /team/kpi/leads) and the export is built server-side
 * (GET /team/kpi/export, `leads.export`-gated). A person outside the
 * caller's visible set renders the not-found panel — and the server
 * answers 404 for the same URL, so the scope is enforced twice.
 *
 * Never-empty rule (owner, 2026-11-13): a people level NEVER hides
 * zero-count people — everyone in scope is listed with their 0s,
 * and when EVERYONE is 0 a short line says so above the list. A
 * leaf level with no matching leads still shows the person's header
 * (name + employee ID), the 0 count, and a clear message — the page
 * is never blank.
 */

export interface KpiLeadItem {
  id: string;
  leadCode: string | null;
  customerName: string;
  mobile: string;
  currentStatus: string;
  nextFollowUpAt: string | null;
  createdAt: string | null;
}

export interface KpiLeadsResponse {
  success: boolean;
  kpi: string;
  employeeId: string;
  total: number;
  items: KpiLeadItem[];
}

function dhakaDate(iso: string | null): string {
  if (!iso) return 'No next action set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No next action set';
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Entry date for a lead row ('' when unknown) — shown for the KPIs where entry age matters. */
function enteredDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

function NotFoundPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center space-y-3">
      <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto" />
      <p className="text-sm font-black text-stone-700">{title}</p>
      <p className="text-xs text-stone-400 max-w-md mx-auto">{body}</p>
      <div className="flex items-center justify-center gap-3 pt-2">
        <Link to="/" className="px-4 py-2 bg-[#3C3C3B] text-white rounded-full text-[11px] font-black uppercase tracking-widest">
          Team Home
        </Link>
        <Link to="/team" className="px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500">
          My Team
        </Link>
      </div>
    </div>
  );
}

function ExportButton({
  canExport,
  exporting,
  onExport,
}: {
  canExport: boolean;
  exporting: boolean;
  onExport: () => void;
}) {
  // Client-side visibility only — the server enforces `leads.export`
  // (403) on the endpoint itself.
  if (!canExport) return null;
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={exporting}
      className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500 hover:border-[#978C21]/50 disabled:opacity-50"
    >
      <Download className="w-3.5 h-3.5" />
      {exporting ? 'Exporting…' : 'Export'}
    </button>
  );
}

export function TeamKpiDrilldownContent({
  level,
  kpi,
  leads,
  leadsLoading,
  leadsError,
  leadsNotFound,
  canExport,
  exporting,
  exportError,
  onExport,
  onRetryLeads,
}: {
  level: KpiLevel;
  kpi: KpiKey | null;
  leads: KpiLeadsResponse | null;
  leadsLoading: boolean;
  leadsError: string | null;
  leadsNotFound: boolean;
  canExport: boolean;
  exporting: boolean;
  exportError: string | null;
  onExport: () => void;
  onRetryLeads: () => void;
}) {
  if (level.kind === 'invalid-kpi') {
    return (
      <NotFoundPanel
        title="Unknown KPI"
        body="This KPI does not exist. Total Lead, Today Lead Collection, Open, Due today, Overdue, No Action Alert and Converted are the seven team KPIs."
      />
    );
  }
  if (level.kind === 'not-found' || leadsNotFound) {
    return (
      <NotFoundPanel
        title="Person not found"
        body="This person is not in your visible team — they may not exist, or they may sit outside the part of the organisation you can see."
      />
    );
  }
  if (!kpi) {
    return <NotFoundPanel title="Unknown KPI" body="This KPI does not exist." />;
  }

  const meta = KPI_META[kpi];
  const current = level.current;
  const chain = level.chain;
  const isPeople = level.kind === 'people';
  const levelTotal = isPeople
    ? level.rows.reduce((sum, p) => sum + kpiValueFor(p, kpi), 0)
    : (leads?.total ?? 0);
  const heading = current.isSelf
    ? isPeople ? 'Your team' : 'Your leads'
    : isPeople ? `${current.name}'s team` : `${current.name}'s leads`;

  return (
    <div className="space-y-6 text-left">
      <nav className="flex flex-wrap items-center gap-1 text-[11px] font-bold text-stone-400" aria-label="Breadcrumb">
        <Link to="/" className="flex items-center gap-1 hover:text-stone-700">
          <Home className="w-3.5 h-3.5" /> Home
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link to={kpiDrilldownUrl(kpi)} className="hover:text-stone-700">{meta.label}</Link>
        {chain.map((person, index) => {
          const isLast = index === chain.length - 1;
          const label = person.isSelf ? (isPeople ? 'Your team' : 'Your leads') : person.name;
          return (
            <span key={person.userId} className="flex items-center gap-1">
              <ChevronRight className="w-3 h-3" />
              {isLast ? (
                <span className="text-stone-700">{label}</span>
              ) : (
                <Link
                  to={person.isSelf ? kpiDrilldownUrl(kpi) : kpiDrilldownUrl(kpi, person.employeeId)}
                  className="hover:text-stone-700"
                >
                  {label}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#978C21]/10 text-[#978C21] rounded-2xl flex items-center justify-center">
            {isPeople ? <Users className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-black text-stone-800 tracking-tight">
              {meta.label} · {heading}
            </h1>
            <p className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
              {isPeople
                ? `${level.rows.length} ${level.rows.length === 1 ? 'person' : 'people'} · ${levelTotal} total`
                : `${levelTotal} ${levelTotal === 1 ? 'lead' : 'leads'} · ${current.employeeId}`}
            </p>
          </div>
        </div>
        <ExportButton canExport={canExport} exporting={exporting} onExport={onExport} />
      </div>

      {exportError && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-5 py-3">
          <p className="text-sm font-bold text-red-600">{exportError}</p>
        </div>
      )}

      {isPeople ? (
        <section className="space-y-2">
          {level.rows.length === 0 ? (
            <div className="bg-white border border-stone-200/80 rounded-2xl p-6">
              <p className="text-sm font-bold text-stone-600">Nobody reports to {current.isSelf ? 'you' : current.name} right now.</p>
            </div>
          ) : (
            level.rows.map(person => (
              <Link
                key={person.userId}
                to={kpiDrilldownUrl(kpi, person.employeeId)}
                className="flex items-center justify-between gap-3 bg-white border border-stone-200/80 rounded-2xl px-4 py-3 hover:border-[#978C21]/50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-black text-stone-800 truncate">
                    {person.name}
                    {person.isSelf && (
                      <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
                    )}
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
                    {[person.employeeId, person.designation].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn(
                    'text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full',
                    kpiValueFor(person, kpi) > 0 ? 'bg-stone-100 text-stone-700' : 'bg-stone-50 text-stone-400'
                  )}>
                    {kpiValueFor(person, kpi)} {meta.shortLabel.toLowerCase()}
                  </span>
                  <ChevronRight className="w-4 h-4 text-stone-300" />
                </div>
              </Link>
            ))
          )}
          {level.rows.length > 0 && levelTotal === 0 && (
            <p className="text-[11px] font-bold text-stone-400 pt-1">
              No leads for this KPI yet — everyone is at 0.
            </p>
          )}
          <p className="text-[11px] font-bold text-stone-400 pt-1">
            Tap a name to see their team — down to team-member level, where the actual leads appear.
          </p>
        </section>
      ) : (
        <section className="space-y-2">
          {leadsLoading ? (
            <div className="space-y-2" role="status" aria-label="Loading leads">
              {[0, 1, 2].map(i => (
                <div key={i} className="h-16 bg-stone-100 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : leadsError ? (
            <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3">
              <p className="text-sm text-red-600 font-bold">{leadsError}</p>
              <button
                type="button"
                onClick={onRetryLeads}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
              >
                <RefreshCcw className="w-3.5 h-3.5" /> Try again
              </button>
            </div>
          ) : !leads || leads.items.length === 0 ? (
            <div className="bg-white border border-stone-200/80 rounded-2xl p-6">
              <p className="text-sm font-bold text-stone-600">
                No leads for this KPI — {current.isSelf ? 'you have' : `${current.name} has`} none right now.
              </p>
            </div>
          ) : (
            <>
              {leads.total > leads.items.length && (
                <p className="text-[11px] font-bold text-stone-400">
                  Showing {leads.items.length} of {leads.total} leads — the export carries the same {leads.items.length}.
                </p>
              )}
              {leads.items.map(lead => (
                <Link
                  key={lead.id}
                  to={`/leads/${lead.id}`}
                  className="flex items-center justify-between gap-3 bg-white border border-stone-200/80 rounded-2xl px-4 py-3 hover:border-[#978C21]/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-black text-stone-800 truncate">{lead.customerName}</p>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
                      {[lead.leadCode, lead.mobile].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-black uppercase tracking-widest bg-stone-100 text-stone-600 px-2 py-1 rounded-full">
                      {lead.currentStatus}
                    </span>
                    {(kpi === 'noAction' || kpi === 'todayCollection') && enteredDate(lead.createdAt) && (
                      <span className="text-[10px] font-bold text-stone-400 hidden sm:inline">
                        Entered {enteredDate(lead.createdAt)}
                      </span>
                    )}
                    <span className="text-[10px] font-bold text-stone-400 hidden sm:inline">
                      {dhakaDate(lead.nextFollowUpAt)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-stone-300" />
                  </div>
                </Link>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}

export default function TeamKpiDrilldown() {
  const { kpi: kpiParam } = useParams<{ kpi: string }>();
  const [searchParams] = useSearchParams();
  const personParam = searchParams.get('person');
  const { loading, error, overview, refresh } = useCallerTeam();
  const { canAccess } = usePermissions();
  // Same pattern as the Leads page (LeadList): the `leads.export`
  // grant governs the button; the server enforces it (403).
  const canExport = canAccess('lead_tracking', 'export');

  const kpiKey = isKpiKey(kpiParam) ? (kpiParam as KpiKey) : null;
  const level = resolveKpiLevel(overview, kpiParam, personParam);

  const [leads, setLeads] = useState<KpiLeadsResponse | null>(null);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [leadsNotFound, setLeadsNotFound] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const leafEmployeeId = level.kind === 'leads' ? level.current.employeeId : null;

  useEffect(() => {
    if (!kpiKey || !leafEmployeeId) {
      setLeads(null);
      setLeadsNotFound(false);
      setLeadsError(null);
      return;
    }
    let cancelled = false;
    setLeadsLoading(true);
    setLeadsError(null);
    setLeadsNotFound(false);
    apiRequest<KpiLeadsResponse>(kpiLeadsUrl(kpiKey, leafEmployeeId))
      .then(res => {
        if (!cancelled) setLeads(res);
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setLeadsNotFound(true);
        else setLeadsError(err?.message || 'Failed to load leads.');
      })
      .finally(() => {
        if (!cancelled) setLeadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kpiKey, leafEmployeeId, reloadTick]);

  const handleExport = async () => {
    if (!kpiKey || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      // Plain fetch: the global fetch patch (lib/apiClient) attaches
      // the session token, exactly as for every other /api call.
      const response = await fetch(kpiExportUrl(kpiKey, personParam));
      if (!response.ok) {
        let message = 'Export failed. Please try again.';
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch {
          // Non-JSON error body: keep the generic message.
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      anchor.download = match ? match[1] : `kpi-${kpiKey}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setExportError(err?.message || 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading KPI drill-down">
        <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
        <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
        <div className="h-28 bg-stone-100 rounded-[12px] animate-pulse" />
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3 text-left">
        <p className="text-sm text-red-600 font-bold">Failed to load your team.</p>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
        >
          <RefreshCcw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  return (
    <TeamKpiDrilldownContent
      level={level}
      kpi={kpiKey}
      leads={leads}
      leadsLoading={leadsLoading}
      leadsError={leadsError}
      leadsNotFound={leadsNotFound}
      canExport={canExport}
      exporting={exporting}
      exportError={exportError}
      onExport={() => void handleExport()}
      onRetryLeads={() => setReloadTick(t => t + 1)}
    />
  );
}
