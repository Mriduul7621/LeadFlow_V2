import { Lead, LeadStatus, RolePermission, StatusHistoryEntry, User } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { notificationService } from '../../notifications/services/notificationService';
import { filterLeadsByScope } from '../../users/utils/dataScope';
import { apiRequest, ApiError } from '../../shared/api/http';
import { toast } from 'sonner';

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

  async bulkUploadLeads(leads: Omit<Lead, 'id'>[]): Promise<{ inserted: number; updated: number; failed: number; total: number; errors: Array<{ index: number; message: string }> }> {
    const payloads = leads.map(lead => ({
      ...lead,
      id: (lead as Lead).id || `lead_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
    }));

    const result = await apiRequest<{ inserted: number; updated: number; failed: number; total: number; errors: Array<{ index: number; message: string }> }>('/api/leads/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads: payloads }),
    });

    // Refresh the local cache with whatever the server committed.
    this.getAllLeads().catch(() => undefined);

    if (result.failed > 0) {
      const firstMessage = result.errors?.[0]?.message || 'Unknown row error';
      throw new ApiError(422, `${result.failed} of ${result.total} leads could not be saved. ${firstMessage}`);
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
    const existing = await this.getLead(leadId);
    if (!existing) throw new ApiError(404, 'Lead not found. It may have been deleted.');
    const history: StatusHistoryEntry = {
      status,
      date: new Date().toISOString(),
      remarks: remarks || '',
      nextFollowUpDate,
      nextCallDate,
      meetingDate,
      sumAssured,
      productName,
      updatedBy,
      lossReason,
      meetingType,
    };
    return this.updateLead(
      leadId,
      {
        currentStatus: status,
        collectedNCP: ncp ?? existing.collectedNCP,
        nextFollowUpDate: nextFollowUpDate ?? existing.nextFollowUpDate,
        nextCallDate: nextCallDate ?? existing.nextCallDate,
        meetingDate: meetingDate ?? existing.meetingDate,
        sumAssured: sumAssured ?? existing.sumAssured,
        productName: productName ?? existing.productName,
        projectedNCP: projectedNCP ?? existing.projectedNCP,
        lossReason: lossReason ?? existing.lossReason,
        meetingType: meetingType ?? existing.meetingType,
        statusHistory: [...(existing.statusHistory || []), history],
      },
      updatedBy
    );
  },

  async getLead(leadId: string): Promise<Lead | null> {
    const cached = localDb.getLead(leadId);
    try {
      const cloudLeads = await apiRequest<Lead[]>('/api/leads');
      localDb.saveLeads(cloudLeads);
      const match = cloudLeads.find(l => l.id === leadId);
      if (match) {
        localDb.updateLead(leadId, match);
        return match;
      }
      return null; // cloud says it is gone - do not resurrect from cache
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return cached;
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
