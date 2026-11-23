import { Lead, LeadQuality, LeadStatus, RolePermission, StatusHistoryEntry, User } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { filterLeadsByScope } from '../../users/utils/dataScope';
import { apiRequest, apiRequestEnvelope, ApiError } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';
import { shouldFallBackToCache } from '../../shared/api/offlinePolicy';
import { newMutationId } from '../utils/followUpOutboxCore';
import { enqueueFollowUp, FollowUpQueuedOfflineError } from './followUpOutbox';
import type { MatchedPolicy } from '../utils/policyLookupFill';

export type { MatchedPolicy } from '../utils/policyLookupFill';

/** The matched policy reference a Converted save carries (PR sync). */
export interface PolicyReference {
  policyNo?: string;
  proposalNo?: string;
  term?: string;
  payMode?: string;
}

export { FollowUpQueuedOfflineError } from './followUpOutbox';

/**
 * First-contact SLA state for a queue row (Phase 3 PR #3), computed
 * server-side by LeadSlaService and attached only when the admin SLA
 * switch is ON — absent entirely when the feature is off, and absent
 * for unassigned / terminal-status leads.
 */
export interface LeadSlaInfo {
  state: 'within' | 'due_soon' | 'breached' | 'met';
  clockStartAt: string;
  deadlineAt: string;
  remainingMs: number;
  overdueMs: number;
  firstContactAt: string | null;
}

/** One lead the server could not act on in a bulk call — the id
 *  echoes the identifier the caller sent, the reason is human
 *  readable (never an existence leak for out-of-scope leads). */
export interface BulkLeadFailure {
  id: string;
  reason: string;
}

/** Result of POST /api/leads/bulk-reassign: the moved leads plus
 *  the per-lead failures (a bad lead never fails the good ones). */
export interface BulkReassignResult {
  reassigned: string[];
  failed: BulkLeadFailure[];
}

/** Result of POST /api/leads/bulk-delete: an admin gets `deleted`,
 *  anyone else gets `requested` — the per-role semantics of the
 *  single-lead flows, applied per lead. */
export interface BulkDeleteResult {
  deleted?: string[];
  requested?: string[];
  failed: BulkLeadFailure[];
}

/** Result of POST /api/leads/bulk (row-level partial success semantics). */
export interface FollowUpQueueItem {
  id: string;
  leadCode?: string;
  prospectName: string;
  customerName?: string;
  mobile: string;
  assignedTo: string;
  assignedEmployeeName?: string;
  currentStatus: string;
  nextFollowUpAt: string;
  lastContactedAt?: string | null;
  followUpCount?: number;
  campaign?: string;
  product?: string;
  area?: string;
  priority?: string;
  overdueDays?: number;
  dueState: 'overdue' | 'today' | 'upcoming' | string;
  latestActivity?: { status?: string; remarks?: string; createdAt?: string } | null;
  /** Server-computed compact Lead Quality for this queue row's lead. */
  leadQuality?: LeadQuality | null;
  /** Server-computed first-contact SLA (present only when SLA is ON). */
  sla?: LeadSlaInfo | null;
}

export interface FollowUpQueueResult {
  bucket: string;
  timezone: string;
  todayDate: string;
  bounds: { todayStart: string; tomorrowStart: string };
  items: FollowUpQueueItem[];
  counts: { overdue: number; today: number; upcoming: number; all: number };
  pagination: { limit: number; offset: number; total: number };
}

export interface BulkImportResult {
  dryRun?: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  /** Rows resolved to a corporate client by code (065). */
  corporate?: number;
  errors: Array<{ index: number; message: string }>;
  warnings?: Array<{ index: number; message: string }>;
  campaignsRegistered?: number;
}

/** One corporate client (MIS code + company name) from the sheet. */
export interface CorporateClientOption {
  code: string;
  name: string;
}

/** GET /api/corporate-clients/search — available:false means the
 *  sheet could not be read (the picker then offers manual entry). */
