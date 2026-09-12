/**
 * dashboardService.ts
 * ------------------------------------------------------------------
 * Server-authoritative dashboard metrics (Step 5).
 * Production totals come ONLY from GET /api/dashboard.
 * Client-side lead lists are never used for authoritative KPI totals.
 */

import { apiRequest } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';

export interface DashboardFollowUpCounts {
  overdue: number;
  today: number;
  upcoming: number;
  all: number;
}

export interface DashboardStatusCounts {
  Untouched: number;
  Contacted: number;
  'No Response': number;
  Busy: number;
  Interested: number;
  'Follow-up Set': number;
  'Meeting Fixed': number;
  'Meeting Completed': number;
  'Pipeline Locked': number;
  Converted: number;
  'Not Interested': number;
  [key: string]: number;
}

export interface DashboardAgentStat {
  name: string;
  employeeId?: string;
  assigned: number;
  total: number;
  noCall: number;
  nextCall: number;
  followUp: number;
  followUpAlert: number;
  converted: number;
  collected: number;
  projected: number;
  conversion: string;
}

export interface DashboardTeamStat {
  team: string;
  assigned: number;
  noCall: number;
  contacted: number;
  meetings: number;
  followUps: number;
  pipeline: number;
  collected: number;
  projected: number;
}

export interface DashboardCampaignStat {
  name: string;
  value: number;
  color: string;
}

/**
 * Scope-consistent Lead Quality aggregate from GET /api/dashboard.
 * Server-computed only — the client never derives band counts from lead
 * lists. Undefined when the server omits it (older responses).
 */
export interface DashboardQualityAggregate {
  hot: number;
  warm: number;
  developing: number;
  cold: number;
  /** Mean score across scored active leads (null when none). */
  activeAverage: number | null;
  /** Active leads scored (terminal outcomes excluded by definition). */
  activeScored: number;
  /** Active leads carrying at least one attention reason. */
  needsAttention: number;
}

function sanitizeQuality(raw: unknown): DashboardQualityAggregate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    hot: num(q.hot),
    warm: num(q.warm),
    developing: num(q.developing),
    cold: num(q.cold),
    activeAverage:
      typeof q.activeAverage === 'number' && Number.isFinite(q.activeAverage)
        ? q.activeAverage
        : null,
    activeScored: num(q.activeScored),
    needsAttention: num(q.needsAttention),
  };
}

export interface DashboardMetrics {
  timezone: string;
  todayDate: string;
  bounds: { todayStart: string; tomorrowStart: string };
  period: string;
  totalLeads: number;
  activeLeads: number;
  converted: number;
  notInterested: number;
  statusCounts: DashboardStatusCounts;
  newLeads: number;
  responses: number;
  pipeline: number;
  pipelineLocked: number;
  alerts: number;
  contacted: number;
  meetings: number;
  followUps: number;
  projected: number;
  collected: number;
  sumAssured: number;
  conversionRate: string;
  conversionRateValue: number;
  /** Null when no authoritative first-contact TAT is available. Never a fabricated default. */
  avgResponseTAT: string | null;
  followUpsQueue: DashboardFollowUpCounts;
  followUpCounts: DashboardFollowUpCounts;
  agentStats: DashboardAgentStat[];
  teamStats: DashboardTeamStat[];
  campaignStats: DashboardCampaignStat[];
  /** Empty until the server provides real time-series points. */
  trendData?: Array<{ date: string; value: number }>;
  leadCount?: number;
  userCount?: number;
  /** Server-computed Lead Quality band distribution (undefined when absent). */
  quality?: DashboardQualityAggregate;
}

export type DashboardPeriod = 'TODAY' | 'THIS_MONTH' | 'LAST_MONTH' | 'CUSTOM' | 'ALL' | 'THIS MONTH' | 'LAST MONTH';

export interface DashboardQuery {
  period?: DashboardPeriod | string;
  selectedDate?: string;
  startDate?: string;
  endDate?: string;
}

function emptyMetrics(): DashboardMetrics {
  const zeroStatus: DashboardStatusCounts = {
    Untouched: 0,
    Contacted: 0,
    'No Response': 0,
    Busy: 0,
    Interested: 0,
    'Follow-up Set': 0,
    'Meeting Fixed': 0,
    'Meeting Completed': 0,
    'Pipeline Locked': 0,
    Converted: 0,
    'Not Interested': 0,
  };
  const zeroFu = { overdue: 0, today: 0, upcoming: 0, all: 0 };
  return {
    timezone: 'Asia/Dhaka',
    todayDate: '',
    bounds: { todayStart: '', tomorrowStart: '' },
    period: 'ALL',
    totalLeads: 0,
    activeLeads: 0,
    converted: 0,
    notInterested: 0,
    statusCounts: zeroStatus,
    newLeads: 0,
    responses: 0,
    pipeline: 0,
    pipelineLocked: 0,
    alerts: 0,
    contacted: 0,
    meetings: 0,
    followUps: 0,
    projected: 0,
    collected: 0,
    sumAssured: 0,
    conversionRate: '0.0%',
    conversionRateValue: 0,
    avgResponseTAT: null,
    followUpsQueue: zeroFu,
    followUpCounts: zeroFu,
    agentStats: [],
    teamStats: [],
    campaignStats: [],
    trendData: [],
  };
}

export const dashboardService = {
  /**
   * Fetch authoritative dashboard metrics from the server.
   * Throws on failure — callers must show error/loading state rather than
   * silently presenting stale local totals as current.
   */
  async getDashboard(query: DashboardQuery = {}): Promise<DashboardMetrics> {
    const qs = new URLSearchParams();
    if (query.period) qs.set('period', String(query.period));
    if (query.selectedDate) qs.set('selectedDate', query.selectedDate);
    if (query.startDate) qs.set('startDate', query.startDate);
    if (query.endDate) qs.set('endDate', query.endDate);
    const path = `/api/dashboard${qs.toString() ? `?${qs.toString()}` : ''}`;
    // GET read: concurrent identical requests (StrictMode double-effect,
    // refresh while a load is in flight) share one round-trip.
    const data = await coalesceGet(path, () => apiRequest<DashboardMetrics>(path));
    if (!data || typeof data !== 'object') {
      throw new Error('Dashboard response was empty.');
    }
    return {
      ...emptyMetrics(),
      ...data,
      statusCounts: { ...emptyMetrics().statusCounts, ...(data.statusCounts || {}) },
      followUpCounts: { ...emptyMetrics().followUpCounts, ...(data.followUpCounts || data.followUpsQueue || {}) },
      followUpsQueue: { ...emptyMetrics().followUpsQueue, ...(data.followUpsQueue || data.followUpCounts || {}) },
      agentStats: Array.isArray(data.agentStats) ? data.agentStats : [],
      teamStats: Array.isArray(data.teamStats) ? data.teamStats : [],
      campaignStats: Array.isArray(data.campaignStats) ? data.campaignStats : [],
      trendData: Array.isArray(data.trendData) ? data.trendData : [],
      // Server-computed quality aggregate — sanitized, never fabricated.
      quality: sanitizeQuality((data as { quality?: unknown }).quality),
      // Preserve null TAT — never coerce to a fabricated default hours value.
      avgResponseTAT: data.avgResponseTAT == null || data.avgResponseTAT === '' ? null : String(data.avgResponseTAT),
    };
  },
};
