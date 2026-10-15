import { UserRole } from '../modules/shared/types';
import { ANY_ROLE, resolveMenuVisibility } from './menuVisibility';
import type { RolePermission } from '../modules/shared/types';

/**
 * featureRouteAccess.ts
 * ------------------------------------------------------------------
 * Feature Access (Layer B) at the ROUTE level.
 *
 * Primary navigation and More directories use module visibility toggles;
 * this module enforces the same decision at each route so a page cannot be
 * reached merely by typing its URL when its Feature Access module is off.
 *
 * Semantics follow the current navigation:
 *   1. ADMIN / SUPERADMIN always pass (established bypass — the server
 *      treats SUPERADMIN like ADMIN in every authz helper).
 *   2. A dynamic role `menuAccess` entry for the route's module path
 *      wins (explicit true OR false).
 *   3. Otherwise the static role fallback for that module applies.
 *      Organization-wide routes use the ANY_ROLE ('*') sentinel so they
 *      work for every authenticated role — including the role codes that
 *      live in the database (MANAGER, TEAM_LEAD, EMPLOYEE, SBE, SM, CEO)
 *      and admin-created custom codes — without pinning a stale enum
 *      list in the client. Privileged routes keep explicit lists and
 *      stay fail-closed.
 *
 * This is a UX/visibility gate, NOT a security boundary: the server
 * keeps enforcing canonical Action Permissions and Data Visibility on
 * every request regardless of what a page renders.
 */

/** Static role fallbacks — must stay aligned with the primary navigation and More directories. */
const ADMIN_ONLY: string[] = [UserRole.ADMIN];
const DIAGNOSTICS_ADMIN_ROLES: string[] = ['ADMIN', 'SUPERADMIN'];

/**
 * Org-wide fallback: every authenticated role. See the ANY_ROLE note in
 * menuVisibility.ts — the server is the authority on data, this only
 * decides whether a page shell may render.
 */
const EVERYONE: string[] = [ANY_ROLE];

/**
 * Insight/report pages and team roll-ups are privileged by default (the
 * business rule: performance analytics are not visible to everyone); an
 * admin can still grant them per role through Roles & Access, which
 * writes `menuAccess` and wins over this fallback.
 */
const INSIGHT_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.RO,
  UserRole.RM,
  // The CEO sits above the org and must see performance by default; every
  // other non-legacy role needs an explicit Roles & Access grant (which
  // writes menuAccess and wins over this fallback).
  'CEO',
];
const TEAM_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.RM,
  UserRole.ASM,
  UserRole.BDM,
  UserRole.BUSINESS_EXECUTIVE,
  UserRole.BUSINESS_HEAD,
  'MANAGER',
  'SM',
  'TEAM_LEAD',
  'BDM',
];
/**
 * Roadshows stay behind explicit role lists (never ANY_ROLE): the business
 * rule is that roadshow visibility is a deliberate grant, so a role with
 * no `menuAccess['/roadshows']` entry must not get the page shell by
 * default.
 */
const ROADSHOW_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.RO,
  UserRole.RM,
  UserRole.ASM,
  UserRole.BDM,
  UserRole.BUSINESS_EXECUTIVE,
  UserRole.BUSINESS_HEAD,
  'MANAGER',
  'SM',
  'TEAM_LEAD',
  'BDM',
  'SBE',
];

export interface FeatureRouteEntry {
  /** Route key used by FeatureGate (router path pattern). */
  route: string;
  /** menuAccess path key — exactly the navigation item's path. */
  path: string;
  /** Static role fallback (navigation parity). */
  roles: string[];
}

/**
 * Every production page route -> the Feature Access module that drives
 * it. `/leads/:id` (Lead 360) is a sub-resource of the Lead Workspace
 * module, so it inherits the `/leads` menuAccess key.
 */
