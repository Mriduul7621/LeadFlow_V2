/**
 * Deployment chunk recovery — graceful handling of stale dynamic chunks.
 * ------------------------------------------------------------------
 * The production build ships one hashed chunk per route (Performance
 * Phase 2). After a new deployment the old hashed files are gone, so a
 * user whose browser still runs the previous session (an open tab, a
 * cached index.html, a resumed mobile session) requests chunk URLs that
 * no longer exist. The dynamic import rejects, no boundary handled it,
 * and React unmounted the whole tree: a silent white screen that only a
 * manual refresh fixed.
 *
 * The contract here is deliberately small and framework-agnostic:
 *
 *   1. `isChunkLoadError(payload)` — recognize every known browser /
 *      bundler signature of "a dynamic import failed because the
 *      requested module is gone or was served as HTML". Regular network
 *      and API failures must NOT match (they have their own recovery
 *      paths: offline cache, retry queues).
 *
 *   2. `recoverFromChunkError()` — ONE guarded `location.reload()`.
 *      Reloading refetches index.html (revalidated by the browser on
 *      reload), whose hashed chunk references are current again — that
 *      is the whole fix. The guard (cooldown marker in sessionStorage,
 *      with an in-memory fallback when storage is unavailable) makes an
 *      automatic reload-loop impossible when the new deployment itself
 *      is broken or the user is offline.
 *
 *   3. `installGlobalChunkRecovery()` — window-level safety net for
 *      failures that never reach a React boundary: the stale entry
 *      script on a hard load, modulepreload links, and dynamic imports
 *      outside the route tree.
 *
 * React-side wiring lives in `ChunkErrorBoundary` (route content) and
 * `main.tsx` (global install). Nothing here touches app state: tokens,
 * stores and localStorage survive a plain reload untouched.
 */

/** sessionStorage key holding the timestamp of the last auto-recovery. */
const RECOVERY_STORAGE_KEY = 'lf:chunk-recovery';

/**
 * Minimum time between two AUTOMATIC recovery reloads, in ms. One
 * reload is almost always enough (a reload revalidates index.html).
 * If the SAME tab keeps failing inside this window, the deployment it
 * lands on is broken too — reloading again in a tight loop would only
 * hide that, so the guard stops and the UI falls back to an explicit
 * "Reload now" action the user controls.
 */
const RECOVERY_COOLDOWN_MS = 60_000;

/** Vite emits every hashed bundle (and asset) under /assets/. */
const ASSET_URL_PATTERN = /\/assets\//;

/**
 * Every known signature of a stale-dynamic-import failure, per engine:
 *
 * - Chromium : "Failed to fetch dynamically imported module: <url>"
 * - Firefox  : "error loading dynamically imported module: <url>"
 * - Safari   : "Importing a module script failed."
 * - webpack  : "ChunkLoadError: Loading chunk 5 failed" / "Loading CSS
 *              chunk 5 failed" (kept for parity if the bundler changes)
 * - Vite     : "Unable to preload CSS for <dep>" (its preload helper
 *              rejects when a dynamic import's dependency link fails)
 * - HTML     : a server that falls back to index.html for missing files
 *              serves the module as text/html → "Expected a JavaScript
 *              module script…" (Chromium) / "…disallowed MIME type
 *              (\"text/html\")" (Firefox)
 */
const CHUNK_ERROR_SIGNATURES: RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading (?:css )?chunk [^\s]+ failed/i,
  /\bchunkloaderror\b/i,
  /unable to preload/i,
  /expected a javascript module script/i,
  /disallowed mime type/i,
];

/**
 * Reduce an unknown rejection payload (Error, ErrorEvent, string,
 * PromiseRejectionEvent reason wrapper, …) to its message. Bounded
 * recursion: only `reason`/`error` wrapper shapes are unwrapped.
 */
