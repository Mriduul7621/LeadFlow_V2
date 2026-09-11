/**
 * diagnostics.ts
 * ------------------------------------------------------------------
 * TEMPORARY, ADMIN-ONLY, READ-ONLY mobile performance diagnostics.
 *
 * Records client-side timing metadata for API requests so an Admin can
 * diagnose production latency from a phone (see
 * docs/MOBILE_PERFORMANCE_DIAGNOSTICS.md). This is diagnostic tooling
 * ONLY — it never modifies business data and never talks to the network.
 *
 * Privacy contract (asserted by server/tests/perf-diagnostics-source-guards.test.ts):
 * - Stores ONLY request metadata: sanitized URL, HTTP method, status,
 *   durations, Server-Timing text, content-length, timestamps, and a
 *   short network-error message. Nothing else.
 * - NEVER stores: Authorization header, raw JWT/token, passwords,
 *   request bodies, response bodies, cookies, customer PII (names,
 *   phones, emails), or environment values. This module's API accepts
 *   only (url, method) + the settled Response's safe header fields —
 *   request bodies and auth headers are structurally unreachable here.
 * - URLs are sanitized with a DEFAULT-DENY query policy: only a small
 *   allowlist of known-safe parameter keys (page, limit, status, ...)
 *   keeps its value; every other query value is replaced with `…` so a
 *   lead name/phone typed into a search box can never be recorded.
 * - In-memory ONLY. No PostgreSQL, no localStorage, no sessionStorage,
 *   no cookies, no off-device transmission.
 *
 * Session hygiene (same guarantees as coalesce.ts / sessionCache.ts):
 * - The buffer is scoped to the authenticated session (user id + token
 *   FINGERPRINT — the raw token never appears anywhere). When a different
 *   session identity is observed the buffer is wiped before anything is
 *   recorded, so a new authenticated user can never inherit the previous
 *   user's diagnostics.
 * - A store watcher handles auth transitions WITHOUT touching authStore:
 *   logout clears EVERYTHING; a fresh login clears everything EXCEPT the
 *   just-completed POST /api/auth/login of the new session (renumbered to
 *   request #1), so the fresh-login diagnostic the admin is testing for
 *   stays visible while no prior-session data can carry over.
 *
 * Timing: performance.now() before the real fetch and after the
 * response/error — the request path is never delayed for instrumentation
 * and response handling semantics are unchanged.
 */

import { useAuthStore } from '../../auth/store/authStore';
import { currentSessionScope } from './coalesce';

/** Bounded recent-history: the UI shows the most recent 20–30 requests. */
const MAX_ENTRIES = 30;

/** Stored URLs are capped so a pathological URL can't bloat memory. */
const MAX_PATH_LENGTH = 300;
const MAX_ERROR_LENGTH = 200;
const MAX_SERVER_TIMING_LENGTH = 300;

/**
 * DEFAULT-DENY query allowlist. Only these parameter keys keep their
 * value in the stored URL; everything else (search terms, tokens, ids in
 * query form, anything unknown) is redacted. Keys are lowercase.
 */
const SAFE_QUERY_KEYS = new Set([
  'page', 'limit', 'offset', 'sort', 'order', 'dir',
  'status', 'type', 'activitytype', 'activity_type', 'priority', 'bucket',
  'includeterminal', 'include_terminal', 'from', 'to', 'role', 'scope', 'view',
]);

export type ApiDiagnosticsDurationClass = 'good' | 'moderate' | 'slow' | 'very_slow';

export interface ApiDiagnosticsEntry {
  /** Monotonic recorder id (stable key for expansion in the UI). */
  id: number;
  /** Per-session request sequence number (1 = first request after app load). */
  seq: number;
  /** Sanitized request path (origin stripped, sensitive query values redacted). */
  path: string;
  method: string;
  /** HTTP status; 0 means the request never got a response (network error). */
  status: number;
  ok: boolean;
  /** True from request start until the fetch settled. */
  pending: boolean;
  /** Total client duration in ms (upgraded to body-inclusive when available). */
  durationMs: number;
  /** Duration measured at response-header time (subset of durationMs). */
  headerDurationMs: number;
  /** Raw Server-Timing header text, when the browser permits access. */
  serverTiming: string | null;
  /** content-length in bytes when the server provides it. */
  responseSizeBytes: number | null;
  /** Epoch ms when the request started. */
  startedAt: number;
  /** Epoch ms when the fetch settled (null while pending). */
  finishedAt: number | null;
  /** True for the first API request after page/app load (cold-start probe). */
  firstAfterLoad: boolean;
  /** Short message for network failures only; never response bodies. */
  errorMessage: string | null;
  /** True when fetch itself rejected (device/network/server unreachable). */
  networkError: boolean;
}

