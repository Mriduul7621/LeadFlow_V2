import { useEffect, useState } from 'react';
import { useAuthStore } from '../modules/auth/store/authStore';
import { useCallerTeam } from '../modules/team/hooks/useCallerTeam';
import { callerHasTeam } from '../modules/team/services/teamOverviewService';
import { adminService } from '../modules/admin/services/adminService';
import { deriveEnterpriseRole, type EnterpriseRole } from './enterpriseRole';

/**
 * useEnterpriseRole — the caller's derived enterprise workspace role.
 * ------------------------------------------------------------------
 * Reads the scoped team overview (session-cached: AppLayout, the
 * home switch and the home data hook all share one network request)
 * and the role matrix (adminService.getRoles is coalesced + cached
 * the same way) and derives the role with deriveEnterpriseRole.
 * There is no switcher: the value is derived, never chosen.
 *
 * `loading` is true only while the overview loads. The role matrix
 * refines the answer when it lands (a no-reports FullTeam manager
 * refines from agent to manager); callers must not treat a
 * pre-matrix role as final for anything but a loading skeleton.
 * Admins never flash: the admin arm needs only the role code, which
 * the auth store holds from the first paint.
 *
 * `hasSubordinates` is the same tree fact the teamLead derivation
 * runs on (≥1 direct report), exposed for the route gate: the
 * `teamLeadAllowed` predicate in featureRouteAccess needs it, and
 * every caller that already derives a role should not re-derive it
 * from a second overview read.
 */
export function useEnterpriseRole(): { role: EnterpriseRole; loading: boolean; hasSubordinates: boolean } {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  const userRole = user?.role;
  const callerTeam = useCallerTeam();
  const [dataVisibility, setDataVisibility] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    adminService
      .getRoles()
      .then(roles => {
        if (cancelled) return;
        const code = String(userRole || '');
        const match = roles.find(rp => rp.roleId === code || rp.roleId === code.toUpperCase());
        setDataVisibility(match?.dataVisibility ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, userRole]);

  return {
    role: deriveEnterpriseRole({
      userRole,
      overviewScope: callerTeam.overview?.scope ?? '',
      hasDirectReports: callerHasTeam(callerTeam.overview?.people),
      dataVisibility,
    }),
    loading: callerTeam.loading,
    hasSubordinates: callerHasTeam(callerTeam.overview?.people),
  };
}
