/**
 * LeadQualityConfigService — versioned Lead Quality config (Admin Control
 * programme, DZ-3; audit §2.6 F1–F6, §4).
 * ------------------------------------------------------------------
 * Every Lead Quality weight used to live only in code
 * (`server/utils/leadQuality.ts`). It now lives in ONE versioned
 * config row a super admin edits in the Danger Zone, while the code
 * values remain the default and the fail-closed fallback:
 *
 *   Metadata Engine options, group 'LeadQuality', one row:
 *   ('LeadQuality', 'config') carries the whole config as meta JSON.
 *
 * STORED form (what the meta holds) — status points are keyed to the
 * FollowUpStatus DICTIONARY ENTRY (the option row's id), never to the
 * status name:
 *
 *   { version, baseScore, thresholds: {hot, warm, developing},
 *     statusPointsById: { <optionId>: points },
 *     advancedStatusIds: [ <optionId>, ... ],
 *     recency: [ {maxDays, points}, ... ],
 *     engagement: { pointsPerEvent, maxEvents },
 *     failedContact: { pointsPerEvent, maxEvents, attentionAt },
 *     followUp: { scheduledPoints, overdue: [ {maxDays, points}, ... ] },
 *     investment: { points } }
 *
 * EFFECTIVE form (what the scorer takes) — the stored ids are
 * resolved to the dictionary's CURRENT names at read time, so
 * renaming a status in Settings → Metadata never detaches its
 * points (audit Finding 5; the rename rewrite keeps the option
 * row, migration 044 pattern). A stored id whose entry no longer
 * exists is dropped; a dictionary entry with no configured weight
 * scores 0 — today's behaviour for unknown/custom statuses.
 *
 * Reads fail closed to the code defaults whenever the row is
 * missing, malformed or out of range, so a bad stored value can
 * never take scoring down. Writes are validated server-side (400
 * on anything out of range) and audit-logged with old→new values
 * (action `danger_zone.lead_quality.update`, Q7).
 *
 * Terminal statuses take NO points: they bypass the active scale
 * with fixed scores (won = 100, lost = 0), and WHICH statuses are
 * terminal is resolved from the dictionary's isTerminal / isWon
 * flags at read time (DZ-6 — see resolveStoredConfig). A PUT that
 * assigns points (or the advanced flag) to one is refused.
 *
 * Storage mirrors NotificationSettingsService / OperationsSettingsService
 * exactly (lazy seeding on first write, fallback-store path for demo
 * mode). No migration: the options table already carries `meta`.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb, logAccessChange } from '../routes/production/shared.js';
import {
  isLostDictionaryEntry,
  isTerminalDictionaryEntry,
  isWonDictionaryEntry,
} from './StageRulesService.js';
import {
  DEFAULT_LEAD_QUALITY_CONFIG,
  LEAD_QUALITY_POINT_MIN,
  LEAD_QUALITY_POINT_MAX,
  cloneLeadQualityConfig,
  normalizeLeadQualityConfig,
  validateLeadQualityConfig,
  validateLeadQualityLadder,
  type LeadQualityConfig,
  type LeadQualityLadderRung,
} from '../utils/leadQuality.js';

export const LEAD_QUALITY_OPTION_TYPE = 'LeadQuality';
export const LEAD_QUALITY_CONFIG_OPTION_VALUE = 'config';
export const LEAD_QUALITY_CONFIG_OPTION_LABEL = 'Lead Quality Config';
export const LEAD_QUALITY_AUDIT_ACTION = 'danger_zone.lead_quality.update';

/** Thrown by setLeadQualityConfig when the PUT body is invalid (route maps it to a 400). */
export class LeadQualityConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadQualityConfigValidationError';
  }
}

/** Fixed scale — shown for display, never editable (DZ-6 owns terminal handling). */
export const LEAD_QUALITY_SCALE = { min: 0, max: 100 } as const;

/* ====================================================================
   SHAPES
==================================================================== */

/** The stored form: status weights keyed by dictionary-entry id. */
export interface LeadQualityStoredConfig {
  version: number;
  baseScore: number;
  thresholds: { hot: number; warm: number; developing: number };
  statusPointsById: Record<string, number>;
  advancedStatusIds: string[];
  recency: LeadQualityLadderRung[];
  engagement: { pointsPerEvent: number; maxEvents: number };
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  investment: { points: number };
}

