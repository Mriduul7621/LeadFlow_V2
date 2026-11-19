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
  memberCompletions,
  memberStatus,
  scopeLeadsByAssignee,
  scopePeople,
  tlAncestorOf,
} from '../../workspace/utils/teamWorkspaceData';
import { formatDhakaShort } from '../../workspace/utils/enterpriseData';
import type { Lead } from '../../shared/types';

/**
 * TeamOverview — the Team Members page (Team Lead / Manager /
 * Admin workspace rebuild, 2026-11-20, Mahadi's demo
 * screenshot 4).
 * ------------------------------------------------------------------
 * Mahadi called the old page "ekta faltu design" (an org tree +
 * tier groups fed by GET /api/team/tree). The rebuild follows the
 * demo: 4 KPI cards + a Team roster table, with the Retail Sales
 * Dashboard drill-down pattern — roster → click a member → that
 * member's detail (their KPIs, leads and follow-ups due) → click
 * a lead → Lead360. The organogram chart still lives at
 * /team/organogram (linked from the header).
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
 * member has any overdue follow-up, else "On track".
 *
 * Manager grouping (Mahadi): a Manager FIRST sees TL groups;
 * clicking a Team Lead drills to that TL's member-wise roster
 * (?tl=), then to a member (?member=). Admin-role users never
 * appear in the roster or any aggregate (an admin is never a
 * sales employee). "+ Invite member" is the Add user flow and
 * shows ONLY with the admin-granted `users.add_employee` grant
 * (and only once the server permission sheet has settled, so
 * it never flashes in for an ungranted TL).
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
}

const RosterRow: FC<RosterRowProps> = ({ person, pct, followUpsDue, to }) => (
  <Link to={to} className="ep-roster-row" aria-label={`Open ${person.name}'s detail`}>
    <span className="ep-roster-member">
      <span className="ep-miniavatar" aria-hidden="true">{initialsOf(person.name)}</span>
      <span className="ep-roster-copy">
        <strong>
          {person.name}
          {person.isSelf && <span className="ep-roster-you">You</span>}
        </strong>
        <small>{person.employeeId}</small>
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
  const tlParam = searchParams.get('tl');

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

  // Manager TL grouping (?tl= drills one TL's member-wise roster).
  const isManagerView = displayRole === 'manager';
  const tlGroups = useMemo(() => {
    if (!isManagerView || !self) return [];
    const groups = new Map<string, { tl: TeamOverviewPerson; members: TeamOverviewPerson[] }>();
    for (const person of roster) {
      const tl = tlAncestorOf(people, person.employeeId, self.employeeId) ?? self;
      const key = String(tl.employeeId).toUpperCase();
      const group = groups.get(key) ?? { tl, members: [] };
      group.members.push(person);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.tl.name.localeCompare(b.tl.name));
  }, [isManagerView, roster, people, self]);
  const selectedTlGroup = useMemo(
    () => tlGroups.find(g => String(g.tl.employeeId).toUpperCase() === String(tlParam || '').toUpperCase()),
    [tlGroups, tlParam],
  );
  const visibleRoster = useMemo(() => {
    if (!isManagerView || !tlParam) return roster;
    return selectedTlGroup ? selectedTlGroup.members : [];
  }, [isManagerView, tlParam, roster, selectedTlGroup]);

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
            ← Back to {isManagerView && tlParam && selectedTlGroup ? `${selectedTlGroup.tl.name}'s team` : 'team members'}
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
            <KpiCard label="Team members" value={roster.length} foot="People in scope, including you" />
            <KpiCard label="Active leads" value={totals.open} foot="Open leads across the team" />
            <KpiCard label="Avg. conversion" value={`${avgConversion}%`} foot={`${totals.converted} of ${totals.totalLeads} converted`} />
            <KpiCard label="Avg. active leads" value={avgActiveLeads} foot="Open leads per member" />
          </div>

          {isManagerView && !tlParam ? (
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Teams by team lead</h3>
                  <div className="ep-muted">Click a team lead to see their members</div>
                </div>
              </div>
              {tlGroups.length === 0 ? (
                <p className="ep-empty">No team leads in scope yet.</p>
              ) : (
                <div className="ep-member-list">
                  {tlGroups.map(group => {
                    const groupTotals = summarizeTeamTotals(group.members);
                    return (
                      <Link
                        key={group.tl.employeeId}
                        to={`/team?tl=${encodeURIComponent(group.tl.employeeId)}`}
                        className="ep-member-row"
                        aria-label={`Open ${group.tl.name}'s team`}
                      >
                        <span className="ep-miniavatar" aria-hidden="true">{initialsOf(group.tl.name)}</span>
                        <span className="ep-member-copy">
                          <strong>{group.tl.name}</strong>
                          <small>
                            {group.tl.designation || group.tl.roleName || 'Team Lead'}
                            {` · ${group.members.length} member${group.members.length === 1 ? '' : 's'} · ${groupTotals.open} active leads`}
                          </small>
                        </span>
                        <span className="ep-member-pct">→</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>{isManagerView && tlParam && selectedTlGroup ? `${selectedTlGroup.tl.name}'s team` : 'Team roster'}</h3>
                  <div className="ep-muted">
                    {visibleRoster.length} member{visibleRoster.length === 1 ? '' : 's'} · click a member to see their leads and follow-ups
                  </div>
                </div>
                {isManagerView && tlParam && (
                  <Link className="ep-viewall" to="/team">← All teams</Link>
                )}
              </div>
              {visibleRoster.length === 0 ? (
                <p className="ep-empty">No team members in scope yet.</p>
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
                    {visibleRoster.map(person => {
                      const completion = completions.get(String(person.employeeId).toUpperCase());
                      const params = new URLSearchParams(searchParams);
                      params.set('member', person.employeeId);
                      return (
                        <RosterRow
                          key={person.userId}
                          person={person}
                          pct={completion?.pct ?? null}
                          followUpsDue={person.dueToday + person.overdue}
                          to={`/team?${params.toString()}`}
                        />
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
