import { Lead, LeadStatus, RolePermission, StatusHistoryEntry, User } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { notificationService } from '../../notifications/services/notificationService';
import { filterLeadsByScope } from '../../users/utils/dataScope';
import { apiRequest, ApiError } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';
import { toast } from 'sonner';

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

    // Assignment notifications are a side channel - fired only AFTER the
    // lead itself committed to the database, and fire-and-forget: the
    // save is already server-confirmed, so the notification fan-out
    // (which fans out one request per supervisor up the chain) must not
    // extend the user's "saving..." state. Failures still surface via the
    // warning toast inside sendHierarchyNotifications.
    if (saved.assignedTo) {
      void sendHierarchyNotifications(saved.id, saved.prospectName, saved.assignedTo, saved.assignedBy || 'System').catch(
        err => console.warn('[leads] Assignment notification fan-out failed (lead is saved):', err)
      );
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
    };
    // Remove undefined values — preserves partial-update semantics
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const result = await apiRequest<any>(`/api/leads/${encodeURIComponent(leadId)}/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Server returns { lead, activity } (unwrapped from { success, data })
    // For backward compat, also handle bare Lead response
    const lead: Lead | null = result && typeof result === 'object' && 'lead' in result ? (result.lead as Lead) : (result as Lead);
    if (lead) {
      cacheLead(lead);
      return lead;
    }
    return null;
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
        if (err.status !== 0 && err.status < 500) throw err;
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

  async getLeadActivities(leadId: string): Promise<Array<Record<string, any>>> {
    try {
      const activities = await apiRequest<Array<Record<string, any>>>(`/api/leads/${encodeURIComponent(leadId)}/activities`);
      return Array.isArray(activities) ? activities : [];
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return [];
    }
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

    const payload: Lead = {
      ...existing,
      ...fields,
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

    // Assignment notifications after the DB commit confirmed — and
    // fire-and-forget, so the confirmed save is not extended by the
    // per-supervisor fan-out (see createLead above).
    if (fields.assignedTo && fields.assignedTo !== existing.assignedTo) {
      void sendHierarchyNotifications(saved.id, saved.prospectName, saved.assignedTo, updater).catch(
        err => console.warn('[leads] Assignment notification fan-out failed (lead is saved):', err)
      );
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
