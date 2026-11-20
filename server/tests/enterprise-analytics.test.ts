/**
 * enterprise-analytics.test.ts
 * ------------------------------------------------------------------
 * Fix round 1 (2026-11-19): Mahadi's ask — "Analytics page E
 * analytic type E data thakte Hobe." /execution-intelligence
 * imported recharts but rendered NO chart — KPI buttons and a
 * list only. It now leads with analytic content built from the
 * real data the page already loads: a leads-over-time area chart,
 * a stage-distribution pie, an NCP-by-area bar comparison, and
 * rate breakdowns — with honest empty states when a period has
 * no data. Real data only: the server trendData is [] and nothing
 * is invented to fill a chart.
 *
 * The same round fixed a real-data bug in NCP Progress: its chart
 * interpolated the period totals at 25/55/80/100% — invented
 * numbers. The buckets now sum the leads that actually fall in
 * each quarter of the selected period, cumulatively.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterpriseHeadingForPath } from '../../src/layouts/enterpriseNav';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented substitutions don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const analytics = stripComments(read('src/modules/dashboard/pages/ExecutionIntelligence.tsx'));

describe('Analytics — charts are the primary content, from real data', () => {
  it('renders three real charts: leads over time, stage mix, NCP by area', () => {
    assert.ok(analytics.includes('<AreaChart data={trendPoints}'), 'leads-over-time area chart');
    assert.ok(analytics.includes('data={stageBreakdown}'), 'stage-distribution pie data');
    assert.ok(analytics.includes('<PieChart>'), 'stage-distribution pie chart');
    assert.ok(analytics.includes('<BarChart data={ncpByArea}'), 'NCP-by-area bar comparison');
  });

  it('every chart is fed by a memo over the real loaded leads', () => {
    for (const memo of ['stageBreakdown', 'trendPoints', 'ncpByArea', 'filteredLeads', 'rates']) {
      assert.ok(analytics.includes(`const ${memo} = useMemo`), `${memo} is computed from the page data`);
    }
    assert.ok(analytics.includes('leads.filter'), 'the memos filter the real lead list');
  });

  it('never fabricates trend data — the server trendData is [] and unused', () => {
    assert.ok(!analytics.includes('trendData'), 'no trendData anywhere on the page');
    // The trend buckets come from the leads' own timestamps.
    assert.ok(analytics.includes('new Date(l.timestamp)'), 'trend buckets use real lead timestamps');
  });

  it('empty periods show an honest empty state instead of a chart', () => {
    for (const memo of ['trendPoints', 'stageBreakdown', 'ncpByArea']) {
      assert.ok(analytics.includes(`{${memo}.length === 0 ? (`), `the ${memo} chart guards its empty period`);
    }
    assert.ok(analytics.includes('No leads in this period'), 'the empty copy says so plainly');
  });

  it('the rates card shows real counts, never a bare percent', () => {
    assert.ok(analytics.includes('Contact rate'), 'contact rate is shown');
    assert.ok(analytics.includes('Conversion rate'), 'conversion rate is shown');
    assert.ok(analytics.includes('Collection rate'), 'collection rate is shown');
    assert.ok(
      analytics.includes('Rates are computed from the {rates.total} lead'),
      'the denominator is named in the card foot',
    );
  });

  it('keeps the sample heading and the drill-down (the list is secondary now)', () => {
    assert.ok(analytics.includes('path="/execution-intelligence"'), 'the sample heading via EnterprisePageHeader');
    assert.ok(analytics.includes('setActivePopup(stat.id)'), 'KPI drill-down still works');
  });
});

describe('Analytics — the role-aware titles read as analytics', () => {
  it('admin sees "Analytics", manager "Performance", team lead "Team Performance"', () => {
    assert.equal(enterpriseHeadingForPath('admin', '/execution-intelligence').title, 'Analytics');
    assert.equal(enterpriseHeadingForPath('manager', '/execution-intelligence').title, 'Performance');
    assert.equal(enterpriseHeadingForPath('teamLead', '/execution-intelligence').title, 'Team Performance');
    assert.equal(
      enterpriseHeadingForPath('admin', '/execution-intelligence').sub,
      'Explore performance indicators and authorized records.',
      "the sample's description, verbatim",
    );
  });
});

describe('NCP Progress — quartile buckets from real leads, no interpolation', () => {
  const ncp = stripComments(read('src/modules/dashboard/pages/NcpProgress.tsx'));

  it('the chart data sums the leads in each quarter of the period', () => {
    assert.ok(ncp.includes('const ncpTrackingData = useMemo'), 'the chart data is a memo');
    assert.ok(ncp.includes('const inQuartile = leads.filter'), 'each bucket filters the real leads');
    assert.ok(ncp.includes('cumCollected += inQuartile.reduce'), 'collected is cumulative over real leads');
    assert.ok(ncp.includes('cumProjected += inQuartile.reduce'), 'projected is cumulative over real leads');
    assert.ok(ncp.includes('getPeriodRange()'), 'the quarters come from the selected period');
  });

  it('no interpolated percentages survive in the chart data', () => {
    const memo = ncp.slice(ncp.indexOf('const ncpTrackingData = useMemo'));
    const body = memo.slice(0, memo.indexOf('}, [leads, period, selectedDate, customDates]);'));
    for (const invented of ['0.25', '0.55', '0.8', '* 0.25', '* 0.55']) {
      assert.ok(!body.includes(invented), `the old ${invented} interpolation is gone`);
    }
  });

  it('the chart still renders the cumulative series', () => {
    assert.ok(ncp.includes('data={ncpTrackingData}'), 'the chart reads the quartile memo');
    assert.ok(ncp.includes('Collected vs projected potential, cumulative through the period'));
  });
});
