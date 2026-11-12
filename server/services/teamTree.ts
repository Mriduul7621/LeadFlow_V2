/**
 * Team org-tree builder (owner request, 2026-11-11).
 *
 * Pure function: given the people INSIDE a caller's visibility scope
 * (the route resolves the scope with resolveCallerVisibility — this
 * module never widens it), each person's own lead stats, and each
 * person's lead counts by status, build the reporting tree as the
 * owner asked to see it:
 *
 *   - the tree starts at the top of the caller's visible tree: a root
 *     is a person whose manager is NOT in the returned set (an
 *     Organization-scope caller starts at the real root(s); a scoped
 *     manager starts at themself);
 *   - every node carries OWN numbers (their leads) and a SUBTREE
 *     ROLLUP (their whole team under them, themself included) — the
 *     rollup's pipelineValue is the "possible business" figure: the
 *     summed expected premium of OPEN leads in the subtree;
 *   - every node carries its subtree's lead counts by status, so the
 *     detail view can show the pipeline shape of any selected team.
 *
 * Edges exist only among the people passed in — nobody outside the
 * caller's scope can appear, as a node or as an edge target. A data
 * cycle (A manages B manages A) cannot hang the walk: unreachable
 * people are appended as extra roots and every rollup visits each
 * person at most once.
 */

export interface TeamOwnStats {
  openLeads: number;
  dueToday: number;
  overdue: number;
  converted: number;
  convertedThisMonth: number;
  pipelineValue: number;
}

export const EMPTY_TEAM_STATS: TeamOwnStats = {
  openLeads: 0,
  dueToday: 0,
  overdue: 0,
  converted: 0,
  convertedThisMonth: 0,
  pipelineValue: 0,
};

export interface TeamTreePersonInput {
  userId: string;
  employeeId: string;
  name: string;
  designation: string | null;
  roleName: string | null;
  department: string | null;
  /** Manager within the FULL roster (may point outside the scope set). */
  managerUserId: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  hierarchyLevel: number | null;
  isSelf: boolean;
}

export interface TeamTreePerson extends TeamTreePersonInput {
  tier: 'manager' | 'teamLead' | 'teamMember';
  directReports: number;
  childrenIds: string[];
  /** Own numbers, flattened like the FIX-1b overview fields (+ new). */
  openLeads: number;
  convertedLeads: number;
  convertedThisMonth: number;
  dueToday: number;
  overdue: number;
  pipelineValue: number;
  /** Aggregates over the whole subtree, this person included. */
  subtree: TeamOwnStats & { people: number };
  /** Lead counts by current_status over the whole subtree. */
  subtreeStatusCounts: Record<string, number>;
}

function addStats(into: TeamOwnStats, from: TeamOwnStats) {
  into.openLeads += from.openLeads;
  into.dueToday += from.dueToday;
  into.overdue += from.overdue;
  into.converted += from.converted;
  into.convertedThisMonth += from.convertedThisMonth;
  into.pipelineValue += from.pipelineValue;
}

