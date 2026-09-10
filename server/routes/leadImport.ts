/**
 * leadImport.ts — Bulk spreadsheet import mapping + validation helpers.
 * ------------------------------------------------------------------
 * Single place that knows the REAL historical/current-state lead sheet
 * headers used by the business (Shanta Life) and maps them onto the
 * existing LeadFlow Lead model (leads table + custom_fields bag).
 *
 * Design rules (see PR description):
 *  - PostgreSQL stays the source of truth; this module is pure (no DB).
 *  - An explicitly supplied historical date must stay that date — never
 *    "now". parseImportDate() returns null for blank/unparseable input
 *    instead of defaulting to the current timestamp.
 *  - The canonical employee identifier (users.employee_id, e.g.
 *    "Monsoor_CTG") is the preferred assignee reference.
 *  - No new status taxonomy: statuses are resolved against the active
 *    `options` rows of type FollowUpStatus by the caller (this module
 *    only does the case-insensitive lookup against a provided set).
 *
 * NOTE: a mirrored (display-only) copy of the header aliases exists in
 * src/modules/leads/utils/leadUploadMapping.ts for the client preview.
 * The server copy below is authoritative.
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

/** Canonical import fields and every header alias accepted for them. */
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
  assignedTo: [
    'Assigned To',
    'Assign Person',
    'Assigned Person',
    'Assign To',
    'Operator',
    'assignedTo',
    'assigned_to',
  ],
  previouslyAssigned: [
    'Previously Assigned',
    'Previous Assigned',
    'Previously Assigned To',
    'Previous Assignee',
    'previouslyAssigned',
  ],
  tat: ['TAT', 'tat'],
  firstCallDate: ['1st Call date', '1st Call Date', 'First Call Date', 'First Call date', '1st Call'],
  initialStatus: ['Initial Status', 'initialStatus'],
  initialRemarks: ['Initial Remarks', 'initialRemarks'],
  followUpDate: ['Follow up date', 'Follow Up Date', 'Followup date', 'Next Follow up date', 'nextFollowUpDate'],
  followUp: ['Follow up', 'Follow Up', 'Followup', 'Follow up Status', 'FollowUp Status'],
  finalRemarks: ['Final Remarks', 'finalRemarks'],
};


/** Case/spacing/punctuation-insensitive header key. */
function normalizeHeaderKey(header: unknown): string {
  return String(header == null ? '' : header)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_TO_FIELD = new Map<string, CanonicalField>();
for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[CanonicalField, string[]]>) {
  for (const alias of aliases) {
    const key = normalizeHeaderKey(alias);
    // First alias for a normalized key wins (deterministic).
    if (!HEADER_TO_FIELD.has(key)) HEADER_TO_FIELD.set(key, field);
  }
}

/** Read a canonical field from a raw row (spreadsheet header or API alias). */
export function extractField(raw: Record<string, any>, field: CanonicalField): any {
  if (!raw || typeof raw !== 'object') return undefined;
  // Fast path: exact alias match (preserves the user's original value).
  for (const alias of FIELD_ALIASES[field]) {
    if (raw[alias] !== undefined && raw[alias] !== null && String(raw[alias]) !== '') return raw[alias];
  }
  // Fallback: normalized header matching (handles spacing/case variants
  // such as "assigned  to", "FOLLOW UP DATE", "eMail").
  const normalizedEntries = (raw as any).__normalized ?? buildNormalizedView(raw);
  for (const [key, value] of normalizedEntries) {
    const mapped = HEADER_TO_FIELD.get(key);
    if (mapped === field && value !== undefined && value !== null && String(value) !== '') return value;
  }
  return undefined;
}

function buildNormalizedView(raw: Record<string, any>): Array<[string, any]> {
  const entries = Object.entries(raw)
    .filter(([k]) => k !== '__normalized')
    .map(([k, v]) => [normalizeHeaderKey(k), v] as [string, any]);
  try {
    Object.defineProperty(raw, '__normalized', { value: entries, enumerable: false, configurable: true });
  } catch {
    /* non-fatal: row objects from JSON.parse are extensible; arrays of
       frozen objects simply recompute per access. */
  }
  return entries;
}

