import { RolePermission } from '../modules/shared/types';

/**
 * menuVisibility.ts
 * ------------------------------------------------------------------
 * The single, authoritative navigation visibility check, used by the
 * primary navigation, the More directories AND the route-level
 * FeatureGate, so a page can never disagree with the menu entry that
 * leads to it.
 *
 *   1. ADMIN / SUPERADMIN always pass (bypass).
 *   2. A configured dynamic role `menuAccess` entry for the path wins
 *      (explicit true OR false — a false entry hides the item).
 *   3. Otherwise the static role fallback (item.roles) applies. The
 *      sentinel `'*'` in that list means "any authenticated role" — used
 *      by the organization-wide pages (Home, My Work, Leads, the lead
 *      sub-routes, More, Calendar, Settings ...). Privileged pages keep
 *      explicit role lists, so the fallback stays fail-closed there.
 *
 * Why the sentinel: the role catalogue is data, not code. A database may
 * hold MANAGER / TEAM_LEAD / EMPLOYEE / SBE / SM / CEO (and admin-created
 * custom codes) while the static lists were written against the older
 * enum — an employee therefore saw a "no access" app on a fresh install
 * even though every server-side permission was granted. `'*'` states the
 * intent ("everyone") instead of enumerating codes that can rot, and the
 * server keeps enforcing canonical permissions on every request.
 *
 * Grouping is purely visual and must never change this.
 */

export interface MenuVisibilityItem {
  path: string;
  roles: string[];
}

/** Sentinel for "every authenticated role is allowed by default". */
export const ANY_ROLE = '*';

export function resolveMenuVisibility(
  userRoleName: string,
  matchedPermission: RolePermission | undefined,
  item: MenuVisibilityItem
): boolean {
  // If Admin, they always have access to everything
  const userRoleNormalized = String(userRoleName || '').toUpperCase();
  if (userRoleNormalized === 'ADMIN' || userRoleNormalized === 'SUPERADMIN') return true;

  // Check if custom / role permission overrides menu access
  if (matchedPermission && matchedPermission.menuAccess !== undefined) {
    if (matchedPermission.menuAccess[item.path] !== undefined) {
      return matchedPermission.menuAccess[item.path];
    }
  }

  // Otherwise fallback to static roles check
  if (item.roles.includes(ANY_ROLE)) return true;
  return item.roles.includes(userRoleNormalized) || item.roles.includes(userRoleName);
}

/**
 * The same `menuAccess` lookup without the static fallback: does the
 * caller's role matrix EXPLICITLY allow a path?
 *
 * Pages that need to agree with the "/roadshows" menu entry (the Home and
 * My Work roadshow alerts) use this together with `canAccess(...)`, so
 * the two feature layers that describe the same capability can never
 * disagree on screen: either signal opens the row, and the server still
 * decides whether any data comes back.
 */
export function hasMenuAccessFor(
  roles: RolePermission[] | null | undefined,
  userRoleName: string | null | undefined,
  menuPath: string
): boolean {
  const role = String(userRoleName || '').trim();
  if (!role || !Array.isArray(roles)) return false;
  const normalized = role.toUpperCase();
  const matched = roles.find(
    (rp) => String(rp?.roleId || '').toUpperCase() === normalized
  );
  return matched?.menuAccess?.[menuPath] === true;
}
