/**
 * leadColumnSort.ts — per-column sort + filter for the desktop lead
 * table (2026-11-23, Mahadi: a user asked for Filter By / Sort By
 * on the table columns).
 * ------------------------------------------------------------------
 * Pure helpers, kept free of React/fetch so the node test suite can
 * pin them directly. The page (LeadList.tsx) owns the state; this
 * module owns the rules:
 *
 * SORT — every column sorts on header click, three-click cycle:
 *   click 1 = the column's natural order, click 2 = reverse,
 *   click 3 = clear back to the SORT BY preset. Natural order is
 *   A→Z for the text columns (Lead, Source, Owner, Stage),
 *   highest-priority-first for Priority, newest-first for Created.
 *   Missing values sort LAST in both directions, never crash.
 *
 *   NOTE on Priority: the existing 'Priority Status' SORT BY preset
 *   sorts by pipeline STATUS order (getLeadStatusOrder), not by the
 *   Priority field — so the Priority column does NOT reuse it. It
 *   sorts the values actually shown in the column (High > Medium >
 *   Normal > Low; unknown values after the known four, then
 *   alphabetically; blank last).
 *
 * FILTER — only where no quick filter exists yet (one feature, one
 * place): Source + Owner are multi-select; Created is a preset
 * (All / Today / Last 7 days / Last 30 days) on Dhaka day
 * boundaries via the existing dhakaDayStartMs helper. Priority is
 * sort-only (the PRIORITY dropdown filters it), Stage is sort-only
 * (the status chips filter it), Lead is sort-only (the search box
 * filters it), Action has neither.
 *
 * Distinct filter values come from the currently visible set (after
 * every existing filter, BEFORE the column filters) so the options
 * stay relevant; column filters combine (AND) with all of them.
 */

import type { Lead } from '../../shared/types';
import { dhakaDayStartMs } from '../../workspace/utils/enterpriseData';

/** The six sortable columns of the desktop lead table. */
export type ColumnSortKey = 'lead' | 'source' | 'owner' | 'priority' | 'stage' | 'created';

export type ColumnSortDir = 'asc' | 'desc';

export interface ColumnSort {
  key: ColumnSortKey;
  dir: ColumnSortDir;
}

/** Created presets — 'all' means no created filter. */
export type CreatedPreset = 'all' | 'today' | '7d' | '30d';

export const CREATED_PRESET_LABELS: Record<Exclude<CreatedPreset, 'all'>, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** The three column filters, as held in LeadList state. */
export interface ColumnFilters {
  /** Selected sources (empty = all). Matched against lead.source. */
  sources: string[];
  /** Selected owner display names (empty = all). */
  owners: string[];
  created: CreatedPreset;
}

export const EMPTY_COLUMN_FILTERS: ColumnFilters = { sources: [], owners: [], created: 'all' };

/** The value of the dynamic SORT BY option while a column sort is active. */
export const COLUMN_SORT_SELECT_VALUE = '__column__';

/** Display names for the sortable columns. */
export const COLUMN_SORT_LABELS: Record<ColumnSortKey, string> = {
  lead: 'Lead',
  source: 'Source',
  owner: 'Owner',
  priority: 'Priority',
  stage: 'Stage',
  created: 'Created',
};

/**
 * First-click direction per column: A→Z for the text columns,
 * highest-priority-first for Priority (rank ascending), and
 * newest-first for Created (date descending).
 */
const FIRST_DIR: Record<ColumnSortKey, ColumnSortDir> = {
  lead: 'asc',
  source: 'asc',
  owner: 'asc',
  priority: 'asc',
  stage: 'asc',
  created: 'desc',
};

/**
 * The three-click cycle: a fresh column starts at its natural
 * order, the second click reverses it, the third clears back to
 * the SORT BY preset (null). Clicking a different column starts
 * that column at its natural order.
 */
export function nextColumnSort(current: ColumnSort | null, key: ColumnSortKey): ColumnSort | null {
  if (!current || current.key !== key) return { key, dir: FIRST_DIR[key] };
  if (current.dir === FIRST_DIR[key]) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return null;
}

/** The SORT BY dropdown's dynamic leading option while a column sort is active. */
export function columnSortLabel(sort: ColumnSort): string {
  if (sort.key === 'created') return sort.dir === 'desc' ? 'Created (Newest first)' : 'Created (Oldest first)';
  if (sort.key === 'priority') return sort.dir === 'asc' ? 'Priority (High first)' : 'Priority (Low first)';
  return `${COLUMN_SORT_LABELS[sort.key]} (${sort.dir === 'asc' ? 'A–Z' : 'Z–A'})`;
}

/** Priority is configurable metadata — rank the known values, unknown after them. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, normal: 2, low: 3 };

/** Rank of a priority value: null when blank (sorts last), 4 for unknown values. */
function priorityRank(priority: string | undefined): number | null {
  const p = (priority || '').trim().toLowerCase();
  if (!p) return null;
  const rank = PRIORITY_RANK[p];
  return rank === undefined ? 4 : rank;
}

