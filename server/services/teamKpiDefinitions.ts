/**
 * teamKpiDefinitions.ts — the ONE server definition of the TL+ team
 * KPI keys and what each one counts (owner-approved 2026-11-13;
 * three more cards added the same day: Total Lead, Today Lead
 * Collection, No Action Alert).
 * ------------------------------------------------------------------
 * The overview counts (GET /api/team/overview), the leaf lead list
 * (GET /team/kpi/leads) and the export (GET /team/kpi/export) ALL
 * build their SQL from kpiLeadPredicate below — a count on a card
 * therefore equals the rows its drill-down shows, by construction,
 * never by two parallel hand-written definitions. The client mirrors
 * the keys/labels in src/modules/team/utils/kpiDrilldown.ts (labels
 * duplicated there by design: the client never fetches them).
 *
 * Definitions (production column shapes — current_status,
 * is_deleted, created_at, next_follow_up_at; assigned_to is the
 * assignee's user id, UUID FK → users.id per migration 014):
 *   open            = non-terminal + not deleted
 *   dueToday        = next_follow_up_at within the current Dhaka
 *                     business day — NO terminal filter (the
 *                     overview's due_today_count counts terminal
 *                     leads too; the list must contain exactly the
 *                     leads it counted)
 *   overdue         = non-terminal + not deleted + next_follow_up_at
 *                     before today's Dhaka start
 *   converted       = current_status = 'Converted'
 *   totalLeads      = every non-deleted lead assigned to the person,
 *                     any status (terminal included)
 *   todayCollection = created_at within the current Dhaka business
 *                     day — any status (a lead input today and
 *                     converted today is still collected today)
 *   noAction        = open (non-terminal, not deleted) AND created
 *                     more than 48 hours ago AND zero recorded
 *                     actions. A "recorded action" is ANY row in
 *                     lead_activities for the lead (follow-ups are
 *                     the only writers — lead creation writes none,
 *                     so a fresh lead correctly has zero) OR a
 *                     non-empty legacy leads.status_history JSONB
 *                     array (the pre-037 history, still appended by
 *                     the follow-up route for backward compat).
 *
 * The 48-hour boundary is timezone-correct by construction: the
 * cutoff is computed in JS (UTC) and compared as a UTC wall-clock
 * instant, the same pattern as the Dhaka day bounds — never via a
 * session-timezone-dependent NOW() (cf. the DZ-4 lockout fix, which
 * had to move expiry computation into JS for exactly this reason).
 * Naive TIMESTAMP columns store UTC wall time; a zoned ISO literal
 * compared to a timestamp column drops its zone without conversion,
 * so the cutoff matches stored values in any process timezone.
 *
 * Minimal-schema safety (the DZ-1 lesson): lead_activities and
 * leads.status_history may not exist in every database the code
 * runs against (older bootstraps, minimal test fixtures). The
 * no-action predicate therefore NEVER references them blindly —
 * probeNoActionSupport checks information_schema first, and a
 * missing table/column degrades to the semantically correct
 * reading (no activities table = no actions can exist; no history
 * column = no legacy history), never to a 500.
 */

import { TERMINAL_LEAD_STATUSES } from '../utils/businessTime.js';

export const KPI_KEYS = [
  'open',
  'dueToday',
  'overdue',
  'converted',
  'totalLeads',
  'todayCollection',
  'noAction',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export const KPI_LABELS: Record<KpiKey, string> = {
  open: 'Open leads',
  dueToday: 'Due today',
  overdue: 'Overdue',
  converted: 'Converted',
  totalLeads: 'Total Lead',
  todayCollection: 'Today Lead Collection',
  noAction: 'No Action Alert',
};

/** The no-action window: no first action within 48 hours of entry. */
export const NO_ACTION_WINDOW_MS = 48 * 3600 * 1000;

/** ISO instant of (now − 48h) — the no-action cutoff. */
export function noActionCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - NO_ACTION_WINDOW_MS).toISOString();
}

export function isKpiKey(value: string): value is KpiKey {
  return (KPI_KEYS as readonly string[]).includes(value);
}

