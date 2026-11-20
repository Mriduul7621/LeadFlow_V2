/**
 * enterpriseRole.ts — the derived enterprise workspace role
 * (Enterprise Preview redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample prototype's four workspaces (Admin / Manager / Team
 * Lead / Agent) are NOT a switcher: the caller sees exactly one,
 * derived from their real access. There is no control anywhere that
 * switches it — a member must never switch into a Manager/Admin view.
 *
 * Derivation (pure, unit-testable, no React):
 *
 *   1. ADMIN / SUPERADMIN role                    -> admin
 *   2. data visibility FullTeam / Organization    -> manager
 *      (the role's configured scope, from the role matrix; this is
 *      what catches a department manager with no direct reports —
 *      their overview scope is 'Team' but they oversee full teams)
 *   3. overview scope 'Organization'              -> manager
 *      (the matrix has not loaded yet: Organization scope means
 *      sees-everyone, which only managers/executives hold)
 *   4. >= 1 direct report (the UM-1 tree fact)    -> teamLead
 *   5. everyone else                              -> agent
 *
 * The overview scope comes from GET /team/overview and is only ever
 * 'Organization' | 'Team' | 'Own' (the server collapses DownTeam /
 * FullTeam into 'Team' whenever more than one person is visible), so
 * the scope alone cannot separate a manager from a team lead — the
 * data-visibility arm (2) and the reports arm (4) do that work.
 * A DownTeam supervisor with reports is a teamLead (RM is the
 * first-line supervisor); a DownTeam role WITHOUT reports is an
 * agent (no subordinates, effective scope just themself).
 *
 * The UM-1 tree floor still applies underneath: a role whose stored
 * scope is 'Own' still sees its reporting subtree when it has one,
 * so `hasDirectReports` is read from the overview's own
 * `directReports` count (callerHasTeam), never from a role label.
 */

export type EnterpriseRole = 'admin' | 'manager' | 'teamLead' | 'agent';

export interface EnterpriseRoleInput {
  /** The caller's role code (user.role), any casing. */
  userRole: string | null | undefined;
  /** GET /team/overview `scope`: 'Organization' | 'Team' | 'Own' | ''. */
  overviewScope: string;
  /** The UM-1 tree fact: at least one person reports to the caller. */
  hasDirectReports: boolean;
  /**
   * The role's configured data visibility from the role matrix
   * ('Own' | 'DownTeam' | 'FullTeam' | 'Organization'), or null
   * while the matrix has not loaded yet. The derivation stays
   * correct without it for every case except a no-reports
   * FullTeam manager, who refines from agent to manager when the
   * matrix lands.
   */
  dataVisibility?: string | null;
}

export function deriveEnterpriseRole(input: EnterpriseRoleInput): EnterpriseRole {
  const role = String(input.userRole || '').trim().toUpperCase();
  if (role === 'ADMIN' || role === 'SUPERADMIN') return 'admin';
  const visibility = String(input.dataVisibility || '').trim();
  if (visibility === 'FullTeam' || visibility === 'Organization') return 'manager';
  if (input.overviewScope === 'Organization') return 'manager';
  if (input.hasDirectReports) return 'teamLead';
  return 'agent';
}

/** Display labels — the sample's role names, exactly. */
export const ENTERPRISE_ROLE_LABELS: Record<EnterpriseRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  teamLead: 'Team Lead',
  agent: 'Agent',
};

/** The sample's per-role overview subtitle (the `sub` of each role). */
export const ENTERPRISE_ROLE_SUBTITLES: Record<EnterpriseRole, string> = {
  admin: 'Monitor platform health, access integrity and operational readiness.',
  manager: 'Understand managed-team performance and focus attention where it matters.',
  teamLead: "Coordinate today's work, support your team and keep follow-ups on track.",
  agent: 'Your daily priorities, follow-ups and the next best action for every lead.',
};
