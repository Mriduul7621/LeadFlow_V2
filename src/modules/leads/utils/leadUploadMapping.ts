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
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const EXCEL_EPOCH_DAYS = 25569; // days between 1899-12-30 (Excel epoch) and 1970-01-01

function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial >= 2958466 /* year 9999 */) return null;
  // Only treat plausible date serials as dates (1954..2119). Plain small
  // numbers (TAT=1, amounts) must never become dates.
  if (serial < 20000 || serial >= 80000) return null;
  const ms = Math.round((serial - EXCEL_EPOCH_DAYS) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeYear(y: string): number {
  const n = Number(y);
  if (y.length === 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

/** True when the Date sits exactly at midnight in the LOCAL timezone. */
function isLocalMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/**
 * Mirror of the server's authoritative parseImportDate()
 * (server/routes/leadImport.ts) — parses a spreadsheet date into a
 * UTC-midnight ISO instant WITHOUT ever defaulting to "now" and WITHOUT
 * timezone shifting date-only values.
 *
 * Deliberately NEVER uses `new Date(string)` + toISOString() for date-only
 * strings: in UTC+ timezones such as Bangladesh (UTC+6) the engine parses
 * "23-Apr-2026" as LOCAL midnight, and toISOString() would then display
 * the PREVIOUS day (the historical off-by-one preview bug). All date-only
 * shapes below are built explicitly with Date.UTC:
 *  - JS Date objects (xlsx cellDates:true) and ISO strings
 *  - Excel serial numbers and numeric strings (e.g. 46135)
 *  - "23-Apr-2026" / "23 Apr 2026" / "Apr 23, 2026"
 *  - "23/04/2026" (day-first, Bangladesh convention; month-first only
 *    when the day part cannot be a day, e.g. "04/23/2026")
 *  - "2026-04-23" and full ISO timestamps (a timezone-less midnight
 *    timestamp counts as date-only; real timestamps keep instant semantics)
 * Returns null for blank/unparseable values — the caller decides.
 */
export function parseImportDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A Date constructed at LOCAL midnight represents a DATE-ONLY value;
    // display the intended calendar date, not the previous UTC day.
    if (isLocalMidnight(value)) {
      return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString();
    }
    return value.toISOString();
  }
  if (typeof value === 'number') return excelSerialToIso(value);

  const s = String(value).trim();
  if (!s) return null;

  // Excel serial passed as a numeric string (CSV export of an Excel column).
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const iso = excelSerialToIso(Number(s));
    if (iso) return iso;
  }

  // ISO-ish (YYYY-MM-DD with optional time) - unambiguous.
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T\s].*)?$/);
  if (isoMatch) {
    if (isoMatch[4]) {
      if (/^[T\s]00:00(?::00(?:\.\d+)?)?$/.test(isoMatch[4])) {
        const d = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      } else {
        const withTime = new Date(s);
        if (!Number.isNaN(withTime.getTime())) return withTime.toISOString();
      }
    } else {
      const d = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  // 23-Apr-2026 / 23 Apr 2026 / 23-Apr-26
  const dmy = s.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3,9})[\s\-/.](\d{2,4})$/);
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase()];
    if (month !== undefined) {
      const year = normalizeYear(dmy[3]);
      const day = Number(dmy[1]);
      const d = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(d.getTime()) && d.getUTCDate() === day) return d.toISOString();
    }
  }

  // Apr 23, 2026 / Apr 23 2026
  const mdy = s.match(/^([A-Za-z]{3,9})[\s\-/.](\d{1,2}),?[\s\-/.](\d{2,4})$/);
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase()];
    if (month !== undefined) {
      const year = normalizeYear(mdy[3]);
      const day = Number(mdy[2]);
      const d = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(d.getTime()) && d.getUTCDate() === day) return d.toISOString();
    }
  }

  // 23/04/2026 - numeric day-first (BD convention) unless day part > 12
  // is impossible, in which case accept month-first ("04/23/2026").
  const numeric = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (numeric) {
    let day = Number(numeric[1]);
    let month = Number(numeric[2]);
    if (day > 12 && month <= 12) {
      // day-first as written
    } else if (month > 12 && day <= 12) {
      // month-first export: swap
      [day, month] = [month, day];
    }
    const year = normalizeYear(numeric[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(d.getTime()) && d.getUTCDate() === day && d.getUTCMonth() === month - 1) {
      return d.toISOString();
    }
    return null; // explicitly invalid rather than guessed
  }

  // Last resort: native parser (handles RFC strings, "2026/04/23", etc.)
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    // Date-only strings parsed by the engine as LOCAL midnight ("2026/04/23")
    // must keep the intended calendar date; real timestamps stay instants.
    if (isLocalMidnight(parsed)) {
      return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())).toISOString();
    }
    return parsed.toISOString();
  }
  return null;
}

/**
 * Display formatter for the Bulk Upload preview - DATE-ONLY output
 * ("YYYY-MM-DD") computed WITHOUT timezone shifting: date-only spreadsheet
 * values are treated as date-only values (UTC-midnight historical dates).
 * Unparseable values are shown as-is so the user still sees the raw cell.
 */
