import { PolicyLookupError, readGoogleSheetRange } from './PolicyLookupService.js';

/**
 * CorporateClientsService — the company master for Corporate Group
 * Leads (Mahadi, 2026-11-24).
 * ------------------------------------------------------------------
 * Shanta Life holds group insurance with a set of companies; the
 * field force sells individual policies to those companies'
 * employees. MIS keeps the company list in a Google Sheet tab —
 * 'Corporate Clients' in the SAME workbook as the policy lookup —
 * and maintains it themselves, so the master is read LIVE from the
 * sheet (no DB table, no sync job): a newly added client appears
 * automatically, at most one cache TTL later.
 *
 * Tab shape (Mahadi): header row 1, A: Code, B: Company Name.
 * Columns are matched BY HEADER NAME first (like the policy
 * lookup), falling back to positions A/B when the headers are
 * absent or renamed.
 *
 * The tab DOES NOT EXIST YET (Mahadi creates it later). Every
 * read path degrades gracefully: a missing tab, an empty sheet or
 * a Sheets outage returns an empty list with available=false —
 * never a 500. The Add Lead picker then offers a manual code
 * input; bulk import fails closed on code rows (see leads.routes).
 *
 * Auth reuses the policy lookup's service-account helper
 * (readGoogleSheetRange) — same GOOGLE_* env vars, same 10-minute
 * per-range cache, same test seam (_setPolicyLookupReaderForTest).
 * Parsed clients get their own 10-minute cache on top; a failed
 * read is cached for 60 seconds so a down sheet is not hammered
 * on every keystroke.
 */

export const CORPORATE_SOURCE = 'Corporate Client Group Insurance';

export const CORPORATE_CLIENTS_RANGE = `'Corporate Clients'!A1:B`;

export interface CorporateClient {
  code: string;
  name: string;
}

export interface CorporateClientListResult {
  clients: CorporateClient[];
  /** False when the sheet could not be read (missing tab / outage). */
  available: boolean;
  /** Human-readable reason when available is false. */
  error?: string;
}

const SEARCH_LIMIT = 20;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;

let parsedCache: { at: number; result: CorporateClientListResult } | null = null;

/** Test seam: clears the parsed-client cache. */
export function _resetCorporateClientsForTest(): void {
  parsedCache = null;
}

const headerKey = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Parse the tab's raw values into clients. Pure — no I/O, so tests
 * can pin the shape without a sheet. Header row first: 'Code' and
 * 'Company Name' by name, else columns A/B. Rows with no code are
 * skipped (a name without a code cannot be matched); duplicate
 * codes keep the FIRST row (the sheet's own order wins).
 */
export function parseCorporateClientRows(values: string[][]): CorporateClient[] {
  if (!values || values.length < 2) return [];
  const headers = (values[0] || []).map(headerKey);
  let codeIdx = headers.indexOf('code');
  let nameIdx = headers.indexOf('companyname');
  if (codeIdx < 0) codeIdx = 0;
  if (nameIdx < 0) nameIdx = 1;
  const seen = new Set<string>();
  const out: CorporateClient[] = [];
  for (const row of values.slice(1)) {
    const code = String(row[codeIdx] ?? '').trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, name: String(row[nameIdx] ?? '').trim() });
  }
  return out;
}

/**
 * Read the client list (cached). Never throws for a sheet problem:
 * a missing tab or outage yields { clients: [], available: false }.
 */
export async function listCorporateClients(): Promise<CorporateClientListResult> {
  if (parsedCache) {
    const ttl = parsedCache.result.available ? CACHE_TTL_MS : FAILURE_CACHE_MS;
    if (Date.now() - parsedCache.at < ttl) return parsedCache.result;
  }
  try {
    const values = await readGoogleSheetRange(CORPORATE_CLIENTS_RANGE);
    const result: CorporateClientListResult = { clients: parseCorporateClientRows(values), available: true };
    parsedCache = { at: Date.now(), result };
    return result;
  } catch (error: any) {
    const message =
      error instanceof PolicyLookupError
        ? 'The Corporate Clients sheet could not be read. Ask MIS to check the tab, or enter the client code manually.'
        : 'The Corporate Clients sheet could not be read. Enter the client code manually.';
    const result: CorporateClientListResult = { clients: [], available: false, error: message };
    parsedCache = { at: Date.now(), result };
    return result;
  }
}

/**
 * Rank clients for an autocomplete query. Pure. Exact name match
 * (case-insensitive) first, then name starts-with, then name
 * contains, then code contains; alphabetical by name inside a
 * rank. Empty query returns no rows — the picker shows nothing
 * until the user types. Capped at 20.
 */
export function rankCorporateSearch(clients: CorporateClient[], query: string): CorporateClient[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ client: CorporateClient; rank: number }> = [];
  for (const client of clients) {
    const name = client.name.toLowerCase();
    const code = client.code.toLowerCase();
    let rank = -1;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (code.includes(q)) rank = 3;
    if (rank >= 0) scored.push({ client, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.client.name.localeCompare(b.client.name) || a.client.code.localeCompare(b.client.code));
  return scored.slice(0, SEARCH_LIMIT).map(s => s.client);
}

/** Exact code match, case-insensitive. Pure. Null when no client carries the code. */
export function matchCorporateCode(clients: CorporateClient[], value: string): CorporateClient | null {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  return clients.find(c => c.code.toLowerCase() === v) || null;
}

export async function searchCorporateClients(query: string): Promise<CorporateClientListResult & { clients: CorporateClient[] }> {
  const list = await listCorporateClients();
  return { ...list, clients: rankCorporateSearch(list.clients, query) };
}

export async function findCorporateClientByCode(code: string): Promise<{ client: CorporateClient | null; available: boolean }> {
  const list = await listCorporateClients();
  return { client: matchCorporateCode(list.clients, code), available: list.available };
}
