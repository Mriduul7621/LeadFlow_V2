/**
 * StageRulesService — stage rules & terminal unification (Admin
 * Control programme, DZ-6; audit §2.4 D2/D3, §4, §5 Finding 5).
 * ------------------------------------------------------------------
 * Two hardcoded, NAME-keyed sources of truth are retired here:
 *
 *   D2 — the per-status required-field rules (`LEAD_STAGE_RULES` in
 *        src/modules/leads/utils/leadStatusRules.ts). They now live
 *        in the `lead_stage_rules` table (migration 060), ONE row per
 *        FollowUpStatus dictionary entry that carries required
 *        fields, keyed by the entry's id — renaming a status keeps
 *        its rule. The code table remains the default and the
 *        fail-closed fallback (DZ-3 pattern): when the table is
 *        missing or holds no rows, enforcement uses exactly the code
 *        table, resolved against the current dictionary by name.
 *   D3 — the terminal set lived twice: the dictionary's
 *        `meta.isTerminal` flag AND the hardcoded
 *        `TERMINAL_LEAD_STATUSES` constant. The constant is deleted
 *        and the dictionary flag is the single source for every
 *        "open lead" definition (follow-up queue, dashboard counts,
 *        SLA, auto-assignment, calendar sync, push reminders,
 *        deactivation transfers, Lead Quality).
 *
 * TERMINAL, PRECISELY. A dictionary entry is terminal when its
 * meta carries isTerminal = true. An explicit isTerminal = false
 * is a deliberate choice and is honoured (an admin un-ticking a
 * status in the Danger Zone must actually un-close it). Only when
 * the entry carries NO isTerminal key at all (a dictionary row
 * predating the flag, or a hand-built test fixture) does the
 * canonical-name check apply as a compatibility fallback — this is
 * the same fallback DZ-3 already used for quality points, and
 * migration 060 backfills the flag on the two canonical names so a
 * production database never relies on it. The won/lost split of a
 * terminal status comes from the same meta (isWon / isLost, same
 * absent-key name fallback): 'Converted' completes a calendar
 * entry, any other terminal status cancels it.
 *
 * READS NEVER THROW. Every getter catches database failures and
 * falls back (code-default rules / the two canonical terminal
 * names) with a warning, so a bad stored value or a missing table
 * can never take a lead surface down. Callers inside a caller
 * transaction pass { probeFirst: true }: the table's existence is
 * probed via information_schema BEFORE any query touches it — a
 * failed statement aborts the caller's whole PostgreSQL
 * transaction (the DZ-1 regression), so the service must decide
 * before querying, never fail inside it. Pool callers rely on the
 * try/catch instead (no transaction is at stake).
 *
 * WRITES are Danger Zone only (see dangerZone.routes.ts): a full
 * replace of the rule table + the terminal flags on the dictionary
 * rows, in ONE transaction, audit-logged with old→new values
 * (action `danger_zone.stage_rules.update`, Q7). At least one
 * terminal status is always required — an empty terminal set would
 * silently re-open every closed lead in the app.
 *
 * Storage mirrors LeadQualityConfigService exactly (dictionary read
 * from the options table, fallback-store path for demo mode).
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { useDb, logAccessChange } from '../routes/production/shared.js';
import {
  LEAD_STAGE_RULES,
  validateLeadStatusFieldsWithRules,
  type StageField,
  type StageRule,
} from '../../src/modules/leads/utils/leadStatusRules.js';
import { normalizeStatusKey } from '../../src/modules/shared/utils/statusFieldRules.js';

export const STAGE_RULES_AUDIT_ACTION = 'danger_zone.stage_rules.update';
export const FOLLOW_UP_STATUS_TYPE = 'FollowUpStatus';

/**
 * Canonical terminal names — the FAIL-CLOSED FALLBACK ONLY, used
 * when the dictionary cannot be read at all (missing table, DB
 * error, empty dictionary). Never the source of truth: on any
 * readable dictionary the flags decide, and migration 060 backfills
 * them on the two canonical names.
 */
export const FALLBACK_TERMINAL_STATUS_NAMES = ['Converted', 'Not Interested'] as const;
export const FALLBACK_TERMINAL_WON_NAMES = ['Converted'] as const;
export const FALLBACK_TERMINAL_LOST_NAMES = ['Not Interested'] as const;

