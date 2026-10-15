/**
 * forbidden.ts
 * ------------------------------------------------------------------
 * "Is this failure a PERMISSION failure?" — one classifier, shared by
 * every page that renders a load-error state.
 *
 * Why it exists: `hasPermissionCode()` fails closed on the server, so a
 * role with no grant answers 403 for every read. The pages used to lose
 * that distinction and print a generic red "could not be loaded" card —
 * the reviewer's F3 note: a fresh database looked BROKEN instead of
 * "nobody has granted this role anything yet".
 *
 * Deliberately dependency-free: no import of the HTTP client, so this
 * module stays importable from a plain Node test (and from anywhere a
 * page only wants the classification, not the whole API layer).
 */

type MaybeErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown } | null;
  message?: unknown;
} | null | undefined;

/** True when the failure is (or looks like) an HTTP 403 permission denial. */
export function isForbiddenError(err: unknown): boolean {
  if (!err) return false;

  if (typeof err === 'object') {
    const e = err as MaybeErrorLike;
    const status = e?.status ?? e?.statusCode ?? e?.response?.status;
    if (status === 403 || status === '403') return true;
  }

  // Fallback for errors that were re-wrapped without their status: the
  // server's own 403 copy is stable and distinctive.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /does not have permission|do not have permission|access denied|forbidden/i.test(message);
}
