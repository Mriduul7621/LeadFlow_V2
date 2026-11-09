/**
 * calendar-ui-rebuild.test.ts
 * ------------------------------------------------------------------
 * Unit tests for the pure helpers behind the Microsoft-style Task
 * Calendar rebuild (calendar upgrade PR D): src/modules/calendar/
 * utils/calendarLayout.ts. The page component is a thin shell over
 * these helpers, so the rules Mahadi approved are pinned here:
 *
 *   - Work week = every weekday NOT in the configured weekend
 *     (Calendar Settings, PR C). Bangladesh default Fri+Sat →
 *     Sun–Thu columns; an empty weekend yields the full week; a
 *     degenerate all-week weekend falls back to 7 columns so the
 *     grid never renders nothing.
 *   - Category mapping (PR B data model): a meeting WITH a lead is
 *     a customer meeting, a lead-less meeting is a team meeting.
 *   - Overlap layout: side-by-side columns per overlap cluster;
 *     touching endpoints do not overlap.
 *   - Slot → prefill: clicking an empty time-grid slot produces
 *     the create form's date/start/end (30-minute default, clamped
 *     at the day edge).
 *   - Form-kind rules mirroring the PR B server rules: follow_up /
 *     call / customer meeting require a lead; a team meeting is a
 *     lead-less meeting.
 *   - PR A managed entries are detected via source_activity_id.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryOfScheduled,
  isManagedEntry,
  sanitizeWeekendDays,
  deriveWorkWeekDays,
  weekDatesContaining,
  visibleWeekDates,
  minutesOfDay,
  eventSpan,
  layoutDayEvents,
  slotPrefill,
  toDateStr,
  apiTypeForKind,
  kindRequiresLead,
  kindForCategory,
} from '../../src/modules/calendar/utils/calendarLayout';

describe('deriveWorkWeekDays — configured weekend drives the Work week view', () => {
  it('Bangladesh default Fri+Sat weekend → Sun–Thu working days', () => {
    assert.deepEqual(deriveWorkWeekDays([5, 6]), [0, 1, 2, 3, 4]);
  });

  it('empty weekend → all seven days are working days', () => {
    assert.deepEqual(deriveWorkWeekDays([]), [0, 1, 2, 3, 4, 5, 6]);
  });

  it('Sat+Sun weekend → Mon–Fri working days', () => {
    assert.deepEqual(deriveWorkWeekDays([6, 0]), [1, 2, 3, 4, 5]);
  });

  it('all-week weekend → no working days (view falls back, see visibleWeekDates)', () => {
    assert.deepEqual(deriveWorkWeekDays([0, 1, 2, 3, 4, 5, 6]), []);
  });

  it('sanitizes duplicates, out-of-range and non-integer input', () => {
    assert.deepEqual(sanitizeWeekendDays([5, 5, 6, 7, -1, 2.5, 'x']), [5, 6]);
    assert.deepEqual(deriveWorkWeekDays([5, 5, 6, 99]), [0, 1, 2, 3, 4]);
  });

  it('non-array config → no weekend days sanitized, full work week derived', () => {
    assert.deepEqual(sanitizeWeekendDays(undefined), []);
    assert.deepEqual(sanitizeWeekendDays('fri'), []);
    assert.deepEqual(deriveWorkWeekDays(null), [0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('visibleWeekDates — week anchoring and work-week filtering', () => {
  // Wednesday 2026-11-11; its Sunday-first week is Nov 8 – Nov 14.
  const anchor = new Date(2026, 10, 11);

  it('week view returns the full Sunday-first week containing the anchor', () => {
    const days = weekDatesContaining(anchor);
    assert.equal(days.length, 7);
    assert.equal(toDateStr(days[0]), '2026-11-08');
    assert.equal(toDateStr(days[6]), '2026-11-14');
  });

  it('week view ignores the weekend config', () => {
    assert.equal(visibleWeekDates(anchor, [5, 6], false).length, 7);
  });

  it('work week keeps Sun–Thu under the Fri+Sat weekend', () => {
    const days = visibleWeekDates(anchor, [5, 6], true);
    assert.deepEqual(days.map(toDateStr), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('work week with an empty weekend shows all seven days', () => {
    assert.equal(visibleWeekDates(anchor, [], true).length, 7);
  });

  it('degenerate all-week weekend falls back to the full week (never zero columns)', () => {
    assert.equal(visibleWeekDates(anchor, [0, 1, 2, 3, 4, 5, 6], true).length, 7);
  });

  it('an anchor ON the weekend still shows the surrounding work week', () => {
    const saturday = new Date(2026, 10, 14);
    const days = visibleWeekDates(saturday, [5, 6], true);
    assert.deepEqual(days.map(toDateStr), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  });
});

describe('categoryOfScheduled — PR B data model mapping', () => {
  it('follow_up and call map directly', () => {
    assert.equal(categoryOfScheduled({ activityType: 'follow_up', leadId: 'L1' }), 'followup');
    assert.equal(categoryOfScheduled({ activityType: 'call', leadId: 'L1' }), 'call');
    assert.equal(categoryOfScheduled({ activityType: 'task', leadId: null }), 'task');
  });

  it('a meeting WITH a lead is a customer meeting', () => {
    assert.equal(categoryOfScheduled({ activityType: 'meeting', leadId: 'L1' }), 'customer_meeting');
    assert.equal(categoryOfScheduled({ activity_type: 'meeting', lead_id: 'L1' }), 'customer_meeting');
  });

  it('a lead-less meeting is a team meeting', () => {
    assert.equal(categoryOfScheduled({ activityType: 'meeting', leadId: null }), 'team_meeting');
    assert.equal(categoryOfScheduled({ activity_type: 'meeting', lead_id: null }), 'team_meeting');
    assert.equal(categoryOfScheduled({ activityType: 'meeting' }), 'team_meeting');
  });

  it('unknown / missing types fall back to followup (the calendar default)', () => {
    assert.equal(categoryOfScheduled({ activityType: 'something_else', leadId: 'L1' }), 'followup');
    assert.equal(categoryOfScheduled({}), 'followup');
  });
});

describe('isManagedEntry — PR A next-step sync ownership', () => {
  it('detects camelCase and snake_case provenance', () => {
    assert.equal(isManagedEntry({ sourceActivityId: 'a1' }), true);
    assert.equal(isManagedEntry({ source_activity_id: 'a1' }), true);
  });

  it('plain entries are not managed', () => {
    assert.equal(isManagedEntry({ sourceActivityId: null }), false);
    assert.equal(isManagedEntry({}), false);
  });
});

describe('eventSpan — time-grid spans', () => {
  it('uses the stored duration when valid', () => {
    const start = new Date(2026, 10, 9, 10, 30);
    assert.deepEqual(eventSpan(start, 45), { startMin: 630, endMin: 675 });
  });

  it('defaults to 30 minutes when duration is missing or invalid', () => {
    const start = new Date(2026, 10, 9, 9, 0);
    assert.deepEqual(eventSpan(start, null), { startMin: 540, endMin: 570 });
    assert.deepEqual(eventSpan(start, 0), { startMin: 540, endMin: 570 });
    assert.deepEqual(eventSpan(start, undefined), { startMin: 540, endMin: 570 });
  });

  it('clamps the end at midnight and never returns a zero-length span', () => {
    const late = new Date(2026, 10, 9, 23, 50);
    const span = eventSpan(late, 60);
    assert.equal(span.endMin, 1440);
    assert.ok(span.endMin > span.startMin);
  });

  it('minutesOfDay reads local clock time', () => {
    assert.equal(minutesOfDay(new Date(2026, 10, 9, 0, 0)), 0);
    assert.equal(minutesOfDay(new Date(2026, 10, 9, 13, 15)), 795);
  });
});

describe('layoutDayEvents — overlap columns', () => {
  const ev = (id: string, startMin: number, endMin: number) => ({ id, startMin, endMin });

  it('non-overlapping events each get a single full-width column', () => {
    const layout = layoutDayEvents([ev('a', 540, 570), ev('b', 600, 630), ev('c', 660, 690)]);
    for (const id of ['a', 'b', 'c']) assert.deepEqual(layout.get(id), { column: 0, columns: 1 });
  });

  it('two overlapping events split into two columns', () => {
    const layout = layoutDayEvents([ev('a', 540, 600), ev('b', 570, 630)]);
    assert.deepEqual(layout.get('a'), { column: 0, columns: 2 });
    assert.deepEqual(layout.get('b'), { column: 1, columns: 2 });
  });

  it('three mutually overlapping events take three columns', () => {
    const layout = layoutDayEvents([ev('a', 540, 660), ev('b', 570, 690), ev('c', 600, 720)]);
    assert.equal(layout.get('a')?.columns, 3);
    assert.equal(layout.get('b')?.columns, 3);
    assert.equal(layout.get('c')?.columns, 3);
    assert.deepEqual([layout.get('a')?.column, layout.get('b')?.column, layout.get('c')?.column], [0, 1, 2]);
  });

  it('a chain (A∩B, B∩C, A∁C) reuses the freed column inside one cluster', () => {
    const layout = layoutDayEvents([ev('a', 540, 600), ev('b', 570, 660), ev('c', 630, 690)]);
    assert.equal(layout.get('a')?.columns, 2);
    assert.equal(layout.get('b')?.columns, 2);
    assert.deepEqual(layout.get('c'), { column: 0, columns: 2 });
  });

  it('touching endpoints (end == start) do NOT overlap', () => {
    const layout = layoutDayEvents([ev('a', 540, 600), ev('b', 600, 660)]);
    assert.deepEqual(layout.get('a'), { column: 0, columns: 1 });
    assert.deepEqual(layout.get('b'), { column: 0, columns: 1 });
  });

  it('separate clusters report their own column counts', () => {
    const layout = layoutDayEvents([
      ev('a', 540, 600), ev('b', 570, 630), // cluster of 2
      ev('c', 900, 960), // alone
    ]);
    assert.equal(layout.get('a')?.columns, 2);
    assert.deepEqual(layout.get('c'), { column: 0, columns: 1 });
  });

  it('input order does not matter (sorted internally by start, longer first)', () => {
    const layout = layoutDayEvents([ev('short', 570, 600), ev('long', 540, 660)]);
    assert.deepEqual(layout.get('long'), { column: 0, columns: 2 });
    assert.deepEqual(layout.get('short'), { column: 1, columns: 2 });
  });
});

describe('slotPrefill — empty-slot click → create form values', () => {
  const day = new Date(2026, 10, 12); // Thursday

  it('produces date + start + 30-minute default end', () => {
    assert.deepEqual(slotPrefill(day, 10), { date: '2026-11-12', startTime: '10:00', endTime: '10:30' });
  });

  it('honours half-hour slots and explicit durations', () => {
    assert.deepEqual(slotPrefill(day, 14, 30, 60), { date: '2026-11-12', startTime: '14:30', endTime: '15:30' });
  });

  it('clamps the end at 23:59 near midnight', () => {
    const p = slotPrefill(day, 23, 45, 30);
    assert.equal(p.startTime, '23:45');
    assert.equal(p.endTime, '23:59');
  });

  it('zero-pads single-digit months, days, hours and minutes', () => {
    assert.deepEqual(slotPrefill(new Date(2027, 0, 5), 9, 5), { date: '2027-01-05', startTime: '09:05', endTime: '09:35' });
  });
});

describe('form-kind rules — PR B create/update contract, mirrored client-side', () => {
  it('apiTypeForKind collapses both meeting kinds to meeting', () => {
    assert.equal(apiTypeForKind('customer_meeting'), 'meeting');
    assert.equal(apiTypeForKind('team_meeting'), 'meeting');
    assert.equal(apiTypeForKind('follow_up'), 'follow_up');
    assert.equal(apiTypeForKind('call'), 'call');
    assert.equal(apiTypeForKind('task'), 'task');
  });

  it('follow_up, call and customer meeting require a lead; team meeting and task do not', () => {
    assert.equal(kindRequiresLead('follow_up'), true);
    assert.equal(kindRequiresLead('call'), true);
    assert.equal(kindRequiresLead('customer_meeting'), true);
    assert.equal(kindRequiresLead('team_meeting'), false);
    assert.equal(kindRequiresLead('task'), false);
  });

  it('kindForCategory round-trips every scheduled category', () => {
    assert.equal(kindForCategory('followup'), 'follow_up');
    assert.equal(kindForCategory('call'), 'call');
    assert.equal(kindForCategory('customer_meeting'), 'customer_meeting');
    assert.equal(kindForCategory('team_meeting'), 'team_meeting');
    assert.equal(kindForCategory('task'), 'task');
  });
});
