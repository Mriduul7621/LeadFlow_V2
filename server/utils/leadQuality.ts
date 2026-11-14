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
  | 'Not Interested'
  // A renamed terminal status keeps its own name as its band (DZ-6).
  | (string & {});

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
  New: { points: 0, label: 'New' },
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
   VERSIONED CONFIG (Admin Control programme, DZ-3)
   --------------------------------------------------------------------
   Audit §2.6 (F1–F6): every value above used to live only in this
   file. It now ALSO lives in a versioned config row (Metadata
   Engine, type 'LeadQuality') that a super admin edits in the
   Danger Zone. The values below remain the CODE DEFAULTS and the
   fail-closed fallback: whenever no row exists, the row is corrupt,
   or a caller passes nothing, scoring uses exactly these values.

   The effective config is keyed by CURRENT status NAME — the
   config service (LeadQualityConfigService) resolves the stored
   dictionary-entry ids to today's names at read time, so renaming
   a status in Settings → Metadata never detaches its points
   (audit Finding 5). A status with no configured weight scores 0,
   exactly as unknown/custom statuses do today.

   The scale itself (0–100) is NOT configurable: a won terminal
   scores 100 and a lost terminal scores 0, and WHICH statuses are
   terminal (won vs lost) is resolved from the dictionary's
   isTerminal / isWon flags by the config service at read time
   (DZ-6) into cfg.terminalWon / cfg.terminalLost — never from
   hardcoded names, so renaming a status keeps its terminal score.
==================================================================== */

/** One rung of a day-based ladder: applies while days <= maxDays; maxDays null = open-ended last rung. */
export interface LeadQualityLadderRung {
  maxDays: number | null;
  points: number;
}

export interface LeadQualityConfig {
  /** Config version (0 = never saved; increments on every DZ save). */
  version: number;
  /** F1 — neutral starting point every active lead is scored from. */
  baseScore: number;
  /** F2 — active band thresholds. */
  thresholds: { hot: number; warm: number; developing: number };
  /** F3 — buying-intent weight per status, keyed by CURRENT status name. */
  statusPoints: Record<string, number>;
  /** Statuses advanced enough that a missing next action is an attention flag (current names). */
  advancedStatuses: string[];
  /** F4 — recency ladder (Dhaka calendar days since last touch). */
  recency: LeadQualityLadderRung[];
  /** F5 — engagement bonus. */
  engagement: { pointsPerEvent: number; maxEvents: number };
  /** F5 — failed-contact penalty + the attention flag threshold. */
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  /** F6 — follow-up discipline: scheduled bonus + overdue ladder. */
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  /** F6 — explicit investment interest (flat bonus). */
  investment: { points: number };
  /**
   * DZ-6 — terminal statuses, keyed by CURRENT status name and
   * resolved from the dictionary's isTerminal / isWon flags by the
   * config service at read time (never stored in the config row).
   * A won terminal scores 100, a lost terminal scores 0; a status
   * in neither list is scored on the active scale.
   */
  terminalWon: string[];
  /** Terminal statuses that are losses (score 0). See terminalWon. */
  terminalLost: string[];
}

/** Sane bounds for editable point values (validation rejects outside). */
export const LEAD_QUALITY_POINT_MIN = -100;
export const LEAD_QUALITY_POINT_MAX = 100;

