import { apiRequest } from '../../shared/api/http';

export type RoadshowStatus = 'pending' | 'execute' | 'reschedule' | 'cancel';

export interface RoadshowAssignee {
  id: string;
  name: string;
  employeeId: string;
}

export interface RoadshowStageCount {
  status: string;
  count: number;
}

export interface Roadshow {
  id: string;
  organization: string;
  location: string;
  scheduledAt: string;
  status: RoadshowStatus;
  sourceCode: string | null;
  executedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  assignedUsers: RoadshowAssignee[];
  totalLeads: number;
  convertedLeads: number;
  stageBreakdown: RoadshowStageCount[];
}

export interface RoadshowInput {
  organization: string;
  location: string;
  scheduledAt: string;
  assignedUserIds: string[];
}

export const roadshowService = {
  list(params: { from?: string; to?: string; mine?: boolean } = {}): Promise<Roadshow[]> {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    if (params.mine) query.set('mine', 'true');
    const suffix = query.size ? `?${query.toString()}` : '';
    return apiRequest<Roadshow[]>(`/api/roadshows${suffix}`);
  },

  performance(): Promise<Roadshow[]> {
    return apiRequest<Roadshow[]>('/api/roadshows/performance');
  },

  create(input: RoadshowInput): Promise<Roadshow> {
    return apiRequest<Roadshow>('/api/roadshows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  update(id: string, input: Partial<RoadshowInput> & { status?: RoadshowStatus }): Promise<Roadshow> {
    return apiRequest<Roadshow>(`/api/roadshows/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },
};
