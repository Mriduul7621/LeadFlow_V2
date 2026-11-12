import { apiRequest, jsonBody } from '../../shared/api/http';

/**
 * dangerZoneService.ts
 * ------------------------------------------------------------------
 * Client for Settings → Danger Zone (Admin Control programme,
 * slice DZ-0). The server is the real gate: it re-resolves the
 * caller's role from the database on every request (a token that
 * claims ADMIN is not enough) and requires a fresh password
 * step-up — a 10-minute, non-sliding unlock — before the overview
 * can be read.
 *
 * The client keeps NO unlock state of its own: it asks the server
 * for status when the section opens and whenever it acts, and drops
 * back to the password prompt whenever the server answers
 * `danger_zone_locked`. Nothing is stored in localStorage.
 */

export interface DangerZoneStatus {
  isSuperAdmin: boolean;
  unlocked: boolean;
  unlockedUntil: string | null;
  secondsRemaining: number;
  unlockLifetimeMinutes: number;
}

export interface DangerZoneRuleCard {
  id: string;
  title: string;
  rule: string;
  currentValue: string;
  source: string;
}

export interface DangerZoneOverview {
  unlock: { unlockedUntil: string; secondsRemaining: number };
  invariants: string[];
  cards: DangerZoneRuleCard[];
}

/**
 * Lead Quality config (DZ-3, audit §2.6 F1–F6). The effective
 * `config` is keyed by current status NAME; the write payload keys
 * status points by dictionary-entry ID (`statusPoints`), which the
 * editor takes from `statusOptions[].id` — renaming a status never
 * detaches its points.
 */
export interface LeadQualityLadderRung {
  maxDays: number | null;
  points: number;
}

export interface LeadQualityConfig {
  version: number;
  baseScore: number;
  thresholds: { hot: number; warm: number; developing: number };
  statusPoints: Record<string, number>;
  advancedStatuses: string[];
  recency: LeadQualityLadderRung[];
  engagement: { pointsPerEvent: number; maxEvents: number };
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  investment: { points: number };
}

export interface LeadQualityStatusOption {
  id: string;
  value: string;
  label: string;
  isActive: boolean;
  isTerminal: boolean;
  points: number;
  defaultPoints: number;
  advanced: boolean;
  defaultAdvanced: boolean;
}

export interface LeadQualityLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: LeadQualityConfig | null;
  newValue: LeadQualityConfig;
}

export interface LeadQualityConfigForEdit {
  version: number;
  config: LeadQualityConfig;
  defaults: LeadQualityConfig;
  statusOptions: LeadQualityStatusOption[];
  lastChange: LeadQualityLastChange | null;
  scale: { min: number; max: number };
}

export interface LeadQualityConfigInput {
  baseScore: number;
  thresholds: { hot: number; warm: number; developing: number };
  /** Keyed by FollowUpStatus dictionary-entry id. */
  statusPoints: Record<string, number>;
  advancedStatusIds: string[];
  recency: LeadQualityLadderRung[];
  engagement: { pointsPerEvent: number; maxEvents: number };
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  investment: { points: number };
}

export const dangerZoneService = {
  async getStatus(): Promise<DangerZoneStatus> {
    return apiRequest<DangerZoneStatus>('/api/danger-zone/status');
  },

  /**
   * Unlock uses a RAW fetch on purpose (the same pattern as the
   * change-password call in Settings): a wrong password is a 401,
   * and the shared apiRequest layer treats a 401 that carried the
   * active session token as a dead session and logs the user out.
   * A mistyped Danger Zone password must only ever show the generic
   * error — never end the session. The global authenticated fetch
   * (lib/apiClient) still attaches the session token.
   */
  async unlock(password: string): Promise<{ unlocked: boolean; unlockedUntil: string; expiresInSeconds: number }> {
    let res: Response;
    try {
      res = await fetch('/api/danger-zone/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      throw new Error('Unable to reach the server. Please check your connection and try again.');
    }
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      throw new Error(body?.message || 'Unlock failed. Check your password and try again.');
    }
    return body as { unlocked: boolean; unlockedUntil: string; expiresInSeconds: number };
  },

  async lock(): Promise<void> {
    await apiRequest('/api/danger-zone/lock', { method: 'POST', ...jsonBody({}) });
  },

  async getOverview(): Promise<DangerZoneOverview> {
    return apiRequest<DangerZoneOverview>('/api/danger-zone/overview');
  },

  async getLeadQuality(): Promise<LeadQualityConfigForEdit> {
    return apiRequest<LeadQualityConfigForEdit>('/api/danger-zone/lead-quality');
  },

  async saveLeadQuality(input: LeadQualityConfigInput): Promise<LeadQualityConfigForEdit> {
    return apiRequest<LeadQualityConfigForEdit>('/api/danger-zone/lead-quality', {
      method: 'PUT',
      ...jsonBody(input),
    });
  },
};