/** The 400 message for an unknown KPI — built from the live key list. */
export function kpiKeysMessage(): string {
  return `kpi must be ${KPI_KEYS.join(', ')}.`;
}

export interface NoActionSupport {
  /** The lead_activities table exists (migration 037). */
  hasActivities: boolean;
  /** The leads.status_history JSONB column exists (legacy history). */
  hasStatusHistory: boolean;
}

type QueryablePool = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
};

/**
 * Probe (information_schema, the DZ-1 precedent) for the two
 * no-action sources. Runs on the pool, never inside a caller
 * transaction — a failed probe must not abort anything.
 */
export async function probeNoActionSupport(pool: QueryablePool): Promise<NoActionSupport> {
  const res = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_activities') AS has_activities,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'status_history') AS has_status_history`
  );
  const row = res.rows[0] || {};
  return {
    hasActivities: Boolean(row.has_activities),
    hasStatusHistory: Boolean(row.has_status_history),
  };
}

export interface KpiPredicateContext {
  /** Push a param value; returns its $n placeholder. */
  pushParam: (value: unknown) => string;
  /** Qualifier for the leads row: 'leads' (overview) or 'l' (leaf). */
  alias: string;
  /** Probe result — which no-action sources exist. */
  support: NoActionSupport;
  /** Dhaka day bounds, ISO instants (getDhakaBusinessDayBounds). */
  todayStartIso: string;
  tomorrowStartIso: string;
  /** noActionCutoffIso() for the same `now` as the bounds. */
  noActionCutoffIso: string;
}

/**
 * The per-lead SQL predicate for one KPI — the single definition
 * shared by the overview FILTER counts and the leaf WHERE clause.
 * The caller supplies the base conditions (is_deleted, assigned_to)
 * separately; this returns ONLY the KPI's own condition.
 */
export function kpiLeadPredicate(kpi: KpiKey, ctx: KpiPredicateContext): string {
  const a = ctx.alias;
  const notTerminal = (): string => {
    const placeholders = (TERMINAL_LEAD_STATUSES as readonly string[]).map(s => ctx.pushParam(s));
    return `${a}.current_status NOT IN (${placeholders.join(', ')})`;
  };
  switch (kpi) {
    case 'open':
      return notTerminal();
    case 'converted':
      return `${a}.current_status = ${ctx.pushParam('Converted')}`;
    case 'dueToday':
      // Deliberately NO terminal filter — see the module header.
      return `${a}.next_follow_up_at >= ${ctx.pushParam(ctx.todayStartIso)} AND ${a}.next_follow_up_at < ${ctx.pushParam(ctx.tomorrowStartIso)}`;
    case 'overdue':
      return `${notTerminal()} AND ${a}.next_follow_up_at < ${ctx.pushParam(ctx.todayStartIso)}`;
    case 'totalLeads':
      // Any status, terminal included — the caller's base conditions
      // (not deleted, assigned to this person) are the whole filter.
      return 'TRUE';
    case 'todayCollection':
      return `${a}.created_at >= ${ctx.pushParam(ctx.todayStartIso)} AND ${a}.created_at < ${ctx.pushParam(ctx.tomorrowStartIso)}`;
    case 'noAction': {
      const parts = [
        notTerminal(),
        `${a}.created_at < ${ctx.pushParam(ctx.noActionCutoffIso)}`,
      ];
      if (ctx.support.hasActivities) {
        parts.push(`NOT EXISTS (SELECT 1 FROM lead_activities la WHERE la.lead_id = ${a}.id)`);
      }
      if (ctx.support.hasStatusHistory) {
        // CASE (not OR) so jsonb_array_length never runs on a
        // non-array value: Postgres does not guarantee OR
        // short-circuit order, and a stray non-array history value
        // must not 500 the whole overview.
        parts.push(
          `(CASE WHEN jsonb_typeof(COALESCE(${a}.status_history, '[]'::jsonb)) = 'array' ` +
          `THEN jsonb_array_length(COALESCE(${a}.status_history, '[]'::jsonb)) ELSE 0 END) = 0`
        );
      }
      return parts.join(' AND ');
    }
  }
}
