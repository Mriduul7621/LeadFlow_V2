/**
 * lead-column-filter-sort.test.ts
 * ------------------------------------------------------------------
 * Per-column Filter By / Sort By on the desktop lead table (Mahadi,
 * 2026-11-23 — a user asked for it): every column sorts on header
 * click (3-click cycle), Source / Owner / Created also filter via
 * a funnel panel. Desktop table only — mobile rows and the
 * workbench queue are untouched; no server changes.
 *
 *   1. Unit tests — the pure logic in leadColumnSort.ts, imported
 *      directly: the 3-click cycle, every column asc/desc (incl.
 *      the priority rank + created dates), missing-values-last in
 *      both directions, multi-select AND semantics, Created
 *      presets against Dhaka day boundaries, distinct values.
 *   2. Source guards — the headers are buttons with sort arrows;
 *      the funnel exists ONLY on Source / Owner / Created (the
 *      one-place rule: Priority / Stage / Lead already have quick
 *      filters above the table); the two SORT BY dropdowns stay in
 *      sync with the column sort; the chips row + panel exist;
 *      mobile rows, the workbench and AdvancedFilterPanel are
 *      untouched; the bulk selection (keyed by lead id) is
 *      unaffected by sorting.
 *
 * All date fixtures use explicit +06:00 offsets and the util uses
 * the existing dhakaDayStartMs helper (Asia/Dhaka, no DST), so
 * these tests are identical under TZ=UTC and TZ=Asia/Dhaka.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COLUMN_SORT_SELECT_VALUE,
  applyColumnFilters,
  columnSortLabel,
  compareLeadsByColumn,
  distinctColumnValues,
  hasActiveColumnFilters,
  matchesCreatedPreset,
  nextColumnSort,
  sortLeadsByColumn,
  toggleFilterValue,
  type ColumnFilters,
  type ColumnSort,
  type CreatedPreset,
} from '../../src/modules/leads/utils/leadColumnSort.js';
import type { Lead } from '../../src/modules/shared/types';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Minimal Lead fixture — only the fields the column logic reads vary. */
function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    creationDate: '2026-11-20T10:00:00+06:00',
    prospectName: 'Test Prospect',
    mobile: '01700000000',
    profession: 'Business',
    familyMember: 'Self',
    maritalStatus: 'Single',
    hasChild: false,
    area: 'Dhaka',
    source: 'Facebook',
    productName: 'Plan A',
    campaignName: 'Campaign',
    assignedTo: '2025001',
    currentStatus: 'New',
    projectedNCP: 0,
    collectedNCP: 0,
    timestamp: '2026-11-20T10:00:00+06:00',
    ...overrides,
  } as Lead;
}

/** Owner resolver mirroring the page: roster name, else the ID, else 'Unassigned'. */
const ownerNames: Record<string, string> = {
  '2025001': 'Ahnaf Tahmid Khan',
  '2025002': 'Nafisa Maliat Wazed',
  '2025003': 'Zillur Rahman',
};
const resolveOwner = (lead: Lead): string => {
  if (!lead.assignedTo) return 'Unassigned';
  return ownerNames[lead.assignedTo] || lead.assignedTo;
};

const names = (leads: Lead[]): string[] => leads.map(l => l.prospectName);

describe('lead column sort — the 3-click cycle', () => {
  it('a fresh column starts at its natural order, then reverses, then clears', () => {
    assert.deepEqual(nextColumnSort(null, 'lead'), { key: 'lead', dir: 'asc' });
    assert.deepEqual(nextColumnSort({ key: 'lead', dir: 'asc' }, 'lead'), { key: 'lead', dir: 'desc' });
    assert.equal(nextColumnSort({ key: 'lead', dir: 'desc' }, 'lead'), null);
  });

  it('Created starts newest-first (desc), then oldest-first, then clears', () => {
    assert.deepEqual(nextColumnSort(null, 'created'), { key: 'created', dir: 'desc' });
    assert.deepEqual(nextColumnSort({ key: 'created', dir: 'desc' }, 'created'), { key: 'created', dir: 'asc' });
    assert.equal(nextColumnSort({ key: 'created', dir: 'asc' }, 'created'), null);
  });

  it('clicking a different column starts that column at its natural order', () => {
    assert.deepEqual(
      nextColumnSort({ key: 'lead', dir: 'desc' }, 'source'),
      { key: 'source', dir: 'asc' },
    );
    assert.deepEqual(
      nextColumnSort({ key: 'source', dir: 'asc' }, 'created'),
      { key: 'created', dir: 'desc' },
    );
  });

  it('the SORT BY dropdown labels the active column sort', () => {
    assert.equal(columnSortLabel({ key: 'source', dir: 'asc' }), 'Source (A–Z)');
    assert.equal(columnSortLabel({ key: 'source', dir: 'desc' }), 'Source (Z–A)');
    assert.equal(columnSortLabel({ key: 'priority', dir: 'asc' }), 'Priority (High first)');
    assert.equal(columnSortLabel({ key: 'priority', dir: 'desc' }), 'Priority (Low first)');
    assert.equal(columnSortLabel({ key: 'created', dir: 'desc' }), 'Created (Newest first)');
    assert.equal(columnSortLabel({ key: 'created', dir: 'asc' }), 'Created (Oldest first)');
    assert.equal(COLUMN_SORT_SELECT_VALUE, '__column__');
  });
});