/** Code defaults, derived from the constants above (single source). */
export const DEFAULT_LEAD_QUALITY_CONFIG: LeadQualityConfig = {
  version: 0,
  baseScore: LEAD_QUALITY_BASE_SCORE,
  thresholds: {
    hot: LEAD_QUALITY_THRESHOLDS.HOT_MIN,
    warm: LEAD_QUALITY_THRESHOLDS.WARM_MIN,
    developing: LEAD_QUALITY_THRESHOLDS.DEVELOPING_MIN,
  },
  statusPoints: Object.fromEntries(
    Object.entries(LEAD_QUALITY_STATUS_POINTS).map(([name, w]) => [name, w.points])
  ),
  advancedStatuses: [...LEAD_QUALITY_ADVANCED_STATUSES],
  recency: [
    { maxDays: 1, points: 5 },
    { maxDays: 3, points: 3 },
    { maxDays: 7, points: 0 },
    { maxDays: 14, points: -8 },
    { maxDays: 30, points: -15 },
    { maxDays: null, points: -22 },
  ],
  engagement: {
    pointsPerEvent: LEAD_QUALITY_ENGAGEMENT_POINTS_PER_EVENT,
    maxEvents: LEAD_QUALITY_ENGAGEMENT_CAP_EVENTS,
  },
  failedContact: {
    pointsPerEvent: LEAD_QUALITY_FAILED_CONTACT_POINTS_PER_EVENT,
    maxEvents: LEAD_QUALITY_FAILED_CONTACT_CAP_EVENTS,
    attentionAt: 3,
  },
  followUp: {
    scheduledPoints: 5,
    overdue: [
      { maxDays: 3, points: -5 },
      { maxDays: 7, points: -10 },
      { maxDays: null, points: -15 },
    ],
  },
  investment: { points: LEAD_QUALITY_INVESTMENT_POINTS },
  terminalWon: ['Converted'],
  terminalLost: ['Not Interested'],
};

/** Deep copy of a config (callers must never mutate the default). */
export function cloneLeadQualityConfig(config: LeadQualityConfig): LeadQualityConfig {
  return JSON.parse(JSON.stringify(config)) as LeadQualityConfig;
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate one day-ladder. Returns error strings (empty = valid).
 * `pointMin`/`pointMax` bound the rung points; the ladder must have
 * 1–10 rungs, strictly increasing maxDays, and an open-ended last rung.
 */
export function validateLeadQualityLadder(
  value: unknown,
  label: string,
  pointMin: number,
  pointMax: number
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    return [`${label} must be a list of 1 to 10 rungs.`];
  }
  let prevMax: number | null = null;
  value.forEach((rung: any, i: number) => {
    const at = `${label} rung ${i + 1}`;
    if (!rung || typeof rung !== 'object') {
      errors.push(`${at} must be an object with maxDays and points.`);
      return;
    }
    const isLast = i === value.length - 1;
    if (isLast) {
      if (rung.maxDays !== null) errors.push(`${at} must be open-ended (maxDays null) so the ladder covers every day count.`);
    } else {
      if (!isIntIn(rung.maxDays, 0, 3650)) {
        errors.push(`${at} maxDays must be a whole number of days (0–3650).`);
      } else if (prevMax !== null && rung.maxDays <= prevMax) {
        errors.push(`${at} maxDays must be larger than the previous rung's maxDays.`);
      } else {
        prevMax = rung.maxDays;
      }
    }
    if (!isIntIn(rung.points, pointMin, pointMax)) {
      errors.push(`${at} points must be a whole number between ${pointMin} and ${pointMax}.`);
    }
  });
  return errors;
}

/**
 * Shape validation for an EFFECTIVE (name-keyed) config. Returns error
 * strings (empty = valid). The config service reuses this for the
 * stored form after resolving ids to names, and adds the id-existence
 * checks on top. Reads never throw — a config failing here falls back
 * to the code defaults, never takes scoring down.
 */
