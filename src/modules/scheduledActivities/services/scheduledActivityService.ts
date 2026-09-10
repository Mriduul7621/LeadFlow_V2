import { apiRequest } from '../../shared/api/http';

/**
 * scheduledActivityService.ts — Step 5C
 * ------------------------------------------------------------------
 * Server-authoritative scheduled activities / calendar. Every read
 * and mutation goes through PostgreSQL (Asia/Dhaka) and is scoped
 * by the same Own/DownTeam/FullTeam/Organization visibility as leads.
 * No localStorage / localDb authority.
 */

export type ScheduledActivityType = 'call' | 'meeting' | 'follow_up';
export type ScheduledActivityStatus = 'scheduled' | 'completed' | 'cancelled';

export interface ScheduledActivity {
  id: string;
  leadId: string;
  lead_id?: string;
  activityType: ScheduledActivityType;
  activity_type?: ScheduledActivityType;
  title?: string | null;
  scheduledAt: string;
  scheduled_at?: string;
  durationMinutes?: number | null;
  duration_minutes?: number | null;
  remarks?: string | null;
  status: ScheduledActivityStatus;
  createdBy?: string | null;
  created_by?: string | null;
  assignedTo?: string | null;
  assigned_to?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  // joined lead convenience
  leadCustomerName?: string | null;
  leadMobile?: string | null;
  leadStatus?: string | null;
}

export interface ScheduledActivityListParams {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  leadId?: string;
  activityType?: ScheduledActivityType;
  status?: ScheduledActivityStatus;
  limit?: number;
  offset?: number;
}

export interface ScheduledActivityListResult {
  data: ScheduledActivity[];
  pagination?: { limit: number; offset: number; total: number };
}

function toQuery(params: ScheduledActivityListParams): string {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.leadId) q.set('leadId', params.leadId);
  if (params.activityType) q.set('activityType', params.activityType);
  if (params.status) q.set('status', params.status);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const scheduledActivityService = {
  async list(params: ScheduledActivityListParams = {}): Promise<ScheduledActivity[]> {
    const qs = toQuery(params);
    const res = await apiRequest<ScheduledActivity[] | { data: ScheduledActivity[]; pagination: any }>(`/api/scheduled-activities${qs}`);
    // Unwrap helper may have returned array directly (via {success,data}) or object with data
    if (Array.isArray(res)) return res as ScheduledActivity[];
    if (res && typeof res === 'object' && 'data' in (res as any) && Array.isArray((res as any).data)) {
      return (res as any).data as ScheduledActivity[];
    }
    // Fallback: if wrapped as {success,data,pagination}
    if (res && typeof res === 'object' && Array.isArray((res as any))) return res as any;
    return res as unknown as ScheduledActivity[];
  },

  async listWithPagination(params: ScheduledActivityListParams = {}): Promise<{ items: ScheduledActivity[]; pagination: { limit: number; offset: number; total: number } }> {
    const qs = toQuery(params);
    const raw: any = await apiRequest<any>(`/api/scheduled-activities${qs}`);
    // When apiRequest unwraps {success,data}, data is array; but we need pagination from raw fetch
    // So do a direct fetch to capture pagination if needed
    // Instead, use fetch directly for full envelope
    try {
      const resp = await fetch(`/api/scheduled-activities${qs}`, { headers: { 'Content-Type': 'application/json' } });
      const body = await resp.json().catch(() => ({}));
      if (body && body.success && Array.isArray(body.data)) {
        return { items: body.data as ScheduledActivity[], pagination: body.pagination || { limit: params.limit || 50, offset: params.offset || 0, total: body.data.length } };
      }
    } catch {}
    // Fallback to simple list
    const items = Array.isArray(raw) ? raw : raw?.data || [];
    return { items, pagination: raw?.pagination || { limit: params.limit || 50, offset: params.offset || 0, total: items.length } };
  },

  async getById(id: string): Promise<ScheduledActivity> {
    return apiRequest<ScheduledActivity>(`/api/scheduled-activities/${encodeURIComponent(id)}`);
  },

  async getByLead(leadId: string): Promise<ScheduledActivity[]> {
    return apiRequest<ScheduledActivity[]>(`/api/leads/${encodeURIComponent(leadId)}/scheduled-activities`);
  },

  async create(payload: {
    leadId: string;
    activityType: ScheduledActivityType;
    scheduledAt: string;
    title?: string | null;
    remarks?: string | null;
    durationMinutes?: number | null;
    status?: ScheduledActivityStatus;
  }): Promise<ScheduledActivity> {
    return apiRequest<ScheduledActivity>('/api/scheduled-activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async update(
    id: string,
    payload: Partial<{
      activityType: ScheduledActivityType;
      scheduledAt: string;
      title: string | null;
      remarks: string | null;
      durationMinutes: number | null;
      status: ScheduledActivityStatus;
    }>
  ): Promise<ScheduledActivity> {
    return apiRequest<ScheduledActivity>(`/api/scheduled-activities/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async remove(id: string): Promise<void> {
    await apiRequest<void>(`/api/scheduled-activities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