/* ------------------------------------------------------------------
   Dates
------------------------------------------------------------------- */

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

/**
 * Parse a spreadsheet/CSV date WITHOUT ever defaulting to "now".
 * Supported representations (mirrors the existing client parser plus the
 * day-first formats the business sheets use):
 *  - JS Date objects (xlsx cellDates:true) and ISO strings
 *  - Excel serial numbers (e.g. 46135)
 *  - "23-Apr-2026" / "23 Apr 2026" / "Apr 23, 2026"
 *  - "23/04/2026" (day-first, Bangladesh convention; month-first only
 *    when the day part cannot be a day, e.g. "04/23/2026")
 *  - "2026-04-23" and full ISO timestamps
 * Returns UTC-midnight ISO for date-only input. Returns null for blank
 * or unparseable values — the caller decides whether that is an error.
 */
export function parseImportDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A Date constructed at LOCAL midnight (e.g. new Date(2026, 3, 23) in
    // UTC+6) represents a DATE-ONLY value; converting the instant via
    // toISOString() would shift it to the previous UTC day. Rebuild it as
    // UTC midnight of the intended calendar date instead. UTC-midnight
    // dates (the xlsx `cellDates` shape) are unaffected in UTC+ zones and
    // identical in UTC, so this never moves a correctly-built date.
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
      // A timezone-less midnight timestamp ("2026-04-23T00:00:00") is a
      // date-only value with a redundant time. Parsing it with new Date()
      // interprets it as LOCAL midnight, and toISOString() then shifts it
      // to the previous UTC day in UTC+ timezones (e.g. Bangladesh). Treat
      // it as the date it says, at UTC midnight.
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
    // Date-only strings the regexes above do not cover ("2026/04/23") are
    // parsed by the engine as LOCAL midnight; keep the intended calendar
    // date instead of letting toISOString() shift it a day back in UTC+
    // timezones. Real timestamps (non-midnight) keep instant semantics.
    if (isLocalMidnight(parsed)) {
      return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())).toISOString();
    }
    return parsed.toISOString();
  }
  return null;
}