describe('lead column sort — comparators', () => {
  it('Lead sorts A→Z then Z→A by prospect name', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'Zillur' }),
      makeLead({ id: 'b', prospectName: 'Ahnaf' }),
      makeLead({ id: 'c', prospectName: 'Nafisa' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'lead', dir: 'asc' }, resolveOwner)), ['Ahnaf', 'Nafisa', 'Zillur']);
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'lead', dir: 'desc' }, resolveOwner)), ['Zillur', 'Nafisa', 'Ahnaf']);
  });

  it('Source sorts alphabetically by the source value', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'A', source: 'Walk-in' }),
      makeLead({ id: 'b', prospectName: 'B', source: 'Facebook' }),
      makeLead({ id: 'c', prospectName: 'C', source: 'Term Policy' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'source', dir: 'asc' }, resolveOwner)), ['B', 'C', 'A']);
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'source', dir: 'desc' }, resolveOwner)), ['A', 'C', 'B']);
  });

  it('Owner sorts alphabetically by the resolved owner name (not the employee ID)', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'A', assignedTo: '2025003' }), // Zillur
      makeLead({ id: 'b', prospectName: 'B', assignedTo: '2025001' }), // Ahnaf
      makeLead({ id: 'c', prospectName: 'C', assignedTo: '' }), // Unassigned
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'owner', dir: 'asc' }, resolveOwner)), ['B', 'C', 'A']);
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'owner', dir: 'desc' }, resolveOwner)), ['A', 'C', 'B']);
  });

  it('Stage sorts alphabetically by status name', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'A', currentStatus: 'New' }),
      makeLead({ id: 'b', prospectName: 'B', currentStatus: 'Converted' }),
      makeLead({ id: 'c', prospectName: 'C', currentStatus: 'Meeting Fixed' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'stage', dir: 'asc' }, resolveOwner)), ['B', 'C', 'A']);
  });

  it('Priority sorts by rank — High, Medium, Normal, Low — unknown after the known four', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'Low-one', priority: 'Low' }),
      makeLead({ id: 'b', prospectName: 'High-one', priority: 'High' }),
      makeLead({ id: 'c', prospectName: 'Normal-one', priority: 'Normal' }),
      makeLead({ id: 'd', prospectName: 'Medium-one', priority: 'Medium' }),
      makeLead({ id: 'e', prospectName: 'Urgent-one', priority: 'Urgent' }),
    ];
    assert.deepEqual(
      names(sortLeadsByColumn(leads, { key: 'priority', dir: 'asc' }, resolveOwner)),
      ['High-one', 'Medium-one', 'Normal-one', 'Low-one', 'Urgent-one'],
    );
    assert.deepEqual(
      names(sortLeadsByColumn(leads, { key: 'priority', dir: 'desc' }, resolveOwner)),
      ['Urgent-one', 'Low-one', 'Normal-one', 'Medium-one', 'High-one'],
    );
  });

  it('Priority matches case-insensitively (HIGH sorts as High)', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'A', priority: 'Medium' }),
      makeLead({ id: 'b', prospectName: 'B', priority: 'HIGH' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'priority', dir: 'asc' }, resolveOwner)), ['B', 'A']);
  });

  it('Created sorts newest-first on desc and oldest-first on asc', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'Oldest', creationDate: '2026-11-18T09:00:00+06:00', timestamp: '2026-11-18T09:00:00+06:00' }),
      makeLead({ id: 'b', prospectName: 'Newest', creationDate: '2026-11-22T09:00:00+06:00', timestamp: '2026-11-22T09:00:00+06:00' }),
      makeLead({ id: 'c', prospectName: 'Middle', creationDate: '2026-11-20T09:00:00+06:00', timestamp: '2026-11-20T09:00:00+06:00' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'created', dir: 'desc' }, resolveOwner)), ['Newest', 'Middle', 'Oldest']);
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'created', dir: 'asc' }, resolveOwner)), ['Oldest', 'Middle', 'Newest']);
  });

  it('missing values sort LAST in both directions and never crash', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'A', source: '' }),
      makeLead({ id: 'b', prospectName: 'B', source: 'Facebook' }),
      makeLead({ id: 'c', prospectName: 'C', source: 'Walk-in' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'source', dir: 'asc' }, resolveOwner)), ['B', 'C', 'A']);
    assert.deepEqual(names(sortLeadsByColumn(leads, { key: 'source', dir: 'desc' }, resolveOwner)), ['C', 'B', 'A']);

    const noDates = [
      makeLead({ id: 'a', prospectName: 'No-date', creationDate: '', timestamp: '' }),
      makeLead({ id: 'b', prospectName: 'Dated', creationDate: '2026-11-20T09:00:00+06:00', timestamp: '2026-11-20T09:00:00+06:00' }),
      makeLead({ id: 'c', prospectName: 'Bad-date', creationDate: 'not-a-date', timestamp: 'also-bad' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(noDates, { key: 'created', dir: 'desc' }, resolveOwner)), ['Dated', 'No-date', 'Bad-date']);
    assert.deepEqual(names(sortLeadsByColumn(noDates, { key: 'created', dir: 'asc' }, resolveOwner)), ['Dated', 'No-date', 'Bad-date']);

    const noPriority = [
      makeLead({ id: 'a', prospectName: 'No-priority', priority: undefined }),
      makeLead({ id: 'b', prospectName: 'High-one', priority: 'High' }),
    ];
    assert.deepEqual(names(sortLeadsByColumn(noPriority, { key: 'priority', dir: 'asc' }, resolveOwner)), ['High-one', 'No-priority']);
    assert.deepEqual(names(sortLeadsByColumn(noPriority, { key: 'priority', dir: 'desc' }, resolveOwner)), ['High-one', 'No-priority']);
  });

  it('compareLeadsByColumn is a pure comparator (equal values compare 0)', () => {
    const a = makeLead({ prospectName: 'Same' });
    const b = makeLead({ prospectName: 'Same' });
    assert.equal(compareLeadsByColumn(a, b, { key: 'lead', dir: 'asc' }, resolveOwner), 0);
  });

  it('sorting never mutates the input array', () => {
    const leads = [
      makeLead({ id: 'a', prospectName: 'Zillur' }),
      makeLead({ id: 'b', prospectName: 'Ahnaf' }),
    ];
    const before = [...leads];
    const sorted = sortLeadsByColumn(leads, { key: 'lead', dir: 'asc' }, resolveOwner);
    assert.deepEqual(leads, before);
    assert.notEqual(sorted, leads);
  });
});

