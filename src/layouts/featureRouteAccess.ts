import { UserRole } from '../modules/shared/types';
import { resolveMenuVisibility } from './menuVisibility';
import type { RolePermission } from '../modules/shared/types';

/**
 * featureRouteAccess.ts
 * ------------------------------------------------------------------
 * Feature Access (Layer B) at the ROUTE level.
 *
 * The sidebar already hides menu items whose module toggle is off
 * (`AppLayout` + `resolveMenuVisibility`); this module enforces the
 * SAME decision at the route so a page cannot be reached merely by
 * typing its URL when the corresponding Feature Access module is
 * disabled for the caller's role.
 *
 * Semantics are intentionally identical to the sidebar:
 *   1. ADMIN / SUPERADMIN always pass (established bypass — the server
 *      treats SUPERADMIN like ADMIN in every authz helper).
 *   2. A dynamic role `menuAccess` entry for the route's module path
 *      wins (explicit true OR false).
 *   3. Otherwise the static role fallback for that module applies.
 *
 * This is a UX/visibility gate, NOT a security boundary: the server
 * keeps enforcing canonical Action Permissions and Data Visibility on
 * every request regardless of what a page renders.
 */

/** Static role fallbacks — must stay aligned with AppLayout menuSections. */
const ALL_ROLES: string[] = Object.values(UserRole);
const INSIGHT_ROLES: string[] = [UserRole.ADMIN, UserRole.RO, UserRole.RM];
const TEAM_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.RM,
  UserRole.ASM,
  UserRole.BDM,
  UserRole.BUSINESS_EXECUTIVE,
  UserRole.BUSINESS_HEAD,
];
const ADMIN_ONLY: string[] = [UserRole.ADMIN];
const DIAGNOSTICS_ADMIN_ROLES: string[] = ['ADMIN', 'SUPERADMIN'];

export interface FeatureRouteEntry {
  /** Route key used by FeatureGate (router path pattern). */
  route: string;
  /** menuAccess path key — exactly the sidebar item's path. */
  path: string;
  /** Static role fallback (sidebar parity). */
  roles: string[];
}

/**
 * Every production page route -> the Feature Access module that drives
 * it. `/leads/:id` (Lead 360) is a sub-resource of the Lead Workspace
 * module, so it inherits the `/leads` menuAccess key.
 */
export const FEATURE_ROUTES: Record<string, FeatureRouteEntry> = {
  '/': { route: '/', path: '/', roles: ALL_ROLES },
  '/workbench': { route: '/workbench', path: '/workbench', roles: ALL_ROLES },
  '/activities': { route: '/activities', path: '/activities', roles: ALL_ROLES },
  '/task-calendar': { route: '/task-calendar', path: '/task-calendar', roles: ALL_ROLES },
  '/follow-up': { route: '/follow-up', path: '/follow-up', roles: ALL_ROLES },
  '/leads': { route: '/leads', path: '/leads', roles: ALL_ROLES },
  '/leads/new': { route: '/leads/new', path: '/leads/new', roles: ALL_ROLES },
  '/leads/upload': { route: '/leads/upload', path: '/leads/upload', roles: ADMIN_ONLY },
  '/leads/all': { route: '/leads/all', path: '/leads/all', roles: ADMIN_ONLY },
  '/execution-intelligence': { route: '/execution-intelligence', path: '/execution-intelligence', roles: INSIGHT_ROLES },
  '/ncp-progress': { route: '/ncp-progress', path: '/ncp-progress', roles: INSIGHT_ROLES },
  '/trend-charts': { route: '/trend-charts', path: '/trend-charts', roles: INSIGHT_ROLES },
  '/campaign-breakdown': { route: '/campaign-breakdown', path: '/campaign-breakdown', roles: INSIGHT_ROLES },
  '/team': { route: '/team', path: '/team', roles: TEAM_ROLES },
  '/users': { route: '/users', path: '/users', roles: ADMIN_ONLY },
  '/settings': { route: '/settings', path: '/settings', roles: ALL_ROLES },
  '/settings/performance-diagnostics': {
    route: '/settings/performance-diagnostics',
    path: '/settings/performance-diagnostics',
    roles: DIAGNOSTICS_ADMIN_ROLES,
  },
  /** Lead 360 detail — inherits the Lead Workspace module. */
  '/leads/:id': { route: '/leads/:id', path: '/leads', roles: ALL_ROLES },
};

/**
 * Pure route-level Feature Access decision (directly unit-testable).
 * `matchedPermission` is the caller's role permission profile (as the
 * sidebar resolves it); undefined => static role fallback, exactly like
 * the sidebar before any dynamic data has loaded.
 */
export function resolveFeatureRouteAccess(
  routeKey: string,
  userRoleName: string | null | undefined,
  matchedPermission: RolePermission | undefined
): boolean {
  const entry = FEATURE_ROUTES[routeKey];
  if (!entry) return false; // unknown route key: fail closed
  const role = String(userRoleName || '').trim().toUpperCase();
  if (!role) return false; // no role: fail closed
  if (role === 'ADMIN' || role === 'SUPERADMIN') return true;
  return resolveMenuVisibility(userRoleName, matchedPermission, {
    path: entry.path,
    roles: entry.roles,
  });
}
