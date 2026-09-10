/**
 * leadUploadMapping.ts
 * ------------------------------------------------------------------
 * Client-side mirror of the server's spreadsheet mapping
 * (server/routes/leadImport.ts) used ONLY for the Bulk Upload preview:
 * instant, local (DB-free) row validation and a compact per-row summary
 * for the validation table.
 *
 * The SERVER remains authoritative: the raw sheet rows are submitted
 * as-is and the server re-maps + re-validates everything (assignee
 * resolution, status dictionary, duplicates) before anything is written.
 */

/** The exact headers used by the legacy/current-state lead spreadsheet. */
export const REAL_SHEET_HEADERS = [
  'Assigned Date',
  'Lead Date',
  'Name',
  'Phone',
  'E-mail',
  'Area',
  'Interested amount of investment',
  'Source',
  'Product',
  'Other Info',
  'Campaign Name',
  'Assigned To',
  'Previously Assigned',
  'TAT',
  '1st Call date',
  'Initial Status',
  'Initial Remarks',
  'Follow up date',
  'Follow up',
  'Final Remarks',
] as const;

export type CanonicalField =
  | 'assignedDate' | 'leadDate' | 'name' | 'phone' | 'email' | 'area'
  | 'interestedAmount' | 'source' | 'product' | 'otherInfo' | 'campaign'
  | 'assignedTo' | 'previouslyAssigned' | 'tat' | 'firstCallDate'
  | 'initialStatus' | 'initialRemarks' | 'followUpDate' | 'followUp' | 'finalRemarks';

const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  assignedDate: ['Assigned Date', 'Assign Date', 'assignedDate', 'Assignment Date'],
  leadDate: ['Lead Date', 'creationDate', 'Created Date', 'leadDate'],
  name: ['Name', 'Customer Name', 'prospectName', 'Client Name', 'customerName'],
  phone: ['Phone', 'Mobile Number', 'Mobile', 'Phone Number', 'Contact Number', 'mobileNumber', 'mobile'],
  email: ['E-mail', 'Email', 'e-mail', 'email'],
  area: ['Area', 'area'],
  interestedAmount: [
    'Interested amount of investment',
    'Interested Amount of Investment',
    'Interested Investment Amount',
    'Investment Amount',
    'interestedAmount',
  ],
  source: ['Source', 'source'],
  product: ['Product', 'Product Name', 'productName'],
  otherInfo: ['Other Info', 'Other information', 'otherInfo'],
  campaign: ['Campaign Name', 'Campaign', 'campaignName'],
  assignedTo: ['Assigned To', 'Assign Person', 'Assigned Person', 'Assign To', 'Operator', 'assignedTo', 'assigned_to'],
  previouslyAssigned: ['Previously Assigned', 'Previous Assigned', 'Previously Assigned To', 'Previous Assignee', 'previouslyAssigned'],
  tat: ['TAT', 'tat'],
  firstCallDate: ['1st Call date', '1st Call Date', 'First Call Date', 'First Call date', '1st Call'],
  initialStatus: ['Initial Status', 'initialStatus'],
  initialRemarks: ['Initial Remarks', 'initialRemarks'],
  followUpDate: ['Follow up date', 'Follow Up Date', 'Followup date', 'Next Follow up date', 'nextFollowUpDate'],
  followUp: ['Follow up', 'Follow Up', 'Followup', 'Follow up Status', 'FollowUp Status'],
  finalRemarks: ['Final Remarks', 'finalRemarks'],
};

function normalizeHeaderKey(header: unknown): string {
  return String(header == null ? '' : header)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_TO_FIELD = new Map<string, CanonicalField>();
for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[CanonicalField, string[]]>) {
  for (const alias of aliases) {
    const key = normalizeHeaderKey(alias);
    if (!HEADER_TO_FIELD.has(key)) HEADER_TO_FIELD.set(key, field);
  }
}

