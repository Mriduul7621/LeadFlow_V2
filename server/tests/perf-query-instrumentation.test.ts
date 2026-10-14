import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

describe('Performance diagnostics — database query breakdown', () => {
  it('supports independent duration measurements in Server-Timing', () => {
    const perf = read('server/utils/perf.ts');
    assert.ok(perf.includes('measure(label: string, ms: number): void'));
    assert.ok(perf.includes('spans.push({ label, ms: round1(ms) })'));
  });

  it('records individual dashboard query durations without serializing parallel reads', () => {
    const source = read('server/routes/production.routes.ts');
    const start = source.indexOf("router.get('/dashboard'");
    const end = source.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    for (const label of ['db.metricQuery', 'db.followUpCounts', 'db.agentQuery', 'db.qualityAggregate']) {
      assert.ok(body.includes(label), 'missing dashboard timing label: ' + label);
    }
    assert.ok(body.includes('Promise.all(['), 'dashboard reads must remain parallel');
  });

  it('breaks follow-up queue timings into authorization, counts, list and quality signals', () => {
    const source = read('server/routes/production.routes.ts');
    const start = source.indexOf("router.get('/leads/follow-ups'");
    const end = source.indexOf("router.get('/leads/:id'", start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    for (const label of ['authz.caller', 'authz.permission', 'authz.visibility', 'db.countBuckets', 'db.list', 'db.qualitySignals']) {
      assert.ok(body.includes(label), 'missing follow-up timing label: ' + label);
    }
    assert.ok(body.includes('Promise.all(['), 'follow-up count and list reads should run concurrently');
    assert.ok(body.includes('counts[bucket as keyof typeof counts]'), 'pagination total should reuse the bucket aggregate');
    assert.ok(!body.includes('db.countTotal'), 'follow-up route should not issue a redundant total-count query');
    assert.ok(body.includes("perf.finish(res)"), 'timing header must be emitted before response');
  });

  it('breaks scheduled activity timings into authorization, count, list and quality signals', () => {
    const source = read('server/routes/production.routes.ts');
    const start = source.indexOf("router.get('/scheduled-activities'");
    const end = source.indexOf("router.get('/scheduled-activities/:id'", start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    for (const label of ['authz.caller', 'authz.permission', 'authz.visibility', 'db.countTotal', 'db.list', 'db.qualitySignals']) {
      assert.ok(body.includes(label), 'missing scheduled timing label: ' + label);
    }
    assert.ok(body.includes('Promise.all(['), 'scheduled count and list reads should run concurrently');
  });
  it('profiles individual Lead Quality query families', () => {
    const source = read('server/utils/leadQualitySignals.ts');
    const routes = read('server/routes/production.routes.ts');
    for (const label of ['leadScan', 'activitySignals', 'scheduledSignals']) {
      assert.ok(source.includes(`onTiming?.('${label}'`) || source.includes(`onTiming?.('${label}',`), 'missing quality timing callback: ' + label);
    }
    for (const label of ['db.qualityActivity', 'db.qualityScheduled', 'db.qualityAggregate.']) {
      assert.ok(routes.includes(label), 'missing route quality timing label: ' + label);
    }
  });

  it('uses sargable timestamp ranges for follow-up bucket list queries', () => {
    const routes = read('server/routes/production.routes.ts');
    const start = routes.indexOf("router.get('/leads/follow-ups'");
    const end = routes.indexOf("GET /leads/:id", start);
    const route = routes.slice(start, end);
    assert.ok(route.includes('const bucketRangePredicate'), 'missing sargable follow-up range predicate');
    assert.ok(route.includes("l.next_follow_up_at < '${todayLit}'::timestamp"), 'overdue should use a direct timestamp range');
    assert.ok(route.includes("l.next_follow_up_at >= '${todayLit}'::timestamp AND l.next_follow_up_at < '${tomorrowLit}'::timestamp"), 'today should use a half-open timestamp range');
    assert.ok(route.includes("l.next_follow_up_at >= '${tomorrowLit}'::timestamp"), 'upcoming should use a direct timestamp range');
    assert.ok(route.includes('const listWhere = bucketRangePredicate ? [...where, bucketRangePredicate] : where'), 'bucket filter should use the sargable range');
  });

});