export interface CorporateClientSearchResult {
  clients: CorporateClientOption[];
  available: boolean;
  error: string | null;
}

/** GET /api/leads/corporate/summary. */
export interface CorporateSummaryData {
  period: { key: string; label: string; start: string; end: string };
  kpis: { totalLeads: number; converted: number; conversionRatio: number; totalPremium: number };
  byCompany: Array<{ code: string; name: string; leads: number; converted: number; conversionRatio: number; premium: number }>;
  byAgent: Array<{ employeeId: string; name: string; companies: number; leads: number; converted: number }>;
  policies: Array<{ policyNo: string; clientName: string; product: string; payMode: string; sumAssured: number | null; premium: number; convertedAt: string | null; companyCode: string; companyName: string }>;
}

/**
 * leadService.ts
 * ------------------------------------------------------------------
 * Persistence policy:
 *   Every mutation calls the API FIRST. The local cache is only updated
 *   after the server confirms the PostgreSQL commit. Failed writes
 *   throw; no lead is ever "saved" locally while the cloud write failed.
 */

function currentEmployeeId(): string {
  return useAuthStore.getState().user?.employeeId || '';
}

function loadRolePermissions(): RolePermission[] {
  try {
    const raw = localStorage.getItem('lf_local_roles_permissions');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to parse role permissions for data-visibility scoping:', e);
    return [];
  }
}

function applyDataVisibilityFilters(leads: Lead[], filters: { role?: string, employeeId?: string }, allUsers: User[]): Lead[] {
  if (!filters?.employeeId) return leads;

  const currentUser = allUsers.find(u => u.employeeId === filters.employeeId) || {
    employeeId: filters.employeeId,
    role: filters.role,
  };

  const roles = loadRolePermissions();
  return filterLeadsByScope(leads, currentUser as any, allUsers, roles);
}

/** Cache a successfully persisted lead locally (cache only). */
function cacheLead(lead: Lead): void {
  const existing = localDb.getLead(lead.id);
  if (existing) {
    localDb.updateLead(lead.id, lead);
  } else {
    localDb.createLead(lead);
  }
}

/**
 * ONE attempt at the follow-up write with an idempotency key
 * (Phase 3 PR #2). Shared by the live submit path (updateLeadStatus)
 * and the offline outbox flush (followUpSync): the server applies a
 * clientMutationId exactly once (migration 050), so re-posting the
 * same payload + id after a lost response is safe. No queueing here —
 * this function either returns the authoritative lead or throws the
 * ApiError the caller must classify.
 */
