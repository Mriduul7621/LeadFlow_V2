import { useMemo, useState, type FC } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useEnterpriseHomeData } from '../hooks/useEnterpriseHomeData';
import { useAgentHomeLeads } from '../hooks/useAgentHomeLeads';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { getSelfPerson } from '../../team/services/teamOverviewService';
import { kpiDrilldownUrl } from '../../team/utils/kpiDrilldown';
import { EnterpriseErrorPanel } from '../components/EnterpriseErrorPanel';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { formatDhakaTime } from '../utils/enterpriseData';
import {
  activityBuckets,
  dhakaHour,
  firstNameOf,
  greetingForDhakaHour,
  pipelineSegments,
  recentOwnLeads,
  tomorrowFollowUps,
  topPriorityFollowUps,
  type ActivityRange,
} from '../utils/agentWorkspaceData';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import { HomeSkeleton, KpiCard, OverviewHeading } from '../components/EnterprisePrimitives';
import type { FollowUpQueueItem } from '../../leads/services/leadService';

/**
 * AgentHome — the Agent workspace overview (Agent workspace
 * rebuild, 2026-11-20, Mahadi's demo screenshots).
 * ------------------------------------------------------------------
 * The demo's "My Work" home, rebuilt on real LeadFlow data. The H1
 * is the time-based greeting ("Good morning, {firstName}"); "My
 * Work" survives as the sidebar label and breadcrumb. The four
 * KPI cards are the demo's set with Mahadi's substitution: the
 * demo's "Target progress" has no real source (no targets model),
 * so Converted stands in, as he said ("Target er replace e amra
 * chaile converted dibo"). The demo's "+x% vs last week" deltas
 * have no real source either, so the cards carry plain factual
 * sublines instead — never a fabricated trend.
 *
 *   Assigned leads -> the caller's own overview row (totalLeads)
 *   Due today      -> the caller's own overview row (dueToday);
 *                     the subline names the real overdue count
 *   Contacted      -> the dashboard metrics (own scope)
 *   Converted      -> the caller's own overview row
 *
 * Priority follow-ups are the top 2 of today's bucket by time;
 * "View all" opens the full today + tomorrow list on this page.
 * The pipeline bar uses the REAL LeadFlow statuses from the
 * dashboard status counts (never the demo's New / Qualified /
 * Proposal / Won names). Weekly activity counts real logged
 * follow-up outcomes per day, with a timeframe the data supports
 * (this week / last week / this month). Recent leads are the
 * caller's own 3 most recently added or updated leads.
 *
 * The Contacted card has no drill-down: there is no 'contacted'
 * KPI key, and linking it to the unfiltered lead list would
 * promise a filter that does not exist.
 */

const ACTIVITY_RANGES: Array<{ value: ActivityRange; label: string }> = [
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
];

interface PriorityRowProps {
  item: FollowUpQueueItem;
  index: number;
}

const PriorityRow: FC<PriorityRowProps> = ({ item, index }) => {
  const name = item.prospectName || item.customerName || 'Unnamed lead';
  return (
    <Link
      to={`/leads/${encodeURIComponent(item.id)}/update`}
      className="ep-priority-row"
      aria-label={`Update follow-up for ${name}`}
    >
      <span className="ep-priority-num" aria-hidden="true">{index + 1}</span>
      <span className="ep-priority-copy">
        <strong>{name}</strong>
        <small>
          {item.currentStatus}
          {item.priority ? ` · ${item.priority} priority` : ''}
        </small>
      </span>
      <span className="ep-priority-time">{formatDhakaTime(item.nextFollowUpAt)}</span>
    </Link>
  );
}

