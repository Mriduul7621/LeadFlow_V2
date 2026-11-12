import type { TeamOverviewPerson, TeamOverviewResponse } from '../services/teamOverviewService';
import { getSelfPerson } from '../services/teamOverviewService';

/**
 * kpiDrilldown.ts — pure helpers for the TL+ KPI drill-down
 * (owner-approved 2026-11-13)
 * ------------------------------------------------------------------
 * The team home's seven KPI cards drill down the reporting tree. Every
 * level is computed CLIENT-side from the ONE scoped overview payload
 * (GET /api/team/overview via teamOverviewService) — no parallel
 * queries, no new server shape for the people levels. Only the leaf
 * lead list comes from the server (GET /team/kpi/leads), and only the
 * export (GET /team/kpi/export) builds a file.
 *
 * Never-empty rule (owner, 2026-11-13): NO level here ever filters
 * out zero-count people — sortKpiRows sorts, it never drops a row,
 * so an all-zero KPI still lists every in-scope person with 0s.
 *
 * Level rules (resolveKpiLevel):
 *   - `person=self` (or a member with no reports and no person) ->
 *     the LEAF view: the caller's own leads for the KPI. This is how
 *     a leaf member sees their own data, and how the My Day strip
 *     always lands on own leads even for a team holder.
 *   - a person with reports -> the PEOPLE view: their direct reports
 *     with their KPI numbers, each name drilling one level deeper.
 *   - a person without reports -> the LEAF view: their leads.
 *   - a person param outside the payload (not in the caller's visible
 *     set) -> not-found. The server enforces the same rule, so a
 *     hand-crafted URL cannot widen the scope.
 */

export const KPI_KEYS = ['open', 'dueToday', 'overdue', 'converted', 'totalLeads', 'todayCollection', 'noAction'] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export const KPI_META: Record<KpiKey, { label: string; shortLabel: string }> = {
  open: { label: 'Open leads', shortLabel: 'Open' },
  dueToday: { label: 'Due today', shortLabel: 'Due today' },
  overdue: { label: 'Overdue', shortLabel: 'Overdue' },
  converted: { label: 'Converted', shortLabel: 'Converted' },
  totalLeads: { label: 'Total Lead', shortLabel: 'Total lead' },
  todayCollection: { label: 'Today Lead Collection', shortLabel: 'Today collection' },
  noAction: { label: 'No Action Alert', shortLabel: 'No action' },
};

/** `person=self` = the caller's own leads, even if they have reports. */
export const SELF_PERSON_PARAM = 'self';

export function isKpiKey(value: string | null | undefined): value is KpiKey {
  return (KPI_KEYS as readonly string[]).includes(value as string);
}

/** One person's KPI number, straight from their overview row. */
export function kpiValueFor(person: TeamOverviewPerson, kpi: KpiKey): number {
  switch (kpi) {
    case 'open': return person.openLeads;
    case 'dueToday': return person.dueToday;
    case 'overdue': return person.overdue;
    case 'converted': return person.convertedLeads;
    case 'totalLeads': return person.totalLeads;
    case 'todayCollection': return person.todayLeads;
    case 'noAction': return person.noActionLeads;
  }
}

function sameEmployee(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && String(a).toUpperCase() === String(b).toUpperCase());
}

/** Find a person in the payload by employee ID (case-insensitive). */
export function findPersonByEmployeeId(
  people: TeamOverviewPerson[],
  employeeId: string
): TeamOverviewPerson | undefined {
  return people.find(p => sameEmployee(p.employeeId, employeeId));
}

/** Direct reports of one person, from the payload's manager links. */
export function directReportsOf(
  people: TeamOverviewPerson[],
  employeeId: string
): TeamOverviewPerson[] {
  return people.filter(p => sameEmployee(p.managerEmployeeId, employeeId));
}

/**
 * Drill-down rows, worst first: highest KPI value, then name. The
 * export endpoint sorts the same way (server/routes/production/
 * users.routes.ts, /team/kpi/export) so the file matches the page.
 */
export function sortKpiRows(rows: TeamOverviewPerson[], kpi: KpiKey): TeamOverviewPerson[] {
  return [...rows].sort((a, b) => kpiValueFor(b, kpi) - kpiValueFor(a, kpi) || a.name.localeCompare(b.name));
}

