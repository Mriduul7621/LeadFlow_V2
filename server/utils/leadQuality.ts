/**
 * leadQuality.ts — server-authoritative, rule-based, explainable Lead Quality scoring.
 * ------------------------------------------------------------------
 * Every active (non-terminal) lead receives a deterministic 0–100 score
 * answering: which leads deserve attention first, why, and what action
 * would improve quality.
 *
 * This is NOT an AI/ML model. It is a transparent weighted sum over
 * operational sales signals already present in LeadFlow:
 *
 *   score = clamp(0, 100, BASE + status + recency + engagement
 *                            + followUpDiscipline + investment
 *                            - failedContact)
 *
 * Every non-zero component emits a human-readable factor so the score is
 * fully auditable: score === clamp(BASE + Σ factor.points) always holds
 * (terminal outcomes reconcile through a single terminal factor).
 *
 * Design rules:
 *  - deterministic: same input → same score (no randomness, no clock
 *    reads inside; callers inject `now`, defaulting to the server clock)
 *  - Dhaka-safe: day math uses Asia/Dhaka calendar days, consistent with
 *    server/utils/businessTime.ts (the follow-up queue buckets)
 *  - no demographic signals: gender, age, occupation, income proxies etc.
 *    are NEVER inputs. Only an explicitly supplied investment amount
 *    counts, capped at a small bonus
 *  - anti-gaming: engagement bonuses and failed-contact penalties are
 *    hard-capped; raw activity volume alone can never produce Hot
 *  - terminal outcomes (Converted / Not Interested) are NOT scored on the
 *    active scale; they receive fixed scores with terminal bands
 *
 * This module is pure (no DB, no imports from route handlers). The SQL
 * aggregation of per-lead signals lives in leadQualitySignals.ts; the
 * frontend NEVER reimplements this formula — it only renders the
 * server-computed score/band/factors.
 */

import {
  getDhakaBusinessDayBounds,
  classifyFollowUpBucket,
  dhakaYmd,
} from './businessTime.js';
import {
  DEFAULT_STATUS_DICTIONARY,
  resolveImportStatus,
} from '../routes/leadImport.js';

/* ====================================================================
   CENTRALIZED CONSTANTS — thresholds, weights, caps
==================================================================== */

/** Neutral starting point every active lead is scored from. */
export const LEAD_QUALITY_BASE_SCORE = 35;

export const LEAD_QUALITY_MIN_SCORE = 0;
export const LEAD_QUALITY_MAX_SCORE = 100;

/** Active band thresholds (terminal bands bypass the score scale). */
export const LEAD_QUALITY_THRESHOLDS = {
  HOT_MIN: 80,
  WARM_MIN: 60,
  DEVELOPING_MIN: 40,
} as const;

export type LeadQualityBand =
  | 'Hot'
  | 'Warm'
  | 'Developing'
  | 'Cold'
  | 'Converted'
  | 'Not Interested';

export type LeadQualityActiveBand = 'Hot' | 'Warm' | 'Developing' | 'Cold';

/**
 * Status → buying-intent weight. The current status is the strongest
 * single signal; meeting/pipeline progression is expressed THROUGH these
 * weights (not double-counted from history).
 */
export const LEAD_QUALITY_STATUS_POINTS: Record<string, { points: number; label: string }> = {
  'Pipeline Locked': { points: 35, label: 'Pipeline locked' },
  'Meeting Completed': { points: 25, label: 'Meeting completed' },
  'Meeting Fixed': { points: 20, label: 'Meeting fixed' },
  Interested: { points: 15, label: 'Customer interested' },
  'Follow-up Set': { points: 10, label: 'Follow-up set' },
  Contacted: { points: 5, label: 'Contacted' },
  Untouched: { points: 0, label: 'Untouched' },
  Busy: { points: -2, label: 'Customer busy' },
  'No Response': { points: -8, label: 'No response' },
};

/** Statuses advanced enough that a missing next action is an attention flag. */
export const LEAD_QUALITY_ADVANCED_STATUSES = new Set([
  'Interested',
  'Follow-up Set',
  'Meeting Fixed',
  'Meeting Completed',
  'Pipeline Locked',
]);