export function formatDateForDisplay(value: any): string {
  if (value === undefined || value === null || value === '') return '';
  const iso = parseImportDate(value);
  if (iso) return iso.slice(0, 10);
  if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString().slice(0, 10);
  return String(value).trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------
   Statuses (mirror of server/routes/leadImport.ts)
------------------------------------------------------------------- */

/**
 * Built-in FollowUpStatus dictionary — the app's documented default
 * pipeline (metadata.seed.ts / DEFAULT_LEAD_STATUSES). The Bulk Upload
 * preview is deliberately DB-free, so it validates against the same
 * built-in list the server falls back to when the options table is not
 * configured; the authoritative dryRun preview still runs against the real
 * admin-configured options and its errors are shown alongside.
 */
export const DEFAULT_STATUS_DICTIONARY = [
  'Untouched', 'Contacted', 'No Response', 'Busy', 'Interested',
  'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked',
  'Converted', 'Not Interested',
];

/** Case/spacing/punctuation-insensitive status key. */
export function normalizeStatusKey(value: unknown): string {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * LEGACY SHEET ALIASES — MUST stay identical to LEGACY_STATUS_ALIASES in
 * server/routes/leadImport.ts (the authoritative copy). See the server
 * documentation: deterministic legacy sheet wording -> EXISTING canonical
 * FollowUpStatus values; no new options, no new taxonomy.
 */
const LEGACY_STATUS_ALIASES: Record<string, string> = {
  unreachable: 'No Response',
  followup: 'Follow-up Set',
};

export interface ImportStatusResolution {
  /** false = value is not a canonical status nor a known legacy alias. */
  ok: boolean;
  /** Resolved canonical status ('' when the raw value was blank). */
  status: string;
}

/**
 * Mirror of the server's resolveImportStatus(): blank -> ok/'', canonical
 * case-insensitive match, then legacy alias (only when its canonical target
 * is in the dictionary), else NOT ok. Used by BOTH the preview table and
 * the preview validation so the preview applies the exact same
 * status-resolution rules the server applies at import time.
 */
export function resolveImportStatus(rawValue: unknown, canonicalStatuses: string[] = DEFAULT_STATUS_DICTIONARY): ImportStatusResolution {
  const raw = String(rawValue == null ? '' : rawValue).trim();
  if (!raw) return { ok: true, status: '' };
  const dict = new Map<string, string>();
  for (const value of canonicalStatuses) {
    const key = normalizeStatusKey(value);
    if (key && !dict.has(key)) dict.set(key, value);
  }
  const direct = dict.get(normalizeStatusKey(raw));
  if (direct) return { ok: true, status: direct };
  const aliasTarget = LEGACY_STATUS_ALIASES[normalizeStatusKey(raw)];
  if (aliasTarget) {
    const resolved = dict.get(normalizeStatusKey(aliasTarget));
    if (resolved) return { ok: true, status: resolved };
  }
  return { ok: false, status: raw };
}

export interface PreviewRow {
  /** 1-based data row number (sheet row = index + 2 with header). */
  rowNumber: number;
  index: number;
  name: string;
  phone: string;
  email: string;
  assignedTo: string;
  campaign: string;
  /** Raw "Initial Status" cell text (as written in the sheet). */
  initialStatus: string;
  /** Raw "Follow up" cell text (as written in the sheet). */
  followUp: string;
  /** Resolved canonical status for "Initial Status" ('' when blank/invalid). */
  initialStatusResolved: string;
  /** Resolved canonical status for "Follow up" ('' when blank/invalid). */
  followUpResolved: string;
  /** The status the server will store as current_status ('' when blank). */
  currentStatusResolved: string;
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

  const looksLikeDate = (rawValue: any): boolean => {
    // Mirrors the server exactly: accepted when parseImportDate (the same
    // deterministic parser the server uses) accepts the value.
    return parseImportDate(rawValue) !== null;
  };

  for (const [label, field] of [
    ['Assigned Date', 'assignedDate'],
    ['Lead Date', 'leadDate'],
    ['1st Call date', 'firstCallDate'],
    ['Follow up date', 'followUpDate'],
  ] as Array<[string, CanonicalField]>) {
    const v = extractField(raw, field);
    const rawText = v instanceof Date ? '' : text(v);
    if (rawText && !looksLikeDate(v)) {
      issues.push(`${label} "${rawText}" is not a recognizable date`);
    }
  }

  // Status validation with the SAME resolution rules the server applies at
  // import time (case-insensitive canonical match + the shared legacy alias
  // table), and the SAME error messages, so the preview can never disagree
  // with the actual import. Unknown values fail locally - they are never
  // silently converted to "Untouched" here or on the server.
  const initialResolution = resolveImportStatus(initialStatus);
  if (initialStatus && !initialResolution.ok) {
    issues.push(`Initial Status "${initialStatus}" is not a valid status`);
  }
  const followUpResolution = resolveImportStatus(followUp);
  if (followUp && !followUpResolution.ok) {
    issues.push(`Follow up "${followUp}" is not a valid status`);
  }
  // Latest known state wins - identical precedence to the server.
  const currentStatusResolved = followUpResolution.status || initialResolution.status;

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
    initialStatusResolved: initialResolution.ok ? initialResolution.status : '',
    followUpResolved: followUpResolution.ok ? followUpResolution.status : '',
    currentStatusResolved,
    leadDate,
    localIssues: issues,
    hasAnyValue,
  };
}
