/**
 * leadQualitySignals.ts — bulk signal aggregation for Lead Quality scoring.
 * ------------------------------------------------------------------
 * The pure formula lives in leadQuality.ts. This module answers "what are
 * the signals for THESE leads" with a constant number of queries no
 * matter how many leads are scored:
 *
 *   1 × lead_activities aggregate   (history: recency/engagement/failed)
 *   1 × scheduled_activities query  (planned next action)
 *
 * There is deliberately NO per-lead query here — every consumer (lead
 * list, follow-up queue, scheduled list, single lead, dashboard) passes
 * the whole id set once. Lead-row signals (status, next_follow_up_at,
 * last_contacted_at, created_at, expected_premium, custom_fields) come
 * from rows the caller ALREADY fetched; they never trigger extra reads.
 *
 * Degradation policy: each bulk query is wrapped in try/catch. The
 * lead_activities (037) and scheduled_activities (039) tables always
 * exist in migrated databases; if a query ever fails the signals degrade
 * to neutral (empty history / no planned action) with a warning instead
 * of failing the enclosing read. Scoring stays deterministic for the
 * data actually available.
 */

import {
  calculateLeadQuality,
  toCompactQuality,
  type LeadQualityBand,
  type LeadQualityInput,
  type LeadQualityResult,
} from './leadQuality.js';
import { parseAmount } from '../routes/leadImport.js';

export interface ActivityQualitySignals {
  lastActivityAt: string | null;
  failedContactCount: number;
  meaningfulEngagementCount: number;
}

export interface ScheduledQualitySignals {
  nextScheduledAt: string | null;
}

/**
 * Accepts EITHER a snake_case PostgreSQL lead row (leads table) OR a
 * camelCase mapped/fallback lead object. Only quality-signal fields are
 * read; ownership/visibility fields are never consulted here (callers
 * enforce visibility BEFORE scoring).
 */
export interface LeadRowLike {
  id?: unknown;
  dbId?: unknown;
  current_status?: unknown;
  currentStatus?: unknown;
  next_follow_up_at?: unknown;
  nextFollowUpAt?: unknown;
  nextFollowUpDate?: unknown;
  last_contacted_at?: unknown;
  lastFollowUpDate?: unknown;
  created_at?: unknown;
  creationDate?: unknown;
  timestamp?: unknown;
  expected_premium?: unknown;
  projectedNCP?: unknown;
  custom_fields?: unknown;
  customFields?: unknown;
}

function firstPresent(row: LeadRowLike, ...keys: Array<keyof LeadRowLike>): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return null;
}

function asTimestamp(value: unknown): Date | string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Explicit investment interest — ONLY when the customer/supplied record
 * carries a real positive amount:
 *   1. leads.expected_premium (incl. follow-up projectedNCP writes)
 *   2. numeric custom_fields.interestedAmount (bulk-import column)
 * Missing/non-numeric/zero amounts → no signal (never a penalty).
 */
export function parseExplicitInvestmentAmount(
  expectedPremium: unknown,
  interestedAmountRaw: unknown
): { hasAmount: boolean; amount: number | null } {
  const premium = Number(
    expectedPremium === '' || expectedPremium == null ? NaN : expectedPremium
  );
  if (Number.isFinite(premium) && premium > 0) {
    return { hasAmount: true, amount: premium };
  }
  if (interestedAmountRaw !== undefined && interestedAmountRaw !== null) {
    if (typeof interestedAmountRaw === 'number') {
      if (Number.isFinite(interestedAmountRaw) && interestedAmountRaw > 0) {
        return { hasAmount: true, amount: interestedAmountRaw };
      }
      return { hasAmount: false, amount: null };
    }
    const parsed = parseAmount(String(interestedAmountRaw).trim());
    if (parsed !== null && parsed > 0) return { hasAmount: true, amount: parsed };
  }
  return { hasAmount: false, amount: null };
}

/* ====================================================================
   BULK SIGNAL QUERIES (one query per signal family, any lead count)
==================================================================== */

