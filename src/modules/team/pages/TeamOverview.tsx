import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Network, RefreshCcw, UserPlus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { EnterprisePageHeader, KpiCard } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';
import { useCallerTeam } from '../hooks/useCallerTeam';
import { getSelfPerson, summarizeTeamTotals, type TeamOverviewPerson } from '../services/teamOverviewService';
import { useAgentHomeLeads } from '../../workspace/hooks/useAgentHomeLeads';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import {
  aggregateSubtree,
  departmentHeadsOf,
  directReportsOf,
  memberCompletions,
  memberStatus,
  scopeLeadsByAssignee,
  scopePeople,
  type SubtreeAggregate,
} from '../../workspace/utils/teamWorkspaceData';
import { formatDhakaShort } from '../../workspace/utils/enterpriseData';
import type { Lead } from '../../shared/types';

/**
 * TeamOverview — the Team Members page (Team Lead / Manager /
 * Admin workspace rebuild, 2026-11-20, Mahadi's demo
 * screenshot 4; Head-first drill-down, 2026-11-20 06:10).
 * ------------------------------------------------------------------
 * Mahadi called the old page "ekta faltu design" (an org tree +
 * tier groups fed by GET /api/team/tree). The rebuild follows the
 * demo: 4 KPI cards + a Team roster table, with the Retail Sales
 * Dashboard drill-down pattern — roster → click a member → that
 * member's detail (their KPIs, leads and follow-ups due) → click
 * a lead → Lead360. The organogram chart still lives at
 * /team/organogram (linked from the header).
 *
 * Head-first drill-down (Mahadi 2026-11-20 06:10 + 06:12):
 *   Admin / CEO: the top level is the DEPARTMENT HEADS, each row
 *     showing that Head's FULL team's data; clicking a Head
 *     drills into the next tier, tier by tier, down to individual
 *     members → the member detail. Heads are found structurally
 *     (departmentHeadsOf): the top of the visible tree, with a
 *     CEO root contributing their direct reports instead.
 *   Manager: the top level is the Manager's IMMEDIATE
 *     subordinates ("Manager der jonno tar immediate nicher
 *     member gulo") — uniform for every Manager, including one
 *     who is themself a Head — each row showing that person's
 *     full subtree, drilling tier by tier the same way. This
 *     REPLACES the Manager TL grouping (?tl=) from the rebuild;
 *     ?tl= survives only as a legacy alias for ?node= (Team
 *     Performance linked /team?tl=… before this change).
 *   Team Lead: the current direct roster, unchanged (Mahadi
 *     scoped the drill-down to Manager / Admin / CEO only).
 *
 * One consistent pattern: every row with reports in the scoped
 * roster is a GROUP row (click → that person's direct reports,
 * ?node=<employeeId>); every leaf is a MEMBER row (click → the
 * member detail, ?member=, keeping ?node= so Back returns to the
 * same tier). A breadcrumb climbs back up the tiers. Group rows
 * aggregate the SAME honest metrics over the whole subtree
 * (aggregateSubtree): active leads, follow-up completion % (ONE
 * definition — completed-today / (completed + due-today +
 * overdue)), follow-ups due. No targets anywhere (Phase 3
 * undecided). The drill-down never widens scope: every tier is
 * computed over the scoped roster, and a ?node= outside it (or
 * a leaf, or the caller themself) falls back to the top level.
 *
 * Data comes from the ONE scoped overview payload (GET
 * /api/team/overview via useCallerTeam) + the caller's visible
 * leads (useAgentHomeLeads) + the follow-up queue (one 'all'
 * read for the member detail). The /api/team/tree endpoint and
 * its builder (server/services/teamTree.ts) were REMOVED with
 * the rebuild — the roster was their only caller.
 *
 * Honest metrics (no targets model exists — Phase 3 undecided):
 *   Progress  = follow-up completion % (completed-today /
 *               (completed-today + due-today + overdue)), the
 *               SAME definition as Team Overview's member
 *               performance — "—" when nothing was due or done.
 *   Capacity  = the demo's "Capacity used" has no model, so the
 *               fourth card is "Avg. active leads" per member
 *               (a plain count).
 *   Avg. conversion = team converted / team total leads.
 * Status is honest and simple: "Needs attention" when the
 * member has any overdue follow-up, else "On track" — for a
 * group row, when anything in the subtree is overdue.
 *
 * Admin-role users never appear in the roster or any aggregate
 * (an admin is never a sales employee). "+ Invite member" is
 * the Add user flow and shows ONLY with the admin-granted
 * `users.add_employee` grant (and only once the server
 * permission sheet has settled, so it never flashes in for an
 * ungranted TL).
 */

