import { WorkflowRule } from '../../shared/types';
import { apiRequest, jsonBody, ApiError } from '../../shared/api/http';
import { shouldFallBackToCache } from '../../shared/api/offlinePolicy';

/**
 * workflowService.ts
 * ------------------------------------------------------------------
 * Client for the Workflow Engine (Phase 3). Rules are deliberately
 * permissive by default (allowedNextStatuses = null means "any status
 * is reachable"), so existing deployments behave exactly as before
 * unless the admin explicitly restricts a status's next steps through
 * Settings > Workflow. The two requirement flags (Loss Reason, Meeting
 * Type) add genuinely new, previously-unenforced business rules.
 *
 * Writes are DB-first: saveRule/deleteRule only report success after the
 * API (and therefore PostgreSQL) commits. Reads default to "no
 * restrictions" only when the server is unreachable/failing - 4xx
 * responses (e.g. expired session) surface as errors instead.
 */

let cache: WorkflowRule[] | null = null;

function isOfflineError(err: unknown): boolean {
  if (err instanceof ApiError) return shouldFallBackToCache(err.status);
  return true;
}

export const workflowService = {
  async getRules(forceRefresh = false): Promise<WorkflowRule[]> {
    if (cache && !forceRefresh) return cache;
    try {
      cache = await apiRequest<WorkflowRule[]>('/api/workflow-rules');
      return cache;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      return cache || [];
    }
  },

  async saveRule(rule: Partial<WorkflowRule>): Promise<WorkflowRule> {
    const saved = await apiRequest<WorkflowRule>('/api/workflow-rules', jsonBody(rule));
    cache = null;
    return saved;
  },

  async deleteRule(id: string): Promise<void> {
    await apiRequest(`/api/workflow-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    cache = null;
  },

  /** Which statuses `fromStatus` is allowed to move to. Unrestricted (returns all) if no rule exists. */
  getAllowedNextStatuses(fromStatus: string, allStatuses: string[], rules: WorkflowRule[]): string[] {
    const rule = rules.find(r => r.status === fromStatus);
    if (!rule || !rule.allowedNextStatuses || rule.allowedNextStatuses.length === 0) {
      return allStatuses;
    }
    // Always allow staying in the same status (no-op) and the configured targets.
    return Array.from(new Set([...rule.allowedNextStatuses, fromStatus]));
  },

  /** What extra fields are required for a lead to move INTO `toStatus`. */
  getRequirements(toStatus: string, rules: WorkflowRule[]): { requiresLossReason: boolean; requiresMeetingType: boolean; requiresFollowUpType: boolean; requiresNote: boolean } {
    const rule = rules.find(r => r.status === toStatus);
    return {
      requiresLossReason: !!rule?.requiresLossReason,
      requiresMeetingType: !!rule?.requiresMeetingType,
      requiresFollowUpType: !!rule?.requiresFollowUpType,
      requiresNote: !!rule?.requiresNote,
    };
  },

  clearCache() {
    cache = null;
  },
};