describe('lead column filters — predicates', () => {
  const leads = [
    makeLead({ id: 'a', prospectName: 'A', source: 'Facebook', assignedTo: '2025001', creationDate: '2026-11-23T08:00:00+06:00', timestamp: '2026-11-23T08:00:00+06:00' }),
    makeLead({ id: 'b', prospectName: 'B', source: 'Term Policy', assignedTo: '2025002', creationDate: '2026-11-20T08:00:00+06:00', timestamp: '2026-11-20T08:00:00+06:00' }),
    makeLead({ id: 'c', prospectName: 'C', source: 'Facebook', assignedTo: '2025002', creationDate: '2026-11-10T08:00:00+06:00', timestamp: '2026-11-10T08:00:00+06:00' }),
    makeLead({ id: 'd', prospectName: 'D', source: 'Walk-in', assignedTo: '', creationDate: '2026-10-20T08:00:00+06:00', timestamp: '2026-10-20T08:00:00+06:00' }),
  ];
  // Fixed "now": noon on 23 Nov 2026, Dhaka time.
  const now = new Date('2026-11-23T12:00:00+06:00');
  const noFilters: ColumnFilters = { sources: [], owners: [], created: 'all' };

  it('no active filter returns the input untouched', () => {
    assert.equal(applyColumnFilters(leads, noFilters, resolveOwner, now), leads);
    assert.equal(hasActiveColumnFilters(noFilters), false);
  });

  it('Source multi-select is OR within the column', () => {
    const out = applyColumnFilters(leads, { ...noFilters, sources: ['Facebook', 'Walk-in'] }, resolveOwner, now);
    assert.deepEqual(names(out), ['A', 'C', 'D']);
    assert.equal(hasActiveColumnFilters({ ...noFilters, sources: ['Facebook'] }), true);
  });

  it('Owner multi-select matches the resolved display name (incl. Unassigned)', () => {
    const out = applyColumnFilters(leads, { ...noFilters, owners: ['Nafisa Maliat Wazed', 'Unassigned'] }, resolveOwner, now);
    assert.deepEqual(names(out), ['B', 'C', 'D']);
  });

  it('filters combine with AND across columns', () => {
    const out = applyColumnFilters(
      leads,
      { sources: ['Facebook'], owners: ['Nafisa Maliat Wazed'], created: 'all' },
      resolveOwner,
      now,
    );
    assert.deepEqual(names(out), ['C']);
  });

  it('a value that matches nothing yields an empty list, never an error', () => {
    const out = applyColumnFilters(leads, { ...noFilters, sources: ['No such source'] }, resolveOwner, now);
    assert.deepEqual(out, []);
  });

  it('Created "Today" follows the Dhaka day boundary (not UTC, not the viewer TZ)', () => {
    // 23 Nov 00:30 Dhaka is today; 22 Nov 23:30 Dhaka (17:30 UTC)
    // is yesterday in Dhaka even though it is still 22 Nov in UTC.
    const justAfterMidnight = makeLead({ id: 'x', prospectName: 'Just-after', creationDate: '2026-11-23T00:30:00+06:00', timestamp: '2026-11-23T00:30:00+06:00' });
    const justBeforeMidnight = makeLead({ id: 'y', prospectName: 'Just-before', creationDate: '2026-11-22T23:30:00+06:00', timestamp: '2026-11-22T23:30:00+06:00' });
    assert.equal(matchesCreatedPreset(justAfterMidnight, 'today', now), true);
    assert.equal(matchesCreatedPreset(justBeforeMidnight, 'today', now), false);
    assert.equal(matchesCreatedPreset(justBeforeMidnight, '7d', now), true);
  });

  it('Created "Last 7 days" covers today + the previous 6 Dhaka days', () => {
    const oldestIn = makeLead({ id: 'x', prospectName: 'Oldest-in', creationDate: '2026-11-17T00:00:00+06:00', timestamp: '2026-11-17T00:00:00+06:00' });
    const justOut = makeLead({ id: 'y', prospectName: 'Just-out', creationDate: '2026-11-16T23:59:00+06:00', timestamp: '2026-11-16T23:59:00+06:00' });
    assert.equal(matchesCreatedPreset(oldestIn, '7d', now), true);
    assert.equal(matchesCreatedPreset(justOut, '7d', now), false);
    assert.equal(matchesCreatedPreset(justOut, '30d', now), true);
  });

  it('Created "Last 30 days" covers today + the previous 29 Dhaka days', () => {
    const oldestIn = makeLead({ id: 'x', prospectName: 'Oldest-in', creationDate: '2026-10-25T00:00:00+06:00', timestamp: '2026-10-25T00:00:00+06:00' });
    const justOut = makeLead({ id: 'y', prospectName: 'Just-out', creationDate: '2026-10-24T23:59:00+06:00', timestamp: '2026-10-24T23:59:00+06:00' });
    assert.equal(matchesCreatedPreset(oldestIn, '30d', now), true);
    assert.equal(matchesCreatedPreset(justOut, '30d', now), false);
    assert.equal(matchesCreatedPreset(justOut, 'all', now), true);
  });

  it('a lead with no parseable creation date never matches a preset', () => {
    const dateless = makeLead({ id: 'x', prospectName: 'Dateless', creationDate: '', timestamp: '' });
    assert.equal(matchesCreatedPreset(dateless, 'today', now), false);
    assert.equal(matchesCreatedPreset(dateless, '7d', now), false);
    assert.equal(matchesCreatedPreset(dateless, '30d', now), false);
    assert.equal(matchesCreatedPreset(dateless, 'all', now), true);
  });

  it('the Created preset combines with the multi-select filters', () => {
    const out = applyColumnFilters(
      leads,
      { sources: ['Facebook'], owners: [], created: '7d' },
      resolveOwner,
      now,
    );
    assert.deepEqual(names(out), ['A']);
  });

  it('distinct values carry counts, sort alphabetically, and skip blanks', () => {
    const rows = [
      makeLead({ source: 'Walk-in' }),
      makeLead({ source: 'Facebook' }),
      makeLead({ source: 'Facebook' }),
      makeLead({ source: '' }),
      makeLead({ source: '  ' }),
    ];
    assert.deepEqual(distinctColumnValues(rows, l => l.source || ''), [
      { value: 'Facebook', count: 2 },
      { value: 'Walk-in', count: 1 },
    ]);
  });

  it('toggleFilterValue adds and removes without mutating', () => {
    const current = ['Facebook'];
    assert.deepEqual(toggleFilterValue(current, 'Walk-in'), ['Facebook', 'Walk-in']);
    assert.deepEqual(toggleFilterValue(current, 'Facebook'), []);
    assert.deepEqual(current, ['Facebook']);
  });
});

