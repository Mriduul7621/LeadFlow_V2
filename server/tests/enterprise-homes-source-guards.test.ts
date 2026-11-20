/**
 * enterprise-homes-source-guards.test.ts
 * ------------------------------------------------------------------
 * Source guards on the four enterprise role homes (Enterprise
 * Preview redesign, 2026-11-19; Team Lead / Manager / Admin
 * workspace rebuild, 2026-11-20) + the shared hook + primitives:
 *
 *   - the sample prototype's demo metrics must NOT appear as
 *     rendered content — the real KPI substitutions are pinned
 *     instead (the sample's numbers survive ONLY in the header
 *     comments that document each substitution, so every guard
 *     below runs on COMMENT-STRIPPED code);
 *   - no "$" anywhere (money is always ৳; the only `$` in these
 *     files is template interpolation `${...}`);
 *   - no demo stage names (the sample's pipeline stages
 *     Qualified / Proposal / Won / Lost / Stalled are NOT
 *     LeadFlow statuses — the real list is New, Contacted,
 *     No Response, Busy, Interested, Follow-up Set, Meeting
 *     Fixed, Meeting Completed, Pipeline Locked, Converted,
 *     Not Interested);
 *   - every link target is a real route registered in App.tsx;
 *   - no home reads leads through getLeads (the hook owns the
 *     bounded queue reads).
 *
 * The three non-agent homes are thin wrappers around the shared
 * TeamOverviewHome (2026-11-20), so the guards run on the shared
 * component too — that is where the rendered content lives now.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KPI_KEYS } from '../../src/modules/team/utils/kpiDrilldown';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented substitutions don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const HOME_FILES = [
  'src/modules/workspace/pages/AdminHome.tsx',
  'src/modules/workspace/pages/ManagerHome.tsx',
  'src/modules/workspace/pages/TeamLeadHome.tsx',
  'src/modules/workspace/pages/AgentHome.tsx',
] as const;

/** The shared Team Overview home (2026-11-20) — the non-agent homes' rendered content lives here. */
const SHARED_HOME_FILE = 'src/modules/workspace/pages/TeamOverviewHome.tsx';

const GUARDED_FILES = [...HOME_FILES, SHARED_HOME_FILE];

/** The sample's demo metrics / demo chrome — banned from rendered code. */
const BANNED_STRINGS = [
  'Import success',
  'System health',
  'Target progress',
  'Monthly target',
  'Open records',
  // 'Follow-up completion' is DELIBERATELY not banned anymore:
  // since the 2026-11-20 rebuild it is a REAL metric (completed
  // today / (completed + due today + overdue), computed from the
  // team's follow-up activity — see teamWorkspaceData.
  // memberCompletions), honestly labelled on Team Overview and
  // Team Members. The ban protected the sample's FAKE metric;
  // the real one is the substitution.
  'NCP achievement',
  'Performance trend',
  'Filters are illustrative',
  'Demo only',
];

/** The sample's demo-only stage names (not LeadFlow statuses). */
const DEMO_STAGE_NAMES = ['Qualified', 'Proposal', 'Won', 'Lost', 'Stalled'];

describe('enterprise homes — no demo metrics, no demo stages, no dollars', () => {
  for (const file of GUARDED_FILES) {
    it(`${file}: no sample demo metric or demo chrome in rendered code`, () => {
      const code = stripComments(read(file));
      for (const banned of BANNED_STRINGS) {
        assert.ok(!code.includes(banned), `${file} must not render "${banned}"`);
      }
    });

    it(`${file}: no demo stage names in rendered code`, () => {
      const code = stripComments(read(file));
      for (const stage of DEMO_STAGE_NAMES) {
        assert.ok(!new RegExp(`\\b${stage}\\b`).test(code), `${file} must not name the demo stage "${stage}"`);
      }
    });

    it(`${file}: no bare "$" — money is ৳, and "$" appears only as template interpolation`, () => {
      const code = stripComments(read(file)).replaceAll('${', '');
      assert.ok(!code.includes('$'), `${file} carries a bare dollar sign`);
    });

    it(`${file}: never calls getLeads`, () => {
      assert.ok(!stripComments(read(file)).includes('getLeads'), `${file} must not call getLeads`);
    });
  }

  it('the hook and primitives carry no bare "$" either', () => {
    for (const file of [
      'src/modules/workspace/hooks/useEnterpriseHomeData.ts',
      'src/modules/workspace/components/EnterprisePrimitives.tsx',
      'src/modules/workspace/utils/enterpriseData.ts',
    ]) {
      const code = stripComments(read(file)).replaceAll('${', '');
      assert.ok(!code.includes('$'), `${file} carries a bare dollar sign`);
    }
  });

  it('the demo strings survive ONLY in the substitution comments (the guards strip them deliberately)', () => {
    // If a future edit moves a demo string out of a comment into
    // rendered JSX, the tests above catch it; this test pins the
    // reason the strip exists at all. The substitution docs moved
    // to the shared component with the 2026-11-20 rebuild (the
    // role homes are thin wrappers now).
    const shared = read(SHARED_HOME_FILE);
    assert.ok(shared.includes('"Import success 98.4%"'), 'TeamOverviewHome documents its Import-success substitution');
    assert.ok(shared.includes('"System health"'), 'TeamOverviewHome documents its System-health substitution');
    assert.ok(shared.includes('"Target progress 62%"'), 'TeamOverviewHome documents its Target-progress substitution');
    assert.ok(shared.includes('"NCP achievement ৳28.4L"'), 'TeamOverviewHome documents its NCP-achievement substitution');
    assert.ok(shared.includes('"Monthly target"'), 'TeamOverviewHome documents its Monthly-target substitution');
    assert.ok(shared.includes('"Open records"'), 'TeamOverviewHome documents its Open-records substitution');
  });
});

