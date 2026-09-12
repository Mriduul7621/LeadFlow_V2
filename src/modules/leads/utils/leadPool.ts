import type { Lead } from '../../shared/types';

/**
 * Lead Pool view state is derived from the canonical ownership field only.
 * `assignedTo` is the employee id exposed by the API; an empty value means
 * that the PostgreSQL lead row has no owner. No client role or feature flag
 * participates in this classification.
 */
export type LeadPoolTab = 'unassigned' | 'assigned' | 'all';

export function hasLeadOwner(lead: Pick<Lead, 'assignedTo'>): boolean {
  return String(lead.assignedTo ?? '').trim().length > 0;
}

export function filterLeadsByPoolTab(leads: Lead[], tab: LeadPoolTab): Lead[] {
  if (tab === 'unassigned') return leads.filter(lead => !hasLeadOwner(lead));
  if (tab === 'assigned') return leads.filter(lead => hasLeadOwner(lead));
  return leads;
}

export function getLeadPoolCounts(leads: Lead[]): {
  total: number;
  unassigned: number;
  assigned: number;
  converted: number;
} {
  const unassigned = leads.filter(lead => !hasLeadOwner(lead)).length;
  return {
    total: leads.length,
    unassigned,
    assigned: leads.length - unassigned,
    converted: leads.filter(lead => lead.currentStatus === 'Converted').length,
  };
}
