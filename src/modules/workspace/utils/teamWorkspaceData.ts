import type { Lead } from '../../shared/types';
import type { FollowUpQueueItem } from '../../leads/services/leadService';
import type { TeamOverviewPerson } from '../../team/services/teamOverviewService';
import { downlineOf, summarizeTeamTotals, type TeamTotals } from '../../team/services/teamOverviewService';
import { CONTACTED_STATUSES, completedToday, isTerminalStatus, onTimeRate } from './agentWorkspaceData';
import { dhakaDayStartMs, dhakaYmdParts } from './enterpriseData';
import type { EnterpriseRole } from '../../../layouts/enterpriseRole';

/**
 * teamWorkspaceData.ts — pure data shaping for the Team Lead /
 * Manager / Admin workspaces (2026-11-20, Mahadi's demo
 * screenshots + words).
 * ------------------------------------------------------------------
 * Every helper here is pure and timezone-explicit (Asia/Dhaka)
 * so the node test suite can pin it without a browser. Nothing
 * here fetches, and nothing widens scope: every filter only
 * NARROWS the server-visible set the caller already holds.
 *
 * Scope model (Mahadi's words):
 *   Team Lead  = self + full reporting subtree (the whole
 *                downline, not just direct reports).
 *   Manager    = self + full downline. On the Team Members page
 *                the drill-down starts at the Manager's IMMEDIATE
 *                subordinates (Mahadi 2026-11-20 06:12: "Manager
 *                der jonno tar immediate nicher member gulo") and
 *                goes tier by tier — the TL grouping below still
 *                serves Team Leads, Follow-up Monitor and Team
 *                Performance, NOT /team anymore.
 *   Admin      = the whole organisation, EXCLUDING admin-role
 *                users from every member list, KPI and aggregate
 *                (an admin is never a sales employee and never
 *                appears in report data). On the Team Members
 *                page the drill-down starts at the DEPARTMENT
 *                HEADS (Mahadi 2026-11-20 06:10), each with their
 *                full team's data, then tier by tier.
 *
 * Creator matching is dual-space: `createdByEmployeeId` (the
 * roster employee ID, exposed by the server since this build)
 * or `createdBy` (the users.id UUID, matched against the
 * overview roster's userId) — demo rows may carry either.
 *
 * Honest metrics (no targets model exists — Phase 3 undecided):
 *   Member %  = follow-up completion: completed-today /
 *               (completed-today + due-today + overdue), "—"
 *               when the denominator is 0. ONE definition on
 *               Team Overview AND Team Members.
 *   At-risk   = an overdue follow-up, OR no activity in 48h
 *               (latest activity — creation or last logged
 *               follow-up — more than 48h ago AND no future
 *               follow-up scheduled). A properly scheduled future
 *               follow-up is never at-risk.
 *   Capacity  = no model exists, so the demo's "Capacity used"
 *               card is replaced by "Avg. active leads" per
 *               member (a plain count).
 */

/** Uppercase-normalised employee ID ('' when absent). */
function empId(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase();
}