/** Thrown by setStageRules when the PUT body is invalid (route maps it to a 400). */
export class StageRulesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageRulesValidationError';
  }
}

export interface StageRulesExecutor {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** One FollowUpStatus dictionary entry as this service sees it. */
export interface FollowUpStatusEntry {
  id: string;
  value: string;
  label: string;
  isActive: boolean;
  isTerminal: boolean;
  isWon: boolean;
  isLost: boolean;
}

/** The stored rule shape (required fields), per dictionary entry. */
export interface StageRuleEffective {
  /** Dictionary-entry id ('' for a code-default rule with no dictionary match). */
  statusId: string;
  /** Current dictionary name. */
  status: string;
  required: StageField[];
}

export interface StageRuleInput {
  statusId: string;
  required: StageField[];
}

export interface StageRulesInput {
  rules: StageRuleInput[];
  terminalStatusIds: string[];
}

export interface TerminalStatusInfo {
  /** Current names flagged terminal (won + lost). */
  names: string[];
  /** Terminal names that are wins (complete the calendar entry). */
  wonNames: string[];
  /** Terminal names that are losses (cancel the calendar entry). */
  lostNames: string[];
  entries: FollowUpStatusEntry[];
}

export interface StageStatusOption {
  id: string;
  value: string;
  label: string;
  isActive: boolean;
  isTerminal: boolean;
  isWon: boolean;
  isLost: boolean;
  /** The effective required fields for this status (null = no rule). */
  required: StageField[] | null;
}

export interface StageRulesLastChange {
  actorUserId: string | null;
  createdAt: string;
  version: number;
  oldValue: { rules: StageRuleEffective[]; terminalStatusIds: string[] } | null;
  newValue: { rules: StageRuleEffective[]; terminalStatusIds: string[] };
}

export interface StageRulesForEdit {
  version: number;
  rules: StageRuleEffective[];
  defaults: StageRuleEffective[];
  fieldVocabulary: StageField[];
  statusOptions: StageStatusOption[];
  terminalStatusIds: string[];
  lastChange: StageRulesLastChange | null;
}

/* ====================================================================
   TERMINAL — the tri-state flag rule
==================================================================== */

/** Canonical terminal names (fallback only — see the header). */
export function isTerminalStatusName(value: string): boolean {
  const v = String(value || '').trim().toLowerCase();
  return v === 'converted' || v === 'not interested';
}

function isWonStatusName(value: string): boolean {
  return String(value || '').trim().toLowerCase() === 'converted';
}

function isLostStatusName(value: string): boolean {
  return String(value || '').trim().toLowerCase() === 'not interested';
}

/**
 * The terminal decision for ONE dictionary entry. meta.isTerminal
 * true → terminal; false → NOT terminal (an explicit admin choice);
 * key absent → the canonical-name fallback (pre-flag dictionaries).
 * The same tri-state applies to isWon / isLost.
 */
export function isTerminalDictionaryEntry(entry: {
  value: string;
  meta?: Record<string, any> | null;
  isTerminal?: boolean | null;
  isWon?: boolean | null;
  isLost?: boolean | null;
}): boolean {
  if (entry.meta && typeof entry.meta === 'object' && 'isTerminal' in entry.meta) {
    return entry.meta.isTerminal === true;
  }
  if (entry.isTerminal !== undefined && entry.isTerminal !== null) return entry.isTerminal === true;
  return isTerminalStatusName(entry.value);
}

export function isWonDictionaryEntry(entry: {
  value: string;
  meta?: Record<string, any> | null;
  isWon?: boolean | null;
}): boolean {
  if (entry.meta && typeof entry.meta === 'object' && 'isWon' in entry.meta) {
    return entry.meta.isWon === true;
  }
  if (entry.isWon !== undefined && entry.isWon !== null) return entry.isWon === true;
  return isWonStatusName(entry.value);
}

export function isLostDictionaryEntry(entry: {
  value: string;
  meta?: Record<string, any> | null;
  isLost?: boolean | null;
}): boolean {
  if (entry.meta && typeof entry.meta === 'object' && 'isLost' in entry.meta) {
    return entry.meta.isLost === true;
  }
  if (entry.isLost !== undefined && entry.isLost !== null) return entry.isLost === true;
  return isLostStatusName(entry.value);
}

/** The field vocabulary the DZ editor may require (the code table's fields). */
export const STAGE_RULE_FIELDS: StageField[] = (() => {
  const seen = new Map<string, StageField>();
  for (const rule of LEAD_STAGE_RULES) {
    for (const field of rule.required) {
      if (!seen.has(field.field)) seen.set(field.field, { ...field });
    }
  }
  return [...seen.values()];
})();

/* ====================================================================
   DICTIONARY READS
==================================================================== */

function dictionaryFromDbRows(rows: any[]): FollowUpStatusEntry[] {
  return (rows || []).map((r: any) => {
    const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    const entry = {
      id: String(r.id),
      value: String(r.option_value ?? r.value ?? ''),
      label: String(r.option_label ?? r.label ?? r.option_value ?? r.value ?? ''),
      isActive: r.is_active !== false && r.status !== 'Inactive',
      isTerminal: false,
      isWon: false,
      isLost: false,
    };
    // Tri-state resolution needs the raw meta (a missing key is NOT
    // the same as an explicit false) — resolve here, once.
    entry.isTerminal = isTerminalDictionaryEntry({ value: entry.value, meta });
    entry.isWon = isWonDictionaryEntry({ value: entry.value, meta });
    entry.isLost = isLostDictionaryEntry({ value: entry.value, meta });
    return entry;
  });
}

function dictionaryFromFallbackRows(rows: any[]): FollowUpStatusEntry[] {
  return dictionaryFromDbRows(
    (rows || []).map((o: any) => ({
      id: o.id,
      option_value: o.value,
      option_label: o.label ?? o.value,
      is_active: o.status !== 'Inactive' && o.isActive !== false,
      meta: o.meta && typeof o.meta === 'object' ? o.meta : {},
    }))
  );
}

async function hasTable(executor: StageRulesExecutor, table: string): Promise<boolean> {
  try {
    const res = await executor.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [table]
    );
    return (res.rows || []).length > 0;
  } catch {
    return false;
  }
}

