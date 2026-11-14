/**
 * TeamKpiExportService.ts
 * ------------------------------------------------------------------
 * The .xlsx builder for the TL+ KPI drill-down export (owner-approved
 * 2026-11-13): every level of the drill-down page can be exported by
 * anyone holding `leads.export` — people rows at a people level, lead
 * rows at a leaf level. The route (GET /api/team/kpi/export) resolves
 * the level and the visibility scope; this module only turns the
 * already-scoped rows into a workbook, so it can never widen access.
 *
 * Server-side exceljs use is deliberate: the excel-replacement guard
 * (server/tests/excel-replacement.test.ts) restricts exceljs to the
 * single wrapper in `src/` — the server is outside that scan, and no
 * server wrapper exists. FIX-2's LeadExportService is NOT imported:
 * it lives on an unmerged branch (feat/leads-fix2-scoped-export).
 */

import ExcelJS from 'exceljs';

export type KpiExportLevel = 'people' | 'leads';

export interface KpiExportPeopleRow {
  name: string;
  employeeId: string;
  designation: string | null;
  kpiValue: number;
}

export interface KpiExportLeadRow {
  leadCode: string | null;
  customerName: string;
  mobile: string;
  currentStatus: string;
  /** Dhaka calendar date as display text ('12 Nov 2026'), '' when unset. */
  nextFollowUpDate: string;
}

const SHEET_NAME = 'KPI Export';

/** Dhaka calendar date for a stored timestamp, as unambiguous text. */
export function dhakaDateText(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export async function buildKpiExportWorkbook(input: {
  kpiLabel: string;
  level: KpiExportLevel;
  /** Human scope line, e.g. "Ayesha Khan's team" or "Your leads". */
  scopeLabel: string;
  peopleRows?: KpiExportPeopleRow[];
  leadRows?: KpiExportLeadRow[];
  /** Full matching count when the rows are capped (leaf lists). */
  totalRows?: number;
  generatedAt?: Date;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LeadFlow';
  workbook.created = input.generatedAt ?? new Date();
  const sheet = workbook.addWorksheet(SHEET_NAME);

  const rows = input.level === 'people' ? (input.peopleRows ?? []) : (input.leadRows ?? []);
  const generatedText = (input.generatedAt ?? new Date()).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const countText = input.totalRows != null && input.totalRows > rows.length
    ? `${rows.length} rows (of ${input.totalRows} total)`
    : `${rows.length} row${rows.length === 1 ? '' : 's'}`;

  sheet.getCell('A1').value = `${input.kpiLabel} — ${input.scopeLabel}`;
  sheet.getCell('A1').font = { bold: true, size: 14 };
  sheet.getCell('A2').value = `Generated ${generatedText} (Asia/Dhaka) · ${countText}`;
  sheet.getCell('A2').font = { size: 10, color: { argb: 'FF78716C' } };

  if (input.level === 'people') {
    // NOTE: no `header` on the column defs — exceljs auto-writes
    // column headers into row 1, which would clobber the title rows
    // above. Headers are written explicitly at row 4 instead.
    sheet.columns = [
      { key: 'name', width: 32 },
      { key: 'employeeId', width: 16 },
      { key: 'designation', width: 28 },
      { key: 'kpiValue', width: 16 },
    ];
    const headerRow = sheet.getRow(4);
    headerRow.values = ['Name', 'Employee ID', 'Designation', input.kpiLabel];
    headerRow.font = { bold: true };
    for (const row of input.peopleRows ?? []) {
      sheet.addRow([row.name, row.employeeId, row.designation ?? '', row.kpiValue]);
    }
  } else {
    sheet.columns = [
      { key: 'leadCode', width: 18 },
      { key: 'customerName', width: 32 },
      { key: 'mobile', width: 16 },
      { key: 'currentStatus', width: 20 },
      { key: 'nextFollowUpDate', width: 18 },
    ];
    const headerRow = sheet.getRow(4);
    headerRow.values = ['Lead Code', 'Customer Name', 'Mobile', 'Status', 'Next Follow-up'];
    headerRow.font = { bold: true };
    for (const row of input.leadRows ?? []) {
      sheet.addRow([row.leadCode ?? '', row.customerName, row.mobile, row.currentStatus, row.nextFollowUpDate]);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as any);
}
