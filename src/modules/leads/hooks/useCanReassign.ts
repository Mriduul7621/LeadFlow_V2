import { useMemo } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { callerHasTeam } from '../../team/services/teamOverviewService';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';

/**
 * useCanReassign — the client-side Reassign visibility rule
 * (2026-11-20, Mahadi: reassign belongs to Team Lead and
 * Manager, never to a plain Agent).
 * ------------------------------------------------------------------
 * The button shows when ALL of these hold:
 *   1. the DISPLAY role is not 'agent' — a super admin previewing
 *      as Agent hides it (the preview is display-only, so the
 *      button follows what the previewed role would see);
 *   2. the caller is an admin, OR has ≥1 subordinate (the Team
 *      Lead arm), OR has the derived Manager role (FullTeam /
 *      Organization scope — a no-reports Manager may reassign
 *      within their scope);
 *   3. the caller holds the `leads.assign` grant (toggleable per
 *      role in Roles & Access — the editor's Leads module).
 *
 * The server ALWAYS enforces the real rule (callerHasTeamScope +
 * leads.assign) regardless of the preview — this hook only
 * decides whether the button renders.
 */
export function useCanReassign(): boolean {
  const user = useAuthStore(state => state.user);
  const { canAccess } = usePermissions();
  const { role: displayRole, realRole } = useEnterpriseDisplayRole();
  const callerTeam = useCallerTeam();

  return useMemo(() => {
    if (displayRole === 'agent') return false;
    const userRoleUpper = String(user?.role || '').toUpperCase();
    const isAdmin = userRoleUpper === 'ADMIN' || userRoleUpper === 'SUPERADMIN';
    const hasTeam = callerHasTeam(callerTeam.overview?.people);
    const isManager = realRole === 'manager';
    if (!isAdmin && !hasTeam && !isManager) return false;
    return canAccess('lead_tracking', 'reassign_global_leads');
  }, [displayRole, realRole, user?.role, callerTeam.overview, canAccess]);
}
