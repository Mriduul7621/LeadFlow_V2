import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import { leadService, type CorporateSummaryData } from '../services/leadService';
import type { Lead } from '../../shared/types';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import {
  columnSortLabel,
  nextColumnSort,
  sortLeadsByColumn,
  type ColumnSort,
  type ColumnSortKey,
} from '../utils/leadColumnSort';
import { formatDhakaShort } from '../../workspace/utils/enterpriseData';

/**
 * CorporateGroupLead — the Corporate Group Lead page (migration 065,
 * Mahadi 2026-11-24).
 * ------------------------------------------------------------------
 * Shanta Life's group-insurance companies: the field force sells
 * individual policies to their employees, and this page tracks it
 * per company. Top to bottom: timeframe selector, KPI cards (Total
 * Leads, Conversion Ratio, Total Premium), per-company summary,
 * per-agent coverage, and the corporate lead list (same columns as
 * All Leads + a Company column). Clicking Total Premium opens the
 * converted-policies popup.
 *
 * The timeframe drives the KPIs AND the lists. The two date bases
 * differ by design and the cards label them: Total Leads counts by
 * CREATED date, Conversion Ratio and Total Premium by CONVERSION
 * date (see server/utils/corporateSummary.ts).
 *
 * Visibility follows the caller's lead scope server-side — an agent
 * sees only their own corporate leads. The page itself never widens
 * scope; the company filter only narrows the list.
 */

const PERIODS: Array<{ key: string; label: string }> = [
  { key: 'THIS_MONTH', label: 'This month' },
  { key: 'LAST_MONTH', label: 'Last month' },
  { key: 'LAST_3_MONTHS', label: 'Last 3 months' },
  { key: 'THIS_YEAR', label: 'This year' },
];