function initialsOf(name: string): string {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase() || '?';
}

interface RosterRowProps {
  person: TeamOverviewPerson;
  pct: number | null;
  followUpsDue: number;
  to: string;
  /** Small text under the name (default: the employee ID). Group rows show the team size. */
  sub?: string;
  /** Accessible label override (group rows open a team, not a detail). */
  ariaLabel?: string;
}

const RosterRow: FC<RosterRowProps> = ({ person, pct, followUpsDue, to, sub, ariaLabel }) => (
  <Link to={to} className="ep-roster-row" aria-label={ariaLabel ?? `Open ${person.name}'s detail`}>
    <span className="ep-roster-member">
      <span className="ep-miniavatar" aria-hidden="true">{initialsOf(person.name)}</span>
      <span className="ep-roster-copy">
        <strong>
          {person.name}
          {person.isSelf && <span className="ep-roster-you">You</span>}
        </strong>
        <small>{sub ?? person.employeeId}</small>
      </span>
    </span>
    <span className="ep-roster-role">{person.designation || person.roleName || 'Team member'}</span>
    <span className="ep-roster-num">{person.openLeads}</span>
    <span className="ep-roster-num">{pct === null ? '—' : `${pct}%`}</span>
    <span className="ep-roster-num">{followUpsDue}</span>
    <span className={cn('ep-pill', memberStatus(person) === 'Needs attention' ? 'warn' : 'ok')}>
      {memberStatus(person)}
    </span>
  </Link>
);