describe('lead column filter/sort — LeadList source guards', () => {
  const list = () => read('src/modules/leads/pages/LeadList.tsx');
  /** One ColumnHeader usage line, by its label prop. */
  const headerLine = (label: string): string => {
    const src = list();
    const line = src.split('\n').find(l => l.includes('<ColumnHeader') && l.includes(`label="${label}"`));
    assert.ok(line, `a ColumnHeader usage for ${label} exists`);
    return line as string;
  };

  it('all six columns render as sort-button headers with arrows', () => {
    const src = list();
    for (const [label, key] of [
      ['Lead', 'lead'], ['Source', 'source'], ['Owner', 'owner'],
      ['Priority', 'priority'], ['Stage', 'stage'], ['Created', 'created'],
    ]) {
      const line = headerLine(label);
      assert.ok(line.includes(`sortKey="${key}"`), `${label} header sorts by ${key}`);
      assert.ok(line.includes('onSort={handleColumnSort}'), `${label} header wires the 3-click cycle`);
    }
    // The header cell itself is a real button with an accessible
    // name, and the active column shows an arrow.
    assert.ok(src.includes('aria-label={`Sort by ${label}`}'), 'the sort button names its column');
    assert.ok(src.includes("'↑'") && src.includes("'↓'"), 'the active column shows an up/down arrow');
  });

  it('the funnel exists ONLY on Source / Owner / Created (the one-place rule)', () => {
    for (const label of ['Source', 'Owner', 'Created']) {
      assert.ok(headerLine(label).includes('filter={{'), `${label} carries a filter funnel`);
    }
    for (const label of ['Lead', 'Priority', 'Stage']) {
      assert.ok(!headerLine(label).includes('filter='), `${label} has NO funnel — its quick filter already exists above the table`);
    }
    // The funnel button itself names its column.
    assert.ok(list().includes('aria-label={`Filter by ${label}`}'), 'the funnel button names its column');
  });

  it('the two SORT BY dropdowns stay in sync with the column sort', () => {
    const src = list();
    const dynamicOptions = src.split('{columnSort && <option value={COLUMN_SORT_SELECT_VALUE}>').length - 1;
    assert.equal(dynamicOptions, 2, 'both SORT BY renders (desktop + mobile) show the dynamic column option');
    assert.ok(src.includes('value={columnSort ? COLUMN_SORT_SELECT_VALUE : sortLogic}'), 'the dropdown value follows the active column sort');
    // Choosing any preset clears the column sort — the two controls
    // can never disagree.
    const handler = src.slice(src.indexOf('const handlePresetSortChange'));
    assert.ok(handler.includes('setColumnSort(null)'), 'a preset choice clears the column sort');
    assert.ok(handler.includes('COLUMN_SORT_SELECT_VALUE'), 're-selecting the dynamic option is a no-op');
  });

  it('the column sort overrides the SORT BY preset in the sort pipeline', () => {
    const src = list();
    assert.ok(src.includes('if (columnSort) return sortLeadsByColumn(columnFiltered, columnSort, ownerName)'), 'the column sort wins while set');
    assert.ok(src.includes('applyColumnFilters(preColumnLeads, columnFilters, ownerName)'), 'column filters apply on top of the pre-column set');
  });

  it('the distinct options derive from the pre-column set (after existing filters, before column filters)', () => {
    const src = list();
    assert.ok(src.includes('distinctColumnValues(preColumnLeads, lead => lead.source'), 'source options come from the pre-column set');
    assert.ok(src.includes('distinctColumnValues(preColumnLeads, lead => ownerName(lead))'), 'owner options come from the pre-column set');
  });

  it('the chips row shows active column filters with per-chip remove + Clear all', () => {
    const src = list();
    assert.ok(src.includes('aria-label="Active column filters"'), 'the chips row exists');
    assert.ok(src.includes('Remove Source filter'), 'a source chip is removable');
    assert.ok(src.includes('Remove Owner filter'), 'an owner chip is removable');
    assert.ok(src.includes('Remove Created filter'), 'the created chip is removable');
    assert.ok(src.includes('Clear all'), 'Clear all removes every column filter');
    assert.ok(src.includes('clearAllColumnFilters'), 'Clear all wires the clear handler');
  });

  it('the filter panel is fixed, closes on outside click / Escape, and has its own Clear', () => {
    const src = list();
    assert.ok(src.includes('role="dialog"'), 'the panel is a dialog');
    assert.ok(src.includes('fixed inset-0 z-20'), 'a transparent overlay catches outside clicks');
    assert.ok(src.includes("e.key === 'Escape'"), 'Escape closes the panel');
    assert.ok(src.includes("window.addEventListener('scroll', onScrollOrResize, true)"), 'scroll closes the panel (the anchor rect would go stale)');
    // The panel's own Clear resets just that column.
    assert.ok(src.includes("if (openFilter === 'source') setSourceFilter([])"), 'the panel Clear resets the source filter');
    assert.ok(src.includes("else if (openFilter === 'owner') setOwnerFilter([])"), 'the panel Clear resets the owner filter');
    assert.ok(src.includes("else setCreatedFilter('all')"), 'the panel Clear resets the created preset');
  });

  it('the bulk-select header checkbox stays first and untouched', () => {
    const src = list();
    const head = src.slice(src.indexOf('<thead>'), src.indexOf('</thead>'));
    assert.ok(head.includes('aria-label="Select all visible leads"'), 'the select-all checkbox is still in the header');
    assert.ok(
      head.indexOf('Select all visible leads') < head.indexOf('<ColumnHeader'),
      'the checkbox column still leads the header row',
    );
  });

  it('the mobile rows carry no column controls at all', () => {
    const src = list();
    const mobile = src.slice(src.indexOf('lf-mobile-lead-list'), src.indexOf('lf-desktop-lead-table'));
    assert.ok(!mobile.includes('ColumnHeader'), 'no sortable headers on the mobile rows');
    assert.ok(!mobile.includes('columnSort'), 'no column sort state in the mobile rows');
    assert.ok(!mobile.includes('Filter by'), 'no filter funnel on the mobile rows');
  });

  it('the workbench queue and AdvancedFilterPanel are untouched', () => {
    const workbench = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(!workbench.includes('columnSort'), 'no column sort in the workbench');
    assert.ok(!workbench.includes('leadColumnSort'), 'the workbench does not import the column util');
    assert.ok(!workbench.includes('ColumnHeader'), 'no sortable headers in the workbench');
    const panel = read('src/modules/shared/components/AdvancedFilterPanel.tsx');
    assert.ok(!panel.includes('columnSort'), 'the advanced rule builder is untouched — the column controls are the quick layer, not a duplicate of it');
    assert.ok(list().includes('<AdvancedFilterPanel'), 'LeadList still renders the advanced panel');
  });

  it('bulk selection is keyed by lead id, so sorting never disturbs it', () => {
    const src = list();
    // The selection holds ids, not row positions.
    assert.ok(src.includes('useState<Set<string>>(new Set())'), 'the selection is a Set of lead ids');
    assert.ok(src.includes('toggleLeadSelected(String(lead.id))'), 'toggling keys on the lead id');
    // The selected lead OBJECTS derive from the unsorted `leads`
    // state, never from the sorted filteredLeads — reordering the
    // table cannot change what is selected.
    const selectedLeads = src.slice(src.indexOf('const selectedLeads = useMemo'));
    assert.ok(selectedLeads.startsWith('const selectedLeads = useMemo(\n    () => leads.filter('), 'selectedLeads derives from the unsorted leads state');
    assert.ok(!src.includes('filteredLeads.filter(l => selectedLeadIds'), 'selection never reads the sorted list');
  });
});
