import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  CalendarPlus,
  FolderOpen,
  Layers,
  TrendingUp,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { HOME_KPI_ORDER, KPI_META, type KpiKey } from '../utils/kpiDrilldown';

/**
 * HomeKpiRow — the ONE KPI row both home pages render (mirror rule,
 * owner 2026-11-18)
 * ------------------------------------------------------------------
 * My Work (DailyWorkbench) and Team Home used to show the same seven
 * KPIs in two different presentations — a large "My numbers" strip
 * on one, compact cards on the other. Both pages now render THIS
 * component: same seven cards, same order (HOME_KPI_ORDER), same
 * card look, same drill-down links. Only the VALUES differ (own
 * numbers vs team totals) and the link target: My Work passes
 * personParam="self" so every card opens the caller's own leads
 * (/team/kpi/:kpi?person=self); Team Home passes none, so the
 * cards open the member-wise team drill-down (/team/kpi/:kpi).
 * All seven cards always render — a 0 is shown, never hidden
 * (never-empty rule).
 */

export type HomeKpiValues = Record<
  'totalLeads' | 'todayCollection' | 'open' | 'dueToday' | 'overdue' | 'noAction' | 'converted',
  number
>;

type HomeKpiKey = (typeof HOME_KPI_ORDER)[number];

const CARD_STYLE: Record<HomeKpiKey, { icon: typeof FolderOpen; tone: string; iconTone: string }> = {
  totalLeads: { icon: Layers, tone: 'bg-stone-50', iconTone: 'text-stone-400' },
  todayCollection: { icon: CalendarPlus, tone: 'bg-sky-50', iconTone: 'text-sky-500' },
  open: { icon: FolderOpen, tone: 'bg-stone-50', iconTone: 'text-stone-400' },
  dueToday: { icon: CalendarClock, tone: 'bg-amber-50', iconTone: 'text-amber-500' },
  overdue: { icon: AlertTriangle, tone: 'bg-red-50', iconTone: 'text-red-500' },
  noAction: { icon: BellRing, tone: 'bg-red-50', iconTone: 'text-red-500' },
  converted: { icon: TrendingUp, tone: 'bg-emerald-50', iconTone: 'text-emerald-500' },
};

function HomeKpiCard({
  kpi,
  value,
  to,
  own,
}: {
  kpi: HomeKpiKey;
  value: number;
  to: string;
  own: boolean;
}) {
  const { icon: Icon, tone, iconTone } = CARD_STYLE[kpi];
  const label = KPI_META[kpi as KpiKey].label;
  return (
    <Link
      to={to}
      className={cn('rounded-2xl py-3 px-4 text-center block hover:ring-2 hover:ring-[#978C21]/40 transition-shadow', tone)}
      aria-label={`${label}: ${value} — ${own ? 'view my leads' : 'view details'}`}
    >
      <p className="text-xl font-black text-stone-800 flex items-center justify-center gap-1.5">
        <Icon className={cn('w-4 h-4', iconTone)} />
        {value}
      </p>
      <p className="text-[8px] font-black uppercase tracking-widest text-stone-400 mt-0.5">{label}</p>
    </Link>
  );
}

export default function HomeKpiRow({
  values,
  personParam,
}: {
  values: HomeKpiValues;
  /** 'self' on My Work (own leads); omitted on Team Home (team drill-down). */
  personParam?: string;
}) {
  const suffix = personParam ? `?person=${encodeURIComponent(personParam)}` : '';
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {HOME_KPI_ORDER.map(kpi => (
        <Fragment key={kpi}>
          <HomeKpiCard
            kpi={kpi}
            value={values[kpi]}
            to={`/team/kpi/${kpi}${suffix}`}
            own={personParam === 'self'}
          />
        </Fragment>
      ))}
    </div>
  );
}
