/**
 * excel-replacement.test.ts — Phase 4: xlsx (SheetJS) → exceljs swap.
 * ---------------------------------------------------------------------
 * The old parser's output shapes are the spec. The expected literals
 * below were RECORDED from SheetJS 0.18.5 itself (same fixtures run
 * through XLSX.read + sheet_to_json before the swap) — this suite pins
 * the new wrapper (src/modules/shared/utils/excel.ts) to them:
 *  - keyed rows: duplicate headers → `_1` suffixes, absent header cell
 *    → `__EMPTY`, empty cells → '' (defval), blank separator rows with
 *    no cells are skipped;
 *  - text cells keep BD mobiles' leading zero; numeric cells stay
 *    numbers (the file itself lost the zero — matched, not "fixed");
 *  - date cells arrive as Dates that the import date parsers resolve
 *    to the exact calendar date (suite runs in Asia/Dhaka);
 *  - CSV keeps SheetJS coercion: numeric fields → numbers (quoted or
 *    not), TRUE/FALSE → booleans, date fields → Excel serials;
 *  - legacy .xls (OLE) files are rejected with the save-as message;
 *  - guards: nothing imports 'xlsx' anymore, exceljs is only touched
 *    by the wrapper, and package.json carries neither 'xlsx' nor the
 *    unused '@supabase/supabase-js'.
 */
process.env.TZ = 'Asia/Dhaka';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  parseSpreadsheetBytes,
  gridToKeyedRows,
  gridWithDefval,
  buildWorkbookBuffer,
  LEGACY_XLS_MESSAGE,
} = await import('../../src/modules/shared/utils/excel.js');

const { parseImportDate } = await import('../routes/leadImport.js');
const { formatDateForDisplay } = await import('../../src/modules/leads/utils/leadUploadMapping.js');
const { buildUserImportTemplate, USER_TEMPLATE_HEADERS } = await import('../../src/modules/users/utils/userBulkImport.js');
const ExcelJS = (await import('exceljs')).default as any;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('excel replacement — xlsx read equivalence with the SheetJS shapes', () => {
  it('round-trip: text mobile keeps its zero, numeric stays numeric, dates/Bangla/amounts intact', async () => {
    const buf = await buildWorkbookBuffer([
      {
        name: 'Users',
        headers: ['Name', 'Mobile', 'Joining Date', 'Amount', 'Note'],
        rows: [
          { Name: 'Rahim Uddin', Mobile: '01712345678', 'Joining Date': new Date(Date.UTC(2026, 0, 15)), Amount: 5000, Note: 'ঢাকা অফিস' },
          { Name: 'Karim', Mobile: 1712345678, 'Joining Date': new Date(Date.UTC(2025, 5, 7)), Amount: 0, Note: '' },
        ],
      },
      { name: 'Second', rows: [{ a: 1 }] },
    ]);
    const parsed = await parseSpreadsheetBytes(new Uint8Array(buf), 'xlsx');
    assert.deepEqual(parsed.sheetNames, ['Users', 'Second']);

    const rows = gridToKeyedRows(parsed.sheets[0].grid);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].Name, 'Rahim Uddin');
    assert.equal(rows[0].Mobile, '01712345678', 'text mobile must keep the leading zero');
    assert.ok(rows[0]['Joining Date'] instanceof Date, 'date cell must arrive as a Date');
    assert.equal((rows[0]['Joining Date'] as Date).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(rows[0].Amount, 5000);
    assert.equal(rows[0].Note, 'ঢাকা অফিস', 'Bangla text must survive intact');
    assert.equal(rows[1].Mobile, 1712345678, 'numeric mobile stays a number (zero lost in the file itself)');
    assert.equal(rows[1].Amount, 0);
    assert.equal(rows[1].Note, '', 'empty cell must become the defval empty string');

    // Grid mode (LeadUpload preview) matches sheet_to_json header:1 + defval.
    const grid = gridWithDefval(parsed.sheets[0].grid);
    assert.deepEqual(grid[0], ['Name', 'Mobile', 'Joining Date', 'Amount', 'Note']);
    assert.equal(grid[1][1], '01712345678');
    assert.equal(grid[2][4], '');
  });

  it('a genuine Excel-authored date serial (46037, date-formatted) reads as UTC midnight', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'Joining Date';
    ws.getCell('A2').value = 46037; // Excel serial for 2026-01-15
    ws.getCell('A2').numFmt = 'yyyy-mm-dd';
    const buf = await wb.xlsx.writeBuffer();
    const parsed = await parseSpreadsheetBytes(new Uint8Array(buf), 'xlsx');
    const cell = gridToKeyedRows(parsed.sheets[0].grid)[0]['Joining Date'];
    assert.ok(cell instanceof Date);
    assert.equal(cell.toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(formatDateForDisplay(cell), '2026-01-15');
    assert.equal(parseImportDate(cell), '2026-01-15T00:00:00.000Z');
  });

  it('parsed date cells resolve to the exact calendar date downstream (Asia/Dhaka)', async () => {
    const buf = await buildWorkbookBuffer([
      { name: 'S', rows: [{ 'Joining Date': new Date(Date.UTC(2026, 0, 15)) }] },
    ]);
    const parsed = await parseSpreadsheetBytes(new Uint8Array(buf), 'xlsx');
    const cell = gridToKeyedRows(parsed.sheets[0].grid)[0]['Joining Date'];
    assert.equal(formatDateForDisplay(cell), '2026-01-15');
    assert.equal(parseImportDate(cell), '2026-01-15T00:00:00.000Z');
  });

  it('duplicate + absent headers replicate SheetJS keys (Mobile_1, __EMPTY); formula gives cached result', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = 'Name';
    ws.getCell('B1').value = 'Mobile';
    ws.getCell('C1').value = 'Mobile';
    // D1 intentionally absent -> __EMPTY
    ws.getCell('E1').value = 'Amount';
    ws.getCell('F1').value = 'Calc';
    ws.getCell('A2').value = 'Rahim';
    ws.getCell('B2').value = '01712345678';
    ws.getCell('C2').value = 1712345678;
    ws.getCell('D2').value = 'x';
    ws.getCell('E2').value = 5000;
    ws.getCell('F2').value = { formula: '1+2', result: 3 };
    const buf = await wb.xlsx.writeBuffer();

    const parsed = await parseSpreadsheetBytes(new Uint8Array(buf), 'xlsx');
    const rows = gridToKeyedRows(parsed.sheets[0].grid);
    // Recorded from SheetJS on the same fixture shape.
    assert.deepEqual(rows, [{
      Name: 'Rahim', Mobile: '01712345678', Mobile_1: 1712345678, __EMPTY: 'x', Amount: 5000, Calc: 3,
    }]);
  });

  it('the 3-sheet user template builds and re-reads with sheet order + headers intact', async () => {
    const specs = buildUserImportTemplate({ roles: [], departments: [], teams: [] } as any);
    assert.deepEqual(specs.map(s => s.name), ['Users', 'Reference Values', 'Instructions']);
    assert.deepEqual(specs[0].headers, [...USER_TEMPLATE_HEADERS]);

    const buf = await buildWorkbookBuffer(specs);
    const parsed = await parseSpreadsheetBytes(new Uint8Array(buf), 'xlsx');
    assert.deepEqual(parsed.sheetNames, ['Users', 'Reference Values', 'Instructions']);
    const users = parsed.sheets.find(s => s.name === 'Users')!;
    assert.deepEqual(gridWithDefval(users.grid)[0], [...USER_TEMPLATE_HEADERS]);
  });
});

