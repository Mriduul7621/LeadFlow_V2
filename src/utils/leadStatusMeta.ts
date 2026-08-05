import { DEFAULT_LEAD_STATUSES, DropdownOption } from '../types';
import { metadataService } from '../services/metadataService';

/**
 * leadStatusMeta.ts
 * ------------------------------------------------------------------
 * Central place for lead-status color/order/won-lost logic. Lead
 * statuses are admin-configurable (Metadata Engine, type='lead_status'),
 * so this module fetches them once, caches in-memory, and exposes
 * synchronous lookups the UI can call inside render without awaiting -
 * falling back to the original hardcoded defaults until the real data
 * has loaded once, so existing pages never break during the transition.
 */

const DEFAULT_COLOR_MAP: Record<string, string> = {
  'Untouched': 'slate',
  'Contacted': 'blue',
  'No Response': 'amber',
  'Busy': 'orange',
  'Interested': 'teal',
  'Follow-up Set': 'indigo',
  'Meeting Fixed': 'purple',
  'Meeting Completed': 'violet',
  'Pipeline Locked': 'yellow',
  'Converted': 'green',
  'Not Interested': 'red',
};

const COLOR_CLASS_MAP: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-500 border-slate-200',
  blue: 'bg-blue-100 text-blue-600 border-blue-200',
  amber: 'bg-amber-100 text-amber-600 border-amber-200',
  orange: 'bg-orange-100 text-orange-600 border-orange-200',
  teal: 'bg-teal-100 text-teal-600 border-teal-200',
  indigo: 'bg-indigo-100 text-indigo-600 border-indigo-200',
  purple: 'bg-purple-100 text-purple-600 border-purple-200',
  violet: 'bg-violet-100 text-violet-600 border-violet-200',
  yellow: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  green: 'bg-green-100 text-green-700 border-green-200',
  red: 'bg-red-100 text-red-600 border-red-200',
};

let cachedStatuses: DropdownOption[] | null = null;
let loadPromise: Promise<DropdownOption[]> | null = null;

function fallbackList(): DropdownOption[] {
  return DEFAULT_LEAD_STATUSES.map((value, i) => ({
    type: 'FollowUpStatus',
    value,
    label: value,
    status: 'Active' as const,
    sortOrder: i + 1,
    meta: {
      color: DEFAULT_COLOR_MAP[value] || 'slate',
      isWon: value === 'Converted',
      isLost: value === 'Not Interested',
      isTerminal: value === 'Converted' || value === 'Not Interested',
    },
  }));
}

/** Kicks off (and caches) loading the real, admin-configured status list. Call once at app boot / dashboard mount. */
export async function preloadLeadStatuses(): Promise<DropdownOption[]> {
  if (cachedStatuses) return cachedStatuses;
  if (!loadPromise) {
    loadPromise = metadataService.getAllValues('FollowUpStatus').then(values => {
      cachedStatuses = values.length > 0 ? values : fallbackList();
      return cachedStatuses;
    }).catch(() => {
      cachedStatuses = fallbackList();
      return cachedStatuses;
    });
  }
  return loadPromise;
}

/** Synchronous accessor - returns whatever is cached so far (defaults until preload resolves). */
function getStatuses(): DropdownOption[] {
  if (!cachedStatuses) {
    // Kick off a background load for next time, but return defaults now
    // so callers never have to await this inside render logic.
    preloadLeadStatuses();
    return fallbackList();
  }
  return cachedStatuses;
}

export function getAllLeadStatusValues(): string[] {
  return getStatuses().filter(s => s.status === 'Active').map(s => s.label || s.value);
}

export function getLeadStatusMeta(status: string): { color: string; isWon: boolean; isLost: boolean; isTerminal: boolean } {
  const match = getStatuses().find(s => s.value === status);
  const meta = match?.meta || {};
  return {
    color: meta.color || DEFAULT_COLOR_MAP[status] || 'slate',
    isWon: !!meta.isWon,
    isLost: !!meta.isLost,
    isTerminal: !!meta.isTerminal,
  };
}

/** Tailwind badge classes for a given status - drop-in replacement for the old hardcoded switch/case functions. */
export function getLeadStatusColorClasses(status: string): string {
  const { color } = getLeadStatusMeta(status);
  return COLOR_CLASS_MAP[color] || COLOR_CLASS_MAP.slate;
}

/** Numeric pipeline order for sorting (e.g. Kanban columns) - lower = earlier stage. */
export function getLeadStatusOrder(status: string): number {
  const match = getStatuses().find(s => s.value === status);
  return match?.sortOrder ?? 999;
}

export function invalidateLeadStatusCache() {
  cachedStatuses = null;
  loadPromise = null;
}
