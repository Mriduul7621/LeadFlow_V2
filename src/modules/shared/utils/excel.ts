/**
 * excel.ts — the app's single spreadsheet boundary (Phase 4 hardening).
 * ---------------------------------------------------------------------
 * ALL Excel/CSV reading and writing in the client goes through this
 * module. It replaces the unmaintained `xlsx` (SheetJS) package —
 * which carries known prototype-pollution / ReDoS CVEs with no fixes
 * published to npm — with the maintained `exceljs` library.
 *
 * exceljs is loaded LAZILY via dynamic import() at the action site, so
 * it lands in its own async chunk and never enters any page bundle.
 *
 * Behaviour contract (pinned by server/tests/excel-replacement.test.ts
 * against fixtures that record the old SheetJS output shapes):
 *  - Keyed rows replicate `sheet_to_json(ws, { defval: '' })`:
 *    duplicate headers get `_1`, `_2` suffixes; a header cell that is
 *    absent from the file becomes `__EMPTY`; empty cells become ''.
 *  - Grid rows replicate `sheet_to_json(ws, { header: 1, defval: '' })`.
 *  - Date cells become JS Dates via the same serial→UTC-instant math
 *    SheetJS `cellDates: true` used (verified against recorded
 *    fixtures), so the import date parsers (client preview + server)
 *    keep resolving the exact calendar date in any reader timezone.
 *  - CSV keeps SheetJS's type coercion: numeric-looking fields become
 *    numbers (a BD mobile typed as 01712345678 loses its leading zero
 *    to the number 1712345678, exactly as before — downstream mobile
 *    normalisation is written for that), `TRUE`/`FALSE` become
 *    booleans, and date-looking fields become Excel serial numbers.
 *  - Legacy binary `.xls` (OLE) files are rejected with a clear
 *    message: exceljs cannot read the pre-2007 format. Save as
 *    `.xlsx` or `.csv` instead.
 */

export const LEGACY_XLS_MESSAGE =
  'Legacy .xls files are no longer supported. Please save the file as .xlsx or .csv and upload again.';

/* ------------------------------------------------------------------ */
/* Lazy library loading                                                */
/* ------------------------------------------------------------------ */

let excelJsPromise: Promise<any> | null = null;

function loadExcelJs(): Promise<any> {
  if (!excelJsPromise) {
    excelJsPromise = import('exceljs').then((mod: any) => mod?.default ?? mod);
  }
  return excelJsPromise;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface ExcelSheetGrid {
  name: string;
  /** Rectangular grid of raw cell values; `undefined` = empty cell. */
  grid: any[][];
}

export interface ParsedSpreadsheet {
  sheetNames: string[];
  sheets: ExcelSheetGrid[];
}

function isLegacyXlsBytes(bytes: Uint8Array): boolean {
  // OLE2 compound-document magic: D0 CF 11 E0 A1 B1 1A E1
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  );
}

function extractCellValue(cell: any): any {
  const v = cell?.value;
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    // Formula cell: SheetJS returned the cached result.
    if ('result' in v) {
      const r = (v as any).result;
      if (r === null || r === undefined) return undefined;
      return r;
    }
    // Rich text: SheetJS returned the plain text.
    if ('richText' in v) {
      return ((v as any).richText || []).map((t: any) => t?.text ?? '').join('');
    }
    // Hyperlink cell: SheetJS returned the display text.
    if ('text' in v && 'hyperlink' in v) return (v as any).text;
    // Error cells and anything else exotic read as empty.
    return undefined;
  }
  return v;
}

async function parseXlsxBytes(bytes: Uint8Array): Promise<ParsedSpreadsheet> {
  if (isLegacyXlsBytes(bytes)) throw new Error(LEGACY_XLS_MESSAGE);
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as any);
  const sheets: ExcelSheetGrid[] = [];
  for (const ws of wb.worksheets) {
    const rowCount = ws.rowCount || 0;
    const colCount = ws.columnCount || 0;
    const grid: any[][] = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      // Emit a row when the file actually carries cells for it (or any
      // value extracts). Rows with no cells at all are the genuinely
      // blank separators SheetJS also skipped.
      if ((row.cellCount || 0) === 0) continue;
      const cells: any[] = [];
      for (let c = 1; c <= colCount; c++) {
        cells.push(extractCellValue(row.getCell(c)));
      }
      grid.push(cells);
    }
    sheets.push({ name: ws.name, grid });
  }
  return { sheetNames: sheets.map(s => s.name), sheets };
}

/* ---------------------------- CSV ---------------------------------- */