export function validateLeadQualityConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Lead Quality config must be an object.'];
  }
  const c = value as Record<string, any>;
  if (c.version !== undefined && !isIntIn(c.version, 0, Number.MAX_SAFE_INTEGER)) {
    errors.push('version must be a whole number (0 or more).');
  }
  if (!isIntIn(c.baseScore, 0, 100)) {
    errors.push('baseScore must be a whole number between 0 and 100.');
  }
  const t = c.thresholds;
  if (!t || typeof t !== 'object') {
    errors.push('thresholds must be an object with hot, warm and developing.');
  } else {
    for (const key of ['hot', 'warm', 'developing'] as const) {
      if (!isIntIn(t[key], 0, 100)) errors.push(`thresholds.${key} must be a whole number between 0 and 100.`);
    }
    if (isIntIn(t.hot, 0, 100) && isIntIn(t.warm, 0, 100) && isIntIn(t.developing, 0, 100)) {
      if (!(t.hot > t.warm && t.warm > t.developing)) {
        errors.push('thresholds must be ordered hot > warm > developing.');
      }
    }
  }
  if (!c.statusPoints || typeof c.statusPoints !== 'object' || Array.isArray(c.statusPoints)) {
    errors.push('statusPoints must be an object keyed by status name.');
  } else {
    for (const [name, points] of Object.entries(c.statusPoints)) {
      if (!name || typeof name !== 'string') errors.push('statusPoints keys must be non-empty status names.');
      if (!isIntIn(points, LEAD_QUALITY_POINT_MIN, LEAD_QUALITY_POINT_MAX)) {
        errors.push(`statusPoints for "${name}" must be a whole number between ${LEAD_QUALITY_POINT_MIN} and ${LEAD_QUALITY_POINT_MAX}.`);
      }
    }
  }
  if (!Array.isArray(c.advancedStatuses) || c.advancedStatuses.some((s: any) => typeof s !== 'string' || !s)) {
    errors.push('advancedStatuses must be a list of status names.');
  }
  errors.push(...validateLeadQualityLadder(c.recency, 'recency', LEAD_QUALITY_POINT_MIN, LEAD_QUALITY_POINT_MAX));
  const e = c.engagement;
  if (!e || typeof e !== 'object') {
    errors.push('engagement must be an object with pointsPerEvent and maxEvents.');
  } else {
    if (!isIntIn(e.pointsPerEvent, 0, 20)) errors.push('engagement.pointsPerEvent must be a whole number between 0 and 20.');
    if (!isIntIn(e.maxEvents, 0, 10)) errors.push('engagement.maxEvents must be a whole number between 0 and 10.');
  }
  const f = c.failedContact;
  if (!f || typeof f !== 'object') {
    errors.push('failedContact must be an object with pointsPerEvent, maxEvents and attentionAt.');
  } else {
    if (!isIntIn(f.pointsPerEvent, -20, 0)) errors.push('failedContact.pointsPerEvent must be a whole number between -20 and 0.');
    if (!isIntIn(f.maxEvents, 0, 10)) errors.push('failedContact.maxEvents must be a whole number between 0 and 10.');
    if (!isIntIn(f.attentionAt, 1, 10)) errors.push('failedContact.attentionAt must be a whole number between 1 and 10.');
  }
  const fu = c.followUp;
  if (!fu || typeof fu !== 'object') {
    errors.push('followUp must be an object with scheduledPoints and overdue.');
  } else {
    if (!isIntIn(fu.scheduledPoints, LEAD_QUALITY_POINT_MIN, LEAD_QUALITY_POINT_MAX)) {
      errors.push(`followUp.scheduledPoints must be a whole number between ${LEAD_QUALITY_POINT_MIN} and ${LEAD_QUALITY_POINT_MAX}.`);
    }
    errors.push(...validateLeadQualityLadder(fu.overdue, 'followUp.overdue', LEAD_QUALITY_POINT_MIN, 0));
  }
  const inv = c.investment;
  if (!inv || typeof inv !== 'object') {
    errors.push('investment must be an object with points.');
  } else if (!isIntIn(inv.points, 0, 100)) {
    errors.push('investment.points must be a whole number between 0 and 100.');
  }
  return errors;
}

/**
 * Resolve a caller-supplied config to a usable one. A missing,
 * malformed or out-of-range config returns the code defaults — the
 * scorer can never be taken down by a bad stored value.
 */
export function normalizeLeadQualityConfig(value?: unknown): LeadQualityConfig {
  if (value === undefined || value === null) return cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG);
  if (validateLeadQualityConfig(value).length > 0) {
    return cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG);
  }
  const c = value as LeadQualityConfig;
  return {
    version: typeof c.version === 'number' ? c.version : 0,
    baseScore: c.baseScore,
    thresholds: { ...c.thresholds },
    statusPoints: { ...c.statusPoints },
    advancedStatuses: [...c.advancedStatuses],
    recency: c.recency.map(r => ({ ...r })),
    engagement: { ...c.engagement },
    failedContact: { ...c.failedContact },
    followUp: { scheduledPoints: c.followUp.scheduledPoints, overdue: c.followUp.overdue.map(r => ({ ...r })) },
    investment: { ...c.investment },
    // DZ-6: resolved from the dictionary by the config service;
    // a bare / stored config carries none, so the canonical two apply.
    terminalWon: Array.isArray((c as any).terminalWon) && (c as any).terminalWon.length > 0
      ? [...(c as any).terminalWon]
      : ['Converted'],
    terminalLost: Array.isArray((c as any).terminalLost) && (c as any).terminalLost.length > 0
      ? [...(c as any).terminalLost]
      : ['Not Interested'],
  };
}

