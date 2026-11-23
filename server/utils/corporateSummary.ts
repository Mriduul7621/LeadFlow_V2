import {
  dhakaStartUtc,
  getDhakaBusinessDayBounds,
} from './businessTime.js';

/**
 * corporateSummary.ts — pure Corporate Group Leads aggregation
 * (Mahadi, 2026-11-24).
 * ------------------------------------------------------------------
 * The Corporate Group Lead page reports on leads that carry a
 * corporate client code (migration 065). The two date bases are
 * deliberately different, and the page labels them:
 *   - Total Leads counts by CREATED date (when the lead entered).
 *   - Conversion Ratio and Total Premium count by CONVERSION date
 *     (when the sale closed) — a lead created in October and
 *     converted in November is November premium, not October's.
 *
 * Conversion date per lead, best evidence first:
 *   1. `converted_at` — stamped by the follow-up endpoint when a
 *      lead enters a won terminal status (since 065).
 *   2. The FIRST status_history entry whose status is a won
 *      terminal status — covers leads converted before 065.
 *   3. `updated_at` (the mapped `timestamp`) — last resort.
 *   4. `created_at` — final fallback, so a converted lead is never
 *      silently dropped from premium entirely.
 *
 * Periods are Asia/Dhaka calendar ranges [start, end), following
 * the dashboard's parseDashboardPeriod pattern. "Last 3 months"
 * is the current calendar month plus the two before it.
 *
 * Pure: no DB, no I/O. The endpoint fetches the caller's scoped
 * corporate leads (DB or demo store) and runs this one function,
 * so both modes share exactly the same maths.
 */

export type CorporatePeriodKey = 'THIS_MONTH' | 'LAST_MONTH' | 'LAST_3_MONTHS' | 'THIS_YEAR';

export const CORPORATE_PERIODS: Array<{ key: CorporatePeriodKey; label: string }> = [
  { key: 'THIS_MONTH', label: 'This month' },
  { key: 'LAST_MONTH', label: 'Last month' },
  { key: 'LAST_3_MONTHS', label: 'Last 3 months' },
  { key: 'THIS_YEAR', label: 'This year' },
];

export const DEFAULT_CORPORATE_PERIOD: CorporatePeriodKey = 'THIS_MONTH';

export interface CorporatePeriod {
  key: CorporatePeriodKey;
  label: string;
  start: Date;
  end: Date;
}