/** What a PUT accepts: the full config, status weights keyed by dictionary-entry id. */
export interface LeadQualityConfigInput {
  baseScore: number;
  thresholds: { hot: number; warm: number; developing: number };
  statusPoints: Record<string, number>;
  advancedStatusIds: string[];
  recency: LeadQualityLadderRung[];
  engagement: { pointsPerEvent: number; maxEvents: number };
  failedContact: { pointsPerEvent: number; maxEvents: number; attentionAt: number };
  followUp: { scheduledPoints: number; overdue: LeadQualityLadderRung[] };
  investment: { points: number };
}

export interface LeadQualityStatusOption {
  id: string;
  value: string;
  label: string;
  isActive: boolean;
  isTerminal: boolean;
  /** Effective points (resolved from the stored config, else the code default for the name, else 0). */
  points: number;
  /** The code default for this status name (0 when the code knows no weight for it). */
  defaultPoints: number;
  /** Effective advanced flag (missing next action is an attention flag). */
  advanced: boolean;
  /** The code default for the advanced flag. */
  defaultAdvanced: boolean;
}

export interface LeadQualityLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: LeadQualityConfig | null;
  newValue: LeadQualityConfig;
}

export interface LeadQualityConfigForEdit {
  version: number;
  config: LeadQualityConfig;
  defaults: LeadQualityConfig;
  statusOptions: LeadQualityStatusOption[];
  lastChange: LeadQualityLastChange | null;
}

/** One FollowUpStatus dictionary entry as the config service sees it. */
export interface FollowUpStatusEntry {
  id: string;
  value: string;
  label: string;
  isActive: boolean;
  isTerminal: boolean;
  /** Dictionary isWon flag (DZ-6: won terminals score 100). */
  isWon: boolean;
  /** Dictionary isLost flag (DZ-6: lost terminals score 0). */
  isLost: boolean;
}

/**
 * Terminal, won and lost for ONE dictionary entry (DZ-6): the
 * dictionary flag decides; an explicit false is honoured; only a
 * missing flag falls back to the canonical names. The entry's
 * isTerminal / isWon / isLost booleans are already resolved this
 * way by dictionaryFromRows below, so these helpers just read them
 * — they exist so the resolution rule has one home (see
 * StageRulesService) and this file never re-implements it.
 */
function isTerminalEntry(entry: FollowUpStatusEntry): boolean {
  return entry.isTerminal === true;
}

/* ====================================================================
   STORED ⇄ EFFECTIVE
==================================================================== */

/** The code defaults in stored form (empty id maps — defaults are name-keyed by construction). */
export function defaultStoredConfig(): LeadQualityStoredConfig {
  const d = DEFAULT_LEAD_QUALITY_CONFIG;
  return {
    version: 0,
    baseScore: d.baseScore,
    thresholds: { ...d.thresholds },
    statusPointsById: {},
    advancedStatusIds: [],
    recency: d.recency.map(r => ({ ...r })),
    engagement: { ...d.engagement },
    failedContact: { ...d.failedContact },
    followUp: { scheduledPoints: d.followUp.scheduledPoints, overdue: d.followUp.overdue.map(r => ({ ...r })) },
    investment: { ...d.investment },
  };
}

/**
 * Resolve a stored config to the effective (name-keyed) form against
 * the CURRENT dictionary. Unknown ids are dropped; when the stored
 * config carries no id maps at all (never saved), the code defaults
 * are used as-is.
 */
