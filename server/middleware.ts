/**
 * server/middleware.ts — production HTTP security middleware
 * ------------------------------------------------------------------
 * Single source of truth for the request-level protections mounted by
 * BOTH production entrypoints:
 *
 *   1. `server.ts`      — standalone / Docker (`npm start`, `npm run dev`)
 *   2. `api/index.ts`   — Vercel serverless function
 *
 * HISTORY (why this file was rewritten): `securityHeaders`, `apiLimiter`
 * and `authLimiter` used to be DEFINED here but imported by nobody, so
 * production requests received no security headers, no rate limiting and
 * the process-wide 50 MB JSON parser accepted any body size. Defining a
 * middleware is not mounting it. Everything below is now applied through
 * `applyProductionHttpSecurity()`, which both entrypoints call before any
 * route is registered.
 *
 * MOUNT ORDER (identical in both entrypoints):
 *
 *   trust proxy  ->  security headers  ->  general /api limiter
 *                ->  auth-sensitive limiter
 *                ->  bulk JSON parser (route-scoped, larger allowance)
 *                ->  global JSON parser (ordinary API payloads)
 *                ->  routes
 *                ->  API 404 (JSON)
 *                ->  API error handler (JSON, no internals)
 *
 * Nothing here redesigns authentication, authorization, visibility or
 * business routing: these middleware only decide whether a request may
 * reach the existing route handlers unchanged. See
 * docs/PRODUCTION_SECURITY_HARDENING.md for the deployed behavior,
 * thresholds, proxy assumptions and deferred work (CSP, distributed
 * limiter store).
 */

import type { NextFunction, Request, Response } from 'express';
import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

/* ==================================================================== */
/* 1. Runtime / deployment mode                                         */
/* ==================================================================== */

/**
 * True when the process is a production deployment (either the standalone
 * server started with NODE_ENV=production or any Vercel runtime).
 * Mirrors the IS_PRODUCTION rule already used by server.ts,
 * api/index.ts and production.routes.ts.
 */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.VERCEL);
}

/* ==================================================================== */
/* 2. Trust proxy                                                       */
/* ==================================================================== */

/**
 * Resolve the Express `trust proxy` setting.
 *
 * Security rule: express-rate-limit keys clients on `req.ip`, and
 * `trust proxy` decides what `req.ip` actually is.
 *
 *  - `TRUST_PROXY=1` (or any hop count / named trust list) — used when a
 *    known reverse proxy sits in front of the process. A hop COUNT is
 *    recommended: Express then reads X-Forwarded-For from the RIGHT, i.e.
 *    the entry appended by the trusted proxy, which a client cannot forge.
 *  - `TRUST_PROXY=true` — accepted for compatibility only, loudly warned
 *    about, because it lets any client forge X-Forwarded-For and pick its
 *    own rate-limit bucket.
 *  - default `false` — the socket peer address. On a directly exposed
 *    standalone server that is exactly the client IP.
 */
export function parseTrustProxySetting(value: string): string | number | boolean {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();

  if (lower === 'true') {
    console.warn(
      '[security] TRUST_PROXY=true trusts every hop, so clients can forge X-Forwarded-For and ' +
        'bypass rate limits. Use a hop count (e.g. TRUST_PROXY=1) instead.'
    );
    return true;
  }
  if (lower === 'false') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  // Named trust list / subnet expression (e.g. 'loopback', 'linklocal').
  return normalized;
}

/** Applies the resolved `trust proxy` setting to an Express app. */
export function configureTrustProxy(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const configured = (env.TRUST_PROXY || '').trim();
  if (configured) {
    app.set('trust proxy', parseTrustProxySetting(configured));
    return;
  }

  if (env.VERCEL) {
    // Vercel's edge OVERWRITES X-Forwarded-For with the connecting client IP
    // (documented anti-spoofing behavior), i.e. exactly one trusted hop.
    // Trusting one hop therefore yields the true client IP — and cannot be
    // influenced by a client-supplied X-Forwarded-For prefix.
    app.set('trust proxy', 1);
    return;
  }

  // Standalone: assume the process is the public edge (Docker, PM2, direct
  // VPS). Operators behind nginx/ALB set TRUST_PROXY=1.
  app.set('trust proxy', false);
}