export function parseCorporatePeriod(query: any, now: Date = new Date()): CorporatePeriod {
  const raw = String(query?.period || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const key: CorporatePeriodKey =
    raw === 'LAST_MONTH' || raw === 'LAST_3_MONTHS' || raw === 'THIS_YEAR' ? (raw as CorporatePeriodKey) : 'THIS_MONTH';
  const bounds = getDhakaBusinessDayBounds(now);
  const [y, m] = bounds.todayDate.split('-').map(Number);
  const label = CORPORATE_PERIODS.find(p => p.key === key)!.label;
  if (key === 'LAST_MONTH') {
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    return { key, label, start: dhakaStartUtc(prev.y, prev.m, 1), end: dhakaStartUtc(y, m, 1) };
  }
  if (key === 'LAST_3_MONTHS') {
    // Current month + the two before it.
    let sy = y;
    let sm = m - 2;
    while (sm < 1) { sm += 12; sy -= 1; }
    const nextMonth = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    return { key, label, start: dhakaStartUtc(sy, sm, 1), end: dhakaStartUtc(nextMonth.y, nextMonth.m, 1) };
  }
  if (key === 'THIS_YEAR') {
    return { key, label, start: dhakaStartUtc(y, 1, 1), end: dhakaStartUtc(y + 1, 1, 1) };
  }
  const nextMonth = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { key, label, start: dhakaStartUtc(y, m, 1), end: dhakaStartUtc(nextMonth.y, nextMonth.m, 1) };
}

/** The mapped-lead shape the aggregator reads (DB mapLeadRow or demo store). */
export interface CorporateSummaryLead {
  id?: string;
  customerName?: string;
  corporateClientCode?: string | null;
  corporateClientName?: string | null;
  currentStatus?: string | null;
  creationDate?: string | Date | null;
  created_at?: string | Date | null;
  convertedAt?: string | Date | null;
  converted_at?: string | Date | null;
  timestamp?: string | Date | null;
  updated_at?: string | Date | null;
  statusHistory?: Array<{ status?: string; date?: string | Date | null }>;
  status_history?: Array<{ status?: string; date?: string | Date | null }>;
  assignedTo?: string | null;
  assignedToEmployeeId?: string | null;
  policyNo?: string | null;
  productName?: string | null;
  payMode?: string | null;
  sumAssured?: number | string | null;
  collectedNCP?: number | string | null;
  customFields?: Record<string, any>;
  custom_fields?: Record<string, any>;
}

export interface CorporateCompanyRow {
  code: string;
  name: string;
  leads: number;
  converted: number;
  conversionRatio: number;
  premium: number;
}

export interface CorporateAgentRow {
  employeeId: string;
  name: string;
  companies: number;
  leads: number;
  converted: number;
}

export interface CorporatePolicyRow {
  policyNo: string;
  clientName: string;
  product: string;
  payMode: string;
  sumAssured: number | null;
  premium: number;
  convertedAt: string | null;
  companyCode: string;
  companyName: string;
}

export interface CorporateSummary {
  period: { key: CorporatePeriodKey; label: string; start: string; end: string };
  kpis: { totalLeads: number; converted: number; conversionRatio: number; totalPremium: number };
  byCompany: CorporateCompanyRow[];
  byAgent: CorporateAgentRow[];
  policies: CorporatePolicyRow[];
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function numOr0(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function inRange(d: Date | null, start: Date, end: Date): boolean {
  return d !== null && d.getTime() >= start.getTime() && d.getTime() < end.getTime();
}

function normalizeStatusKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function createdDateOf(lead: CorporateSummaryLead): Date | null {
  return toDate(lead.creationDate ?? lead.created_at ?? lead.timestamp ?? lead.updated_at);
}

/**
 * The conversion date of a lead, best evidence first (see the
 * header). Null only when the lead carries no date at all.
 */
export function corporateConversionDateOf(lead: CorporateSummaryLead, wonNames: string[]): Date | null {
  const stamped = toDate(lead.convertedAt ?? lead.converted_at);
  if (stamped) return stamped;
  const wonKeys = new Set(wonNames.map(normalizeStatusKey));
  const history = lead.statusHistory ?? lead.status_history ?? [];
  let first: Date | null = null;
  for (const entry of history) {
    if (!wonKeys.has(normalizeStatusKey(entry?.status))) continue;
    const d = toDate(entry?.date);
    if (d && (!first || d.getTime() < first.getTime())) first = d;
  }
  if (first) return first;
  return toDate(lead.timestamp ?? lead.updated_at) ?? createdDateOf(lead);
}

function isWon(lead: CorporateSummaryLead, wonNames: string[]): boolean {
  return new Set(wonNames.map(normalizeStatusKey)).has(normalizeStatusKey(lead.currentStatus));
}

/**
 * Aggregate the caller's scoped corporate leads for one period.
 * `agentNames` maps employee id -> display name for the per-agent
 * table (the endpoint resolves it from the users table; unknown
 * ids render as the id itself).
 */
export function computeCorporateSummary(
  leads: CorporateSummaryLead[],
  period: CorporatePeriod,
  wonNames: string[],
  agentNames: Map<string, string> = new Map(),
): CorporateSummary {
  const { start, end } = period;
  const corp = leads.filter(l => String(l.corporateClientCode || '').trim() !== '');

  let totalLeads = 0;
  let converted = 0;
  let totalPremium = 0;
  const companyMap = new Map<string, { name: string; leads: number; converted: number; premium: number }>();
  const agentMap = new Map<string, { codes: Set<string>; leads: number; converted: number }>();
  const policies: CorporatePolicyRow[] = [];

  const companyRow = (code: string, name: string) => {
    let row = companyMap.get(code);
    if (!row) {
      row = { name, leads: 0, converted: 0, premium: 0 };
      companyMap.set(code, row);
    }
    if (!row.name && name) row.name = name;
    return row;
  };
  const agentRow = (employeeId: string) => {
    let row = agentMap.get(employeeId);
    if (!row) {
      row = { codes: new Set<string>(), leads: 0, converted: 0 };
      agentMap.set(employeeId, row);
    }
    return row;
  };

  for (const lead of corp) {
    const code = String(lead.corporateClientCode || '').trim();
    const name = String(lead.corporateClientName || '').trim();
    const created = createdDateOf(lead);
    const createdInPeriod = inRange(created, start, end);
    const won = isWon(lead, wonNames);
    const convDate = won ? corporateConversionDateOf(lead, wonNames) : null;
    const convertedInPeriod = won && inRange(convDate, start, end);
    const premium = numOr0(lead.collectedNCP ?? lead.customFields?.collectedNCP ?? lead.custom_fields?.collectedNCP);

    if (createdInPeriod) {
      totalLeads += 1;
      companyRow(code, name).leads += 1;
      const a = agentRow(String(lead.assignedTo ?? lead.assignedToEmployeeId ?? '').trim());
      a.leads += 1;
      a.codes.add(code);
    }
    if (convertedInPeriod) {
      converted += 1;
      totalPremium += premium;
      const c = companyRow(code, name);
      c.converted += 1;
      c.premium += premium;
      agentRow(String(lead.assignedTo ?? lead.assignedToEmployeeId ?? '').trim()).converted += 1;
      policies.push({
        policyNo: String(lead.policyNo ?? lead.customFields?.policyNo ?? lead.custom_fields?.policyNo ?? ''),
        clientName: String(lead.customerName || ''),
        product: String(lead.productName ?? lead.customFields?.productName ?? lead.custom_fields?.productName ?? ''),
        payMode: String(lead.payMode ?? lead.customFields?.payMode ?? lead.custom_fields?.payMode ?? ''),
        sumAssured: numOrNull(lead.sumAssured ?? lead.customFields?.sumAssured ?? lead.custom_fields?.sumAssured),
        premium,
        convertedAt: convDate ? convDate.toISOString() : null,
        companyCode: code,
        companyName: name,
      });
    }
  }

  const byCompany: CorporateCompanyRow[] = [...companyMap.entries()]
    .filter(([, r]) => r.leads > 0 || r.converted > 0)
    .map(([code, r]) => ({
      code,
      name: r.name,
      leads: r.leads,
      converted: r.converted,
      conversionRatio: r.leads > 0 ? r.converted / r.leads : 0,
      premium: r.premium,
    }))
    .sort((a, b) => b.premium - a.premium || b.leads - a.leads || a.name.localeCompare(b.name));

  const byAgent: CorporateAgentRow[] = [...agentMap.entries()]
    .filter(([, r]) => r.leads > 0 || r.converted > 0)
    .map(([employeeId, r]) => ({
      employeeId,
      name: employeeId ? (agentNames.get(employeeId) || employeeId) : 'Unassigned',
      companies: r.codes.size,
      leads: r.leads,
      converted: r.converted,
    }))
    .sort((a, b) => b.leads - a.leads || b.converted - a.converted || a.name.localeCompare(b.name));

  policies.sort((a, b) => String(b.convertedAt || '').localeCompare(String(a.convertedAt || '')));

  return {
    period: { key: period.key, label: period.label, start: start.toISOString(), end: end.toISOString() },
    kpis: {
      totalLeads,
      converted,
      conversionRatio: totalLeads > 0 ? converted / totalLeads : 0,
      totalPremium,
    },
    byCompany,
    byAgent,
    policies,
  };
}
