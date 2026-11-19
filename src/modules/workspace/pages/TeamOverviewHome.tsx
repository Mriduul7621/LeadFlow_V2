import { useMemo, useState, type FC } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useEnterpriseHomeData } from '../hooks/useEnterpriseHomeData';
import { useAgentHomeLeads } from '../hooks/useAgentHomeLeads';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { getSelfPerson, summarizeTeamTotals } from '../../team/services/teamOverviewService';
import { kpiDrilldownUrl } from '../../team/utils/kpiDrilldown';
import { EnterpriseErrorPanel } from '../components/EnterpriseErrorPanel';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { HomeSkeleton, KpiCard, OverviewHeading } from '../components/EnterprisePrimitives';
import { activityBuckets, type ActivityRange } from '../utils/agentWorkspaceData';
import {
  atRiskLeads,
  contactedCount,
  followUpHealth,
  isoWeekNumber,
  memberCompletions,
  scopeLeadsByAssignee,
  scopePeople,
  teamNameFor,
  type AtRiskLead,
} from '../utils/teamWorkspaceData';
import type { EnterpriseRole } from '../../../layouts/enterpriseRole';
import type { TeamOverviewPerson } from '../../team/services/teamOverviewService';

/**
 * TeamOverviewHome — ONE Team Overview component, three scopes
 * (2026-11-20, Mahadi's demo screenshots + words).
 * ------------------------------------------------------------------
 * Team Lead, Manager and Admin all land on the same layout; only
 * the scope changes (TL = own team, Manager = full downline,
 * Admin = whole organisation minus admin-role users). The demo's
 * "Manage team" and "Assign leads" buttons were dropped on his
 * word — only "+ Add Lead" (TL) / "+ Add user" (Admin) remain.
 *
 * The four KPI cards are the AGENT's set at team scope (his
 * words: "KPI gulo agent er motoi tobe tar nijer and tar nicher
 * subordinate der sob miliye"): Assigned leads, Due today,
 * Contacted, Converted — all from the scoped overview totals
 * (Contacted from the loaded leads list, the same definition as
 * the Agent home). No fabricated deltas anywhere.
 *
 * KPI substitutions (the demo's numbers have no real source):
 *   "Team target 82%"        -> Converted (team scope; no
 *                               targets model exists — Phase 3
 *                               undecided, so no target % is
 *                               shown anywhere)
 *   "Import success 98.4%"   -> Total leads (Admin: Assigned
 *                               leads, organisation-wide)
 *   "System health"          -> Active users is GONE with the
 *                               old Admin home (a user-admin
 *                               metric, not a sales KPI) — the
 *                               Admin home now uses the same
 *                               four sales KPIs as the TL
 *   "Target progress 62%"    -> Converted (team scope)
 *   "NCP achievement ৳28.4L" -> Converted (team scope; NCP
 *                               lives on Team Performance now)
 *   "Monthly target"         -> Converted (team scope)
 *   "Open records"           -> Assigned leads (team scope)
 *
 * Member performance shows exactly 3 members (best follow-up
 * completion first), View all → Team Members. Follow-up
 * completion is now REAL — completed-today / (completed-today +
 * due-today + overdue) — so the old "no real source" note is
 * retired: the guard that banned the label was updated with it.
 * At-risk leads show exactly 3 previews, View all → a dialog
 * with ALL at-risk leads (overdue follow-up OR no activity in
 * 48h — see teamWorkspaceData.atRiskLeads). Team activity counts
 * the whole scope's logged follow-up outcomes, with the same
 * timeframe options the Agent home supports.
 */

const ACTIVITY_RANGES: Array<{ value: ActivityRange; label: string }> = [
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
];

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

interface MemberRowProps {
  person: TeamOverviewPerson;
  pct: number | null;
  followUpsDue: number;
}

