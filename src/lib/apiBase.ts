/// <reference types="vite/client" />
/**
 * apiBase.ts — where the API lives when the app is not served by it.
 * ------------------------------------------------------------------
 * The web app is served BY the API (same origin, `/api/...` just works). The
 * Android app built with Capacitor is NOT: it loads the bundled assets from
 * `https://localhost` inside the WebView, so a relative `/api/leads` would ask
 * the WebView's own (empty) origin for leads and fail. The bundled build bakes
 * the API origin in at build time (CI passes `VITE_API_BASE_URL`), and this
 * module is the ONE place that decides what that base is:
 *
 *   1. a runtime override (`window.__LEADFLOW_API_BASE__`) — an escape hatch for
 *      a build that must be pointed somewhere else without rebuilding,
 *   2. the build-time value (`VITE_API_BASE_URL`, injected by Vite),
 *   3. nothing — meaning "same origin", which is what the web app wants.
 *
 * Everything is pure and dependency-free so the resolution rules can be tested
 * without a browser, and so exactly one module owns the answer (the F16 §3.3
 * lesson: two places that each decide the same thing will eventually disagree).
 */

/** The origins a Capacitor WebView runs under (Android/iOS/web-preview). */
export const CAPACITOR_WEBVIEW_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
];

/**
 * Accept only a plain http(s) origin and strip trailing slashes. Anything else
 * (a path, a query, a javascript: URL, a typo) is refused rather than guessed
 * at — a wrong API base produces confusing 404s far from the mistake.
 */
export function normalizeApiBase(raw?: string | null): string {
  if (raw === null || raw === undefined) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return '';
    // Keep the origin only: a base with a path would produce
    // `https://host/some/path/api/leads`.
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** Build-time value, injected by Vite. Safe to call outside a browser/tsx. */
function bakedApiBase(): string {
  try {
    return String(import.meta.env.VITE_API_BASE_URL || '');
  } catch {
    // Running under node (tests, scripts): there is no import.meta.env.
    return '';
  }
}

/** Runtime override, set by an embedding shell before the app boots. */
function runtimeApiBase(): string {
  try {
    return String((globalThis as any).__LEADFLOW_API_BASE__ || '');
  } catch {
    return '';
  }
}

/**
 * The base every `/api/...` call is prefixed with. Empty string = same origin
 * (the web deployment), which is why this never has to be "unset".
 */
export function resolveApiBaseUrl(runtimeOverride?: string | null): string {
  return (
    normalizeApiBase(runtimeOverride ?? runtimeApiBase()) ||
    normalizeApiBase(bakedApiBase()) ||
    ''
  );
}

/**
 * Prefix a request path with the API base.
 *
 * Only same-origin API paths are rewritten: absolute URLs (`https://…`, which a
 * caller may have built on purpose), protocol-relative URLs (`//host/x`), data
 * URIs and every non-API asset path are returned untouched. With no base
 * configured the input is returned unchanged, so the web behaviour is exactly
 * what it was before this module existed.
 */
export function withApiBase(url: string, base: string): string {
  const normalized = normalizeApiBase(base);
  if (!normalized) return url;
  if (typeof url !== 'string' || !url) return url;
  if (!url.startsWith('/')) return url;
  if (url.startsWith('//')) return url;
  if (!url.startsWith('/api/') && url !== '/api') return url;
  return `${normalized}${url}`;
}