/** True when the Date sits exactly at midnight in the LOCAL timezone. */
function isLocalMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function normalizeYear(y: string): number {
  const n = Number(y);
  if (y.length === 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

/* ------------------------------------------------------------------
   Phones / emails
------------------------------------------------------------------- */

/**
 * Normalized duplicate-matching key for phone numbers. Unifies the
 * representations the sheets use for Bangladeshi mobiles:
 *   01711001122 / 8801711001122 / 1711001122 -> "1711001122".
 * Falls back to the raw digit string for non-BD shapes.
 */
export function normalizePhoneKey(value: unknown): string {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (!digits) return '';
  let d = digits;
  // 880 + 11-digit local (01711001122) -> strip the country code, then the
  // branch below removes the leading zero.
  if ((d.length === 13 || d.length === 14) && d.startsWith('880')) d = d.slice(3);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

export function hasUsablePhone(value: unknown): boolean {
  return normalizePhoneKey(value).length >= 6;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(value: unknown): boolean {
  const s = String(value == null ? '' : value).trim();
  return s.length > 0 && EMAIL_RE.test(s);
}

/* ------------------------------------------------------------------
   Statuses
------------------------------------------------------------------- */

/**
 * Built-in FollowUpStatus dictionary — the app's documented default
 * pipeline (metadata.seed.ts / DEFAULT_LEAD_STATUSES). Used only when the
 * admin-configured `options` table has no active FollowUpStatus rows;
 * otherwise the canonical dictionary comes from the database.
 */
export const DEFAULT_STATUS_DICTIONARY = [
  'Untouched', 'Contacted', 'No Response', 'Busy', 'Interested',
  'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked',
  'Converted', 'Not Interested',
];

/**
 * Case/spacing/punctuation-insensitive status key ("Follow up" and
 * "Follow-up" both -> "followup").
 */
export function normalizeStatusKey(value: unknown): string {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * LEGACY SHEET ALIASES: historical "Initial Status" / "Follow up" values
 * written in the business's legacy sheet that are NOT literal spellings of
 * a canonical FollowUpStatus option, but have ONE deterministic meaning in
 * the existing taxonomy.
 *
 * This is NOT a new status taxonomy and adds NO new options — every target
 * is an existing canonical value, and each alias only applies when that
 * canonical value is actually present in the dictionary being used (an
 * admin-configured list without the target stays authoritative and the
 * value fails validation instead).
 *
 *  - "Unreachable"  -> "No Response"    (legacy call outcome: customer
 *    could not be reached = no response in the current pipeline)
 *  - "Follow up"    -> "Follow-up Set"  (legacy follow-up stage marker =
 *    a follow-up is set in the current pipeline)
 *
 * Exact/case-variant canonical spellings ("No response", "Not interested",
 * "Interested") need no alias — they already match the dictionary
 * case-insensitively.
 *
 * MIRRORED in src/modules/leads/utils/leadUploadMapping.ts for the client
 * preview — keep the two tables identical.
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
 * Resolve one raw sheet/API status against a canonical dictionary.
 *  1. blank                      -> ok, ''
 *  2. case/spacing-insensitive
 *     canonical match            -> the canonical spelling
 *  3. known legacy alias whose
 *     target exists in the
 *     dictionary                 -> the canonical target
 *  4. anything else              -> NOT ok (caller reports an error —
 *     never silently converted to "Untouched")
 * Pure and shared by the bulk-import preview and the import itself, so the
 * preview can never disagree with what the server will actually store.
 */
export function resolveImportStatus(rawValue: unknown, canonicalStatuses: string[]): ImportStatusResolution {
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

/* ------------------------------------------------------------------
   Row mapping
------------------------------------------------------------------- */

export interface ImportRow {
  index: number;
  raw: Record<string, any>;
  /** Explicit lead code when the sheet/API supplies one (update key). */
  leadCode: string;
  name: string;
  phone: string;
  email: string;
  area: string;
  source: string;
  product: string;
  campaign: string;
  assignedTo: string;
  previouslyAssigned: string;
  tat: string;
  interestedAmount: string;
  otherInfo: string;
  initialStatus: string;
  initialRemarks: string;
  followUp: string;
  finalRemarks: string;
  /** Legacy API-shaped rows only (currentStatus); blank for sheet rows. */
  currentStatus: string;
  assignedDate: string | null;
  leadDate: string | null;
  firstCallDate: string | null;
  followUpDate: string | null;
  /** Local (DB-free) validation issues found while mapping. */
  issues: string[];
}

function text(value: any): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * Map one raw spreadsheet/API row onto the canonical import shape.
 * Pure — no DB access, no "now" defaults. Local validation issues are
 * collected on the row so callers can report them per line.
 */
export function mapSpreadsheetRow(raw: Record<string, any>, index: number): ImportRow {
  // Explicit update key: leadCode/lead_code, else a string id (the legacy
  // client generates ids like "lead_..." and historically sent them as the
  // dedup key - keep accepting them for compatibility).
  const explicitCode = text(raw.leadCode ?? raw.lead_code ?? (typeof raw.id === 'string' && raw.id ? raw.id : ''));
  const row: ImportRow = {
    index,
    raw,
    leadCode: explicitCode,
    name: '',
    phone: '',
    email: '',
    area: '',
    source: '',
    product: '',
    campaign: '',
    assignedTo: '',
    previouslyAssigned: '',
    tat: '',
    interestedAmount: '',
    otherInfo: '',
    initialStatus: '',
    initialRemarks: '',
    followUp: '',
    finalRemarks: '',
    currentStatus: '',
    assignedDate: null,
    leadDate: null,
    firstCallDate: null,
    followUpDate: null,
    issues: [],
  };

  row.name = text(raw.customerName ?? raw.customer_name ?? extractField(raw, 'name'));
  row.phone = text(extractField(raw, 'phone'));
  row.email = text(extractField(raw, 'email'));
  row.area = text(extractField(raw, 'area'));
  row.source = text(extractField(raw, 'source'));
  row.product = text(extractField(raw, 'product'));
  row.campaign = text(extractField(raw, 'campaign'));
  row.assignedTo = text(extractField(raw, 'assignedTo'));
  row.previouslyAssigned = text(extractField(raw, 'previouslyAssigned'));
  row.tat = text(extractField(raw, 'tat'));
  row.interestedAmount = text(extractField(raw, 'interestedAmount'));
  row.otherInfo = text(extractField(raw, 'otherInfo'));
  row.initialStatus = text(extractField(raw, 'initialStatus'));
  row.initialRemarks = text(extractField(raw, 'initialRemarks'));
  row.followUp = text(extractField(raw, 'followUp'));
  row.finalRemarks = text(extractField(raw, 'finalRemarks'));
  // Legacy API-shaped payloads carry their status in currentStatus; real
  // sheet rows carry Initial Status / Follow up instead.
  row.currentStatus = text(raw.currentStatus ?? raw.current_status);

  const dateFields: Array<[string, unknown, 'assignedDate' | 'leadDate' | 'firstCallDate' | 'followUpDate']> = [
    ['Assigned Date', extractField(raw, 'assignedDate'), 'assignedDate'],
    ['Lead Date', extractField(raw, 'leadDate'), 'leadDate'],
    ['1st Call date', extractField(raw, 'firstCallDate'), 'firstCallDate'],
    ['Follow up date', extractField(raw, 'followUpDate'), 'followUpDate'],
  ];
  for (const [label, value, target] of dateFields) {
    const rawText = value instanceof Date ? value.toISOString() : text(value);
    const iso = parseImportDate(value);
    if (rawText && !iso) {
      row.issues.push(`${label} "${rawText}" is not a recognizable date`);
    }
    row[target] = iso;
  }

  // ---- local (DB-free) validation ----
  if (!row.name) row.issues.push('Name is required');
  if (!row.phone) {
    row.issues.push('Phone is required');
  } else if (!hasUsablePhone(row.phone)) {
    row.issues.push(`Phone "${row.phone}" does not contain a usable number`);
  }
  if (row.email && !isValidEmail(row.email)) {
    row.issues.push(`E-mail "${row.email}" is not a valid email address`);
  }

  return row;
}

/**
 * Stable fingerprint of the snapshot a row represents. Used to detect
 * exact duplicates (within one upload or against an existing lead that
 * was just imported) so they can be skipped instead of rewritten.
 * Field order matters - keep deterministic.
 */
export function rowFingerprint(row: {
  name: string; phone: string; email: string; area: string; source: string;
  product: string; campaign: string; assignedTo: string; previouslyAssigned: string;
  tat: string; interestedAmount: string; otherInfo: string; initialStatus: string;
  initialRemarks: string; followUp: string; finalRemarks: string;
  assignedDate: string | null; leadDate: string | null; firstCallDate: string | null;
  followUpDate: string | null;
}, resolvedAssignee: string): string {
  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    parts.push(`${label}=${value === null || value === undefined ? '' : String(value).trim().toLowerCase()}`);
  };
  push('name', row.name);
  push('phone', normalizePhoneKey(row.phone));
  push('email', row.email);
  push('area', row.area);
  push('source', row.source);
  push('product', row.product);
  push('campaign', row.campaign);
  push('assignee', resolvedAssignee);
  push('prevAssigned', row.previouslyAssigned);
  push('tat', row.tat);
  push('amount', row.interestedAmount);
  push('otherInfo', row.otherInfo);
  push('initialStatus', row.initialStatus);
  push('initialRemarks', row.initialRemarks);
  push('followUp', row.followUp);
  push('finalRemarks', row.finalRemarks);
  push('assignedDate', row.assignedDate);
  push('leadDate', row.leadDate);
  push('firstCall', row.firstCallDate);
  push('followUpDate', row.followUpDate);
  return parts.join('|');
}

/**
 * Parse the "Interested amount of investment" column. Returns a number
 * when the value is a clean numeric amount (commas/spaces/currency
 * symbols tolerated), otherwise null so the caller can preserve the
 * raw text instead of guessing.
 */
export function parseAmount(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,\s]/g, '').replace(/(?:bdt|tk|taka|usd|\$|৳)/gi, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse TAT (turnaround time in days). Numeric when clean, otherwise
 * null so the raw text is preserved in custom_fields instead.
 */
export function parseTat(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/\s/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
