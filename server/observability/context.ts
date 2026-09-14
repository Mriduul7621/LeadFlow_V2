/**
 * server/observability/context.ts — request observability context
 * ------------------------------------------------------------------
 * Carries the per-request correlation state used by the observability
 * pipeline:
 *
 *   - requestId      — server-generated correlation id (X-Request-ID)
 *   - method/route   — normalized, query-free request identity
 *   - startedAtMs    — monotonic start timestamp for duration math
 *   - dbQueryCount   — PostgreSQL queries issued on behalf of the request
 *   - dbDurationMs   — accumulated PostgreSQL time on behalf of the request
 *
 * Serverless concurrency safety is provided by `node:async_hooks`
 * AsyncLocalStorage: every request runs inside its own `als.run(ctx, …)`
 * scope (installed by server/observability/http.ts), so concurrent Vercel
 * invocations inside one warm function instance NEVER see each other's
 * context. There is no global mutable request state — the storage slot is
 * empty outside a request scope, nothing is written after the response
 * finishes, and the context object becomes garbage with the request.
 *
 * Nothing here is persisted: no PostgreSQL writes, no filesystem writes,
 * no network calls. See docs/PRODUCTION_OBSERVABILITY.md.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestObservabilityContext {
  /** Server-side correlation id echoed as the X-Request-ID response header. */
  requestId: string;
  /** HTTP method (GET, POST, …). */
  method: string;
  /** Normalized route path — no query string, no raw id/UUID segments. */
  route: string;
  /** Monotonic start (performance.now epoch), for duration computation. */
  startedAtMs: number;
  /** Wall-clock start (ISO-8601), for the completion event timestamp. */
  startedAtIso: string;
  /** Number of instrumented PostgreSQL queries completed for this request. */
  dbQueryCount: number;
  /** Accumulated instrumented PostgreSQL time in ms (rounded at read time). */
  dbDurationMs: number;
}

const storage = new AsyncLocalStorage<RequestObservabilityContext>();

/** Rounds to one decimal, matching the existing perf.ts convention. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Monotonic clock (no wall-clock jumps); mirrors server/utils/perf.ts. */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Runs `fn` inside the request observability scope. */
export function runWithRequestContext<T>(
  ctx: RequestObservabilityContext,
  fn: () => T
): T {
  return storage.run(ctx, fn);
}

/** The active request context, or undefined outside a request scope. */
export function getRequestContext(): RequestObservabilityContext | undefined {
  return storage.getStore();
}

/**
 * Records one completed PostgreSQL query against the active request.
 * No-op outside a request scope (background jobs, startup probes), so the
 * DB instrumentation never needs to know whether a request exists.
 */
export function recordDbQuery(durationMs: number): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  ctx.dbQueryCount += 1;
  ctx.dbDurationMs += durationMs;
}
