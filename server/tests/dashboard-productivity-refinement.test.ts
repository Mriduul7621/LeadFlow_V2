/**
 * PR #24 productivity refinement: real React rendering for the dashboard's
 * presentation components, plus narrow source/compile guards for their wiring.
 * Uses the existing node:test + React stack; no browser, DB or extra requests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';
import {
  ExecutiveSnapshot,
  TodayTomorrowPanel,
  resolveRange,
} from '../../src/modules/dashboard/pages/Dashboard';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService';
import type { ScheduledActivity } from '../../src/modules/scheduledActivities/services/scheduledActivityService';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DASHBOARD_PATH = path.join(ROOT, 'src/modules/dashboard/pages/Dashboard.tsx');
const source = fs.readFileSync(DASHBOARD_PATH, 'utf8');
const main = source.slice(source.indexOf('export default function Dashboard()'));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
}

function followUp(id: string, nextFollowUpAt: string): FollowUpQueueItem {
  return {
    id,
    prospectName: `Queue ${id}`,
    mobile: '01700000000',
    assignedTo: 'EMP001',
    currentStatus: 'Interested',
    nextFollowUpAt,
    dueState: 'today',
  };
}

function scheduled(id: string, activityType: ScheduledActivity['activityType'], scheduledAt: string): ScheduledActivity {
  return {
    id,
    leadId: `lead/${id}`,
    leadCustomerName: `Scheduled ${id}`,
    activityType,
    scheduledAt,
    title: `Agenda ${id}`,
    status: 'scheduled',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

const emptyDays = {
  todayFollowUps: [] as FollowUpQueueItem[],
  tomorrowFollowUps: [] as FollowUpQueueItem[],
  todayScheduled: [] as ScheduledActivity[],
  tomorrowScheduled: [] as ScheduledActivity[],
  dailyLoading: false,
};
const populatedDays = {
  ...emptyDays,
  todayFollowUps: [followUp('today-queue', '2026-09-11T11:00:00+06:00')],
  todayScheduled: [
    scheduled('today-task', 'task', '2026-09-11T14:00:00+06:00'),
    scheduled('today-follow-up', 'follow_up', '2026-09-11T09:00:00+06:00'),
    // Different ISO offsets must still sort by the instant, not by the string.
    scheduled('today-meeting', 'meeting', '2026-09-11T04:00:00Z'),
    scheduled('today-call-late', 'call', '2026-09-11T12:00:00+06:00'),
    scheduled('today-call-early', 'call', '2026-09-11T08:00:00+06:00'),
  ],
  tomorrowFollowUps: [
    followUp('tomorrow-queue-late', '2026-09-12T14:00:00+06:00'),
    followUp('tomorrow-queue-early', '2026-09-12T10:00:00+06:00'),
  ],
  tomorrowScheduled: [
    scheduled('tomorrow-task-late', 'task', '2026-09-12T13:00:00+06:00'),
    scheduled('tomorrow-meeting-late', 'meeting', '2026-09-12T11:00:00+06:00'),
    scheduled('tomorrow-follow-up', 'follow_up', '2026-09-12T15:00:00+06:00'),
    scheduled('tomorrow-call', 'call', '2026-09-12T12:00:00+06:00'),
    scheduled('tomorrow-task-early', 'task', '2026-09-12T09:00:00+06:00'),
    scheduled('tomorrow-meeting-early', 'meeting', '2026-09-12T08:00:00+06:00'),
  ],
};

function dayMarkup(html: string, day: 'Today' | 'Tomorrow'): string {
  const match = html.match(new RegExp(`<section\\b[^>]*aria-label="${day}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(match, `${day} section must be rendered`);
  return match[1];
}

function counts(html: string): Record<string, number> {
  const summary = html.match(/<dl\b[^>]*>([\s\S]*?)<\/dl>/);
  assert.ok(summary, 'each loaded day needs a type summary');
  return Object.fromEntries([...summary[1].matchAll(/<dt\b[^>]*>([^<]+)<\/dt>\s*<dd\b[^>]*>([\d,]+)<\/dd>/g)]
    .map((match) => [match[1], Number(match[2].replaceAll(',', ''))]));
}

function rows(html: string): string[] {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
}

const typeLabels = { call: 'Call', meeting: 'Meeting', follow_up: 'Follow-up', task: 'Task' };
const snapshotProps = {
  totalLeads: 100,
  conversionRate: '12.0%',
  collectedNCP: '৳ 1,000',
  projectedNCP: '৳ 2,000',
  activeLeads: 83,
  pipelineLocked: 17,
  overdueFollowUps: 9,
};

describe('Dashboard productivity refinement — PR #24 blockers', () => {
  it('History is explicitly imported from lucide-react and renders as an icon, not the DOM History global', () => {
    const ast = ts.createSourceFile(DASHBOARD_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const iconImport = ast.statements.find((node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'lucide-react');
    const bindings = iconImport?.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    assert.ok(bindings.elements.some((item) => item.name.text === 'History'));
    // The Follow-up Discipline card left Home, so the icon guard now runs on
    // the panel that still renders every activity icon (History included).
    const panel = render(React.createElement(TodayTomorrowPanel, populatedDays));
    assert.match(panel, /lucide-history/);
    assert.match(panel, /lucide-phone/);
    assert.match(panel, /lucide-video/);
    assert.match(panel, /lucide-clipboard-check/);
  });

  it('Dashboard.tsx compiles without unresolved identifiers or unused imports, helpers and local computations', () => {
    const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const program = ts.createProgram([DASHBOARD_PATH], {
      ...parsed.options,
      noUnusedLocals: true,
      noUnusedParameters: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((item) => !item.file || path.resolve(item.file.fileName) === DASHBOARD_PATH)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
    assert.deepEqual(diagnostics, []);
  });

  it('Pipeline Locked receives metrics.pipelineLocked and never derives its subtext from active leads', () => {
    assert.match(main, /pipelineLocked=\{metrics\?\.pipelineLocked\s*\?\?\s*0\}/);
    for (const [activeLeads, pipelineLocked] of [[83, 17], [0, 17], [83, 0]]) {
      const html = render(React.createElement(ExecutiveSnapshot, { ...snapshotProps, activeLeads, pipelineLocked }));
      assert.match(html, new RegExp(`>${pipelineLocked} Pipeline Locked<`));
      assert.doesNotMatch(html, new RegExp(`>${activeLeads} Pipeline Locked<`));
    }
  });

  for (const day of ['Today', 'Tomorrow'] as const) {
    it(`${day} shows Calls, Meetings, Follow-ups and Tasks from its own loaded arrays`, () => {
      const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, populatedDays)), day);
      const expected = day === 'Today'
        ? { Calls: 2, Meetings: 1, 'Follow-ups': 2, Tasks: 1 }
        : { Calls: 1, Meetings: 2, 'Follow-ups': 3, Tasks: 2 };
      assert.deepEqual(counts(html), expected);
      const total = Object.values(expected).reduce((sum, value) => sum + value, 0);
      assert.equal(rows(html).length, total);
      assert.ok(html.includes(`aria-label="${total} activities"`));
    });

    it(`${day} renders every scheduled activity once in a single ordered list, preserving links and badges`, () => {
      const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, populatedDays)), day);
      const activities = day === 'Today' ? populatedDays.todayScheduled : populatedDays.tomorrowScheduled;
      const queue = day === 'Today' ? populatedDays.todayFollowUps : populatedDays.tomorrowFollowUps;
      assert.equal((html.match(/<ol\b/g) || []).length, 1);
      assert.doesNotMatch(html, /Scheduled Activities/);
      for (const item of activities) {
        const matching = rows(html).filter((row) => row.includes(`href="/leads/${encodeURIComponent(item.leadId)}"`));
        assert.equal(matching.length, 1, `${item.id} must appear exactly once`);
        assert.ok(matching[0].includes(item.leadCustomerName!));
        assert.ok(matching[0].includes(item.title!));
        assert.match(matching[0], new RegExp(`<span\\b[^>]*>${typeLabels[item.activityType]}</span>`));
      }
      for (const item of queue) {
        const matching = rows(html).filter((row) => row.includes(`href="/leads/${encodeURIComponent(item.id)}"`));
        assert.equal(matching.length, 1);
        assert.match(matching[0], /<span\b[^>]*>Follow-up<\/span>/);
        assert.match(matching[0], /<span\b[^>]*>Interested<\/span>/);
      }
    });

    it(`${day} interleaves follow-ups and scheduled work by their existing due/scheduled timestamps`, () => {
      const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, populatedDays)), day);
      const names = rows(html).map((row) => row.match(/<p\b[^>]*>([^<]+)<\/p>/)![1]);
      assert.deepEqual(names, day === 'Today' ? [
        'Scheduled today-call-early', 'Scheduled today-follow-up', 'Scheduled today-meeting',
        'Queue today-queue', 'Scheduled today-call-late', 'Scheduled today-task',
      ] : [
        'Scheduled tomorrow-meeting-early', 'Scheduled tomorrow-task-early', 'Queue tomorrow-queue-early',
        'Scheduled tomorrow-meeting-late', 'Scheduled tomorrow-call', 'Scheduled tomorrow-task-late',
        'Queue tomorrow-queue-late', 'Scheduled tomorrow-follow-up',
      ]);
      assert.match(rows(html)[0], /08:00 am/);
    });

    it(`${day} removes exact repeated source IDs before counting or rendering`, () => {
      const queue = followUp('queue', '2026-09-11T11:00:00+06:00');
      const work = Object.keys(typeLabels).map((type) => scheduled(type, type as ScheduledActivity['activityType'], queue.nextFollowUpAt));
      const inputs = day === 'Today'
        ? { todayFollowUps: [queue, { ...queue }], todayScheduled: [...work, ...work.map((item) => ({ ...item }))] }
        : { tomorrowFollowUps: [queue, { ...queue }], tomorrowScheduled: [...work, ...work.map((item) => ({ ...item }))] };
      const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, { ...emptyDays, ...inputs })), day);
      assert.equal(rows(html).length, 5);
      assert.deepEqual(counts(html), { Calls: 1, Meetings: 1, 'Follow-ups': 2, Tasks: 1 });
    });
  }

  it('never heuristically merges follow-ups by name, lead or timestamp, or confuses lead IDs with scheduled IDs', () => {
    const queue = followUp('same-id', '2026-09-11T11:00:00+06:00');
    const work = ['same-id', 'another-id'].map((id) => ({
      ...scheduled(id, 'follow_up', queue.nextFollowUpAt),
      leadId: queue.id,
      leadCustomerName: queue.prospectName,
    }));
    // The current APIs do not provide a shared follow-up/activity identifier.
    // Equal lead/time/name values (even equal IDs across tables) are not proof.
    const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, {
      ...emptyDays, todayFollowUps: [queue], todayScheduled: work,
    })), 'Today');
    assert.equal(rows(html).length, 3);
    assert.deepEqual(counts(html), { Calls: 0, Meetings: 0, 'Follow-ups': 3, Tasks: 0 });
  });

  it('does not silently truncate either loaded source at six rows', () => {
    const queue = Array.from({ length: 7 }, (_, i) => followUp(`queue-${i}`, '2026-09-11T11:00:00+06:00'));
    const work = Array.from({ length: 7 }, (_, i) => scheduled(`call-${i}`, 'call', '2026-09-11T12:00:00+06:00'));
    const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, {
      ...emptyDays, todayFollowUps: queue, todayScheduled: work,
    })), 'Today');
    assert.equal(rows(html).length, 14);
    assert.deepEqual(counts(html), { Calls: 7, Meetings: 0, 'Follow-ups': 7, Tasks: 0 });
  });

  it('keeps records with unavailable timestamps after timed work without losing or miscounting them', () => {
    const html = dayMarkup(render(React.createElement(TodayTomorrowPanel, {
      ...emptyDays,
      todayFollowUps: [followUp('unknown-time', '')],
      todayScheduled: [scheduled('known-time', 'call', '2026-09-11T12:00:00+06:00')],
    })), 'Today');
    assert.match(rows(html)[0], /Scheduled known-time/);
    assert.match(rows(html)[1], /Queue unknown-time/);
    assert.deepEqual(counts(html), { Calls: 1, Meetings: 0, 'Follow-ups': 1, Tasks: 0 });
  });

  it('passes dailyLoading and shows skeletons instead of false empty states or zero totals while pending', () => {
    assert.match(main, /dailyLoading=\{dailyLoading\}/);
    const html = render(React.createElement(TodayTomorrowPanel, { ...emptyDays, dailyLoading: true }));
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /No activities scheduled|<dl\b|aria-label="0 activities"/);
    for (const day of ['Today', 'Tomorrow'] as const) {
      assert.match(dayMarkup(html, day), /role="status"/);
      assert.ok(html.includes(`aria-label="Loading ${day.toLowerCase()} activities"`));
    }
  });

  it('shows loading skeletons during refresh even if old daily arrays are still present', () => {
    const html = render(React.createElement(TodayTomorrowPanel, { ...populatedDays, dailyLoading: true }));
    assert.equal((html.match(/role="status"/g) || []).length, 2);
    assert.doesNotMatch(html, /No activities scheduled|<ol\b|<dl\b/);
  });

  it('only shows both empty states and all four zero counts after daily loading settles', () => {
    const html = render(React.createElement(TodayTomorrowPanel, emptyDays));
    assert.match(html, /aria-busy="false"/);
    assert.doesNotMatch(html, /role="status"/);
    for (const day of ['Today', 'Tomorrow'] as const) {
      const group = dayMarkup(html, day);
      assert.ok(group.includes(`No activities scheduled for ${day.toLowerCase()}`));
      assert.deepEqual(counts(group), { Calls: 0, Meetings: 0, 'Follow-ups': 0, Tasks: 0 });
    }
  });

  it('adds the Roadshows count next to Calls/Meetings/Follow-ups/Tasks, per day, only with access', () => {
    // Without roadshow access the row must not exist at all (no false zero).
    const without = render(React.createElement(TodayTomorrowPanel, populatedDays));
    for (const day of ['Today', 'Tomorrow'] as const) {
      assert.ok(!('Roadshows' in counts(dayMarkup(without, day))), `${day} must not claim a roadshow count without access`);
    }
    const html = render(React.createElement(TodayTomorrowPanel, {
      ...populatedDays,
      roadshowCounts: { today: 2, tomorrow: 1 },
    }));
    const today = counts(dayMarkup(html, 'Today'));
    const tomorrow = counts(dayMarkup(html, 'Tomorrow'));
    assert.equal(today.Roadshows, 2, 'today must show the loaded roadshow count');
    assert.equal(tomorrow.Roadshows, 1, 'tomorrow must show the loaded roadshow count');
    // The four activity counters keep their exact values next to the new row.
    assert.deepEqual(
      Object.fromEntries(Object.entries(today).filter(([label]) => label !== 'Roadshows')),
      { Calls: 2, Meetings: 1, 'Follow-ups': 2, Tasks: 1 },
    );
    assert.match(dayMarkup(html, 'Today'), /data-roadshow-count="2"/, 'the today row carries its own count attribute');
    assert.doesNotMatch(dayMarkup(html, 'Today'), /Roadshows[\s\S]{0,40}No activities scheduled/);
  });

  it('keeps every overdue/today/upcoming bucket reachable without the retired card', () => {
    // The three-bucket card was removed from Home; the buckets themselves are
    // still first-class destinations. The Overdue KPI card links into the
    // queue via the daily-workbench surface, and the queue strategy page still
    // serves ?bucket=overdue|today|upcoming.
    const snapshot = render(React.createElement(ExecutiveSnapshot, snapshotProps));
    assert.match(snapshot, /Overdue Follow-ups/);
    assert.match(snapshot, /lucide-triangle-alert/);
    const strategy = fs.readFileSync(path.join(ROOT, 'src/modules/leads/pages/FollowUpStrategy.tsx'), 'utf8');
    assert.match(strategy, /bucket=overdue|'overdue'/);
    assert.match(strategy, /searchParams|useSearchParams/);
    assert.equal((source.match(/FollowUpDiscipline/g) || []).length, 0, 'the retired card must not come back to Dashboard.tsx');
  });

  it('fixes rounded-[10x] and preserves the Add Lead action', () => {
    assert.doesNotMatch(source, /rounded-\[10x\]/);
    assert.match(main, /to="\/leads\/new"[\s\S]*?rounded-\[10px\]/);
    assert.match(main, /canAccess\('lead_generate', 'create'\)/);
  });

  it('adds no full lead fetch or new daily requests; summaries use only the existing loaded arrays', () => {
    // No network read may be introduced by the presentation layer — with the
    // single, explicitly BOUNDED exception of the Recent Leads strip: it asks
    // for five rows (never the full list) and only when the local mirror is
    // empty. The KPI loader must remain free of every lead read (below).
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\bgetLeads\s*\(/, 'the full lead list must never be fetched here');
    assert.equal(
      (source.match(/leadService\.getRecentLeads\(5\)/g) || []).length,
      1,
      'exactly one bounded recent-leads read (limit 5)',
    );
    assert.ok(!source.includes('localStorage'), 'no direct localStorage access');
    // The ONE permitted local source is the read-only mirror of server data
    // (`localDb.getLeads()`), used by Recent Leads: it performs no request,
    // and it is explicitly forbidden inside the KPI loader (perf-phase2 G
    // enforces the same boundary).
    assert.equal(
      (source.match(/localDb\.getRecentLeads\(/g) || []).length,
      1,
      'exactly one capped mirror read (Recent Leads) — never a second data source',
    );
    {
      const kpiStart = source.indexOf('const loadDashboardData');
      const kpiEnd = source.indexOf('const loadDailyExecution');
      assert.ok(!source.slice(kpiStart, kpiEnd).includes('localDb'), 'the KPI loader must not read the mirror');
    }
    assert.equal((source.match(/leadService\.getFollowUpQueue\(/g) || []).length, 2);
    assert.equal((source.match(/scheduledActivityService\.list\(/g) || []).length, 1);
    assert.match(source, /getFollowUpQueue\(\{ bucket: 'today', limit: 50 \}\)/);
    assert.match(source, /getFollowUpQueue\(\{ bucket: 'upcoming', limit: 50 \}\)/);
    assert.match(source, /scheduledActivityService\.list\(\{ from: dhakaToday, to: tomorrowYmd, limit: 100 \}\)/);
    const panel = source.slice(source.indexOf('function TodayTomorrowPanel('), source.indexOf('// ---- Executive Snapshot'));
    assert.doesNotMatch(panel, /Service\.|\bfetch\s*\(/);
  });

  it('keeps the personal-work sections in order and leaves the analysis pages off Home', () => {
    // Mobile-shell change: Home is Core Performance + Today's Focus + Recent
    // Leads + Performance Insights. The pipeline board, follow-up discipline,
    // needs-attention and the embedded calendar moved to their own pages.
    const order = ['ExecutiveSnapshot', 'TodayTomorrowPanel', 'PerformanceInsights'];
    let previous = -1;
    for (const component of order) {
      const index = main.indexOf(`<${component}`);
      assert.ok(index > previous, `${component} must follow the previous section`);
      previous = index;
    }
    assert.ok(!main.includes('<TaskCalendar'), 'Home must not embed the calendar any more');
    assert.ok(!main.includes('<SalesPipeline'), 'Home must not embed the pipeline board any more');
    assert.doesNotMatch(source, /Lead Status Distribution/);
    // Recent Leads stays: it is personal, not analytical.
    assert.match(main, /lf-recent-list/);
  });
});

describe('Dashboard productivity refinement — unchanged PR #22 date filter', () => {
  for (const timezone of ['UTC', 'Asia/Dhaka', 'America/New_York']) {
    it(`preserves Today/WTD/MTD/LMTD/YTD/Custom/All with Dhaka dates in ${timezone}`, (t) => {
      const originalTimezone = process.env.TZ;
      process.env.TZ = timezone;
      t.after(() => {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
      });
      // 31 March in Dhaka, still 30 March in UTC: also exercises February cap.
      t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-30T20:00:00Z') });
      const ranges = {
        TODAY: ['2026-03-31', '2026-03-31'],
        WTD: ['2026-03-30', '2026-03-31'],
        MTD: ['2026-03-01', '2026-03-31'],
        LMTD: ['2026-02-01', '2026-02-28'],
        YTD: ['2026-01-01', '2026-03-31'],
        CUSTOM: ['2026-01-03', '2026-02-09'],
        ALL: [null, null],
      };
      for (const period of Object.keys(ranges) as Array<keyof typeof ranges>) {
        const result = resolveRange(period, '2026-01-03', '2026-02-09');
        assert.equal(result.label, period);
        assert.deepEqual([result.startYmd, result.endYmd], ranges[period]);
      }
      assert.equal(resolveRange('ALL').display, 'All time');
    });
  }

  it('preserves LMTD year rollover and leap-year capping', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-30T20:00:00Z') });
    let result = resolveRange('LMTD');
    assert.deepEqual([result.startYmd, result.endYmd], ['2025-12-01', '2025-12-31']);
    t.mock.timers.setTime(new Date('2024-03-30T20:00:00Z').getTime());
    result = resolveRange('LMTD');
    assert.deepEqual([result.startYmd, result.endYmd], ['2024-02-01', '2024-02-29']);
  });

  it('keeps Today as default, the existing controls, and server query mapping unchanged', () => {
    assert.match(main, /useState<PeriodKey>\('TODAY'\)/);
    assert.match(main, /\['TODAY', 'WTD', 'MTD', 'LMTD', 'YTD', 'CUSTOM'\]/);
    assert.match(main, /setPeriod\('ALL'\)/);
    assert.match(main, /aria-haspopup="dialog"/);
    assert.match(main, /Start Date/);
    assert.match(main, /End Date/);
    assert.match(main, /Apply/);
    assert.ok(main.includes("query = { period: 'TODAY', selectedDate: r.startYmd }"));
    assert.ok(main.includes("query = { period: 'ALL' }"));
    assert.ok(main.includes("query = { period: 'CUSTOM', startDate: r.startYmd, endDate: r.endYmd }"));
    assert.match(main, /dashboardService\.getDashboard\(query\)/);
  });
});
