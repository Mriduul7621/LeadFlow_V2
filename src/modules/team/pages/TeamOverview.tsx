import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Network, RefreshCcw, CalendarClock, TrendingUp, FolderOpen } from 'lucide-react';
import { apiRequest } from '../../shared/api/http';
import { cn } from '../../../lib/utils';

/**
 * Team Overview (FIX-1 item 5)
 * ------------------------------------------------------------------
 * The team-wise data view the owner asked for: the caller's people
 * from the reporting tree, grouped Manager -> Team Leader -> Team
 * Member, each person with open leads, converted leads and follow-ups
 * due today. Everything comes from ONE scoped endpoint
 * (GET /api/team/overview) — the server applies the caller's existing
 * visibility rules, so this page can only ever render people (and
 * counts) the caller is allowed to see. The organogram chart lives on
 * at /team/organogram.
 */

export interface TeamPerson {
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
  isSelf: boolean;
}

interface TeamOverviewResponse {
  success: boolean;
  scope: string;
  people: TeamPerson[];
}

const TIERS: Array<{ key: TeamPerson['tier']; title: string; blurb: string }> = [
  { key: 'manager', title: 'Managers', blurb: 'People whose teams have team leaders under them' },
  { key: 'teamLead', title: 'Team Leaders', blurb: 'People with team members reporting to them' },
  { key: 'teamMember', title: 'Team Members', blurb: 'Individual contributors' },
];

function PersonCard({ person }: { person: TeamPerson }) {
  return (
    <div className={cn(
      'bg-white border rounded-2xl p-4 shadow-sm space-y-3',
      person.isSelf ? 'border-[#978C21] ring-1 ring-[#978C21]/40' : 'border-stone-200/80'
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-black text-stone-800 truncate">
            {person.name}
            {person.isSelf && (
              <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
            )}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
            {[person.designation, person.department].filter(Boolean).join(' · ') || person.employeeId}
          </p>
          {person.managerName && (
            <p className="text-[10px] text-stone-400 mt-0.5">Reports to {person.managerName}</p>
          )}
        </div>
        {person.directReports > 0 && (
          <span className="shrink-0 text-[9px] font-black uppercase tracking-widest bg-stone-100 text-stone-500 px-2 py-1 rounded-full">
            {person.directReports} report{person.directReports === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-stone-50 rounded-xl py-2">
          <p className="text-base font-black text-stone-800 flex items-center justify-center gap-1"><FolderOpen className="w-3.5 h-3.5 text-stone-400" />{person.openLeads}</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-stone-400">Open leads</p>
        </div>
        <div className="bg-emerald-50 rounded-xl py-2">
          <p className="text-base font-black text-emerald-700 flex items-center justify-center gap-1"><TrendingUp className="w-3.5 h-3.5" />{person.convertedLeads}</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-emerald-600/70">Converted</p>
        </div>
        <div className={cn('rounded-xl py-2', person.dueToday > 0 ? 'bg-amber-50' : 'bg-stone-50')}>
          <p className={cn('text-base font-black flex items-center justify-center gap-1', person.dueToday > 0 ? 'text-amber-700' : 'text-stone-800')}>
            <CalendarClock className="w-3.5 h-3.5" />{person.dueToday}
          </p>
          <p className={cn('text-[8px] font-black uppercase tracking-widest', person.dueToday > 0 ? 'text-amber-600/70' : 'text-stone-400')}>Due today</p>
        </div>
      </div>
    </div>
  );
}

export default function TeamOverview() {
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<TeamOverviewResponse>('/api/team/overview');
      setPeople(Array.isArray(res?.people) ? res.people : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load the team overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => TIERS.map(tier => ({
    ...tier,
    members: people
      .filter(p => p.tier === tier.key)
      .sort((a, b) => (b.openLeads + b.dueToday) - (a.openLeads + a.dueToday) || a.name.localeCompare(b.name)),
  })).filter(g => g.members.length > 0), [people]);

  const totals = useMemo(() => ({
    open: people.reduce((s, p) => s + p.openLeads, 0),
    converted: people.reduce((s, p) => s + p.convertedLeads, 0),
    due: people.reduce((s, p) => s + p.dueToday, 0),
  }), [people]);

  return (
    <div className="space-y-6 text-left">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#978C21]/10 text-[#978C21] rounded-2xl flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-black text-stone-800 tracking-tight">My Team</h1>
            <p className="text-[11px] font-bold uppercase tracking-widest text-stone-400">
              {people.length} people in your scope · {totals.open} open · {totals.converted} converted · {totals.due} due today
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-stone-200 rounded-full text-[11px] font-black uppercase tracking-widest text-stone-500 hover:border-[#978C21]/50"
          >
            <RefreshCcw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Link
            to="/team/organogram"
            className="flex items-center gap-2 px-4 py-2 bg-[#3C3C3B] text-white rounded-full text-[11px] font-black uppercase tracking-widest hover:bg-black"
          >
            <Network className="w-3.5 h-3.5" /> Organogram
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center text-sm text-stone-400 font-bold">
          Loading your team...
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-6 text-sm text-red-600 font-bold">{error}</div>
      ) : people.length === 0 ? (
        <div className="bg-white border border-stone-200/80 rounded-2xl p-10 text-center space-y-2">
          <p className="text-sm font-black text-stone-700">No team members in your scope yet</p>
          <p className="text-xs text-stone-400">When people report to you — directly or through your team — they will appear here with their lead counts.</p>
        </div>
      ) : (
        grouped.map(group => (
          <section key={group.key} className="space-y-3">
            <div className="flex items-baseline gap-3">
              <h2 className="text-sm font-black uppercase tracking-widest text-stone-700">{group.title}</h2>
              <span className="text-[10px] font-bold text-stone-400">{group.members.length} · {group.blurb}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.members.map(person => (
                <div key={person.userId}>
                  <PersonCard person={person} />
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
