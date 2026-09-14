/**
 * server/observability/redaction.ts — secret/PII redaction primitives
 * ------------------------------------------------------------------
 * Defense-in-depth underneath the allowlisted structured-event helpers
 * (server/observability/logger.ts). The policy is layered:
 *
 *   1. ALLOWLIST FIRST — every event helper only copies fields it
 *      explicitly names. Unknown fields never reach the log line at all.
 *   2. KEY REDACTION — any allowlisted value that is itself an object
 *      (rare, defensive) has sensitive keys replaced with '<redacted>'.
 *   3. SHAPE LIMITS — strings are capped, arrays and object depth are
 *      capped, so a pathological value can never bloat a log line.
 *
 * The sensitive-key concept list covers (case-insensitive, tolerating
 * - _ . separators): authorization, cookie (incl. set-cookie), token,
 * secret, password, database_url, jwt, api_key, email, phone — plus
 * 'mobile', the phone-number field name used across the LeadFlow schema.
 *
 * These helpers are pure: no I/O, no env access, no global state.
 */

/** Stand-in written in place of a redacted value. */
export const REDACTED = '<redacted>';

/**
 * Key concepts that must never be logged. Matching is deliberately
 * substring-based (not ^= words) so 'refreshToken', 'DATABASE_URL',
 * 'x-api-key', 'userEmail' and 'phone_number' are all caught.
 */
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|database_url|jwt|api[-_.]?key|email|phone|mobile)/i;

/** True when `key` names a credential/PII concept that must be redacted. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Shape limits — keep every serialized field small and O(1)-bounded. */
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;

const truncate = (value: string): string =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;

/**
 * Deep-sanitizes a single value for logging:
 *  - primitives pass through (strings capped),
 *  - objects/arrays are copied with sensitive keys redacted,
 *  - anything deeper than MAX_DEPTH is replaced with a stub,
 *  - non-serializable values become a type label, never their contents.
 * Never throws — a logging helper must not break request handling.
 */
export function sanitizeValue(value: unknown, key = '', depth = 0): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'string') return truncate(value as string);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return Number(value);
  if (type === 'function' || type === 'symbol') return `[${type}]`;

  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, '', depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return out;
  }

  if (type === 'object') {
    // Only plain data objects are logged; class instances (Request,
    // Response, Error, Date, Buffers, …) collapse to a type label so a
    // stray object can never smuggle headers, bodies or connection state.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      if (value instanceof Date) return value.toISOString();
      return `[${(value as object).constructor?.name || 'object'}]`;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_OBJECT_KEYS) {
        out._truncatedKeys = (Object.keys(value).length - MAX_OBJECT_KEYS) as unknown as string;
        break;
      }
      count += 1;
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = sanitizeValue(v, k, depth + 1);
      }
    }
    return out;
  }

  return `[${type}]`;
}

/**
 * Sanitizes a flat field map (the shape used by every structured event).
 * Returns a NEW object; the input is never mutated.
 */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    out[k] = sanitizeValue(v, k);
  }
  return out;
}

/**
 * Copies ONLY the allowlisted keys from `fields` (order-preserving).
 * This is the primary privacy boundary for structured events: a caller
 * can pass any incidental fields and exactly the named, reviewed fields
 * survive. Sanitization (redaction + shape limits) runs afterwards.
 */
export function pickAllowlisted(
  fields: Record<string, unknown>,
  allowlist: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowlist) {
    const value = fields?.[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