export interface ApiDiagnosticsSummary {
  sessionStartedAt: number;
  captured: number;
  pending: number;
  failed: number;
  /** Longest settled request (metadata only — not a cause attribution). */
  slowest: { path: string; durationMs: number; status: number } | null;
  /** Average settled duration in ms, rounded. */
  averageMs: number | null;
  over1s: number;
  over3s: number;
}

interface InternalRecord extends ApiDiagnosticsEntry {
  /** performance.now() at request start (for body-inclusive upgrades). */
  startPerfMs: number;
}

/* ------------------------------------------------------------------ */
/* State — in-memory only, wiped on reload/logout/session change.      */
/* ------------------------------------------------------------------ */

const entries = new Map<number, InternalRecord>();
const order: number[] = [];
const bodyPending = new WeakMap<object, number>();

let nextId = 1;
let nextSeq = 1;
let bufferScope: string | null = null;
let sessionStartedAt = Date.now();
let version = 0;

const listeners = new Set<() => void>();
let snapshotCache: readonly ApiDiagnosticsEntry[] | null = null;

/** High-resolution clock with a safe fallback (Node tests / old browsers). */
export function diagnosticsNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/* ------------------------------------------------------------------ */
/* Session scoping                                                     */
/* ------------------------------------------------------------------ */

/**
 * Re-bind the buffer to the CURRENT authenticated session. Any change of
 * session identity wipes everything first — diagnostics can never cross a
 * user boundary (and the raw token is never read here, only coalesce.ts's
 * fingerprint-based scope id).
 */
function ensureSessionScope(): void {
  // Imported lazily-shaped (module-level import, function-level use) to
  // mirror coalesce.ts's existing authStore import pattern.
  const scope = currentSessionScope();
  if (bufferScope !== scope) {
    resetBuffer(scope);
  }
}

function resetBuffer(scope: string): void {
  entries.clear();
  order.length = 0;
  nextSeq = 1;
  sessionStartedAt = Date.now();
  bufferScope = scope;
  touch();
}

/**
 * Keep ONLY the most recent /api/auth/login entry (the request that just
 * created this session) and drop everything else. Used on the login
 * transition so the fresh-login diagnostic survives while no data from
 * BEFORE the login (previous user's session, stale attempts) can carry
 * over. The retained entry becomes request #1 of the fresh session.
 */
function retainOnlyFreshLogin(): void {
  let keepId: number | null = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = entries.get(order[i]);
    if (entry && entry.path.startsWith('/api/auth/login')) {
      keepId = entry.id;
      break;
    }
  }
  for (const id of order.splice(0, order.length)) {
    if (id !== keepId) entries.delete(id);
  }
  if (keepId !== null) {
    const kept = entries.get(keepId);
    if (kept) {
      order.push(keepId);
      kept.seq = 1;
      kept.firstAfterLoad = true;
      sessionStartedAt = kept.startedAt;
    }
  } else {
    sessionStartedAt = Date.now();
  }
  nextSeq = order.length + 1;
  touch();
}

/**
 * Clear ALL diagnostics. Called on logout (via the store watcher below)
 * and by the UI's explicit Clear button.
 */
export function clearApiDiagnostics(): void {
  entries.clear();
  order.length = 0;
  nextSeq = 1;
  sessionStartedAt = Date.now();
  touch();
}

/** Live buffer size (test seam). */
export function apiDiagnosticsCount(): number {
  return entries.size;
}

/* ------------------------------------------------------------------ */
/* Subscription (used by the admin UI via useSyncExternalStore)        */
/* ------------------------------------------------------------------ */

export function subscribeApiDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function touch(): void {
  version += 1;
  snapshotCache = null;
  for (const listener of listeners) listener();
}