/** The ISO 8601 week number (1–53) of the Dhaka date holding `instant`. */
export function isoWeekNumber(instant: Date): number {
  const { y, m, d } = dhakaYmdParts(instant);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(date.getTime() + (3 - day) * 86_400_000);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (yearStart.getUTCDay() + 6) % 7;
  const firstThursday = new Date(yearStart.getTime() + (3 - firstDay) * 86_400_000);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** True when the overview person is an admin-role user (never a seller). */
export function isAdminPerson(person: TeamOverviewPerson): boolean {
  const role = empId(person.roleName);
  return role === 'ADMIN' || role === 'SUPERADMIN';
}

/**
 * The in-scope people for one display role, admin users removed.
 * Team Lead / Manager: self + the full downline. Admin: everyone
 * visible minus admins. Agent: just the caller themself.
 */
export function scopePeople(
  people: TeamOverviewPerson[],
  self: TeamOverviewPerson,
  displayRole: EnterpriseRole,
): TeamOverviewPerson[] {
  const sellers = people.filter(p => !isAdminPerson(p));
  if (displayRole === 'admin') return sellers;
  if (displayRole === 'agent') return sellers.filter(p => empId(p.employeeId) === empId(self.employeeId));
  const downline = downlineOf(sellers, self.employeeId);
  const selfRow = sellers.find(p => empId(p.employeeId) === empId(self.employeeId));
  return selfRow ? [selfRow, ...downline] : downline;
}

/** The creator's employee ID (uppercased), resolved in either id space. */
export function leadCreatorEmployeeId(
  lead: Lead,
  peopleByUserId: Map<string, TeamOverviewPerson>,
): string {
  const byEmployee = empId(lead.createdByEmployeeId);
  if (byEmployee) return byEmployee;
  const createdBy = String(lead.createdBy || '').trim();
  if (!createdBy) return '';
  const person = peopleByUserId.get(createdBy);
  return person ? empId(person.employeeId) : '';
}

/**
 * Leads assigned to someone in the scope set (the assignee arm).
 * This is the filter for every HOME aggregate (Contacted, team
 * activity, at-risk, completion): a lead counts for the team
 * whose member owns it. Creator-arm leads (a member created it,
 * someone outside owns it) belong to the Team Leads page list,
 * not to the home totals — the overview row totals (Σ totalLeads
 * etc.) count assignees too, so the two stay consistent.
 */
export function scopeLeadsByAssignee(
  leads: Lead[],
  scopeEmployeeIds: Set<string>,
): Lead[] {
  return leads.filter(lead => scopeEmployeeIds.has(empId(lead.assignedTo)));
}

/**
 * The Team Leads page set for one display role (Mahadi's
 * 2026-11-20 correction: Team Leads shows ONLY team members'
 * leads — the TL's own leads live on My Leads).
 *
 *   Team Lead: assignee ∈ downline, OR creator ∈ downline with
 *     the assignee outside the TL themself, OR unassigned with
 *     the TL as creator (distribution still works without a
 *     Lead Pool sidebar item). A TL-created lead assigned to a
 *     member appears in BOTH Team Leads and My Leads — inherent
 *     in his two definitions (assignee ∈ downline / creator =
 *     self), reported as such.
 *   Manager:   assignee ∈ scope (self + downline) OR creator ∈
 *     scope; unassigned leads need a creator in scope.
 *   Admin:     every visible lead except ones assigned to an
 *     admin employee (unassigned included).
 *   Agent:     unchanged — the server scope is already own-only.
 */
export function teamLeadsForRole(
  leads: Lead[],
  people: TeamOverviewPerson[],
  self: TeamOverviewPerson,
  displayRole: EnterpriseRole,
): Lead[] {
  if (displayRole === 'agent') return leads;
  const peopleByUserId = new Map(people.map(p => [p.userId, p]));
  const selfId = empId(self.employeeId);
  if (displayRole === 'admin') {
    const adminIds = new Set(people.filter(isAdminPerson).map(p => empId(p.employeeId)));
    return leads.filter(lead => !adminIds.has(empId(lead.assignedTo)));
  }
  const scopeIds = new Set(scopePeople(people, self, displayRole).map(p => empId(p.employeeId)));
  const downlineIds = new Set(downlineOf(people, self.employeeId).map(p => empId(p.employeeId)));
  return leads.filter(lead => {
    const assignee = empId(lead.assignedTo);
    const creator = leadCreatorEmployeeId(lead, peopleByUserId);
    if (displayRole === 'teamLead') {
      if (downlineIds.has(assignee)) return true;
      if (creator && downlineIds.has(creator) && assignee !== selfId) return true;
      if (!assignee && creator === selfId) return true;
      return false;
    }
    // Manager: assignee or creator in scope; unassigned needs a creator in scope.
    if (assignee) return scopeIds.has(assignee) || (creator !== '' && scopeIds.has(creator));
    return creator !== '' && scopeIds.has(creator);
  });
}

/** The TL's My Leads set: assigned to the TL OR created by the TL. */
export function myLeadsFor(
  leads: Lead[],
  people: TeamOverviewPerson[],
  self: TeamOverviewPerson,
): Lead[] {
  const peopleByUserId = new Map(people.map(p => [p.userId, p]));
  const selfId = empId(self.employeeId);
  return leads.filter(lead => {
    if (empId(lead.assignedTo) === selfId) return true;
    return leadCreatorEmployeeId(lead, peopleByUserId) === selfId;
  });
}

/** Contacted count over one leads list (the Agent definition). */
export function contactedCount(leads: Lead[]): number {
  const contacted = new Set(CONTACTED_STATUSES);
  return leads.filter(lead => contacted.has(lead.currentStatus)).length;
}

export interface MemberCompletion {
  completed: number;
  dueToday: number;
  overdue: number;
  /** Follow-up completion %, null when nothing was due or done. */
  pct: number | null;
}

/**
 * Follow-up completion per member: completed-today (from the
 * loaded leads list, grouped by assignee) against the server's
 * dueToday + overdue from the overview row. ONE definition for
 * Team Overview and Team Members — labelled "Follow-up
 * completion" in both places.
 */
export function memberCompletions(
  people: TeamOverviewPerson[],
  leads: Lead[],
  now: Date = new Date(),
): Map<string, MemberCompletion> {
  const completedByAssignee = new Map<string, number>();
  for (const lead of completedToday(leads, now)) {
    const assignee = empId(lead.assignedTo);
    completedByAssignee.set(assignee, (completedByAssignee.get(assignee) ?? 0) + 1);
  }
  const result = new Map<string, MemberCompletion>();
  for (const person of people) {
    const completed = completedByAssignee.get(empId(person.employeeId)) ?? 0;
    const dueToday = person.dueToday;
    const overdue = person.overdue;
    const denominator = completed + dueToday + overdue;
    result.set(empId(person.employeeId), {
      completed,
      dueToday,
      overdue,
      pct: denominator === 0 ? null : Math.round((completed / denominator) * 100),
    });
  }
  return result;
}

export interface FollowUpHealth {
  completed: number;
  dueToday: number;
  overdue: number;
  total: number;
  /**
   * The REAL on-time rate of today's logged completions (logged
   * no later than the previous entry scheduled) — null when
   * nothing completed today is measurable, so the UI shows "—"
   * instead of inventing a rate.
   */
  onTimePct: number | null;
  /** Due-today / overdue shares of the follow-up universe (0–100). */
  dueTodayPct: number;
  overduePct: number;
}

/**
 * Follow-up health over the scope, in the demo's shape (three
 * independent bars — the demo's own 78/54/27 do not sum to 100
 * either): "On time" is the real on-time rate of today's logged
 * completions; "Due today" and "Overdue" are shares of the
 * team's current follow-up universe (completed-today +
 * due-today + overdue).
 */
export function followUpHealth(
  people: TeamOverviewPerson[],
  leads: Lead[],
  now: Date = new Date(),
): FollowUpHealth {
  // The overview totals come from the shared helper (no duplicate
  // summation here — scopeTotals was removed as a duplicate).
  const totals = summarizeTeamTotals(people);
  const completed = completedToday(leads, now).length;
  const total = completed + totals.dueToday + totals.overdue;
  const share = (part: number) => (total === 0 ? 0 : Math.round((part / total) * 100));
  const onTime = onTimeRate(leads, now);
  return {
    completed,
    dueToday: totals.dueToday,
    overdue: totals.overdue,
    total,
    onTimePct: onTime ? onTime.rate : null,
    dueTodayPct: share(totals.dueToday),
    overduePct: share(totals.overdue),
  };
}

export interface AtRiskLead {
  lead: Lead;
  reason: 'overdue' | 'no-activity';
}

const NO_ACTIVITY_MS = 48 * 3600_000;

/**
 * At-risk leads: an overdue follow-up (from the queue's overdue
 * bucket), OR no activity in 48h (latest activity — creation or
 * last logged follow-up — more than 48h ago AND no future
 * follow-up scheduled). Overdue first (earliest due first),
 * then no-activity (oldest activity first).
 */
export function atRiskLeads(
  leads: Lead[],
  overdueItems: FollowUpQueueItem[],
  now: Date = new Date(),
): AtRiskLead[] {
  const overdueIds = new Set(overdueItems.map(item => String(item.id)));
  const byId = new Map(leads.map(lead => [String(lead.id), lead]));
  const result: AtRiskLead[] = [];
  const seen = new Set<string>();

  const overdueLeads = overdueItems
    .map(item => byId.get(String(item.id)))
    .filter((lead): lead is Lead => Boolean(lead) && !isTerminalStatus(lead.currentStatus))
    .sort((a, b) => {
      const aDue = new Date(a.nextFollowUpDate || 0).getTime();
      const bDue = new Date(b.nextFollowUpDate || 0).getTime();
      return aDue - bDue;
    });
  for (const lead of overdueLeads) {
    result.push({ lead, reason: 'overdue' });
    seen.add(String(lead.id));
  }

  const nowMs = now.getTime();
  const todayStartMs = dhakaDayStartMs(now);
  const quiet: Array<{ lead: Lead; lastActivityMs: number }> = [];
  for (const lead of leads) {
    if (seen.has(String(lead.id)) || overdueIds.has(String(lead.id))) continue;
    if (isTerminalStatus(lead.currentStatus)) continue;
    // A future follow-up is scheduled — the lead is being worked.
    const nextDue = lead.nextFollowUpDate ? new Date(lead.nextFollowUpDate).getTime() : NaN;
    if (!Number.isNaN(nextDue) && nextDue >= todayStartMs) continue;
    const history = [...(lead.statusHistory || [])]
      .map(entry => new Date(entry.date).getTime())
      .filter(t => !Number.isNaN(t));
    const created = new Date(lead.creationDate || lead.timestamp || 0).getTime();
    const lastActivityMs = Math.max(created, ...history);
    if (Number.isNaN(lastActivityMs)) continue;
    if (nowMs - lastActivityMs > NO_ACTIVITY_MS) {
      quiet.push({ lead, lastActivityMs });
    }
  }
  quiet.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  for (const { lead } of quiet) result.push({ lead, reason: 'no-activity' });
  return result;
}

/**
 * The nearest Team Lead ancestor of one employee: walk the
 * manager links up to the first person with ≥1 direct report (a
 * TL themself is their own group). The caller is the fallback
 * group for their own leads. Null when the walk leaves the
 * payload without finding a TL (a flat tree with no TLs).
 */
export function tlAncestorOf(
  people: TeamOverviewPerson[],
  employeeId: string,
  callerEmployeeId: string,
): TeamOverviewPerson | null {
  const byEmployee = new Map(people.map(p => [empId(p.employeeId), p]));
  const seen = new Set<string>();
  let current = byEmployee.get(empId(employeeId));
  while (current && !seen.has(empId(current.employeeId))) {
    seen.add(empId(current.employeeId));
    if (current.directReports > 0) return current;
    if (empId(current.employeeId) === empId(callerEmployeeId)) return current;
    const managerId = empId(current.managerEmployeeId);
    current = managerId ? byEmployee.get(managerId) : undefined;
  }
  return null;
}

export interface TlLeadGroup {
  tl: TeamOverviewPerson;
  leads: Lead[];
}

/**
 * Manager list grouping: every lead under its owner's nearest TL
 * ancestor (an unassigned lead groups under its creator's TL).
 * Groups sort by TL name; leads inside a group sort newest first.
 * Leads with no TL ancestor group under the caller (the fallback
 * arm of tlAncestorOf covers the caller themself; anything else
 * lands in the caller's own group so no lead is ever dropped).
 */
export function groupLeadsByTl(
  leads: Lead[],
  people: TeamOverviewPerson[],
  self: TeamOverviewPerson,
): TlLeadGroup[] {
  const peopleByUserId = new Map(people.map(p => [p.userId, p]));
  const groups = new Map<string, TlLeadGroup>();
  const groupFor = (person: TeamOverviewPerson): TlLeadGroup => {
    const key = empId(person.employeeId);
    const existing = groups.get(key);
    if (existing) return existing;
    const created: TlLeadGroup = { tl: person, leads: [] };
    groups.set(key, created);
    return created;
  };
  for (const lead of leads) {
    const owner = empId(lead.assignedTo) || leadCreatorEmployeeId(lead, peopleByUserId);
    const tl = owner ? tlAncestorOf(people, owner, self.employeeId) : null;
    groupFor(tl ?? self).leads.push(lead);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.leads.sort(
      (a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime(),
    );
  }
  result.sort((a, b) => a.tl.name.localeCompare(b.tl.name));
  return result;
}

/* ------------------------------------------------------------------ */
/* Team Members drill-down (Head-first, 2026-11-20)                    */
/* ------------------------------------------------------------------ */

/**
 * Direct reports of one employee within a people list — the TREE
 * fact, not the overview row's `directReports` count (that count
 * can cover people outside the caller's scoped roster). Sorted by
 * name. Case-insensitive; a self-manager link is ignored.
 */
export function directReportsOf(
  people: TeamOverviewPerson[],
  employeeId: string,
): TeamOverviewPerson[] {
  const manager = empId(employeeId);
  return people
    .filter(p => empId(p.managerEmployeeId) === manager && empId(p.employeeId) !== manager)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The whole subtree of one employee, INCLUDING themself — the
 * person plus every descendant in the reporting tree. Empty when
 * the id is not in the list. Cycle-guarded (via downlineOf),
 * case-insensitive.
 */
export function subtreeOf(
  people: TeamOverviewPerson[],
  employeeId: string,
): TeamOverviewPerson[] {
  const root = people.find(p => empId(p.employeeId) === empId(employeeId));
  if (!root) return [];
  return [root, ...downlineOf(people, employeeId)];
}

/** True when the person's designation or role says CEO (the top of the tree). */
export function isCeoPerson(person: TeamOverviewPerson): boolean {
  for (const field of [person.designation, person.roleName]) {
    const text = ` ${String(field || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    if (text.includes(' ceo ') || text.includes(' chief executive ')) return true;
  }
  return false;
}

/**
 * Department Heads of the visible org — the Admin/CEO top level
 * of the Team Members page (Mahadi 2026-11-20 06:10: the list
 * starts with the department heads, each with their full team's
 * data, then drills tier by tier).
 *
 * Heads are found STRUCTURALLY — designations are free text and
 * unreliable, while the reporting tree is the source of truth
 * for the drill-down itself. The people at the top of the
 * visible tree are the Heads: when a CEO-designated root is
 * visible, their direct reports are the Heads (the CEO themself
 * is never a Head row); when no CEO row is visible — the CEO is
 * not a LeadFlow user, or is an admin-role user already filtered
 * from the roster — the roots themselves are the Heads. A root
 * with no reports (an orphaned employee whose manager is not
 * visible) still appears as its own top-level row, so nobody is
 * ever dropped from the page. Admin-role users are filtered out
 * here too (defence in depth — the caller passes the scoped
 * roster, which already excludes them). When the tree has no roots at all
 * (a manager cycle swallowed every link), the fallback is the
 * people with reports, else everyone — sorted by name either
 * way.
 */
export function departmentHeadsOf(people: TeamOverviewPerson[]): TeamOverviewPerson[] {
  const sellers = people.filter(p => !isAdminPerson(p));
  const ids = new Set(sellers.map(p => empId(p.employeeId)));
  const heads: TeamOverviewPerson[] = [];
  const seen = new Set<string>();
  const add = (person: TeamOverviewPerson) => {
    const key = empId(person.employeeId);
    if (seen.has(key) || isCeoPerson(person)) return;
    seen.add(key);
    heads.push(person);
  };
  const roots = sellers.filter(p => {
    const manager = empId(p.managerEmployeeId);
    return !manager || !ids.has(manager);
  });
  for (const root of roots) {
    if (isCeoPerson(root)) {
      for (const report of directReportsOf(sellers, root.employeeId)) add(report);
    } else {
      add(root);
    }
  }
  if (heads.length === 0 && sellers.length > 0) {
    // No roots — a manager cycle swallowed every link. Fall back
    // to the people with reports (group nodes), else everyone.
    const withReports = sellers.filter(p => directReportsOf(sellers, p.employeeId).length > 0);
    for (const person of withReports.length > 0 ? withReports : sellers) add(person);
  }
  return heads.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SubtreeAggregate {
  /** The subtree, root person included. */
  members: TeamOverviewPerson[];
  /** Whole-subtree totals (the same sums the roster header shows). */
  totals: TeamTotals;
  /** Follow-ups completed today across the subtree. */
  completed: number;
  /** Follow-up completion % over the subtree, null when nothing was due or done. */
  pct: number | null;
  /** Follow-ups due (due today + overdue) across the subtree. */
  followUpsDue: number;
  /** True when any follow-up in the subtree is overdue. */
  needsAttention: boolean;
}

/**
 * Honest metrics over one person's WHOLE subtree (themself
 * included) — the group-row numbers on the Team Members page.
 * The completion % is the SAME definition as the member % (ONE
 * definition): completed-today / (completed + due-today +
 * overdue), summed over the subtree — null when the denominator
 * is 0, so the UI shows "—". The completions map comes from
 * memberCompletions over the scoped roster (computed once by
 * the page). No targets anywhere (Phase 3 undecided).
 */
export function aggregateSubtree(
  people: TeamOverviewPerson[],
  rootEmployeeId: string,
  completions: Map<string, MemberCompletion>,
): SubtreeAggregate {
  const members = subtreeOf(people, rootEmployeeId);
  const totals = summarizeTeamTotals(members);
  let completed = 0;
  for (const member of members) {
    completed += completions.get(empId(member.employeeId))?.completed ?? 0;
  }
  const denominator = completed + totals.dueToday + totals.overdue;
  return {
    members,
    totals,
    completed,
    pct: denominator === 0 ? null : Math.round((completed / denominator) * 100),
    followUpsDue: totals.dueToday + totals.overdue,
    needsAttention: totals.overdue > 0,
  };
}

/** Roster status: honest and simple — overdue work needs attention. */
export function memberStatus(person: TeamOverviewPerson): 'Needs attention' | 'On track' {
  return person.overdue > 0 ? 'Needs attention' : 'On track';
}

/** The home subtitle's team name: the caller's department, else "{firstName}'s team". */
export function teamNameFor(
  self: TeamOverviewPerson,
  displayRole: EnterpriseRole,
  callerName: string | null | undefined,
): string {
  if (displayRole === 'admin') return 'Whole organisation';
  if (self.department) return self.department;
  const first = String(callerName || '').trim().split(/\s+/)[0] || 'My';
  return `${first}’s team`;
}