/* ==================================================================== */
/* 3. Security headers                                                  */
/* ==================================================================== */

export interface SecurityHeaderOptions {
  /** Production behavior; defaults to isProductionRuntime(). */
  production?: boolean;
  /** Allow embedding in a frame; defaults to `!production`. */
  allowFraming?: boolean;
}

/**
 * Helmet with a deliberately REDUCED, audited configuration:
 *
 *  - Content-Security-Policy: DISABLED (deferred, documented).
 *    A default CSP (`script-src 'self'`) breaks the Vite dev runtime
 *    (inline React-refresh preamble / HMR) and `default-src 'self'` would
 *    block the Unsplash preset images used by Settings/identity presets.
 *    Enabling it needs a frontend resource audit + a Vite dev/prod split,
 *    which is out of scope for a middleware-hardening change.
 *  - Cross-Origin-Embedder-Policy: explicitly disabled (helmet default).
 *  - frameguard: production only. `frame-ancestors` lives inside the CSP
 *    that is deferred, so X-Frame-Options is what protects production from
 *    clickjacking. Development keeps framing allowed because the local
 *    preview host embeds the dev server in a cross-origin iframe.
 *
 * Everything else keeps helmet's safe defaults: X-Content-Type-Options,
 * Referrer-Policy, X-Frame-Options (prod), X-DNS-Prefetch-Control,
 * Cross-Origin-Opener-Policy, X-Permitted-Cross-Domain-Policies,
 * Origin-Agent-Cluster, Strict-Transport-Security, X-Download-Options,
 * Cross-Origin-Resource-Policy and `X-Powered-By` removal.
 */
export function createSecurityHeaders(options: SecurityHeaderOptions = {}) {
  const production = options.production ?? isProductionRuntime();
  const allowFraming = options.allowFraming ?? !production;

  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: allowFraming ? false : { action: 'sameorigin' },
  });
}

/** Default security-header middleware (resolved from the current env). */
export const securityHeaders = createSecurityHeaders();

/* ==================================================================== */
/* 4. Rate limiting                                                     */
/* ==================================================================== */

/** Shared window: 15 minutes. */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * General API limiter threshold — requests / 15 min / client IP.
 *
 * Sized from real LeadFlow traffic, not copied blindly from a 200/15min
 * default (which a single dashboard load + one workbench session can
 * exhaust):
 *   - cold start: ~10-15 requests (session, dashboard, follow-up buckets,
 *     scheduled activities, users, options, roles, leads, notifications)
 *   - background refresh: notifications every 60 s (<=15/window) and the
 *     role/menu cache at most every 60 s when stale (<=15/window)
 *   - heavy interactive bursts (filters, saves, page changes): tens of
 *     requests per minute, ~600 per window in the worst observed session
 *   - shared office NAT: one IP often fronts 5-15 users
 * 3000/15min (~200/min sustained) leaves ~5x headroom over that worst case
 * while still capping scripted abuse from a single client. See
 * docs/PRODUCTION_SECURITY_HARDENING.md.
 */
export const GENERAL_API_RATE_LIMIT = 3000;

/**
 * Auth limiter threshold — FAILED attempts / 15 min / client IP.
 * Successful logins are never counted (`skipSuccessfulRequests`), so a
 * user signing in repeatedly (or a whole office behind one NAT IP) is not
 * punished, while password guessing is capped at 20 tries per 15 min.
 */
export const AUTH_ATTEMPT_RATE_LIMIT = 20;

export const RATE_LIMIT_MESSAGE = 'Too many requests. Please try again later.';
export const AUTH_RATE_LIMIT_MESSAGE =
  'Too many sign-in attempts. Please wait a few minutes and try again.';

/**
 * Unauthenticated operational probes monitored by external uptime checks.
 * They carry no session data and must keep answering while a client IP is
 * throttled, so they are exempt from the general limiter.
 */
export const RATE_LIMIT_EXEMPT_PATHS = ['/api/health', '/api/health/readiness', '/api/db-status'];

/**
 * Authentication-sensitive endpoints — a stricter limiter than the API
 * baseline on purpose. Mounted at the entrypoints (not inside the routes)
 * so the protection holds for every runtime path, including the lazily
 * loaded Vercel router.
 */