/** Stable-reference snapshot for useSyncExternalStore (newest first). */
export function getApiDiagnostics(): readonly ApiDiagnosticsEntry[] {
  if (!snapshotCache) {
    const copy: ApiDiagnosticsEntry[] = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const e = entries.get(order[i]);
      if (e) {
        const { startPerfMs: _ignored, ...entry } = e;
        copy.push(entry);
      }
    }
    snapshotCache = copy;
  }
  return snapshotCache;
}

/* ------------------------------------------------------------------ */
/* Recorder — called ONLY from the centralized API layer               */
/* (lib/apiClient.ts around the real fetch, shared/api/http.ts after   */
/* the body read). Never from individual pages.                        */
/* ------------------------------------------------------------------ */

/**
 * Record the start of an /api/ request. Accepts ONLY the URL and HTTP
 * method — by construction there is no way to hand this recorder an
 * Authorization header, token, or request body.
 * Returns the recorder id to pass to the settle/fail functions.
 */
export function recordApiRequestStart(rawUrl: string, method: string): number {
  ensureLogoutWatcher();
  ensureSessionScope();

  const id = nextId++;
  const record: InternalRecord = {
    id,
    seq: nextSeq++,
    path: sanitizeApiPath(rawUrl),
    method: String(method || 'GET').toUpperCase(),
    status: 0,
    ok: false,
    pending: true,
    durationMs: 0,
    headerDurationMs: 0,
    serverTiming: null,
    responseSizeBytes: null,
    startedAt: Date.now(),
    finishedAt: null,
    firstAfterLoad: nextSeq - 1 === 1,
    errorMessage: null,
    networkError: false,
    startPerfMs: diagnosticsNowMs(),
  };

  entries.set(id, record);
  order.push(id);
  while (order.length > MAX_ENTRIES) {
    const oldest = order.shift();
    if (oldest !== undefined) entries.delete(oldest);
  }
  touch();
  return id;
}

/**
 * Record a settled fetch (headers received). Reads ONLY the safe metadata
 * fields (status / ok / two headers) off the Response inside a try/catch —
 * never the body. The Response object is stored nowhere.
 */
export function recordApiRequestSettled(id: number, response: unknown, headerDurationMs: number): void {
  const record = entries.get(id);
  if (!record) return;

  let status = 0;
  let ok = false;
  let serverTiming: string | null = null;
  let responseSizeBytes: number | null = null;
  try {
    const res = response as { status?: number; ok?: boolean; headers?: { get(name: string): string | null } } | null;
    status = typeof res?.status === 'number' ? res.status : 0;
    ok = Boolean(res?.ok);
    if (res?.headers && typeof res.headers.get === 'function') {
      // Server-Timing needs a same-origin (or Timing-Allow-Origin) response;
      // where the browser withholds it this stays null — never an error.
      serverTiming = cap(res.headers.get('server-timing'), MAX_SERVER_TIMING_LENGTH);
      const contentLength = res.headers.get('content-length');
      if (contentLength && /^\d+$/.test(contentLength.trim())) {
        responseSizeBytes = Number(contentLength.trim());
      }
    }
  } catch {
    // Opaque/blocked header access: keep the timing, drop the metadata.
  }

  record.status = status;
  record.ok = ok;
  record.serverTiming = serverTiming;
  record.responseSizeBytes = responseSizeBytes;
  record.headerDurationMs = Math.max(0, Math.round(headerDurationMs));
  record.durationMs = record.headerDurationMs;
  record.pending = false;
  record.finishedAt = Date.now();
  // Keep the upgrade window open for the shared http.ts layer, which knows
  // when the body has actually been read (body-inclusive client duration).
  if (response && typeof response === 'object') {
    bodyPending.set(response as object, id);
  }
  touch();
}

/**
 * Record a network-level failure (fetch rejected: offline, DNS, CORS
 * crash, ...). Stores only a short browser-generated error message.
 */
export function recordApiRequestFailed(id: number, durationMs: number, error: unknown): void {
  const record = entries.get(id);
  if (!record) return;

  record.status = 0;
  record.ok = false;
  record.pending = false;
  record.networkError = true;
  record.durationMs = Math.max(0, Math.round(durationMs));
  record.finishedAt = Date.now();
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  record.errorMessage = cap(message, MAX_ERROR_LENGTH);
  touch();
}

