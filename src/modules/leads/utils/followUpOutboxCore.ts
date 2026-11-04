/**
 * followUpOutboxCore.ts
 * ------------------------------------------------------------------
 * Pure queue logic for the offline follow-up outbox (Phase 3 PR #2).
 *
 * Field agents submit follow-ups (POST /api/leads/:id/follow-up —
 * server-authoritative) from low-network areas. When the request
 * fails with a NETWORK error, the submission is kept in a durable
 * on-device outbox and flushed later with the SAME clientMutationId;
 * the server applies each mutation id exactly once (migration 050),
 * so a retry can never double-apply a follow-up.
 *
 * This module is deliberately free of storage / DOM / network: every
 * function takes the entry list and returns a new one, so the whole
 * state machine is unit-testable. Storage lives in
 * services/followUpOutbox.ts, the flush engine in
 * services/followUpSync.ts.
 *
 * Entry lifecycle:
 *   queued ──flush success──▶ (removed)
 *   queued ──server 4xx─────▶ attention   (visible, reason kept,
 *   attention ──Retry───────▶ queued       NEVER auto-discarded)
 *   attention ──Discard─────▶ (removed, explicit user action only)
 *   queued ──network/5xx────▶ queued (attempts + 1, flush pauses)
 *   any ──401───────────────▶ unchanged (flush pauses until re-login)
 */

export interface FollowUpOutboxEntry {
  /** Client-minted UUID, reused on every retry of this submission. */
  mutationId: string;
  leadId: string;
  /** Display snapshot (prospect name / lead code) for the pending list. */
  leadLabel: string;
  /** Owner: only this user may sync, retry or discard the entry. */
  userId: string;
  /** Business fields exactly as submitted (status, remarks, dates…). */
  payload: Record<string, any>;
  /** ISO timestamp of the original submission. */
  queuedAt: string;
  attempts: number;
  state: 'queued' | 'attention';
  /** Server's rejection reason (attention) or last transient error. */
  lastError?: string;
}

/** Mint a UUID v4 mutation id (crypto.randomUUID when available). */
export function newMutationId(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Append a submission; a duplicate mutation id is never queued twice. */
export function enqueueEntry(
  entries: FollowUpOutboxEntry[],
  entry: FollowUpOutboxEntry
): FollowUpOutboxEntry[] {
  if (entries.some(e => e.mutationId === entry.mutationId)) return entries;
  return [...entries, entry];
}

/** Entries owned by a user, in original (FIFO) order. */
export function entriesForUser(
  entries: FollowUpOutboxEntry[],
  userId: string
): FollowUpOutboxEntry[] {
  return entries.filter(e => e.userId === userId);
}

/** The next entry the flush engine should attempt for a user. */
export function nextQueuedEntry(
  entries: FollowUpOutboxEntry[],
  userId: string
): FollowUpOutboxEntry | undefined {
  return entries.find(e => e.userId === userId && e.state === 'queued');
}

export function removeEntry(
  entries: FollowUpOutboxEntry[],
  mutationId: string
): FollowUpOutboxEntry[] {
  return entries.filter(e => e.mutationId !== mutationId);
}

/** Record a transient failure (network / 5xx): stays queued, attempts + 1. */
export function markAttemptFailed(
  entries: FollowUpOutboxEntry[],
  mutationId: string,
  error: string
): FollowUpOutboxEntry[] {
  return entries.map(e =>
    e.mutationId === mutationId
      ? { ...e, attempts: e.attempts + 1, lastError: error }
      : e
  );
}

/** Record a definitive server rejection: visible until the user acts. */
export function markAttention(
  entries: FollowUpOutboxEntry[],
  mutationId: string,
  reason: string
): FollowUpOutboxEntry[] {
  return entries.map(e =>
    e.mutationId === mutationId
      ? { ...e, attempts: e.attempts + 1, state: 'attention' as const, lastError: reason }
      : e
  );
}

/** User chose Retry on an attention item: back to the queue. */
export function requeueEntry(
  entries: FollowUpOutboxEntry[],
  mutationId: string
): FollowUpOutboxEntry[] {
  return entries.map(e =>
    e.mutationId === mutationId
      ? { ...e, state: 'queued' as const, lastError: undefined }
      : e
  );
}

export interface OutboxCounts {
  pending: number;
  attention: number;
  total: number;
}

export function outboxCounts(
  entries: FollowUpOutboxEntry[],
  userId: string
): OutboxCounts {
  const mine = entriesForUser(entries, userId);
  const attention = mine.filter(e => e.state === 'attention').length;
  return { pending: mine.length - attention, attention, total: mine.length };
}

/** fetch() itself failed — no response at all (ApiError status 0). */
export function isNetworkFailureStatus(status: number): boolean {
  return status === 0;
}

/** Session refused: pause the whole flush until the next login. */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401;
}

/**
 * A definitive server rejection (validation, permission, conflict…):
 * retrying the identical payload cannot succeed — needs a human.
 * 409 is included deliberately: the server uses it for "this mutation
 * was already applied but its outcome snapshot is unavailable".
 */
export function isAttentionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401;
}
