import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, Network, RefreshCcw, CalendarClock, TrendingUp, FolderOpen,
  ChevronRight, ChevronDown, AlertTriangle, Trophy, Wallet, ArrowUp,
} from 'lucide-react';
import { apiRequest } from '../../shared/api/http';
import { cn } from '../../../lib/utils';

/**
 * Team report (FIX-1 item 5, evolved per owner request 2026-11-11)
 * ------------------------------------------------------------------
 * ONE data path: GET /api/team/tree returns the caller's people as
 * the reporting tree (server applies the caller's visibility scope —
 * nobody outside it is ever in the payload). This page renders, from
 * that single payload:
 *   1. the org TREE, opening at the top of the caller's visible tree,
 *      nodes labelled name + employee ID + designation, each with own
 *      numbers and a whole-subtree rollup incl. "Possible business
 *      (open pipeline)" = summed expected premium of open leads;
 *   2. a drill-down DETAIL for the selected person: breadcrumb back up
 *      the tree, own numbers, their direct team (name + ID wise), the
 *      subtree's pipeline by lead status, and two plain-language
 *      insights — "Needs follow-up" (most overdue + due today) and
 *      "Doing well" (top converters; this month when anyone converted
 *      this month, otherwise all time — the heading says which);
 *   3. the original flat Manager -> Team Leader -> Team Member groups.
 * The organogram chart lives on at /team/organogram.
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
  // Org-tree report additions (GET /api/team/tree)
  childrenIds: string[];
  overdue: number;
  convertedThisMonth: number;
  pipelineValue: number;
  subtree: {
    people: number;
    openLeads: number;
    dueToday: number;
    overdue: number;
    converted: number;
    convertedThisMonth: number;
    pipelineValue: number;
  };
  subtreeStatusCounts: Record<string, number>;
}

interface TeamTreeResponse {
  success: boolean;
  scope: string;
  people: TeamPerson[];
  rootIds: string[];
}

const TIERS: Array<{ key: TeamPerson['tier']; title: string; blurb: string }> = [
  { key: 'manager', title: 'Managers', blurb: 'People whose teams have team leaders under them' },
  { key: 'teamLead', title: 'Team Leaders', blurb: 'People with team members reporting to them' },
  { key: 'teamMember', title: 'Team Members', blurb: 'Individual contributors' },
];

const money = (n: number) => `৳${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

function PersonCard({ person, onSelect }: { person: TeamPerson; onSelect?: (p: TeamPerson) => void }) {
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
      {onSelect && (
        <button
          type="button"
          onClick={() => onSelect(person)}
          className="w-full text-center text-[10px] font-black uppercase tracking-widest text-[#978C21] hover:underline"
        >
          View in tree detail
        </button>
      )}
    </div>
  );
}

function TreeNode({
  person, byId, depth, expanded, onToggle, selectedId, onSelect,
}: {
  person: TeamPerson;
  byId: Map<string, TeamPerson>;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (p: TeamPerson) => void;
}) {
  const kids = (person.childrenIds || []).map(id => byId.get(id)).filter(Boolean) as TeamPerson[];
  const isOpen = expanded.has(person.userId);
  const selected = selectedId === person.userId;
  return (
    <div>
      <div
        className={cn(
          'flex items-start gap-2 py-2.5 pr-3 rounded-xl border mb-1.5 bg-white',
          selected ? 'border-[#978C21] ring-1 ring-[#978C21]/40' : 'border-stone-200/80'
        )}
        style={{ marginLeft: Math.min(depth, 6) * 14 }}
      >
        {kids.length > 0 ? (
          <button
            type="button"
            aria-label={isOpen ? 'Collapse team' : 'Expand team'}
            onClick={() => onToggle(person.userId)}
            className="mt-0.5 ml-1.5 shrink-0 w-6 h-6 rounded-full bg-stone-100 text-stone-500 flex items-center justify-center"
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="mt-0.5 ml-1.5 shrink-0 w-6 h-6 rounded-full bg-stone-50 flex items-center justify-center">
            <span className="w-1.5 h-1.5 rounded-full bg-stone-300" />
          </span>
        )}
        <button type="button" onClick={() => onSelect(person)} className="min-w-0 flex-1 text-left">
          <p className="text-sm font-black text-stone-800 truncate">
            {person.name}
            {person.isSelf && (
              <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>
            )}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 truncate">
            {person.employeeId} · {[person.designation, person.department].filter(Boolean).join(' · ')}
          </p>
          <p className="text-[11px] text-stone-500 mt-1">
            Own: <b>{person.openLeads}</b> open · <b>{person.dueToday}</b> due today ·{' '}
            <span className={person.overdue > 0 ? 'text-red-600 font-bold' : undefined}><b>{person.overdue}</b> overdue</span> ·{' '}
            <b>{person.convertedLeads}</b> converted
          </p>
          {kids.length > 0 && person.subtree && (
            <p className="text-[11px] text-stone-500">
              Whole team ({person.subtree.people}): <b>{person.subtree.openLeads}</b> open ·{' '}
              <span className="text-[#978C21] font-bold">Possible business (open pipeline) {money(person.subtree.pipelineValue)}</span>
            </p>
          )}
        </button>
      </div>
      {isOpen && kids.map(kid => (
        <Fragment key={kid.userId}>
          <TreeNode
            person={kid}
            byId={byId}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </Fragment>
      ))}
    </div>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'amber' | 'green' | 'olive' }) {
  const toneClass = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-emerald-700' : tone === 'olive' ? 'text-[#978C21]' : 'text-stone-800';
  return (
    <div className="bg-stone-50 rounded-xl py-3 px-2 text-center">
      <p className={cn('text-lg font-black', toneClass)}>{value}</p>
      <p className="text-[8px] font-black uppercase tracking-widest text-stone-400">{label}</p>
      {sub && <p className="text-[9px] font-bold text-stone-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function PersonDetail({
  person, byId, byEmployeeId, onSelect,
}: {
  person: TeamPerson;
  byId: Map<string, TeamPerson>;
  byEmployeeId: Map<string, TeamPerson>;
  onSelect: (p: TeamPerson) => void;
}) {
  // Breadcrumb: walk up via managerEmployeeId while the manager is in scope.
  const ancestors = useMemo(() => {
    const chain: TeamPerson[] = [];
    const seen = new Set<string>([person.userId]);
    let cursor: TeamPerson | undefined = person;
    while (cursor?.managerEmployeeId) {
      const mgr = byEmployeeId.get(cursor.managerEmployeeId.toUpperCase());
      if (!mgr || seen.has(mgr.userId)) break;
      seen.add(mgr.userId);
      chain.unshift(mgr);
      cursor = mgr;
    }
    return chain;
  }, [person, byEmployeeId]);

  const directTeam = useMemo(
    () => (person.childrenIds || []).map(id => byId.get(id)).filter(Boolean) as TeamPerson[],
    [person, byId]
  );

  const subtreeMembers = useMemo(() => {
    const out: TeamPerson[] = [];
    const seen = new Set<string>();
    const walk = (p: TeamPerson) => {
      if (seen.has(p.userId)) return;
      seen.add(p.userId);
      out.push(p);
      for (const id of p.childrenIds || []) {
        const kid = byId.get(id);
        if (kid) walk(kid);
      }
    };
    walk(person);
    return out;
  }, [person, byId]);

  const statusRows = useMemo(() => {
    const entries = Object.entries(person.subtreeStatusCounts || {}).sort((a, b) => b[1] - a[1]);
    const max = entries.length ? entries[0][1] : 0;
    return entries.map(([status, count]) => ({ status, count, pct: max > 0 ? Math.round((count / max) * 100) : 0 }));
  }, [person]);

  const needsFollowUp = useMemo(() =>
    subtreeMembers
      .filter(p => p.userId !== person.userId && (p.overdue + p.dueToday) > 0)
      .sort((a, b) => (b.overdue + b.dueToday) - (a.overdue + a.dueToday) || b.overdue - a.overdue || a.name.localeCompare(b.name))
      .slice(0, 5),
    [subtreeMembers, person]);

  const doingWell = useMemo(() => {
    const others = subtreeMembers.filter(p => p.userId !== person.userId);
    const thisMonth = others
      .filter(p => p.convertedThisMonth > 0)
      .sort((a, b) => b.convertedThisMonth - a.convertedThisMonth || b.convertedLeads - a.convertedLeads || a.name.localeCompare(b.name))
      .slice(0, 5);
    if (thisMonth.length > 0) return { period: 'this month' as const, rows: thisMonth };
    const allTime = others
      .filter(p => p.convertedLeads > 0)
      .sort((a, b) => b.convertedLeads - a.convertedLeads || a.name.localeCompare(b.name))
      .slice(0, 5);
    return { period: 'all time' as const, rows: allTime };
  }, [subtreeMembers, person]);

  return (
    <section className="bg-white border border-[#978C21]/40 rounded-2xl p-4 sm:p-5 shadow-sm space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1 text-[11px] font-bold text-stone-400">
          {ancestors.map(a => (
            <span key={a.userId} className="flex items-center gap-1">
              <button type="button" onClick={() => onSelect(a)} className="hover:text-[#978C21] hover:underline">{a.name}</button>
              <ChevronRight className="w-3 h-3" />
            </span>
          ))}
          <span className="text-stone-700">{person.name}</span>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-black text-stone-800">
              {person.name}
              {person.isSelf && <span className="ml-2 align-middle text-[8px] font-black uppercase tracking-widest bg-[#978C21] text-white px-1.5 py-0.5 rounded">You</span>}
            </h2>
            <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400">
              {person.employeeId} · {[person.designation, person.department].filter(Boolean).join(' · ')}
              {person.managerName ? ` · Reports to ${person.managerName}` : ''}
            </p>
          </div>
          {ancestors.length > 0 && (
            <button
              type="button"
              onClick={() => onSelect(ancestors[ancestors.length - 1])}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-100 rounded-full text-[10px] font-black uppercase tracking-widest text-stone-500"
            >
              <ArrowUp className="w-3 h-3" /> Back to {ancestors[ancestors.length - 1].name}
            </button>
          )}
        </div>
      </div>

      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-2">Own numbers</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <StatCard label="Open leads" value={String(person.openLeads)} />
          <StatCard label="Due today" value={String(person.dueToday)} tone={person.dueToday > 0 ? 'amber' : undefined} />
          <StatCard label="Overdue" value={String(person.overdue)} tone={person.overdue > 0 ? 'red' : undefined} />
          <StatCard label="Converted" value={String(person.convertedLeads)} sub={`${person.convertedThisMonth} this month`} tone="green" />
          <StatCard label="Possible business (own)" value={money(person.pipelineValue)} tone="olive" />
        </div>
      </div>

      {person.subtree && person.directReports > 0 && (
        <div className="bg-[#978C21]/5 border border-[#978C21]/20 rounded-xl px-4 py-3 text-[12px] text-stone-600">
          Whole team below <b>{person.name}</b> ({person.subtree.people} people incl. self):{' '}
          <b>{person.subtree.openLeads}</b> open · <b>{person.subtree.dueToday}</b> due today ·{' '}
          <b>{person.subtree.overdue}</b> overdue · <b>{person.subtree.converted}</b> converted ·{' '}
          <span className="text-[#978C21] font-bold">Possible business (open pipeline) {money(person.subtree.pipelineValue)}</span>
        </div>
      )}

      {directTeam.length > 0 && (
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-2">Direct team — tap a person to drill down</p>
          <div className="divide-y divide-stone-100 border border-stone-100 rounded-xl overflow-hidden">
            {directTeam.map(member => (
              <button
                key={member.userId}
                type="button"
                onClick={() => onSelect(member)}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-stone-50"
              >
                <span className="text-sm font-black text-stone-800">{member.name}</span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-stone-400">{member.employeeId} · {member.designation || ''}</span>
                <span className="ml-auto text-[11px] text-stone-500">
                  <b>{member.openLeads}</b> open · <b>{member.dueToday}</b> due ·{' '}
                  <span className={member.overdue > 0 ? 'text-red-600 font-bold' : undefined}><b>{member.overdue}</b> overdue</span> ·{' '}
                  <b>{member.convertedLeads}</b> converted · {money(member.pipelineValue)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {statusRows.length > 0 && (
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-stone-400 mb-2">
            {person.directReports > 0 ? 'Team pipeline by status (whole team below, incl. self)' : 'Pipeline by status'}
          </p>
          <div className="space-y-1.5">
            {statusRows.map(row => (
              <div key={row.status} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-[11px] font-bold text-stone-600 truncate">{row.status}</span>
                <div className="flex-1 h-2.5 bg-stone-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[#978C21] rounded-full" style={{ width: `${row.pct}%` }} />
                </div>
                <span className="w-8 text-right text-[11px] font-black text-stone-700">{row.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-red-100 bg-red-50/50 rounded-xl p-4">
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-red-600">
            <AlertTriangle className="w-3.5 h-3.5" /> Needs follow-up
          </p>
          <p className="text-[10px] text-stone-400 mt-1">In this team, the people with the most overdue + due-today follow-ups.</p>
          {needsFollowUp.length === 0 ? (
            <p className="text-xs font-bold text-stone-500 mt-3">Nobody in this team is behind on follow-ups. 🎉</p>
          ) : (
            <div className="mt-3 space-y-2">
              {needsFollowUp.map(p => (
                <button key={p.userId} type="button" onClick={() => onSelect(p)} className="w-full flex items-center gap-2 text-left">
                  <span className="text-xs font-black text-stone-700 truncate">{p.name}</span>
                  <span className="text-[10px] font-bold text-stone-400">{p.employeeId}</span>
                  <span className="ml-auto shrink-0 text-[11px] font-bold text-red-600">{p.overdue} overdue · {p.dueToday} due today</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="border border-emerald-100 bg-emerald-50/50 rounded-xl p-4">
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-emerald-700">
            <Trophy className="w-3.5 h-3.5" /> Doing well — converted {doingWell.period}
          </p>
          <p className="text-[10px] text-stone-400 mt-1">
            {doingWell.period === 'this month'
              ? 'Top converters in this team this month — a good place to appreciate.'
              : 'Nobody in this team has converted this month yet, so here are the top converters of all time.'}
          </p>
          {doingWell.rows.length === 0 ? (
            <p className="text-xs font-bold text-stone-500 mt-3">No conversions in this team yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {doingWell.rows.map(p => (
                <button key={p.userId} type="button" onClick={() => onSelect(p)} className="w-full flex items-center gap-2 text-left">
                  <span className="text-xs font-black text-stone-700 truncate">{p.name}</span>
                  <span className="text-[10px] font-bold text-stone-400">{p.employeeId}</span>
                  <span className="ml-auto shrink-0 text-[11px] font-bold text-emerald-700">
                    {doingWell.period === 'this month' ? `${p.convertedThisMonth} this month · ` : ''}{p.convertedLeads} converted
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function TeamOverview() {
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [rootIds, setRootIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<TeamTreeResponse>('/api/team/tree');
      const list = Array.isArray(res?.people) ? res.people : [];
      const roots = Array.isArray(res?.rootIds) ? res.rootIds : [];
      setPeople(list);
      setRootIds(roots);
      // Open at the top of the caller's tree: roots expanded one level,
      // and the caller selected so their detail is the first thing seen.
      setExpanded(new Set(roots));
      const self = list.find(p => p.isSelf);
      setSelectedId(self ? self.userId : (roots[0] ?? null));
    } catch (err: any) {
      setError(err?.message || 'Failed to load the team overview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const byId = useMemo(() => new Map(people.map(p => [p.userId, p])), [people]);
  const byEmployeeId = useMemo(
    () => new Map(people.map(p => [String(p.employeeId).toUpperCase(), p])),
    [people]
  );
  const roots = useMemo(
    () => rootIds.map(id => byId.get(id)).filter(Boolean) as TeamPerson[],
    [rootIds, byId]
  );
  const selected = selectedId ? byId.get(selectedId) || null : null;

  const selectPerson = (p: TeamPerson) => {
    setSelectedId(p.userId);
    // Make sure the selected person is visible in the tree: expand the
    // ancestor chain above them.
    setExpanded(prev => {
      const next = new Set(prev);
      let cursor: TeamPerson | undefined = p;
      const seen = new Set<string>();
      while (cursor?.managerEmployeeId && !seen.has(cursor.userId)) {
        seen.add(cursor.userId);
        const mgr = byEmployeeId.get(cursor.managerEmployeeId.toUpperCase());
        if (!mgr) break;
        next.add(mgr.userId);
        cursor = mgr;
      }
      return next;
    });
  };

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const grouped = useMemo(() => TIERS.map(tier => ({
    ...tier,
    members: people
      .filter(p => p.tier === tier.key)
      .sort((a, b) => (b.openLeads + b.dueToday) - (a.openLeads + a.dueToday) || a.name.localeCompare(b.name)),
  })).filter(g => g.members.length > 0), [people]);

  // Totals from the roots' rollups: every person in scope is counted
  // exactly once (roots' subtrees partition the scope).
  const totals = useMemo(() => ({
    open: roots.reduce((s, p) => s + (p.subtree?.openLeads || 0), 0),
    converted: roots.reduce((s, p) => s + (p.subtree?.converted || 0), 0),
    due: roots.reduce((s, p) => s + (p.subtree?.dueToday || 0), 0),
    pipeline: roots.reduce((s, p) => s + (p.subtree?.pipelineValue || 0), 0),
  }), [roots]);

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
            <p className="text-[11px] font-bold text-[#978C21] flex items-center gap-1 mt-0.5">
              <Wallet className="w-3.5 h-3.5" /> Possible business (open pipeline): {money(totals.pipeline)}
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
        <>
          <section className="space-y-2">
            <div className="flex items-baseline gap-3">
              <h2 className="text-sm font-black uppercase tracking-widest text-stone-700">Team tree</h2>
              <span className="text-[10px] font-bold text-stone-400">Starts at the top of your scope — expand a team, tap a person for detail</span>
            </div>
            <div>
              {roots.map(root => (
                <Fragment key={root.userId}>
                  <TreeNode
                    person={root}
                    byId={byId}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggle}
                    selectedId={selectedId}
                    onSelect={selectPerson}
                  />
                </Fragment>
              ))}
            </div>
          </section>

          {selected && (
            <PersonDetail person={selected} byId={byId} byEmployeeId={byEmployeeId} onSelect={selectPerson} />
          )}

          {grouped.map(group => (
            <section key={group.key} className="space-y-3">
              <div className="flex items-baseline gap-3">
                <h2 className="text-sm font-black uppercase tracking-widest text-stone-700">{group.title}</h2>
                <span className="text-[10px] font-bold text-stone-400">{group.members.length} · {group.blurb}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.members.map(person => (
                  <div key={person.userId}>
                    <PersonCard person={person} onSelect={selectPerson} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
