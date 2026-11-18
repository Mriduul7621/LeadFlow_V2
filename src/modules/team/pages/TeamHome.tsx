import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Radar,
  RefreshCcw,
  Users,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useCallerTeam } from '../hooks/useCallerTeam';
import HomeViewSwitch from '../components/HomeViewSwitch';
import HomeKpiRow from '../components/HomeKpiRow';
import {
  fetchExecutions,
  staleLeadRadar,
  summarizeTeamTotals,
  teamExecutionOverview,
  teamFollowUpsToday,
  teamTomorrowPreview,
  type ExecutionLead,
  type ExecutionsResponse,
  type TeamOverviewPerson,
} from '../services/teamOverviewService';

/**
 * TeamHome — the TL+ team-first home (owner-approved 2026-11-11)
 * ------------------------------------------------------------------
 * Anyone who can SEE a team lands here (at `/`, rendered by
 * HomeLanding) instead of the member My Day view: the day starts
 * with the TEAM — totals, who owes follow-ups today, and whose
 * leads are going stale — with a one-tap switch to their own work.
 * "Sees a team" is callerSeesTeam: the scoped overview's scope is
 * not 'Own' (Organization/Team — admin, CEO, managers, team leads),
 * or the caller has >= 1 direct report. Everything renders from the
 * ONE scoped payload (GET /api/team/overview via teamOverviewService),
 * the same data the My Team page shows; rows link through to /team
 * for the full view, and the seven KPI cards drill down the tree at
 * /team/kpi/:kpi (KPI drill-down, 2026-11-13). All seven cards always
 * render — a 0 is shown, never hidden (never-empty rule, 2026-11-13).
 * No Action Alert is styled as an alert (red, like Overdue): leads
 * with no first action within 48 hours of entry.
 *
 * Mirror rule (owner, 2026-11-18): this page and My Work
 * (DailyWorkbench) render the SAME KPI row from the shared
 * HomeKpiRow component — same seven cards, same order, same look;
 * only the data differs (team totals here, own numbers there).
 * The Execution Queue below is the team mirror of the workbench's
 * own queue: a member-wise overview first, then that member's
 * executions on tap (overdue first, then due today, then
 * upcoming — each row to Lead360). The Tomorrow Preview is the
 * team mirror of the workbench's tomorrow grouping: the whole
 * team's combined tomorrow follow-ups, grouped by member.
 */

