/**
 * followUpOutbox.ts
 * ------------------------------------------------------------------
 * Durable on-device outbox for follow-up submissions (Phase 3 PR #2).
 *
 * Storage: localStorage, ONE key per user —
 * `shanta_followup_outbox:<userId>` — holding that user's entries
 * (each entry is also tagged with its owner's id; see
 * utils/followUpOutboxCore.ts for the pure queue logic).
 *
 * Why this is NOT one of the localDb read caches: those are wiped on
 * logout by design (they are read mirrors). An outbox is a WRITE
 * queue — deleting it on logout would silently destroy an agent's
 * unsynced field work, which is the one thing this feature must never
 * do. Entries therefore survive logout and session expiry; they are
 * only ever listed, synced, retried or discarded while THEIR owner
 * is the signed-in user, and the flush engine re-checks ownership
 * before every send. Nothing here is ever read as business data.
 *
 * The queue mutation helpers are thin persistence wrappers over the
 * pure core functions; every mutation broadcasts
 * FOLLOWUP_OUTBOX_CHANGED so the Workbench indicator stays live.
 */

import { useAuthStore } from '../../auth/store/authStore';
import {
  enqueueEntry,
  entriesForUser,
  markAttemptFailed,
  markAttention,
  newMutationId,
  outboxCounts,
  removeEntry,
  requeueEntry,
  type FollowUpOutboxEntry,
  type OutboxCounts,
} from '../utils/followUpOutboxCore';

export type { FollowUpOutboxEntry, OutboxCounts };

export const FOLLOWUP_OUTBOX_CHANGED = 'leadflow:followup-outbox-changed';
export const FOLLOWUP_SYNCED = 'leadflow:followup-synced';

/**
 * Thrown by leadService.updateLeadStatus when a submission could not
 * reach the server and was saved to the outbox instead. Call sites
 * catch this SPECIFIC error to show "Saved offline — will sync"
 * rather than a failure message. Carries the queued entry.
 */
export class FollowUpQueuedOfflineError extends Error {
  readonly entry: FollowUpOutboxEntry;
  constructor(entry: FollowUpOutboxEntry) {
    super('Saved offline — this follow-up will sync automatically when you are back online.');
    this.name = 'FollowUpQueuedOfflineError';
    this.entry = entry;
  }
}

const STORAGE_BASE = 'shanta_followup_outbox';

function sanitizeId(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '');
}

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

function storageKey(userId: string): string {
  return `${STORAGE_BASE}:${sanitizeId(userId)}`;
}

function readEntries(userId: string): FollowUpOutboxEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(userId: string, entries: FollowUpOutboxEntry[]): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(entries));
  } catch {
    // Storage full/blocked: the in-memory submission was already
    // reported to the caller as queued only when the write path
    // succeeded — see enqueueFollowUp, which verifies persistence.
    throw new Error('Could not save the follow-up on this device (storage unavailable).');
  }
}

export function notifyOutboxChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(FOLLOWUP_OUTBOX_CHANGED));
  } catch {
    // Non-browser context (SSR/tests): nothing to notify.
  }
}

function notifyFollowUpSynced(leadId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(FOLLOWUP_SYNCED, { detail: { leadId } }));
  } catch {
    // ignore
  }
}

/**
 * Queue a follow-up submission for the CURRENT user. Verifies the
 * entry actually persisted before returning it — the caller reports
 * "saved offline" to the agent, so a silent storage failure must
 * surface as a real error instead.
 */
export function enqueueFollowUp(input: {
  leadId: string;
  leadLabel: string;
  payload: Record<string, any>;
  mutationId?: string;
}): FollowUpOutboxEntry {
  const userId = currentUserId();
  if (!userId) {
    throw new Error('You are not signed in, so this follow-up cannot be saved offline.');
  }
  const entry: FollowUpOutboxEntry = {
    mutationId: input.mutationId || newMutationId(),
    leadId: input.leadId,
    leadLabel: input.leadLabel || input.leadId,
    userId,
    payload: input.payload,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    state: 'queued',
  };
  const next = enqueueEntry(readEntries(userId), entry);
  writeEntries(userId, next);
  if (!readEntries(userId).some(e => e.mutationId === entry.mutationId)) {
    throw new Error('Could not save the follow-up on this device (storage unavailable).');
  }
  notifyOutboxChanged();
  return entry;
}

/** The current user's entries (FIFO). Empty when signed out. */
export function listOutboxEntries(): FollowUpOutboxEntry[] {
  const userId = currentUserId();
  if (!userId) return [];
  return entriesForUser(readEntries(userId), userId);
}

export function getOutboxCounts(): OutboxCounts {
  const userId = currentUserId();
  if (!userId) return { pending: 0, attention: 0, total: 0 };
  return outboxCounts(readEntries(userId), userId);
}

export function recordAttemptFailed(mutationId: string, error: string): void {
  const userId = currentUserId();
  if (!userId) return;
  writeEntries(userId, markAttemptFailed(readEntries(userId), mutationId, error));
  notifyOutboxChanged();
}

export function recordAttention(mutationId: string, reason: string): void {
  const userId = currentUserId();
  if (!userId) return;
  writeEntries(userId, markAttention(readEntries(userId), mutationId, reason));
  notifyOutboxChanged();
}

export function recordSynced(mutationId: string, leadId: string): void {
  const userId = currentUserId();
  if (!userId) return;
  writeEntries(userId, removeEntry(readEntries(userId), mutationId));
  notifyOutboxChanged();
  notifyFollowUpSynced(leadId);
}

/** Explicit user actions from the pending list — never automatic. */
export function discardOutboxEntry(mutationId: string): void {
  const userId = currentUserId();
  if (!userId) return;
  writeEntries(userId, removeEntry(readEntries(userId), mutationId));
  notifyOutboxChanged();
}

export function retryOutboxEntry(mutationId: string): void {
  const userId = currentUserId();
  if (!userId) return;
  writeEntries(userId, requeueEntry(readEntries(userId), mutationId));
  notifyOutboxChanged();
}