export const AUTH_SENSITIVE_PATHS = [
  '/api/auth/login',
  '/api/auth/bootstrap-admin',
  '/api/auth/change-password',
  '/api/auth/change-required-password',
  '/api/users/:id/reset-password',
];

/** Full request path without the query string. */
function requestPath(req: Request): string {
  const raw = req.originalUrl || req.url || '';
  return raw.split('?')[0];
}

let lastRateLimitLogAt = 0;
const RATE_LIMIT_LOG_INTERVAL_MS = 10_000;

/**
 * Operational signal only — at most one line per 10 s per process to avoid
 * log flooding under attack. Logs the scope, method, path and client key;
 * NEVER a request body, password, token, Authorization header or cookie.
 */
function logRateLimitEvent(scope: string, req: Request): void {
  const now = Date.now();
  if (now - lastRateLimitLogAt < RATE_LIMIT_LOG_INTERVAL_MS) return;
  lastRateLimitLogAt = now;
  console.warn(
    `[security] ${scope} rate limit exceeded: ${req.method} ${requestPath(req)} (client ${req.ip || 'unknown'})`
  );
}

function createLimitHandler(scope: string, message: string) {
  return (req: Request, res: Response): void => {
    logRateLimitEvent(scope, req);
    res.status(429).json({ success: false, message });
  };
}

/** Broad API limiter: real dashboard/workbench traffic must never hit it. */
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: GENERAL_API_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => RATE_LIMIT_EXEMPT_PATHS.includes(requestPath(req)),
  handler: createLimitHandler('api', RATE_LIMIT_MESSAGE),
});

/**
 * Auth limiter: keys on the client IP only (never on a request body field,
 * so a caller cannot pick their own bucket or target another account) and
 * only counts failed attempts, so ordinary successful logins are unharmed.
 */
export const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_ATTEMPT_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: createLimitHandler('auth', AUTH_RATE_LIMIT_MESSAGE),
});

/** Mounts the general limiter (`/api`) then the stricter auth limiter. */
export function applyRateLimiters(app: Express): void {
  app.use('/api', apiLimiter);
  app.use(AUTH_SENSITIVE_PATHS, authLimiter);
}

/* ==================================================================== */
/* 5. Body size / request safety                                        */
/* ==================================================================== */

/**
 * Ordinary API payload budget. The largest legitimate non-bulk payload is
 * the 1.5 MB image limit in Settings/identity presets, which becomes
 * ~2 MB once base64-encoded inside JSON — 10 MB keeps ~5x headroom while
 * replacing the previous process-wide 50 MB parser.
 */
export const API_JSON_BODY_LIMIT = '10mb';

/**
 * Bulk spreadsheet import allowance. The client parses .xlsx/.csv locally
 * and posts the raw rows as JSON: up to 5000 lead rows (or 1000 user rows)
 * with ~20 free-text columns each. 50 MB preserves the exact payload
 * envelope bulk upload worked with before, applied only to the three import
 * paths so a single 50 MB body can no longer reach every endpoint.
 */
export const BULK_JSON_BODY_LIMIT = '50mb';

/** Route-scoped larger allowance (mounted BEFORE the global parser). */
export const BULK_JSON_PATHS = ['/api/leads/bulk', '/api/users/bulk/validate', '/api/users/bulk/commit'];

export function applyBodyParsers(app: Express): void {
  app.use(BULK_JSON_PATHS, express.json({ limit: BULK_JSON_BODY_LIMIT }));
  app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
}

/* ==================================================================== */
/* 6. The pipeline both entrypoints mount                               */
/* ==================================================================== */

export interface HttpSecurityOptions {
  /** Defaults to isProductionRuntime(). */
  production?: boolean;
  /** Defaults to `!production` (see createSecurityHeaders). */
  allowFraming?: boolean;
}

/**
 * Applies trust proxy + security headers + rate limiters + body parsers,
 * in that order, before any route is registered. Idempotent per app.
 */
