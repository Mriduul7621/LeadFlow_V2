/**
 * followUpSync.ts
 * ------------------------------------------------------------------
 * Flush engine for the offline follow-up outbox (Phase 3 PR #2).
 *
 * Sends queued follow-ups ONE AT A TIME, in submission order, each
 * with its original clientMutationId — the server applies a mutation
 * id exactly once (migration 050), so flushing is always safe to
 * retry. Outcomes per entry:
 *
 *   success        → entry removed; the authoritative lead from the
 *                    response is cached and a FOLLOWUP_SYNCED event
 *                    lets open screens refresh.
 *   network / 5xx  → attempts + 1 and the flush STOPS (connectivity
 *                    is still bad; order is preserved for next time).
 *   401            → the flush PAUSES untouched until the next login;
 *                    entries belong to their owner and are never sent
 *                    under a different user's session.
 *   other 4xx      → the server definitively rejected THIS payload
 *                    (e.g. the status rules changed while offline):
 *                    the entry moves to "Needs attention" with the
 *                    server's reason and is NEVER auto-discarded.
 *
 * Triggers (installed once from main.tsx): app start, the browser
 * `online` event, tab visibility returning, a fresh login, and the
 * manual "Sync now" action in the Workbench indicator. There is no
 * dependency on the Background Sync API (uneven browser support) —
 * these triggers cover the realistic field flows.
 */

import { useAuthStore } from '../../auth/store/authStore';
import { ApiError } from '../../shared/api/http';
import {
  isAttentionStatus,
  isAuthFailureStatus,
  nextQueuedEntry,
} from '../utils/followUpOutboxCore';
import {
  listOutboxEntries,
  recordAttention,
  recordAttemptFailed,
  recordSynced,
} from './followUpOutbox';
import { postFollowUpOnce } from './leadService';

let flushing = false;
let installed = false;

export async function flushFollowUpOutbox(): Promise<void> {
  if (flushing) return;
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  flushing = true;
  try {
    for (;;) {
      // Re-read every iteration: entries change as we record outcomes,
      // and the session could end mid-flush — never send one user's
      // queue under another's login.
      const sessionUserId = useAuthStore.getState().user?.id;
      if (!sessionUserId || sessionUserId !== userId) break;
      const entry = nextQueuedEntry(listOutboxEntries(), userId);
      if (!entry) break;
      if (entry.userId !== userId) break; // ownership re-check (defence in depth)

      try {
        await postFollowUpOnce(entry.leadId, entry.payload, entry.mutationId);
        recordSynced(entry.mutationId, entry.leadId);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        const message =
          (err as any)?.message || 'Could not reach the server. Please check your connection.';
        if (isAuthFailureStatus(status)) {
          break; // pause until next login; entry untouched
        }
        if (isAttentionStatus(status)) {
          recordAttention(entry.mutationId, message);
          continue; // a rejected entry must not block the rest of the queue
        }
        recordAttemptFailed(entry.mutationId, message);
        break; // still offline / server down: keep order, retry on next trigger
      }
    }
  } finally {
    flushing = false;
  }
}

/** Manual trigger (Workbench indicator "Sync now"). */
export function syncFollowUpsNow(): void {
  void flushFollowUpOutbox();
}

export function installFollowUpOutboxSync(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('online', () => void flushFollowUpOutbox());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushFollowUpOutbox();
  });
  // Fresh login (or session restore): flush whatever this user queued.
  useAuthStore.subscribe(state => {
    if (state.isAuthenticated && state.user) void flushFollowUpOutbox();
  });
  // App start.
  void flushFollowUpOutbox();
}