export function AgentHome() {
  const user = useAuthStore(state => state.user);
  const { canAccess } = usePermissions();
  const data = useEnterpriseHomeData();
  const { callerTeam, metrics, metricsLoading, metricsError, forbidden } = data;
  const homeLeads = useAgentHomeLeads();
  const [activityRange, setActivityRange] = useState<ActivityRange>('this-week');
  const [priorityDialogOpen, setPriorityDialogOpen] = useState(false);

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );

  const greeting = useMemo(() => {
    const first = firstNameOf(user?.name);
    const greet = greetingForDhakaHour(dhakaHour(new Date()));
    return first ? `${greet}, ${first} 👋` : `${greet} 👋`;
  }, [user?.name]);

  const priorityItems = useMemo(
    () => topPriorityFollowUps(data.todayItems, 2),
    [data.todayItems],
  );

  const tomorrowItems = useMemo(
    () => tomorrowFollowUps(data.upcomingItems),
    [data.upcomingItems],
  );

  const pipeline = useMemo(
    () => pipelineSegments(metrics?.statusCounts ?? {}),
    [metrics],
  );

  const recentLeads = useMemo(
    () => recentOwnLeads(homeLeads.leads, user?.employeeId, 3),
    [homeLeads.leads, user?.employeeId],
  );

  const activity = useMemo(
    () => activityBuckets(homeLeads.leads, activityRange),
    [homeLeads.leads, activityRange],
  );
  const activityMax = Math.max(1, ...activity.map(b => b.count));
  const activityRangeLabel = ACTIVITY_RANGES.find(r => r.value === activityRange)?.label ?? 'This week';

  if (callerTeam.loading || metricsLoading) return <HomeSkeleton label="Loading your workspace" />;

  if (forbidden) return <NoAccessYet module="the workspace overview" />;

  if (callerTeam.error || !callerTeam.overview || !self) {
    return (
      <EnterpriseErrorPanel
        title="This workspace could not be loaded"
        body="Your own overview could not be loaded."
        onRetry={data.refresh}
      />
    );
  }

  const overdueCount = self.overdue;

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow="Personal workspace"
        title={greeting}
        sub="Here's your personal performance and what needs your attention today."
        actions={
          <>
            <Link className="ep-btn" to="/task-calendar">
              View tasks
            </Link>
            {canAccess('lead_generate', 'create') ? (
              <Link className="ep-btn ep-btn-primary" to="/leads/new">
                ＋ Add Lead
              </Link>
            ) : null}
          </>
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} The figures below come from your own overview and the follow-up queue, and are unaffected.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="Assigned leads"
          value={self.totalLeads}
          foot="Assigned to you"
          to={kpiDrilldownUrl('totalLeads', 'self')}
        />
        <KpiCard
          label="Due today"
          value={self.dueToday}
          foot={overdueCount > 0 ? `${overdueCount} overdue needs attention` : 'Nothing overdue'}
          tone={overdueCount > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('dueToday', 'self')}
        />
        <KpiCard
          label="Contacted"
          value={metrics ? metrics.contacted : '—'}
          foot={metrics ? 'Reached at least once' : 'Unavailable right now'}
        />
        <KpiCard
          label="Converted"
          value={self.convertedLeads}
          foot="Your converted leads"
          to={kpiDrilldownUrl('converted', 'self')}
        />
      </div>

      <div className="ep-layout2">
        <div className="ep-card">
          <div className="ep-cardhead">
            <h3>Priority follow-ups</h3>
            <button
              type="button"
              className="ep-viewall"
              onClick={() => setPriorityDialogOpen(true)}
            >
              View all →
            </button>
          </div>
          {data.queueLoading ? (
            <p className="ep-empty">Loading today's follow-ups…</p>
          ) : priorityItems.length === 0 ? (
            <p className="ep-empty">Nothing due today — the queue is clear.</p>
          ) : (
            <div className="ep-priority-list">
              {priorityItems.map((item, i) => (
                <PriorityRow key={item.id} item={item} index={i} />
              ))}
            </div>
          )}
          <div className="ep-cardfoot">Tap a follow-up to log its outcome and set the next one.</div>
        </div>

        <div className="ep-card">
          <div className="ep-cardhead">
            <h3>My pipeline</h3>
            <Link className="ep-viewall" to="/leads">View all →</Link>
          </div>
          {!metrics ? (
            <p className="ep-empty">Pipeline unavailable — the dashboard could not be loaded.</p>
          ) : pipeline.total === 0 ? (
            <p className="ep-empty">No leads yet — your pipeline appears here.</p>
          ) : (
            <>
              <p className="ep-pipeline-total">
                <strong>{pipeline.total}</strong> leads in view
              </p>
              <div
                className="ep-pipeline-bar"
                role="img"
                aria-label={`Pipeline: ${pipeline.segments.map(s => `${s.name} ${s.count}`).join(', ')}`}
              >
                {pipeline.segments
                  .filter(s => s.count > 0)
                  .map(s => (
                    <span
                      key={s.name}
                      className="ep-pipeline-seg"
                      style={{ width: `${(s.count / pipeline.total) * 100}%`, background: s.color }}
                      title={`${s.name}: ${s.count}`}
                    />
                  ))}
              </div>
              <div className="ep-pipeline-legend">
                {pipeline.segments.map(s => (
                  <span key={s.name} className="ep-pipeline-legend-item">
                    <span className="ep-pipeline-dot" style={{ background: s.color }} aria-hidden="true" />
                    {s.name} {s.count}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="ep-layout2">
        <div className="ep-card">
          <div className="ep-cardhead">
            <div>
              <h3>Weekly activity</h3>
              <div className="ep-muted">Follow-up outcomes logged per day · {activityRangeLabel}</div>
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
            <p className="ep-empty">Activity could not be loaded — your leads did not sync.</p>
          ) : (
            <>
              <div
                className="ep-chart"
                role="img"
                aria-label={`Weekly activity: ${activity.map(b => `${b.label} ${b.count}`).join(', ')}`}
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

        <div className="ep-card">
          <div className="ep-cardhead">
            <h3>Recent leads</h3>
            <Link className="ep-viewall" to="/leads">View all →</Link>
          </div>
          {homeLeads.loading ? (
            <p className="ep-empty">Loading recent leads…</p>
          ) : homeLeads.error ? (
            <p className="ep-empty">Recent leads could not be loaded — your leads did not sync.</p>
          ) : recentLeads.length === 0 ? (
            <p className="ep-empty">No leads assigned to you yet.</p>
          ) : (
            <div className="ep-list">
              {recentLeads.map(lead => (
                <Link
                  key={lead.id}
                  to={`/leads/${encodeURIComponent(lead.id)}`}
                  className="ep-listrow ep-recent-row"
                >
                  <span className="ep-person">
                    <span className="ep-miniavatar" aria-hidden="true">
                      {String(lead.prospectName || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'}
                    </span>
                    <span>
                      <strong>{lead.prospectName || 'Unnamed lead'}</strong>
                      <span className="ep-cellsub">
                        {lead.source || 'No source'} · {firstNameOf(user?.name)}
                      </span>
                    </span>
                  </span>
                  <span className={`ep-pill ${getLeadStatusColorClasses(lead.currentStatus)}`}>
                    {lead.currentStatus}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {priorityDialogOpen && (
        <div className="ep-dialog-overlay" role="dialog" aria-modal="true" aria-label="Today and tomorrow follow-ups">
          <div className="ep-dialog">
            <div className="ep-dialog-head">
              <div>
                <h3>Priority follow-ups</h3>
                <div className="ep-muted">Today's list, then tomorrow's planned follow-ups</div>
              </div>
              <button
                type="button"
                className="ep-btn"
                onClick={() => setPriorityDialogOpen(false)}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="ep-dialog-body">
              <p className="ep-dialog-section">Today · {data.todayItems.length} follow-up{data.todayItems.length === 1 ? '' : 's'}</p>
              {data.todayItems.length === 0 ? (
                <p className="ep-empty">Nothing due today.</p>
              ) : (
                <div className="ep-priority-list">
                  {data.todayItems.map((item, i) => (
                    <PriorityRow key={item.id} item={item} index={i} />
                  ))}
                </div>
              )}
              {data.todayTotal > data.todayItems.length && (
                <p className="ep-cardfoot">
                  Showing the first {data.todayItems.length} of {data.todayTotal} due today — the full list is in the queue.
                </p>
              )}
              <p className="ep-dialog-section">Tomorrow · {tomorrowItems.length} planned</p>
              {tomorrowItems.length === 0 ? (
                <p className="ep-empty">Nothing planned for tomorrow yet.</p>
              ) : (
                <div className="ep-priority-list">
                  {tomorrowItems.map((item, i) => (
                    <PriorityRow key={item.id} item={item} index={i} />
                  ))}
                </div>
              )}
            </div>
            <div className="ep-dialog-foot">
              <Link className="ep-btn" to="/follow-up" onClick={() => setPriorityDialogOpen(false)}>
                Open the full queue →
              </Link>
              <button type="button" className="ep-btn ep-btn-primary" onClick={() => setPriorityDialogOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
