/**
 * server/health.ts — liveness & readiness contracts
 * ------------------------------------------------------------------
 * Shared builders for the operational endpoints served by BOTH production
 * entrypoints (server.ts and api/index.ts).
 *
 * Conceptual distinction (see docs/PRODUCTION_READINESS.md):
 *
 *   LIVENESS  (/health, /api/health)  — the runtime can produce a response.
 *   READINESS (/health/readiness, /api/health/readiness) — the critical
 *       dependencies required for real business operations are available.
 *
 * The existing liveness body is preserved EXACTLY as established by earlier
 * PRs (some regression tests assert deep equality on it), so liveness is
 * intentionally NOT extended here. Readiness is a NEW, additive endpoint.
 *
 * Nothing in this module ever returns a secret, connection string, SQL
 * fragment, stack trace or host/credential detail.
 */

import { isProductionRuntime, validateProductionConfig, isWeakJwtSecret } from './config/env.js';

export type DatabaseReachability = boolean;

export interface ReadinessReport {
  /** Overall readiness: 'ready' only when every critical check passes. */
  status: 'ready' | 'not_ready';
  /** Service name / deployment identifier (safe, non-secret). */
  service: 'leadflow-api';
  checks: {
    /** Application runtime is able to respond (liveness). */
    runtime: { ok: boolean };
    /** Production configuration is present and valid. */
    config: {
      ok: boolean;
      /** Secret-free issue names only (e.g. 'JWT_SECRET'). */
      issues: string[];
    };
    /** Critical dependency: PostgreSQL. */
    database: {
      configured: boolean;
      reachable: boolean;
    };
  };
  /** Safe deployment identifier, or null when unavailable. */
  build: string | null;
  /** Environment identifier ('production' | 'vercel' | 'development' | ...). */
  environment: string;
  /** ISO-8601 timestamp of the report. */
  timestamp: string;
}

/**
 * Resolve a safe build identifier from the environment. Vercel injects
 * `VERCEL_GIT_COMMIT_SHA`; standalone operators may set `GIT_SHA` /
 * `COMMIT_SHA`. Never guesses or fabricates a value, never reads the
 * filesystem, never leaks anything else.
 */
export function resolveBuildIdentifier(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.VERCEL_GIT_COMMIT_SHA ||
    env.VERCEL_GIT_COMMIT_MESSAGE ||
    env.COMMIT_SHA ||
    env.GIT_SHA ||
    env.GIT_COMMIT ||
    null
  );
}

/** Short, safe environment identifier. */
export function resolveEnvironmentIdentifier(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERCEL) return 'vercel';
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
}

/**
 * Build the readiness report. `configured` / `reachable` describe the
 * database (typically from `isDatabaseConfigured()` / `checkDatabaseHealth()`
 * in database/connection.js). The report is safe to return to any client.
 */
export function buildReadinessReport(opts: {
  databaseConfigured: boolean;
  databaseReachable: boolean;
  env?: NodeJS.ProcessEnv;
}): ReadinessReport {
  const env = opts.env ?? process.env;
  const production = isProductionRuntime(env);
  const config = validateProductionConfig(env);

  const configOk = production ? config.valid : true;
  const runtimeOk = true; // responding at all is the liveness condition

  // Honest readiness: a production deployment that is misconfigured, or any
  // deployment that is configured for a database but cannot reach it, is
  // NOT ready for business operations.
  const databaseOk = opts.databaseConfigured && opts.databaseReachable;
  const ready = runtimeOk && configOk && databaseOk;

  return {
    status: ready ? 'ready' : 'not_ready',
    service: 'leadflow-api',
    checks: {
      runtime: { ok: runtimeOk },
      config: {
        ok: configOk,
        issues: config.issues.map((i) => i.name),
      },
      database: {
        configured: opts.databaseConfigured,
        reachable: opts.databaseReachable,
      },
    },
    build: resolveBuildIdentifier(env),
    environment: resolveEnvironmentIdentifier(env),
    timestamp: new Date().toISOString(),
  };
}

/**
 * A non-secret, single-line diagnostic of the readiness decision, suitable
 * for server-side logging (used by the entrypoints to keep operators
 * informed without logging any credential).
 */
export function describeReadiness(report: ReadinessReport): string {
  const c = report.checks;
  return (
    `readiness=${report.status} dbConfigured=${c.database.configured}` +
    ` dbReachable=${c.database.reachable} configOk=${c.config.ok}` +
    (c.config.issues.length ? ` configIssues=${c.config.issues.join(',')}` : '') +
    ` build=${report.build || 'unknown'}`
  );
}

/** Re-exported for the smoke script / tests to share the same definition. */
export { isWeakJwtSecret };
