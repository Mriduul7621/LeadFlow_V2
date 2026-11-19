/**
 * Enterprise Preview home guards — the surviving PR #24 invariants.
 * ------------------------------------------------------------------
 * Dashboard.tsx is deleted (Enterprise Preview redesign, 2026-11-19),
 * and TodayTomorrowPanel, ExecutiveSnapshot and resolveRange died with
 * it: they were defined inside that file and exist nowhere else in
 * src/. The render tests, the date-filter tests, the Pipeline Locked /
 * dailyLoading / roadshow-count / section-order tests and the
 * Dashboard.tsx compile check are therefore deleted with them — those
 * invariants genuinely no longer apply to any code.
 *
 * What survives is the performance + reachability contract the home
 * page owes, now guarded against the role homes that replaced the
 * Dashboard (src/modules/workspace/pages/* + the shared
 * useEnterpriseHomeData hook):
 *
 *   (a) no full lead fetch on Home — no home file calls getLeads, and
 *       the shared hook reads only the three bounded queue buckets;
 *   (b) the Add Lead action exists and is gated on
 *       canAccess('lead_generate', 'create');
 *   (c) every queue bucket stays reachable via Follow-up Queue
 *       (/follow-up in every role's enterprise nav, bucket deep links
 *       honoured);
 *   (d) the retired FollowUpDiscipline card stays retired.
 *
 * Source/compile guards only; no browser, DB or extra requests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnterpriseNavGroups } from '../../src/layouts/enterpriseNav';
import type { EnterpriseRole } from '../../src/layouts/enterpriseRole';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every file that renders or feeds the Enterprise Preview homes. */
const HOME_FILES = [
  'src/modules/workspace/pages/EnterpriseHome.tsx',
  'src/modules/workspace/pages/AdminHome.tsx',
  'src/modules/workspace/pages/ManagerHome.tsx',
  'src/modules/workspace/pages/TeamLeadHome.tsx',
  'src/modules/workspace/pages/AgentHome.tsx',
  'src/modules/workspace/hooks/useEnterpriseHomeData.ts',
  'src/modules/workspace/components/EnterprisePrimitives.tsx',
];
const homeSources = HOME_FILES.map(file => ({ file, src: read(file) }));

/** All .ts/.tsx files under a directory, recursively. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Enterprise Preview home — no full lead fetch (PR #24a)', () => {
  it('no home file fetches the full lead list, issues a raw fetch, or loads scheduled activities', () => {
    for (const { file, src } of homeSources) {
      assert.equal(src.includes('getLeads'), false, `${file} must never fetch the full lead list`);
      assert.doesNotMatch(src, /\bfetch\s*\(/, `${file} must not issue a raw fetch — services own the reads`);
      assert.equal(src.includes('scheduledActivityService'), false, `${file} must not load scheduled activities`);
      assert.equal(src.includes('localDb'), false, `${file} must not read the local mirror`);
    }
  });

  it('the shared home data hook reads only the three bounded queue buckets + FollowUpStatus metadata', () => {
    const hook = read('src/modules/workspace/hooks/useEnterpriseHomeData.ts');
    assert.equal((hook.match(/leadService\.getFollowUpQueue\(/g) || []).length, 3,
      'exactly three bounded queue reads (overdue / today / upcoming)');
    assert.match(hook, /getFollowUpQueue\(\{ bucket: 'overdue', limit: 50 \}\)/);
    assert.match(hook, /getFollowUpQueue\(\{ bucket: 'today', limit: 50 \}\)/);
    assert.match(hook, /getFollowUpQueue\(\{ bucket: 'upcoming', limit: 50 \}\)/);
    assert.ok(hook.includes("metadataService.getAllValues('FollowUpStatus')"),
      'the hook loads the FollowUpStatus dictionary for bucket labels');
    assert.equal(hook.includes('getLeads'), false, 'the hook must never fetch the full lead list');
  });
});

describe('Enterprise Preview home — Add Lead action (PR #24b)', () => {
  it('the Agent home offers Add Lead, gated on lead_generate.create', () => {
    const agent = read('src/modules/workspace/pages/AgentHome.tsx');
    assert.ok(agent.includes("canAccess('lead_generate', 'create')"),
      'the Add Lead CTA must be gated on the lead_generate.create capability');
    assert.ok(agent.includes('to="/leads/new"'), 'the CTA must link to the lead capture page');
    assert.ok(agent.includes('Add Lead'), 'the CTA must be labelled Add Lead');
  });

  it('the lead capture page enforces the same capability', () => {
    const page = read('src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(page.includes("canAccess('lead_generate', 'create')"),
      'LeadGenerate must enforce lead_generate.create (the home gate alone is not authorization)');
  });
});

describe('Enterprise Preview home — queue buckets stay reachable (PR #24c)', () => {
  it('Follow-up Queue is in every role\'s enterprise nav', () => {
    const roles: EnterpriseRole[] = ['admin', 'manager', 'teamLead', 'agent'];
    for (const role of roles) {
      const groups = buildEnterpriseNavGroups({
        role,
        canOpen: () => true,
        canAccess: () => true,
      });
      const items = groups.flatMap(g => g.items);
      const strategy = items.find(item => item.path === '/follow-up');
      assert.ok(strategy, `${role} nav must include /follow-up`);
      assert.equal(strategy!.label, 'Follow-up Queue', `${role} nav must label it Follow-up Queue`);
    }
  });

  it('the strategy page serves ?bucket=overdue|today|upcoming and keeps the bucket in the URL', () => {
    const strategy = read('src/modules/leads/pages/FollowUpStrategy.tsx');
    assert.ok(strategy.includes("searchParams.get('bucket')"), 'the bucket comes from the URL');
    assert.ok(strategy.includes("bucket=overdue|today|upcoming"), 'all three buckets are documented deep links');
    assert.ok(strategy.includes('setSearchParams({ bucket }, { replace: true })'),
      'selecting a bucket writes it back to the URL');
    assert.ok(strategy.includes('isValidBucket(bucketFromUrl) ? bucketFromUrl : \'overdue\''),
      'an invalid bucket falls back to overdue, never to a blank page');
  });
});

describe('Enterprise Preview home — the retired card stays retired (PR #24d)', () => {
  it('no home renders FollowUpDiscipline, and the component exists nowhere in src/', () => {
    for (const { file, src } of homeSources) {
      assert.equal(src.includes('FollowUpDiscipline'), false, `${file} must not render the retired card`);
    }
    const offenders = srcFiles(path.join(ROOT, 'src'))
      .filter(file => fs.readFileSync(file, 'utf8').includes('FollowUpDiscipline'));
    assert.deepEqual(offenders, [], 'FollowUpDiscipline must not come back anywhere in src/');
  });
});
