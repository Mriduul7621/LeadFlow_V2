import { createSign } from 'node:crypto';

/**
 * PolicyLookupService — conversion auto-fill from the retail sales sheet.
 * ------------------------------------------------------------------
 * When an agent marks a lead Converted, they enter a Proposal No or
 * Policy No; this service looks the policy up in the 'SLI_Retail Sales
 * Dashboard' Google Sheet and returns the REAL policy data so the form
 * auto-fills instead of relying on manual typing.
 *
 * Sources (Mahadi, 2026-11-17):
 *   1. 'Due and Lapse Policy List' (PRIMARY) — headers on ROW 1.
 *      Policy No (A), Comm. Date (F), Plan Name (I), Term (J),
 *      Premium (M), Sum Assured (O), Pay Mode (U), Proposal No (Z),
 *      FA Code (AB). Holds 1,925 of 2,266 policies.
 *   2. 'PR Database' (FALLBACK) — headers on ROW 3. Match Policy No,
 *      then take that policy's SINGLE New PR row (PR TYPE = New —
 *      exactly one per policy; the conversion record). Product Name (Q)
 *      else PLAN (J); TERM (I); PAYMENT MODE (K); New Premium (AK)
 *      else TOTAL PREM. (L). No Sum Assured lives here.
 *   3. Both miss -> null (the endpoint answers 404 POLICY_NOT_FOUND;
 *      the form stays manually editable — conversion is never blocked).
 *
 * Hard rules baked in here:
 *   - Columns are matched BY HEADER NAME, never by fixed index alone.
 *   - Proposal No is its OWN sequence, NOT "Pro-{Policy No}" — each
 *     key is matched against its own column (1,861/1,925 differ).
 *   - NEVER match on PR NO alone: 322 PR numbers repeat across
 *     policies (T-series reused conventional PR numbers from Oct 2025).
 *   - Shanta Assurance / T-series has NO sum assured anywhere: the
 *     field stays null, never 0, never invented.
 *   - Only the ONE matched policy is ever returned — never the sheet.
 *   - The private key is never logged.
 *
 * Access: service account, env vars GOOGLE_SERVICE_ACCOUNT_EMAIL /
 * GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID (same names the retail dashboard
 * and the recruitment tracker use). Auth is a hand-rolled RS256 JWT +
 * fetch, mirroring the retail dashboard's proven code — zero new
 * dependencies, and the sheet reader is injectable for tests.
 * Missing env -> 503; the lookup endpoint answers it, manual
 * conversion is unaffected.
 *
 * Caching: parsed sheet values are cached in-memory per process with a
 * 10-minute TTL so one conversion does not hammer the Sheets API.
 * (Serverless processes are short-lived; a per-process cache is fine.)
 */
export interface MatchedPolicy {
  policyNo: string;
  proposalNo: string | null;
  productName: string;
  /** Null when unavailable — T-series / PR-database fallback. Never 0. */
  sumAssured: number | null;
  /** Due Premium (M), or the New PR row's New Premium (AK). */
  collectedNCP: number | null;
  term: string | null;
  payMode: string | null;
  faCode: string | null;
  /** Commencement date, ISO yyyy-mm-dd when parseable, else raw. */
  commDate: string | null;
  source: 'due' | 'pr-database';
  /** True for Shanta Assurance / T-series (no sum assured exists). */
  isTermPolicy: boolean;
}

/** Typed lookup failure: the endpoint maps status/code straight through. */
export class PolicyLookupError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PolicyLookupError';
    this.status = status;
    this.code = code;
  }
}

const SHEET_ID_ENV = 'GOOGLE_SHEET_ID';
const EMAIL_ENV = 'GOOGLE_SERVICE_ACCOUNT_EMAIL';
const KEY_ENV = 'GOOGLE_PRIVATE_KEY';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DUE_RANGE = `'Due and Lapse Policy List'!A1:BU`;
const PR_RANGE = `'PR Database'!A1:AR`;
const CACHE_TTL_MS = 10 * 60 * 1000;

const DUE_HEADER_ROW = 0;
const PR_HEADER_ROW = 2;

/** T-series policy numbers start with 'T' (conventional ones are numeric). */
export function isTermPolicy(policyNo: unknown, productName?: unknown): boolean {
  const no = String(policyNo ?? '').trim();
  if (/^t/i.test(no)) return true;
  return /shanta\s*assurance/i.test(String(productName ?? ''));
}

/* ------------------------------------------------------------------ */
/* Sheet value helpers (same normalisation as the retail dashboard)    */
/* ------------------------------------------------------------------ */

const headerKey = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

type SheetRow = Record<string, string>;

