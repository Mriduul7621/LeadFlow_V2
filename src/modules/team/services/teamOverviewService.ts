import { apiRequest } from '../../shared/api/http';
import {
  invalidateSessionCache,
  readSessionCache,
  writeSessionCache,
} from '../../shared/api/sessionCache';

/**
 * teamOverviewService.ts
 * ------------------------------------------------------------------
 * The ONE client data path for GET /api/team/overview. The My Team
 * page, the landing decision (HomeLanding) and the TL+ team home all
 * read the same scoped payload through here — the server applies the
 * caller's existing visibility (resolveCallerVisibility, UM-1 tree
 * floor included), so nothing here can widen what a caller sees.
 *
 * The payload is cached in the in-memory session cache, keyed by
 * user (same lifetime rules as the roles cache: cold load / logout
 * refetch; a force reload after the user asks for one). Concurrent
 * callers share one in-flight request.
 */

export interface TeamOverviewPerson {
  userId: string;
  employeeId: string;
  name: string;
  designation: string | null;
  roleName: string | null;
  department: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  tier: 'manager' | 'teamLead' | 'teamMember';
  directReports: number;
  openLeads: number;
  convertedLeads: number;
  dueToday: number;
  overdue: number;
  isSelf: boolean;
}

export interface TeamOverviewResponse {
  success: boolean;
  scope: string;
  people: TeamOverviewPerson[];
}

export function teamOverviewKey(userId: string): string {
  return `teamOverview:${userId}`;
}

/** The cached overview for this user, or null when not loaded yet. */
export function readCachedTeamOverview(userId: string): TeamOverviewResponse | null {
  return readSessionCache<TeamOverviewResponse>(teamOverviewKey(userId))?.value ?? null;
}

/** Drop the cached overview (e.g. after a roster-affecting change). */
export function invalidateTeamOverview(userId: string): void {
  invalidateSessionCache(teamOverviewKey(userId));
}

const inflight = new Map<string, Promise<TeamOverviewResponse>>();

/**
 * Load the caller's team overview: session cache first, one shared
 * network request otherwise. `force` bypasses (and refreshes) the
 * cache — the Refresh buttons use it.
 */
export function loadTeamOverview(
  userId: string,
  options: { force?: boolean } = {}
): Promise<TeamOverviewResponse> {
  if (!options.force) {
    const cached = readCachedTeamOverview(userId);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(userId);
    if (pending) return pending;
  }
  const request = apiRequest<TeamOverviewResponse>('/api/team/overview')
    .then(res => {
      const normalized: TeamOverviewResponse = {
        success: Boolean(res?.success),
        scope: typeof res?.scope === 'string' ? res.scope : '',
        people: Array.isArray(res?.people) ? res.people : [],
      };
      writeSessionCache(teamOverviewKey(userId), normalized);
      return normalized;
    })
    .finally(() => {
      if (inflight.get(userId) === request) inflight.delete(userId);
    });
  inflight.set(userId, request);
  return request;
}

/** The caller's own row in the overview (undefined before load / when absent). */
export function getSelfPerson(
  people: TeamOverviewPerson[] | null | undefined
): TeamOverviewPerson | undefined {
  return people?.find(p => p.isSelf);
}

/**
 * The UM-1 team-lead fact: the caller HAS a team when at least one
 * person reports to them. Derived from the tree (the overview's own
 * `directReports` on the caller's row) — never from a role label, so
 * an Organization-scope admin with no reports does NOT qualify, and
 * any lead with one report does.
 */
export function callerHasTeam(people: TeamOverviewPerson[] | null | undefined): boolean {
  const self = getSelfPerson(people);
  return Boolean(self && self.directReports > 0);
}

export interface TeamTotals {
  open: number;
  dueToday: number;
  overdue: number;
  converted: number;
}

/** Whole-team totals — the same sums the My Team page header shows. */
export function summarizeTeamTotals(people: TeamOverviewPerson[]): TeamTotals {
  return people.reduce<TeamTotals>(
    (acc, p) => ({
      open: acc.open + p.openLeads,
      dueToday: acc.dueToday + p.dueToday,
      overdue: acc.overdue + p.overdue,
      converted: acc.converted + p.convertedLeads,
    }),
    { open: 0, dueToday: 0, overdue: 0, converted: 0 }
  );
}

/**
 * "Team follow-ups today": everyone with work due today or already
 * overdue, worst first (most overdue, then most due today, then
 * name) — the order a lead should work through their team.
 */
export function teamFollowUpsToday(people: TeamOverviewPerson[]): TeamOverviewPerson[] {
  return people
    .filter(p => p.dueToday > 0 || p.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue || b.dueToday - a.dueToday || a.name.localeCompare(b.name));
}

/**
 * Stale-lead radar: the members carrying the most overdue follow-ups
 * (top `limit`), most overdue first. Empty when nobody is overdue.
 */
export function staleLeadRadar(people: TeamOverviewPerson[], limit = 5): TeamOverviewPerson[] {
  return people
    .filter(p => p.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue || b.openLeads - a.openLeads || a.name.localeCompare(b.name))
    .slice(0, limit);
}
