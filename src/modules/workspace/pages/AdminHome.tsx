import { TeamOverviewHome } from './TeamOverviewHome';

/**
 * AdminHome — the Admin workspace overview (Team Lead / Manager /
 * Admin workspace rebuild, 2026-11-20).
 * ------------------------------------------------------------------
 * A thin wrapper: the shared TeamOverviewHome renders the Admin
 * scope (the whole organisation, admin-role users excluded from
 * every member list, KPI and aggregate — an admin is never a
 * sales employee and never appears in report data). The KPI
 * substitutions and the honest-metric definitions live on the
 * shared component.
 */
export function AdminHome() {
  return <TeamOverviewHome scope="admin" />;
}
