import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DayBucket } from '../utils/enterpriseData';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { ENTERPRISE_ROLE_LABELS } from '../../../layouts/enterpriseRole';
import { enterpriseHeadingForPath } from '../../../layouts/enterpriseNav';

/**
 * EnterprisePrimitives — the Enterprise Preview sample's visual
 * components, rebuilt as React (2026-11-19).
 * ------------------------------------------------------------------
 * Every class here is an `.ep-*` class from index.css, ported from
 * the sample's stylesheet (same tokens, radii, spacing, breakpoints).
 * Nothing here fetches or invents data: each primitive only renders
 * what its caller passes.
 */

/**
 * The sample-aligned heading for a sidebar page (fix round,
 * 2026-11-19): eyebrow "{Role} workspace", H1 the role's own nav
 * label for the route, subtitle the sample's description for that
 * label — so every inner page speaks the sample's words. Pages
 * pass their real action buttons as `actions`; pages with no
 * actions pass none (no fake Filters button).
 */
export function EnterprisePageHeader(props: {
  path: string;
  actions?: React.ReactNode;
}) {
  // The DISPLAY role, so a super admin previewing another role
  // sees that role's heading on inner pages too (outside the
  // provider this is just the caller's own derived role).
  const { role } = useEnterpriseDisplayRole();
  const heading = enterpriseHeadingForPath(role, props.path);
  return (
    <OverviewHeading
      eyebrow={`${ENTERPRISE_ROLE_LABELS[role]} workspace`}
      title={heading.title}
      sub={heading.sub}
      actions={props.actions}
    />
  );
}

export function OverviewHeading(props: {
  eyebrow: string;
  title: string;
  sub: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ep-heading">
      <div>
        <div className="ep-eyebrow">{props.eyebrow}</div>
        <h1>{props.title}</h1>
        <p>{props.sub}</p>
      </div>
      {props.actions && <div className="ep-actions">{props.actions}</div>}
    </div>
  );
}

export function KpiCard(props: {
  label: string;
  value: string | number;
  foot: string;
  tone?: 'green' | 'orange' | 'red';
  to?: string;
}) {
  const body = (
    <>
      <div className="ep-metric-label">{props.label}</div>
      <div className="ep-metric">{props.value}</div>
      <div className={`ep-trend${props.tone === 'orange' || props.tone === 'red' ? ' warn' : ''}`}>
        {props.foot}
      </div>
    </>
  );
  if (props.to) {
    return (
      <Link to={props.to} className="ep-card ep-kpi-link" aria-label={`${props.label}: ${props.value}`}>
        {body}
      </Link>
    );
  }
  return <div className="ep-card">{body}</div>;
}

export function ChartCard(props: {
  title: string;
  sub: string;
  days: DayBucket[];
  foot?: string;
  loading?: boolean;
}) {
  const max = Math.max(1, ...props.days.map(d => d.count));
  return (
    <div className="ep-card">
      <div className="ep-cardhead">
        <div>
          <h3>{props.title}</h3>
          <div className="ep-muted">{props.sub}</div>
        </div>
        <span className="ep-pill">7 days</span>
      </div>
      {props.loading ? (
        <div className="ep-chart-loading" role="status" aria-label="Loading chart">
          <div className="ep-skeleton-bar" />
          <div className="ep-skeleton-bar" />
          <div className="ep-skeleton-bar" />
        </div>
      ) : (
        <>
          <div className="ep-chart" role="img" aria-label={`${props.title}: ${props.days.map(d => `${d.label} ${d.count}`).join(', ')}`}>
            {props.days.map(day => (
              <div className="ep-barwrap" key={day.dayKey}>
                <div
                  className="ep-bar"
                  style={{ height: `${Math.max(day.count > 0 ? 8 : 2, Math.round((day.count / max) * 100))}%` }}
                  title={`${day.label}: ${day.count}`}
                />
              </div>
            ))}
          </div>
          <div className="ep-chartlabels">
            {props.days.map(day => (
              <span key={day.dayKey}>{day.isToday ? 'Today' : day.label}</span>
            ))}
          </div>
        </>
      )}
      {props.foot && <div className="ep-cardfoot">{props.foot}</div>}
    </div>
  );
}

export interface AttentionRow {
  title: string;
  sub: string;
  actionLabel: string;
  to: string;
  tone?: 'orange' | 'red' | '';
}

export function AttentionCard(props: {
  title: string;
  sub: string;
  rows: AttentionRow[];
  emptyText: string;
}) {
  return (
    <div className="ep-card">
      <div className="ep-cardhead">
        <h3>{props.title}</h3>
        <span className="ep-muted">{props.sub}</span>
      </div>
      {props.rows.length === 0 ? (
        <p className="ep-empty">{props.emptyText}</p>
      ) : (
        <div className="ep-list">
          {props.rows.map(row => (
            <div className="ep-listrow" key={`${row.title}-${row.sub}`}>
              <div>
                <div className="ep-rowtitle">{row.title}</div>
                <div className="ep-rowsub">{row.sub}</div>
              </div>
              <Link to={row.to} className={`ep-pill${row.tone ? ` ${row.tone}` : ''}`}>
                {row.actionLabel}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface TableRow {
  key: string;
  /** Lowercase-able text the search box filters on. */
  searchText: string;
  cells: React.ReactNode[];
}

export function DataTableCard(props: {
  title: string;
  sub: string;
  headers: string[];
  rows: TableRow[];
  emptyText: string;
  searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.rows;
    return props.rows.filter(row => row.searchText.toLowerCase().includes(q));
  }, [props.rows, query]);

  return (
    <div className="ep-card ep-tablecard">
      <div className="ep-tablehead">
        <div>
          <h3>{props.title}</h3>
          <div className="ep-muted">{props.sub}</div>
        </div>
        <input
          className="ep-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={props.searchPlaceholder ?? 'Search this list...'}
          aria-label="Search this list"
        />
      </div>
      <div className="ep-tablewrap">
        <table>
          <thead>
            <tr>
              {props.headers.map(h => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(row => (
              <tr key={row.key}>
                {row.cells.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={props.headers.length} className="ep-td-empty">
                  {query.trim() ? `No rows match "${query.trim()}".` : props.emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PersonCell(props: { name: string; sub?: string; to?: string }) {
  const initials = props.name
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const body = (
    <>
      <span className="ep-miniavatar" aria-hidden="true">
        {initials || '?'}
      </span>
      <span>
        <strong>{props.name}</strong>
        {props.sub && <span className="ep-cellsub">{props.sub}</span>}
      </span>
    </>
  );
  if (props.to) {
    return (
      <Link to={props.to} className="ep-person">
        {body}
      </Link>
    );
  }
  return <span className="ep-person">{body}</span>;
}

export function HomeSkeleton(props: { label: string }) {
  return (
    <div role="status" aria-label={props.label}>
      <div className="ep-skeleton-line ep-skeleton-line--title" />
      <div className="ep-grid">
        <div className="ep-card ep-skeleton-card" />
        <div className="ep-card ep-skeleton-card" />
        <div className="ep-card ep-skeleton-card" />
        <div className="ep-card ep-skeleton-card" />
      </div>
      <div className="ep-layout2">
        <div className="ep-card ep-skeleton-card ep-skeleton-card--tall" />
        <div className="ep-card ep-skeleton-card ep-skeleton-card--tall" />
      </div>
    </div>
  );
}
