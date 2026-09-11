import { apiRequest, apiRequestEnvelope } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';

/**
 * scheduledActivityService.ts — Step 5C
 * ------------------------------------------------------------------
 * Server-authoritative scheduled activities / calendar. Every read
 * and mutation goes through PostgreSQL (Asia/Dhaka) and is scoped
 * by the same Own/DownTeam/FullTeam/Organization visibility as leads.
 * No localStorage / localDb authority.
 */

export type ScheduledActivityType = 'call' | 'meeting' | 'follow_up' | 'task';
export type ScheduledActivityStatus = 'scheduled' | 'completed' | 'cancelled';
export type ScheduledActivityPriority = 'LOW' | 'NORMAL' | 'MEDIUM' | 'HIGH';

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
  priority?: ScheduledActivityPriority | string | null;
  meetingType?: string | null;
  meeting_type?: string | null;
  location?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
  assignedTo?: string | null;
  assigned_to?: string | null;
  updatedBy?: string | null;
  updated_by?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  completedAt?: string | null;
  completed_at?: string | null;
  completedBy?: string | null;
  completed_by?: string | null;
  completedActivityId?: string | null;
  completed_activity_id?: string | null;
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
  priority?: ScheduledActivityPriority | string;
  assignedTo?: string; // employeeId or userId — narrowing filter
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
  if (params.priority) q.set('priority', String(params.priority));
  if (params.assignedTo) q.set('assignedTo', String(params.assignedTo));
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function fetchScheduledPage(qs: string, params: ScheduledActivityListParams): Promise<{ items: ScheduledActivity[]; pagination: { limit: number; offset: number; total: number } }> {
  // Single-request helper via shared authenticated layer — preserves EXACT
  // auth (Authorization via lib/apiClient), 401/session handling, base URL
  // and error mapping from http.ts while keeping the pagination envelope.
  // The list read is coalesced: concurrent identical window requests
  // (StrictMode double-effect, embedded calendar + dedicated route on the
  // same tick) share one round-trip. Mutations below are NOT coalesced.
  const body: any = await coalesceGet(`/api/scheduled-activities${qs}`, () =>
    apiRequestEnvelope<ScheduledActivity[]>(`/api/scheduled-activities${qs}`)
  );
  if (body && body.success === true && Array.isArray(body.data)) {
    return { items: body.data as ScheduledActivity[], pagination: body.pagination || { limit: params.limit || 50, offset: params.offset || 0, total: body.data.length } };
  }
  if (Array.isArray(body)) return { items: body as ScheduledActivity[], pagination: { limit: params.limit || 50, offset: params.offset || 0, total: (body as any).length } };
  if (body && Array.isArray(body.data)) return { items: body.data, pagination: body.pagination || { limit: params.limit || 50, offset: params.offset || 0, total: body.data.length } };
  // Fallback for unwrapped envelope edge cases
  if (body && typeof body === 'object' && Array.isArray((body as any).data)) {
    const d = (body as any).data;
    return { items: d as ScheduledActivity[], pagination: (body as any).pagination || { limit: params.limit || 50, offset: params.offset || 0, total: d.length } };
  }
  return { items: [], pagination: { limit: params.limit || 50, offset: params.offset || 0, total: 0 } };
}

export const scheduledActivityService = {
  async list(params: ScheduledActivityListParams = {}): Promise<ScheduledActivity[]> {
    const { items } = await fetchScheduledPage(toQuery(params), params);
    return items;
  },

  async listWithPagination(params: ScheduledActivityListParams = {}): Promise<{ items: ScheduledActivity[]; pagination: { limit: number; offset: number; total: number } }> {
    const qs = toQuery(params);
    return fetchScheduledPage(qs, params);
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
    priority?: ScheduledActivityPriority | string | null;
    meetingType?: string | null;
    location?: string | null;
    assignedTo?: string | null;
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
      priority: ScheduledActivityPriority | string | null;
      meetingType: string | null;
      location: string | null;
      assignedTo: string | null;
    }>
  ): Promise<ScheduledActivity> {
    return apiRequest<ScheduledActivity>(`/api/scheduled-activities/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async complete(id: string, payload?: Record<string, any>): Promise<{ scheduled: ScheduledActivity; activity: any }> {
    return apiRequest<{ scheduled: ScheduledActivity; activity: any }>(`/api/scheduled-activities/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  },

  async cancel(id: string): Promise<ScheduledActivity> {
    return apiRequest<ScheduledActivity>(`/api/scheduled-activities/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async remove(id: string): Promise<void> {
    await apiRequest<void>(`/api/scheduled-activities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