export function resolveStoredConfig(
  stored: LeadQualityStoredConfig | null,
  dictionary: FollowUpStatusEntry[]
): LeadQualityConfig {
  // DZ-6: the terminal sets are resolved from the dictionary's
  // isTerminal / isWon flags at read time (same read that carries
  // the status points) — a renamed terminal status keeps its score.
  // An empty dictionary means "unreadable", so the code defaults
  // (canonical names) apply; a dictionary that exists but flags
  // nothing terminal is honoured as-is (zero terminal names).
  const terminal = dictionary.length === 0
    ? { won: ['Converted'], lost: ['Not Interested'] }
    : {
        won: dictionary.filter(e => e.isTerminal && e.isWon).map(e => e.value),
        lost: dictionary.filter(e => e.isTerminal && !e.isWon).map(e => e.value),
      };
  if (!stored) {
    const defaults = cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG);
    defaults.terminalWon = terminal.won;
    defaults.terminalLost = terminal.lost;
    return defaults;
  }
  const byId = new Map(dictionary.map(e => [e.id, e]));
  // A stored row exists, so the effective weights come ONLY from it:
  // a dictionary entry with no stored weight scores 0 (today's
  // behaviour for unknown/custom statuses), even when the code knows
  // a default weight for that name. Code defaults apply only while
  // nothing was ever saved.
  const effective = normalizeLeadQualityConfig({
    version: stored.version,
    baseScore: stored.baseScore,
    thresholds: stored.thresholds,
    statusPoints: {},
    advancedStatuses: [],
    recency: stored.recency,
    engagement: stored.engagement,
    failedContact: stored.failedContact,
    followUp: stored.followUp,
    investment: stored.investment,
  });
  // Id-keyed weights resolve to today's names; unknown ids are dropped.
  for (const [id, points] of Object.entries(stored.statusPointsById || {})) {
    const entry = byId.get(id);
    if (!entry || isTerminalEntry(entry)) continue;
    effective.statusPoints[entry.value] = points;
  }
  for (const id of stored.advancedStatusIds || []) {
    const entry = byId.get(id);
    if (!entry || isTerminalEntry(entry)) continue;
    if (!effective.advancedStatuses.includes(entry.value)) {
      effective.advancedStatuses.push(entry.value);
    }
  }
  effective.terminalWon = terminal.won;
  effective.terminalLost = terminal.lost;
  return effective;
}

/**
 * Validate a STORED config's shape (id maps are checked for shape
 * only here; existence against the dictionary happens in
 * validateLeadQualityConfigInput). Returns error strings.
 */
export function validateStoredLeadQualityConfig(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Lead Quality config must be an object.'];
  }
  const s = value as Record<string, any>;
  const errors: string[] = [];
  if (s.version !== undefined && (!Number.isInteger(s.version) || s.version < 0)) {
    errors.push('version must be a whole number (0 or more).');
  }
  // Reuse the effective-shape validator for everything except the
  // id-keyed maps, by substituting empty name-keyed maps.
  errors.push(
    ...validateLeadQualityConfig({
      version: s.version ?? 0,
      baseScore: s.baseScore,
      thresholds: s.thresholds,
      statusPoints: {},
      advancedStatuses: [],
      recency: s.recency,
      engagement: s.engagement,
      failedContact: s.failedContact,
      followUp: s.followUp,
      investment: s.investment,
    })
  );
  if (!s.statusPointsById || typeof s.statusPointsById !== 'object' || Array.isArray(s.statusPointsById)) {
    errors.push('statusPointsById must be an object keyed by dictionary-entry id.');
  } else {
    for (const [id, points] of Object.entries(s.statusPointsById)) {
      if (!id || typeof id !== 'string') errors.push('statusPointsById keys must be non-empty dictionary-entry ids.');
      if (!Number.isInteger(points) || (points as number) < LEAD_QUALITY_POINT_MIN || (points as number) > LEAD_QUALITY_POINT_MAX) {
        errors.push(`statusPointsById for "${id}" must be a whole number between ${LEAD_QUALITY_POINT_MIN} and ${LEAD_QUALITY_POINT_MAX}.`);
      }
    }
  }
  if (!Array.isArray(s.advancedStatusIds) || s.advancedStatusIds.some((id: any) => typeof id !== 'string' || !id)) {
    errors.push('advancedStatusIds must be a list of dictionary-entry ids.');
  }
  return errors;
}

/**
 * Parse a stored meta value. Anything unparseable or out of range
 * returns null — the caller falls back to the code defaults, never
 * to a half-valid config.
 */
export function parseStoredLeadQualityConfig(meta: unknown): LeadQualityStoredConfig | null {
  if (!meta || typeof meta !== 'object') return null;
  const candidate = meta as Record<string, any>;
  // The row may hold the meta envelope { version, ... } directly.
  const errors = validateStoredLeadQualityConfig(candidate);
  if (errors.length > 0) return null;
  return {
    version: typeof candidate.version === 'number' ? candidate.version : 0,
    baseScore: candidate.baseScore,
    thresholds: { ...candidate.thresholds },
    statusPointsById: { ...(candidate.statusPointsById || {}) },
    advancedStatusIds: [...(candidate.advancedStatusIds || [])],
    recency: candidate.recency.map((r: any) => ({ ...r })),
    engagement: { ...candidate.engagement },
    failedContact: { ...candidate.failedContact },
    followUp: {
      scheduledPoints: candidate.followUp.scheduledPoints,
      overdue: candidate.followUp.overdue.map((r: any) => ({ ...r })),
    },
    investment: { ...candidate.investment },
  };
}