async function readDictionaryDb(
  executor: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<FollowUpStatusEntry[]> {
  if (opts.probeFirst && !(await hasTable(executor, 'options'))) return [];
  const res = await executor.query(
    `SELECT id, option_value, option_label, is_active, meta
       FROM options WHERE field_key = $1 ORDER BY sort_order ASC, option_value ASC`,
    [FOLLOW_UP_STATUS_TYPE]
  );
  return dictionaryFromDbRows(res.rows);
}

function readDictionaryFallback(): FollowUpStatusEntry[] {
  const rows = ((fallbackStore as any).options as any[] | undefined) || [];
  return dictionaryFromFallbackRows(rows.filter((o: any) => o.type === FOLLOW_UP_STATUS_TYPE));
}

/**
 * The FollowUpStatus dictionary. Pool callers rely on the try/catch
 * (no transaction is at stake); transaction callers pass
 * { probeFirst: true } so a missing table is decided before any
 * statement can abort their transaction.
 */
export async function getFollowUpStatusDictionary(
  executor?: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<FollowUpStatusEntry[]> {
  if (!useDb()) return readDictionaryFallback();
  try {
    return await readDictionaryDb(executor ?? getPool(), opts);
  } catch (error: any) {
    console.warn('[stage-rules] status dictionary unavailable, using fallback terminal names:', error?.message || error);
    return [];
  }
}

function terminalInfoFromEntries(dictionary: FollowUpStatusEntry[]): TerminalStatusInfo {
  const terminal = dictionary.filter(e => e.isTerminal);
  return {
    names: terminal.map(e => e.value),
    wonNames: terminal.filter(e => e.isWon).map(e => e.value),
    lostNames: terminal.filter(e => !e.isWon).map(e => e.value),
    entries: dictionary,
  };
}

function fallbackTerminalInfo(): TerminalStatusInfo {
  return {
    names: [...FALLBACK_TERMINAL_STATUS_NAMES],
    wonNames: [...FALLBACK_TERMINAL_WON_NAMES],
    lostNames: [...FALLBACK_TERMINAL_LOST_NAMES],
    entries: [],
  };
}

/**
 * Terminal names / won / lost names from the dictionary. An EMPTY
 * dictionary (table missing, DB error, nothing seeded) falls back
 * to the two canonical names — a dictionary that EXISTS but flags
 * nothing terminal is honoured as-is (zero terminal names), because
 * that is an explicit state, not a read failure.
 */
export async function getTerminalStatusInfo(
  executor?: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<TerminalStatusInfo> {
  const dictionary = await getFollowUpStatusDictionary(executor, opts);
  if (dictionary.length === 0) return fallbackTerminalInfo();
  return terminalInfoFromEntries(dictionary);
}

export async function getTerminalStatusNames(
  executor?: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<string[]> {
  return (await getTerminalStatusInfo(executor, opts)).names;
}

export async function getTerminalStatusIds(
  executor?: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<string[]> {
  const dictionary = await getFollowUpStatusDictionary(executor, opts);
  if (dictionary.length === 0) return [];
  return dictionary.filter(e => e.isTerminal).map(e => e.id);
}

/** Demo-mode terminal names (fallback store, else the canonical two). */
export function getTerminalStatusNamesFallback(): string[] {
  const dictionary = readDictionaryFallback();
  if (dictionary.length === 0) return [...FALLBACK_TERMINAL_STATUS_NAMES];
  return dictionary.filter(e => e.isTerminal).map(e => e.value);
}

/** Demo-mode terminal info (fallback store, else the canonical split). */
export function getTerminalStatusInfoFallback(): TerminalStatusInfo {
  const dictionary = readDictionaryFallback();
  if (dictionary.length === 0) return fallbackTerminalInfo();
  return terminalInfoFromEntries(dictionary);
}

/**
 * Pure terminal check against a resolved name list. Callers that
 * already resolved the dictionary pass it; anything else gets the
 * canonical fallback (the same fallback the getters use on a read
 * failure) — never a throw.
 */
export function isTerminalStatus(
  status: unknown,
  terminalNames: readonly string[] = FALLBACK_TERMINAL_STATUS_NAMES
): boolean {
  const key = String(status ?? '').trim().toLowerCase();
  if (!key) return false;
  return (terminalNames || []).some(n => String(n).trim().toLowerCase() === key);
}

/* ====================================================================
   EFFECTIVE STAGE RULES
==================================================================== */

/** The code-default rules resolved against the current dictionary (name match). */
export function codeDefaultRules(dictionary: FollowUpStatusEntry[]): StageRuleEffective[] {
  const byKey = new Map(dictionary.map(e => [normalizeStatusKey(e.value), e]));
  return LEAD_STAGE_RULES.map(rule => {
    const entry = byKey.get(normalizeStatusKey(rule.status));
    return {
      statusId: entry ? entry.id : '',
      status: entry ? entry.value : rule.status,
      required: rule.required.map(f => ({ ...f })),
    };
  });
}

interface StoredRuleRow {
  status_option_id: string;
  required_fields: any;
}

function parseStoredRuleFields(value: unknown): StageField[] | null {
  if (!Array.isArray(value)) return null;
  const out: StageField[] = [];
  for (const f of value) {
    if (!f || typeof f !== 'object' || typeof (f as any).field !== 'string' || !(f as any).field) return null;
    const field: StageField = {
      field: (f as any).field,
      label: typeof (f as any).label === 'string' && (f as any).label ? (f as any).label : (f as any).field,
    };
    if ((f as any).numeric === true) field.numeric = true;
    if ((f as any).positive === true) field.positive = true;
    out.push(field);
  }
  return out;
}

async function readStoredRulesDb(
  executor: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<StoredRuleRow[] | null> {
  if (opts.probeFirst && !(await hasTable(executor, 'lead_stage_rules'))) return null;
  const res = await executor.query(
    `SELECT status_option_id, required_fields FROM lead_stage_rules ORDER BY status_option_id ASC`
  );
  return (res.rows || []).map((r: any) => ({
    status_option_id: String(r.status_option_id),
    required_fields: r.required_fields,
  }));
}

/**
 * The effective rules, resolved to CURRENT dictionary names.
 * Stored rows win; unknown ids are dropped; a missing table or
 * zero stored rows means "never saved" and the code defaults
 * apply (DZ-3 pattern). Never throws.
 */
export async function getEffectiveStageRules(
  executor?: StageRulesExecutor,
  opts: { probeFirst?: boolean } = {}
): Promise<StageRuleEffective[]> {
  const dictionary = await getFollowUpStatusDictionary(executor, opts);
  try {
    if (useDb()) {
      const stored = await readStoredRulesDb(executor ?? getPool(), opts);
      if (stored && stored.length > 0) {
        const byId = new Map(dictionary.map(e => [e.id, e]));
        const out: StageRuleEffective[] = [];
        for (const row of stored) {
          const entry = byId.get(row.status_option_id);
          if (!entry) continue;
          const required = parseStoredRuleFields(row.required_fields);
          if (!required || required.length === 0) continue;
          out.push({ statusId: entry.id, status: entry.value, required });
        }
        if (out.length > 0) return out;
        // Stored rows existed but none survived resolution (stale
        // ids): fall through to the code defaults, never to nothing.
      }
    }
  } catch (error: any) {
    console.warn('[stage-rules] stored rules unavailable, using code defaults:', error?.message || error);
  }
  return codeDefaultRules(dictionary);
}

/**
 * Server-side enforcement for POST /leads/:id/follow-up. Reads the
 * effective (DB) rules; on any read failure enforces the static
 * code table instead — the follow-up is never left unguarded, and
 * never blocked by a rules read that failed.
 */
export async function validateLeadStatusFieldsAsync(
  status: string,
  payload: Record<string, unknown>,
  executor?: StageRulesExecutor
): Promise<ReturnType<typeof validateLeadStatusFieldsWithRules>> {
  try {
    const rules = await getEffectiveStageRules(executor);
    return validateLeadStatusFieldsWithRules(status, payload, rules);
  } catch (error: any) {
    console.warn('[stage-rules] effective-rule validation fell back to code defaults:', error?.message || error);
    const { validateLeadStatusFields } = await import(
      '../../src/modules/leads/utils/leadStatusRules.js'
    );
    return validateLeadStatusFields(status, payload);
  }
}

/* ====================================================================
   WRITES (Danger Zone only)
==================================================================== */

/** Validate a PUT body against the CURRENT dictionary. Returns error strings (empty = valid). */
export function validateStageRulesInput(
  input: unknown,
  dictionary: FollowUpStatusEntry[]
): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['Stage rules must be an object with rules and terminalStatusIds.'];
  }
  const body = input as Record<string, any>;
  const errors: string[] = [];
  if (!Array.isArray(body.rules)) {
    errors.push('rules must be a list of per-status required fields.');
  } else if (body.rules.length === 0) {
    errors.push('rules must not be empty — at least one status must keep its required fields.');
  }
  if (!Array.isArray(body.terminalStatusIds)) {
    errors.push('terminalStatusIds must be a list of dictionary-entry ids.');
  } else if (body.terminalStatusIds.length === 0) {
    errors.push('At least one status must stay terminal — an empty terminal set would re-open every closed lead.');
  }
  if (errors.length > 0) return errors;

  const byId = new Map(dictionary.map(e => [e.id, e]));
  const vocabulary = new Map(STAGE_RULE_FIELDS.map(f => [f.field, f]));
  const seenStatus = new Set<string>();
  for (const rule of body.rules as any[]) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push('Each rule must be an object with statusId and required.');
      continue;
    }
    const entry = byId.get(String(rule.statusId || ''));
    if (!entry) {
      errors.push(`rules statusId "${rule.statusId}" is not a FollowUpStatus dictionary entry.`);
      continue;
    }
    if (seenStatus.has(entry.id)) {
      errors.push(`"${entry.value}" has more than one rule — one rule per status.`);
      continue;
    }
    seenStatus.add(entry.id);
    if (!Array.isArray(rule.required) || rule.required.length === 0) {
      errors.push(`"${entry.value}" must list at least one required field (omit the status to carry no rule).`);
      continue;
    }
    const seenField = new Set<string>();
    for (const field of rule.required) {
      if (!field || typeof field !== 'object' || typeof field.field !== 'string' || !field.field) {
        errors.push(`"${entry.value}" has a required field without a field name.`);
        continue;
      }
      const known = vocabulary.get(field.field);
      if (!known) {
        errors.push(`"${entry.value}" requires unknown field "${field.field}".`);
        continue;
      }
      if (seenField.has(field.field)) {
        errors.push(`"${entry.value}" lists "${field.field}" more than once.`);
        continue;
      }
      seenField.add(field.field);
      // The label / numeric / positive shape is fixed by the
      // vocabulary: a PUT may not invent a new meaning for a field.
      if (field.label !== undefined && field.label !== known.label) {
        errors.push(`"${entry.value}" field "${field.field}" must keep its label "${known.label}".`);
      }
      if (field.numeric !== undefined && field.numeric !== !!known.numeric) {
        errors.push(`"${entry.value}" field "${field.field}" must keep its numeric flag.`);
      }
      if (field.positive !== undefined && field.positive !== !!known.positive) {
        errors.push(`"${entry.value}" field "${field.field}" must keep its positive flag.`);
      }
    }
  }
  const seenTerminal = new Set<string>();
  for (const id of body.terminalStatusIds as any[]) {
    const entry = byId.get(String(id || ''));
    if (!entry) {
      errors.push(`terminalStatusIds id "${id}" is not a FollowUpStatus dictionary entry.`);
      continue;
    }
    if (seenTerminal.has(entry.id)) {
      errors.push(`"${entry.value}" is listed as terminal more than once.`);
      continue;
    }
    seenTerminal.add(entry.id);
  }
  return errors;
}

function rulesFromInput(input: StageRulesInput, dictionary: FollowUpStatusEntry[]): StageRuleEffective[] {
  const byId = new Map(dictionary.map(e => [e.id, e]));
  const vocabulary = new Map(STAGE_RULE_FIELDS.map(f => [f.field, f]));
  const out: StageRuleEffective[] = [];
  for (const rule of input.rules) {
    const entry = byId.get(rule.statusId);
    if (!entry) continue;
    out.push({
      statusId: entry.id,
      status: entry.value,
      required: rule.required.map(f => ({ ...(vocabulary.get(f.field) || f) })),
    });
  }
  return out;
}

async function getLastStageRulesVersion(): Promise<number> {
  if (!useDb()) return 0;
  try {
    const result = await getPool().query(
      `SELECT metadata FROM audit_logs WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [STAGE_RULES_AUDIT_ACTION]
    );
    const version = (result.rows[0]?.metadata as any)?.version;
    return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 0;
  } catch {
    return 0;
  }
}

/** The latest DZ-6 change, from the audit log (null when never changed). */
export async function getLastStageRulesChange(): Promise<StageRulesLastChange | null> {
  if (!useDb()) return null;
  try {
    const result = await getPool().query(
      `SELECT actor_user_id, created_at, metadata FROM audit_logs
        WHERE action_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [STAGE_RULES_AUDIT_ACTION]
    );
    const row = result.rows[0];
    if (!row) return null;
    const meta = (row.metadata || {}) as Record<string, any>;
    const parse = (v: any): { rules: StageRuleEffective[]; terminalStatusIds: string[] } | null => {
      if (!v || typeof v !== 'object') return null;
      return {
        rules: Array.isArray(v.rules) ? v.rules : [],
        terminalStatusIds: Array.isArray(v.terminalStatusIds) ? v.terminalStatusIds : [],
      };
    };
    return {
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      version: typeof meta.version === 'number' ? meta.version : 0,
      oldValue: parse(meta.oldValue),
      newValue: parse(meta.newValue) ?? { rules: [], terminalStatusIds: [] },
    };
  } catch {
    return null;
  }
}

/** Full GET payload for the Danger Zone editor. */
export async function getStageRulesForEdit(): Promise<StageRulesForEdit> {
  const dictionary = await getFollowUpStatusDictionary();
  const effective = await getEffectiveStageRules();
  const defaults = codeDefaultRules(dictionary);
  const version = await getLastStageRulesVersion();
  const lastChange = await getLastStageRulesChange();
  const ruleById = new Map(effective.map(r => [r.statusId, r.required]));
  return {
    version,
    rules: effective,
    defaults,
    fieldVocabulary: STAGE_RULE_FIELDS.map(f => ({ ...f })),
    statusOptions: dictionary.map(entry => ({
      id: entry.id,
      value: entry.value,
      label: entry.label || entry.value,
      isActive: entry.isActive,
      isTerminal: entry.isTerminal,
      isWon: entry.isWon,
      isLost: entry.isLost,
      required: ruleById.get(entry.id) ?? null,
    })),
    terminalStatusIds: dictionary.filter(e => e.isTerminal).map(e => e.id),
    lastChange,
  };
}

/**
 * Persist a full rule set + terminal flags (PUT). Full replace in
 * ONE transaction (rule rows + dictionary meta), then an audit row
 * with old→new. Throws StageRulesValidationError naming the problem
 * — the route maps it to a 400. The old→new detail is rendered
 * only inside the Danger Zone (Q2).
 */
export async function setStageRules(
  input: StageRulesInput,
  opts: { actorId?: string | null; ip?: string | null } = {}
): Promise<StageRulesForEdit> {
  const dictionary = await getFollowUpStatusDictionary();
  const problems = validateStageRulesInput(input, dictionary);
  if (problems.length > 0) throw new StageRulesValidationError(problems.join(' '));

  const beforeRules = await getEffectiveStageRules();
  const beforeTerminalIds = dictionary.filter(e => e.isTerminal).map(e => e.id);
  const version = (await getLastStageRulesVersion()) + 1;
  const nextRules = rulesFromInput(input, dictionary);
  const nextTerminalIds = [...new Set(input.terminalStatusIds.map(String))];

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM lead_stage_rules`);
    for (const rule of nextRules) {
      await client.query(
        `INSERT INTO lead_stage_rules (status_option_id, required_fields)
         VALUES ($1, $2::jsonb)`,
        [rule.statusId, JSON.stringify(rule.required)]
      );
    }
    // Terminal flags live on the dictionary rows themselves
    // (meta.isTerminal) — the single source every reader consults.
    // jsonb_set preserves the row's other meta keys (colour, won /
    // lost); only rows whose flag actually differs are touched.
    for (const entry of dictionary) {
      const next = nextTerminalIds.includes(entry.id);
      // Two separate params for the same value: $2 feeds the
      // jsonb_set, $4 feeds the boolean comparison. A single param
      // cast twice ($2::jsonb AND $2::boolean) makes Postgres infer
      // ONE type for $2 — boolean — and the jsonb cast then dies
      // with "cannot cast type boolean to jsonb" (caught by the
      // DZ-6 suite, not by inspection). Both params carry the JSON
      // literal 'true' / 'false' as text: Postgres has no
      // boolean→jsonb cast, so a JS boolean param would fail too.
      await client.query(
        `UPDATE options
            SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{isTerminal}', $2::jsonb, true),
                updated_at = NOW()
          WHERE field_key = $1 AND id = $3::uuid
            AND (CASE WHEN (COALESCE(meta, '{}'::jsonb) ? 'isTerminal')
                      THEN (meta->>'isTerminal') = 'true'
                      ELSE FALSE END) IS DISTINCT FROM $4::boolean`,
        [FOLLOW_UP_STATUS_TYPE, JSON.stringify(next), entry.id, JSON.stringify(next)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the transaction is already gone */
    }
    throw error;
  } finally {
    client.release();
  }

  const after: { rules: StageRuleEffective[]; terminalStatusIds: string[] } = {
    rules: nextRules,
    terminalStatusIds: nextTerminalIds,
  };
  await logAccessChange({
    actorId: opts.actorId || null,
    targetUserId: opts.actorId || null,
    actionCode: STAGE_RULES_AUDIT_ACTION,
    entityType: 'stage_rules',
    entityId: null,
    metadata: {
      key: 'stageRules',
      version,
      oldValue: { rules: beforeRules, terminalStatusIds: beforeTerminalIds },
      newValue: after,
      ip: opts.ip || undefined,
    },
  });
  return {
    ...(await getStageRulesForEdit()),
    version,
    lastChange: {
      actorUserId: opts.actorId || null,
      createdAt: new Date().toISOString(),
      version,
      oldValue: { rules: beforeRules, terminalStatusIds: beforeTerminalIds },
      newValue: after,
    },
  };
}