/** First rung whose window covers `days` (the last rung is open-ended). */
export function ladderRungForDays(
  rungs: LeadQualityLadderRung[],
  days: number
): LeadQualityLadderRung | undefined {
  for (const rung of rungs) {
    if (rung.maxDays === null || days <= rung.maxDays) return rung;
  }
  return undefined;
}

/** Points of the rung covering `days` (0 when no rung covers it). */
export function ladderPointsForDays(rungs: LeadQualityLadderRung[], days: number): number {
  return ladderRungForDays(rungs, days)?.points ?? 0;
}

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
  if (!text) return 'New';
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

export function bandForScore(score: number, config?: LeadQualityConfig): LeadQualityActiveBand {
  const cfg = normalizeLeadQualityConfig(config);
  if (score >= cfg.thresholds.hot) return 'Hot';
  if (score >= cfg.thresholds.warm) return 'Warm';
  if (score >= cfg.thresholds.developing) return 'Developing';
  return 'Cold';
}

/* ====================================================================
   MAIN SCORER
==================================================================== */

/**
 * Deterministic score + full explanation for one lead.
 * Pure: no I/O, no randomness. Same input → same output.
 *
 * `config` is the effective (name-keyed) DZ-3 config; callers that
 * pass nothing keep today's behaviour byte-identically (the code
 * defaults). A malformed config normalizes to those defaults.
 */