function fmtMoney(n: number): string {
  return `৳${Math.round(n).toLocaleString('en-US')}`;
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function leadCreatedMs(lead: Lead): number | null {
  for (const raw of [lead.creationDate, lead.timestamp]) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

export default function CorporateGroupLead() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState('THIS_MONTH');
  const [summary, setSummary] = useState<CorporateSummaryData | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [companyCode, setCompanyCode] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [columnSort, setColumnSort] = useState<ColumnSort | null>(null);
  const [showPolicies, setShowPolicies] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [summaryData, leadRows] = await Promise.all([
        leadService.getCorporateSummary(period),
        leadService.getCorporateLeads(companyCode || undefined),
      ]);
      setSummary(summaryData);
      setLeads(leadRows);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load corporate leads.');
      toast.error(err?.message || 'Could not load corporate leads.');
    } finally {
      setLoading(false);
    }
  }, [period, companyCode]);

  useEffect(() => {
    load();
  }, [load]);

  // Agent display names come from the summary's per-agent table —
  // no second roster fetch; unknown ids render as the id itself.
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of summary?.byAgent || []) {
      if (row.employeeId) map.set(row.employeeId, row.name);
    }
    return map;
  }, [summary]);

  const resolveOwner = useCallback(
    (lead: Lead): string => {
      const id = String(lead.assignedTo || '').trim();
      if (!id) return 'Unassigned';
      return agentNames.get(id) || id;
    },
    [agentNames]
  );

  // The timeframe filters the list by CREATED date, using the
  // summary's own bounds — so the list and the Total Leads KPI
  // can never disagree about which leads are "in" the period.
  const visibleLeads = useMemo(() => {
    if (!summary) return [];
    const startMs = new Date(summary.period.start).getTime();
    const endMs = new Date(summary.period.end).getTime();
    const q = search.trim().toLowerCase();
    let rows = leads.filter(lead => {
      const ms = leadCreatedMs(lead);
      if (ms === null || ms < startMs || ms >= endMs) return false;
      if (!q) return true;
      return [lead.prospectName, lead.mobile, lead.corporateClientName, lead.corporateClientCode]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
    if (columnSort) rows = sortLeadsByColumn(rows, columnSort, resolveOwner);
    return rows;
  }, [leads, summary, search, columnSort, resolveOwner]);

  const companyFilterLabel = useMemo(() => {
    if (!companyCode) return null;
    const row = (summary?.byCompany || []).find(c => c.code.toLowerCase() === companyCode.toLowerCase());
    return row ? `${row.name || row.code} (${row.code})` : companyCode;
  }, [companyCode, summary]);

  const handleColumnSort = (key: ColumnSortKey) => setColumnSort(prev => nextColumnSort(prev, key));

  const sortArrow = (key: ColumnSortKey) =>
    columnSort?.key === key ? (columnSort.dir === 'asc' ? ' ↑' : ' ↓') : '';

  return (
    <div className="ep-page space-y-4">
      <EnterprisePageHeader path="/leads/corporate" />

      {/* Timeframe selector — drives the KPIs and the lists. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Timeframe">
        {PERIODS.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p.key)}
            className={
              period === p.key
                ? 'rounded-full bg-[#978C21] px-4 py-2 text-xs font-bold text-white cursor-pointer'
                : 'rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 cursor-pointer hover:border-[#978C21]'
            }
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && !summary ? (
        <div className="space-y-4" role="status" aria-label="Loading corporate leads">
          <div className="h-24 bg-stone-100 rounded-[12px] animate-pulse" />
          <div className="h-96 bg-stone-100 rounded-[12px] animate-pulse" />
        </div>
      ) : loadError && !summary ? (
        <div className="ep-card" style={{ textAlign: 'center' }}>
          <p className="text-sm text-slate-600">{loadError}</p>
          <button type="button" onClick={load} className="ep-btn ep-btn-primary mt-4">
            Try again
          </button>
        </div>
      ) : summary ? (
        <>
          {/* KPI cards — the date basis is on the card, not hidden. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="ep-card">
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Total Leads</p>
              <p className="mt-1 text-3xl font-black text-slate-900">{summary.kpis.totalLeads.toLocaleString('en-US')}</p>
              <p className="mt-1 text-xs text-slate-500">Created in {summary.period.label.toLowerCase()}</p>
            </div>
            <div className="ep-card">
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Conversion Ratio</p>
              <p className="mt-1 text-3xl font-black text-slate-900">{fmtPct(summary.kpis.conversionRatio)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {summary.kpis.converted.toLocaleString('en-US')} converted in {summary.period.label.toLowerCase()}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowPolicies(true)}
              className="ep-card text-left cursor-pointer hover:border-[#978C21] transition-colors"
              title="See the converted policies"
            >
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Total Premium</p>
              <p className="mt-1 text-3xl font-black text-slate-900">{fmtMoney(summary.kpis.totalPremium)}</p>
              <p className="mt-1 text-xs text-slate-500">
                Converted in {summary.period.label.toLowerCase()} — click to see policies
              </p>
            </button>
          </div>

          {/* Per-company summary — click a company to filter the list. */}
          <div className="ep-card ep-tablecard">
            <div className="p-6 border-b border-slate-50">
              <h2 className="text-base font-bold text-slate-900">By Company</h2>
              <p className="text-xs text-slate-500 mt-1">Click a company to filter the lead list below.</p>
            </div>
            {summary.byCompany.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">No corporate leads in this period yet.</p>
            ) : (
              <div className="ep-tablewrap overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th style={{ textAlign: 'right' }}>Leads</th>
                      <th style={{ textAlign: 'right' }}>Converted</th>
                      <th style={{ textAlign: 'right' }}>Conversion %</th>
                      <th style={{ textAlign: 'right' }}>Premium</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {summary.byCompany.map(row => (
                      <tr
                        key={row.code}
                        onClick={() => setCompanyCode(row.code)}
                        className={
                          companyCode === row.code
                            ? 'bg-[#F7F5E9] cursor-pointer'
                            : 'hover:bg-[#FBFAF8] cursor-pointer'
                        }
                      >
                        <td>
                          <span className="font-semibold text-slate-900">{row.name || row.code}</span>{' '}
                          <span className="font-mono text-xs text-slate-500">({row.code})</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>{row.leads.toLocaleString('en-US')}</td>
                        <td style={{ textAlign: 'right' }}>{row.converted.toLocaleString('en-US')}</td>
                        <td style={{ textAlign: 'right' }}>{fmtPct(row.conversionRatio)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(row.premium)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Per-agent coverage — who went to how many companies. */}
          <div className="ep-card ep-tablecard">
            <div className="p-6 border-b border-slate-50">
              <h2 className="text-base font-bold text-slate-900">By Agent</h2>
              <p className="text-xs text-slate-500 mt-1">Companies visited means distinct corporate clients with a lead created in the period.</p>
            </div>
            {summary.byAgent.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">No corporate leads in this period yet.</p>
            ) : (
              <div className="ep-tablewrap overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th style={{ textAlign: 'right' }}>Companies visited</th>
                      <th style={{ textAlign: 'right' }}>Leads</th>
                      <th style={{ textAlign: 'right' }}>Converted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {summary.byAgent.map(row => (
                      <tr key={row.employeeId || 'unassigned'} className="hover:bg-[#FBFAF8]">
                        <td>
                          <span className="font-semibold text-slate-900">{row.name}</span>
                          {row.employeeId && row.name !== row.employeeId && (
                            <span className="font-mono text-xs text-slate-500"> ({row.employeeId})</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{row.companies.toLocaleString('en-US')}</td>
                        <td style={{ textAlign: 'right' }}>{row.leads.toLocaleString('en-US')}</td>
                        <td style={{ textAlign: 'right' }}>{row.converted.toLocaleString('en-US')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Lead list — All Leads columns + Company; same row behaviour. */}
          <div className="ep-card ep-tablecard">
            <div className="lf-desktop-lead-controls p-6 border-b border-slate-50 flex flex-col md:flex-row md:items-center gap-6">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search name, phone or company…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="ep-search"
                  style={{ width: '100%', paddingLeft: 36 }}
                />
              </div>
              {columnSort && (
                <span className="text-xs font-semibold text-slate-500">
                  Sorted by {columnSortLabel(columnSort)}
                  <button
                    type="button"
                    onClick={() => setColumnSort(null)}
                    className="ml-2 underline underline-offset-2 cursor-pointer bg-transparent border-0 text-slate-500"
                  >
                    Clear
                  </button>
                </span>
              )}
            </div>
            {companyCode && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-4" role="region" aria-label="Active company filter">
                <button
                  type="button"
                  onClick={() => setCompanyCode(null)}
                  aria-label="Remove company filter"
                  className="inline-flex items-center gap-1 rounded-full border border-[#EAE7D6] bg-[#F7F5E9] px-2.5 py-1 text-[11px] font-semibold text-[#817719] cursor-pointer"
                >
                  Company: {companyFilterLabel} <span aria-hidden="true">×</span>
                </button>
              </div>
            )}

            <div className="lf-mobile-lead-list" aria-label="Corporate lead prospects">
              {visibleLeads.length === 0 ? (
                <p className="p-6 text-sm text-slate-500">No corporate leads match.</p>
              ) : (
                visibleLeads.map(lead => (
                  <div
                    key={lead.id}
                    className="lf-mobile-lead-row"
                    onClick={() => navigate(`/leads/${lead.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') navigate(`/leads/${lead.id}`);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-slate-900 truncate">{lead.prospectName || lead.customerName}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {lead.corporateClientName || lead.corporateClientCode}
                        {lead.corporateClientCode ? ` (${lead.corporateClientCode})` : ''}
                      </p>
                      <p className="text-xs text-slate-500">{lead.mobile}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${getLeadStatusColorClasses(lead.currentStatus)}`}
                    >
                      {lead.currentStatus}
                    </span>
                    <ChevronRight size={19} aria-hidden="true" className="shrink-0 text-slate-400" />
                  </div>
                ))
              )}
            </div>

            <div className="lf-desktop-lead-table ep-tablewrap">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th onClick={() => handleColumnSort('lead')} className="cursor-pointer select-none">
                      Lead{sortArrow('lead')}
                    </th>
                    <th onClick={() => handleColumnSort('company')} className="cursor-pointer select-none">
                      Company{sortArrow('company')}
                    </th>
                    <th onClick={() => handleColumnSort('source')} className="cursor-pointer select-none">
                      Source{sortArrow('source')}
                    </th>
                    <th onClick={() => handleColumnSort('owner')} className="cursor-pointer select-none">
                      Owner{sortArrow('owner')}
                    </th>
                    <th onClick={() => handleColumnSort('priority')} className="cursor-pointer select-none">
                      Priority{sortArrow('priority')}
                    </th>
                    <th onClick={() => handleColumnSort('stage')} className="cursor-pointer select-none">
                      Stage{sortArrow('stage')}
                    </th>
                    <th onClick={() => handleColumnSort('created')} className="cursor-pointer select-none">
                      Created{sortArrow('created')}
                    </th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleLeads.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-6 text-sm text-slate-500">
                        No corporate leads match.
                      </td>
                    </tr>
                  ) : (
                    visibleLeads.map(lead => (
                      <tr
                        key={lead.id}
                        className="group hover:bg-[#FBFAF8] transition-colors cursor-pointer"
                        onClick={() => navigate(`/leads/${lead.id}`)}
                      >
                        <td>
                          <span className="font-semibold text-slate-900">{lead.prospectName || lead.customerName}</span>
                          <span className="block text-xs text-slate-500">{lead.mobile}</span>
                        </td>
                        <td>
                          <span className="font-semibold text-slate-900">{lead.corporateClientName || '—'}</span>
                          <span className="block font-mono text-xs text-slate-500">{lead.corporateClientCode}</span>
                        </td>
                        <td>{lead.source}</td>
                        <td>{resolveOwner(lead)}</td>
                        <td>{lead.priority || '—'}</td>
                        <td>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${getLeadStatusColorClasses(lead.currentStatus)}`}
                          >
                            {lead.currentStatus}
                          </span>
                        </td>
                        <td>{lead.creationDate ? formatDhakaShort(lead.creationDate) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <ChevronRight size={19} aria-hidden="true" className="inline-block text-slate-400" />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {/* Total Premium popup — the converted policies behind the number. */}
      {showPolicies && summary && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Converted policies"
          onClick={() => setShowPolicies(false)}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-lg bg-white shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-6">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Converted policies — {summary.period.label}</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Total premium {fmtMoney(summary.kpis.totalPremium)} across {summary.policies.length} policies.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPolicies(false)}
                aria-label="Close"
                className="rounded-full p-1 text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>
            {summary.policies.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">No policies converted in this period yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      <th>Policy Number</th>
                      <th>Client Name</th>
                      <th>Product</th>
                      <th>Premium Mode</th>
                      <th style={{ textAlign: 'right' }}>Sum Assured</th>
                      <th style={{ textAlign: 'right' }}>New Premium</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {summary.policies.map((policy, i) => (
                      <tr key={`${policy.policyNo || 'no-policy'}-${i}`} className="hover:bg-[#FBFAF8]">
                        <td className="font-mono">{policy.policyNo || '—'}</td>
                        <td className="font-semibold text-slate-900">{policy.clientName}</td>
                        <td>{policy.product || '—'}</td>
                        <td>{policy.payMode || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {policy.sumAssured != null ? fmtMoney(policy.sumAssured) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(policy.premium)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
