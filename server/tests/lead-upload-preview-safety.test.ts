/**
 * lead-upload-preview-safety.test.ts
 * ------------------------------------------------------------------
 * The Bulk Upload screen has three jobs, and all three used to lie:
 *
 *   F17 — the raw-file preview formatted EVERY cell as a date, so a number
 *         in a non-date column was read as an Excel serial: an
 *         "Interested amount of investment" of 50000 rendered as 2036-11-21
 *         while the server correctly received (and stored) 50000.
 *   F8  — parsing a file raised "Data imported successfully" before any
 *         validation, let alone any write.
 *   F9  — the sample template the app hands out contained
 *         `Assigned To: 'Monsoor_CTG'`, an employee id that does not exist in
 *         a new workspace, so the app's OWN sample file was rejected on
 *         re-upload.
 *
 * F7 (an unknown status must be a row error, never a silent "New") is a
 * server rule and is proven over HTTP in lead-bulk-import-integration.test.ts
 * (case E2); case D below pins the preview side of the same rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatSheetCellForDisplay,
  isDateColumn,
  mapRowForPreview,
  resolveImportStatus,
  REAL_SHEET_HEADERS,
} from '../../src/modules/leads/utils/leadUploadMapping';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Bulk upload preview — the money cell is not a date (F17/F8/F9)', () => {
  it('A. only real date columns are date columns', () => {
    for (const header of ['Assigned Date', 'Lead Date', '1st Call date', 'Follow up date', 'First Call date', 'Next Follow up date', 'assign date']) {
      assert.equal(isDateColumn(header), true, `${header} must be a date column`);
    }
    for (const header of ['Interested amount of investment', 'TAT', 'Phone', 'Name', 'Campaign Name', 'Initial Status', '', undefined]) {
      assert.equal(isDateColumn(header), false, `${String(header)} must NOT be a date column`);
    }
  });

  it('B. a bare number stays a number outside a date column (the F17 regression)', () => {
    // The exact cell from the report: 50000 displayed as 2036-11-21.
    assert.equal(formatSheetCellForDisplay(50000, 'Interested amount of investment'), '50000');
    assert.equal(formatSheetCellForDisplay(500000, 'Interested amount of investment'), '500000');
    assert.equal(formatSheetCellForDisplay(1, 'TAT'), '1');
    assert.equal(formatSheetCellForDisplay('  01711001122  ', 'Phone'), '01711001122', 'text cells are trimmed, not reformatted');

    // …while a real date column still understands Excel serials and Dates.
    assert.match(formatSheetCellForDisplay(46135, 'Lead Date'), /^\d{4}-\d{2}-\d{2}$/);
    const asDate = new Date(Date.UTC(2026, 3, 23));
    assert.equal(formatSheetCellForDisplay(asDate, 'Lead Date'), '2026-04-23');
    assert.equal(formatSheetCellForDisplay(asDate, 'Interested amount of investment'), '2026-04-23', 'a real Date is a date in any column');
    assert.equal(formatSheetCellForDisplay('23-Apr-2026', 'Assigned Date'), '2026-04-23');
    assert.equal(formatSheetCellForDisplay('', 'Lead Date'), '');
    assert.equal(formatSheetCellForDisplay(null, 'Lead Date'), '');
  });

  it('C. source guards: the preview is column-aware and never claims a write it did not do', () => {
    const page = read('src/modules/leads/pages/LeadUpload.tsx');
    assert.ok(page.includes('formatSheetCellForDisplay'), 'the preview must format by (cell, column)');
    assert.ok(page.includes('isDateColumn'), 'the column must be classified');
    assert.ok(page.includes('displayCell(cell, headerRow[j])'), 'each cell must receive its column header');
    assert.ok(!/displayCell\(cell\)\)/.test(page), 'the old header-less call must be gone');
    assert.ok(!/formatDateForDisplay/.test(page), 'the page must not date-format arbitrary cells any more');

    // F8: parsing is reported as parsing.
    assert.ok(!page.includes("toast.success('Data imported successfully')"), 'no success claim at parse time');
    assert.ok(/toast\.info\(`\$\{rows\.length\} row\(s\) loaded/.test(page), 'the parse step reports a load, not an import');
    assert.ok(page.includes("toast.error('No data rows found in the file (only the header row).')"), 'an empty file says so');
    // The only success toast left is the one that follows a server-confirmed import.
    const successToasts = page.match(/toast\.success\([^)]*\)/g) || [];
    assert.equal(successToasts.length, 2, `exactly two success toasts (template download + confirmed import), got ${successToasts.length}`);
    assert.ok(successToasts.some(t => t.includes('template downloaded')), 'the template download may confirm itself');
    assert.ok(successToasts.some(t => t.includes('Successfully imported')), 'the import result may confirm itself');
  });

  it('D. the sample template imports as-is, and no stale employee id is baked into the app', () => {
    const page = read('src/modules/leads/pages/LeadUpload.tsx');
    assert.ok(!/Monsoor_CTG/.test(page), 'the sample row must not name an employee that may not exist');
    assert.ok(/'Assigned To': ''/.test(page), 'the sample leaves Assigned To blank');
    assert.ok(/Active employee ID of this workspace|Active Employee ID/.test(page), 'the copy must still explain how to fill it');

    // The template row must pass the same preview rules a user's file faces:
    // every mapped field is either valid or blank, never a local error.
    const templateRow: Record<string, any> = {
      'Assigned Date': '23-Apr-2026', 'Lead Date': '22-Apr-2026', 'Name': 'Ranjon Tng',
      'Phone': '8801557586634', 'E-mail': 'ranjanchakama@gmail.com', 'Area': 'CTG',
      'Interested amount of investment': 500000, 'Source': 'Social media', 'Product': 'SCEP',
      'Other Info': '', 'Campaign Name': "Child Education April`26", 'Assigned To': '',
      'Previously Assigned': '', 'TAT': 1, '1st Call date': '23-Apr-2026',
      'Initial Status': 'No response', 'Initial Remarks': '', 'Follow up date': '29-Apr-2026',
      'Follow up': 'Interested', 'Final Remarks': 'The customer is currently busy.',
    };
    for (const header of Object.keys(templateRow)) {
      assert.ok((REAL_SHEET_HEADERS as readonly string[]).includes(header), `template header "${header}" must be a real sheet header`);
    }
    const preview = mapRowForPreview(templateRow, 0);
    assert.deepEqual(preview.localIssues, [], 'the app’s own sample must have zero local issues');
    assert.equal(preview.assignedTo, '', 'blank assignment is intentional (unassigned)');
    assert.equal(preview.currentStatusResolved, 'Interested', 'the follow-up status resolves');
  });

  it('E. the preview blocks unknown statuses exactly like the server does', () => {
    const dictionary = ['New', 'Contacted', 'Interested', 'Follow-up Set', 'Proposal Sent', 'Converted', 'Not Interested'];
    assert.equal(resolveImportStatus('Totally Made Up', dictionary).ok, false);
    // The one legacy alias that must keep working: 'Untouched' is what the old
    // sheets call the starting state, and the dictionary now calls it 'New'.
    assert.equal(resolveImportStatus('Untouched', dictionary).status, 'New');
    assert.equal(resolveImportStatus('untouched', dictionary).status, 'New', 'the alias is case-insensitive');
    // …but an alias without its target in the dictionary is still a hard error.
    assert.equal(resolveImportStatus('Untouched', ['Contacted', 'Interested']).ok, false);
    assert.equal(resolveImportStatus('Interested', dictionary).status, 'Interested');
    assert.equal(resolveImportStatus('  interested ', dictionary).status, 'Interested', 'case/space tolerant');

    const row = mapRowForPreview({ Name: 'X', Phone: '01711001122', 'Initial Status': 'Totally Made Up' }, 0);
    assert.deepEqual(row.localIssues, ['Initial Status "Totally Made Up" is not a valid status']);
  });
});