export function calculateLeadQuality(input: LeadQualityInput, config?: LeadQualityConfig): LeadQualityResult {
  const cfg = normalizeLeadQualityConfig(config);
  const nowRaw = input.now !== undefined && input.now !== null ? input.now : new Date();
  const now = nowRaw instanceof Date ? nowRaw : new Date(String(nowRaw));
  const nowSafe = Number.isFinite(now.getTime()) ? now : new Date();
  const bounds = getDhakaBusinessDayBounds(nowSafe);

  const status = canonicalizeQualityStatus(input.status);

  /* ---- Terminal outcomes bypass the active scale ------------------
     DZ-6: which statuses are terminal (and won vs lost) comes from
     the dictionary's isTerminal / isWon flags, resolved into
     cfg.terminalWon / cfg.terminalLost by the config service at
     read time — never from hardcoded names. A renamed 'Converted'
     still scores 100 with its own name as its band. */
  const statusKey = status.toLowerCase();
  const isWonTerminal = (cfg.terminalWon || []).some(s => String(s).toLowerCase() === statusKey);
  const isLostTerminal = (cfg.terminalLost || []).some(s => String(s).toLowerCase() === statusKey);
  if (isWonTerminal) {
    return {
      score: LEAD_QUALITY_MAX_SCORE,
      band: status as LeadQualityBand,
      isTerminal: true,
      positiveFactors: [
        {
          label: `${status} — successful outcome (terminal)`,
          points: LEAD_QUALITY_MAX_SCORE - cfg.baseScore,
        },
      ],
      negativeFactors: [],
      attentionReasons: [],
    };
  }
  if (isLostTerminal) {
    return {
      score: LEAD_QUALITY_MIN_SCORE,
      band: status as LeadQualityBand,
      isTerminal: true,
      positiveFactors: [],
      negativeFactors: [
        {
          label: `${status} — closed (terminal)`,
          points: LEAD_QUALITY_MIN_SCORE - cfg.baseScore,
        },
      ],
      attentionReasons: [],
    };
  }

  const positiveFactors: LeadQualityFactor[] = [];
  const negativeFactors: LeadQualityFactor[] = [];
  const attentionReasons: string[] = [];
  let total = cfg.baseScore;

  const push = (label: string, points: number) => {
    if (!Number.isFinite(points) || points === 0) return;
    total += points;
    (points > 0 ? positiveFactors : negativeFactors).push({ label, points });
  };

  /* ---- 1. Status / buying intent (strongest active signal) -------- */
  const statusPoints = cfg.statusPoints[status];
  if (typeof statusPoints === 'number' && statusPoints !== 0) {
    push(LEAD_QUALITY_STATUS_POINTS[status]?.label ?? status, statusPoints);
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
    const recencyRung = ladderRungForDays(cfg.recency, daysSince);
    const recencyPoints = recencyRung?.points ?? 0;
    if (recencyPoints !== 0) {
      if (recencyPoints > 0) {
        push(
          daysSince <= 1 ? 'Touched within the last day' : `Touched ${daysSince} days ago`,
          recencyPoints
        );
      } else {
        push(
          `No progress in ${daysSince} days${recencyRung?.maxDays === null ? ' (stale)' : ''}`,
          recencyPoints
        );
      }
    }
    // Staleness flag: no meaningful progress in over two weeks. The
    // day line is a fixed rule (not one of the configurable F-values);
    // the ladder decides the points, this decides the flag.
    if (daysSince > 14) {
      attentionReasons.push(
        `No meaningful progress in ${daysSince} days${daysSince > 30 ? ' — going stale' : ''}`
      );
    }
  }

  /* ---- 3. Engagement (actual history, capped — never raw volume) -- */
  const meaningfulRaw = Math.max(0, Math.floor(Number(input.meaningfulEngagementCount) || 0));
  if (meaningfulRaw > 0) {
    const counted = Math.min(meaningfulRaw, cfg.engagement.maxEvents);
    const points = counted * cfg.engagement.pointsPerEvent;
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
  const advancedStatuses = new Set(cfg.advancedStatuses);
  if (nextActionCandidates.length === 0) {
    if (advancedStatuses.has(status)) {
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
      const penalty = ladderPointsForDays(cfg.followUp.overdue, daysOverdue);
      push(
        `Next action overdue by ${daysOverdue} ${plural(daysOverdue, 'day', 'days')}`,
        penalty
      );
      attentionReasons.push(
        `Next action overdue by ${daysOverdue} ${plural(daysOverdue, 'day', 'days')}`
      );
    } else {
      push('Next action scheduled', cfg.followUp.scheduledPoints);
    }
  }

  /* ---- 5. Explicit investment interest (flat capped bonus) --------- */
  if (input.hasInvestmentAmount === true) {
    const amount = Number(input.investmentAmount);
    const amountNote =
      Number.isFinite(amount) && amount > 0
        ? ` (৳${amount.toLocaleString('en-US')})`
        : '';
    push(`Customer shared an investment interest${amountNote}`, cfg.investment.points);
  }

  /* ---- 6. Failed contact history (capped penalty) ------------------ */
  const failedRaw = Math.max(0, Math.floor(Number(input.failedContactCount) || 0));
  if (failedRaw > 0) {
    const counted = Math.min(failedRaw, cfg.failedContact.maxEvents);
    const points = counted * cfg.failedContact.pointsPerEvent;
    const cappedNote = failedRaw > counted ? ' (capped)' : '';
    push(
      failedRaw === 1
        ? 'Unanswered contact attempt (1)'
        : `${failedRaw} unanswered contact ${plural(failedRaw, 'attempt', 'attempts')}${cappedNote}`,
      points
    );
    if (failedRaw >= cfg.failedContact.attentionAt) {
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
    band: bandForScore(score, cfg),
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
export function reconcileQualityFactors(
  result: LeadQualityResult,
  config?: LeadQualityConfig
): {
  base: number;
  factorTotal: number;
  expected: number;
  matches: boolean;
} {
  const cfg = normalizeLeadQualityConfig(config);
  const factorTotal =
    result.positiveFactors.reduce((a, f) => a + f.points, 0) +
    result.negativeFactors.reduce((a, f) => a + f.points, 0);
  const expected = Math.min(
    LEAD_QUALITY_MAX_SCORE,
    Math.max(LEAD_QUALITY_MIN_SCORE, cfg.baseScore + factorTotal)
  );
  return {
    base: cfg.baseScore,
    factorTotal,
    expected,
    matches: expected === result.score,
  };
}