/**
 * Actual-history aggregates for a set of leads (immutable lead_activities
 * ONLY — planned scheduled_activities never count as completed history).
 *
 * Status matching mirrors the canonical normalization used by scoring:
 * `No Response` includes the legacy `Unreachable` wording
 * (case-insensitive; all write paths store canonical values).
 */
export async function fetchActivityQualitySignals(
  pool: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  leadIds: string[]
): Promise<Map<string, ActivityQualitySignals>> {
  const out = new Map<string, ActivityQualitySignals>();
  const ids = Array.from(new Set((leadIds || []).filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const res = await pool.query(
      `SELECT a.lead_id::text AS lead_id,
              MAX(a.created_at) AS last_activity_at,
              COUNT(*) FILTER (WHERE LOWER(a.status) IN ('no response', 'unreachable'))::int AS failed_contact_count,
              COUNT(*) FILTER (WHERE LOWER(a.status) IN ('interested', 'meeting fixed', 'meeting completed', 'pipeline locked', 'converted'))::int AS meaningful_engagement_count
         FROM lead_activities a
        WHERE a.lead_id = ANY($1::uuid[])
        GROUP BY a.lead_id`,
      [ids]
    );
    for (const row of res.rows || []) {
      out.set(String(row.lead_id), {
        lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
        failedContactCount: Number(row.failed_contact_count) || 0,
        meaningfulEngagementCount: Number(row.meaningful_engagement_count) || 0,
      });
    }
  } catch (error: any) {
    console.warn(
      '[leadQuality] activity signals unavailable, scoring without history:',
      error?.message || error
    );
  }
  return out;
}

/**
 * Earliest still-pending planned action per lead (mutable
 * scheduled_activities ONLY — used for follow-up discipline, never as
 * completed engagement).
 */
export async function fetchScheduledQualitySignals(
  pool: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  leadIds: string[]
): Promise<Map<string, ScheduledQualitySignals>> {
  const out = new Map<string, ScheduledQualitySignals>();
  const ids = Array.from(new Set((leadIds || []).filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    const res = await pool.query(
      `SELECT s.lead_id::text AS lead_id,
              MIN(s.scheduled_at) AS next_scheduled_at
         FROM scheduled_activities s
        WHERE s.lead_id = ANY($1::uuid[])
          AND LOWER(s.status) = 'scheduled'
        GROUP BY s.lead_id`,
      [ids]
    );
    for (const row of res.rows || []) {
      out.set(String(row.lead_id), {
        nextScheduledAt: row.next_scheduled_at
          ? new Date(row.next_scheduled_at).toISOString()
          : null,
      });
    }
  } catch (error: any) {
    console.warn(
      '[leadQuality] scheduled signals unavailable, scoring without planned actions:',
      error?.message || error
    );
  }
  return out;
}

/* ====================================================================
   SCORING FROM ROWS (no I/O — pure composition)
==================================================================== */

/** Resolve the canonical lead uuid for signal-map lookup. */
export function leadSignalKey(row: LeadRowLike): string {
  const dbId = row.dbId != null ? String(row.dbId) : '';
  if (dbId) return dbId;
  return row.id != null ? String(row.id) : '';
}

function customField(row: LeadRowLike, key: string): unknown {
  const bag = (row.custom_fields ?? row.customFields) as Record<string, any> | null | undefined;
  if (!bag || typeof bag !== 'object') return undefined;
  return (bag as Record<string, any>)[key];
}

/** Build the pure-formula input from an already-fetched row + signals. */
export function qualityInputFromRow(
  row: LeadRowLike,
  activity: ActivityQualitySignals | undefined,
  scheduled: ScheduledQualitySignals | undefined,
  now?: Date | string
): LeadQualityInput {
  const investment = parseExplicitInvestmentAmount(
    firstPresent(row, 'expected_premium', 'projectedNCP'),
    customField(row, 'interestedAmount')
  );
  return {
    status: firstPresent(row, 'current_status', 'currentStatus'),
    lastContactedAt: asTimestamp(firstPresent(row, 'last_contacted_at', 'lastFollowUpDate')),
    lastActivityAt: asTimestamp(activity?.lastActivityAt ?? null),
    createdAt: asTimestamp(firstPresent(row, 'created_at', 'creationDate', 'timestamp')),
    nextFollowUpAt: asTimestamp(
      firstPresent(row, 'next_follow_up_at', 'nextFollowUpAt', 'nextFollowUpDate')
    ),
    nextScheduledAt: asTimestamp(scheduled?.nextScheduledAt ?? null),
    hasInvestmentAmount: investment.hasAmount,
    investmentAmount: investment.amount,
    failedContactCount: activity?.failedContactCount ?? 0,
    meaningfulEngagementCount: activity?.meaningfulEngagementCount ?? 0,
    now,
  };
}

/** Full explanation for one already-fetched row (no I/O). */
export function scoreLeadRow(
  row: LeadRowLike,
  activity: ActivityQualitySignals | undefined,
  scheduled: ScheduledQualitySignals | undefined,
  now?: Date | string
): LeadQualityResult {
  return calculateLeadQuality(qualityInputFromRow(row, activity, scheduled, now));
}

/** Compact { score, band } for one already-fetched row (no I/O). */
export function compactScoreLeadRow(
  row: LeadRowLike,
  activity: ActivityQualitySignals | undefined,
  scheduled: ScheduledQualitySignals | undefined,
  now?: Date | string
): { score: number; band: LeadQualityBand } {
  return toCompactQuality(scoreLeadRow(row, activity, scheduled, now));
}

/* ====================================================================
   DASHBOARD AGGREGATES (one narrow scan + the two bulk signal queries)
==================================================================== */

export interface LeadQualityDashboard {
  hot: number;
  warm: number;
  developing: number;
  cold: number;
  /** Mean score across scored active leads (null when none). */
  activeAverage: number | null;
  /** Active leads scored (terminal outcomes excluded by definition). */
  activeScored: number;
  /** Active leads carrying at least one attention reason. */
  needsAttention: number;
}

export function emptyQualityDashboard(): LeadQualityDashboard {
  return {
    hot: 0,
    warm: 0,
    developing: 0,
    cold: 0,
    activeAverage: null,
    activeScored: 0,
    needsAttention: 0,
  };
}

/**
 * Aggregate quality over ALL active visible leads with exactly three
 * bounded queries (narrow lead scan + two bulk signal queries) and
 * in-memory scoring. Visibility is enforced by the caller's WHERE clause
 * — this helper never widens scope.
 */
export async function aggregateQualityForScope(
  pool: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  visibilitySql: string,
  visibilityParams: any[],
  terminalStatuses: string[],
  now?: Date | string
): Promise<LeadQualityDashboard> {
  const params: any[] = [...visibilityParams, terminalStatuses];
  const pTerminal = params.length;
  let rows: any[] = [];
  try {
    const res = await pool.query(
      `SELECT l.id::text AS id,
              l.current_status,
              l.next_follow_up_at,
              l.last_contacted_at,
              l.created_at,
              l.expected_premium,
              l.custom_fields->>'interestedAmount' AS interested_amount_raw
         FROM leads l
        WHERE l.is_deleted = FALSE
          AND l.current_status <> ALL($${pTerminal}::text[])
          AND (${visibilitySql})`,
      params
    );
    rows = res.rows || [];
  } catch (error: any) {
    console.warn(
      '[leadQuality] dashboard quality scan unavailable:',
      error?.message || error
    );
    return emptyQualityDashboard();
  }
  if (rows.length === 0) return emptyQualityDashboard();

  const ids = rows.map(r => String(r.id));
  const [activityMap, scheduledMap] = await Promise.all([
    fetchActivityQualitySignals(pool, ids),
    fetchScheduledQualitySignals(pool, ids),
  ]);

  const agg = emptyQualityDashboard();
  let sum = 0;
  for (const row of rows) {
    const id = String(row.id);
    const result = scoreLeadRow(
      {
        id,
        current_status: row.current_status,
        next_follow_up_at: row.next_follow_up_at,
        last_contacted_at: row.last_contacted_at,
        created_at: row.created_at,
        expected_premium: row.expected_premium,
        custom_fields: { interestedAmount: row.interested_amount_raw },
      },
      activityMap.get(id),
      scheduledMap.get(id),
      now
    );
    // Terminal guard: scope already excludes terminal statuses, but a
    // custom/alias edge must never pollute the active bands.
    if (result.isTerminal) continue;
    agg.activeScored += 1;
    sum += result.score;
    if (result.band === 'Hot') agg.hot += 1;
    else if (result.band === 'Warm') agg.warm += 1;
    else if (result.band === 'Developing') agg.developing += 1;
    else agg.cold += 1;
    if (result.attentionReasons.length > 0) agg.needsAttention += 1;
  }
  agg.activeAverage =
    agg.activeScored > 0 ? Math.round((sum / agg.activeScored) * 10) / 10 : null;
  return agg;
}

/**
 * In-memory equivalent for development demo mode (fallbackStore): scores
 * fallback leads from in-memory activity/scheduled arrays. Same formula,
 * same contract — no I/O.
 */
export function aggregateQualityForFallbackLeads(
  leads: any[],
  leadActivities: any[],
  scheduledActivities: any[],
  now?: Date | string
): LeadQualityDashboard {
  const agg = emptyQualityDashboard();
  const terminal = new Set(['converted', 'not interested']);
  const byLeadActivities = new Map<string, any[]>();
  for (const a of leadActivities || []) {
    const key = String(a.leadId ?? a.lead_id ?? '');
    if (!key) continue;
    const list = byLeadActivities.get(key) || [];
    list.push(a);
    byLeadActivities.set(key, list);
  }
  const MEANINGFUL = new Set([
    'interested',
    'meeting fixed',
    'meeting completed',
    'pipeline locked',
    'converted',
  ]);
  let sum = 0;
  for (const lead of leads || []) {
    if (lead?.is_deleted === true) continue;
    const status = String(lead?.currentStatus || '');
    if (terminal.has(status.toLowerCase())) continue;
    const acts = byLeadActivities.get(String(lead.id)) || [];
    let lastActivityAt: string | null = null;
    let failed = 0;
    let meaningful = 0;
    for (const a of acts) {
      const at = String(a.createdAt ?? a.created_at ?? '');
      if (at && (!lastActivityAt || at > lastActivityAt)) lastActivityAt = at;
      const st = String(a.status || '').toLowerCase();
      if (st === 'no response' || st === 'unreachable') failed += 1;
      if (MEANINGFUL.has(st)) meaningful += 1;
    }
    let nextScheduledAt: string | null = null;
    for (const s of scheduledActivities || []) {
      if (String(s.leadId ?? s.lead_id ?? '') !== String(lead.id)) continue;
      if (String(s.status || '').toLowerCase() !== 'scheduled') continue;
      const at = String(s.scheduledAt ?? s.scheduled_at ?? '');
      if (at && (!nextScheduledAt || at < nextScheduledAt)) nextScheduledAt = at;
    }
    const result = scoreLeadRow(
      lead as LeadRowLike,
      { lastActivityAt, failedContactCount: failed, meaningfulEngagementCount: meaningful },
      { nextScheduledAt },
      now
    );
    if (result.isTerminal) continue;
    agg.activeScored += 1;
    sum += result.score;
    if (result.band === 'Hot') agg.hot += 1;
    else if (result.band === 'Warm') agg.warm += 1;
    else if (result.band === 'Developing') agg.developing += 1;
    else agg.cold += 1;
    if (result.attentionReasons.length > 0) agg.needsAttention += 1;
  }
  agg.activeAverage =
    agg.activeScored > 0 ? Math.round((sum / agg.activeScored) * 10) / 10 : null;
  return agg;
}

/**
 * Compact quality for fallback (demo-mode) leads in bulk, keyed by lead
 * id. Same formula as the database path.
 */
export function compactQualityForFallbackLeads(
  leads: any[],
  leadActivities: any[],
  scheduledActivities: any[],
  now?: Date | string
): Map<string, { score: number; band: LeadQualityBand }> {
  const out = new Map<string, { score: number; band: LeadQualityBand }>();
  const MEANINGFUL = new Set([
    'interested',
    'meeting fixed',
    'meeting completed',
    'pipeline locked',
    'converted',
  ]);
  const byLeadActivities = new Map<string, any[]>();
  for (const a of leadActivities || []) {
    const key = String(a.leadId ?? a.lead_id ?? '');
    if (!key) continue;
    const list = byLeadActivities.get(key) || [];
    list.push(a);
    byLeadActivities.set(key, list);
  }
  const nextScheduledByLead = new Map<string, string>();
  for (const s of scheduledActivities || []) {
    if (String(s.status || '').toLowerCase() !== 'scheduled') continue;
    const key = String(s.leadId ?? s.lead_id ?? '');
    const at = String(s.scheduledAt ?? s.scheduled_at ?? '');
    if (!key || !at) continue;
    const prev = nextScheduledByLead.get(key);
    if (!prev || at < prev) nextScheduledByLead.set(key, at);
  }
  for (const lead of leads || []) {
    const key = String(lead?.id ?? '');
    if (!key) continue;
    const acts = byLeadActivities.get(key) || [];
    let lastActivityAt: string | null = null;
    let failed = 0;
    let meaningful = 0;
    for (const a of acts) {
      const at = String(a.createdAt ?? a.created_at ?? '');
      if (at && (!lastActivityAt || at > lastActivityAt)) lastActivityAt = at;
      const st = String(a.status || '').toLowerCase();
      if (st === 'no response' || st === 'unreachable') failed += 1;
      if (MEANINGFUL.has(st)) meaningful += 1;
    }
    out.set(
      key,
      compactScoreLeadRow(
        lead as LeadRowLike,
        { lastActivityAt, failedContactCount: failed, meaningfulEngagementCount: meaningful },
        { nextScheduledAt: nextScheduledByLead.get(key) ?? null },
        now
      )
    );
  }
  return out;
}

/** Full explanation for one fallback (demo-mode) lead. */
export function scoreFallbackLead(
  lead: any,
  leadActivities: any[],
  scheduledActivities: any[],
  now?: Date | string
): LeadQualityResult {
  const key = String(lead?.id ?? '');
  const MEANINGFUL = new Set([
    'interested',
    'meeting fixed',
    'meeting completed',
    'pipeline locked',
    'converted',
  ]);
  let lastActivityAt: string | null = null;
  let failed = 0;
  let meaningful = 0;
  for (const a of leadActivities || []) {
    if (String(a.leadId ?? a.lead_id ?? '') !== key) continue;
    const at = String(a.createdAt ?? a.created_at ?? '');
    if (at && (!lastActivityAt || at > lastActivityAt)) lastActivityAt = at;
    const st = String(a.status || '').toLowerCase();
    if (st === 'no response' || st === 'unreachable') failed += 1;
    if (MEANINGFUL.has(st)) meaningful += 1;
  }
  let nextScheduledAt: string | null = null;
  for (const s of scheduledActivities || []) {
    if (String(s.leadId ?? s.lead_id ?? '') !== key) continue;
    if (String(s.status || '').toLowerCase() !== 'scheduled') continue;
    const at = String(s.scheduledAt ?? s.scheduled_at ?? '');
    if (at && (!nextScheduledAt || at < nextScheduledAt)) nextScheduledAt = at;
  }
  return scoreLeadRow(
    lead as LeadRowLike,
    { lastActivityAt, failedContactCount: failed, meaningfulEngagementCount: meaningful },
    { nextScheduledAt },
    now
  );
}
