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
 * Two independent gates (must not share one `settled` flag):
 *
 *   1. First-dashboard-critical (`waitForCriticalStartup`)
 *      Settled ONLY when GET /api/dashboard of this authenticated
 *      session has finished (success OR failure). Today/upcoming
 *      follow-ups wait on this. A visit to /workbench, /users, /leads
 *      MUST NOT mark it — otherwise the later first Dashboard load
 *      would start follow-ups concurrently with the KPI request.
 *
 *   2. Shell / non-dashboard readiness (`waitForShellStartup`)
 *      Notifications and options warm-up wait here so they do not
 *      hang when the first protected route is not Dashboard. AppLayout
 *      marks this on any path other than `/`. The first Dashboard KPI
 *      settle also marks it (so landing on `/` still defers them).
 *
 * After the first Dashboard critical request of the session settles,
 * later Dashboard revisits resolve immediately (no re-sequencing,
 * no deadlock). Logout resets BOTH gates.
 *
 * Rules:
 * - No timers, no sleeps, no global serialization of business requests.
 * - Waiters resolve the instant their gate settles — a failed KPI load
 *   must not pin follow-ups forever.
 * - Logout drops in-flight waiters (not resolved) so they cannot fetch
 *   under the next user's token.
 *
 * Marker for post-deploy mobile comparison (Performance Diagnostics):
 *   STARTUP_CRITICAL = GET /api/dashboard
 */

let dashboardSettled = false;
let dashboardWaiters: Array<() => void> = [];

let shellSettled = false;
let shellWaiters: Array<() => void> = [];

function release(waiters: Array<() => void>): void {
  const pending = waiters;
  for (const resolve of pending) resolve();
}

/** True once THIS session's first GET /api/dashboard has settled. */
export function isCriticalStartupSettled(): boolean {
  return dashboardSettled;
}

/** True once shell waiters (notifications / options) may proceed. */
export function isShellStartupSettled(): boolean {
  return shellSettled;
}

/**
 * Release first-dashboard waiters. Idempotent. Also unblocks the shell
 * gate: a Dashboard landing is the critical path those waiters were
 * deferring for. AppLayout must NEVER call this on non-`/` routes.
 */
export function markCriticalStartupSettled(): void {
  if (!dashboardSettled) {
    dashboardSettled = true;
    const pending = dashboardWaiters;
    dashboardWaiters = [];
    release(pending);
  }
  markShellStartupSettled();
}

/**
 * Unblock notifications / options without claiming the first Dashboard
 * KPI has run. Used by AppLayout on every path other than `/`.
 */
export function markShellStartupSettled(): void {
  if (shellSettled) return;
  shellSettled = true;
  const pending = shellWaiters;
  shellWaiters = [];
  release(pending);
}

/**
 * Resolve when THIS session's first GET /api/dashboard has settled.
 * Already-settled callers (later Dashboard revisits) get a resolved
 * promise so they never deadlock.
 */
export function waitForCriticalStartup(): Promise<void> {
  if (dashboardSettled) return Promise.resolve();
  return new Promise<void>(resolve => {
    dashboardWaiters.push(resolve);
  });
}

/**
 * Resolve when shell chrome may fetch. Settled by a non-dashboard
 * route OR by the first Dashboard KPI — whichever happens first.
 */
export function waitForShellStartup(): Promise<void> {
  if (shellSettled) return Promise.resolve();
  return new Promise<void>(resolve => {
    shellWaiters.push(resolve);
  });
}

/**
 * Called on logout so the next login re-enters first-dashboard
 * sequencing. In-flight waiters from the signed-out session are
 * dropped (not resolved).
 */
export function resetStartupPriority(): void {
  dashboardSettled = false;
  shellSettled = false;
  dashboardWaiters = [];
  shellWaiters = [];
}