/** First non-empty cell among the named headers (header names, not indexes). */
function valueOf(row: SheetRow, keys: string[], ...names: string[]): string {
  for (const name of names) {
    const key = headerKey(name);
    if (!keys.includes(key)) continue;
    const value = row[key];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

/** Sheet money: strips ৳ / commas / spaces. Null when empty or not a number. */
function numberOf(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[৳,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Sheet date -> ISO yyyy-mm-dd when parseable, else the raw trimmed text. */
function dateOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})$/);
  if (m) {
    const month = new Date(`${m[2]} 1 2000`).getMonth();
    if (Number.isFinite(month)) {
      const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    }
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return `${String(year).padStart(4, '0')}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

/** Rows below the header row, keyed by normalised header name. */
function table(values: string[][], headerRowIndex: number): SheetRow[] {
  if (!values || values.length <= headerRowIndex) return [];
  const headers = (values[headerRowIndex] || []).map(headerKey);
  return values
    .slice(headerRowIndex + 1)
    .map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])) as SheetRow)
    .filter(row => Object.values(row).some(v => v !== ''));
}

function textOrNull(value: string): string | null {
  const t = String(value ?? '').trim();
  return t ? t : null;
}

/* ------------------------------------------------------------------ */
/* Google auth + Sheets read (zero new dependencies)                   */
/* ------------------------------------------------------------------ */

let tokenCache = { value: '', expires: 0 };

function readServiceAccountConfig(): { email: string; privateKey: string; sheetId: string } {
  const email = (process.env[EMAIL_ENV] || '').trim();
  const sheetId = (process.env[SHEET_ID_ENV] || '').trim();
  let privateKey = (process.env[KEY_ENV] || '').trim();
  if (privateKey.startsWith('{')) {
    try {
      privateKey = JSON.parse(privateKey).private_key || '';
    } catch {
      throw new PolicyLookupError(503, 'INVALID_PRIVATE_KEY', 'GOOGLE_PRIVATE_KEY is not valid. Paste the private_key value from the service-account JSON file.');
    }
  }
  if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '').trim();
  if (!email || !privateKey || !sheetId) {
    throw new PolicyLookupError(
      503,
      'SYNC_NOT_CONFIGURED',
      'Policy lookup is not configured yet. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_SHEET_ID on the LeadFlow project, then try again. Manual conversion still works.',
    );
  }
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
    throw new PolicyLookupError(503, 'INVALID_PRIVATE_KEY', 'GOOGLE_PRIVATE_KEY format is invalid. Use only the private_key value from the downloaded JSON, including its BEGIN/END PRIVATE KEY lines.');
  }
  return { email, privateKey, sheetId };
}

async function accessToken(): Promise<string> {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60_000) return tokenCache.value;
  const { email, privateKey } = readServiceAccountConfig();
  const b64url = (value: string): string => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: email,
    scope: TOKEN_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))}`;
  let assertion: string;
  try {
    const sign = createSign('RSA-SHA256');
    sign.update(unsigned);
    assertion = `${unsigned}.${sign.sign(privateKey, 'base64url')}`;
  } catch {
    throw new PolicyLookupError(503, 'INVALID_PRIVATE_KEY', 'GOOGLE_PRIVATE_KEY could not be decoded. Paste the private_key field from the JSON key file and preserve its line breaks.');
  }
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PolicyLookupError(502, 'GOOGLE_AUTH_FAILED', result?.error_description || 'Google authentication failed.');
  }
  tokenCache = { value: result.access_token, expires: Date.now() + (result.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function readSheetValuesLive(range: string): Promise<string[][]> {
  const { sheetId } = readServiceAccountConfig();
  const token = await accessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PolicyLookupError(502, 'SHEET_READ_FAILED', 'Could not read the retail sales sheet. Please try again — manual conversion still works.');
  }
  return (body.values || []) as string[][];
}

/* ------------------------------------------------------------------ */
/* Cache + test seams                                                  */
/* ------------------------------------------------------------------ */

type SheetReader = (range: string) => Promise<string[][]>;

let sheetReaderOverride: SheetReader | null = null;
const sheetCache = new Map<string, { at: number; values: string[][] }>();

/** Test seam: replaces the Google read with fixture rows. */
export function _setPolicyLookupReaderForTest(reader: SheetReader | null): void {
  sheetReaderOverride = reader;
}

/** Test seam: clears the parsed-sheet cache (and the override reader). */
export function _resetPolicyLookupForTest(): void {
  sheetReaderOverride = null;
  sheetCache.clear();
  tokenCache = { value: '', expires: 0 };
}

async function readSheetCached(range: string): Promise<string[][]> {
  const cached = sheetCache.get(range);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
  const reader = sheetReaderOverride ?? readSheetValuesLive;
  const values = await reader(range);
  sheetCache.set(range, { at: Date.now(), values });
  return values;
}

/**
 * Shared cached sheet read for other services that live in the same
 * workbook (Corporate Clients, migration 065). Same auth, same
 * 10-minute per-range cache, same test seam — no second auth path.
 * Throws PolicyLookupError (503/502) when Sheets is unconfigured or
 * unreachable; callers that must degrade gracefully catch it.
 */
export async function readGoogleSheetRange(range: string): Promise<string[][]> {
  return readSheetCached(range);
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function matchDueRow(rows: SheetRow[], key: string): SheetRow | null {
  const normKey = key.trim().toLowerCase();
  // Policy No first: a bare number must match the Policy No column, never
  // a Proposal No that happens to contain it.
  for (const row of rows) {
    if (String(row.policyno ?? '').trim().toLowerCase() === normKey) return row;
  }
  for (const row of rows) {
    if (String(row.proposalno ?? '').trim().toLowerCase() === normKey) return row;
  }
  return null;
}

function matchPrNewRow(rows: SheetRow[], key: string): SheetRow | null {
  const normKey = key.trim().toLowerCase();
  // Match on POLICY NO only — PR NO repeats across policies, so it is
  // never a key. Then take the policy's single New PR row.
  const policyRows = rows.filter(r => String(r.policyno ?? '').trim().toLowerCase() === normKey);
  const newRows = policyRows.filter(r => String(r.prtype ?? '').trim().toLowerCase() === 'new');
  if (newRows.length === 0) return null;
  if (newRows.length === 1) return newRows[0];
  // Defensive only (exactly one New PR per policy by construction):
  // earliest PR DATE wins.
  return [...newRows].sort((a, b) => String(a.prdate ?? '').localeCompare(String(b.prdate ?? '')))[0];
}

function fromDueRow(row: SheetRow): MatchedPolicy {
  const keys = Object.keys(row);
  const policyNo = valueOf(row, keys, 'Policy No');
  const productName = valueOf(row, keys, 'Plan Name');
  return {
    policyNo,
    proposalNo: textOrNull(valueOf(row, keys, 'Proposal No')),
    productName,
    sumAssured: numberOf(valueOf(row, keys, 'Sum Assured')),
    collectedNCP: numberOf(valueOf(row, keys, 'Premium')),
    term: textOrNull(valueOf(row, keys, 'Term')),
    payMode: textOrNull(valueOf(row, keys, 'Pay Mode')),
    faCode: textOrNull(valueOf(row, keys, 'FA Code')),
    commDate: dateOf(valueOf(row, keys, 'Comm. Date Acc', 'Comm. Date')),
    source: 'due',
    isTermPolicy: isTermPolicy(policyNo, productName),
  };
}

function fromPrRow(row: SheetRow): MatchedPolicy {
  const keys = Object.keys(row);
  const policyNo = valueOf(row, keys, 'POLICY NO');
  const productName = valueOf(row, keys, 'Product Name', 'PLAN');
  const collected = numberOf(valueOf(row, keys, 'New Premium')) ?? numberOf(valueOf(row, keys, 'TOTAL PREM.'));
  return {
    policyNo,
    // The PR Database carries no Proposal No — only the Due sheet maps it.
    proposalNo: null,
    productName,
    // No Sum Assured lives in the PR Database. Null, never 0.
    sumAssured: null,
    collectedNCP: collected,
    term: textOrNull(valueOf(row, keys, 'TERM')),
    payMode: textOrNull(valueOf(row, keys, 'PAYMENT MODE')),
    faCode: textOrNull(valueOf(row, keys, 'FA Code')),
    commDate: dateOf(valueOf(row, keys, 'PR DATE')),
    source: 'pr-database',
    isTermPolicy: isTermPolicy(policyNo, productName),
  };
}

/**
 * Look a policy up by Proposal No or Policy No.
 * Returns the ONE matched policy, or null when neither sheet has it.
 * Throws PolicyLookupError (503/502) when Sheets is unconfigured or
 * unreachable — the caller maps it; manual conversion is unaffected.
 */
export async function lookupPolicy(key: string): Promise<MatchedPolicy | null> {
  const normKey = String(key ?? '').trim();
  if (!normKey) {
    throw new PolicyLookupError(400, 'INVALID_KEY', 'Enter a Proposal No or Policy No.');
  }
  const dueValues = await readSheetCached(DUE_RANGE);
  const dueRows = table(dueValues, DUE_HEADER_ROW);
  const dueHit = matchDueRow(dueRows, normKey);
  if (dueHit) return fromDueRow(dueHit);

  const prValues = await readSheetCached(PR_RANGE);
  const prRows = table(prValues, PR_HEADER_ROW);
  const prHit = matchPrNewRow(prRows, normKey);
  if (prHit) return fromPrRow(prHit);

  return null;
}
