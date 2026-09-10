import { RolePermission } from '../modules/shared/types';

/**
 * menuVisibility.ts
 * ------------------------------------------------------------------
 * The single, authoritative sidebar visibility check, extracted verbatim
 * from AppLayout so the exact menuAccess semantics are unit-testable:
 *
 *   1. ADMIN always sees everything (bypass).
 *   2. A configured dynamic role `menuAccess` entry for the path wins
 *      (explicit true OR false — a false entry hides the item).
 *   3. Otherwise the static role fallback (item.roles) applies.
 *
 * Grouping in the sidebar is purely visual and must never change this.
 */

export interface MenuVisibilityItem {
  path: string;
  roles: string[];
}

export function resolveMenuVisibility(
  userRoleName: string,
  matchedPermission: RolePermission | undefined,
  item: MenuVisibilityItem
): boolean {
  // If Admin, they always have access to everything
  const userRoleNormalized = String(userRoleName || '').toUpperCase();
  if (userRoleNormalized === 'ADMIN') return true;

  // Check if custom / role permission overrides menu access
  if (matchedPermission && matchedPermission.menuAccess !== undefined) {
    if (matchedPermission.menuAccess[item.path] !== undefined) {
      return matchedPermission.menuAccess[item.path];
    }
  }

  // Otherwise fallback to static roles check
  return item.roles.includes(userRoleNormalized) || item.roles.includes(userRoleName);
}
