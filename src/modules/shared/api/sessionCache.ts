/**
 * sessionCache.ts
 * ------------------------------------------------------------------
 * In-memory, session-scoped cache for shared, user-specific session data
 * (role/menu permissions, the notification list, the user's own
 * permission sheet).
 *
 * Why this exists: every protected route mounts the full AppLayout, so
 * without a session-scoped cache the SAME requests (roles, notifications,
 * permission sheet) would be re-issued on every single navigation. This
 * cache lets a fresh result be reused across route changes within one
 * browser session.
 *
 * Rules:
 * - Entries are ALWAYS keyed by the authenticated user, never shared
 *   across users (the whole cache is cleared on logout).
 * - It is a read-through cache only: entries are written exclusively
 *   AFTER a successful API response (DB/API remains authoritative) and
 *   invalidated by the explicit role/permission save flows.
 * - It is not persisted and is never consulted for authorization on the
 *   server: all security decisions stay server-side.
 * - localStorage remains a separate offline read cache; it is never
 *   authoritative for auth/permissions either.
 */

export interface SessionCacheEntry<T> {
  value: T;
  /** Epoch ms when the value was last confirmed by the server. */
  fetchedAt: number;
}

const entries = new Map<string, SessionCacheEntry<any>>();

/** Read a session-scoped entry (null when absent or already invalidated). */
export function readSessionCache<T>(key: string): SessionCacheEntry<T> | null {
  const entry = entries.get(key);
  return entry ? (entry as SessionCacheEntry<T>) : null;
}

/** Record a server-confirmed value (updates the freshness timestamp). */
export function writeSessionCache<T>(key: string, value: T): void {
  entries.set(key, { value, fetchedAt: Date.now() });
}

/**
 * Apply a locally-confirmed mutation to a cached value (e.g. marking a
 * notification read AFTER the server accepted the change). Keeps the
 * freshness timestamp: the data was just confirmed, not refetched.
 */
export function updateSessionCache<T>(key: string, transform: (value: T) => T): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.set(key, { value: transform(entry.value as T), fetchedAt: entry.fetchedAt });
}

/** Drop one entry (role/permission change flows invalidate their entry). */
export function invalidateSessionCache(key: string): void {
  entries.delete(key);
}

/** Clear EVERY entry. Called on logout: nothing may cross user boundaries. */
export function clearSessionCache(): void {
  entries.clear();
}

/**
 * Test seam: the cache is intentionally per page-load (like the rest of
 * the auth state); tests need a clean slate between cases.
 */
export function resetSessionCacheForTests(): void {
  entries.clear();
}