const MemberRow: FC<MemberRowProps> = ({ person, pct, followUpsDue }) => (
  <Link
    to={`/team?member=${encodeURIComponent(person.employeeId)}`}
    className="ep-member-row"
    aria-label={`Open ${person.name}'s detail`}
  >
    <span className="ep-miniavatar" aria-hidden="true">{initialsOf(person.name)}</span>
    <span className="ep-member-copy">
      <strong>{person.name}</strong>
      <small>
        {person.designation || person.roleName || 'Team member'}
        {` · ${followUpsDue} follow-up${followUpsDue === 1 ? '' : 's'} due`}
      </small>
    </span>
    <span className="ep-member-pct">{pct === null ? '—' : `${pct}%`}</span>
  </Link>
);

interface AtRiskRowProps {
  item: AtRiskLead;
}

const AtRiskRow: FC<AtRiskRowProps> = ({ item }) => {
  const lead = item.lead;
  return (
    <Link
      to={`/leads/${encodeURIComponent(lead.id)}`}
      className="ep-atrisk-row"
      aria-label={`Open ${lead.prospectName || 'lead'}`}
    >
      <span className="ep-atrisk-copy">
        <strong>{lead.prospectName || 'Unnamed lead'}</strong>
        <small>
          {item.reason === 'overdue' ? 'Follow-up overdue' : 'No activity in 48h'}
          {lead.assignedTo ? ` · ${lead.assignedTo}` : ''}
        </small>
      </span>
      <span className="ep-pill warn">{lead.currentStatus}</span>
    </Link>
  );
};