/* ====================================================================
   READS
==================================================================== */

interface DictionaryAndStored {
  dictionary: FollowUpStatusEntry[];
  stored: LeadQualityStoredConfig | null;
}

function dictionaryFromRows(rows: any[]): FollowUpStatusEntry[] {
  return (rows || []).map((r: any) => {
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const value = String(r.option_value ?? r.value ?? '');
    return {
      id: String(r.id),
      value,
      label: String(r.option_label ?? r.label ?? r.option_value ?? r.value ?? ''),
      isActive: r.is_active !== false && r.status !== 'Inactive',
      // DZ-6 tri-state: an explicit flag (true OR false) is honoured;
      // only a missing key falls back to the canonical names.
      isTerminal: isTerminalDictionaryEntry({ value, meta }),
      isWon: isWonDictionaryEntry({ value, meta }),
      isLost: isLostDictionaryEntry({ value, meta }),
    };
  });
}

async function readDictionaryAndStoredDb(): Promise<DictionaryAndStored> {
  const pool = getPool();
  let dictionary: FollowUpStatusEntry[] = [];
  let stored: LeadQualityStoredConfig | null = null;
  try {
    const dictRes = await pool.query(
      `SELECT id, option_value, option_label, is_active, meta
         FROM options WHERE field_key = 'FollowUpStatus' ORDER BY sort_order ASC, option_value ASC`
    );
    dictionary = dictionaryFromRows(dictRes.rows);
  } catch (error: any) {
    console.warn('[lead-quality-config] status dictionary unavailable, scoring with code defaults:', error?.message || error);
  }
  try {
    const cfgRes = await pool.query(
      `SELECT meta FROM options WHERE field_key = $1 AND option_value = $2 LIMIT 1`,
      [LEAD_QUALITY_OPTION_TYPE, LEAD_QUALITY_CONFIG_OPTION_VALUE]
    );
    const meta = cfgRes.rows[0]?.meta;
    stored = parseStoredLeadQualityConfig(meta);
    if (meta != null && stored === null) {
      console.warn('[lead-quality-config] stored config is malformed or out of range — falling back to code defaults.');
    }
  } catch (error: any) {
    console.warn('[lead-quality-config] stored config unavailable, scoring with code defaults:', error?.message || error);
  }
  return { dictionary, stored };
}

function readDictionaryAndStoredFallback(): DictionaryAndStored {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  const dictionary = dictionaryFromRows(
    rows.filter((o: any) => o.type === 'FollowUpStatus')
  );
  const cfgRow = rows.find(
    (o: any) => o.type === LEAD_QUALITY_OPTION_TYPE && o.value === LEAD_QUALITY_CONFIG_OPTION_VALUE
  );
  return { dictionary, stored: parseStoredLeadQualityConfig(cfgRow?.meta) };
}

async function readDictionaryAndStored(): Promise<DictionaryAndStored> {
  if (!useDb()) return readDictionaryAndStoredFallback();
  return readDictionaryAndStoredDb();
}

/** The current effective config (code defaults whenever unset/unreadable). */
export async function getLeadQualityConfig(): Promise<LeadQualityConfig> {
  const { dictionary, stored } = await readDictionaryAndStored();
  return resolveStoredConfig(stored, dictionary);
}

/** The current FollowUpStatus dictionary entries (empty when unreadable). */
export async function getLeadQualityDictionary(): Promise<FollowUpStatusEntry[]> {
  return (await readDictionaryAndStored()).dictionary;
}

/** The stored version (0 when the config was never saved). */
export async function getLeadQualityVersion(): Promise<number> {
  const { stored } = await readDictionaryAndStored();
  return stored?.version ?? 0;
}

function buildStatusOptions(
  dictionary: FollowUpStatusEntry[],
  effective: LeadQualityConfig
): LeadQualityStatusOption[] {
  const defaults = DEFAULT_LEAD_QUALITY_CONFIG;
  return dictionary.map(entry => {
    // Effective points: what the scorer actually uses for this entry
    // today (0 when the stored config carries no weight for it).
    const points = Object.prototype.hasOwnProperty.call(effective.statusPoints, entry.value)
      ? effective.statusPoints[entry.value]
      : 0;
    return {
      id: entry.id,
      value: entry.value,
      label: entry.label || entry.value,
      isActive: entry.isActive,
      isTerminal: isTerminalEntry(entry),
      points,
      defaultPoints: defaults.statusPoints[entry.value] ?? 0,
      advanced: effective.advancedStatuses.includes(entry.value),
      defaultAdvanced: defaults.advancedStatuses.includes(entry.value),
    };
  });
}

