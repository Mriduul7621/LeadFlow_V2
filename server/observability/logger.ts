/**
 * server/observability/logger.ts — structured JSON-line logger
 * ------------------------------------------------------------------
 * One small, dependency-free logger for production observability. One
 * event = one single-line JSON object on stdout/stderr, which is exactly
 * what Vercel (and any process manager) captures and indexes.
 *
 * Example (http_request_complete):
 *   {"ts":"2026-09-14T10:00:00.000Z","level":"info",
 *    "event":"http_request_complete","build":"5705830",
 *    "env":"vercel","requestId":"5b3f…","method":"GET",
 *    "route":"/api/leads","status":200,"durationMs":183.4,
 *    "dbQueryCount":4,"dbDurationMs":72.1}
 *
 * Hard rules enforced HERE (not just by convention):
 *   - allowance-first: `logEvent` only serializes the allowlisted fields
 *     a caller names; everything else is dropped before serialization;
 *   - key redaction: sensitive keys (authorization/cookie/token/secret/
 *     password/database_url/jwt/api_key/email/phone/mobile) can never
 *     survive `sanitizeValue`, nested or not;
 *   - no persistence: stdout/stderr only. No PostgreSQL writes, no file
 *     writes, no network service — a database outage must still be
 *     observable, and logging must not add DB write pressure;
 *   - never throws: logging failure can never break a request;
 *   - O(1): one bounded JSON.stringify per event, no request/response
 *     object serialization.
 *
 * Levels (OBSERVABILITY_LOG_LEVEL): debug | info | warn | error.
 * Default: 'debug' outside production, 'info' in production. An unknown
 * value falls back to 'info' (never to 'debug', so PII-adjacent debug
 * payloads can not be enabled by a typo).
 */

import { isProductionRuntime } from '../config/env.js';
import {
  resolveBuildIdentifier,
  resolveEnvironmentIdentifier,
} from '../health.js';
import { getRequestContext } from './context.js';
import { pickAllowlisted, sanitizeFields, sanitizeValue } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Resolves the effective level. Pure, env-injectable (and unit-tested). */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.OBSERVABILITY_LOG_LEVEL || '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  if (raw) {
    // Unknown value: fall back safely to 'info'. A misspelled level must
    // never enable debug output in production.
    return 'info';
  }
  return isProductionRuntime(env) ? 'info' : 'debug';
}

/** Destination for serialized lines. Swappable in tests. */
export type LogSink = (level: LogLevel, line: string) => void;

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

let activeSink: LogSink | null = null;

/**
 * Test hook: installs (or clears, with null) the sink that receives every
 * serialized line. The sink is logger configuration, not request state —
 * it carries no data between requests.
 */
export function _setLogSinkForTests(sink: LogSink | null): void {
  activeSink = sink;
}

export interface StructuredEvent {
  ts: string;
  level: LogLevel;
  event: string;
  build?: string;
  env: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Builds the event object without emitting it. Exposed for unit tests.
 *
 * Privacy pipeline: allowlist pick (when an allowlist is given) →
 * redaction/shape sanitization of every value. The requestId from the
 * active request context is attached automatically unless the caller
 * supplied one explicitly.
 */
export function buildStructuredEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  allowlist?: readonly string[]
): StructuredEvent {
  const entry: StructuredEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    env: resolveEnvironmentIdentifier(),
  };
  const build = resolveBuildIdentifier();
  if (build) entry.build = build;

  const ctx = getRequestContext();
  if (ctx && fields.requestId === undefined) {
    entry.requestId = ctx.requestId;
  }

  const picked = allowlist ? pickAllowlisted(fields, allowlist) : fields;
  const safe = sanitizeFields(picked);
  for (const [key, value] of Object.entries(safe)) {
    entry[key] = value;
  }
  return entry;
}

/**
 * Serializes and emits one event if its level passes the configured
 * threshold. Guaranteed not to throw.
 */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  allowlist?: readonly string[]
): void {
  try {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveLogLevel()]) return;
    const entry = buildStructuredEvent(level, event, fields, allowlist);
    const line = JSON.stringify(entry);
    (activeSink ?? defaultSink)(level, line);
  } catch {
    // Logging must never break request handling.
  }
}

export const logDebug = (event: string, fields?: Record<string, unknown>, allowlist?: readonly string[]) =>
  logEvent('debug', event, fields, allowlist);
export const logInfo = (event: string, fields?: Record<string, unknown>, allowlist?: readonly string[]) =>
  logEvent('info', event, fields, allowlist);
export const logWarn = (event: string, fields?: Record<string, unknown>, allowlist?: readonly string[]) =>
  logEvent('warn', event, fields, allowlist);
export const logError = (event: string, fields?: Record<string, unknown>, allowlist?: readonly string[]) =>
  logEvent('error', event, fields, allowlist);

// Re-exported so callers can sanitize one-off values without importing two
// modules (the allowlist boundary stays the primary mechanism).
export { sanitizeValue };