/**
 * Called by shared/api/http.ts AFTER the response body has been read, to
 * upgrade the entry to the true body-inclusive total client duration.
 * Pure metadata bookkeeping — response handling is untouched.
 */
export function noteApiBodySettled(response: unknown): void {
  if (!response || typeof response !== 'object') return;
  const id = bodyPending.get(response as object);
  if (id === undefined) return;
  bodyPending.delete(response as object);
  const record = entries.get(id);
  if (!record || record.pending) return;
  const totalMs = Math.max(0, Math.round(diagnosticsNowMs() - record.startPerfMs));
  if (totalMs > record.durationMs) {
    record.durationMs = totalMs;
    touch();
  }
}

/* ------------------------------------------------------------------ */
/* Summary / copy text                                                 */
/* ------------------------------------------------------------------ */

export function summarizeApiDiagnostics(): ApiDiagnosticsSummary {
  const all = getApiDiagnostics();
  const settled = all.filter(e => !e.pending);
  const durations = settled.map(e => e.durationMs);
  const slowestEntry = settled.length
    ? settled.reduce((max, e) => (e.durationMs > max.durationMs ? e : max), settled[0])
    : null;

  return {
    sessionStartedAt,
    captured: all.length,
    pending: all.filter(e => e.pending).length,
    failed: all.filter(e => !e.pending && !e.ok).length,
    slowest: slowestEntry
      ? { path: slowestEntry.path, durationMs: slowestEntry.durationMs, status: slowestEntry.status }
      : null,
    averageMs: durations.length
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : null,
    over1s: durations.filter(d => d > 1000).length,
    over3s: durations.filter(d => d > 3000).length,
  };
}

/**
 * Plain-text summary for the Copy button — sanitized paths only (query
 * values redacted by sanitizeApiPath), no tokens, no bodies, no headers.
 * Sized so an Admin can paste it straight into a chat from a phone.
 */
export function buildDiagnosticsCopySummary(): string {
  const summary = summarizeApiDiagnostics();
  const all = getApiDiagnostics().slice().reverse(); // chronological
  const lines: string[] = [];

  lines.push('Performance Diagnostics');
  lines.push(`Session started: ${formatTimestamp(summary.sessionStartedAt)}`);
  lines.push(
    `Browser online: ${typeof navigator !== 'undefined' && navigator.onLine ? 'yes' : 'no'}`
  );
  lines.push(`Requests captured: ${summary.captured}`);
  lines.push('');

  all.forEach((entry, index) => {
    let line = `${index + 1}. ${entry.path} — ${entry.durationMs} ms`;
    if (entry.pending) {
      line += ' — pending';
    } else if (entry.networkError) {
      line += ` — ${entry.method} — NETWORK ERROR${entry.errorMessage ? `: ${entry.errorMessage}` : ''}`;
    } else {
      line += ` — ${entry.method} — ${entry.status}`;
      if (entry.serverTiming) line += ` — Server-Timing: ${entry.serverTiming}`;
    }
    lines.push(line);
    if (entry.firstAfterLoad) lines.push('   (1st request after app load)');
  });

  lines.push('');
  if (summary.slowest) {
    lines.push(`Slowest: ${summary.slowest.path} — ${summary.slowest.durationMs} ms`);
  } else {
    lines.push('Slowest: none yet');
  }
  lines.push(`Average (recent): ${summary.averageMs !== null ? `${summary.averageMs} ms` : 'n/a'}`);
  lines.push(`Requests >1s: ${summary.over1s}`);
  lines.push(`Requests >3s: ${summary.over3s}`);
  lines.push(`Failed: ${summary.failed}`);

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Pure helpers (shared by the UI and the copy summary)                */
/* ------------------------------------------------------------------ */

/** <500ms good · 500–1000 moderate · 1–3s slow · >3s very slow. */
export function classifyDuration(ms: number): ApiDiagnosticsDurationClass {
  if (ms < 500) return 'good';
  if (ms < 1000) return 'moderate';
  if (ms <= 3000) return 'slow';
  return 'very_slow';
}

/**
 * Extract the server-side total from a Server-Timing header. Prefers the
 * `total` metric (what this app's server emits); otherwise the largest
 * single `dur`. Returns null when absent/unparseable.
 */
export function parseServerTimingTotal(header: string | null): number | null {
  if (!header) return null;
  let total: number | null = null;
  const metric = /([A-Za-z0-9_-]+)\s*;\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = metric.exec(header)) !== null) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      if (match[1].toLowerCase() === 'total') return Math.round(value);
      total = total === null ? value : Math.max(total, value);
    }
  }
  return total === null ? null : Math.round(total);
}

