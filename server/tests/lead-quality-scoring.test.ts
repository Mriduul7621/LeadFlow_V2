/**
 * lead-quality-scoring.test.ts — Explainable Lead Quality scoring guards
 * ------------------------------------------------------------------
 * Verifies:
 * - pure formula: base/bands/weights/recency/engagement/discipline/
 *   investment/failed-contact arithmetic, terminal model, determinism
 * - bulk signals: investment parsing, row adapters, bulk fetch mapping,
 *   failure degradation, dashboard aggregates (stub pool, no DB)
 * - fallback (demo-mode) aggregates use the same formula
 * - route wiring present; frontend never scores; no new score column;
 *   scoring doc exists and documents the contract
 *
 * All pure-scorer cases inject a fixed `now` (2026-09-12T06:00:00Z, i.e.
 * 12:00 Asia/Dhaka) with multi-day margins — no wall-clock flakes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  calculateLeadQuality,
  bandForScore,
  toCompactQuality,
  reconcileQualityFactors,
  canonicalizeQualityStatus,
  LEAD_QUALITY_BASE_SCORE,
  LEAD_QUALITY_THRESHOLDS,
} from '../utils/leadQuality.js';
import {
  parseExplicitInvestmentAmount,
  qualityInputFromRow,
  scoreLeadRow,
  compactScoreLeadRow,
  leadSignalKey,
  fetchActivityQualitySignals,
  fetchScheduledQualitySignals,
  aggregateQualityForScope,
  aggregateQualityForFallbackLeads,
  compactQualityForFallbackLeads,
  scoreFallbackLead,
  emptyQualityDashboard,
} from '../utils/leadQualitySignals.js';

/** Fixed reference instant: 2026-09-12 12:00 Asia/Dhaka. */
const NOW = '2026-09-12T06:00:00Z';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Lead Quality — pure formula', () => {
  it('exports the documented constants', () => {
    assert.equal(LEAD_QUALITY_BASE_SCORE, 35);
    assert.equal(LEAD_QUALITY_THRESHOLDS.HOT_MIN, 80);
    assert.equal(LEAD_QUALITY_THRESHOLDS.WARM_MIN, 60);
    assert.equal(LEAD_QUALITY_THRESHOLDS.DEVELOPING_MIN, 40);
  });

  it('bare untouched lead scores base 35 / Cold with no factors', () => {
    const r = calculateLeadQuality({ status: 'Untouched', now: NOW });
    assert.equal(r.score, 35);
    assert.equal(r.band, 'Cold');
    assert.equal(r.isTerminal, false);
    assert.deepEqual(r.positiveFactors, []);
    assert.deepEqual(r.negativeFactors, []);
    assert.deepEqual(r.attentionReasons, []);
    assert.ok(reconcileQualityFactors(r).matches);
  });

  it('status weights move the score exactly', () => {
    const cases: Array<[string, number, string]> = [
      ['Pipeline Locked', 70, 'Warm'],
      ['Meeting Completed', 60, 'Warm'],
      ['Meeting Fixed', 55, 'Developing'],
      ['Interested', 50, 'Developing'],
      ['Follow-up Set', 45, 'Developing'],
      ['Contacted', 40, 'Developing'],
      ['Untouched', 35, 'Cold'],
      ['Busy', 33, 'Cold'],
      ['No Response', 27, 'Cold'],
    ];
    for (const [status, score, band] of cases) {
      const r = calculateLeadQuality({ status, now: NOW });
      assert.equal(r.score, score, `${status} score`);
      assert.equal(r.band, band, `${status} band`);
      assert.ok(reconcileQualityFactors(r).matches, `${status} reconciles`);
    }
  });

  it('band thresholds cut exactly at 80 / 60 / 40', () => {
    assert.equal(bandForScore(100), 'Hot');
    assert.equal(bandForScore(80), 'Hot');
    assert.equal(bandForScore(79), 'Warm');
    assert.equal(bandForScore(60), 'Warm');
    assert.equal(bandForScore(59), 'Developing');
    assert.equal(bandForScore(40), 'Developing');
    assert.equal(bandForScore(39), 'Cold');
    assert.equal(bandForScore(0), 'Cold');
  });

  it('terminal outcomes bypass the active scale', () => {
    const converted = calculateLeadQuality({ status: 'Converted', now: NOW });
    assert.equal(converted.score, 100);
    assert.equal(converted.band, 'Converted');
    assert.equal(converted.isTerminal, true);
    assert.deepEqual(converted.attentionReasons, []);
    assert.equal(converted.positiveFactors.length, 1);
    assert.equal(converted.positiveFactors[0].points, 65);
    assert.ok(reconcileQualityFactors(converted).matches);

    const lost = calculateLeadQuality({ status: 'Not Interested', now: NOW });
    assert.equal(lost.score, 0);
    assert.equal(lost.band, 'Not Interested');
    assert.equal(lost.isTerminal, true);
    assert.deepEqual(lost.attentionReasons, []);
    assert.equal(lost.negativeFactors.length, 1);
    assert.equal(lost.negativeFactors[0].points, -35);
    assert.ok(reconcileQualityFactors(lost).matches);
  });

  it('terminal status matching is case-insensitive', () => {
    assert.equal(calculateLeadQuality({ status: 'converted', now: NOW }).band, 'Converted');
    assert.equal(calculateLeadQuality({ status: 'NOT INTERESTED', now: NOW }).band, 'Not Interested');
  });

  it('status aliases resolve like bulk import; custom statuses stay neutral', () => {
    assert.equal(canonicalizeQualityStatus('Unreachable'), 'No Response');
    assert.equal(canonicalizeQualityStatus('Follow up'), 'Follow-up Set');
    assert.equal(canonicalizeQualityStatus(''), 'Untouched');
    assert.equal(calculateLeadQuality({ status: 'Unreachable', now: NOW }).score, 27);
    assert.equal(calculateLeadQuality({ status: 'Follow up', now: NOW }).score, 45);
    const custom = calculateLeadQuality({ status: 'VIP Nurture', now: NOW });
    assert.equal(custom.score, 35);
    assert.equal(custom.positiveFactors.length, 0);
    assert.equal(custom.negativeFactors.length, 0);
  });

  it('recency ladder: fresh bonus, neutral week, stale penalties + attention', () => {
    const touchedToday = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-09-12T00:30:00Z', now: NOW,
    });
    assert.equal(touchedToday.score, 40);
    assert.equal(touchedToday.band, 'Developing');
    assert.ok(touchedToday.positiveFactors.some(f => f.label === 'Touched within the last day' && f.points === 5));

    const twoDays = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-09-10T00:00:00Z', now: NOW,
    });
    assert.equal(twoDays.score, 38);
    assert.ok(twoDays.positiveFactors.some(f => f.label === 'Touched 2 days ago' && f.points === 3));

    const week = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-09-05T12:00:00Z', now: NOW,
    });
    assert.equal(week.score, 35);
    assert.deepEqual(week.attentionReasons, []);

    const fortnight = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-08-29T12:00:00Z', now: NOW,
    });
    assert.equal(fortnight.score, 27);
    assert.ok(fortnight.negativeFactors.some(f => f.label === 'No progress in 14 days' && f.points === -8));
    assert.deepEqual(fortnight.attentionReasons, []);

    const twentyDays = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-08-23T12:00:00Z', now: NOW,
    });
    assert.equal(twentyDays.score, 20);
    assert.deepEqual(twentyDays.attentionReasons, ['No meaningful progress in 20 days']);

    const stale = calculateLeadQuality({
      status: 'Untouched', createdAt: '2026-07-01T12:00:00Z', now: NOW,
    });
    assert.equal(stale.score, 13);
    assert.ok(stale.attentionReasons.some(r => r.includes('going stale')));
    assert.ok(reconcileQualityFactors(stale).matches);
  });

  it('recency uses the freshest touch across contact/activity/creation', () => {
    const r = calculateLeadQuality({
      status: 'Untouched',
      createdAt: '2026-07-01T12:00:00Z',
      lastContactedAt: '2026-09-12T00:30:00Z',
      now: NOW,
    });
    assert.equal(r.score, 40);
  });

  it('engagement bonus is capped (volume alone cannot make Hot)', () => {
    const capped = calculateLeadQuality({ status: 'Untouched', meaningfulEngagementCount: 10, now: NOW });
    assert.equal(capped.score, 44);
    assert.ok(capped.positiveFactors.some(f => f.points === 9 && f.label.includes('(capped)')));
    const single = calculateLeadQuality({ status: 'Untouched', meaningfulEngagementCount: 1, now: NOW });
    assert.equal(single.score, 38);
    assert.ok(single.positiveFactors.some(f => f.label === 'Customer showed buying interest (1 interaction)'));
  });

  it('failed-contact penalty is capped and raises attention at 3+', () => {
    const heavy = calculateLeadQuality({ status: 'Untouched', failedContactCount: 5, now: NOW });
    assert.equal(heavy.score, 26);
    assert.ok(heavy.negativeFactors.some(f => f.points === -9 && f.label.includes('(capped)')));
    assert.deepEqual(heavy.attentionReasons, ['Repeated unanswered contact (5 attempts)']);
    const light = calculateLeadQuality({ status: 'Untouched', failedContactCount: 2, now: NOW });
    assert.equal(light.score, 29);
    assert.deepEqual(light.attentionReasons, []);
  });

  it('explicit investment interest is a flat bonus, never a penalty', () => {
    const withAmount = calculateLeadQuality({
      status: 'Untouched', hasInvestmentAmount: true, investmentAmount: 50000, now: NOW,
    });
    assert.equal(withAmount.score, 38);
    assert.ok(withAmount.positiveFactors.some(f => f.points === 3 && f.label.includes('50,000')));
    const without = calculateLeadQuality({ status: 'Untouched', now: NOW });
    assert.equal(without.score, 35);
  });

  it('scheduled next action earns a bonus; overdue earns penalties + attention', () => {
    const scheduled = calculateLeadQuality({
      status: 'Untouched', nextFollowUpAt: '2026-09-20T00:00:00Z', now: NOW,
    });
    assert.equal(scheduled.score, 40);
    assert.ok(scheduled.positiveFactors.some(f => f.label === 'Next action scheduled' && f.points === 5));

    const overdue2 = calculateLeadQuality({
      status: 'Untouched', nextFollowUpAt: '2026-09-10T00:00:00Z', now: NOW,
    });
    assert.equal(overdue2.score, 30);
    assert.deepEqual(overdue2.attentionReasons, ['Next action overdue by 2 days']);

    const overdue3 = calculateLeadQuality({
      status: 'Untouched', nextFollowUpAt: '2026-09-09T00:00:00Z', now: NOW,
    });
    assert.equal(overdue3.score, 30);

    const overdue4 = calculateLeadQuality({
      status: 'Untouched', nextFollowUpAt: '2026-09-08T00:00:00Z', now: NOW,
    });
    assert.equal(overdue4.score, 25);

    const overdue10 = calculateLeadQuality({
      status: 'Untouched', nextFollowUpAt: '2026-09-02T00:00:00Z', now: NOW,
    });
    assert.equal(overdue10.score, 20);
    assert.deepEqual(overdue10.attentionReasons, ['Next action overdue by 10 days']);
  });

  it('earliest planned action wins across follow-up and scheduled activity', () => {
    const r = calculateLeadQuality({
      status: 'Untouched',
      nextFollowUpAt: '2026-09-20T00:00:00Z',
      nextScheduledAt: '2026-09-10T00:00:00Z',
      now: NOW,
    });
    assert.equal(r.score, 30);
    assert.deepEqual(r.attentionReasons, ['Next action overdue by 2 days']);
  });

  it('advanced status without a next action raises attention (no score change)', () => {
    const advanced = calculateLeadQuality({ status: 'Interested', now: NOW });
    assert.equal(advanced.score, 50);
    assert.deepEqual(advanced.attentionReasons, ['No next action scheduled for Interested lead']);
    const early = calculateLeadQuality({ status: 'Contacted', now: NOW });
    assert.equal(early.score, 40);
    assert.deepEqual(early.attentionReasons, []);
  });

  it('composite Hot case reconciles and sorts factors by impact', () => {
    const r = calculateLeadQuality({
      status: 'Pipeline Locked',
      createdAt: '2026-09-12T00:30:00Z',
      meaningfulEngagementCount: 2,
      nextFollowUpAt: '2026-09-20T00:00:00Z',
      hasInvestmentAmount: true,
      investmentAmount: 25000,
      now: NOW,
    });
    // 35 + 35 + 5 + 6 + 5 + 3 = 89
    assert.equal(r.score, 89);
    assert.equal(r.band, 'Hot');
    assert.deepEqual(r.positiveFactors.map(f => f.points), [35, 6, 5, 5, 3]);
    assert.ok(reconcileQualityFactors(r).matches);
  });

  it('deep-negative totals clamp to 0 and still reconcile', () => {
    const r = calculateLeadQuality({
      status: 'No Response',
      createdAt: '2026-07-01T12:00:00Z',
      failedContactCount: 5,
      nextFollowUpAt: '2026-09-02T00:00:00Z',
      now: NOW,
    });
    // 35 - 8 - 22 - 9 - 15 = -19 -> 0
    assert.equal(r.score, 0);
    assert.equal(r.band, 'Cold');
    assert.equal(r.attentionReasons.length, 3);
    assert.ok(reconcileQualityFactors(r).matches);
  });

  it('is deterministic for identical input and honors the injected clock', () => {
    const input = {
      status: 'Meeting Fixed',
      createdAt: '2026-09-12T00:30:00Z',
      meaningfulEngagementCount: 2,
      now: NOW,
    };
    assert.deepEqual(calculateLeadQuality(input), calculateLeadQuality(input));
    const later = calculateLeadQuality({ ...input, now: '2026-10-30T06:00:00Z' });
    // Same lead 48 days later is stale: 35 + 20 + 6 - 22 = 39
    assert.equal(later.score, 39);
    assert.ok(later.attentionReasons.some(r => r.includes('going stale')));
  });

  it('toCompactQuality strips the explanation to score + band', () => {
    const full = calculateLeadQuality({ status: 'Interested', now: NOW });
    assert.deepEqual(toCompactQuality(full), { score: 50, band: 'Developing' });
  });
});