/** The latest DZ-3 change, from the audit log (null when never changed). */
export async function getLastLeadQualityChange(): Promise<LeadQualityLastChange | null> {
  if (!useDb()) return null;
  try {
    const result = await getPool().query(
      `SELECT actor_user_id, created_at, metadata FROM audit_logs
        WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [LEAD_QUALITY_AUDIT_ACTION]
    );
    const row = result.rows[0];
    if (!row) return null;
    const meta = (row.metadata || {}) as Record<string, any>;
    const newValue = normalizeLeadQualityConfig(meta.newValue);
    return {
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      version: typeof meta.version === 'number' ? meta.version : 0,
      oldValue: meta.oldValue ? normalizeLeadQualityConfig(meta.oldValue) : null,
      newValue,
    };
  } catch {
    return null;
  }
}

/** Full GET payload for the Danger Zone editor. */
export async function getLeadQualityConfigForEdit(): Promise<LeadQualityConfigForEdit> {
  const { dictionary, stored } = await readDictionaryAndStored();
  const effective = resolveStoredConfig(stored, dictionary);
  const lastChange = await getLastLeadQualityChange();
  return {
    version: stored?.version ?? 0,
    config: effective,
    defaults: cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG),
    statusOptions: buildStatusOptions(dictionary, effective),
    lastChange,
  };
}

/* ====================================================================
   WRITES
==================================================================== */

/**
 * Validate a PUT body against the CURRENT dictionary. Returns error
 * strings (empty = valid). Unknown dictionary ids, terminal statuses
 * and out-of-range values are all refused with a clear message.
 */
export function validateLeadQualityConfigInput(
  input: unknown,
  dictionary: FollowUpStatusEntry[]
): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Lead Quality config must be an object.'];
  }
  const body = input as Record<string, any>;
  const errors: string[] = [];
  const required = [
    'baseScore', 'thresholds', 'statusPoints', 'advancedStatusIds',
    'recency', 'engagement', 'failedContact', 'followUp', 'investment',
  ] as const;
  for (const key of required) {
    if (body[key] === undefined) errors.push(`${key} is required.`);
  }
  if (errors.length > 0) return errors;

  // Shape checks reuse the effective-config validator with the id map
  // substituted by an empty name map (id checks follow below).
  errors.push(
    ...validateLeadQualityConfig({
      version: 0,
      baseScore: body.baseScore,
      thresholds: body.thresholds,
      statusPoints: {},
      advancedStatuses: [],
      recency: body.recency,
      engagement: body.engagement,
      failedContact: body.failedContact,
      followUp: body.followUp,
      investment: body.investment,
    })
  );

  const byId = new Map(dictionary.map(e => [e.id, e]));
  if (!body.statusPoints || typeof body.statusPoints !== 'object' || Array.isArray(body.statusPoints)) {
    errors.push('statusPoints must be an object keyed by dictionary-entry id.');
  } else {
    for (const [id, points] of Object.entries(body.statusPoints)) {
      const entry = byId.get(id);
      if (!entry) {
        errors.push(`statusPoints id "${id}" is not a FollowUpStatus dictionary entry.`);
        continue;
      }
      if (isTerminalEntry(entry)) {
        errors.push(`"${entry.value}" is terminal and takes no status points (terminal scores are fixed).`);
      }
      if (!Number.isInteger(points) || (points as number) < LEAD_QUALITY_POINT_MIN || (points as number) > LEAD_QUALITY_POINT_MAX) {
        errors.push(`statusPoints for "${entry.value}" must be a whole number between ${LEAD_QUALITY_POINT_MIN} and ${LEAD_QUALITY_POINT_MAX}.`);
      }
    }
  }
  if (!Array.isArray(body.advancedStatusIds)) {
    errors.push('advancedStatusIds must be a list of dictionary-entry ids.');
  } else {
    for (const id of body.advancedStatusIds) {
      const entry = byId.get(String(id));
      if (!entry) {
        errors.push(`advancedStatusIds id "${id}" is not a FollowUpStatus dictionary entry.`);
        continue;
      }
      if (isTerminalEntry(entry)) {
        errors.push(`"${entry.value}" is terminal and cannot be an advanced status.`);
      }
    }
  }
  return errors;
}

async function upsertConfigRowDb(stored: LeadQualityStoredConfig): Promise<void> {
  const meta = JSON.stringify(stored);
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE options SET meta = $1::jsonb, updated_at = NOW()
      WHERE field_key = $2 AND option_value = $3`,
    [meta, LEAD_QUALITY_OPTION_TYPE, LEAD_QUALITY_CONFIG_OPTION_VALUE]
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       SELECT 'LeadQuality', 'Lead Quality',
              'Versioned Lead Quality scoring config (Danger Zone, DZ-3).',
              TRUE, COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM metadata_types WHERE key = 'LeadQuality')`
    );
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('LeadQuality', $1, $2, 1, FALSE, TRUE, $3::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta, updated_at = NOW()`,
      [LEAD_QUALITY_CONFIG_OPTION_VALUE, LEAD_QUALITY_CONFIG_OPTION_LABEL, meta]
    );
  }
}

