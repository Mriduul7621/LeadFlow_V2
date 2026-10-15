/**
 * statusFieldRules.ts
 * ------------------------------------------------------------------
 * The primitives behind the per-status required-field rules (F6), kept in
 * one dependency-free module so that the SAME code runs on the server
 * (`enforceLeadStatusRules` in the follow-up endpoint) and in the client
 * form (`LeadUpdate.tsx`) without pulling React or the API layer into a
 * Node test.
 */

export interface RequiredFieldViolation {
  /** Canonical API field name. */
  field: string;
  /** Operator-facing label. */
  label: string;
  /** Ready-to-show message (the API returns this verbatim). */
  message: string;
}

/** Case/space/punctuation-insensitive key for a status dictionary value. */
export function normalizeStatusKey(value: unknown): string {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/** True for undefined / null / empty / whitespace-only. */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Trimmed text of a value, or '' when it is not a usable string. */
export function requireText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * Number check for a required numeric field.
 *
 * Returns `null` when the value is acceptable, otherwise the reason:
 *   'missing'  — blank/undefined (the field was simply not filled in)
 *   'invalid'  — present but not a finite number
 *   'zero'     — 0 / negative where a positive amount is required
 */
export function requireNumber(
  value: unknown,
  kind: 'finite' | 'positive' = 'finite',
): 'missing' | 'invalid' | 'zero' | null {
  if (isBlank(value)) return 'missing';
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return 'invalid';
  if (kind === 'positive' && n <= 0) return 'zero';
  return null;
}

/**
 * Shared decision: does a numeric field count as "supplied" for the rule?
 * Kept next to requireNumber so both sides cannot disagree about, say,
 * whether the string "0" counts (it does — and `positive` then rejects it).
 */
export function isNumericValuePresent(value: unknown): boolean {
  return requireNumber(value, 'finite') === null;
}