export const FEATURE_ROUTES: Record<string, FeatureRouteEntry> = {
  '/': { route: '/', path: '/', roles: EVERYONE },
  '/more': { route: '/more', path: '/more', roles: EVERYONE },
  '/administration': { route: '/administration', path: '/administration', roles: DIAGNOSTICS_ADMIN_ROLES },
  '/notifications': { route: '/notifications', path: '/notifications', roles: EVERYONE },
  '/help': { route: '/help', path: '/help', roles: EVERYONE },
  '/about': { route: '/about', path: '/about', roles: EVERYONE },
  '/roadshows': { route: '/roadshows', path: '/roadshows', roles: ROADSHOW_ROLES },
  '/sales-pipeline': { route: '/sales-pipeline', path: '/sales-pipeline', roles: EVERYONE },
  '/workbench': { route: '/workbench', path: '/workbench', roles: EVERYONE },
  '/activities': { route: '/activities', path: '/activities', roles: EVERYONE },
  '/task-calendar': { route: '/task-calendar', path: '/task-calendar', roles: EVERYONE },
  '/follow-up': { route: '/follow-up', path: '/follow-up', roles: EVERYONE },
  '/leads': { route: '/leads', path: '/leads', roles: EVERYONE },
  '/leads/new': { route: '/leads/new', path: '/leads/new', roles: EVERYONE },
  '/leads/upload': { route: '/leads/upload', path: '/leads/upload', roles: ADMIN_ONLY },
  '/leads/all': { route: '/leads/all', path: '/leads/all', roles: ADMIN_ONLY },
  '/leads/:id/update': { route: '/leads/:id/update', path: '/leads', roles: EVERYONE },
  '/execution-intelligence': { route: '/execution-intelligence', path: '/execution-intelligence', roles: INSIGHT_ROLES },
  '/ncp-progress': { route: '/ncp-progress', path: '/ncp-progress', roles: INSIGHT_ROLES },
  '/trend-charts': { route: '/trend-charts', path: '/trend-charts', roles: INSIGHT_ROLES },
  '/campaign-breakdown': { route: '/campaign-breakdown', path: '/campaign-breakdown', roles: INSIGHT_ROLES },
  '/team': { route: '/team', path: '/team', roles: TEAM_ROLES },
  '/users': { route: '/users', path: '/users', roles: ADMIN_ONLY },
  '/settings': { route: '/settings', path: '/settings', roles: EVERYONE },
  '/settings/system': { route: '/settings/system', path: '/settings', roles: DIAGNOSTICS_ADMIN_ROLES },
  '/settings/performance-diagnostics': {
    route: '/settings/performance-diagnostics',
    path: '/settings/performance-diagnostics',
    roles: DIAGNOSTICS_ADMIN_ROLES,
  },
  /** Lead 360 detail — inherits the Lead Workspace module. */
  '/leads/:id': { route: '/leads/:id', path: '/leads', roles: EVERYONE },
};

/**
 * Pure route-level Feature Access decision (directly unit-testable).
 * `matchedPermission` is the caller's role permission profile (as the
 * navigation resolves it); undefined => static role fallback, exactly like
 * the navigation before any dynamic data has loaded.
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

/**
 * Whether the route decision can be made AT ALL yet.
 *
 * `resolveFeatureRouteAccess` is pure: with no role matrix it falls back
 * to the static lists. That is the right answer for ADMIN and for the
 * ANY_ROLE routes, but for a role that only its own `menuAccess` row can
 * authorize (a role the admin has configured, or specifically hidden)
 * the static answer is a GUESS. Deciding on that guess was the
 * "hard reload bounces to Home" bug: every cold load re-evaluated the
 * route before the role matrix arrived.
 *
 * Callers therefore wait while this returns false instead of redirecting:
 *   - every route key must be known (unknown = fail closed immediately),
 *   - ADMIN/SUPERADMIN never wait (synchronous bypass),
 *   - ANY_ROLE routes never wait (the answer cannot change),
 *   - no matrix yet -> the answer may still change -> wait,
 *   - matrix present -> the answer is final.
 */
export function canResolveRouteAccess(
  routeKey: string,
  userRoleName: string | null | undefined,
  matchedPermission: RolePermission | undefined
): boolean {
  const entry = FEATURE_ROUTES[routeKey];
  if (!entry) return true; // unknown route: fail closed now, do not wait
  const role = String(userRoleName || '').trim().toUpperCase();
  if (!role) return true; // unauthenticated: ProtectedRoute handles it
  if (role === 'ADMIN' || role === 'SUPERADMIN') return true;
  if (entry.roles.includes(ANY_ROLE)) return true;
  return matchedPermission !== undefined;
}
