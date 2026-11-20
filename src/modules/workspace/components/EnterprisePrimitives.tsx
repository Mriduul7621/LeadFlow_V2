import React from 'react';
import { Link } from 'react-router-dom';
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
 *
 * Removed 2026-11-20 (Team Lead / Manager / Admin workspace):
 * ChartCard, AttentionCard (+ AttentionRow), DataTableCard
 * (+ TableRow) and PersonCell — their only callers were the three
 * old role homes, replaced by the shared TeamOverviewHome, which
 * renders its own lists and charts directly. Nothing renders them
 * anymore.
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