function extractErrorMessage(payload: unknown, depth = 0): string {
  if (depth > 3 || payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (payload instanceof Error) return payload.message || payload.name || '';
  const record = payload as { message?: unknown; reason?: unknown; error?: unknown };
  if (typeof record.message === 'string' && record.message) return record.message;
  return extractErrorMessage(record.reason ?? record.error, depth + 1);
}

/**
 * True only for the stale-dynamic-import failure class. Deliberately
 * NOT matched: bare "Failed to fetch" (generic network failure), HTTP
 * 4xx/5xx API errors, aborts — those must keep flowing to their own
 * offline/retry handling.
 */
export function isChunkLoadError(payload: unknown): boolean {
  if (payload instanceof Error && payload.name === 'ChunkLoadError') return true;
  const message = extractErrorMessage(payload);
  if (!message) return false;
  return CHUNK_ERROR_SIGNATURES.some((signature) => signature.test(message));
}

/* ------------------------------------------------------------------ */
/* Guarded single reload                                               */
/* ------------------------------------------------------------------ */

/** In-memory fallback when sessionStorage is unavailable (privacy mode). */
let inMemoryLastAttempt: number | null = null;

function getLastRecoveryAttempt(): number | null {
  try {
    const raw = window.sessionStorage?.getItem(RECOVERY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { at?: unknown };
      if (typeof parsed?.at === 'number') return parsed.at;
    }
  } catch {
    /* storage unavailable — the in-memory marker still applies */
  }
  return inMemoryLastAttempt;
}

function recordRecoveryAttempt(now: number): void {
  inMemoryLastAttempt = now;
  try {
    window.sessionStorage?.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ at: now }));
  } catch {
    /* memory marker already set — nothing else to do */
  }
}

/**
 * Whether an AUTOMATIC recovery reload is allowed right now: only if
 * the last one is older than the cooldown (or there never was one).
 */
export function shouldAttemptRecovery(now: number = Date.now()): boolean {
  if (typeof window === 'undefined') return false;
  const last = getLastRecoveryAttempt();
  return last == null || now - last >= RECOVERY_COOLDOWN_MS;
}

/**
 * Recover from a stale-chunk failure by reloading the document, which
 * refetches a current index.html with up-to-date chunk references.
 *
 * Returns `true` when a reload was triggered. Automatic attempts are
 * cooldown-guarded (see `shouldAttemptRecovery`); `force: true` is the
 * explicit user action ("Reload now" button) and always reloads.
 */
export function recoverFromChunkError(
  options: { force?: boolean; now?: number } = {},
): boolean {
  if (typeof window === 'undefined') return false;
  const now = options.now ?? Date.now();
  if (!options.force && !shouldAttemptRecovery(now)) return false;
  recordRecoveryAttempt(now);
  window.location.reload();
  return true;
}

/**
 * Window-level safety net for chunk failures that never reach a React
 * error boundary:
 *
 * - `unhandledrejection` — dynamic imports outside the route tree
 *   (e.g. a page-level `import()` that nothing catches).
 * - `error` — script/module evaluation failures carrying an error.
 * - capture-phase `error` — resource load failures don't bubble and
 *   carry no error object; this is how a stale entry script or a
 *   modulepreload link announces itself on a hard load with a cached
 *   index.html.
 *
 * Every path goes through the same guarded single reload. Returns a
 * cleanup function (unused in production; keeps the installer testable
 * and symmetric).
 */
export function installGlobalChunkRecovery(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadError(event.reason)) recoverFromChunkError();
  };

  const onError = (event: ErrorEvent): void => {
    if (isChunkLoadError(event.error ?? event.message)) recoverFromChunkError();
  };

  const onResourceError = (event: Event): void => {
    const target = event.target as HTMLScriptElement | HTMLLinkElement | null;
    if (!target || (target.tagName !== 'SCRIPT' && target.tagName !== 'LINK')) return;
    const url =
      target instanceof HTMLScriptElement
        ? target.src
        : target instanceof HTMLLinkElement
          ? target.href
          : '';
    if (ASSET_URL_PATTERN.test(url)) recoverFromChunkError();
  };

  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('error', onError);
  window.addEventListener('error', onResourceError, true);

  return () => {
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    window.removeEventListener('error', onError);
    window.removeEventListener('error', onResourceError, true);
  };
}

/**
 * Test-only: reset the in-memory marker and the storage key so tests
 * start from a clean slate (same convention as `_setTestPoolForTest`).
 */
export function _resetChunkRecoveryForTests(): void {
  inMemoryLastAttempt = null;
  try {
    window.sessionStorage?.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    /* nothing to reset */
  }
}