export function TeamOverviewHome(props: { scope: 'teamLead' | 'manager' | 'admin' }) {
  const { scope } = props;
  const user = useAuthStore(state => state.user);
  const { canAccess } = usePermissions();
  const data = useEnterpriseHomeData();
  const { callerTeam, metricsLoading, metricsError, forbidden } = data;
  const homeLeads = useAgentHomeLeads();
  const [activityRange, setActivityRange] = useState<ActivityRange>('this-week');
  const [atRiskDialogOpen, setAtRiskDialogOpen] = useState(false);

  const displayRole = scope as EnterpriseRole;

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );

  const people = useMemo(
    () => (callerTeam.overview && self ? scopePeople(callerTeam.overview.people, self, displayRole) : []),
    [callerTeam.overview, self, displayRole],
  );

  const scopeIds = useMemo(
    () => new Set(people.map(p => String(p.employeeId).toUpperCase())),
    [people],
  );

  const scopedLeads = useMemo(
    () => scopeLeadsByAssignee(homeLeads.leads, scopeIds),
    [homeLeads.leads, scopeIds],
  );

  const totals = useMemo(() => summarizeTeamTotals(people), [people]);
  const contacted = useMemo(() => contactedCount(scopedLeads), [scopedLeads]);

  const completions = useMemo(
    () => memberCompletions(people, scopedLeads),
    [people, scopedLeads],
  );

  const memberPerformance = useMemo(() => {
    const rows = people.map(person => ({
      person,
      pct: completions.get(String(person.employeeId).toUpperCase())?.pct ?? null,
      followUpsDue: person.dueToday + person.overdue,
    }));
    rows.sort((a, b) => {
      if (a.pct === null && b.pct === null) return a.person.name.localeCompare(b.person.name);
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return b.pct - a.pct || a.person.name.localeCompare(b.person.name);
    });
    return rows.slice(0, 3);
  }, [people, completions]);

  const health = useMemo(
    () => followUpHealth(people, scopedLeads),
    [people, scopedLeads],
  );

  const atRisk = useMemo(
    () => atRiskLeads(scopedLeads, data.overdueItems),
    [scopedLeads, data.overdueItems],
  );

  const activity = useMemo(
    () => activityBuckets(scopedLeads, activityRange),
    [scopedLeads, activityRange],
  );
  const activityMax = Math.max(1, ...activity.map(b => b.count));
  const activityRangeLabel = ACTIVITY_RANGES.find(r => r.value === activityRange)?.label ?? 'This week';

  const teamName = self ? teamNameFor(self, displayRole, user?.name) : '';
  const weekNumber = isoWeekNumber(new Date());
  const memberCount = people.length;

  if (callerTeam.loading || metricsLoading) {
    return <HomeSkeleton label="Loading the Team Overview" />;
  }

  if (forbidden) return <NoAccessYet module="the workspace overview" />;

  if (callerTeam.error || !callerTeam.overview || !self) {
    return (
      <EnterpriseErrorPanel
        title="This workspace could not be loaded"
        body="The team overview could not be loaded."
        onRetry={data.refresh}
      />
    );
  }

  const overdueCount = totals.overdue;

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow={scope === 'admin' ? 'ORGANISATION OVERVIEW' : 'TEAM COMMAND CENTER'}
        title="Team Overview"
        sub={`${teamName} · ${memberCount} member${memberCount === 1 ? '' : 's'} · Week ${weekNumber}`}
        actions={
          <>
            {scope === 'teamLead' && canAccess('lead_generate', 'create') ? (
              <Link className="ep-btn ep-btn-primary" to="/leads/new">
                ＋ Add Lead
              </Link>
            ) : null}
            {scope === 'admin' ? (
              <Link className="ep-btn ep-btn-primary" to="/users">
                ＋ Add user
              </Link>
            ) : null}
          </>
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} The figures below come from the team overview and the follow-up queue, and are unaffected.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="Assigned leads"
          value={totals.totalLeads}
          foot={`${memberCount} ${memberCount === 1 ? 'person' : 'people'} in scope`}
          to={kpiDrilldownUrl('totalLeads')}
        />
        <KpiCard
          label="Due today"
          value={totals.dueToday}
          foot={overdueCount > 0 ? `${overdueCount} overdue needs attention` : 'Nothing overdue'}
          tone={overdueCount > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('dueToday')}
        />
        <KpiCard
          label="Contacted"
          value={contacted}
          foot="Reached at least once"
        />
        <KpiCard
          label="Converted"
          value={totals.converted}
          foot="Converted leads in scope"
          to={kpiDrilldownUrl('converted')}
        />
      </div>

      <div className="ep-layout2">
        <div className="ep-card">
          <div className="ep-cardhead">
            <div>
              <h3>Member performance</h3>
              <div className="ep-muted">Follow-up completion % · best first</div>
            </div>
            <Link className="ep-viewall" to="/team">View all →</Link>
          </div>
          {memberPerformance.length === 0 ? (
            <p className="ep-empty">No members in scope yet.</p>
          ) : (
            <div className="ep-member-list">
              {memberPerformance.map(row => (
                <MemberRow
                  key={row.person.userId}
                  person={row.person}
                  pct={row.pct}
                  followUpsDue={row.followUpsDue}
                />
              ))}
            </div>
          )}
        </div>

        <div className="ep-card">
          <div className="ep-cardhead">
            <div>
              <h3>Follow-up health</h3>
              <div className="ep-muted">From the team&apos;s follow-up activity</div>
            </div>
            <Link className="ep-viewall" to="/follow-up">View all →</Link>
          </div>
          {health.total === 0 ? (
            <p className="ep-empty">No follow-ups in view — nothing due, overdue or completed today.</p>
          ) : (
            <div className="ep-health-list">
              <div className="ep-health-row">
                <span className="ep-health-label">On time</span>
                <span className="ep-health-bar"><span style={{ width: `${health.onTimePct ?? 0}%` }} /></span>
                <span className="ep-health-pct">{health.onTimePct === null ? '—' : `${health.onTimePct}%`}</span>
              </div>
              <div className="ep-health-row">
                <span className="ep-health-label">Due today</span>
                <span className="ep-health-bar"><span style={{ width: `${health.dueTodayPct}%` }} /></span>
                <span className="ep-health-pct">{health.dueTodayPct}%</span>
              </div>
              <div className="ep-health-row">
                <span className="ep-health-label">Overdue</span>
                <span className="ep-health-bar ep-health-bar--red"><span style={{ width: `${health.overduePct}%` }} /></span>
                <span className="ep-health-pct">{health.overduePct}%</span>
              </div>
            </div>
          )}
          {overdueCount > 0 && (
            <div className="ep-alert-bar" role="alert">
              {overdueCount} follow-up{overdueCount === 1 ? ' is' : 's are'} overdue. Review the queue and assign recovery actions.
            </div>
          )}
        </div>
      </div>

      <div className="ep-layout2">
        <div className="ep-card">
          <div className="ep-cardhead">
            <div>
              <h3>At-risk leads</h3>
              <div className="ep-muted">Overdue follow-up or no activity in 48h</div>
            </div>
            <button
              type="button"
              className="ep-viewall"
              onClick={() => setAtRiskDialogOpen(true)}
            >
              View all →
            </button>
          </div>
          {atRisk.length === 0 ? (
            <p className="ep-empty">No leads at risk right now.</p>
          ) : (
            <div className="ep-atrisk-list">
              {atRisk.slice(0, 3).map(item => (
                <AtRiskRow key={item.lead.id} item={item} />
              ))}
            </div>
          )}
        </div>

        <div className="ep-card">
          <div className="ep-cardhead">
            <div>
              <h3>Team activity</h3>
              <div className="ep-muted">Follow-up outcomes logged · {activityRangeLabel}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <select
                className="ep-select"
                value={activityRange}
                onChange={e => setActivityRange(e.target.value as ActivityRange)}
                aria-label="Activity timeframe"
              >
                {ACTIVITY_RANGES.map(range => (
                  <option key={range.value} value={range.value}>{range.label}</option>
                ))}
              </select>
              <Link className="ep-viewall" to="/activities">View all →</Link>
            </div>
          </div>
          {homeLeads.loading ? (
            <div className="ep-chart-loading" role="status" aria-label="Loading activity">
              <div className="ep-skeleton-bar" />
              <div className="ep-skeleton-bar" />
              <div className="ep-skeleton-bar" />
            </div>
          ) : homeLeads.error ? (
            <p className="ep-empty">Activity could not be loaded — the leads did not sync.</p>
          ) : (
            <>
              <div
                className="ep-chart"
                role="img"
                aria-label={`Team activity: ${activity.map(b => `${b.label} ${b.count}`).join(', ')}`}
              >
                {activity.map(bucket => (
                  <div className="ep-barwrap" key={bucket.label}>
                    <div
                      className="ep-bar"
                      style={{ height: `${Math.max(bucket.count > 0 ? 8 : 2, Math.round((bucket.count / activityMax) * 100))}%` }}
                      title={`${bucket.label}: ${bucket.count}`}
                    />
                  </div>
                ))}
              </div>
              <div className="ep-chartlabels">
                {activity.map(bucket => (
                  <span key={bucket.label}>{bucket.label}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {atRiskDialogOpen && (
        <div className="ep-dialog-overlay" role="dialog" aria-modal="true" aria-label="All at-risk leads">
          <div className="ep-dialog">
            <div className="ep-dialog-head">
              <div>
                <h3>At-risk leads</h3>
                <div className="ep-muted">Overdue follow-up or no activity in 48h · {atRisk.length} lead{atRisk.length === 1 ? '' : 's'}</div>
              </div>
              <button
                type="button"
                className="ep-btn"
                onClick={() => setAtRiskDialogOpen(false)}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="ep-dialog-body">
              {atRisk.length === 0 ? (
                <p className="ep-empty">No leads at risk right now.</p>
              ) : (
                <div className="ep-atrisk-list">
                  {atRisk.map(item => (
                    <AtRiskRow key={item.lead.id} item={item} />
                  ))}
                </div>
              )}
              {data.overdueTotal > data.overdueItems.length && (
                <p className="ep-cardfoot">
                  Showing the first {data.overdueItems.length} of {data.overdueTotal} overdue follow-ups — the full list is in the queue.
                </p>
              )}
            </div>
            <div className="ep-dialog-foot">
              <Link className="ep-btn" to="/follow-up" onClick={() => setAtRiskDialogOpen(false)}>
                Open the full queue →
              </Link>
              <button type="button" className="ep-btn ep-btn-primary" onClick={() => setAtRiskDialogOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
