import { Lead, LeadActivityEntry, LeadStatus, FollowUpResult, FollowUpUpdate, RolePermission, User } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { notificationService } from '../../notifications/services/notificationService';
import { filterLeadsByScope } from '../../users/utils/dataScope';
import { apiRequest, ApiError } from '../../shared/api/http';
import { toast } from 'sonner';

/** Result of POST /api/leads/bulk (row-level partial success semantics). */
export interface BulkImportResult {
  dryRun?: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  errors: Array<{ index: number; message: string }>;
  warnings?: Array<{ index: number; message: string }>;
  campaignsRegistered?: number;
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

async function sendHierarchyNotifications(leadId: string, prospectName: string, assignedTo: string, updaterName: string) {
  const errors: string[] = [];
  try {
    const allUsers = await userService.getAllUsers();

    // 1. Send notification to the assignee
    try {
      await notificationService.createNotification(assignedTo, 'New Lead Assigned', `Lead '${prospectName}' has been assigned to you by ${updaterName}.`, leadId);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Assignee notification failed');
    }

    // 2. Transmit notifications up the supervisor/manager hierarchy
    let currentAssignee = allUsers.find(u => u.employeeId === assignedTo);
    const visited = new Set<string>();
    if (currentAssignee) visited.add(currentAssignee.employeeId);

    while (currentAssignee && currentAssignee.managerId) {
      const supervisorId = currentAssignee.managerId;
      if (visited.has(supervisorId)) break; // Prevent infinite loops
      visited.add(supervisorId);

      const manager = allUsers.find(u => u.employeeId === supervisorId);
      if (manager && manager.status === 'Active') {
        try {
          await notificationService.createNotification(
            manager.employeeId,
            'Team Lead Assigned Upline Alert',
            `Lead '${prospectName}' under your team tracking has been routed to assignee: ${assignedTo} (${currentAssignee.name}) by ${updaterName}.`,
            leadId
          );
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'Upline notification failed');
        }
        currentAssignee = manager;
      } else {
        break;
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Notification recipients could not be loaded');
  }
  if (errors.length > 0) {
    // The lead itself is persisted - surface the side-effect failure so it
    // is never silently lost, without rolling back the successful write.
    toast.warning('Lead saved, but one or more team notifications could not be sent.', { id: `notif-${leadId}` });
  }
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

export const leadService = {
  async createLead(leadData: Omit<Lead, 'id'>): Promise<Lead> {
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

    const saved = await apiRequest<Lead>('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cacheLead(saved);

    // Assignment notifications are a side channel - fired only after the
    // lead itself committed to the database.
    if (saved.assignedTo) {
      await sendHierarchyNotifications(saved.id, saved.prospectName, saved.assignedTo, saved.assignedBy || 'System');
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
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
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
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return localDb.getLeads();
    }
  },

  async clearAllLeads(): Promise<void> {
    await apiRequest('/api/leads/clear-all', { method: 'POST' });
    localDb.clearAllLeads();
  },

  /**
   * Log a follow-up / status change through the dedicated server-authoritative
   * endpoint (POST /api/leads/:id/follow-up).
   *
   * The client sends ONLY the business fields of the event. It never sends:
   *   - statusHistory / assignmentHistory  (the server appends atomically)
   *   - changedBy / updatedBy / actor      (server derives from the session)
   *   - a client timestamp                 (the server clock is the event time)
   * `updatedBy` stays in the signature purely so existing call sites keep
   * compiling; it is deliberately NOT transmitted.
   *
   * The local cache is refreshed only after the server reports that
   * PostgreSQL committed. A failed write throws - never a local success.
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
  ): Promise<Lead | null> {
    void updatedBy; // intentionally not sent: the server owns the actor

    const payload: FollowUpUpdate = { status };
    // Only explicitly supplied fields are sent; omitted fields keep their
    // stored value on the server (partial update / preserve-on-undefined).
    const put = (key: keyof FollowUpUpdate, value: unknown) => {
      if (value === undefined || value === null) return;
      if (typeof value === 'string' && value.trim() === '') return;
      (payload as Record<string, unknown>)[key] = value;
    };

    put('collectedNCP', ncp);
    put('remarks', remarks);
    put('nextFollowUpDate', nextFollowUpDate);
    put('nextCallDate', nextCallDate);
    put('meetingDate', meetingDate);
    put('sumAssured', sumAssured);
    put('productName', productName);
    put('projectedNCP', projectedNCP);
    put('lossReason', lossReason);
    put('meetingType', meetingType);

    const result = await apiRequest<FollowUpResult>(
      `/api/leads/${encodeURIComponent(leadId)}/follow-up`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    // The server committed - only now mirror the authoritative state.
    const saved = result?.lead;
    if (saved) cacheLead(saved);
    return saved ?? null;
  },

  /**
   * Direct single-lead read (GET /api/leads/:id) - one row, server-side
   * visibility enforced. No longer fetches the whole /api/leads list.
   * A 404 means "gone, or never visible to you" and is NOT resurrected
   * from the offline cache; transport/5xx failures fall back to the cache.
   */
  async getLead(leadId: string): Promise<Lead | null> {
    const cached = localDb.getLead(leadId);
    try {
      const lead = await apiRequest<Lead>(`/api/leads/${encodeURIComponent(leadId)}`);
      if (lead && typeof lead === 'object' && (lead as Lead).id) {
        if (!localDb.updateLead(leadId, lead)) cacheLead(lead);
        return lead;
      }
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return cached;
    }
  },

  /**
   * The authoritative follow-up/status activity stream for one lead
   * (newest first) from `lead_activities`. Rows are appended by the server
   * inside the same transaction that updates the lead, so this is the only
   * trustworthy activity source for LeadFlow-native activity.
   *
   * Returns [] when the lead has no LeadFlow-recorded activity yet - e.g. a
   * lead imported from the legacy spreadsheet, which is a current-state
   * snapshot and is deliberately NOT fabricated into event history.
   */
  async getLeadActivities(leadId: string): Promise<LeadActivityEntry[]> {
    const result = await apiRequest<{ activities?: LeadActivityEntry[] }>(
      `/api/leads/${encodeURIComponent(leadId)}/activities`
    );
    return Array.isArray(result?.activities) ? result.activities : [];
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
      fields.assignedDate = new Date().toISOString();
      // NOTE: the assignment-history ENTRY is not built here any more. When
      // the server sees the assignee change it appends the history entry
      // itself (actor + time server-derived) onto the stored history - see
      // POST /api/leads. Assignment architecture is unchanged by STEP 4A.
    }

    const payload: Lead = {
      ...existing,
      ...fields,
      documents: fields.documents || existing.documents || [],
    };

    // STEP 4A: history arrays and audit metadata are server-owned and are
    // never round-tripped. status_history / assignment_history are appended
    // by the server inside the same transaction that writes the row, so the
    // client sending (and potentially clobbering) the full array is both
    // unnecessary and unsafe. `existing` carries those fields because the
    // lead read model includes them - they are stripped before sending.
    const outbound = payload as unknown as Record<string, unknown>;
    delete outbound.statusHistory;
    delete outbound.assignmentHistory;
    delete outbound.createdBy;
    delete outbound.updatedBy;
    delete outbound.timestamp;

    const saved = await apiRequest<Lead>('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cacheLead(saved);

    // Assignment notifications after the DB commit confirmed.
    if (fields.assignedTo && fields.assignedTo !== existing.assignedTo) {
      await sendHierarchyNotifications(saved.id, saved.prospectName, saved.assignedTo, updater);
    }
    return saved;
  },

  async deleteLead(leadId: string): Promise<void> {
    await apiRequest(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' });
    localDb.deleteLead(leadId);
  },

  async deleteLeadsByCampaign(campaignName: string): Promise<void> {
    await apiRequest(`/api/leads/campaign/${encodeURIComponent(campaignName)}`, { method: 'DELETE' });
    const leads = localDb.getLeads().filter(l => l.campaignName !== campaignName);
    localDb.saveLeads(leads);
  },
};
