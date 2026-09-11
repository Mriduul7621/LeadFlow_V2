/**
 * startupPriority.ts
 * ------------------------------------------------------------------
 * Deterministic first-login / first-dashboard request sequencing.
 *
 * Why this exists: mobile production diagnostics showed
 *   GET /api/dashboard                         client 47.6 s  (Server-Timing 1.6 s)
 *   GET /api/leads/follow-ups?bucket=today     client 46.8 s
 *   GET /api/leads/follow-ups?bucket=upcoming  client 45.1 s
 * while nearby GETs finished in 0.5–1.2 s. Backend SQL does not explain
 * the 45 s waits — the three heavy reads were launched together and
 * sat behind browser connection contention. This module lets the
 * Dashboard mark the critical KPI request as settled so noncritical
 * startup reads (follow-up buckets, scheduled activities, notification
 * refresh, lead-status warm-up) start AFTER that, with no setTimeout
 * and no global fetch queue.
 *
 * Rules:
 * - No timers, no sleeps, no global serialization of business requests.
 * - Waiters resolve the instant critical startup settles (success OR
 *   failure) — a failed KPI load must not pin follow-ups forever.
 * - Logout resets the gate so the next session sequences again.
 * - Non-dashboard routes mark settled immediately (there is no KPI
 *   request to wait for, so deferred reads must not hang).
 *
 * Marker for post-deploy mobile comparison (Performance Diagnostics):
 *   STARTUP_CRITICAL = GET /api/dashboard
 */

let settled = false;
let waiters: Array<() => void> = [];

/** True once the critical first-dashboard request has settled (or there is none). */
export function isCriticalStartupSettled(): boolean {
  return settled;
}

/**
 * Release every waiter. Idempotent: a second call is a no-op so a
 * dashboard unmount and a non-dashboard route effect can both fire.
 */
export function markCriticalStartupSettled(): void {
  if (settled) return;
  settled = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/**
 * Resolve when critical startup has settled. Already-settled callers
 * get a resolved promise (refresh / later navigation never block).
 */
export function waitForCriticalStartup(): Promise<void> {
  if (settled) return Promise.resolve();
  return new Promise<void>(resolve => {
    waiters.push(resolve);
  });
}

/**
 * Called on logout so the next login re-enters the first-dashboard
 * sequence. In-flight waiters from the signed-out session are dropped
 * (not resolved) — those callers belong to unmounting components and
 * must not start fetches under the next user's token.
 */
export function resetStartupPriority(): void {
  settled = false;
  waiters = [];
}