export function applyProductionHttpSecurity(app: Express, options: HttpSecurityOptions = {}): void {
  const production = options.production ?? isProductionRuntime();

  configureTrustProxy(app);
  app.disable('x-powered-by');
  app.use(createSecurityHeaders({ production, allowFraming: options.allowFraming }));
  applyRateLimiters(app);
  applyBodyParsers(app);
}

/* ==================================================================== */
/* 7. JSON error handling / API 404                                     */
/* ==================================================================== */

/** Curated, non-leaking messages for generic (unexpected) failures. */
const SAFE_STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request.',
  401: 'Unauthorized. Please log in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested record was not found.',
  405: 'Method not allowed.',
  409: 'The request conflicts with the current state of the record.',
  413: 'Request payload is too large.',
  415: 'Unsupported media type.',
  429: RATE_LIMIT_MESSAGE,
};

export interface ApiErrorHandlerOptions {
  /** Defaults to isProductionRuntime(). */
  production?: boolean;
}

/**
 * Generic API error handler. Keeps the established JSON contract
 * (`{ success: false, message }`) and never leaks internals:
 *  - no stack trace is ever sent,
 *  - in production the message is a curated status message instead of the
 *    raw `error.message` (which for a pg failure can contain SQL, the
 *    connection target or query parameters),
 *  - Authorization headers / tokens / bodies are never echoed.
 * Full error detail is logged server-side only.
 */
export function createApiErrorHandler(options: ApiErrorHandlerOptions = {}) {
  const production = options.production ?? isProductionRuntime();

  return function apiErrorHandler(
    error: any,
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const path = requestPath(req);
    const isApiRequest = path === '/api' || path.startsWith('/api/');

    // Non-API failures (Vite dev middleware, static assets, SPA fallback)
    // keep the previous Express/Vite behavior.
    if (!isApiRequest) {
      next(error);
      return;
    }

    if (res.headersSent) {
      next(error);
      return;
    }

    const explicitStatus = Number(error?.status ?? error?.statusCode);
    const status =
      Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 600
        ? explicitStatus
        : 500;

    console.error(
      `[api-error] ${req.method} ${path} -> ${status}:`,
      error?.message || error
    );

    // Body-parser failures (invalid JSON, payload too large) are client
    // errors with a well-defined, safe message.
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ success: false, message: SAFE_STATUS_MESSAGES[413] });
      return;
    }
    if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
      res.status(400).json({ success: false, message: 'Invalid JSON request body.' });
      return;
    }

    if (!production) {
      // Development keeps the detailed message for debuggability.
      res.status(status).json({
        success: false,
        message: error?.message || 'Internal server error',
      });
      return;
    }

    res.status(status).json({
      success: false,
      message: status >= 500 ? 'Internal server error' : SAFE_STATUS_MESSAGES[status] || 'Request failed.',
    });
  };
}

/** Development default (env-resolved) export. */
export const apiErrorHandler = createApiErrorHandler();

/** JSON 404 for unknown API routes — same contract in both entrypoints. */
export function createApiNotFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).json({
      success: false,
      message: `API route not found: ${req.method} ${req.originalUrl}`,
    });
  };
}

/* ==================================================================== */
/* 8. Pre-existing request helpers (unchanged, kept for compatibility)  */
/* ==================================================================== */

/**
 * zod is imported lazily on purpose: this helper is not mounted by either
 * entrypoint, and a static `zod` import would add ~40 ms of parser code to
 * every serverless cold start (PR #31 prewarming budget) for nothing.
 */
let requestSchemaPromise: Promise<any> | null = null;
function loadRequestSchema(): Promise<any> {
  if (!requestSchemaPromise) {
    requestSchemaPromise = import('zod').then(({ z }) =>
      z.object({
        body: z.any().optional(),
        query: z.any().optional(),
        params: z.any().optional(),
      })
    );
  }
  return requestSchemaPromise;
}

export async function validateRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const requestSchema = await loadRequestSchema();
    const parsed = requestSchema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request payload.' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function sanitizeInput(req: Request, res: Response, next: NextFunction) {
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/<script|javascript:/gi, '').trim();
    }
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
    }
    return value;
  };
  req.body = sanitize(req.body);
  req.query = sanitize(req.query) as typeof req.query;
  req.params = sanitize(req.params) as typeof req.params;
  next();
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
}