describe('excel replacement — CSV keeps SheetJS coercion', () => {
  it('quoted text, embedded commas/newlines and numeric coercion match the recorded output', async () => {
    const csv = 'Name,Mobile,Note\n"Rahim, Jr.",01712345678,"He said ""hi""\nbye"\nKarim,01898765432,plain\n';
    const parsed = await parseSpreadsheetBytes(new TextEncoder().encode(csv), 'csv');
    const rows = gridToKeyedRows(parsed.sheets[0].grid);
    // Recorded verbatim from SheetJS 0.18.5 on this exact input.
    assert.deepEqual(rows, [
      { Name: 'Rahim, Jr.', Mobile: 1712345678, Note: 'He said "hi"\nbye' },
      { Name: 'Karim', Mobile: 1898765432, Note: 'plain' },
    ]);
  });

  it('numbers, booleans and date fields coerce exactly as SheetJS did', async () => {
    const csv = 'A,B,C,D,E,F,G,H\n"01712345678",007,1.5e3,TRUE,2026-01-15,23-Apr-2026,-42, 99 \n';
    const parsed = await parseSpreadsheetBytes(new TextEncoder().encode(csv), 'csv');
    const rows = gridToKeyedRows(parsed.sheets[0].grid);
    // Recorded verbatim from SheetJS 0.18.5 on this exact input
    // (E and F became Excel serials 46037 / 46135).
    assert.deepEqual(rows, [{ A: 1712345678, B: 7, C: 1500, D: true, E: 46037, F: 46135, G: -42, H: 99 }]);
  });
});

describe('excel replacement — legacy .xls handling', () => {
  it('OLE-magic bytes are rejected with the save-as message', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await assert.rejects(
      () => parseSpreadsheetBytes(ole, 'xlsx'),
      (err: any) => err?.message === LEGACY_XLS_MESSAGE,
    );
  });

  it('garbage bytes fail loudly (never silently parse)', async () => {
    await assert.rejects(() => parseSpreadsheetBytes(new Uint8Array([1, 2, 3, 4, 5]), 'xlsx'));
  });
});

describe('excel replacement — dependency + boundary guards', () => {
  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full.includes(`${path.sep}tests${path.sep}`) || full.endsWith(`${path.sep}tests`)) continue;
        yield* walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        yield full;
      }
    }
  }

  it('no source file imports the removed xlsx package', () => {
    const patterns = ["from 'xlsx'", 'from "xlsx"', "require('xlsx')", 'require("xlsx")', "import('xlsx')", 'import("xlsx")'];
    const offenders: string[] = [];
    for (const dir of ['src', 'server']) {
      for (const file of walk(path.join(repoRoot, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        if (patterns.some(p => text.includes(p))) offenders.push(path.relative(repoRoot, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('exceljs is touched only by the single wrapper module', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(repoRoot, 'src'))) {
      if (file.endsWith(path.join('shared', 'utils', 'excel.ts'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes("from 'exceljs'") || text.includes('from "exceljs"') || text.includes("import('exceljs')")) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('package.json: xlsx and @supabase/supabase-js gone, exceljs pinned', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    assert.ok(!('xlsx' in deps), 'xlsx must be removed');
    assert.ok(!('@supabase/supabase-js' in deps), '@supabase/supabase-js must be removed (zero imports repo-wide)');
    assert.equal(deps['exceljs'], '4.4.0');
  });
});
