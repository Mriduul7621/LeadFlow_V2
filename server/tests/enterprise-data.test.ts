/**
 * enterprise-data.test.ts
 * ------------------------------------------------------------------
 * Pure data shaping for the enterprise role homes (Enterprise
 * Preview redesign, 2026-11-19): every helper in
 * src/modules/workspace/utils/enterpriseData.ts is pure and
 * timezone-explicit (Asia/Dhaka, UTC+6 year-round, no DST).
 *
 * Every assertion here uses EXPLICIT timestamps, never "now", so
 * the whole file holds under TZ=UTC and under TZ=Asia/Dhaka alike
 * (run it under both). The Dhaka-midnight edge — 18:00 UTC is
 * 00:00 the next day in Dhaka — is pinned at both sides.
 *
 * Removed 2026-11-20 (Team Lead / Manager / Admin workspace):
 * buildNext7Days + DayBucket — the 7-day chart pipeline is gone
 * (the homes chart team activity from the loaded leads list via
 * activityBuckets), so its describe went with it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversionShare,
  dhakaDayKey,
  dhakaDayLabel,
  dhakaDayStartMs,
  dhakaYmdParts,
  dueLabel,
  formatDhakaShort,
  formatDhakaTime,
  formatPercent,
  largestOpenStatus,
  money,
  resolveTerminalNames,
} from '../../src/modules/workspace/utils/enterpriseData';
import type { DropdownOption } from '../../src/modules/shared/types';

// Noon Dhaka, Thursday 19 November 2026.
const NOON_19_NOV = new Date('2026-11-19T06:00:00.000Z');

const statusOption = (label: string, isTerminal?: boolean): DropdownOption =>
  ({
    type: 'FollowUpStatus',
    value: label,
    label,
    status: 'Active',
    ...(isTerminal === undefined ? {} : { meta: { isTerminal } }),
  });

describe('enterpriseData — Dhaka day arithmetic', () => {
  it('dhakaDayKey follows the Dhaka calendar day, not the UTC day', () => {
    // 23:30 Dhaka on the 18th is still the 18th in Dhaka…
    assert.equal(dhakaDayKey(new Date('2026-11-18T17:30:00.000Z')), '2026-11-18');
    // …but 00:30 Dhaka is already the 19th, though UTC still says 18th.
    assert.equal(dhakaDayKey(new Date('2026-11-18T18:30:00.000Z')), '2026-11-19');
    assert.equal(dhakaDayKey(NOON_19_NOV), '2026-11-19');
  });

  it('dhakaYmdParts splits at the Dhaka midnight (18:00 UTC)', () => {
    assert.deepEqual(dhakaYmdParts(new Date('2026-11-18T17:59:59.000Z')), { y: 2026, m: 11, d: 18 });
    assert.deepEqual(dhakaYmdParts(new Date('2026-11-18T18:00:00.000Z')), { y: 2026, m: 11, d: 19 });
  });

  it('dhakaDayStartMs is midnight Dhaka (18:00 UTC the previous day)', () => {
    assert.equal(dhakaDayStartMs(NOON_19_NOV), Date.parse('2026-11-18T18:00:00.000Z'));
    assert.equal(
      dhakaDayStartMs(new Date('2026-11-19T23:30:00.000Z')),
      Date.parse('2026-11-19T18:00:00.000Z'),
      'late evening Dhaka is the NEXT Dhaka day'
    );
  });

  it('dhakaDayLabel renders "Thu 19" style labels', () => {
    assert.equal(dhakaDayLabel('2026-11-19'), 'Thu 19');
    assert.equal(dhakaDayLabel('2026-11-25'), 'Wed 25');
  });

  it('formatDhakaShort / formatDhakaTime render in Dhaka terms', () => {
    assert.equal(formatDhakaShort('2026-11-12T00:00:00.000Z'), '12 Nov');
    // 04:30 UTC is 10:30 in Dhaka (en-GB hour12 renders "am").
    assert.match(formatDhakaTime('2026-11-19T04:30:00.000Z'), /^10:30\s?am$/i);
  });
});

describe('enterpriseData — dueLabel', () => {
  it('overdue items count whole Dhaka days past the due day', () => {
    assert.equal(dueLabel('2026-11-17T09:00:00.000Z', NOON_19_NOV), 'Overdue · 2 days');
    assert.equal(dueLabel('2026-11-18T09:00:00.000Z', NOON_19_NOV), 'Overdue · 1 day');
  });

  it('today shows the Dhaka time, tomorrow is just "Tomorrow"', () => {
    assert.match(dueLabel('2026-11-19T04:30:00.000Z', NOON_19_NOV), /^Today · 10:30\s?am$/i);
    assert.equal(dueLabel('2026-11-20T04:00:00.000Z', NOON_19_NOV), 'Tomorrow');
    // Midnight Dhaka belongs to the new day.
    assert.equal(dueLabel('2026-11-19T18:00:00.000Z', NOON_19_NOV), 'Tomorrow');
  });

  it('later dates render as a short Dhaka date; invalid input renders empty', () => {
    assert.equal(dueLabel('2026-11-25T04:00:00.000Z', NOON_19_NOV), '25 Nov');
    assert.equal(dueLabel('2026-12-01T04:00:00.000Z', NOON_19_NOV), '1 Dec');
    assert.equal(dueLabel('not-a-date', NOON_19_NOV), '');
  });
});

describe('enterpriseData — money and percents', () => {
  it('money is always ৳ (BDT), grouped, rounded — never $', () => {
    assert.equal(money(0), '৳0');
    assert.equal(money(1234567), '৳1,234,567');
    assert.equal(money(999.6), '৳1,000');
    assert.equal(money(Number.NaN), '৳0');
    for (const value of [0, 42, 1234567, 999.6]) {
      assert.ok(!money(value).includes('$'), `money(${value}) carries no dollar sign`);
      assert.ok(money(value).startsWith('৳'), `money(${value}) starts with ৳`);
    }
  });

  it('formatPercent renders one decimal; non-finite input is 0%', () => {
    assert.equal(formatPercent(18.64), '18.6%');
    assert.equal(formatPercent(0), '0.0%');
    assert.equal(formatPercent(100), '100.0%');
    assert.equal(formatPercent(Number.NaN), '0%');
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), '0%');
  });

  it('conversionShare is the converted share of decided leads (0 when there are none)', () => {
    assert.ok(Math.abs(conversionShare(3, 7) - 0.3) < 1e-12);
    assert.equal(conversionShare(0, 0), 0);
    assert.equal(conversionShare(5, 0), 1);
    assert.equal(conversionShare(0, 5), 0);
  });
});

describe('enterpriseData — terminal statuses and the pipeline bottleneck', () => {
  it('an empty dictionary falls back to the canonical terminal names', () => {
    assert.deepEqual([...resolveTerminalNames([])].sort(), ['Converted', 'Not Interested']);
    assert.deepEqual([...resolveTerminalNames()].sort(), ['Converted', 'Not Interested']);
  });

  it('an explicit meta.isTerminal is honoured over the name fallback', () => {
    const names = resolveTerminalNames([
      statusOption('Converted', false), // explicitly NOT terminal
      statusOption('Pipeline Locked', true), // explicitly terminal
      statusOption('Interested'), // no meta, not a canonical name
      statusOption('Not Interested'), // no meta, canonical name
    ]);
    assert.equal(names.has('Converted'), false, 'the explicit false wins over the name');
    assert.equal(names.has('Pipeline Locked'), true, 'the explicit true wins over the name');
    assert.equal(names.has('Interested'), false);
    assert.equal(names.has('Not Interested'), true, 'the canonical fallback applies when meta is missing');
  });

  it('a terminal status is NEVER the bottleneck, however many leads it holds', () => {
    assert.deepEqual(
      largestOpenStatus({ Converted: 100, 'Not Interested': 50, Interested: 5 }, []),
      { name: 'Interested', count: 5 }
    );
    assert.equal(
      largestOpenStatus({ Converted: 100, 'Not Interested': 50 }, []),
      null,
      'all-terminal means no bottleneck at all'
    );
  });

  it('largestOpenStatus returns the biggest OPEN status, ignoring zeros and empties', () => {
    assert.deepEqual(
      largestOpenStatus({ New: 10, 'Follow-up Set': 25, Converted: 99, Interested: 0 }, []),
      { name: 'Follow-up Set', count: 25 }
    );
    assert.equal(largestOpenStatus({}, []), null);
    assert.equal(largestOpenStatus({ Interested: 0 }, []), null);
  });

  it('a dictionary-marked terminal status is excluded even when it is the largest', () => {
    assert.deepEqual(
      largestOpenStatus(
        { 'Follow-up Set': 90, New: 10 },
        [statusOption('Follow-up Set', true), statusOption('New', false)]
      ),
      { name: 'New', count: 10 }
    );
  });
});