describe('enterprise homes — the KPI substitutions are pinned', () => {
  it('the three non-agent homes are thin wrappers around the shared Team Overview', () => {
    for (const [file, scope] of [
      ['src/modules/workspace/pages/AdminHome.tsx', 'admin'],
      ['src/modules/workspace/pages/ManagerHome.tsx', 'manager'],
      ['src/modules/workspace/pages/TeamLeadHome.tsx', 'teamLead'],
    ] as const) {
      const code = stripComments(read(file));
      assert.ok(code.includes(`<TeamOverviewHome scope="${scope}" />`), `${file} renders the shared home with scope ${scope}`);
      assert.ok(!code.includes('<KpiCard'), `${file} renders no KPI card of its own`);
    }
  });

  it('TeamOverviewHome: the Agent KPI set at team scope — Assigned leads + Due today + Contacted + Converted', () => {
    // Mahadi's words (2026-11-20): "KPI gulo agent er motoi tobe
    // tar nijer and tar nicher subordinate der sob miliye" — the
    // Agent's set, scoped to own + all subordinates (org-wide for
    // the Admin, minus admin-role users).
    const code = stripComments(read(SHARED_HOME_FILE));
    for (const label of ['label="Assigned leads"', 'label="Due today"', 'label="Contacted"', 'label="Converted"']) {
      assert.ok(code.includes(label), `TeamOverviewHome renders ${label}`);
    }
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'TeamOverviewHome renders exactly four KPI cards');
    // The old Admin "Active users" KPI is GONE with the rebuild
    // (it was a user-admin metric, not a sales KPI — documented
    // in the shared component's substitution comment).
    assert.ok(!code.includes('label="Active users"'), 'no Active users card anymore');
    assert.ok(!code.includes('label="Overdue"'), 'no Overdue card (the count is the Due-today subline, as on AgentHome)');
  });

  it('AgentHome: greeting H1 + Assigned leads + Contacted + Converted (Agent workspace rebuild, 2026-11-20)', () => {
    // The H1 is now the time-based greeting ("Good morning,
    // {firstName}"); "My Work" survives as the sidebar label and
    // breadcrumb, not as the page title. The KPI set is the demo's
    // with Mahadi's substitution: Converted replaces Target
    // progress, and the Overdue card became the Due-today subline.
    const code = stripComments(read('src/modules/workspace/pages/AgentHome.tsx'));
    assert.ok(code.includes('greetingForDhakaHour'), 'AgentHome greets by Dhaka hour');
    assert.ok(code.includes('eyebrow="Personal workspace"'), 'AgentHome keeps the Personal workspace eyebrow');
    for (const label of ['label="Assigned leads"', 'label="Due today"', 'label="Contacted"', 'label="Converted"']) {
      assert.ok(code.includes(label), `AgentHome renders ${label}`);
    }
    assert.ok(!code.includes('label="Overdue"'), 'AgentHome has no Overdue card (the count is the Due-today subline)');
    assert.ok(code.includes('overdue needs attention'), 'AgentHome names the overdue count in the Due-today subline');
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'AgentHome renders exactly four KPI cards');
  });

  it('TeamOverviewHome shows the Team activity chart (real logged outcomes), not the sample\'s 7-month trend', () => {
    // The non-agent homes used to show the 7-day follow-up chart
    // from the queue buckets; the 2026-11-20 rebuild replaced it
    // with the Team activity chart — the whole team's logged
    // activity, timeframe-switchable (This week / Last week /
    // This month), exactly like AgentHome's Weekly activity.
    const code = stripComments(read(SHARED_HOME_FILE));
    assert.ok(code.includes('Team activity'), 'TeamOverviewHome carries the Team activity chart');
    assert.ok(code.includes('activityBuckets('), 'TeamOverviewHome buckets real logged outcomes per day');
    assert.ok(!code.includes('title="Follow-ups due · next 7 days"'), 'the 7-day queue chart is gone');
    const agent = stripComments(read('src/modules/workspace/pages/AgentHome.tsx'));
    assert.ok(agent.includes('Weekly activity'), 'AgentHome carries the Weekly activity chart');
    assert.ok(agent.includes('activityBuckets'), 'AgentHome buckets real logged outcomes per day');
  });

  it('TeamOverviewHome carries Member performance + Follow-up health + At-risk leads (the demo sections)', () => {
    const code = stripComments(read(SHARED_HOME_FILE));
    assert.ok(code.includes('Member performance'), 'the member performance section renders');
    assert.ok(code.includes('Follow-up health'), 'the follow-up health section renders');
    assert.ok(code.includes('At-risk leads'), 'the at-risk leads section renders');
    assert.ok(code.includes('Follow-up completion'), 'the member % is honestly labelled Follow-up completion');
    assert.ok(code.includes('ep-member-list'), 'member performance renders as a list');
    assert.ok(code.includes('ep-health-list'), 'follow-up health renders as bars');
    assert.ok(code.includes('ep-atrisk-list'), 'at-risk leads render as a list');
  });
});

