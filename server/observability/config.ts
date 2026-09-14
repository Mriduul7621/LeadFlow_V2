/**
 * server/observability/config.ts — tunable observability thresholds
 * ------------------------------------------------------------------
 * Pure, env-injectable resolution of the operator-tunable knobs. Every
 * value has a safe default and a safe fallback: a missing, non-numeric or
 * non-positive value NEVER disables detection (and never throws).
 *
 *   OBSERVABILITY_SLOW_REQUEST_MS (default 2000)
 *     Requests taking at least this long emit an extra
 *     `http_request_slow` warning event (the request itself completes
 *     normally — slow is never a failure).
 *
 *   OBSERVABILITY_SLOW_DB_MS (default 750)
 *     A single instrumented PostgreSQL operation taking at least this
 *     long emits a `db_query_slow` warning (count + duration only,
 *     never SQL text or parameters).
 *
 *   OBSERVABILITY_LOG_LEVEL — resolved in logger.ts (debug|info|warn|error).
 */

export const DEFAULT_SLOW_REQUEST_MS = 2000;
export const DEFAULT_SLOW_DB_MS = 750;

function parseThreshold(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw || !raw.trim()) return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // Absurd ceilings (> 10 minutes) are treated as a typo and fall back.
  if (value > 600_000) return fallback;
  return value;
}

/** Slow-request warning threshold (ms). */
export function resolveSlowRequestThresholdMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseThreshold(env.OBSERVABILITY_SLOW_REQUEST_MS, DEFAULT_SLOW_REQUEST_MS);
}

/** Slow single-query warning threshold (ms). */
export function resolveSlowDbThresholdMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseThreshold(env.OBSERVABILITY_SLOW_DB_MS, DEFAULT_SLOW_DB_MS);
}