describe('Lead Quality — investment parsing and row adapters', () => {
  it('parseExplicitInvestmentAmount only honors real positive amounts', () => {
    assert.deepEqual(parseExplicitInvestmentAmount(50000, undefined), { hasAmount: true, amount: 50000 });
    assert.deepEqual(parseExplicitInvestmentAmount('12000', undefined), { hasAmount: true, amount: 12000 });
    assert.deepEqual(parseExplicitInvestmentAmount(0, undefined), { hasAmount: false, amount: null });
    assert.deepEqual(parseExplicitInvestmentAmount('', null), { hasAmount: false, amount: null });
    assert.deepEqual(parseExplicitInvestmentAmount(NaN, undefined), { hasAmount: false, amount: null });
    assert.deepEqual(parseExplicitInvestmentAmount(null, '25,000'), { hasAmount: true, amount: 25000 });
    assert.deepEqual(parseExplicitInvestmentAmount(null, 75000), { hasAmount: true, amount: 75000 });
    assert.deepEqual(parseExplicitInvestmentAmount(null, 'abc'), { hasAmount: false, amount: null });
    assert.deepEqual(parseExplicitInvestmentAmount(null, 0), { hasAmount: false, amount: null });
  });

  it('leadSignalKey prefers dbId, then id', () => {
    assert.equal(leadSignalKey({ dbId: 'x', id: 'y' }), 'x');
    assert.equal(leadSignalKey({ id: 'y' }), 'y');
    assert.equal(leadSignalKey({}), '');
  });

  it('qualityInputFromRow maps snake_case PostgreSQL rows', () => {
    const input = qualityInputFromRow(
      {
        current_status: 'Interested',
        last_contacted_at: '2026-09-12T00:30:00Z',
        created_at: '2026-09-01T00:00:00Z',
        next_follow_up_at: '2026-09-20T00:00:00Z',
        expected_premium: 1000,
      },
      { lastActivityAt: null, failedContactCount: 2, meaningfulEngagementCount: 1 },
      { nextScheduledAt: null },
      NOW
    );
    assert.equal(input.status, 'Interested');
    assert.equal(input.failedContactCount, 2);
    assert.equal(input.meaningfulEngagementCount, 1);
    assert.equal(input.hasInvestmentAmount, true);
    assert.equal(input.investmentAmount, 1000);
    assert.ok(input.lastContactedAt instanceof Date);
  });

  it('qualityInputFromRow maps camelCase fallback rows identically', () => {
    const snake = qualityInputFromRow(
      { current_status: 'Contacted', created_at: '2026-09-12T00:30:00Z', custom_fields: { interestedAmount: '9000' } },
      undefined,
      undefined,
      NOW
    );
    const camel = qualityInputFromRow(
      { currentStatus: 'Contacted', creationDate: '2026-09-12T00:30:00Z', customFields: { interestedAmount: '9000' } },
      undefined,
      undefined,
      NOW
    );
    assert.deepEqual(camel, snake);
    assert.equal(camel.hasInvestmentAmount, true);
  });

  it('scoreLeadRow / compactScoreLeadRow compose row + signals without I/O', () => {
    const row = {
      current_status: 'Pipeline Locked',
      created_at: '2026-09-12T00:30:00Z',
      next_follow_up_at: '2026-09-20T00:00:00Z',
    };
    const full = scoreLeadRow(row, undefined, undefined, NOW);
    assert.equal(full.score, 80);
    assert.equal(full.band, 'Hot');
    assert.equal(full.positiveFactors.length, 3);
    assert.deepEqual(compactScoreLeadRow(row, undefined, undefined, NOW), { score: 80, band: 'Hot' });
  });
});