export async function postFollowUpOnce(
  leadId: string,
  payload: Record<string, any>,
  clientMutationId: string,
): Promise<Lead | null> {
  const result = await apiRequest<any>(`/api/leads/${encodeURIComponent(leadId)}/follow-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, clientMutationId }),
  });

  // Server returns { lead, activity } (unwrapped from { success, data })
  // For backward compat, also handle bare Lead response
  const lead: Lead | null = result && typeof result === 'object' && 'lead' in result ? (result.lead as Lead) : (result as Lead);
  if (lead) {
    cacheLead(lead);
    return lead;
  }
  return null;
}

/** FIX-2 scoped lead export (see leadService.getLeadExportOptions / exportLeads). */
export type LeadExportScope = 'own' | 'team' | 'teamwise';
export type LeadExportBasis = 'added' | 'updated';

export interface LeadExportOptions {
  scopes: LeadExportScope[];
  maxRows: number;
  defaults: { scope: LeadExportScope; basis: LeadExportBasis; from: string; to: string };
}

export interface LeadExportRequest {
  scope: LeadExportScope;
  basis: LeadExportBasis;
  from?: string;
  to?: string;
}

export const leadService = {
  async createLead(leadData: Omit<Lead, 'id'>, options: { onMatch?: (info: { matchedBy: 'leadCode' | 'mobile' }) => void } = {}): Promise<Lead> {
    const leadDataWithId = leadData as Lead;
    const id = leadDataWithId.id || `lead_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const payload: Lead = {
      ...leadData,
      id,
      timestamp: new Date().toISOString(),
    } as Lead;

    if (payload.assignedTo) {
      payload.assignmentHistory = [
        ...(payload.assignmentHistory || []),
        {
          id: `assign_${Date.now()}`,
          toEmployeeId: payload.assignedTo,
          changedBy: payload.assignedBy || 'System',
          date: new Date().toISOString(),
          note: 'Initial assignment at lead creation',
        },
      ];
    }
    if (!payload.assignedBy) payload.assignedBy = currentEmployeeId();

    // F12: the server upserts on a matching mobile number (documented
    // behaviour), so "created" can quietly mean "the existing lead was
    // overwritten". The response says which one happened and the caller is
    // told, instead of a bare success toast.
    const envelope = await apiRequestEnvelope<Lead>('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const saved = (envelope.data ?? (envelope as any)) as Lead;
    if (envelope.matchedBy === 'leadCode' || envelope.matchedBy === 'mobile') {
      options.onMatch?.({ matchedBy: envelope.matchedBy });
    }
    cacheLead(saved);

    // Assignment notifications are now created server-side inside the
    // same transaction as the lead upsert (production.routes.ts POST /leads).
    // The browser no longer needs to fire a separate POST /notifications.
    if (saved.assignedTo) {
      // Notifications are now server-side in the same DB transaction.
    }
    return saved;
  },

  /**
   * Bulk import rows through the hardened /api/leads/bulk endpoint.
   * Rows may be raw spreadsheet rows (exact legacy headers - the server
   * maps them authoritatively) or already API-shaped lead payloads.
   *
   * dryRun:true performs server-side validation + duplicate detection
   * WITHOUT writing anything - used by the Bulk Upload preview so users
   * see row-level problems before committing.
   *
   * Row-level failures do NOT throw: the caller receives the full
   * result (inserted/updated/skipped/failed + per-row errors) so the UI
   * can report exactly what happened. Only transport/server failures
   * (network, 5xx, auth) throw.
   */
  async bulkUploadLeads(
    leads: Array<Record<string, any>>,
    options?: { dryRun?: boolean }
  ): Promise<BulkImportResult> {
    const dryRun = options?.dryRun === true;
    const result = await apiRequest<BulkImportResult>('/api/leads/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads, dryRun }),
    });

    if (!dryRun) {
      // Refresh the local cache with whatever the server committed.
      this.getAllLeads().catch(() => undefined);
    }
    return result;
  },

  /**
   * Bounded read for lightweight surfaces (the Dashboard "Recent Leads"
   * strip). Explicitly limited — the server caps it further with
   * LEADS_LIST_MAX_ROWS — and it NEVER rewrites the local mirror, so a
   * 5-row read can never shrink the offline cache the lead screens use.
   * Falls back to the mirror when the network or the server is unavailable.
   */
  async getRecentLeads(limit = 5): Promise<Lead[]> {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
    try {
      const rows = await apiRequest<Lead[]>(`/api/leads?limit=${cap}`);
      return Array.isArray(rows) ? rows.slice(0, cap) : [];
    } catch (err) {
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return localDb.getRecentLeads(cap);
    }
  },

  async getLeads(filters?: { role?: string, employeeId?: string, startDate?: string, endDate?: string }): Promise<Lead[]> {
    let leads: Lead[];
    try {
      const cloudLeads = await apiRequest<Lead[]>('/api/leads');
      // Cloud authoritative - mirror the full list into the cache.
      const merged = localDb.getLeads();
      const cloudIds = new Set(cloudLeads.map(l => l.id));
      const staleOnly = merged.filter(l => !cloudIds.has(l.id));
      // Keep cache entries that the cloud never returned only if they were
      // explicitly created offline (none are with DB-first writes) - so drop.
      void staleOnly;
      localDb.saveLeads(cloudLeads);
      leads = cloudLeads;
    } catch (err) {
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      leads = localDb.getLeads(); // read-only offline cache
    }

    if (filters?.employeeId) {
      const allUsers = await userService.getAllUsers().catch(() => localDb.getUsers());
      leads = applyDataVisibilityFilters(leads, filters, allUsers);
    }

    if (filters?.startDate && filters?.endDate) {
      const start = new Date(filters.startDate).getTime();
      const end = new Date(filters.endDate).getTime();
      leads = leads.filter(l => {
        const t = new Date(l.timestamp).getTime();
        return t >= start && t <= end;
      });
    }

    return leads.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  },

  async getAllLeads(): Promise<Lead[]> {
    try {
      const cloudLeads = await apiRequest<Lead[]>('/api/leads');
      localDb.saveLeads(cloudLeads);
      return cloudLeads;
    } catch (err) {
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return localDb.getLeads();
    }
  },

  /**
   * Corporate Group Leads (065): the /leads/corporate page list.
   * Server-filtered by the existing /api/leads endpoint
   * (corporateOnly + optional companyCode); no cache write — the
   * page is a report view, not the offline lead book.
   */
  async getCorporateLeads(companyCode?: string): Promise<Lead[]> {
    const params = new URLSearchParams({ corporateOnly: '1' });
    if (companyCode) params.set('companyCode', companyCode);
    return apiRequest<Lead[]>(`/api/leads?${params.toString()}`);
  },

  /** Corporate Group Leads (065): KPIs + per-company + per-agent + policies. */
  async getCorporateSummary(period: string): Promise<CorporateSummaryData> {
    return apiRequest<CorporateSummaryData>(`/api/leads/corporate/summary?period=${encodeURIComponent(period)}`);
  },

  /** Corporate Group Leads (065): autocomplete options for the client picker. */
  async searchCorporateClients(query: string): Promise<CorporateClientSearchResult> {
    return apiRequest<CorporateClientSearchResult>(`/api/corporate-clients/search?q=${encodeURIComponent(query)}`);
  },

  async clearAllLeads(): Promise<void> {
    // Server safety rail: the purge is refused (400) unless the body
    // carries the typed confirmation.
    await apiRequest('/api/leads/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'CLEAR_ALL' }),
    });
    localDb.clearAllLeads();
  },

  /**
   * Server-authoritative follow-up/status update.
   * Sends ONLY the business fields to POST /api/leads/:id/follow-up.
   * The server derives actor/timestamp, validates status, appends history
   * atomically, and updates the lead's current state in one transaction.
   * No history arrays or spoofable actor fields are ever sent.
   */
  async updateLeadStatus(
    leadId: string,
    status: LeadStatus,
    ncp?: number,
    remarks?: string,
    nextFollowUpDate?: string,
    updatedBy?: string,
    nextCallDate?: string,
    meetingDate?: string,
    sumAssured?: number,
    productName?: string,
    projectedNCP?: number,
    lossReason?: string,
    meetingType?: string,
    policyRef?: PolicyReference,
  ): Promise<Lead | null> {
    // updatedBy is intentionally ignored: server derives actor from auth
    void updatedBy;
    const payload: Record<string, any> = {
      status,
      remarks,
      nextFollowUpDate,
      nextCallDate,
      meetingDate,
      meetingType,
      collectedNCP: ncp,
      projectedNCP,
      sumAssured,
      productName,
      lossReason,
      // PR sync: the matched policy reference + term/pay mode ride with
      // the conversion and are stored in custom_fields server-side.
      policyNo: policyRef?.policyNo,
      proposalNo: policyRef?.proposalNo,
      policyTerm: policyRef?.term,
      payMode: policyRef?.payMode,
    };
    // Remove undefined values — preserves partial-update semantics
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    // One idempotency key per user submission: if the response is
    // lost (offline area, dropped connection), the outbox retry with
    // the same key can never apply the follow-up twice server-side.
    const mutationId = newMutationId();
    try {
      return await postFollowUpOnce(leadId, payload, mutationId);
    } catch (err) {
      // Network failure ONLY (ApiError status 0 = the request never
      // reached the server): save the submission to the durable
      // on-device outbox and throw the dedicated error so call sites
      // can say "Saved offline — will sync" instead of "failed".
      // Every definitive server answer (4xx validation/permission,
      // 5xx) surfaces exactly as it did before this feature.
      if (err instanceof ApiError && err.status === 0) {
        const cached = localDb.getLead(leadId) as any;
        const entry = enqueueFollowUp({
          leadId,
          leadLabel: cached?.prospectName || cached?.leadCode || leadId,
          payload,
          mutationId,
        });
        throw new FollowUpQueuedOfflineError(entry);
      }
      throw err;
    }
  },

  /**
   * PR sync — look a policy up by Proposal No or Policy No.
   * Returns the ONE matched policy's conversion fields. The ApiError
   * propagates with the server's message (404 = not in the sheet yet,
   * 503 = lookup not configured) so the form can show it inline and
   * leave manual entry working. The optional assigneeEmployeeId lets
   * the server resolve the assignee's stored IDRA FA Code for the
   * mismatch verdict (064).
   */
  async lookupPolicy(key: string, assigneeEmployeeId?: string): Promise<MatchedPolicy> {
    return apiRequest<MatchedPolicy>('/api/leads/policy-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ...(assigneeEmployeeId ? { assigneeEmployeeId } : {}) }),
    });
  },

  async getLead(leadId: string): Promise<Lead | null> {
    const cached = localDb.getLead(leadId);
    try {
      const lead = await apiRequest<Lead>(`/api/leads/${encodeURIComponent(leadId)}`);
      if (lead) {
        cacheLead(lead);
        return lead;
      }
      return null;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) return null;
        if (!shouldFallBackToCache(err.status)) throw err;
      }
      // Network / 5xx: return cached for offline read, but never report write success elsewhere
      return cached;
    }
  },

  /**
   * Fetch authoritative activity history for a lead.
   * Uses GET /api/leads/:id/activities (reverse chronological).
   */
  /**
   * Server-authoritative follow-up queue.
   * Visibility is enforced on the server; do not client-filter by role.
   */
  async getFollowUpQueue(params?: {
    bucket?: 'overdue' | 'today' | 'upcoming' | 'all';
    status?: string;
    assignedTo?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    includeTerminal?: boolean;
  }): Promise<FollowUpQueueResult> {
    const qs = new URLSearchParams();
    if (params?.bucket) qs.set('bucket', params.bucket);
    if (params?.status) qs.set('status', params.status);
    if (params?.assignedTo) qs.set('assignedTo', params.assignedTo);
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    if (params?.includeTerminal) qs.set('includeTerminal', 'true');
    const path = `/api/leads/follow-ups${qs.toString() ? `?${qs.toString()}` : ''}`;
    // GET read: the Dashboard fires today+upcoming, and a StrictMode
    // double-effect (or a quick Dashboard→Workbench round trip) can re-issue
    // the same bucket while the first is in flight — share one round-trip.
    const data = await coalesceGet(path, () => apiRequest<FollowUpQueueResult>(path));
    return data;
  },

  /**
   * Effective stage rules (DZ-6): the per-status required fields the
   * server enforces on POST /leads/:id/follow-up, resolved to current
   * status names. The client form validates from this same list so the
   * two can never drift. Returns null when the list cannot be read —
   * the caller falls back to the code-default table in
   * leadStatusRules.ts (exactly the server's fallback).
   */
  async getStageRules(): Promise<{ rules: import('../utils/leadStatusRules').StageRule[]; terminalNames: string[] } | null> {
    try {
      return await apiRequest<{ rules: import('../utils/leadStatusRules').StageRule[]; terminalNames: string[] }>('/api/leads/stage-rules');
    } catch {
      return null;
    }
  },

  async getLeadActivities(leadId: string): Promise<Array<Record<string, any>>> {
    try {
      const activities = await apiRequest<Array<Record<string, any>>>(`/api/leads/${encodeURIComponent(leadId)}/activities`);
      return Array.isArray(activities) ? activities : [];
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return [];
    }
  },

  /**
   * Full server-authoritative Lead Quality explanation for one lead
   * (score, band, positive/negative factors, attention reasons).
   * Single-lead read for details views — never called per row in a list.
   */
  async getLeadQuality(leadId: string): Promise<LeadQuality | null> {
    try {
      const quality = await apiRequest<LeadQuality>(`/api/leads/${encodeURIComponent(leadId)}/quality`);
      return quality ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return null;
    }
  },

  /**
   * FIX-2 scoped export: which scopes the server will offer this
   * caller (own always; team/teamwise only when their visible set
   * reaches beyond themself), plus the default basis + date range.
   */
  async getLeadExportOptions(): Promise<LeadExportOptions> {
    return apiRequest<LeadExportOptions>('/api/leads/export/options');
  },

  /**
   * FIX-2 scoped export: POST the scope/basis/range and download the
   * server-built .xlsx workbook (Leads + History sheets). Raw fetch
   * on purpose — the response is a binary file, not JSON; the global
   * authenticated fetch (lib/apiClient) still attaches the session
   * token and the API base. Server errors arrive as JSON and are
   * surfaced with the server's own message (e.g. the row cap).
   */
  async exportLeads(payload: LeadExportRequest): Promise<{ blob: Blob; filename: string; leadCount: number; historyCount: number }> {
    let res: Response;
    try {
      res = await fetch('/api/leads/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error('Unable to reach the server. Please check your connection and try again.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      throw new Error(body?.message || 'Export failed. Please try again.');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return {
      blob,
      filename: match?.[1] || 'leadflow-leads-export.xlsx',
      leadCount: Number(res.headers.get('X-Lead-Count') || 0),
      historyCount: Number(res.headers.get('X-History-Count') || 0),
    };
  },

  async addDocument(leadId: string, name: string, note: string | undefined, uploadedBy: string) {
    const existing = await this.getLead(leadId);
    if (!existing) throw new ApiError(404, 'Lead not found. It may have been deleted.');
    const doc = {
      id: `doc_${Date.now()}`,
      name,
      note,
      uploadedBy,
      date: new Date().toISOString(),
    };
    const saved = await this.updateLead(leadId, { documents: [...(existing.documents || []), doc] }, uploadedBy);
    return doc;
  },

  async updateLead(leadId: string, updatedFields: Partial<Lead>, updaterName?: string): Promise<Lead | null> {
    const updater = updaterName || useAuthStore.getState().user?.name || 'Admin';

    const existing = await this.getLead(leadId);
    if (!existing) throw new ApiError(404, 'Lead not found. It may have been deleted.');

    const fields: Partial<Lead> = { ...updatedFields };

    if (fields.assignedTo !== undefined && existing.assignedTo !== fields.assignedTo) {
      fields.assignedBy = updater;
      fields.assignedDate = new Date().toISOString();
      const assignmentEntry = {
        id: `assign_${Date.now()}`,
        fromEmployeeId: existing.assignedTo || undefined,
        toEmployeeId: fields.assignedTo,
        changedBy: updater,
        date: new Date().toISOString(),
      };
      fields.assignmentHistory = [...(existing.assignmentHistory || []), assignmentEntry];
    }

    const payload: Lead & { _preserveAssignment?: boolean } = {
      ...existing,
      ...fields,
      // Keep the compatibility payload shape, but tell the server whether
      // this operation intentionally changes ownership. This prevents a
      // demographic/document edit from turning a canonical NULL owner into
      // the current caller.
      _preserveAssignment: fields.assignedTo === undefined,
      statusHistory: fields.statusHistory || existing.statusHistory || [],
      assignmentHistory: fields.assignmentHistory || existing.assignmentHistory || [],
      documents: fields.documents || existing.documents || [],
      timestamp: new Date().toISOString(),
    };

    const saved = await apiRequest<Lead>('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cacheLead(saved);

    // Assignment notifications are now created server-side inside the
    // same transaction as the lead upsert (production.routes.ts POST /leads).
    // The browser no longer fires per-supervisor fan-out requests.
    if (fields.assignedTo && fields.assignedTo !== existing.assignedTo) {
      // Notifications are now server-side in the same DB transaction.
    }
    return saved;
  },

  async deleteLead(leadId: string): Promise<void> {
    await apiRequest(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' });
    localDb.deleteLead(leadId);
  },

  /**
   * Request deletion of a lead (migration 062, 2026-11-18). This does
   * NOT delete the lead: it files a request the admins review, and
   * only an approval actually deletes it. The server notifies every
   * active admin in-app (no email), refuses a second pending request
   * (409), and 404s for leads outside the caller's scope. The local
   * cache is updated to carry the pending marker so the list shows
   * it without a refetch.
   */
  async requestDelete(leadId: string, reason?: string): Promise<void> {
    await apiRequest(`/api/leads/${encodeURIComponent(leadId)}/delete-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || undefined }),
    });
    const cached = localDb.getLead(leadId);
    if (cached) {
      cacheLead({ ...cached, deleteRequested: true });
    }
  },

  /**
   * Direct delete of a lead (Mahadi, 2026-11-21): ADMIN/SUPERADMIN
   * only — no approval, only the confirm click in DirectDeleteDialog.
   * The server enforces the role (POST /leads/:id/delete is
   * admin-only; a non-admin gets 403 even with the leads.delete
   * grant). The local cache drops the lead so the list reflects
   * the delete without a refetch.
   */
  async deleteLeadDirect(leadId: string): Promise<void> {
    await apiRequest(`/api/leads/${encodeURIComponent(leadId)}/delete`, { method: 'POST' });
    localDb.deleteLead(leadId);
  },

  /**
   * Bulk reassign (2026-11-22): move several leads to one team
   * member. The server enforces the reassign permission + team
   * scope upfront and authorises every lead server-side, so a bad
   * lead lands in `failed` and never fails the good ones. The
   * caller refreshes the list afterwards (getLeads re-syncs the
   * local cache from the cloud), so no cache surgery here.
   */
  async bulkReassign(leadIds: string[], toEmployeeId: string): Promise<BulkReassignResult> {
    return apiRequest<BulkReassignResult>('/api/leads/bulk-reassign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds, toEmployeeId }),
    });
  },

  /**
   * Bulk delete (2026-11-22): an admin direct-deletes each
   * selected lead; anyone else files one delete request per lead
   * (one reason, entered once, applied to all). The server
   * enforces the per-role rule per lead. The caller refreshes the
   * list afterwards (getLeads re-syncs the local cache, so deleted
   * leads drop out and pending request markers appear).
   */
  async bulkDelete(leadIds: string[], reason?: string): Promise<BulkDeleteResult> {
    return apiRequest<BulkDeleteResult>('/api/leads/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds, reason: reason || undefined }),
    });
  },

  async deleteLeadsByCampaign(campaignName: string): Promise<void> {
    // Server safety rail: the purge is refused (400) unless the body
    // repeats the exact campaign name as the typed confirmation.
    await apiRequest(`/api/leads/campaign/${encodeURIComponent(campaignName)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: campaignName }),
    });
    const leads = localDb.getLeads().filter(l => l.campaignName !== campaignName);
    localDb.saveLeads(leads);
  },
};
