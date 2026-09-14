/**
 * server/observability/dbTiming.ts — PostgreSQL timing instrumentation
 * ------------------------------------------------------------------
 * The smallest safe hook for per-request DB timing: instead of rewriting
 * every query site, the Pool's `query` method is wrapped ONCE (at pool
 * creation in database/connection.ts). Every instrumented query then:
 *
 *   - records its duration into the active request context
 *     (dbQueryCount / dbDurationMs), when a request is in scope;
 *   - emits ONE `db_query_slow` warning when a single operation exceeds
 *     OBSERVABILITY_SLOW_DB_MS.
 *
 * Hard privacy rule: no SQL text and no query parameters are EVER logged
 * or stored — only durations and counts. There are no per-query info logs
 * by default (that would be log spam); only the aggregate on the request
 * completion event plus the slow-query warning.
 *
 * Compatibility:
 *   - supports both the promise style (`pool.query(text, values)`) and
 *     the callback style (`pool.query(text, values, cb)`) of node-pg;
 *   - idempotent (a pool is wrapped at most once, marked by symbol);
 *   - works unchanged for the PGlite test pool and the production Pool —
 *     tests that replace `pool.query` afterwards simply wrap this wrapper;
 *   - outside a request scope (startup, scripts, background jobs) the
 *     hook costs two clock reads and records nothing.
 */

import { getRequestContext, nowMs, recordDbQuery, round1 } from './context.js';
import { resolveSlowDbThresholdMs } from './config.js';
import { logEvent } from './logger.js';

/** Marker so a pool is instrumented at most once. */
const INSTRUMENTED = Symbol.for('leadflow.observability.dbInstrumented');

export const SLOW_DB_ALLOWLIST = ['requestId', 'durationMs', 'thresholdMs'] as const;

function settleAndReport(startedAtMs: number): void {
  const durationMs = round1(nowMs() - startedAtMs);
  recordDbQuery(durationMs);

  const thresholdMs = resolveSlowDbThresholdMs();
  if (durationMs >= thresholdMs) {
    const ctx = getRequestContext();
    // Count + duration only: NEVER SQL text or parameters.
    logEvent(
      'warn',
      'db_query_slow',
      { requestId: ctx?.requestId, durationMs, thresholdMs },
      SLOW_DB_ALLOWLIST
    );
  }
}

/**
 * Wraps `pool.query` with duration measurement. Safe to call on every
 * `getPool()` — subsequent calls are no-ops.
 */
export function instrumentPoolForObservability(pool: any): void {
  if (!pool || typeof pool.query !== 'function') return;
  if ((pool as any)[INSTRUMENTED]) return;

  const original: (...args: any[]) => any = pool.query.bind(pool);

  try {
    Object.defineProperty(pool, INSTRUMENTED, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    (pool as any)[INSTRUMENTED] = true;
  }

  (pool as any).query = function instrumentedQuery(...args: any[]): any {
    const startedAtMs = nowMs();
    const last = args[args.length - 1];

    // Callback style: time up to the callback, preserving its contract.
    if (typeof last === 'function') {
      args[args.length - 1] = (err: any, result: any) => {
        settleAndReport(startedAtMs);
        last(err, result);
      };
      return original(...args);
    }

    // Promise style (the style every LeadFlow query helper uses).
    try {
      const pending = original(...args);
      return Promise.resolve(pending).then(
        (result) => {
          settleAndReport(startedAtMs);
          return result;
        },
        (error) => {
          settleAndReport(startedAtMs);
          throw error;
        }
      );
    } catch (error) {
      settleAndReport(startedAtMs);
      throw error;
    }
  };
}
