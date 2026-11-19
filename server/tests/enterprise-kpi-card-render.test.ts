/**
 * enterprise-kpi-card-render.test.ts
 * ------------------------------------------------------------------
 * Render tests for the enterprise KpiCard primitive
 * (src/modules/workspace/components/EnterprisePrimitives.tsx),
 * SSR style like the TL+ drill-down tests (renderToStaticMarkup +
 * MemoryRouter). The four role homes render every KPI through
 * this one primitive, so its link / aria-label / tone behaviour
 * is pinned here once.
 *
 * Real props (note: the brief's `trend`/`warn` names do not exist
 * — the component takes `foot` for the trend line and `tone` for
 * the alert colour):
 *   { label, value, foot, tone?: 'green' | 'orange' | 'red', to?: string }
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { KpiCard } from '../../src/modules/workspace/components/EnterprisePrimitives';
import { kpiDrilldownUrl, KPI_KEYS } from '../../src/modules/team/utils/kpiDrilldown';

const renderCard = (props: {
  label: string;
  value: string | number;
  foot: string;
  tone?: 'green' | 'orange' | 'red';
  to?: string;
}) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(KpiCard, props))
  );

describe('KpiCard — linked card', () => {
  it('with `to` it renders a link to that href with aria-label "label: value"', () => {
    const html = renderCard({ label: 'Total Lead', value: 12, foot: '7 people in scope', to: '/team/kpi/totalLeads' });
    assert.ok(html.includes('href="/team/kpi/totalLeads"'), 'the card links to the drill-down');
    assert.ok(html.includes('aria-label="Total Lead: 12"'), 'the aria-label is "label: value"');
    assert.ok(html.includes('ep-kpi-link'), 'the linked card carries the link class');
    assert.ok(html.includes('Total Lead'), 'the label renders');
    assert.ok(html.includes('>12<'), 'the value renders');
    assert.ok(html.includes('7 people in scope'), 'the foot line renders');
  });

  it('links every KPI drill-down URL, including the agent person=self form', () => {
    for (const kpi of KPI_KEYS) {
      const html = renderCard({ label: 'KPI', value: 1, foot: 'test', to: kpiDrilldownUrl(kpi) });
      assert.ok(html.includes(`href="/team/kpi/${kpi}"`), `the ${kpi} URL renders as the href`);
    }
    const self = renderCard({ label: 'My leads', value: 5, foot: 'test', to: kpiDrilldownUrl('totalLeads', 'self') });
    assert.ok(self.includes('href="/team/kpi/totalLeads?person=self"'), 'the self drill-down keeps its person param');
  });

  it('renders a string value verbatim in the metric and the aria-label', () => {
    const html = renderCard({ label: 'Collected NCP', value: '৳1,234,567', foot: 'test', to: '/ncp-progress' });
    assert.ok(html.includes('৳1,234,567'), 'the formatted value renders');
    assert.ok(html.includes('aria-label="Collected NCP: ৳1,234,567"'), 'the aria-label carries the formatted value');
  });
});

describe('KpiCard — plain card', () => {
  it('without `to` it renders a plain card with no link', () => {
    const html = renderCard({ label: 'Conversion', value: '18.6%', foot: '12 of 64 leads converted' });
    assert.ok(!html.includes('<a '), 'no anchor is rendered without `to`');
    assert.ok(!html.includes('aria-label='), 'no link aria-label without `to`');
    assert.ok(html.includes('class="ep-card"'), 'the plain card keeps the card class');
    assert.ok(!html.includes('ep-kpi-link'), 'no link class without `to`');
    assert.ok(html.includes('Conversion') && html.includes('18.6%'), 'label and value still render');
  });
});

describe('KpiCard — tone', () => {
  it('tone="orange" applies the warn trend class', () => {
    const html = renderCard({ label: 'Overdue', value: 3, foot: 'test', tone: 'orange', to: '/team/kpi/overdue' });
    assert.ok(html.includes('class="ep-trend warn"'), 'orange tone warns');
  });

  it('tone="red" applies the warn trend class', () => {
    const html = renderCard({ label: 'No Action Alert', value: 4, foot: 'test', tone: 'red', to: '/team/kpi/noAction' });
    assert.ok(html.includes('class="ep-trend warn"'), 'red tone warns');
  });

  it('no tone (or green) renders the plain trend class', () => {
    const plain = renderCard({ label: 'Total Lead', value: 12, foot: 'test', to: '/team/kpi/totalLeads' });
    assert.ok(plain.includes('class="ep-trend"'), 'no tone means no warn class');
    assert.ok(!plain.includes('warn'), 'no warn anywhere without a tone');
    const green = renderCard({ label: 'Converted', value: 2, foot: 'test', tone: 'green', to: '/team/kpi/converted' });
    assert.ok(green.includes('class="ep-trend"'), 'green is not a warn tone');
    assert.ok(!green.includes('warn'), 'no warn anywhere with green');
  });
});