/** Dhaka calendar date for a stored timestamp (same shape as the drill-down). */
function dhakaDate(iso: string | null): string {
  if (!iso) return 'No next action set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No next action set';
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

function MemberRow({ person, variant }: { person: TeamOverviewPerson; variant: 'followUp' | 'radar' }) {
  return (
    <Link
      to="/team"
      className="flex items-center justify-between gap-3 bg-white border border-stone-200/80 rounded-2xl px-4 py-3 hover:border-[#978C21]/50 transition-colors"
    >
      <div className="min-w-0">
        <p className="text-sm font-black text-stone-800 truncate">
          {person.name}
          {person.isSelf && (
            <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
          )}
        </p>
        <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
          {[person.employeeId, person.designation].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {variant === 'followUp' && person.dueToday > 0 && (
          <span className="text-[10px] font-black uppercase tracking-widest bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
            {person.dueToday} due today
          </span>
        )}
        {person.overdue > 0 && (
          <span className="text-[10px] font-black uppercase tracking-widest bg-red-50 text-red-600 px-2 py-1 rounded-full">
            {person.overdue} overdue
          </span>
        )}
        {variant === 'radar' && (
          <span className="text-[10px] font-black uppercase tracking-widest bg-stone-100 text-stone-500 px-2 py-1 rounded-full">
            {person.openLeads} open
          </span>
        )}
      </div>
    </Link>
  );
}

/** One execution in a member's queue — same row shape as the KPI
 *  drill-down's leaf rows, plus a due-state pill (overdue / due
 *  today / the scheduled date). Links to Lead360. */
function ExecutionRow({ lead }: { lead: ExecutionLead }) {
  const pill =
    lead.dueState === 'overdue'
      ? { text: 'Overdue', cls: 'bg-red-50 text-red-600' }
      : lead.dueState === 'today'
        ? { text: 'Due today', cls: 'bg-amber-50 text-amber-700' }
        : { text: dhakaDate(lead.nextFollowUpAt), cls: 'bg-stone-100 text-stone-500' };
  return (
    <Link
      to={`/leads/${lead.id}`}
      className="flex items-center justify-between gap-3 bg-stone-50/60 border border-stone-200/60 rounded-2xl px-4 py-3 hover:border-[#978C21]/50 transition-colors"
    >
      <div className="min-w-0">
        <p className="text-sm font-black text-stone-800 truncate">{lead.customerName}</p>
        <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
          {[lead.leadCode, lead.mobile].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest bg-stone-100 text-stone-600 px-2 py-1 rounded-full">
          {lead.currentStatus}
        </span>
        <span className={cn('text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full', pill.cls)}>
          {pill.text}
        </span>
        <ChevronRight className="w-4 h-4 text-stone-300" />
      </div>
    </Link>
  );
}

export function TeamHomeContent({
  people,
  scope,
  onRefresh,
}: {
  people: TeamOverviewPerson[];
  scope: string;
  onRefresh?: () => void;
}) {
  const totals = summarizeTeamTotals(people);
  const followUps = teamFollowUpsToday(people);
  const radar = staleLeadRadar(people);
  const executionMembers = teamExecutionOverview(people);
  const tomorrowMembers = teamTomorrowPreview(people);

  // Execution Queue expansion: one member at a time; their
  // executions load lazily on first expand and are cached per
  // member for the session (a Refresh reloads the overview, and
  // the next expand re-fetches — executions are not cached across
  // a refresh because follow-up work changes fast).
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);
  const [executions, setExecutions] = useState<Record<string, ExecutionsResponse>>({});
  const [execLoading, setExecLoading] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const toggleMember = async (employeeId: string) => {
    if (expandedEmp === employeeId) {
      setExpandedEmp(null);
      return;
    }
    setExpandedEmp(employeeId);
    setExecError(null);
    if (executions[employeeId]) return;
    setExecLoading(employeeId);
    try {
      const res = await fetchExecutions(employeeId);
      setExecutions(prev => ({ ...prev, [employeeId]: res }));
    } catch {
      setExecError('Could not load this member\u2019s executions. Please try again.');
    } finally {
      setExecLoading(null);
    }
  };

  const retryExecutions = (employeeId: string) => {
    setExecutions(prev => {
      const next = { ...prev };
      delete next[employeeId];
      return next;
    });
    setExecError(null);
    setExecLoading(employeeId);
    fetchExecutions(employeeId)
      .then(res => setExecutions(prev => ({ ...prev, [employeeId]: res })))
      .catch(() => setExecError('Could not load this member\u2019s executions. Please try again.'))
      .finally(() => setExecLoading(null));
  };

  return (
    <div className="space-y-6 text-left">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#978C21]/10 text-[#978C21] rounded-2xl flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-black text-stone-800 tracking-tight">Team Home</h1>
            <p className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
              {people.length} people in your team{scope ? ` · ${scope} scope` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HomeViewSwitch active="team" />
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500 hover:border-[#978C21]/50"
            >
              <RefreshCcw className="w-3.5 h-3.5" /> Refresh
            </button>
          )}
        </div>
      </div>

      <HomeKpiRow values={totals} />

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-stone-700 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-[#978C21]" /> Execution Queue
          </h2>
          <span className="text-[10px] font-bold text-stone-400">Member-wise — tap a member to see their executions</span>
        </div>
        {executionMembers.length === 0 ? (
          <div className="bg-white border border-stone-200/80 rounded-2xl p-6 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <p className="text-sm font-bold text-stone-600">
              No team members in scope — there is no execution queue to show.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {executionMembers.map(person => {
              const expanded = expandedEmp === person.employeeId;
              const exec = executions[person.employeeId];
              return (
                <div key={person.userId} className="bg-white border border-stone-200/80 rounded-2xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleMember(person.employeeId)}
                    aria-expanded={expanded}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-stone-50 transition-colors text-left"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-black text-stone-800 truncate">
                        {person.name}
                        {person.isSelf && (
                          <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
                        )}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
                        {[person.employeeId, person.designation].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={cn(
                        'text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full',
                        person.dueToday > 0 ? 'bg-amber-50 text-amber-700' : 'bg-stone-100 text-stone-400'
                      )}>
                        {person.dueToday} due today
                      </span>
                      <span className={cn(
                        'text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full',
                        person.overdue > 0 ? 'bg-red-50 text-red-600' : 'bg-stone-100 text-stone-400'
                      )}>
                        {person.overdue} overdue
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest bg-stone-100 text-stone-500 px-2 py-1 rounded-full">
                        {person.openLeads} open
                      </span>
                      <ChevronDown className={cn('w-4 h-4 text-stone-400 transition-transform', expanded && 'rotate-180')} />
                    </div>
                  </button>
                  {expanded && (
                    <div className="border-t border-stone-100 px-4 py-3 space-y-2">
                      {execLoading === person.employeeId ? (
                        <div className="space-y-2" role="status" aria-label={`Loading ${person.name}'s executions`}>
                          {[0, 1].map(i => (
                            <div key={i} className="h-14 bg-stone-100 rounded-2xl animate-pulse" />
                          ))}
                        </div>
                      ) : execError ? (
                        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 space-y-2">
                          <p className="text-sm text-red-600 font-bold">{execError}</p>
                          <button
                            type="button"
                            onClick={() => retryExecutions(person.employeeId)}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
                          >
                            <RefreshCcw className="w-3.5 h-3.5" /> Try again
                          </button>
                        </div>
                      ) : !exec || exec.items.length === 0 ? (
                        <p className="text-sm font-bold text-stone-600 py-1">
                          No scheduled follow-ups — nothing in {person.isSelf ? 'your' : `${person.name}'s`} execution queue.
                        </p>
                      ) : (
                        <>
                          {exec.total > exec.items.length && (
                            <p className="text-[11px] font-bold text-stone-400">
                              Showing {exec.items.length} of {exec.total} executions — most urgent first.
                            </p>
                          )}
                          {exec.items.map(lead => (
                            <Fragment key={lead.id}>
                              <ExecutionRow lead={lead} />
                            </Fragment>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-stone-700">Team follow-ups today</h2>
          <span className="text-[10px] font-bold text-stone-400">Due and overdue, by member</span>
        </div>
        {followUps.length === 0 ? (
          <div className="bg-white border border-stone-200/80 rounded-2xl p-6 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <p className="text-sm font-bold text-stone-600">
              Nothing due today — no follow-ups due or overdue across the team.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {followUps.map(person => (
              <div key={person.userId}>
                <MemberRow person={person} variant="followUp" />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-stone-700 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-sky-500" /> Tomorrow Preview
          </h2>
          <span className="text-[10px] font-bold text-stone-400">
            {totals.dueTomorrow} follow-up{totals.dueTomorrow === 1 ? '' : 's'} due tomorrow across the team
          </span>
          {totals.dueTomorrow > 0 && (
            <Link to="/team/kpi/dueTomorrow" className="text-[11px] font-black uppercase tracking-widest text-[#978C21] hover:underline ml-auto">
              View all
            </Link>
          )}
        </div>
        {tomorrowMembers.length === 0 ? (
          <div className="bg-white border border-stone-200/80 rounded-2xl p-6 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <p className="text-sm font-bold text-stone-600">
              Nothing scheduled for tomorrow — no follow-ups due across the team.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tomorrowMembers.map(person => (
              <Link
                key={person.userId}
                to={`/team/kpi/dueTomorrow?person=${encodeURIComponent(person.employeeId)}`}
                className="flex items-center justify-between gap-3 bg-white border border-stone-200/80 rounded-2xl px-4 py-3 hover:border-[#978C21]/50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-black text-stone-800 truncate">
                    {person.name}
                    {person.isSelf && (
                      <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
                    )}
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
                    {[person.employeeId, person.designation].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-black uppercase tracking-widest bg-sky-50 text-sky-600 px-2 py-1 rounded-full">
                    {person.dueTomorrow ?? 0} due tomorrow
                  </span>
                  <ChevronRight className="w-4 h-4 text-stone-300" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-stone-700 flex items-center gap-2">
            <Radar className="w-4 h-4 text-red-500" /> Stale-lead radar
          </h2>
          <span className="text-[10px] font-bold text-stone-400">Most overdue follow-ups</span>
        </div>
        {radar.length === 0 ? (
          <div className="bg-white border border-stone-200/80 rounded-2xl p-6 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <p className="text-sm font-bold text-stone-600">
              No overdue follow-ups — nobody's leads are going stale.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {radar.map(person => (
              <div key={person.userId}>
                <MemberRow person={person} variant="radar" />
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-[11px] font-bold text-stone-400">
        Full team detail lives on{' '}
        <Link to="/team" className="text-[#978C21] hover:underline">
          My Team
        </Link>
        .
      </p>
    </div>
  );
}

export default function TeamHome() {
  const { loading, error, overview, hasTeam, refresh } = useCallerTeam();

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading team home">
        <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
        <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
        <div className="h-28 bg-stone-100 rounded-[12px] animate-pulse" />
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-3 text-left">
        <p className="text-sm text-red-600 font-bold">Failed to load your team home.</p>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500"
        >
          <RefreshCcw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  if (!hasTeam) {
    // Defensive: HomeLanding only renders this for callers who see
    // a team, but the roster can change mid-session — fall back to
    // the switch and a plain explanation instead of an empty view.
    return (
      <div className="space-y-4 text-left">
        <div className="flex justify-end">
          <HomeViewSwitch active="team" />
        </div>
        <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center space-y-2">
          <p className="text-sm font-black text-stone-700">No team to show right now</p>
          <p className="text-xs text-stone-400">
            When people report to you — or your role can see the wider team — your day will start with their follow-ups here.
          </p>
        </div>
      </div>
    );
  }

  return <TeamHomeContent people={overview.people} scope={overview.scope} onRefresh={refresh} />;
}
