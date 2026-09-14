/**
 * server/observability/http.ts — API request observability middleware
 * ------------------------------------------------------------------
 * Mounted FIRST inside applyProductionHttpSecurity() (before helmet, the
 * rate limiters and the body parsers) so that EVERY /api/* request —
 * including rate-limited 429s, body-parser rejections, 404s and error
 * responses — is observed identically on both entrypoints (server.ts and
 * api/index.ts).
 *
 * Per request it:
 *   1. resolves/generates the correlation id (see requestId.ts) and
 *      echoes it back as `X-Request-ID`;
 *   2. opens an AsyncLocalStorage request context (see context.ts) that
 *      DB instrumentation and event helpers read implicitly;
 *   3. when the response finishes, emits exactly ONE
 *      `http_request_complete` info event (O(1) — one bounded JSON line);
 *   4. emits an additional `http_request_slow` warning when the request
 *      exceeds OBSERVABILITY_SLOW_REQUEST_MS (the request still
 *      completes normally — slow is never a failure);
 *   5. classifies health/readiness/db-status probes as low-noise:
 *      successful probes log at DEBUG (invisible at the production
 *      default level), probe failures (5xx) stay visible as warnings.
 *
 * Privacy: the completion event is built from an allowlist only
 * (method, normalized route, status, durations, query count, safe user
 * id + role from the already-verified session claim, Server-Timing
 * summary). No query-string values, headers, bodies or credentials can
 * appear — the allowlist does not include them and redaction would strip
 * them even if it did.
 */

import type { NextFunction, Request, Response } from 'express';

import {
  getRequestContext,
  nowMs,
  round1,
  runWithRequestContext,
  type RequestObservabilityContext,
} from './context.js';
import { resolveSlowRequestThresholdMs } from './config.js';
import { logEvent } from './logger.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './requestId.js';

/* ==================================================================== */
/* Route normalization                                                  */
/* ==================================================================== */

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^[0-9]{4,}$/;
const MAX_ROUTE_LENGTH = 200;

/**
 * Normalizes a request pathname for logs: strips any query string (the
 * caller passes the raw path), masks per-entity segments (UUIDs, long
 * numeric ids), and caps the length. Business identifiers that are
 * legitimately part of a route (e.g. /users/:id) collapse to a stable
 * template-ish form instead of leaking record identity into every line.
 */
export function normalizeRoutePath(rawPath: string): string {
  const pathname = String(rawPath || '').split('?')[0] || '/';
  const segments = pathname.split('/').map((segment) => {
    if (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment)) return ':id';
    return segment;
  });
  let normalized = segments.join('/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length > MAX_ROUTE_LENGTH) {
    normalized = `${normalized.slice(0, MAX_ROUTE_LENGTH)}…`;
  }
  return normalized;
}

/* ==================================================================== */
/* Health-probe classification                                          */
/* ==================================================================== */

/**
 * Unauthenticated operational probes (uptime monitors). Successful
 * probes are expected and frequent: logging each at INFO would drown
 * real signal, so they are emitted at DEBUG (off by default in
 * production). Failures stay visible.
 */
export const HEALTH_PROBE_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/api/health',
  '/health/readiness',
  '/api/health/readiness',
  '/api/db-status',
]);

/* ==================================================================== */
/* Completion event                                                     */
/* ==================================================================== */

/**
 * The ONLY fields a request-completion event may contain. Query strings,
 * headers, bodies, credentials and PII are structurally excluded.
 */
export const REQUEST_COMPLETION_ALLOWLIST = [
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'dbQueryCount',
  'dbDurationMs',
  'userId',
  'role',
  'serverTiming',
] as const;

export const SLOW_REQUEST_ALLOWLIST = [
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'dbQueryCount',
  'dbDurationMs',
  'thresholdMs',
] as const;

const SERVER_TIMING_MAX = 300;

function logCompletion(req: Request, res: Response, ctx: RequestObservabilityContext): void {
  const durationMs = round1(nowMs() - ctx.startedAtMs);
  const status = typeof res.statusCode === 'number' ? res.statusCode : 0;

  // The session claim was verified by the existing auth middleware (never
  // from the request body). Only the user uuid and role code are taken —
  // never the email, name, employeeId or the token itself.
  const claim = (req as any).currentUser;
  const userId = typeof claim?.id === 'string' ? claim.id : undefined;
  const role = typeof claim?.role === 'string' ? claim.role : undefined;

  // Integration (not replacement) with the existing perf.ts spans: the
  // Server-Timing header that instrumented routes already set is echoed
  // into the log event. That header is built only from span labels and
  // durations (see server/utils/perf.ts), so it is safe and capped here.
  const serverTimingHeader = res.getHeader('Server-Timing');
  const serverTiming =
    typeof serverTimingHeader === 'string' && serverTimingHeader
      ? serverTimingHeader.slice(0, SERVER_TIMING_MAX)
      : undefined;

  const fields = {
    requestId: ctx.requestId,
    method: ctx.method,
    route: ctx.route,
    status,
    durationMs,
    dbQueryCount: ctx.dbQueryCount,
    dbDurationMs: round1(ctx.dbDurationMs),
    userId,
    role,
    serverTiming,
  };

  if (HEALTH_PROBE_PATHS.has(ctx.route)) {
    if (status >= 500) {
      logEvent('warn', 'http_probe_unhealthy', fields, REQUEST_COMPLETION_ALLOWLIST);
    } else {
      logEvent('debug', 'http_probe_complete', fields, REQUEST_COMPLETION_ALLOWLIST);
    }
  } else {
    logEvent('info', 'http_request_complete', fields, REQUEST_COMPLETION_ALLOWLIST);
  }

  const thresholdMs = resolveSlowRequestThresholdMs();
  if (durationMs >= thresholdMs) {
    logEvent(
      'warn',
      'http_request_slow',
      {
        requestId: ctx.requestId,
        method: ctx.method,
        route: ctx.route,
        status,
        durationMs,
        dbQueryCount: ctx.dbQueryCount,
        dbDurationMs: round1(ctx.dbDurationMs),
        thresholdMs,
      },
      SLOW_REQUEST_ALLOWLIST
    );
  }
}

/* ==================================================================== */
/* Middleware                                                           */
/* ==================================================================== */

/**
 * Express middleware: request-id generation/adoption, response header,
 * request context, completion + slow-request logging. Only `/api/*`
 * traffic is observed (the SPA shell and static assets are unchanged).
 */
export function createApiObservabilityMiddleware() {
  return function apiObservability(req: Request, res: Response, next: NextFunction): void {
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    if (!pathname.startsWith('/api')) {
      next();
      return;
    }

    const requestId = resolveRequestId(req as any);
    const ctx: RequestObservabilityContext = {
      requestId,
      method: req.method || 'UNKNOWN',
      route: normalizeRoutePath(pathname),
      startedAtMs: nowMs(),
      startedAtIso: new Date().toISOString(),
      dbQueryCount: 0,
      dbDurationMs: 0,
    };

    // Correlation header — present on EVERY api response (200s, 4xx, 429,
    // 5xx alike) because the middleware runs before them all.
    try {
      res.setHeader(REQUEST_ID_HEADER, requestId);
    } catch {
      // A correlation header must never break the response.
    }
    (req as any).requestId = requestId;

    runWithRequestContext(ctx, () => {
      res.on('finish', () => {
        try {
          logCompletion(req, res, ctx);
        } catch {
          // Observability must never break a finished response.
        }
      });
      next();
    });
  };
}

/** Exported for the API error handler: the active context, if any. */
export { getRequestContext };