describe('Lead Quality — bulk signal fetches (stub pool)', () => {
  it('empty id sets never touch the pool', async () => {
    const explosive = { query: async () => { throw new Error('must not query'); } };
    assert.equal((await fetchActivityQualitySignals(explosive as any, [])).size, 0);
    assert.equal((await fetchScheduledQualitySignals(explosive as any, [])).size, 0);
  });

  it('activity rows map to recency/failed/meaningful signals', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            lead_id: 'lead-1',
            last_activity_at: '2026-09-11T00:00:00Z',
            failed_contact_count: 2,
            meaningful_engagement_count: 1,
          },
        ],
      }),
    };
    const map = await fetchActivityQualitySignals(pool as any, ['lead-1']);
    assert.deepEqual(map.get('lead-1'), {
      lastActivityAt: '2026-09-11T00:00:00.000Z',
      failedContactCount: 2,
      meaningfulEngagementCount: 1,
    });
  });

  it('scheduled rows map to the earliest pending action', async () => {
    const pool = {
      query: async () => ({
        rows: [{ lead_id: 'lead-1', next_scheduled_at: '2026-09-15T00:00:00Z' }],
      }),
    };
    const map = await fetchScheduledQualitySignals(pool as any, ['lead-1']);
    assert.deepEqual(map.get('lead-1'), { nextScheduledAt: '2026-09-15T00:00:00.000Z' });
  });

  it('signal failures degrade to neutral instead of throwing', async () => {
    const failing = { query: async () => { throw new Error('relation gone'); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await fetchActivityQualitySignals(failing as any, ['lead-1'])).size, 0);
      assert.equal((await fetchScheduledQualitySignals(failing as any, ['lead-1'])).size, 0);
    } finally {
      console.warn = warn;
    }
  });
});