export default function TeamOverview() {
  const callerTeam = useCallerTeam();
  const homeLeads = useAgentHomeLeads();
  const { canAccess, serverPermissionsSettled } = usePermissions();
  const { role: displayRole } = useEnterpriseDisplayRole();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queueItems, setQueueItems] = useState<FollowUpQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);

  const memberParam = searchParams.get('member');
  // ?node= is the drill node (show this person's direct reports).
  // ?tl= is the legacy alias: Team Performance linked /team?tl=…
  // before the Head-first drill-down, and it means the same node.
  const nodeParam = searchParams.get('node') || searchParams.get('tl');

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const result = await leadService.getFollowUpQueue({ bucket: 'all', limit: 200 });
      setQueueItems(result.items || []);
    } catch {
      setQueueItems([]);
    } finally {
      setQueueLoading(false);
    }
  }, []);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );
  const people = useMemo(() => callerTeam.overview?.people ?? [], [callerTeam.overview]);

  // In-scope roster (admin-role users removed everywhere).
  const roster = useMemo(
    () => (self ? scopePeople(people, self, displayRole) : []),
    [people, self, displayRole],
  );
  const rosterIds = useMemo(
    () => new Set(roster.map(p => String(p.employeeId).toUpperCase())),
    [roster],
  );
  const scopedLeads = useMemo(
    () => scopeLeadsByAssignee(homeLeads.leads, rosterIds),
    [homeLeads.leads, rosterIds],
  );
  const totals = useMemo(() => summarizeTeamTotals(roster), [roster]);
  const completions = useMemo(
    () => memberCompletions(roster, scopedLeads),
    [roster, scopedLeads],
  );

  const avgConversion = totals.totalLeads === 0
    ? 0
    : Math.round((totals.converted / totals.totalLeads) * 100);
  const avgActiveLeads = roster.length === 0
    ? 0
    : Math.round((totals.open / roster.length) * 10) / 10;

  const canAddUser = serverPermissionsSettled && canAccess('user_management', 'add_employee');

  // Head-first drill-down (Admin / Manager only — the Team Lead
  // keeps the flat roster below). Every tier is computed over the
  // SCOPED roster, so drilling can never show someone outside the
  // caller's visibility. childrenOf is the memoized form of
  // directReportsOf over that roster.
  const isAdminView = displayRole === 'admin';
  const isManagerView = displayRole === 'manager';
  const isDrillView = isAdminView || isManagerView;
  const childrenByManager = useMemo(() => {
    const map = new Map<string, TeamOverviewPerson[]>();
    for (const person of roster) {
      const manager = String(person.managerEmployeeId || '').toUpperCase();
      if (!manager) continue;
      const list = map.get(manager) ?? [];
      list.push(person);
      map.set(manager, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [roster]);
  const childrenOf = useCallback(
    (employeeId: string) => childrenByManager.get(String(employeeId).toUpperCase()) ?? [],
    [childrenByManager],
  );

  // Top level: Department Heads (Admin, org-wide) or the
  // Manager's immediate subordinates — never the caller.
  const topLevel = useMemo(() => {
    if (!self) return [];
    if (isAdminView) return departmentHeadsOf(roster);
    if (isManagerView) return directReportsOf(roster, self.employeeId);
    return roster;
  }, [isAdminView, isManagerView, roster, self]);

  // The drill node, validated against the scoped roster: a node
  // outside it, a leaf (nothing to drill into), or the caller
  // themself falls back to the top level.
  const currentNode = useMemo(() => {
    if (!isDrillView || !nodeParam) return undefined;
    const node = roster.find(p => String(p.employeeId).toUpperCase() === String(nodeParam).toUpperCase());
    if (!node || node.isSelf) return undefined;
    return childrenOf(node.employeeId).length > 0 ? node : undefined;
  }, [isDrillView, nodeParam, roster, childrenOf]);

  const visibleRows = useMemo(() => {
    if (!isDrillView) return roster;
    if (currentNode) return childrenOf(currentNode.employeeId);
    return topLevel;
  }, [isDrillView, currentNode, roster, topLevel, childrenOf]);

  // Breadcrumb: the ancestor chain from the current node up to a
  // top-level node (the caller's own row is the root, never a
  // crumb). Cycle-guarded, roster-bound.
  const crumbs = useMemo(() => {
    if (!currentNode) return [];
    const topIds = new Set(topLevel.map(p => String(p.employeeId).toUpperCase()));
    const byId = new Map<string, TeamOverviewPerson>(roster.map(p => [String(p.employeeId).toUpperCase(), p]));
    const chain: TeamOverviewPerson[] = [];
    const seen = new Set<string>();
    let cursor: TeamOverviewPerson | undefined = currentNode;
    while (cursor && !seen.has(String(cursor.employeeId).toUpperCase())) {
      seen.add(String(cursor.employeeId).toUpperCase());
      chain.unshift(cursor);
      if (topIds.has(String(cursor.employeeId).toUpperCase())) break;
      const managerId = String(cursor.managerEmployeeId || '').toUpperCase();
      cursor = managerId ? byId.get(managerId) : undefined;
      if (cursor && cursor.isSelf) break;
    }
    return chain;
  }, [currentNode, roster, topLevel]);

  // Subtree aggregates for the group rows in this tier (leaf rows
  // use their own overview row + completion, as before).
  const aggregates = useMemo(() => {
    const map = new Map<string, SubtreeAggregate>();
    if (!isDrillView) return map;
    for (const row of visibleRows) {
      if (childrenOf(row.employeeId).length > 0) {
        map.set(
          String(row.employeeId).toUpperCase(),
          aggregateSubtree(roster, row.employeeId, completions),
        );
      }
    }
    return map;
  }, [isDrillView, visibleRows, roster, childrenOf, completions]);

  const listTitle = !isDrillView
    ? 'Team roster'
    : currentNode
      ? `${currentNode.name}'s team`
      : isAdminView
        ? 'Department heads'
        : 'Your direct reports';
  const listSub = !isDrillView
    ? `${visibleRows.length} member${visibleRows.length === 1 ? '' : 's'} · click a member to see their leads and follow-ups`
    : currentNode
      ? `${visibleRows.length} ${visibleRows.length === 1 ? 'person' : 'people'} · click a team to drill down, or a member to see their leads and follow-ups`
      : isAdminView
        ? `${visibleRows.length} department head${visibleRows.length === 1 ? '' : 's'} · click a head to drill into their team`
        : `${visibleRows.length} direct report${visibleRows.length === 1 ? '' : 's'} · click to drill into their team`;
  const backLabel = currentNode
    ? `${currentNode.name}'s team`
    : isAdminView
      ? 'department heads'
      : isManagerView
        ? 'direct reports'
        : 'team members';

  const selectedMember = useMemo(
    () => roster.find(p => String(p.employeeId).toUpperCase() === String(memberParam || '').toUpperCase()),
    [roster, memberParam],
  );
  const memberLeads = useMemo(() => {
    if (!selectedMember) return [];
    const memberId = String(selectedMember.employeeId).toUpperCase();
    return scopedLeads
      .filter(lead => String(lead.assignedTo || '').toUpperCase() === memberId)
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  }, [selectedMember, scopedLeads]);
  const memberFollowUps = useMemo(() => {
    if (!selectedMember) return [];
    const memberId = String(selectedMember.employeeId).toUpperCase();
    return queueItems
      .filter(item => String(item.assignedTo || '').toUpperCase() === memberId)
      .sort((a, b) => new Date(a.nextFollowUpAt).getTime() - new Date(b.nextFollowUpAt).getTime());
  }, [selectedMember, queueItems]);
  const selectedCompletion = selectedMember
    ? completions.get(String(selectedMember.employeeId).toUpperCase())
    : undefined;

  const closeMember = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('member');
    setSearchParams(next);
  };

  const loading = callerTeam.loading || homeLeads.loading;

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/team"
        actions={(
          <>
            <button
              type="button"
              onClick={() => { callerTeam.refresh(); void loadQueue(); }}
              className="ep-btn"
            >
              <RefreshCcw className="w-3.5 h-3.5" /> Refresh
            </button>
            <Link to="/team/organogram" className="ep-btn">
              <Network className="w-3.5 h-3.5" /> Organogram
            </Link>
            {canAddUser && (
              <Link to="/users/team" className="ep-btn ep-btn-primary">
                <UserPlus className="w-3.5 h-3.5" /> Invite member
              </Link>
            )}
          </>
        )}
      />

      {loading ? (
        <div className="ep-card">
          <p className="ep-empty" style={{ textAlign: 'center' }}>Loading your team…</p>
        </div>
      ) : callerTeam.error || !callerTeam.overview || !self ? (
        <div className="ep-card" style={{ borderColor: '#e8b4b0', background: '#fdf6f5' }}>
          <p className="text-sm font-bold" style={{ color: '#c84d43' }}>The team could not be loaded.</p>
          <button type="button" className="ep-btn" style={{ marginTop: 12 }} onClick={() => callerTeam.refresh()}>
            Retry
          </button>
        </div>
      ) : selectedMember ? (
        <>
          <button type="button" className="ep-btn" onClick={closeMember} style={{ marginBottom: 12 }}>
            ← Back to {backLabel}
          </button>
          <div className="ep-card">
            <div className="ep-cardhead">
              <div>
                <h3>{selectedMember.name}</h3>
                <div className="ep-muted">
                  {selectedMember.employeeId} · {selectedMember.designation || selectedMember.roleName || 'Team member'}
                  {selectedMember.managerName ? ` · Reports to ${selectedMember.managerName}` : ''}
                </div>
              </div>
              <span className={cn('ep-pill', memberStatus(selectedMember) === 'Needs attention' ? 'warn' : 'ok')}>
                {memberStatus(selectedMember)}
              </span>
            </div>
            <div className="ep-grid" style={{ marginTop: 4 }}>
              <KpiCard label="Assigned leads" value={selectedMember.totalLeads} foot="Assigned to this member" />
              <KpiCard label="Open leads" value={selectedMember.openLeads} foot="Not yet converted or closed" />
              <KpiCard
                label="Due today"
                value={selectedMember.dueToday}
                foot={selectedMember.overdue > 0 ? `${selectedMember.overdue} overdue` : 'Nothing overdue'}
                tone={selectedMember.overdue > 0 ? 'orange' : undefined}
              />
              <KpiCard
                label="Follow-up completion"
                value={selectedCompletion?.pct === null || selectedCompletion?.pct === undefined ? '—' : `${selectedCompletion.pct}%`}
                foot={`${selectedCompletion?.completed ?? 0} completed today`}
              />
            </div>
          </div>

          <div className="ep-card">
            <div className="ep-cardhead">
              <h3>Their leads</h3>
              <span className="ep-muted">{memberLeads.length} lead{memberLeads.length === 1 ? '' : 's'}</span>
            </div>
            {memberLeads.length === 0 ? (
              <p className="ep-empty">No leads assigned to this member yet.</p>
            ) : (
              <div className="ep-list">
                {memberLeads.map((lead: Lead) => (
                  <Link
                    key={lead.id}
                    to={`/leads/${encodeURIComponent(lead.id)}`}
                    className="ep-listrow ep-recent-row"
                  >
                    <span className="ep-person">
                      <span className="ep-miniavatar" aria-hidden="true">{initialsOf(lead.prospectName || '')}</span>
                      <span>
                        <strong>{lead.prospectName || 'Unnamed lead'}</strong>
                        <span className="ep-cellsub">
                          {lead.source || 'No source'}
                          {lead.nextFollowUpDate ? ` · Next follow-up ${formatDhakaShort(lead.nextFollowUpDate)}` : ''}
                        </span>
                      </span>
                    </span>
                    <span className={cn('ep-pill', getLeadStatusColorClasses(lead.currentStatus))}>
                      {lead.currentStatus}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="ep-card">
            <div className="ep-cardhead">
              <h3>Follow-ups due</h3>
              <span className="ep-muted">{memberFollowUps.length} scheduled</span>
            </div>
            {queueLoading ? (
              <p className="ep-empty">Loading follow-ups…</p>
            ) : memberFollowUps.length === 0 ? (
              <p className="ep-empty">No follow-ups scheduled for this member.</p>
            ) : (
              <div className="ep-list">
                {memberFollowUps.map(item => (
                  <Link
                    key={item.id}
                    to={`/leads/${encodeURIComponent(item.id)}`}
                    className="ep-listrow ep-recent-row"
                  >
                    <span className="ep-person">
                      <span>
                        <strong>{item.prospectName || item.customerName || 'Unnamed lead'}</strong>
                        <span className="ep-cellsub">
                          {item.currentStatus}
                          {item.dueState === 'overdue' ? ` · Overdue${item.overdueDays ? ` ${item.overdueDays}d` : ''}` : ''}
                        </span>
                      </span>
                    </span>
                    <span className="ep-muted">{formatDhakaShort(item.nextFollowUpAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="ep-grid">
            <KpiCard
              label="Team members"
              value={roster.length}
              foot={isAdminView ? 'People in scope across the organisation' : 'People in scope, including you'}
            />
            <KpiCard label="Active leads" value={totals.open} foot="Open leads across the team" />
            <KpiCard label="Avg. conversion" value={`${avgConversion}%`} foot={`${totals.converted} of ${totals.totalLeads} converted`} />
            <KpiCard label="Avg. active leads" value={avgActiveLeads} foot="Open leads per member" />
          </div>

          {isDrillView && currentNode && (
            <div className="ep-muted" style={{ marginBottom: 12, fontSize: 12 }}>
              <Link className="ep-viewall" to="/team">{isAdminView ? 'All departments' : 'All direct reports'}</Link>
              {crumbs.map(crumb => (
                <span key={crumb.employeeId}>
                  {' / '}
                  {String(crumb.employeeId).toUpperCase() === String(currentNode.employeeId).toUpperCase() ? (
                    <strong>{crumb.name}</strong>
                  ) : (
                    <Link className="ep-viewall" to={`/team?node=${encodeURIComponent(crumb.employeeId)}`}>{crumb.name}</Link>
                  )}
                </span>
              ))}
            </div>
          )}

          <div className="ep-card">
            <div className="ep-cardhead">
              <div>
                <h3>{listTitle}</h3>
                <div className="ep-muted">{listSub}</div>
              </div>
            </div>
            {visibleRows.length === 0 ? (
              <p className="ep-empty">
                {isManagerView && !currentNode
                  ? 'No direct reports yet — people who report to you will appear here.'
                  : 'No team members in scope yet.'}
              </p>
            ) : (
              <>
                <div className="ep-roster-head" aria-hidden="true">
                  <span>Member</span>
                  <span>Role</span>
                  <span>Active leads</span>
                  <span>Follow-up completion</span>
                  <span>Follow-ups due</span>
                  <span>Status</span>
                </div>
                <div className="ep-roster-list">
                  {visibleRows.map(person => {
                    const key = String(person.employeeId).toUpperCase();
                    const aggregate = aggregates.get(key);
                    const params = new URLSearchParams(searchParams);
                    params.set('member', person.employeeId);
                    // Group rows drill into the person's reports
                    // (?node=); leaf rows open the member detail
                    // (?member=, keeping ?node= so Back returns to
                    // this tier). The URL is built in a variable —
                    // the link-site guard in
                    // enterprise-inner-pages.test.ts cannot see it,
                    // so the two shapes are pinned in
                    // team-members-head-drilldown.test.ts instead.
                    const rowTo = aggregate
                      ? `/team?node=${encodeURIComponent(person.employeeId)}`
                      : `/team?${params.toString()}`;
                    // A group row shows the subtree numbers (the
                    // pill reads overdue, so the display person
                    // carries the subtree's open + overdue).
                    const displayPerson = aggregate
                      ? { ...person, openLeads: aggregate.totals.open, overdue: aggregate.totals.overdue }
                      : person;
                    return (
                      <RosterRow
                        key={person.userId}
                        person={displayPerson}
                        pct={aggregate ? aggregate.pct : (completions.get(key)?.pct ?? null)}
                        followUpsDue={aggregate ? aggregate.followUpsDue : person.dueToday + person.overdue}
                        to={rowTo}
                        sub={aggregate ? `${person.employeeId} · ${aggregate.members.length} in team` : undefined}
                        ariaLabel={aggregate ? `Open ${person.name}'s team` : undefined}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