function setConfigFallback(stored: LeadQualityStoredConfig): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.options)) store.options = [];
  const existing = store.options.find(
    (o: any) => o.type === LEAD_QUALITY_OPTION_TYPE && o.value === LEAD_QUALITY_CONFIG_OPTION_VALUE
  );
  if (existing) existing.meta = { ...stored };
  else {
    store.options.push({
      id: `lead-quality-${LEAD_QUALITY_CONFIG_OPTION_VALUE}`,
      type: LEAD_QUALITY_OPTION_TYPE,
      value: LEAD_QUALITY_CONFIG_OPTION_VALUE,
      label: LEAD_QUALITY_CONFIG_OPTION_LABEL,
      status: 'Active',
      sortOrder: 1,
      meta: { ...stored },
    });
  }
}

/**
 * Persist a full config (PUT). Validates against the current
 * dictionary, increments the version, and audit-logs old→new.
 * Throws LeadQualityConfigValidationError naming the problem — the
 * route maps it to a 400.
 * The audit row carries the effective (name-keyed) old and new
 * configs; the old→new detail is rendered only inside the Danger
 * Zone (Q2).
 */
export async function setLeadQualityConfig(
  input: LeadQualityConfigInput,
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<LeadQualityConfigForEdit> {
  const { dictionary, stored } = await readDictionaryAndStored();
  const problems = validateLeadQualityConfigInput(input, dictionary);
  if (problems.length > 0) throw new LeadQualityConfigValidationError(problems.join(' '));

  const beforeEffective = resolveStoredConfig(stored, dictionary);
  const version = (stored?.version ?? 0) + 1;
  const nextStored: LeadQualityStoredConfig = {
    version,
    baseScore: input.baseScore,
    thresholds: { ...input.thresholds },
    statusPointsById: { ...input.statusPoints },
    advancedStatusIds: [...input.advancedStatusIds],
    recency: input.recency.map(r => ({ ...r })),
    engagement: { ...input.engagement },
    failedContact: { ...input.failedContact },
    followUp: { scheduledPoints: input.followUp.scheduledPoints, overdue: input.followUp.overdue.map(r => ({ ...r })) },
    investment: { ...input.investment },
  };
  // The stored row must always re-validate (defence in depth).
  const storedErrors = validateStoredLeadQualityConfig(nextStored);
  if (storedErrors.length > 0) throw new LeadQualityConfigValidationError(storedErrors.join(' '));

  if (!useDb()) {
    setConfigFallback(nextStored);
  } else {
    await upsertConfigRowDb(nextStored);
  }
  const afterEffective = resolveStoredConfig(nextStored, dictionary);
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: LEAD_QUALITY_AUDIT_ACTION,
    entityType: 'lead_quality_config',
    entityId: null,
    metadata: {
      key: 'leadQuality',
      version,
      oldValue: beforeEffective,
      newValue: afterEffective,
      ip: opts.ip || undefined,
    },
  });
  return {
    version,
    config: afterEffective,
    defaults: cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG),
    statusOptions: buildStatusOptions(dictionary, afterEffective),
    lastChange: {
      actorUserId: opts.actorId || null,
      createdAt: new Date().toISOString(),
      version,
      oldValue: beforeEffective,
      newValue: afterEffective,
    },
  };
}