describe('Lead Quality — dashboard aggregates (stub pool)', () => {
  const L1 = '11111111-1111-1111-1111-111111111111';
  const L2 = '22222222-2222-2222-2222-222222222222';
  const L3 = '33333333-3333-3333-3333-333333333333';
  const L4 = '44444444-4444-4444-4444-444444444444';

  function stubPool(captured: { sql: string[]; params: any[][] }) {
    return {
      query: async (sql: string, params?: any[]) => {
        captured.sql.push(sql);
        captured.params.push(params || []);
        if (sql.includes('FROM leads')) {
          return {
            rows: [
              {
                id: L1,
                current_status: 'Pipeline Locked',
                next_follow_up_at: '2026-09-20T00:00:00Z',
                last_contacted_at: null,
                created_at: '2026-09-12T00:30:00Z',
                expected_premium: null,
                interested_amount_raw: null,
              },
              {
                id: L2,
                current_status: 'Meeting Completed',
                next_follow_up_at: null,
                last_contacted_at: null,
                created_at: '2026-09-12T00:30:00Z',
                expected_premium: null,
                interested_amount_raw: null,
              },
              {
                id: L3,
                current_status: 'No Response',
                next_follow_up_at: null,
                last_contacted_at: null,
                created_at: '2026-07-01T12:00:00Z',
                expected_premium: null,
                interested_amount_raw: null,
              },
              {
                id: L4,
                current_status: 'Converted',
                next_follow_up_at: null,
                last_contacted_at: null,
                created_at: '2026-09-12T00:30:00Z',
                expected_premium: null,
                interested_amount_raw: null,
              },
            ],
          };
        }
        if (sql.includes('lead_activities')) {
          return {
            rows: [
              {
                lead_id: L3,
                last_activity_at: '2026-07-02T00:00:00Z',
                failed_contact_count: 3,
                meaningful_engagement_count: 0,
              },
            ],
          };
        }
        if (sql.includes('scheduled_activities')) {
          return { rows: [{ lead_id: L1, next_scheduled_at: '2026-09-25T00:00:00Z' }] };
        }
        throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
      },
    };
  }

  it('emptyQualityDashboard is the zero aggregate', () => {
    assert.deepEqual(emptyQualityDashboard(), {
      hot: 0, warm: 0, developing: 0, cold: 0,
      activeAverage: null, activeScored: 0, needsAttention: 0,
    });
  });

  it('aggregateQualityForScope scores visible actives with 3 bounded queries', async () => {
    const captured: { sql: string[]; params: any[][] } = { sql: [], params: [] };
    const agg = await aggregateQualityForScope(
      stubPool(captured) as any,
      'l.assigned_to = $1',
      ['user-1'],
      ['Converted', 'Not Interested'],
      NOW
    );
    // L1: 35+35+5+5 = 80 Hot · L2: 35+25+5 = 65 Warm (+attention: no next
    // action) · L3: 35-8-22-9 -> 0 Cold (+attention) · L4 terminal: skipped
    assert.deepEqual(agg, {
      hot: 1, warm: 1, developing: 0, cold: 1,
      activeAverage: 48.3, activeScored: 3, needsAttention: 2,
    });
    assert.equal(captured.sql.length, 3);
    assert.ok(captured.sql[0].includes('l.assigned_to = $1'), 'visibility clause embedded');
    assert.ok(captured.sql[0].includes('$2::text[]'), 'terminal exclusion parameterized');
    assert.deepEqual(captured.params[0], ['user-1', ['Converted', 'Not Interested']]);
  });

  it('aggregateQualityForScope degrades to zeros when the scan fails', async () => {
    const failing = { query: async () => { throw new Error('down'); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(
        await aggregateQualityForScope(failing as any, 'TRUE', [], ['Converted'], NOW),
        emptyQualityDashboard()
      );
    } finally {
      console.warn = warn;
    }
  });
});

describe('Lead Quality — fallback (demo-mode) aggregates', () => {
  const leads = [
    {
      id: 'f1', currentStatus: 'Pipeline Locked',
      creationDate: '2026-09-12T00:30:00Z', nextFollowUpAt: '2026-09-20T00:00:00Z',
    },
    { id: 'f2', currentStatus: 'Converted', creationDate: '2026-09-12T00:30:00Z' },
    { id: 'f3', currentStatus: 'No Response', creationDate: '2026-07-01T12:00:00Z' },
    { id: 'f4', currentStatus: 'Contacted', is_deleted: true },
  ];
  const activities = [
    { leadId: 'f3', status: 'No Response', createdAt: '2026-07-02T00:00:00Z' },
    { leadId: 'f3', status: 'No Response', createdAt: '2026-07-03T00:00:00Z' },
    { leadId: 'f3', status: 'Unreachable', createdAt: '2026-07-04T00:00:00Z' },
  ];

  it('aggregateQualityForFallbackLeads matches the database formula', () => {
    const agg = aggregateQualityForFallbackLeads(leads, activities, [], NOW);
    // f1: 80 Hot · f2 terminal skipped · f3: 35-8-22-9 -> 0 Cold · f4 deleted skipped
    assert.deepEqual(agg, {
      hot: 1, warm: 0, developing: 0, cold: 1,
      activeAverage: 40, activeScored: 2, needsAttention: 1,
    });
  });

  it('compactQualityForFallbackLeads keys compact scores by lead id', () => {
    const map = compactQualityForFallbackLeads(leads, activities, [], NOW);
    assert.deepEqual(map.get('f1'), { score: 80, band: 'Hot' });
    assert.deepEqual(map.get('f3'), { score: 0, band: 'Cold' });
    assert.deepEqual(map.get('f2'), { score: 100, band: 'Converted' });
    assert.deepEqual(Object.keys(map.get('f1') || {}).sort(), ['band', 'score']);
  });

  it('scoreFallbackLead returns the full explanation for one lead', () => {
    const r = scoreFallbackLead(leads[0], activities, [], NOW);
    assert.equal(r.score, 80);
    assert.equal(r.band, 'Hot');
    assert.equal(r.isTerminal, false);
    assert.equal(r.positiveFactors.length, 3);
    assert.ok(reconcileQualityFactors(r).matches);
  });
});

describe('Lead Quality — route wiring guards', () => {
  const routes = () => read('server/routes/production.routes.ts');

  it('quality endpoint, filters, sorts, and aggregates are wired', () => {
    const src = routes();
    assert.ok(src.includes("'/leads/:id/quality'"), 'GET /leads/:id/quality must exist');
    assert.ok(src.includes('quality_desc'), 'quality_desc sort must exist');
    assert.ok(src.includes('quality_asc'), 'quality_asc sort must exist');
    assert.ok(src.includes('qualityBand'), 'qualityBand filter must exist');
    assert.ok(src.includes('aggregateQualityForScope'), 'dashboard aggregate must be wired');
    assert.ok(src.includes('compactScoreLeadRow'), 'compact list scoring must be wired');
    assert.ok(src.includes('scoreFallbackLead'), 'demo-mode parity must be wired');
    assert.ok(src.includes('leadQuality'), 'leadQuality payload key must be wired');
  });

  it('no new score column: migrations add no quality/score column to leads', () => {
    const dir = path.join(ROOT, 'server/database/migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
    assert.ok(files.length > 0, 'migrations directory must be readable');
    for (const file of files) {
      assert.ok(!/quality/i.test(file), `${file} must not be a quality migration`);
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      assert.ok(
        !/ADD\s+(COLUMN\s+)?["']?\w*(quality|score)/i.test(src),
        `${file} must not add a quality/score column (scoring is read-time)`
      );
    }
  });
});

describe('Lead Quality — frontend never scores (source guards)', () => {
  const FRONTEND_FILES = [
    'src/modules/leads/components/LeadQualityBadge.tsx',
    'src/modules/leads/components/LeadQualityPanel.tsx',
    'src/modules/leads/pages/LeadList.tsx',
    'src/modules/leads/pages/Lead360.tsx',
    'src/modules/workbench/pages/DailyWorkbench.tsx',
    'src/modules/dashboard/pages/Dashboard.tsx',
    'src/modules/dashboard/services/dashboardService.ts',
    'src/modules/leads/services/leadService.ts',
    'src/modules/scheduledActivities/services/scheduledActivityService.ts',
  ];
  // Weight/threshold/scorer identifiers that must never appear in the client.
  // (LEAD_QUALITY_BADGE_CLASSES is CSS only and therefore allowlisted.)
  const FORBIDDEN = [
    'calculateLeadQuality',
    'scoreLeadRow',
    'qualityInputFromRow',
    'bandForScore',
    'reconcileQualityFactors',
    'LEAD_QUALITY_BASE',
    'LEAD_QUALITY_THRESHOLD',
    'LEAD_QUALITY_STATUS',
    'LEAD_QUALITY_ENGAGEMENT',
    'LEAD_QUALITY_FAILED',
    'LEAD_QUALITY_INVESTMENT',
    'LEAD_QUALITY_MIN',
    'LEAD_QUALITY_MAX',
  ];

  it('no scorer, weights, or thresholds in client code', () => {
    for (const file of FRONTEND_FILES) {
      const src = stripComments(read(file));
      for (const token of FORBIDDEN) {
        assert.ok(!src.includes(token), `${file} must not contain ${token}`);
      }
    }
  });

  it('badge renders server values only', () => {
    const src = stripComments(read('src/modules/leads/components/LeadQualityBadge.tsx'));
    assert.ok(src.includes('quality.score'), 'badge must render quality.score');
    assert.ok(src.includes('quality.band'), 'badge must render quality.band');
  });

  it('workbench prioritizes over loaded items without per-item detail fetches', () => {
    const src = stripComments(read('src/modules/workbench/pages/DailyWorkbench.tsx'));
    assert.ok(src.includes('qualityFilteredItems'), 'workbench must narrow the loaded queue by quality');
    assert.ok(!src.includes('getLeadQuality('), 'workbench must not fetch per-item quality (no N+1)');
    assert.ok(!src.includes('getLeads('), 'workbench must not fetch the full lead list');
  });

  it('dashboard consumes only the server aggregate', () => {
    const src = stripComments(read('src/modules/dashboard/pages/Dashboard.tsx'));
    assert.ok(src.includes('metrics?.quality'), 'dashboard must render metrics.quality');
    assert.ok(!src.includes('getLeadQuality('), 'dashboard must not fetch per-item quality');
  });

  it('lead workspace lazily loads single-lead explanations through the reader', () => {
    const src = stripComments(read('src/modules/leads/pages/LeadList.tsx'));
    assert.ok(src.includes('getLeadQuality'), 'workspace modal must use the getLeadQuality reader');
  });
});

describe('Lead Quality — documentation guard', () => {
  it('docs/LEAD_QUALITY_SCORING.md documents the contract', () => {
    const doc = read('docs/LEAD_QUALITY_SCORING.md');
    for (const token of [
      'LEAD_QUALITY_BASE_SCORE',
      'score = clamp',
      'Converted',
      'Not Interested',
      'GET /api/leads/:id/quality',
      'qualityBand',
      'aggregateQualityForScope',
    ]) {
      assert.ok(doc.includes(token), `doc must document ${token}`);
    }
  });
});
