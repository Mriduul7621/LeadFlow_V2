import { UserRole } from '../modules/shared/types';
import { ANY_ROLE, resolveMenuVisibility } from './menuVisibility';
import type { RolePermission } from '../modules/shared/types';
import { rolesWithDefaultGrant } from '../modules/shared/access/roleGrantDefaults';

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
 *   4. Team Lead predicate (2026-11-19): a route marked
 *      `teamLeadAllowed` also opens to any caller with ≥1 subordinate
 *      — Team Lead is derived from the reporting tree, never a role
 *      code — but ONLY where no explicit `menuAccess` entry exists
 *      (rule 2 still wins). Without the tree fact the predicate
 *      cannot fire and the static fallback decides.
 *   5. Manager predicate (2026-11-20): a route marked
 *      `managerAllowed` also opens to a caller whose DERIVED
 *      enterprise role is Manager (FullTeam/Organization scope) —
 *      again only where no explicit `menuAccess` entry exists.
 *      This is the route-level twin of the server's Manager-scope
 *      arm (callerHasTeamScope): a no-reports Manager may upload
 *      leads and manage their team's users.
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
 *
 * DERIVED, not retyped (F16 §3.3): the list is exactly the standard roles
 * the DEFAULT grant table gives `reports.view` — so the page gate and the
 * server's data permission can never disagree again. That decision
 * (2026-10-15) resolved the divergence the F16 audit found: the server
 * already granted MANAGER / SM / RM / TEAM_LEAD / BDM / ASM `reports.view`
 * while this fallback only listed ADMIN/RO/RM/CEO, hiding from a manager
 * the very reports the server was willing to serve. ADMIN/SUPERADMIN need
 * no entry here (bypass above).
 *
 * Enterprise Preview (2026-11-19): the field roles (RO/BE/SBE/EMPLOYEE)
 * now carry `reports.view` in the default table too, because the
 * sample's Agent nav includes MY PERFORMANCE → Performance and NCP
 * Progress. The list below derives from the table, so it picked the
 * field roles up automatically — no hardcoded list to keep in sync.
 * An admin who wants a frontline role NOT to see reports revokes
 * `reports.view` in Roles & Access (its Reports module).
 */
