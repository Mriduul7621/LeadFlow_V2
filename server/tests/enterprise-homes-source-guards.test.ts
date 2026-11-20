/**
 * enterprise-homes-source-guards.test.ts
 * ------------------------------------------------------------------
 * Source guards on the four enterprise role homes (Enterprise
 * Preview redesign, 2026-11-19) + the shared hook + primitives:
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

/** The sample's demo metrics / demo chrome — banned from rendered code. */
const BANNED_STRINGS = [
  'Import success',
  'System health',
  'Target progress',
  'Monthly target',
  'Open records',
  'Follow-up completion',
  'NCP achievement',
  'Performance trend',
  'Filters are illustrative',
  'Demo only',
];

/** The sample's demo-only stage names (not LeadFlow statuses). */
const DEMO_STAGE_NAMES = ['Qualified', 'Proposal', 'Won', 'Lost', 'Stalled'];

describe('enterprise homes — no demo metrics, no demo stages, no dollars', () => {
  for (const file of HOME_FILES) {
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
    // reason the strip exists at all.
    const admin = read('src/modules/workspace/pages/AdminHome.tsx');
    assert.ok(admin.includes('"Import success 98.4%"'), 'AdminHome documents its Import-success substitution');
    assert.ok(admin.includes('"System health"'), 'AdminHome documents its System-health substitution');
    const manager = read('src/modules/workspace/pages/ManagerHome.tsx');
    assert.ok(manager.includes('"Target progress 62%"'), 'ManagerHome documents its Target-progress substitution');
  });
});

describe('enterprise homes — the KPI substitutions are pinned', () => {
  it('AdminHome: Total leads + Active users + Open leads + Converted', () => {
    const code = stripComments(read('src/modules/workspace/pages/AdminHome.tsx'));
    for (const label of ['label="Active users"', 'label="Total leads"', 'label="Open leads"', 'label="Converted"']) {
      assert.ok(code.includes(label), `AdminHome renders ${label}`);
    }
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'AdminHome renders exactly four KPI cards');
  });

  it('ManagerHome: Conversion + Collected NCP (৳) + Managed leads + At-risk leads', () => {
    const code = stripComments(read('src/modules/workspace/pages/ManagerHome.tsx'));
    for (const label of ['label="Managed leads"', 'label="Conversion"', 'label="Collected NCP"', 'label="At-risk leads"']) {
      assert.ok(code.includes(label), `ManagerHome renders ${label}`);
    }
    assert.ok(code.includes('money(metrics.collected)'), 'Collected NCP renders through the ৳ money helper');
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'ManagerHome renders exactly four KPI cards');
  });

  it('TeamLeadHome: No Action Alert stands in for follow-up completion', () => {
    const code = stripComments(read('src/modules/workspace/pages/TeamLeadHome.tsx'));
    for (const label of ['label="Team leads"', 'label="Due today"', 'label="Overdue"', 'label="No Action Alert"']) {
      assert.ok(code.includes(label), `TeamLeadHome renders ${label}`);
    }
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'TeamLeadHome renders exactly four KPI cards');
  });

  it('AgentHome: "My Work" (the sample\'s one H1 exception) + My leads + Converted', () => {
    const code = stripComments(read('src/modules/workspace/pages/AgentHome.tsx'));
    assert.ok(code.includes('title="My Work"'), 'AgentHome is headed My Work, not Overview');
    for (const label of ['label="My leads"', 'label="Due today"', 'label="Overdue"', 'label="Converted"']) {
      assert.ok(code.includes(label), `AgentHome renders ${label}`);
    }
    assert.equal((code.match(/<KpiCard/g) || []).length, 4, 'AgentHome renders exactly four KPI cards');
  });

  it('all four homes show the real 7-day follow-up chart, not the sample\'s 7-month trend', () => {
    for (const file of HOME_FILES) {
      const code = stripComments(read(file));
      assert.ok(code.includes('title="Follow-ups due · next 7 days"'), `${file} carries the 7-day chart`);
      assert.ok(code.includes('days={data.chartDays}'), `${file} feeds the chart from the queue buckets`);
    }
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
    'src/modules/workspace/pages/AdminHome.tsx': 10,
    'src/modules/workspace/pages/ManagerHome.tsx': 9,
    'src/modules/workspace/pages/TeamLeadHome.tsx': 10,
    'src/modules/workspace/pages/AgentHome.tsx': 8,
  };

  for (const file of HOME_FILES) {
    it(`${file}: every link target resolves to a registered route`, () => {
      const sites = linkSites(stripComments(read(file)));
      assert.equal(sites.length, EXPECTED_SITES[file], `${file} link-site count (extraction drift?)`);
      for (const site of sites) {
        if (site.kind === 'static') {
          assert.ok(site.value.startsWith('/'), `${file}: link target ${site.value} starts with /`);
          assert.ok(isRealRoute(site.value), `${file}: ${site.value} is not a registered App.tsx route`);
        } else if (site.kind === 'template') {
          // `/leads/${item.id}` -> /leads/:param, matched segment-wise.
          const normalized = site.value.replace(/\$\{[^}]+\}/g, ':param');
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
    assert.ok(hook.includes('buildNext7Days('), 'the 7-day chart is built from the buckets');
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