// SheetJS's CSV reader coerced field types: numbers (incl. scientific
// notation), booleans, and date-shaped fields (to Excel serials).
const CSV_NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function excelSerialFromDate(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function coerceCsvField(raw: string): any {
  if (raw === '') return '';
  // SheetJS tested the trimmed field for coercion (' 99 ' became 99),
  // while non-coerced strings kept their original spacing.
  const t = raw.trim();
  if (CSV_NUMBER_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return excelSerialFromDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = t.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})$/);
  if (dmy) {
    const months: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const m = months[dmy[2].slice(0, 3).toLowerCase()];
    if (m) return excelSerialFromDate(Number(dmy[3]), m, Number(dmy[1]));
  }
  return raw;
}

/** RFC-4180-style CSV tokenizer (quotes, "" escapes, embedded newlines). */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  // Trailing field/row (a final newline already flushed an empty row's
  // field; only flush when there is pending content).
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

function parseCsvBytes(bytes: Uint8Array): ParsedSpreadsheet {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  const rawRows = tokenizeCsv(text);
  // SheetJS determines the range from the widest row; pad to width.
  const width = rawRows.reduce((w, r) => Math.max(w, r.length), 0);
  const grid = rawRows.map(r => {
    const cells: any[] = r.map(coerceCsvField);
    while (cells.length < width) cells.push(undefined);
    return cells;
  });
  // A trailing all-empty row produced by a final newline is not data.
  while (grid.length > 0 && grid[grid.length - 1].every(v => v === undefined || v === '')) {
    grid.pop();
  }
  return { sheetNames: ['Sheet1'], sheets: [{ name: 'Sheet1', grid }] };
}

export type SpreadsheetKind = 'xlsx' | 'csv';

export async function parseSpreadsheetBytes(
  bytes: Uint8Array,
  kind: SpreadsheetKind,
): Promise<ParsedSpreadsheet> {
  if (kind === 'csv') return parseCsvBytes(bytes);
  return parseXlsxBytes(bytes);
}

/* ------------------------------------------------------------------ */
/* Grid conversion (SheetJS sheet_to_json shapes)                      */
/* ------------------------------------------------------------------ */

/** Grid rows with every empty cell replaced by `defval` (default ''). */
export function gridWithDefval(grid: any[][], defval: any = ''): any[][] {
  return grid.map(row => row.map(v => (v === undefined || v === null ? defval : v)));
}

/**
 * Keyed rows exactly as `XLSX.utils.sheet_to_json(ws, { defval })`
 * produced them: first grid row is the header; duplicate headers are
 * suffixed `_1`, `_2`, …; absent header cells become `__EMPTY`;
 * empty data cells become `defval`.
 */
export function gridToKeyedRows(grid: any[][], defval: any = ''): Record<string, any>[] {
  if (!grid || grid.length === 0) return [];
  const headerRow = grid[0];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const keys = headerRow.map(h => {
    const base = h === undefined || h === null ? '__EMPTY' : String(h);
    let key = base;
    if (used.has(key)) {
      let n = (counts.get(base) || 0) + 1;
      key = `${base}_${n}`;
      while (used.has(key)) { n++; key = `${base}_${n}`; }
      counts.set(base, n);
    } else {
      counts.set(base, 0);
    }
    used.add(key);
    return key;
  });
  const rows: Record<string, any>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const obj: Record<string, any> = {};
    const row = grid[r];
    for (let c = 0; c < keys.length; c++) {
      const v = row[c];
      obj[keys[c]] = v === undefined || v === null ? defval : v;
    }
    rows.push(obj);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface ExcelSheetSpec {
  name: string;
  rows: Array<Record<string, any>>;
  /** Explicit column order; defaults to first-appearance key order
   *  across the rows (json_to_sheet semantics). */
  headers?: string[];
  columnWidths?: number[];
}

function jsonToSheetColumns(rows: Array<Record<string, any>>, headers?: string[]): string[] {
  if (headers) return [...headers];
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!set.has(k)) { set.add(k); seen.push(k); }
    }
  }
  return seen;
}

export async function buildWorkbookBuffer(sheets: ExcelSheetSpec[]): Promise<ArrayBuffer> {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    const cols = jsonToSheetColumns(spec.rows, spec.headers);
    ws.addRow(cols);
    for (const row of spec.rows) {
      ws.addRow(cols.map(c => (row[c] === undefined ? null : row[c])));
    }
    if (spec.columnWidths) {
      spec.columnWidths.forEach((w, i) => {
        const col = ws.getColumn(i + 1);
        if (col) col.width = w;
      });
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

/** Browser download of a generated workbook (exceljs writeBuffer → Blob). */
export async function downloadWorkbook(fileName: string, sheets: ExcelSheetSpec[]): Promise<void> {
  const buf = await buildWorkbookBuffer(sheets);
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