/** Anti-gaming caps (number of history events that may contribute). */
export const LEAD_QUALITY_ENGAGEMENT_CAP_EVENTS = 3;
export const LEAD_QUALITY_ENGAGEMENT_POINTS_PER_EVENT = 3;
export const LEAD_QUALITY_FAILED_CONTACT_CAP_EVENTS = 3;
export const LEAD_QUALITY_FAILED_CONTACT_POINTS_PER_EVENT = -3;

/** Explicit investment interest: small flat capped bonus, never a penalty. */
export const LEAD_QUALITY_INVESTMENT_POINTS = 3;

/* ====================================================================
   TYPES
==================================================================== */

export interface LeadQualityFactor {
  label: string;
  points: number;
}

export interface LeadQualityInput {
  /** Raw status text (canonical, alias, or custom — normalized inside). */
  status: unknown;
  /** Last successful/attempted contact stamp (leads.last_contacted_at). */
  lastContactedAt?: Date | string | null;
  /** Newest immutable history event (lead_activities.created_at). */
  lastActivityAt?: Date | string | null;
  /** Lead creation (authoritative created_at, incl. historical imports). */
  createdAt?: Date | string | null;
  /** Canonical next follow-up (leads.next_follow_up_at). */
  nextFollowUpAt?: Date | string | null;
  /** Earliest still-pending planned activity (scheduled_activities). */
  nextScheduledAt?: Date | string | null;
  /** True when the customer explicitly supplied an investment amount. */
  hasInvestmentAmount?: boolean;
  /** The explicit amount, when known (display only — bonus is flat). */
  investmentAmount?: number | null;
  /** Unanswered attempts in actual history (No Response / Unreachable). */
  failedContactCount?: number;
  /** Meaningful customer responses in actual history (capped). */
  meaningfulEngagementCount?: number;
  /** Reference instant (server clock by default; injectable for tests). */
  now?: Date | string;
}

export interface LeadQualityResult {
  score: number;
  band: LeadQualityBand;
  isTerminal: boolean;
  positiveFactors: LeadQualityFactor[];
  negativeFactors: LeadQualityFactor[];
  attentionReasons: string[];
}

/* ====================================================================
   HELPERS
==================================================================== */

/**
 * Canonical status for scoring. Reuses the SAME alias resolution as bulk
 * import (`Unreachable` → `No Response`, `Follow up` → `Follow-up Set`),
 * so historical wording never loses its meaning. Unknown/custom statuses
 * stay neutral (0 points, no factor) instead of failing.
 */
