import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useEnterpriseHomeData } from '../hooks/useEnterpriseHomeData';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { getSelfPerson } from '../../team/services/teamOverviewService';
import { kpiDrilldownUrl } from '../../team/utils/kpiDrilldown';
import { EnterpriseErrorPanel } from '../components/EnterpriseErrorPanel';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { dueLabel } from '../utils/enterpriseData';
import {
  AttentionCard,
  ChartCard,
  DataTableCard,
  HomeSkeleton,
  KpiCard,
  OverviewHeading,
  PersonCell,
  type AttentionRow,
  type TableRow,
} from '../components/EnterprisePrimitives';

/**
 * AgentHome — the Agent workspace overview (Enterprise Preview
 * redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample's Agent overview, rebuilt on real LeadFlow data. The
 * H1 is "My Work" (the sample's one H1 exception). KPI
 * substitutions (the sample's numbers have no real source):
 *   "My leads 128"     -> My leads (the caller's own overview row)
 *   "Due today 9"      -> Due today (own row)
 *   "Overdue 3"        -> Overdue (own row)
 *   "Monthly target"   -> Converted (own row)
 * There is no targets data model in LeadFlow, so no target percent
 * is shown anywhere — the caller's own converted count stands in.
 * Every KPI drills into the caller's OWN leads (?person=self).
 * The attention list and the follow-ups table read the real
 * follow-up queue (overdue first, then today); priorities come
 * from the queue rows the server already computed, never invented.
 */

const MAX_TABLE_ROWS = 8;

export function AgentHome() {
  const user = useAuthStore(state => state.user);
  const { canAccess } = usePermissions();
  const data = useEnterpriseHomeData();
  const { callerTeam, metricsLoading, metricsError, forbidden } = data;

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );

  const attentionRows = useMemo<AttentionRow[]>(() => {
    const rows: AttentionRow[] = [];
    for (const item of data.overdueItems.slice(0, 4)) {
      rows.push({
        title: item.prospectName || item.customerName || 'Unnamed lead',
        sub: dueLabel(item.nextFollowUpAt),
        actionLabel: 'Call and update outcome',
        to: `/leads/${item.id}`,
        tone: 'red',
      });
    }
    if (rows.length < 4) {
      for (const item of data.todayItems.slice(0, 4 - rows.length)) {
        rows.push({
          title: item.prospectName || item.customerName || 'Unnamed lead',
          sub: dueLabel(item.nextFollowUpAt),
          actionLabel: 'Open lead',
          to: `/leads/${item.id}`,
          tone: 'orange',
        });
      }
    }
    return rows;
  }, [data.overdueItems, data.todayItems]);

  const tableRows = useMemo<TableRow[]>(() => {
    const items = [...data.overdueItems, ...data.todayItems].slice(0, MAX_TABLE_ROWS);
    return items.map(item => ({
      key: item.id,
      searchText: `${item.prospectName || ''} ${item.customerName || ''} ${item.mobile || ''} ${item.currentStatus || ''}`,
      cells: [
        <PersonCell
          name={item.prospectName || item.customerName || 'Unnamed lead'}
          sub={item.mobile}
          to={`/leads/${item.id}`}
        />,
        item.currentStatus,
        dueLabel(item.nextFollowUpAt),
        item.priority ? (
          <span key="priority" className={`ep-pill${item.dueState === 'overdue' ? ' red' : ''}`}>
            {item.priority}
          </span>
        ) : (
          '—'
        ),
      ],
    }));
  }, [data.overdueItems, data.todayItems]);

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

  return (
    <div className="ep-page">
      <OverviewHeading
        eyebrow="Agent workspace"
        title="My Work"
        sub={user ? `Welcome back, ${user.name}. Your daily priorities, follow-ups and the next best action for every lead.` : 'Your daily priorities, follow-ups and the next best action for every lead.'}
        actions={
          canAccess('lead_generate', 'create') ? (
            <Link className="ep-btn ep-btn-primary" to="/leads/new">
              ＋ Add Lead
            </Link>
          ) : undefined
        }
      />

      {metricsError && (
        <div className="ep-banner" role="alert">
          {metricsError} The figures below come from your own overview and the follow-up queue, and are unaffected.
        </div>
      )}

      <div className="ep-grid">
        <KpiCard
          label="My leads"
          value={self.totalLeads}
          foot="Assigned to you"
          to={kpiDrilldownUrl('totalLeads', 'self')}
        />
        <KpiCard
          label="Due today"
          value={self.dueToday}
          foot="Keep your day on track"
          tone={self.dueToday > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('dueToday', 'self')}
        />
        <KpiCard
          label="Overdue"
          value={self.overdue}
          foot="Take action first"
          tone={self.overdue > 0 ? 'orange' : undefined}
          to={kpiDrilldownUrl('overdue', 'self')}
        />
        <KpiCard
          label="Converted"
          value={self.convertedLeads}
          foot="Your converted leads"
          to={kpiDrilldownUrl('converted', 'self')}
        />
      </div>

      <div className="ep-layout2">
        <ChartCard
          title="Follow-ups due · next 7 days"
          sub="From the follow-up queue, grouped by Dhaka day"
          days={data.chartDays}
          loading={data.queueLoading}
          foot={data.chartTruncated ? 'Showing the first 50 due today and 50 upcoming — the queue holds more.' : undefined}
        />
        <AttentionCard
          title="Your priorities"
          sub="Action list"
          rows={attentionRows}
          emptyText="Nothing due — no follow-ups are overdue or due today."
        />
      </div>

      <DataTableCard
        title="My follow-ups"
        sub="Overdue first, then due today"
        headers={['Lead', 'Next action', 'Due', 'Priority']}
        rows={tableRows}
        emptyText="No follow-ups due — the queue is clear."
        searchPlaceholder="Search by name, mobile or status…"
      />
    </div>
  );
}
