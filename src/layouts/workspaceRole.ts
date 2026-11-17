import {
  callerHasTeam,
  type TeamOverviewResponse,
} from '../modules/team/services/teamOverviewService';

/**
 * workspaceRole.ts — the ONE place that decides which workspace a caller
 * sees (role-dashboard redesign, Phase 1, 2026-11-17).
 * ------------------------------------------------------------------
 * The sample prototype shipped a role-switcher dropdown. That is demo
 * furniture and is NEVER built: a member must never be able to switch
 * into a Manager view. The workspace role is DERIVED from the caller's
 * real scope, exactly the way the TL+ home landing already decides
 * (callerSeesTeam / the scoped overview), and the data endpoints stay
 * server-scoped regardless of what the shell shows.
 *
 *   overview scope 'Organization' -> 'manager'   (admin / CEO / BH:
 *                                                 the server forces
 *                                                 Organization scope)
 *   overview scope 'Team'         -> 'teamLead'  (sees a team)
 *   overview scope 'Own' (or an empty/unknown scope — the server
 *                        always sends one of the three, so anything
 *                        else is a degraded payload) -> 'teamLead'
 *                        when the caller has >= 1 direct report
 *                        (the UM-1 tree fact: an Own-scope user
 *                        WITH subordinates sees their team's
 *                        leads), else 'member' — the same fallback
 *                        callerSeesTeam applies to an empty scope
 *   no overview yet (still loading) -> fail closed to 'member',
 *                                    except an admin-bypass caller
 *                                    (ADMIN / SUPERADMIN), whose
 *                                    scope is Organization by server
 *                                    rule even before the overview
 *                                    lands — they get 'manager'.
 *
 * The function is pure so the node test suite can pin every branch
 * without a browser.
 */

export type WorkspaceRole = 'member' | 'teamLead' | 'manager';

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  member: 'Team Member',
  teamLead: 'Team Lead',
  manager: 'Manager',
};

/** The home page's easy name per workspace role (display label only). */
export const WORKSPACE_HOME_LABELS: Record<WorkspaceRole, string> = {
  member: 'My Work',
  teamLead: 'Team Overview',
  manager: 'Business Overview',
};

export function deriveWorkspaceRole(
  overview: TeamOverviewResponse | null | undefined,
  isAdminBypass: boolean,
): WorkspaceRole {
  const scope = overview?.scope;
  if (scope === 'Organization') return 'manager';
  if (scope === 'Team') return 'teamLead';
  // 'Own' — or an empty/unknown scope on a payload that did arrive:
  // the tree fact decides, exactly as callerSeesTeam does for the
  // landing. Only a MISSING overview fails closed below.
  if (overview) return callerHasTeam(overview.people) ? 'teamLead' : 'member';
  // No overview yet: never guess a team view. An admin-bypass caller is
  // the one exception — the server forces their scope to Organization.
  return isAdminBypass ? 'manager' : 'member';
}