/** Read a canonical field from a raw row (spreadsheet header or API alias). */
export function extractField(raw: Record<string, any>, field: CanonicalField): any {
  if (!raw || typeof raw !== 'object') return undefined;
  for (const alias of FIELD_ALIASES[field]) {
    const v = raw[alias];
    if (v !== undefined && v !== null && String(v) !== '') return v;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (HEADER_TO_FIELD.get(normalizeHeaderKey(key)) === field && value !== undefined && value !== null && String(value) !== '') {
      return value;
    }
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, february: 1, feb: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  january: 0,
};

/** Display formatter - keeps dates recognizable without changing values. */
export function formatDateForDisplay(value: any): string {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? String(value) : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}|[A-Za-z]{3}/.test(s)) {
    return d.toISOString().slice(0, 10);
  }
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface PreviewRow {
  /** 1-based data row number (sheet row = index + 2 with header). */
  rowNumber: number;
  index: number;
  name: string;
  phone: string;
  email: string;
  assignedTo: string;
  campaign: string;
  initialStatus: string;
  followUp: string;
  leadDate: string;
  localIssues: string[];
  hasAnyValue: boolean;
}

/** Map + locally validate one raw sheet row for the preview table. */
export function mapRowForPreview(raw: Record<string, any>, index: number): PreviewRow {
  const text = (v: any) => (v === undefined || v === null ? '' : String(v).trim());
  const name = text(raw.customerName ?? extractField(raw, 'name'));
  const phone = text(extractField(raw, 'phone'));
  const email = text(extractField(raw, 'email'));
  const assignedTo = text(extractField(raw, 'assignedTo'));
  const campaign = text(extractField(raw, 'campaign'));
  const initialStatus = text(extractField(raw, 'initialStatus'));
  const followUp = text(extractField(raw, 'followUp'));
  const leadDateRaw = extractField(raw, 'leadDate');
  const leadDate = leadDateRaw === undefined || leadDateRaw === null || leadDateRaw === '' ? '' : formatDateForDisplay(leadDateRaw);

  const issues: string[] = [];
  if (!name) issues.push('Name is required');
  if (!phone) {
    issues.push('Phone is required');
  } else if (phone.replace(/\D/g, '').length < 6) {
    issues.push(`Phone "${phone}" does not contain a usable number`);
  }
  if (email && !EMAIL_RE.test(email)) issues.push(`E-mail "${email}" is not a valid email address`);

  const looksLikeDate = (rawText: string): boolean => {
    // Mirrors the server's accepted shapes closely enough for preview:
    // ISO / native-parseable, Excel serials, "23-Apr-2026", day-first
    // numeric dates (the server resolves those authoritatively).
    if (!isNaN(new Date(rawText).getTime())) return true;
    if (/^\d{4,5}(\.\d+)?$/.test(rawText) && Number(rawText) > 20000 && Number(rawText) < 80000) return true;
    if (/^\d{1,2}[-\s/.][A-Za-z]{3,9}[-\s/.]\d{2,4}$/.test(rawText)) return true;
    if (/^[A-Za-z]{3,9}[-\s/.]\d{1,2},?[-\s/.]\d{2,4}$/.test(rawText)) return true;
    if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(rawText)) return true;
    return false;
  };

  for (const [label, field] of [
    ['Assigned Date', 'assignedDate'],
    ['Lead Date', 'leadDate'],
    ['1st Call date', 'firstCallDate'],
    ['Follow up date', 'followUpDate'],
  ] as Array<[string, CanonicalField]>) {
    const v = extractField(raw, field);
    const rawText = v instanceof Date ? '' : text(v);
    if (rawText && !looksLikeDate(rawText)) {
      issues.push(`${label} "${rawText}" is not a recognizable date`);
    }
  }

  const hasAnyValue = [name, phone, email, assignedTo, campaign, initialStatus, followUp, leadDate].some(v => v !== '');

  return {
    rowNumber: index + 1,
    index,
    name,
    phone,
    email,
    assignedTo,
    campaign,
    initialStatus,
    followUp,
    leadDate,
    localIssues: issues,
    hasAnyValue,
  };
}
