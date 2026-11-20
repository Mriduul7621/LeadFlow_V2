import { TeamOverviewHome } from './TeamOverviewHome';

/**
 * ManagerHome — the Manager workspace overview (Team Lead /
 * Manager / Admin workspace rebuild, 2026-11-20).
 * ------------------------------------------------------------------
 * A thin wrapper: the shared TeamOverviewHome renders the
 * Manager scope (self + full downline). The KPI substitutions
 * and the honest-metric definitions live on the shared
 * component.
 */
export function ManagerHome() {
  return <TeamOverviewHome scope="manager" />;
}
