/**
 * server/observability/requestId.ts — request correlation identifiers
 * ------------------------------------------------------------------
 * Every `/api/*` request gets one compact, server-side identifier that is:
 *
 *   - returned as the `X-Request-ID` response header,
 *   - attached to the request observability context (so every structured
 *     event emitted while handling the request carries it automatically),
 *   - never an auth token, session id or user-supplied free text.
 *
 * Trust policy for INCOMING ids: an `X-Request-ID` header from the caller
 * (e.g. from a browser diagnostics flow with a pre-known id) is honored
 * ONLY when it matches the strict shape below — bounded length, whitelist
 * charset, no whitespace/control characters. Anything else is discarded
 * and a fresh server id is generated, so request input can never inject
 * newlines or payloads into log lines.
 */

import { randomUUID } from 'node:crypto';

/** Public response header name (Express lowercases request headers). */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Strict incoming-id shape: 8–64 chars of [A-Za-z0-9_-]. Covers UUIDs,
 * nanoid-style ids and reverse-proxy ids without allowing any character
 * that could break a JSON log line or forge a second "log event".
 */
const INCOMING_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Generates a fresh server-side request id (compact UUID v4). */
export function generateRequestId(): string {
  return randomUUID();
}

/** True when a caller-supplied id is safe to adopt. */
export function isValidIncomingRequestId(value: unknown): value is string {
  return typeof value === 'string' && INCOMING_REQUEST_ID_PATTERN.test(value);
}

/**
 * Resolves the id for one request: the validated incoming header value,
 * or a freshly generated server id. Header arrays (duplicate headers)
 * are never adopted.
 */
export function resolveRequestId(req: {
  headers?: Record<string, unknown>;
}): string {
  const incoming = req?.headers?.[REQUEST_ID_HEADER.toLowerCase()];
  if (isValidIncomingRequestId(incoming)) return incoming;
  return generateRequestId();
}