export function buildTeamTree(
  people: TeamTreePersonInput[],
  statsByEmployeeId: Map<string, TeamOwnStats>,
  statusByEmployeeId: Map<string, Record<string, number>>,
): { people: TeamTreePerson[]; rootIds: string[] } {
  const byId = new Map(people.map(p => [String(p.userId), p]));
  const statsOf = (p: TeamTreePersonInput): TeamOwnStats =>
    statsByEmployeeId.get(String(p.employeeId).toUpperCase()) || EMPTY_TEAM_STATS;
  const statusOf = (p: TeamTreePersonInput): Record<string, number> =>
    statusByEmployeeId.get(String(p.employeeId).toUpperCase()) || {};

  // Edges only among returned people.
  const childrenOf = new Map<string, TeamTreePersonInput[]>();
  for (const p of people) childrenOf.set(String(p.userId), []);
  for (const p of people) {
    const mgr = p.managerUserId ? byId.get(String(p.managerUserId)) : undefined;
    if (mgr && String(mgr.userId) !== String(p.userId)) {
      childrenOf.get(String(mgr.userId))!.push(p);
    }
  }
  const byName = (a: TeamTreePersonInput, b: TeamTreePersonInput) =>
    a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId);
  for (const kids of childrenOf.values()) kids.sort(byName);

  const isRoot = (p: TeamTreePersonInput) =>
    !p.managerUserId || !byId.has(String(p.managerUserId)) || String(p.managerUserId) === String(p.userId);
  const roots = people.filter(isRoot).sort(byName);

  // Post-order rollup with a visited guard (cycle-safe).
  const rollup = new Map<string, { stats: TeamOwnStats & { people: number }; status: Record<string, number> }>();
  const visiting = new Set<string>();
  const compute = (p: TeamTreePersonInput): { stats: TeamOwnStats & { people: number }; status: Record<string, number> } => {
    const key = String(p.userId);
    const cached = rollup.get(key);
    if (cached) return cached;
    if (visiting.has(key)) {
      // Cycle: contribute only the person's own numbers at this level;
      // the outer frame completes the aggregate without looping.
      const own = { ...statsOf(p), people: 1 };
      return { stats: own, status: { ...statusOf(p) } };
    }
    visiting.add(key);
    const stats: TeamOwnStats & { people: number } = { ...statsOf(p), people: 1 };
    const status: Record<string, number> = { ...statusOf(p) };
    for (const child of childrenOf.get(key) || []) {
      const childRollup = compute(child);
      addStats(stats, childRollup.stats);
      for (const [s, n] of Object.entries(childRollup.status)) {
        status[s] = (status[s] || 0) + n;
      }
    }
    visiting.delete(key);
    const done = { stats, status };
    rollup.set(key, done);
    return done;
  };
  // Subtree people counts need their own pass (addStats carries only the
  // six stat fields): count each subtree directly, cycle-guarded.
  const countPeople = (p: TeamTreePersonInput, seen: Set<string>): number => {
    const key = String(p.userId);
    if (seen.has(key)) return 0;
    seen.add(key);
    let n = 1;
    for (const child of childrenOf.get(key) || []) n += countPeople(child, seen);
    return n;
  };
  for (const p of people) {
    const r = compute(p);
    r.stats.people = countPeople(p, new Set());
  }

  const out: TeamTreePerson[] = people.map(p => {
    const kids = childrenOf.get(String(p.userId)) || [];
    const hasGrandReports = kids.some(k => (childrenOf.get(String(k.userId)) || []).length > 0);
    const level = p.hierarchyLevel != null ? Number(p.hierarchyLevel) : null;
    const tier: TeamTreePerson['tier'] = kids.length > 0 && (hasGrandReports || (level != null && level <= 2))
      ? 'manager'
      : kids.length > 0 ? 'teamLead' : 'teamMember';
    const own = statsOf(p);
    const r = rollup.get(String(p.userId))!;
    return {
      ...p,
      tier,
      directReports: kids.length,
      childrenIds: kids.map(k => String(k.userId)),
      openLeads: own.openLeads,
      convertedLeads: own.converted,
      convertedThisMonth: own.convertedThisMonth,
      dueToday: own.dueToday,
      overdue: own.overdue,
      pipelineValue: own.pipelineValue,
      subtree: r.stats,
      subtreeStatusCounts: r.status,
    };
  });

  // Roots in tree order; anyone unreachable from a root (cycle island)
  // is appended as an extra root so nobody silently disappears.
  const reachable = new Set<string>();
  const mark = (p: TeamTreePersonInput, seen: Set<string>) => {
    const key = String(p.userId);
    if (seen.has(key)) return;
    seen.add(key);
    reachable.add(key);
    for (const child of childrenOf.get(key) || []) mark(child, seen);
  };
  for (const root of roots) mark(root, new Set());
  const islandRoots = people.filter(p => !reachable.has(String(p.userId))).sort(byName);
  const rootIds = [...roots, ...islandRoots].map(p => String(p.userId));

  return { people: out, rootIds };
}
