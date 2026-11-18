import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  FolderOpen,
  Layers,
  Radar,
  RefreshCcw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useCallerTeam } from '../hooks/useCallerTeam';
import { useAuthStore } from '../../auth/store/authStore';
import {
  staleLeadRadar,
  summarizeTeamTotals,
  teamFollowUpsToday,
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
 */


function getWorkspaceMeta(roleName?: string) {
  const role = String(roleName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (role === 'ADMIN' || role === 'SUPERADMIN') return {
    title: 'Admin Workspace',
    subtitle: 'Organization-wide visibility, people and operational control',
    followUpTitle: 'Organization follow-ups today',
    quickLinks: [
      { label: 'User Management', description: 'People, roles and access', to: '/users' },
      { label: 'Administration', description: 'System settings and governance', to: '/administration' },
      { label: 'Performance', description: 'Organization-level insights', to: '/execution-intelligence' },
      { label: 'Team Overview', description: 'Review the reporting structure', to: '/team' },
    ],
  };
  if (role === 'MANAGER') return {
    title: 'Manager Workspace',
    subtitle: 'Manage team execution, lead movement and performance',
    followUpTitle: 'Managed-team follow-ups today',
    quickLinks: [
      { label: 'Team Overview', description: 'Review team activity and ownership', to: '/team' },
      { label: 'Lead Workspace', description: 'Review and progress leads', to: '/leads' },
      { label: 'Follow-up Queue', description: 'Prioritize due and overdue work', to: '/follow-up' },
      { label: 'Performance', description: 'Track team execution trends', to: '/execution-intelligence' },
    ],
  };
  return {
    title: 'Team Lead Workspace',
    subtitle: 'Keep your team aligned on leads, follow-ups and daily execution',
    followUpTitle: 'Team follow-ups today',
    quickLinks: [
      { label: 'My Team', description: 'Review team members and progress', to: '/team' },
      { label: 'Follow-up Queue', description: 'Prioritize due and overdue work', to: '/follow-up' },
      { label: 'Lead Workspace', description: 'Review assigned team leads', to: '/leads' },
      { label: 'Activities', description: 'Review recent execution history', to: '/activities' },
    ],
  };
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  iconTone,
  to,
}: {
  label: string;
  value: number;
  icon: typeof FolderOpen;
  tone: string;
  iconTone: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className={cn('rounded-2xl py-3 px-4 text-center block hover:ring-2 hover:ring-[#978C21]/40 transition-shadow', tone)}
      aria-label={`${label}: ${value} — view details`}
    >
      <p className="text-xl font-black text-stone-800 flex items-center justify-center gap-1.5">
        <Icon className={cn('w-4 h-4', iconTone)} />
        {value}
      </p>
      <p className="text-[8px] font-black uppercase tracking-widest text-stone-400 mt-0.5">{label}</p>
    </Link>
  );
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

export function TeamHomeContent({
  people,
  scope,
  onRefresh,
}: {
  people: TeamOverviewPerson[];
  scope: string;
  onRefresh?: () => void;
}) {
  const user = useAuthStore(state => state.user);
  const workspace = getWorkspaceMeta(user?.role);
  const totals = summarizeTeamTotals(people);
  const followUps = teamFollowUpsToday(people);
  const radar = staleLeadRadar(people);

  return (
    <div className="space-y-6 text-left">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#978C21]/10 text-[#978C21] rounded-2xl flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-black text-stone-800 tracking-tight">{workspace.title}</h1>
            <p className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
              {people.length} people in your view · {scope || 'Assigned scope'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
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

      <p className="-mt-3 text-sm text-stone-500">{workspace.subtitle}</p>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Role workspace shortcuts">
        {workspace.quickLinks.map(item => (
          <Link key={item.to} to={item.to} className="group rounded-xl border border-stone-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-[#978C21]/50 hover:bg-[#FFFCF8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#978C21]">
            <span className="block text-sm font-bold text-stone-800 group-hover:text-[#756c1b]">{item.label}</span>
            <span className="mt-1 block text-xs leading-5 text-stone-500">{item.description}</span>
          </Link>
        ))}
      </section>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Total Lead" value={totals.totalLeads} icon={Layers} tone="bg-stone-50" iconTone="text-stone-400" to="/team/kpi/totalLeads" />
        <StatCard label="Today Lead Collection" value={totals.todayCollection} icon={CalendarPlus} tone="bg-sky-50" iconTone="text-sky-500" to="/team/kpi/todayCollection" />
        <StatCard label="Open leads" value={totals.open} icon={FolderOpen} tone="bg-stone-50" iconTone="text-stone-400" to="/team/kpi/open" />
        <StatCard label="Due today" value={totals.dueToday} icon={CalendarClock} tone="bg-amber-50" iconTone="text-amber-500" to="/team/kpi/dueToday" />
        <StatCard label="Overdue" value={totals.overdue} icon={AlertTriangle} tone="bg-red-50" iconTone="text-red-500" to="/team/kpi/overdue" />
        <StatCard label="No Action Alert" value={totals.noAction} icon={BellRing} tone="bg-red-50" iconTone="text-red-500" to="/team/kpi/noAction" />
        <StatCard label="Converted" value={totals.converted} icon={TrendingUp} tone="bg-emerald-50" iconTone="text-emerald-500" to="/team/kpi/converted" />
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-black uppercase tracking-widest text-stone-700">{workspace.followUpTitle}</h2>
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
        <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center space-y-2">
          <p className="text-sm font-black text-stone-700">No team data available right now</p>
          <p className="text-xs text-stone-400">
            Your role-based workspace is ready. Team metrics will appear here when your reporting scope contains team members.
          </p>
        </div>
      </div>
    );
  }

  return <TeamHomeContent people={overview.people} scope={overview.scope} onRefresh={refresh} />;
}
