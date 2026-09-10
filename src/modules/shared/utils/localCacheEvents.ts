/**
 * localCacheEvents.ts
 * ------------------------------------------------------------------
 * Same-tab invalidation for the localStorage role/permission cache
 * (`lf_local_roles_permissions`).
 *
 * The browser only fires `storage` events in OTHER tabs, so without a
 * same-tab signal the `usePermissions` hook used a 3-second localStorage
 * poll to notice writes made in the current tab. That poll re-rendered
 * every permission-consuming component on a timer. Instead, the writer
 * (adminService) now emits this event right after it writes the cache,
 * and the hook listens to it — freshness with zero polling.
 */

export const ROLES_CACHE_CHANGED_EVENT = 'lf-roles-cache-changed';

/** Fire after a same-tab write of the role/permission localStorage cache. */
export function emitRolesCacheChanged(): void {
  try {
    window.dispatchEvent(new Event(ROLES_CACHE_CHANGED_EVENT));
  } catch {
    // Non-browser environment (SSR/tests) — nothing to notify.
  }
}