const INSIGHT_ROLES: string[] = [
  UserRole.ADMIN,
  ...rolesWithDefaultGrant('reports.view'),
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
  /**
   * Team Lead predicate (2026-11-19): when true, any caller with ≥1
   * subordinate may open the route — Team Lead is derived from the
   * reporting tree, never a role code. An explicit `menuAccess`
   * entry for the route's path still wins over the predicate (the
   * admin's per-role control is never overridden by it).
   */
  teamLeadAllowed?: boolean;
  /**
   * Manager predicate (2026-11-20): when true, a caller whose
   * DERIVED enterprise role is Manager (FullTeam/Organization
   * scope) may open the route — same gap-filling semantics as
   * teamLeadAllowed (an explicit `menuAccess` entry still wins).
   */
  managerAllowed?: boolean;
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
  '/audit-log': { route: '/audit-log', path: '/audit-log', roles: DIAGNOSTICS_ADMIN_ROLES },
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
  // Team Lead My Leads (2026-11-20): own-only list. EVERYONE at the
  // route level — the page itself gates to the Team Lead display
  // role (other roles are redirected to /leads), because the route
  // gate cannot express a display-role rule.
  '/leads/my': { route: '/leads/my', path: '/leads', roles: EVERYONE },
  '/leads/new': { route: '/leads/new', path: '/leads/new', roles: EVERYONE },
  // Team Lead lead upload (2026-11-19, Mahadi; Manager arm added
  // 2026-11-20): Lead Intake opens to ADMIN, anyone with ≥1
  // subordinate (the teamLeadAllowed predicate), or a derived
  // Manager (the managerAllowed predicate) — a plain Agent stays
  // blocked. The static ADMIN_ONLY fallback is unchanged: it
  // decides only when the tree/role facts are unavailable, and an
  // explicit menuAccess entry still wins.
  '/leads/upload': { route: '/leads/upload', path: '/leads/upload', roles: ADMIN_ONLY, teamLeadAllowed: true, managerAllowed: true },
  '/leads/all': { route: '/leads/all', path: '/leads/all', roles: ADMIN_ONLY },
  '/leads/:id/update': { route: '/leads/:id/update', path: '/leads', roles: EVERYONE },
  // Lead details edit (2026-11-20): same as /leads/:id/update —
  // the route is open to every role and the page itself gates on
  // leads.edit (lead_tracking.edit), with the server re-checking
  // the grant and visibility on the save.
  '/leads/:id/edit': { route: '/leads/:id/edit', path: '/leads', roles: EVERYONE },
  '/execution-intelligence': { route: '/execution-intelligence', path: '/execution-intelligence', roles: INSIGHT_ROLES },
  // Self Performance / My Performance (2026-11-20): the Agent
  // performance layout on the caller's OWN leads. EVERYONE at the
  // route level — the page gates to the Team Lead / Manager display
  // roles (others are redirected to /execution-intelligence).
  '/performance/self': { route: '/performance/self', path: '/execution-intelligence', roles: EVERYONE },
  '/ncp-progress': { route: '/ncp-progress', path: '/ncp-progress', roles: INSIGHT_ROLES },
  '/trend-charts': { route: '/trend-charts', path: '/trend-charts', roles: INSIGHT_ROLES },
  '/campaign-breakdown': { route: '/campaign-breakdown', path: '/campaign-breakdown', roles: INSIGHT_ROLES },
  // FIX-1: the Team overview follows the owner's model — anyone may
  // open it; the endpoint returns only their own scope (a leaf employee
  // sees just themself). The old static TEAM_ROLES list contradicted
  // that model and hid the page from people with real subordinates.
  '/team': { route: '/team', path: '/team', roles: EVERYONE },
  // KPI drill-down (TL+ Home): same model as /team — anyone may open
  // it; the overview payload scopes what they see (a leaf member
  // sees only their own leads), and the leaf/export endpoints
  // enforce the same scope server-side.
  '/team/kpi/:kpi': { route: '/team/kpi/:kpi', path: '/team', roles: EVERYONE },
  '/team/organogram': { route: '/team/organogram', path: '/team', roles: EVERYONE },
  '/users': { route: '/users', path: '/users', roles: ADMIN_ONLY },
  // Team User Management (2026-11-20): the TL/Manager team list +
  // Employee add page. ADMIN_ONLY statically, opened by the same
  // teamLeadAllowed / managerAllowed predicates as Lead Intake —
  // and the page itself gates on the `users.add_employee` grant, so
  // a team lead WITHOUT the grant never sees the add flow even
  // though the route shell may open.
  '/users/team': { route: '/users/team', path: '/users', roles: ADMIN_ONLY, teamLeadAllowed: true, managerAllowed: true },
  '/settings': { route: '/settings', path: '/settings', roles: EVERYONE },
  '/settings/system': { route: '/settings/system', path: '/settings', roles: DIAGNOSTICS_ADMIN_ROLES },
  // Fix round (2026-11-19): the CONFIGURATION group's three pages
  // are three distinct routes, all in the same admin-only module
  // as /settings/system (same menuAccess key, same fallback).
  '/settings/status-pipeline': { route: '/settings/status-pipeline', path: '/settings', roles: DIAGNOSTICS_ADMIN_ROLES },
  '/settings/products-campaigns': { route: '/settings/products-campaigns', path: '/settings', roles: DIAGNOSTICS_ADMIN_ROLES },
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
 *
 * `context.hasSubordinates` is the tree fact for `teamLeadAllowed`
 * routes (from the caller's team overview): true opens the route when
 * no explicit `menuAccess` entry decides it. `context.isManager` is
 * the derived-enterprise-role fact for `managerAllowed` routes
 * (FullTeam/Organization scope). Omitted or false => the predicate
 * cannot fire and the static fallback decides.
 */
export function resolveFeatureRouteAccess(
  routeKey: string,
  userRoleName: string | null | undefined,
  matchedPermission: RolePermission | undefined,
  context?: { hasSubordinates?: boolean; isManager?: boolean }
): boolean {
  const entry = FEATURE_ROUTES[routeKey];
  if (!entry) return false; // unknown route key: fail closed
  const role = String(userRoleName || '').trim().toUpperCase();
  if (!role) return false; // no role: fail closed
  if (role === 'ADMIN' || role === 'SUPERADMIN') return true;
  // Team Lead / Manager predicates: the caller has a team (or
  // Manager scope) AND no explicit menuAccess entry decides this
  // route — the predicates only fill the gap where the admin has
  // not configured the role. An explicit false still hides the
  // route from a team lead or a manager.
  if ((entry.teamLeadAllowed && context?.hasSubordinates === true)
    || (entry.managerAllowed && context?.isManager === true)) {
    const explicit = matchedPermission?.menuAccess?.[entry.path];
    if (explicit === undefined) return true;
  }
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
/** The two candidate landing pages for the post-login / root decision. */
export const DASHBOARD_HOME_PATH = '/';
export const WORKBENCH_HOME_PATH = '/workbench';

/**
 * Post-login / root landing decision (Phase 2 — Workbench-first).
 * ------------------------------------------------------------------
 * A field user's day starts at the Daily Workbench (follow-ups due and
 * overdue — the actionable page), not the Dashboard. The decision is
 * ACCESS-based, not role-name-based: it is exactly the Layer B decision
 * for `/workbench` above, so it can never disagree with the sidebar or
 * the route gate.
 *
 * Evidence from the permission model: `/workbench` carries the ANY_ROLE
 * static fallback (and its data endpoint is auth-only), so EVERY
 * authenticated role — the sales hierarchy (RO/RM/ASM/BDM/BE/BH), ADMIN,
 * and database/custom codes (MANAGER, TEAM_LEAD, EMPLOYEE, SBE, SM,
 * CEO) — has Workbench access by default. The only callers kept on the
 * Dashboard are roles an admin explicitly hid `/workbench` from via a
 * dynamic `menuAccess['/workbench'] = false` entry (and the degenerate
 * no-role case, which fails to the historical default). The fail-closed
 * `workbench: { view: false }` seed in adminService is NOT this gate: it
 * is the Roles & Access editor's feature-permission default, itself
 * derived from menuAccess.
 *
 * Pure and directly unit-testable. Its once-per-session application used
 * to live in HomeLanding (modules/auth/components); the Enterprise
 * Preview redesign (2026-11-19) retired that component and the
 * Workbench-first bounce with it — `/` now renders the role overview
 * directly. This helper and the WORKBENCH_HOME_PATH / DASHBOARD_HOME_PATH
 * constants stay as tested utilities; removing them is later cleanup.
 */
export function resolveHomePath(
  userRoleName: string | null | undefined,
  matchedPermission: RolePermission | undefined
): string {
  return resolveFeatureRouteAccess(WORKBENCH_HOME_PATH, userRoleName, matchedPermission)
    ? WORKBENCH_HOME_PATH
    : DASHBOARD_HOME_PATH;
}

export function canResolveRouteAccess(
  routeKey: string,
  userRoleName: string | null | undefined,
  matchedPermission: RolePermission | undefined,
  context?: { teamSettled?: boolean; roleSettled?: boolean }
): boolean {
  const entry = FEATURE_ROUTES[routeKey];
  if (!entry) return true; // unknown route: fail closed now, do not wait
  const role = String(userRoleName || '').trim().toUpperCase();
  if (!role) return true; // unauthenticated: ProtectedRoute handles it
  if (role === 'ADMIN' || role === 'SUPERADMIN') return true;
  if (entry.roles.includes(ANY_ROLE)) return true;
  // Team Lead / Manager predicate routes: the answer may still
  // change while the team overview is loading — but only when no
  // explicit menuAccess entry already decides it (an explicit entry
  // wins over the predicates, so the tree/role facts are irrelevant
  // then). Callers that omit the context keep the old behaviour
  // (matrix-only).
  if ((entry.teamLeadAllowed || entry.managerAllowed) && context?.teamSettled === false) {
    const explicit = matchedPermission?.menuAccess?.[entry.path];
    if (explicit === undefined) return false;
  }
  // Manager predicate routes also wait for the enterprise-role
  // derivation itself (isManager comes from the role matrix's
  // dataVisibility, derived in the caller's own hook state — a
  // one-render lag after the matrix settles would otherwise
  // bounce a Manager out of Lead Intake on a cold load).
  if (entry.managerAllowed && context?.roleSettled === false) {
    const explicit = matchedPermission?.menuAccess?.[entry.path];
    if (explicit === undefined) return false;
  }
  return matchedPermission !== undefined;
}