/**
 * Breadcrumb chain from the caller (first) down to `fromEmployeeId`
 * (last, inclusive): walk up the manager links, cycle-safe, stopping
 * at the caller, at a root (manager outside the payload), or on a
 * repeated employee ID. Returns [] when the start person is absent.
 */
export function breadcrumbChain(
  people: TeamOverviewPerson[],
  fromEmployeeId: string,
  callerEmployeeId: string
): TeamOverviewPerson[] {
  const byEmployee = new Map(people.map(p => [p.employeeId.toUpperCase(), p]));
  const chain: TeamOverviewPerson[] = [];
  const seen = new Set<string>();
  let current = byEmployee.get(fromEmployeeId.toUpperCase());
  while (current && !seen.has(current.employeeId.toUpperCase())) {
    seen.add(current.employeeId.toUpperCase());
    chain.unshift(current);
    if (sameEmployee(current.employeeId, callerEmployeeId)) break;
    const managerId = current.managerEmployeeId;
    current = managerId ? byEmployee.get(managerId.toUpperCase()) : undefined;
  }
  return chain;
}

export type KpiLevel =
  | { kind: 'invalid-kpi' }
  | { kind: 'not-found' }
  | {
      kind: 'people';
      current: TeamOverviewPerson;
      rows: TeamOverviewPerson[];
      chain: TeamOverviewPerson[];
    }
  | {
      kind: 'leads';
      current: TeamOverviewPerson;
      chain: TeamOverviewPerson[];
    };

/**
 * Resolve which level the drill-down page shows, from the overview
 * payload + the URL's kpi/person params. Pure — the page renders
 * from the result, and the server resolves the same level for the
 * leaf list and the export.
 */
export function resolveKpiLevel(
  overview: TeamOverviewResponse | null | undefined,
  kpiParam: string | null | undefined,
  personParam: string | null | undefined
): KpiLevel {
  if (!isKpiKey(kpiParam)) return { kind: 'invalid-kpi' };
  const kpi = kpiParam as KpiKey;
  const people = overview?.people ?? [];
  const self = getSelfPerson(people);
  if (!self) return { kind: 'not-found' };

  if (!personParam || personParam.toLowerCase() === SELF_PERSON_PARAM) {
    // No person: the caller's own level — their reports when they
    // have any, otherwise their own leads (the member self-view).
    // `person=self`: the caller's own leads, even with reports.
    const forceLeaf = Boolean(personParam) && personParam.toLowerCase() === SELF_PERSON_PARAM;
    if (forceLeaf || self.directReports === 0) {
      return { kind: 'leads', current: self, chain: [self] };
    }
    return {
      kind: 'people',
      current: self,
      rows: sortKpiRows(directReportsOf(people, self.employeeId), kpi),
      chain: [self],
    };
  }

  const person = findPersonByEmployeeId(people, personParam);
  if (!person) return { kind: 'not-found' };
  const chain = breadcrumbChain(people, person.employeeId, self.employeeId);
  if (person.directReports === 0) {
    return { kind: 'leads', current: person, chain };
  }
  return {
    kind: 'people',
    current: person,
    rows: sortKpiRows(directReportsOf(people, person.employeeId), kpi),
    chain,
  };
}

/** Drill-down URL for a KPI, optionally at one person's level. */
export function kpiDrilldownUrl(kpi: KpiKey, personEmployeeId?: string): string {
  const base = `/team/kpi/${kpi}`;
  return personEmployeeId ? `${base}?person=${encodeURIComponent(personEmployeeId)}` : base;
}

/** Export URL for the level currently viewed (same params as the page). */
export function kpiExportUrl(kpi: KpiKey, personParam?: string | null): string {
  const base = `/api/team/kpi/export?kpi=${encodeURIComponent(kpi)}`;
  return personParam ? `${base}&person=${encodeURIComponent(personParam)}` : base;
}

/** Leaf-leads URL for one person (the server resolves `self` too). */
export function kpiLeadsUrl(kpi: KpiKey, personEmployeeId: string): string {
  return `/api/team/kpi/leads?kpi=${encodeURIComponent(kpi)}&person=${encodeURIComponent(personEmployeeId)}`;
}