/** 823 ms · 2.84 s — compact mobile-friendly duration text. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatTimestamp(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('en-GB', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function formatClock(epochMs: number | null): string {
  if (epochMs === null) return '—';
  try {
    return new Date(epochMs).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

/**
 * Sanitize a request URL for storage/display:
 * - absolute URLs are reduced to their path,
 * - query KEYS are kept (useful for diagnosis) but VALUES survive only
 *   for the safe allowlist — everything else becomes `…` (a default-deny
 *   policy, so lead names/phones/tokens in a query can never be stored),
 * - the result is length-capped.
 */
export function sanitizeApiPath(rawUrl: string): string {
  let text = String(rawUrl ?? '');
  let pathname = text;
  let query = '';

  const schemeIndex = text.indexOf('://');
  if (schemeIndex !== -1) {
    const afterScheme = text.indexOf('/', schemeIndex + 3);
    pathname = afterScheme === -1 ? '/' : text.slice(afterScheme);
  }
  const queryIndex = pathname.indexOf('?');
  if (queryIndex !== -1) {
    query = pathname.slice(queryIndex + 1);
    pathname = pathname.slice(0, queryIndex);
  }

  if (query) {
    const parts = query.split('&').map(part => {
      const eq = part.indexOf('=');
      if (eq === -1) return part;
      const rawKey = part.slice(0, eq);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep the raw key when it is not valid percent-encoding
      }
      const normalized = decodedKey.trim().toLowerCase();
      const safeValue = SAFE_QUERY_KEYS.has(normalized) ? part.slice(eq + 1) : '…';
      return `${rawKey}=${safeValue}`;
    });
    return cap(`${pathname}?${parts.join('&')}`, MAX_PATH_LENGTH);
  }
  return cap(pathname, MAX_PATH_LENGTH);
}

function cap(text: string, maxLength: number): string {
  const trimmed = String(text ?? '').slice(0, maxLength);
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Logout hygiene                                                      */
/* ------------------------------------------------------------------ */

let authWatcherInstalled = false;

/**
 * Clears diagnostics on identity transitions of the auth store. Reads
 * state only — the auth/session flow itself is not modified.
 *
 * - logout (button, idle timeout, server-rejected 401): wipe EVERYTHING.
 * - login (fresh sign-in): wipe everything EXCEPT the just-completed
 *   POST /api/auth/login of THIS session, so the fresh-login diagnostic
 *   the admin is testing for stays visible as request #1. Nothing from
 *   before the login can survive this transition.
 * - user id change between two authenticated states: wipe EVERYTHING.
 *
 * In every case the buffer is re-bound to the current session scope so
 * the next ensureSessionScope() call cannot re-wipe the retained entry.
 */
function ensureLogoutWatcher(): void {
  if (authWatcherInstalled) return;
  authWatcherInstalled = true;
  try {
    useAuthStore.subscribe((state, prevState) => {
      const sessionEnded = prevState.isAuthenticated && !state.isAuthenticated;
      const sessionStarted = !prevState.isAuthenticated && state.isAuthenticated;
      const userChanged =
        state.isAuthenticated &&
        prevState.isAuthenticated &&
        String(state.user?.id ?? '') !== String(prevState.user?.id ?? '');
      if (sessionEnded || userChanged) {
        clearApiDiagnostics();
        bufferScope = currentSessionScope();
        return;
      }
      if (sessionStarted) {
        retainOnlyFreshLogin();
        bufferScope = currentSessionScope();
      }
    });
  } catch {
    // A subscribe failure must never break requests; the session-scope
    // wipe in ensureSessionScope() still guards cross-user carryover.
  }
}