export function canonicalizeQualityStatus(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return 'Untouched';
  const resolved = resolveImportStatus(text, DEFAULT_STATUS_DICTIONARY);
  if (resolved.ok && resolved.status) return resolved.status;
  return text;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Whole Asia/Dhaka calendar days between two instants (dateB − dateA). */
function dhakaCalendarDaysBetween(dateA: Date, dateB: Date): number {
  const a = dhakaYmd(dateA);
  const b = dhakaYmd(dateB);
  const aDay = Date.UTC(a.y, a.m - 1, a.d);
  const bDay = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((bDay - aDay) / 86400000);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function bandForScore(score: number): LeadQualityActiveBand {
  if (score >= LEAD_QUALITY_THRESHOLDS.HOT_MIN) return 'Hot';
  if (score >= LEAD_QUALITY_THRESHOLDS.WARM_MIN) return 'Warm';
  if (score >= LEAD_QUALITY_THRESHOLDS.DEVELOPING_MIN) return 'Developing';
  return 'Cold';
}

/* ====================================================================
   MAIN SCORER
==================================================================== */

/**
 * Deterministic score + full explanation for one lead.
 * Pure: no I/O, no randomness. Same input → same output.
 */
export function calculateLeadQuality(input: LeadQualityInput): LeadQualityResult {
  const nowRaw = input.now !== undefined && input.now !== null ? input.now : new Date();
  const now = nowRaw instanceof Date ? nowRaw : new Date(String(nowRaw));
  const nowSafe = Number.isFinite(now.getTime()) ? now : new Date();
  const bounds = getDhakaBusinessDayBounds(nowSafe);

  const status = canonicalizeQualityStatus(input.status);

  /* ---- Terminal outcomes bypass the active scale ------------------ */
  if (status === 'Converted') {
    return {
      score: LEAD_QUALITY_MAX_SCORE,
      band: 'Converted',
      isTerminal: true,
      positiveFactors: [
        {
          label: 'Converted — successful outcome (terminal)',
          points: LEAD_QUALITY_MAX_SCORE - LEAD_QUALITY_BASE_SCORE,
        },
      ],
      negativeFactors: [],
      attentionReasons: [],
    };
  }
  if (status === 'Not Interested') {
    return {
      score: LEAD_QUALITY_MIN_SCORE,
      band: 'Not Interested',
      isTerminal: true,
      positiveFactors: [],
      negativeFactors: [
        {
          label: 'Not Interested — closed (terminal)',
          points: LEAD_QUALITY_MIN_SCORE - LEAD_QUALITY_BASE_SCORE,
        },
      ],
      attentionReasons: [],
    };
  }

  const positiveFactors: LeadQualityFactor[] = [];
  const negativeFactors: LeadQualityFactor[] = [];
  const attentionReasons: string[] = [];
  let total = LEAD_QUALITY_BASE_SCORE;

  const push = (label: string, points: number) => {
    if (!Number.isFinite(points) || points === 0) return;
    total += points;
    (points > 0 ? positiveFactors : negativeFactors).push({ label, points });
  };

  /* ---- 1. Status / buying intent (strongest active signal) -------- */
  const statusWeight = LEAD_QUALITY_STATUS_POINTS[status];
  if (statusWeight && statusWeight.points !== 0) {
    push(statusWeight.label, statusWeight.points);
  }

  /* ---- 2. Recency / freshness ------------------------------------- */
  const touchCandidates = [
    toDate(input.lastContactedAt),
    toDate(input.lastActivityAt),
    toDate(input.createdAt),
  ].filter((d): d is Date => d !== null);
  if (touchCandidates.length > 0) {
    const lastTouch = new Date(Math.max(...touchCandidates.map(d => d.getTime())));
    const daysSince = Math.max(0, dhakaCalendarDaysBetween(lastTouch, nowSafe));
    if (daysSince <= 1) {
      push('Touched within the last day', 5);
    } else if (daysSince <= 3) {
      push(`Touched ${daysSince} days ago`, 3);
    } else if (daysSince <= 7) {
      // Neutral week — no factor.
    } else if (daysSince <= 14) {
      push(`No progress in ${daysSince} days`, -8);
    } else if (daysSince <= 30) {
      push(`No progress in ${daysSince} days`, -15);
      attentionReasons.push(`No meaningful progress in ${daysSince} days`);
    } else {
      push(`No progress in ${daysSince} days (stale)`, -22);
      attentionReasons.push(`No meaningful progress in ${daysSince} days — going stale`);
    }
  }

  /* ---- 3. Engagement (actual history, capped — never raw volume) -- */
  const meaningfulRaw = Math.max(0, Math.floor(Number(input.meaningfulEngagementCount) || 0));
  if (meaningfulRaw > 0) {
    const counted = Math.min(meaningfulRaw, LEAD_QUALITY_ENGAGEMENT_CAP_EVENTS);
    const points = counted * LEAD_QUALITY_ENGAGEMENT_POINTS_PER_EVENT;
    const cappedNote = meaningfulRaw > counted ? ' (capped)' : '';
    push(
      meaningfulRaw === 1
        ? 'Customer showed buying interest (1 interaction)'
        : `Customer showed buying interest across ${meaningfulRaw} ${plural(meaningfulRaw, 'interaction', 'interactions')}${cappedNote}`,
      points
    );
  }

  /* ---- 4. Follow-up discipline (planned next action) --------------- */
  const nextActionCandidates = [toDate(input.nextFollowUpAt), toDate(input.nextScheduledAt)].filter(
    (d): d is Date => d !== null
  );
  if (nextActionCandidates.length === 0) {
    if (LEAD_QUALITY_ADVANCED_STATUSES.has(status)) {
      attentionReasons.push(`No next action scheduled for ${status} lead`);
    }
  } else {
    const nextAction = new Date(Math.min(...nextActionCandidates.map(d => d.getTime())));
    const bucket = classifyFollowUpBucket(nextAction, bounds);
    if (bucket === 'overdue') {
      // Calendar-day overdue: always ≥ 1 here and matches the bucket the
      // follow-up queue displays (never 0 for an overdue item).
      const daysOverdue = Math.max(
        1,
        dhakaCalendarDaysBetween(nextAction, nowSafe)
      );
      const penalty = daysOverdue <= 3 ? -5 : daysOverdue <= 7 ? -10 : -15;
      push(
        `Next action overdue by ${daysOverdue} ${plural(daysOverdue, 'day', 'days')}`,
        penalty
      );
      attentionReasons.push(
        `Next action overdue by ${daysOverdue} ${plural(daysOverdue, 'day', 'days')}`
      );
    } else {
      push('Next action scheduled', 5);
    }
  }

  /* ---- 5. Explicit investment interest (flat capped bonus) --------- */
  if (input.hasInvestmentAmount === true) {
    const amount = Number(input.investmentAmount);
    const amountNote =
      Number.isFinite(amount) && amount > 0
        ? ` (৳${amount.toLocaleString('en-US')})`
        : '';
    push(`Customer shared an investment interest${amountNote}`, LEAD_QUALITY_INVESTMENT_POINTS);
  }

  /* ---- 6. Failed contact history (capped penalty) ------------------ */
  const failedRaw = Math.max(0, Math.floor(Number(input.failedContactCount) || 0));
  if (failedRaw > 0) {
    const counted = Math.min(failedRaw, LEAD_QUALITY_FAILED_CONTACT_CAP_EVENTS);
    const points = counted * LEAD_QUALITY_FAILED_CONTACT_POINTS_PER_EVENT;
    const cappedNote = failedRaw > counted ? ' (capped)' : '';
    push(
      failedRaw === 1
        ? 'Unanswered contact attempt (1)'
        : `${failedRaw} unanswered contact ${plural(failedRaw, 'attempt', 'attempts')}${cappedNote}`,
      points
    );
    if (failedRaw >= 3) {
      attentionReasons.push(`Repeated unanswered contact (${failedRaw} attempts)`);
    }
  }

  /* ---- Clamp + band ------------------------------------------------ */
  const score = Math.min(
    LEAD_QUALITY_MAX_SCORE,
    Math.max(LEAD_QUALITY_MIN_SCORE, total)
  );

  positiveFactors.sort((a, b) => b.points - a.points);
  negativeFactors.sort((a, b) => a.points - b.points);

  return {
    score,
    band: bandForScore(score),
    isTerminal: false,
    positiveFactors,
    negativeFactors,
    attentionReasons,
  };
}

/** Compact list shape (badge rendering / sorting / filtering). */
export function toCompactQuality(result: LeadQualityResult): {
  score: number;
  band: LeadQualityBand;
} {
  return { score: result.score, band: result.band };
}

/**
 * Reconciliation check: the factors must always explain the score
 * (used by tests and safe to use in diagnostics).
 */
export function reconcileQualityFactors(result: LeadQualityResult): {
  base: number;
  factorTotal: number;
  expected: number;
  matches: boolean;
} {
  const factorTotal =
    result.positiveFactors.reduce((a, f) => a + f.points, 0) +
    result.negativeFactors.reduce((a, f) => a + f.points, 0);
  const expected = Math.min(
    LEAD_QUALITY_MAX_SCORE,
    Math.max(LEAD_QUALITY_MIN_SCORE, LEAD_QUALITY_BASE_SCORE + factorTotal)
  );
  return {
    base: LEAD_QUALITY_BASE_SCORE,
    factorTotal,
    expected,
    matches: expected === result.score,
  };
}