/** Creation instant of a lead (creationDate, falling back to timestamp); null when unparseable. */
function createdMs(lead: Lead): number | null {
  for (const raw of [lead.creationDate, lead.timestamp]) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * Text comparison with missing-last in BOTH directions: the
 * missing check is never multiplied by the direction, so a blank
 * value never floats to the top on a descending sort.
 */
function compareText(a: string | undefined, b: string | undefined, dir: 1 | -1): number {
  const x = (a || '').trim();
  const y = (b || '').trim();
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return dir * x.localeCompare(y);
}

function comparePriority(a: string | undefined, b: string | undefined, dir: 1 | -1): number {
  const ra = priorityRank(a);
  const rb = priorityRank(b);
  if (ra === null && rb === null) return 0;
  if (ra === null) return 1;
  if (rb === null) return -1;
  if (ra !== rb) return dir * (ra - rb);
  // Same rank (two unknown values): alphabetical, direction-aware.
  return dir * (a || '').trim().localeCompare((b || '').trim());
}

function compareCreated(a: Lead, b: Lead, dir: 1 | -1): number {
  const ma = createdMs(a);
  const mb = createdMs(b);
  if (ma === null && mb === null) return 0;
  if (ma === null) return 1;
  if (mb === null) return -1;
  return dir * (ma - mb);
}

/**
 * Compare two leads under a column sort. `resolveOwner` is the
 * page's owner-name resolver (roster lookup with the employee ID
 * fallback) — the util never sees the roster itself.
 */
export function compareLeadsByColumn(
  a: Lead,
  b: Lead,
  sort: ColumnSort,
  resolveOwner: (lead: Lead) => string,
): number {
  const dir: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
  switch (sort.key) {
    case 'lead':
      return compareText(a.prospectName, b.prospectName, dir);
    case 'source':
      return compareText(a.source, b.source, dir);
    case 'owner':
      return compareText(resolveOwner(a), resolveOwner(b), dir);
    case 'priority':
      return comparePriority(a.priority, b.priority, dir);
    case 'stage':
      return compareText(a.currentStatus, b.currentStatus, dir);
    case 'created':
      return compareCreated(a, b, dir);
  }
}

/** A new array sorted by the column sort (the input is untouched; Array.sort is stable). */
export function sortLeadsByColumn(
  leads: Lead[],
  sort: ColumnSort,
  resolveOwner: (lead: Lead) => string,
): Lead[] {
  return [...leads].sort((a, b) => compareLeadsByColumn(a, b, sort, resolveOwner));
}

/**
 * Does a lead fall inside a Created preset? Dhaka day boundaries:
 * 'today' is from the start of today's Dhaka day, '7d' / '30d'
 * cover today plus the previous 6 / 29 Dhaka days. A lead with no
 * parseable creation date never matches a preset.
 */
export function matchesCreatedPreset(lead: Lead, preset: CreatedPreset, now: Date = new Date()): boolean {
  if (preset === 'all') return true;
  const ms = createdMs(lead);
  if (ms === null) return false;
  const todayStart = dhakaDayStartMs(now);
  if (preset === 'today') return ms >= todayStart;
  const days = preset === '7d' ? 7 : 30;
  return ms >= todayStart - (days - 1) * 24 * 3600 * 1000;
}

/**
 * Apply the column filters (AND): a lead must match every active
 * filter. An empty multi-select / 'all' preset means "no filter
 * on this column". With no column filter active the input array is
 * returned as-is.
 */
export function applyColumnFilters(
  leads: Lead[],
  filters: ColumnFilters,
  resolveOwner: (lead: Lead) => string,
  now: Date = new Date(),
): Lead[] {
  if (filters.sources.length === 0 && filters.owners.length === 0 && filters.created === 'all') {
    return leads;
  }
  const sourceSet = new Set(filters.sources);
  const ownerSet = new Set(filters.owners);
  return leads.filter(lead => {
    if (sourceSet.size > 0 && !sourceSet.has((lead.source || '').trim())) return false;
    if (ownerSet.size > 0 && !ownerSet.has(resolveOwner(lead))) return false;
    if (filters.created !== 'all' && !matchesCreatedPreset(lead, filters.created, now)) return false;
    return true;
  });
}

/** One distinct filter value with its count in the visible set. */
export interface DistinctColumnValue {
  value: string;
  count: number;
}

/**
 * Distinct values of a column over a lead set, with counts,
 * alphabetically ordered. Blank values are excluded (a filter
 * option for "no value" would be noise — a blank lead simply
 * matches no selected value once any filter is active).
 */
export function distinctColumnValues(
  leads: Lead[],
  keyFn: (lead: Lead) => string,
): DistinctColumnValue[] {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const value = (keyFn(lead) || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Toggle one value in a multi-select filter array (pure — the input is untouched). */
export function toggleFilterValue(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter(v => v !== value) : [...current, value];
}

/** True when any column filter is active (drives the chips row + the Clear-all control). */
export function hasActiveColumnFilters(filters: ColumnFilters): boolean {
  return filters.sources.length > 0 || filters.owners.length > 0 || filters.created !== 'all';
}
