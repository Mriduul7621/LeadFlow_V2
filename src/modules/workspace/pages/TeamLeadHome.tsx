import { TeamOverviewHome } from './TeamOverviewHome';

/**
 * TeamLeadHome — the Team Lead workspace overview (Team Lead /
 * Manager / Admin workspace rebuild, 2026-11-20).
 * ------------------------------------------------------------------
 * A thin wrapper: the shared TeamOverviewHome renders the TL
 * scope (self + full downline). The KPI substitutions and the
 * honest-metric definitions live on the shared component.
 */
export function TeamLeadHome() {
  return <TeamOverviewHome scope="teamLead" />;
}
