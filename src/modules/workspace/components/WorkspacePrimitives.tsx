import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { FollowUpQueueItem } from '../../leads/services/leadService';
import { formatDhakaShort, type DayBucket, type PipelineSegment } from '../utils/workspaceData';

/**
 * WorkspacePrimitives — shared presentational pieces for the three
 * role homes (role-dashboard redesign, Phase 1, 2026-11-17).
 * ------------------------------------------------------------------
 * The sample prototype's visual language (olive / orange / beige,
 * 15px radius, soft card shadow) as small components. All of them
 * are pure renderers: data in, markup out, no fetching — the
 * containers own every read.
 */

export function PageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  actions?: ReactNode;
}) {
  return (
    <div className="lf-page-head">
      <div className="min-w-0">
        <p className="lf-eyebrow">{eyebrow}</p>
        <h1 className="lf-page-title">{title}</h1>
        <p className="lf-page-sub">{sub}</p>
      </div>
      {actions && <div className="lf-page-actions">{actions}</div>}
    </div>
  );
}

export type KpiTone = 'default' | 'orange' | 'red' | 'green' | 'blue';

export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
  to,
  foot,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: KpiTone;
  /** Drill-down target; absent the card is a plain summary (no link). */
  to?: string;
  foot?: string;
}) {
  const body = (
    <>
      <p className="lf-kpi-value">
        <Icon className="lf-kpi-icon" />
        {value}
      </p>
      <p className="lf-kpi-label">{label}</p>
      {foot && <p className="lf-kpi-foot">{foot}</p>}
    </>
  );
  const className = cn('lf-kpi-card', `lf-kpi-card--${tone}`);
  if (to) {
    return (
      <Link to={to} className={className} aria-label={`${label}: ${value} — view details`}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

export function WorkspaceCard({
  title,
  sub,
  action,
  children,
  foot,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
  foot?: string;
}) {
  return (
    <section className="lf-card">
      <div className="lf-card-head">
        <div className="min-w-0">
          <h2 className="lf-card-title">{title}</h2>
          {sub && <p className="lf-card-sub">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
      {foot && <p className="lf-card-foot">{foot}</p>}
    </section>
  );
}

/** Seven vertical bars — one per day, all seven always rendered (never-empty). */
export function BarChart({ days }: { days: DayBucket[] }) {
  const max = Math.max(1, ...days.map(d => d.count));
  return (
    <div className="lf-bar-chart" role="img" aria-label="Follow-ups due over the next 7 days">
      {days.map(day => (
        <div key={day.dayKey} className="lf-bar-col">
          <span className="lf-bar-value">{day.count > 0 ? day.count : ''}</span>
          <div
            className={cn('lf-bar', day.isToday && 'is-today')}
            style={{ height: `${day.count === 0 ? 4 : Math.max(10, Math.round((day.count / max) * 72))}px` }}
          />
          <span className={cn('lf-bar-label', day.isToday && 'is-today')}>{day.label}</span>
        </div>
      ))}
    </div>
  );
}

const ACTIVE_PALETTE = ['#707817', '#4478b5', '#ED6B18', '#4f5710', '#978C21', '#7a8440', '#5b7fa6', '#c96a2e'];

/** Segmented pipeline bar + a legend that lists every status, including 0s. */
export function PipelineBar({ segments }: { segments: PipelineSegment[] }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  let activeIdx = 0;
  const colourFor = (segment: PipelineSegment): string => {
    if (segment.won) return '#2e8054';
    if (segment.lost) return '#c64d42';
    if (segment.terminal) return '#b9bab0';
    const colour = ACTIVE_PALETTE[activeIdx % ACTIVE_PALETTE.length];
    activeIdx += 1;
    return colour;
  };
  const coloured = segments.map(segment => ({ ...segment, colour: colourFor(segment) }));
  return (
    <div>
      <div className="lf-pipeline-bar" aria-label={`Pipeline across ${segments.length} stages, ${total} leads in total`}>
        {total === 0 ? (
          <div className="lf-pipeline-empty" />
        ) : (
          coloured
            .filter(s => s.count > 0)
            .map(s => (
              <div
                key={s.name}
                className="lf-pipeline-segment"
                style={{ width: `${(s.count / total) * 100}%`, background: s.colour }}
                title={`${s.name}: ${s.count}`}
              />
            ))
        )}
      </div>
      <ul className="lf-pipeline-legend">
        {coloured.map(s => (
          <li key={s.name} className="lf-pipeline-legend-item">
            <span className="lf-pipeline-dot" style={{ background: s.colour }} />
            <span className="lf-pipeline-name">{s.name}</span>
            <span className="lf-pipeline-count">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function dueLabel(item: FollowUpQueueItem): string {
  if (item.dueState === 'overdue') {
    return typeof item.overdueDays === 'number' && item.overdueDays > 0
      ? `Overdue ${item.overdueDays}d`
      : 'Overdue';
  }
  if (item.dueState === 'today') return 'Due today';
  return formatDhakaShort(item.nextFollowUpAt);
}

/** One follow-up row, linking to the lead's workspace (Lead360). */
export function FollowUpRow({ item }: { item: FollowUpQueueItem }) {
  const name = item.prospectName || item.customerName || 'Unnamed lead';
  return (
    <Link to={`/leads/${item.id}`} className="lf-list-row">
      <span className="lf-list-main">
        <strong className="lf-list-name">{name}</strong>
        <span className="lf-list-sub">{item.currentStatus}</span>
      </span>
      <span className={cn('lf-pill', item.dueState === 'overdue' && 'lf-pill--red', item.dueState === 'today' && 'lf-pill--orange')}>
        {dueLabel(item)}
      </span>
    </Link>
  );
}

/** One team-member row (name + employee ID + designation, right-side chips). */
export function MemberRow({
  name,
  employeeId,
  designation,
  isSelf,
  to,
  children,
}: {
  name: string;
  employeeId: string;
  designation?: string | null;
  isSelf?: boolean;
  to: string;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className="lf-list-row">
      <span className="lf-list-main">
        <strong className="lf-list-name">
          {name}
          {isSelf && <span className="lf-you-badge">You</span>}
        </strong>
        <span className="lf-list-sub">{[employeeId, designation].filter(Boolean).join(' · ')}</span>
      </span>
      {children && <span className="lf-list-side">{children}</span>}
    </Link>
  );
}

/** The designed empty state — a message, never a blank screen. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="lf-empty">{children}</div>;
}

/** Loading placeholder for a home (skeletons, never false 0s). */
export function HomeSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-4" role="status" aria-label={label}>
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
      <div className="h-28 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}
