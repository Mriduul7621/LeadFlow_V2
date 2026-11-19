import { lazy, Suspense } from 'react';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { HomeSkeleton } from '../components/EnterprisePrimitives';

/**
 * EnterpriseHome — the root route (Enterprise Preview redesign,
 * 2026-11-19).
 * ------------------------------------------------------------------
 * `/` renders exactly one role overview, chosen by the DISPLAY
 * enterprise role (useEnterpriseDisplayRole): the caller's own
 * derived role — or, for a super admin using the sidebar rolebox,
 * the role being previewed. The preview is display-only (the
 * home's data hooks are still scoped to the real logged-in user).
 * There is no switcher for ordinary users, no landing redirect
 * and no Workbench-first bounce: the role overview IS the landing
 * page, and the Daily Workbench stays one tap away in the sidebar
 * ("Follow-up Queue") and in the Team/My-work toggle on the
 * Workbench itself.
 *
 * The four homes are lazy chunks (the route-level code-splitting
 * rule): the shell never downloads a home the caller will not see.
 */

const AdminHome = lazy(() => import('./AdminHome').then(m => ({ default: m.AdminHome })));
const ManagerHome = lazy(() => import('./ManagerHome').then(m => ({ default: m.ManagerHome })));
const TeamLeadHome = lazy(() => import('./TeamLeadHome').then(m => ({ default: m.TeamLeadHome })));
const AgentHome = lazy(() => import('./AgentHome').then(m => ({ default: m.AgentHome })));

export default function EnterpriseHome() {
  const { role, loading } = useEnterpriseDisplayRole();

  if (loading) return <HomeSkeleton label="Loading your workspace" />;

  return (
    <Suspense fallback={<HomeSkeleton label="Loading your workspace" />}>
      {role === 'admin' ? (
        <AdminHome />
      ) : role === 'manager' ? (
        <ManagerHome />
      ) : role === 'teamLead' ? (
        <TeamLeadHome />
      ) : (
        <AgentHome />
      )}
    </Suspense>
  );
}
