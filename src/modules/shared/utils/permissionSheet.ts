/**
 * permissionSheet.ts
 * ------------------------------------------------------------------
 * Turns the raw rows of `GET /api/users/:id/permissions` into the boolean
 * sheet the UI consults, using EXACTLY the precedence the server enforces
 * in `hasPermissionCode()`:
 *
 *     permission definition missing   -> the code is absent (callers treat
 *                                        an absent code as deny)
 *     per-user override row exists    -> its is_allowed wins
 *     else role grant row exists      -> its is_allowed
 *     else                            -> deny (fail closed)
 *
 * Why this module exists (F16 §3.1): the hook used to read only
 * `is_allowed` — the ROLE grant — and silently ignored `user_override`.
 * An administrator could therefore deny one permission for one person and
 * the server would answer 403 while the UI still rendered the button.
 * One pure function, unit-tested against the server's rule, keeps the two
 * answers identical.
 */

export interface PermissionSheetRow {
  permission_code?: unknown;
  is_allowed?: unknown;
  user_override?: unknown;
}

/**
 * `rows` is the API's `data` array. Rows without a code are skipped; a
 * user override of `true`/`false` overrides the role grant; `null`/
 * `undefined` means "no override, use the role grant" (the trio the
 * Enterprise Access panel writes: ROLE / ALLOW / DENY).
 */
export function buildPermissionSheet(
  rows: PermissionSheetRow[] | null | undefined
): Record<string, boolean> {
  const sheet: Record<string, boolean> = {};
  if (!Array.isArray(rows)) return sheet;
  for (const row of rows) {
    const code = String(row?.permission_code ?? '').trim();
    if (!code) continue;
    const hasOverride = row?.user_override !== null && row?.user_override !== undefined;
    sheet[code] = hasOverride ? Boolean(row.user_override) : Boolean(row?.is_allowed);
  }
  return sheet;
}