describe('enterprise homes — every link target is a real App.tsx route', () => {
  /** Route patterns registered in App.tsx (`path: '/...'`), incl. `:param` segments. */
  const appRoutes = [...read('src/App.tsx').matchAll(/path: '([^']+)'/g)].map(m => m[1]);

  /** Does `route` match `pattern` (`:param` matches one segment)? */
  const matchesRoute = (pattern: string, route: string): boolean => {
    const patternParts = pattern.split('/');
    const routeParts = route.split('/');
    if (patternParts.length !== routeParts.length) return false;
    return patternParts.every((part, i) => part.startsWith(':') || part === routeParts[i]);
  };

  const isRealRoute = (route: string): boolean =>
    appRoutes.some(pattern => pattern !== '*' && matchesRoute(pattern, route));

  interface LinkSite {
    kind: 'static' | 'template' | 'kpi';
    value: string;
  }

  /** Every link site in a home: `to="..."`, `to: '...'`, template `to`s, and kpiDrilldownUrl calls. */
  const linkSites = (src: string): LinkSite[] => {
    const sites: LinkSite[] = [];
    for (const m of src.matchAll(/to="([^"]+)"/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/to:\s*'([^']+)'/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/to:\s*`([^`]+)`/g)) sites.push({ kind: 'template', value: m[1] });
    for (const m of src.matchAll(/to=\{`([^`]+)`\}/g)) sites.push({ kind: 'template', value: m[1] });
    for (const m of src.matchAll(/kpiDrilldownUrl\('([^']+)'/g)) sites.push({ kind: 'kpi', value: m[1] });
    // String literals inside to={...} ternaries (e.g. the gated NCP card).
    for (const m of src.matchAll(/to=\{[^}]*'(\/[^']+)'[^}]*\}/g)) sites.push({ kind: 'static', value: m[1] });
    return sites;
  };

  it('App.tsx registers the routes the homes link to', () => {
    for (const route of ['/', '/users', '/team', '/leads', '/leads/new', '/leads/:id', '/workbench', '/sales-pipeline', '/ncp-progress', '/team/kpi/:kpi']) {
      assert.ok(appRoutes.includes(route), `App.tsx registers ${route}`);
    }
  });

  // Exact site counts pin the extraction itself: if a regex stops
  // matching a link shape, the count drops and this fails loudly
  // instead of silently checking fewer links.
  const EXPECTED_SITES: Record<string, number> = {
    // The three role homes are thin wrappers now — no links of
    // their own; the shared component carries them all.
    'src/modules/workspace/pages/AdminHome.tsx': 0,
    'src/modules/workspace/pages/ManagerHome.tsx': 0,
    'src/modules/workspace/pages/TeamLeadHome.tsx': 0,
    // Agent workspace rebuild (2026-11-20): 11 — View tasks, Add
    // Lead, 3 KPI drill-downs, the priority-row update link, the
    // pipeline / activity / recent "View all" links, the recent
    // lead row, and the dialog's queue link.
    'src/modules/workspace/pages/AgentHome.tsx': 11,
    // Team Overview (2026-11-20): 11 — Add Lead, Add user, 3 KPI
    // drill-downs, the member row (template, /team?member=…), the
    // at-risk row (template, /leads/:id), the member / health /
    // activity "View all" links, and the dialog's queue link.
    [SHARED_HOME_FILE]: 11,
  };

  for (const file of GUARDED_FILES) {
    it(`${file}: every link target resolves to a registered route`, () => {
      const sites = linkSites(stripComments(read(file)));
      assert.equal(sites.length, EXPECTED_SITES[file], `${file} link-site count (extraction drift?)`);
      for (const site of sites) {
        if (site.kind === 'static') {
          assert.ok(site.value.startsWith('/'), `${file}: link target ${site.value} starts with /`);
          assert.ok(isRealRoute(site.value), `${file}: ${site.value} is not a registered App.tsx route`);
        } else if (site.kind === 'template') {
          // `/leads/${item.id}` -> /leads/:param, matched
          // segment-wise. A query string (e.g. /team?member=…)
          // resolves to its base route.
          const base = site.value.split('?')[0];
          const normalized = base.replace(/\$\{[^}]+\}/g, ':param');
          assert.ok(isRealRoute(normalized), `${file}: ${site.value} does not resolve to a registered route`);
        } else {
          assert.ok((KPI_KEYS as readonly string[]).includes(site.value), `${file}: ${site.value} is not a KPI key`);
          assert.ok(appRoutes.includes('/team/kpi/:kpi'), 'App.tsx registers the drill-down route');
        }
      }
    });
  }
});

describe('enterprise homes — the shared hook and primitives', () => {
  it('the hook loads the overview + dashboard + bounded queue buckets, never getLeads', () => {
    const hook = stripComments(read('src/modules/workspace/hooks/useEnterpriseHomeData.ts'));
    assert.ok(hook.includes('useCallerTeam()'), 'the KPIs come from the shared caller-team overview');
    assert.ok(hook.includes('dashboardService.getDashboard'), 'conversion/NCP come from the dashboard');
    for (const bucket of ["bucket: 'overdue'", "bucket: 'today'", "bucket: 'upcoming'"]) {
      assert.ok(hook.includes(bucket), `the queue reads the ${bucket} bucket`);
    }
    assert.ok(!hook.includes("bucket: 'all'"), 'no unbounded bucket=all read');
    // Team Lead / Manager / Admin workspace (2026-11-20): the 7-day
    // chart pipeline (chartDays / buildNext7Days) was removed — the
    // homes chart team activity from the loaded leads list via
    // activityBuckets, and the hook carries no chart state anymore.
    assert.ok(!hook.includes('buildNext7Days('), 'the 7-day chart builder is gone');
    assert.ok(!hook.includes('chartDays'), 'the hook carries no 7-day chart state anymore');
    assert.ok(!hook.includes('getLeads'), 'the hook never calls getLeads');
  });

  it('EnterpriseHome lazy-loads exactly one home per DISPLAY role, with no switcher for ordinary users', () => {
    const home = stripComments(read('src/modules/workspace/pages/EnterpriseHome.tsx'));
    for (const page of ['AdminHome', 'ManagerHome', 'TeamLeadHome', 'AgentHome']) {
      assert.ok(home.includes(`import('./${page}')`), `EnterpriseHome lazy-loads ${page}`);
    }
    // Fix round 1: the role comes from the display-role hook, which is
    // the derived role for everyone — except a super admin previewing
    // another role (see enterprise-preview.test.ts for the gate).
    assert.ok(home.includes('useEnterpriseDisplayRole()'), 'the role comes from the display-role hook');
    assert.ok(!home.includes('setRole'), 'no control anywhere switches the role');
  });

  it('KpiCard links when `to` is set, with the "label: value" aria-label', () => {
    const primitives = stripComments(read('src/modules/workspace/components/EnterprisePrimitives.tsx'));
    assert.ok(primitives.includes('<Link to={props.to} className="ep-card ep-kpi-link"'), 'a linked card renders a Link');
    assert.ok(primitives.includes('aria-label={`${props.label}: ${props.value}`}'), 'the aria-label is "label: value"');
    assert.ok(primitives.includes("tone === 'orange' || props.tone === 'red' ? ' warn' : ''"), 'the warn class follows the orange/red tone');
  });
});
