/**
 * production/leads.routes.ts — LEADS domain of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the twelve handlers that
 * used to live inline in production.routes.ts — lead list / create,
 * the hardened bulk import, the follow-up queue, single-lead read,
 * quality and activity views, the follow-up write path, lead delete,
 * campaign purge and clear-all (with the Phase 0 typed-confirm and
 * pre-delete snapshot safety rails) and the per-lead
 * scheduled-activities listing — moved verbatim, together with their
 * exclusive helpers (the lead row mapper, the secure record builder,
 * the upsert / bulk SQL and the Lead Quality list filters). Helpers
 * shared with the remaining monolith domains live in ./shared.js
 * (one definition, imported by both sides); buildDashboardVisibilitySql
 * moved there in this step because the dashboard handler also calls it.
 *
 * FORBIDDEN_CUSTOM_KEYS / sanitizeCustomFields / buildSecureLeadRecord
 * stay importable from production.routes.ts via a re-export (the test
 * suite imports them from there); their single definition lives here.
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import { createPerf } from '../../utils/perf.js';
import {
  leadStatusViolationMessage,
  resolveNextActionStatus,
} from '../../utils/leadStatusRules.js';
import {
  getEffectiveStageRules,
  getTerminalStatusNames,
  getTerminalStatusNamesFallback,
  validateLeadStatusFieldsAsync,
} from '../../services/StageRulesService.js';
// NOTE: the `.js` extension is mandatory here. Vercel transpiles every
// traced file individually and runs the tree as plain Node ESM, where an
// extensionless relative import is a runtime ERR_MODULE_NOT_FOUND even
// though tsx/esbuild resolve it locally (see scripts/verify-serverless-build.mjs).
import { normalizeStatusKey } from '../../../src/modules/shared/utils/statusFieldRules.js';
import {
  mapSpreadsheetRow,
  normalizePhoneKey,
  parseAmount,
  parseTat,
  resolveImportStatus,
  canonicalizeLegacyStatusValue,
  DEFAULT_STATUS_DICTIONARY,
  rowFingerprint,
  type ImportRow,
} from '../leadImport.js';
import {
  BUSINESS_TIMEZONE,
  getDhakaBusinessDayBounds,
  overdueDays,
  parseYmd,
  dhakaStartUtc,
  addCalendarDays,
} from '../../utils/businessTime.js';
import {
  fetchActivityQualitySignals,
  fetchScheduledQualitySignals,
  compactScoreLeadRow,
  scoreLeadRow,
  compactQualityForFallbackLeads,
  scoreFallbackLead,
} from '../../utils/leadQualitySignals.js';
import type { LeadQualityBand } from '../../utils/leadQuality.js';
import {
  createAssignmentNotifications,
  createAssignmentNotificationsDemo,
} from '../../services/NotificationService.js';
import { getLeadBulkImportMaxRows } from '../../services/OperationsSettingsService.js';
import {
  AUTO_ASSIGN_AUDIT_ACTION,
  AUTO_ASSIGN_RULE,
  buildAutoAssignHistoryEntry,
  buildDemoAutoAssignCandidates,
  isAutoAssignmentEnabled,
  loadAutoAssignCandidates,
  pickAutoAssignee,
  resolveAutoAssignment,
  type AutoAssignPick,
} from '../../services/AutoAssignmentService.js';
import {
  computeLeadSla,
  getLeadSlaConfig,
} from '../../services/LeadSlaService.js';
import { getLeadQualityConfig } from '../../services/LeadQualityConfigService.js';
import {
  reconcileLeadNextStepCalendar,
  reconcileLeadNextStepCalendarDemo,
  resolveNextStep,
  syncNextStepAfterFollowUp,
  syncNextStepAfterFollowUpDemo,
} from '../../services/NextStepCalendarSync.js';
import {
  AUDIT_CHANGE_CAP,
  LEAD_SELECT,
  asUuid,
  buildDashboardVisibilitySql,
  callerIsAdmin,
  clean,
  dateOrNull,
  dbErrorStatus,
  demoModeAllowed,
  employeeIdsFor,
  findLeadByIdRaw,
  getCallerDbInfo,
  getFollowUpStatusValues,
  hasPermissionCode,
  isAssignedToAllowed,
  isCanonicalLowerUuid,
  isLeadAccessible,
  logAccessChange,
  managerEmployeeId,
  mapActivityRow,
  mapScheduledActivityRow,
  normalizeRole,
  parseNumeric,
  requireAdmin,
  requireAuth,
  resolveAssignedTo,
  resolveCallerVisibility,
  resolveUserId,
  sendDbUnavailable,
  sendJson,
  useDb,
  type CallerDbInfo,
} from './shared.js';

const router = Router();

function mapLeadRow(row: any) {
  const custom = row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {};
  const spread: Record<string, any> = { ...custom };
  const hasCanonicalAssignment = row.assigned_to != null && String(row.assigned_to).trim() !== '';
  // PostgreSQL assigned_to is the only ownership source. Never resurrect a
  // stale custom_fields.assignedTo value for an unassigned canonical row.
  const assignedToEmp = hasCanonicalAssignment ? (row.assigned_to_employee_id || '') : '';
  const assignedByEmp = row.assigned_by_employee_id || '';
  return {
    ...spread,
    id: row.lead_code || row.id,
    dbId: row.id,
    prospectName: row.customer_name,
    customerName: row.customer_name,
    mobile: row.mobile || '',
    alternateMobile: row.alternate_mobile || '',
    email: row.email || '',
    profession: row.occupation || spread.profession || '',
    occupation: row.occupation || '',
    maritalStatus: row.marital_status || '',
    address: row.address || '',
    area: row.area || '',
    district: row.district || '',
    division: row.division || '',
    source: row.source || '',
    priority: row.priority || spread.priority || 'NORMAL',
    notes: row.notes || '',
    assignedTo: assignedToEmp || spread.assignedTo || '',
    assignedBy: assignedByEmp || spread.assignedBy || '',
    assignedDate: row.assigned_at || spread.assignedDate || '',
    projectedNCP: row.expected_premium != null ? Number(row.expected_premium) : (spread.projectedNCP ?? 0),
    sumAssured: row.expected_value != null ? Number(row.expected_value) : (spread.sumAssured ?? 0),
    lastFollowUpDate: row.last_contacted_at || spread.lastFollowUpDate || '',
    nextFollowUpDate: row.next_follow_up_at || spread.nextFollowUpDate || '',
    currentStatus: row.current_status || spread.currentStatus || 'New',
    statusHistory: Array.isArray(row.status_history) ? row.status_history : (Array.isArray(spread.statusHistory) ? spread.statusHistory : []),
    assignmentHistory: Array.isArray(row.assignment_history) ? row.assignment_history : (Array.isArray(spread.assignmentHistory) ? spread.assignmentHistory : []),
    documents: Array.isArray(row.documents) ? row.documents : (Array.isArray(spread.documents) ? spread.documents : []),
    tags: Array.isArray(row.tags) ? row.tags : [],
    campaignName: spread.campaignName || '',
    creationDate: row.created_at,
    timestamp: row.updated_at || row.created_at,
  };
}

/**
 * Upper bound for GET /leads (the client's shared "visible leads" read).
 *
 * Unchanged by default — this is a documented tuning knob, not a behavior
 * change: at 5000 rows the JSON payload is already ~1.2 MB (≈78 KiB gzipped)
 * and the client mirrors it into localStorage on every call, so
 * deployments with very large books can lower it (LEADS_LIST_MAX_ROWS)
 * once their pages pass an explicit `limit`, without a code change.
 */
function resolveLeadsListMaxRows(): number {
  const configured = Number(process.env.LEADS_LIST_MAX_ROWS);
  if (Number.isFinite(configured) && configured > 0) return Math.min(Math.floor(configured), 5000);
  return 5000;
}

/* ====================================================================
   HELPERS - shared value conversions
==================================================================== */

/** Deterministic lead code for bulk imports (idempotency across retries). */
function importLeadCode(mobile: string): string {
  const digits = mobile.replace(/\D/g, '').slice(-11);
  return `imp_${digits}`;
}

/* ====================================================================
   LEAD SECURITY HARDENING HELPERS
   - PostgreSQL is authoritative
   - All identity fields derived from authenticated session
   - Ownership + hierarchy/data-scope enforced server-side
   - Permission checks reuse existing permissions table
==================================================================== */

/** Fields that must NEVER be trusted from client payload for authz. */
export const FORBIDDEN_CUSTOM_KEYS = new Set([
  'assignedBy', 'assigned_by', 'updatedBy', 'updated_by',
  'createdBy', 'created_by', 'created_by_employee', 'updated_by_employee',
  'deletedBy', 'deleted_by', 'owner', 'ownerId', 'owner_id',
  'employeeId', 'employee_id', 'visibility', 'scope', 'role', 'roleCode', 'role_code',
]);

/** Sanitize customFields to remove forbidden authz-influencing keys. */
export function sanitizeCustomFields(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (FORBIDDEN_CUSTOM_KEYS.has(k)) continue;
    if (k.startsWith('_')) continue;
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/* ====================================================================
   LEADS
==================================================================== */

/* ====================================================================
   LEADS - HARDENED
   - PostgreSQL authoritative
   - Authentication required for all mutations
   - Server-side authorization via hierarchy/data-scope (resolveVisibility)
   - Permission checks (leads.create, leads.edit, leads.delete, leads.import, leads.view)
   - Spoofing prevention: assignedBy/created_by/updated_by derived from session
   - assignedTo validated against caller's visible scope
   - Mobile upsert does NOT bypass authz
==================================================================== */

/** Builds the column set + params for the leads upsert (single/bulk). */
export interface LeadRecord {
  leadCode: string;
  customerName: string;
  mobile: string;
  alternateMobile: string | null;
  email: string | null;
  maritalStatus: string | null;
  occupation: string | null;
  address: string | null;
  area: string | null;
  district: string | null;
  division: string | null;
  source: string | null;
  priority: string;
  projectedNCP: number | null;
  sumAssured: number | null;
  collectedNCP: number | null;
  notes: string | null;
  assignedTo: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  lastFollowUpDate: string | null;
  nextFollowUpDate: string | null;
  currentStatus: string | null;
  statusHistory: unknown[];
  assignmentHistory: unknown[];
  documents: unknown[];
  tags: string[];
  customFields: Record<string, any>;
  createdBy: string | null;
  updatedBy: string | null;
  /** Historical Lead Date - written to created_at on INSERT only. */
  createdAt: string | null;
  /** Resolved Previously Assigned user id (previous_assigned_to FK). */
  previousAssignedTo: string | null;
}

const LEAD_IGNORED_KEYS = new Set([
  'id', 'dbId', 'customerName', 'customer_name', 'prospectName', 'prospect_name',
  'mobile', 'mobileNumber', 'alternateMobile', 'email', 'profession', 'occupation',
  'maritalStatus', 'address', 'area', 'district', 'division', 'thana', 'source',
  'priority', 'notes', 'assignedTo', 'assignedBy', 'assignedDate', 'projectedNCP',
  'expectedPremium', 'sumAssured', 'expectedValue', 'collectedNCP', 'lastFollowUpDate',
  'nextFollowUpDate', 'nextCallDate', 'meetingDate', 'tags', 'creationDate', 'timestamp',
  'statusHistory', 'assignmentHistory', 'documents', 'currentStatus', 'customFields',
  'createdBy', 'updatedBy', 'created_by', 'updated_by', 'assigned_by', 'assigned_to',
  'created_at', 'updated_at', 'is_deleted', 'deleted_at', 'deleted_by',
  '_preserveAssignment',
]);

/** Normalize an incoming lead payload (frontend shape) to DB fields - SECURE version.
 *  Caller identity is derived from session, not client.
 *  options.allowUnassigned         - bulk import: a BLANK assignment stays
 *                                    unassigned (schema allows it) instead of
 *                                    silently self-assigning to the caller.
 *  options.preserveSuppliedDates   - bulk import: never substitute "now" for
 *                                    a blank/supplied date; keep exactly what
 *                                    the row says (null when absent).
 */
export async function buildSecureLeadRecord(
  lead: any,
  caller: CallerDbInfo,
  targetAssigned: { userId: string; employeeId: string } | null,
  options?: { allowUnassigned?: boolean; preserveSuppliedDates?: boolean }
): Promise<LeadRecord | { error: string }> {
  const customerName = clean(lead.customerName || lead.customer_name || lead.prospectName || lead.prospect_name);
  const mobile = clean(lead.mobile || lead.mobileNumber || lead.phone);
  if (!customerName || !mobile) {
    return { error: 'Customer name and mobile are required' };
  }
  const numeric = (v: any): number | null => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const leadCode = String(lead.leadCode || lead.lead_code || lead.id || createId('lead')).slice(0, 50);

  // AssignedTo is a validated target. Single-lead create defaults to the
  // caller; the bulk import path may explicitly leave a lead unassigned.
  const preserveDates = options?.preserveSuppliedDates === true;
  const effectiveAssigned = targetAssigned || (options?.allowUnassigned ? null : { userId: caller.id, employeeId: caller.employee_id });
  const assignedToId = effectiveAssigned ? effectiveAssigned.userId : null;
  // Audit actor: the assigner is ALWAYS the authenticated session user.
  let assignedById = caller.id;
  if (!effectiveAssigned) assignedById = null;

  const reserved: Record<string, any> = {
    assignedTo: effectiveAssigned ? effectiveAssigned.employeeId || '' : '',
    assignedBy: effectiveAssigned ? caller.employee_id || '' : '',
    assignedDate: effectiveAssigned ? (lead.assignedDate || (preserveDates ? '' : new Date().toISOString())) : null,
    projectedNCP: lead.projectedNCP,
    sumAssured: lead.sumAssured,
    collectedNCP: lead.collectedNCP,
    lastFollowUpDate: lead.lastFollowUpDate || null,
    nextFollowUpDate: lead.nextFollowUpDate || null,
    nextCallDate: lead.nextCallDate || null,
    meetingDate: lead.meetingDate || null,
    meetingType: lead.meetingType || null,
    lossReason: lead.lossReason || null,
    followUpType: lead.followUpType || null,
    familyMember: lead.familyMember || null,
    noOfChildren: lead.noOfChildren || null,
    hasChild: lead.hasChild ?? null,
    residenceAddress: lead.residenceAddress || null,
    officeAddress: lead.officeAddress || null,
    otherInfo: lead.otherInfo || null,
    campaignName: lead.campaignName || null,
    productName: lead.productName || null,
    currentStatus: lead.currentStatus || null,
    thana: lead.thana || null,
  };

  const customFields: Record<string, any> = {};
  // Only allow non-authz keys from top-level payload
  for (const [key, value] of Object.entries(lead)) {
    if (LEAD_IGNORED_KEYS.has(key)) continue;
    if (FORBIDDEN_CUSTOM_KEYS.has(key)) continue;
    if (key.startsWith('_')) continue;
    if (value === undefined || value === null) continue;
    // Strip any nested authz attempt
    if (typeof value === 'object') continue; // keep customFields flat for security, but allow primitives
    customFields[key] = value;
  }
  // Merge sanitized customFields bag if provided
  if (lead.customFields && typeof lead.customFields === 'object') {
    const sanitized = sanitizeCustomFields(lead.customFields as any);
    for (const [k, v] of Object.entries(sanitized)) {
      if (v !== undefined && v !== null && v !== '') customFields[k] = v;
    }
  }
  // Reserved fields override (but with secure assignedTo/By)
  for (const [key, value] of Object.entries(reserved)) {
    if (value !== null && value !== undefined && value !== '') customFields[key] = value;
  }

  // Server-side audit/history handling: NEVER trust client-provided actor identity.
  // For any history entries supplied by client (e.g. during create), override actor to session user.
  // Legitimate historical records preserved from DB are handled separately in update paths
  // and are NOT rewritten here - only client-supplied arrays are sanitized.
  let assignmentHistory: unknown[] = Array.isArray(lead.assignmentHistory) ? [...lead.assignmentHistory] : [];
  assignmentHistory = assignmentHistory.map((entry: any) => {
    if (!entry || typeof entry !== 'object') return entry;
    // Always derive actor from authenticated session, ignore client value
    const { changedBy: _cb, updatedBy: _ub, createdBy: _crb, assignedBy: _ab, deletedBy: _db, ...rest } = entry as any;
    return {
      ...rest,
      changedBy: caller.employee_id,
      // Preserve other fields but ensure actor is session-derived
    };
  });

  let statusHistory: unknown[] = Array.isArray(lead.statusHistory) ? [...lead.statusHistory] : [];
  statusHistory = statusHistory.map((entry: any) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { updatedBy: _ub, changedBy: _cb, createdBy: _crb, assignedBy: _ab, deletedBy: _db, ...rest } = entry as any;
    return {
      ...rest,
      updatedBy: caller.employee_id,
    };
  });

  return {
    leadCode,
    customerName,
    mobile,
    alternateMobile: clean(lead.alternateMobile) || null,
    email: clean(lead.email) || null,
    maritalStatus: clean(lead.maritalStatus) || null,
    occupation: clean(lead.occupation || lead.profession) || null,
    address: clean(lead.address) || null,
    area: clean(lead.area) || null,
    district: clean(lead.district) || null,
    division: clean(lead.division) || null,
    source: clean(lead.source) || null,
    priority: clean(lead.priority || 'NORMAL').toUpperCase().slice(0, 30) || 'NORMAL',
    projectedNCP: numeric(lead.projectedNCP ?? lead.expectedPremium),
    sumAssured: numeric(lead.sumAssured ?? lead.expectedValue),
    collectedNCP: numeric(lead.collectedNCP),
    notes: lead.notes != null && lead.notes !== '' ? String(lead.notes) : null,
    assignedTo: assignedToId,
    assignedBy: assignedById,
    assignedAt: effectiveAssigned
      ? (preserveDates ? dateOrNull(lead.assignedDate) : (dateOrNull(lead.assignedDate) || new Date().toISOString()))
      : null,
    lastFollowUpDate: dateOrNull(lead.lastFollowUpDate || lead.lastContactedAt),
    nextFollowUpDate: dateOrNull(lead.nextFollowUpDate || lead.nextFollowUpAt),
    currentStatus: clean(lead.currentStatus).slice(0, 255) || (preserveDates ? '' : 'New'),
    statusHistory,
    assignmentHistory,
    documents: Array.isArray(lead.documents) ? lead.documents : [],
    tags: Array.isArray(lead.tags) ? lead.tags.map(String) : [],
    customFields,
    createdBy: caller.id,
    updatedBy: caller.id,
    // Historical Lead Date (created_at on INSERT; never overwritten on update)
    createdAt: dateOrNull(lead.leadDate || lead.creationDate),
    // Resolved Previously Assigned reference (uuid) when supplied by the import
    previousAssignedTo: asUuid(lead.previousAssignedTo) || asUuid(lead.previous_assigned_to),
  };
}

/** Legacy buildLeadRecord kept for internal use but now delegates to secure version where possible.
 *  For backward compat, it still exists but should NOT be used for authz-sensitive paths.
 */
async function buildLeadRecord(lead: any, resolveRefs = true): Promise<LeadRecord | { error: string }> {
  // This legacy function is kept but will be overridden by secure version in hardened paths.
  // It still respects FORBIDDEN keys removal.
  const customerName = clean(lead.customerName || lead.customer_name || lead.prospectName || lead.prospect_name);
  const mobile = clean(lead.mobile || lead.mobileNumber || lead.phone);
  if (!customerName || !mobile) {
    return { error: 'Customer name and mobile are required' };
  }
  const numeric = (v: any): number | null => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const leadCode = String(lead.leadCode || lead.lead_code || lead.id || createId('lead')).slice(0, 50);
  const assignedTo = clean(lead.assignedTo);
  const assignedBy = clean(lead.assignedBy);
  const assignedToId = resolveRefs && assignedTo ? await resolveUserId(assignedTo) : null;
  const assignedById = resolveRefs && assignedBy ? await resolveUserId(assignedBy) : null;

  const reserved: Record<string, any> = {
    assignedTo: assignedTo || '',
    assignedBy: assignedBy || '',
    assignedDate: lead.assignedDate || null,
    projectedNCP: lead.projectedNCP,
    sumAssured: lead.sumAssured,
    collectedNCP: lead.collectedNCP,
    lastFollowUpDate: lead.lastFollowUpDate || null,
    nextFollowUpDate: lead.nextFollowUpDate || null,
    nextCallDate: lead.nextCallDate || null,
    meetingDate: lead.meetingDate || null,
    meetingType: lead.meetingType || null,
    lossReason: lead.lossReason || null,
    followUpType: lead.followUpType || null,
    familyMember: lead.familyMember || null,
    noOfChildren: lead.noOfChildren || null,
    hasChild: lead.hasChild ?? null,
    residenceAddress: lead.residenceAddress || null,
    officeAddress: lead.officeAddress || null,
    otherInfo: lead.otherInfo || null,
    campaignName: lead.campaignName || null,
    productName: lead.productName || null,
    currentStatus: lead.currentStatus || null,
    thana: lead.thana || null,
  };
  const customFields: Record<string, any> = {};
  for (const [key, value] of Object.entries(lead)) {
    if (LEAD_IGNORED_KEYS.has(key)) continue;
    if (FORBIDDEN_CUSTOM_KEYS.has(key)) continue;
    if (key.startsWith('_')) continue;
    if (value === undefined || value === null) continue;
    customFields[key] = value;
  }
  for (const [key, value] of Object.entries(reserved)) {
    if (value !== null && value !== undefined && value !== '') customFields[key] = value;
  }
  if (lead.customFields && typeof lead.customFields === 'object') {
    const sanitized = sanitizeCustomFields(lead.customFields as any);
    for (const [key, value] of Object.entries(sanitized)) {
      if (value !== undefined && value !== null && value !== '') customFields[key] = value;
    }
  }

  return {
    leadCode,
    customerName,
    mobile,
    alternateMobile: clean(lead.alternateMobile) || null,
    email: clean(lead.email) || null,
    maritalStatus: clean(lead.maritalStatus) || null,
    occupation: clean(lead.occupation || lead.profession) || null,
    address: clean(lead.address) || null,
    area: clean(lead.area) || null,
    district: clean(lead.district) || null,
    division: clean(lead.division) || null,
    source: clean(lead.source) || null,
    priority: clean(lead.priority || 'NORMAL').toUpperCase().slice(0, 30) || 'NORMAL',
    projectedNCP: numeric(lead.projectedNCP ?? lead.expectedPremium),
    sumAssured: numeric(lead.sumAssured ?? lead.expectedValue),
    collectedNCP: numeric(lead.collectedNCP),
    notes: lead.notes != null && lead.notes !== '' ? String(lead.notes) : null,
    assignedTo: assignedToId,
    assignedBy: assignedById,
    assignedAt: dateOrNull(lead.assignedDate),
    lastFollowUpDate: dateOrNull(lead.lastFollowUpDate || lead.lastContactedAt),
    nextFollowUpDate: dateOrNull(lead.nextFollowUpDate || lead.nextFollowUpAt),
    currentStatus: clean(lead.currentStatus).slice(0, 255) || null,
    statusHistory: Array.isArray(lead.statusHistory) ? lead.statusHistory : [],
    assignmentHistory: Array.isArray(lead.assignmentHistory) ? lead.assignmentHistory : [],
    documents: Array.isArray(lead.documents) ? lead.documents : [],
    tags: Array.isArray(lead.tags) ? lead.tags.map(String) : [],
    customFields,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    previousAssignedTo: null,
  };
}

/* ------------------------------------------------------------------
   Lead Quality list helpers — server-computed compact scores attached
   to already-visible rows. Filtering/sorting by quality is a NARROWING
   operation applied AFTER visibility scoping; it can never widen scope.
------------------------------------------------------------------- */
const LEAD_QUALITY_BAND_FILTERS: LeadQualityBand[] = [
  'Hot', 'Warm', 'Developing', 'Cold', 'Converted', 'Not Interested',
];

function normalizeQualityBandFilter(raw: any): LeadQualityBand | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim().toLowerCase();
  // Accept canonical bands plus common casings ('hot', 'NOT INTERESTED').
  const match = LEAD_QUALITY_BAND_FILTERS.find(b => b.toLowerCase() === text);
  return match || null;
}

function applyQualityListOptions(
  leads: Array<Record<string, any>>,
  query: any
): Array<Record<string, any>> {
  const band = normalizeQualityBandFilter(query?.qualityBand ?? query?.quality);
  let out = band ? leads.filter(l => (l.leadQuality as any)?.band === band) : leads;
  const sort = String(query?.sort || '').trim().toLowerCase();
  if (sort === 'quality_desc' || sort === 'quality_asc') {
    const dir = sort === 'quality_desc' ? -1 : 1;
    out = [...out].sort((a, b) => {
      const sa = Number((a.leadQuality as any)?.score);
      const sb = Number((b.leadQuality as any)?.score);
      const va = Number.isFinite(sa) ? sa : -1;
      const vb = Number.isFinite(sb) ? sb : -1;
      if (va !== vb) return (va - vb) * dir;
      // Stable tiebreak: newest first (matches the default list order).
      const ta = new Date(a.timestamp || a.creationDate || 0).getTime();
      const tb = new Date(b.timestamp || b.creationDate || 0).getTime();
      return tb - ta;
    });
  }
  return out;
}

router.get('/leads', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    // Demo mode: still enforce visibility via fallbackStore
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    }
    const visibility = await resolveCallerVisibility(caller);
    // THE lead-access predicate (isLeadAccessible) — the same unified
    // rule the DB list enforces via buildDashboardVisibilitySql:
    // assignee in scope OR creator in scope. (This demo filter used to
    // check the assignee only, so creator-chain leads the DB list
    // shows were hidden here.)
    const scope = (list: any[]) => list.filter((l: any) =>
      isLeadAccessible(
        { assignedTo: (l as any).assignedTo, createdBy: (l as any).createdBy ?? null } as any,
        visibility,
        caller
      )
    );
    const visible = scope(fallbackStore.leads || []);
    // DZ-3: the stored Lead Quality config (code defaults when unset).
    const qualityConfig = await getLeadQualityConfig();
    const qualityById = compactQualityForFallbackLeads(
      visible,
      (fallbackStore as any).leadActivities || [],
      (fallbackStore as any).scheduledActivities || [],
      undefined,
      qualityConfig
    );
    const scored = visible.map((l: any) => ({ ...l, leadQuality: qualityById.get(String(l.id)) }));
    return sendJson(res, 200, applyQualityListOptions(scored, req.query || {}));
  }
  const perf = createPerf('leads.list');
  try {
    const pool = getPool();
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    // Permission check + visibility scope. Both derive from the caller and
    // are independent, so they overlap instead of costing two serial round
    // trips. The 403 is still returned before any row is read.
    const [canViewLeads, visibility] = await Promise.all([
      hasPermissionCode(caller, 'leads.view'),
      resolveCallerVisibility(caller),
    ]);
    perf.span('authz.permission');
    if (!canViewLeads) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }

    const params: any[] = [];
    const where: string[] = ['l.is_deleted = FALSE'];
    const { startDate, endDate, status, assignedTo, search } = req.query || {};
    if (startDate) { params.push(dateOrNull(String(startDate))); where.push(`l.created_at >= $${params.length}`); }
    if (endDate) { params.push(dateOrNull(String(endDate))); where.push(`l.created_at <= $${params.length}`); }
    if (status) { params.push(String(status)); where.push(`l.current_status = $${params.length}`); }
    if (assignedTo) {
      const assignedResolved = await resolveAssignedTo(String(assignedTo));
      const filterUserId = assignedResolved?.userId || String(assignedTo);
      params.push(filterUserId);
      // Resolved user ids (and canonical-lowercase UUID inputs) use a
      // sargable uuid comparison so idx_leads_assigned_to applies;
      // anything else keeps the legacy text comparison (no-match).
      where.push(isCanonicalLowerUuid(filterUserId)
        ? `l.assigned_to = $${params.length}::uuid`
        : `l.assigned_to::text = $${params.length}`);
    }
    if (search) {
      params.push(`%${String(search)}%`);
      where.push(`(l.customer_name ILIKE $${params.length} OR l.mobile ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.occupation ILIKE $${params.length})`);
    }
    perf.span('authz.visibility');
    // THE lead-visibility predicate — one shared definition
    // (buildDashboardVisibilitySql), identical to the follow-up queue,
    // the dashboard counts and the scheduled-activities list, and to
    // the row-level isLeadAccessible the detail endpoints enforce.
    where.push(buildDashboardVisibilitySql(visibility, params));
    // An explicit, smaller `limit` is honoured (the dashboard's "Recent
    // Leads" strip asks for 5 rows instead of the full max), while the
    // configured ceiling is always the hard cap — a caller can only ever
    // ask for FEWER rows than the deployment allows.
    const maxRows = resolveLeadsListMaxRows();
    const requested = Number(req.query?.limit);
    const listLimit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), maxRows)
      : maxRows;
    // F11: `offset` was silently ignored, so ?offset=5 returned the same rows
    // as ?offset=0 and any paging client silently re-read page 1. It is a
    // non-negative integer, clamped to the same ceiling as `limit` so a
    // hostile value cannot ask the database to walk the whole table.
    const rawOffset = Number(req.query?.offset);
    const listOffset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.min(Math.floor(rawOffset), LIST_OFFSET_CEILING)
      : 0;
    const result = await pool.query(
      `${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ${listLimit} OFFSET ${listOffset}`,
      params
    );
    perf.span('db.query');
    // Lead Quality: exactly two bulk signal queries for the whole page
    // (history aggregates + planned-action aggregates) — never per-lead.
    // Scoring runs in memory over rows the visibility scope already
    // allowed; the score itself grants no access.
    const ids = (result.rows || []).map((r: any) => String(r.id));
    const [activityMap, scheduledMap, qualityConfig] = await Promise.all([
      fetchActivityQualitySignals(pool, ids),
      fetchScheduledQualitySignals(pool, ids),
      // DZ-3: the stored Lead Quality config (code defaults when unset).
      getLeadQualityConfig(),
    ]);
    perf.span('db.qualitySignals');
    const scored = (result.rows || []).map((row: any) => {
      const mapped: any = mapLeadRow(row);
      mapped.leadQuality = compactScoreLeadRow(
        row,
        activityMap.get(String(row.id)),
        scheduledMap.get(String(row.id)),
        undefined,
        qualityConfig
      );
      return mapped;
    });
    perf.finish(res);
    // NOTE: the response stays a bare array — that is the client contract.
    return sendJson(res, 200, applyQualityListOptions(scored, req.query || {}));
  } catch (error: any) {
    perf.finish(res);
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead fetch failed' });
  }
});

/** Hard ceiling for ?offset= on the leads list (F11). */
const LIST_OFFSET_CEILING = 100000;

const LEAD_UPSERT_SQL = `
  INSERT INTO leads (
    lead_code, customer_name, mobile, alternate_mobile, email, marital_status, occupation,
    address, area, district, division, source, priority, expected_premium, expected_value,
    notes, assigned_to, assigned_by, assigned_at, last_contacted_at, next_follow_up_at,
    current_status, status_history, assignment_history, documents, custom_fields, tags,
    created_by, updated_by, created_at, updated_at, previous_assigned_to
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    $8, $9, $10, $11, $12, COALESCE(NULLIF($13, ''), 'NORMAL'), $14, $15, $16,
    $17, $18, $19, $20, $21,
    COALESCE(NULLIF($22, ''), 'New'),
    COALESCE($23::jsonb, '[]'::jsonb), COALESCE($24::jsonb, '[]'::jsonb),
    COALESCE($25::jsonb, '[]'::jsonb),
    COALESCE($26::jsonb, '{}'::jsonb), COALESCE($27::jsonb, '[]'::jsonb),
    $28, $29,
    COALESCE($30::timestamp, NOW()), NOW(), $31
  )
  ON CONFLICT (lead_code) DO UPDATE SET
    customer_name = EXCLUDED.customer_name,
    mobile = EXCLUDED.mobile,
    alternate_mobile = EXCLUDED.alternate_mobile,
    email = EXCLUDED.email,
    marital_status = EXCLUDED.marital_status,
    occupation = EXCLUDED.occupation,
    address = EXCLUDED.address,
    area = EXCLUDED.area,
    district = EXCLUDED.district,
    division = EXCLUDED.division,
    source = EXCLUDED.source,
    priority = EXCLUDED.priority,
    expected_premium = EXCLUDED.expected_premium,
    expected_value = EXCLUDED.expected_value,
    notes = EXCLUDED.notes,
    assigned_to = EXCLUDED.assigned_to,
    assigned_by = EXCLUDED.assigned_by,
    assigned_at = EXCLUDED.assigned_at,
    last_contacted_at = EXCLUDED.last_contacted_at,
    next_follow_up_at = EXCLUDED.next_follow_up_at,
    current_status = EXCLUDED.current_status,
    status_history = EXCLUDED.status_history,
    assignment_history = EXCLUDED.assignment_history,
    documents = EXCLUDED.documents,
    custom_fields = leads.custom_fields || EXCLUDED.custom_fields,
    tags = EXCLUDED.tags,
    previous_assigned_to = COALESCE($31::uuid, leads.previous_assigned_to),
    updated_by = EXCLUDED.updated_by,
    -- created_at is IMMUTABLE on conflict/update: the historical Lead Date
    -- is written on INSERT only (COALESCE($30, NOW()) in the VALUES above).
    -- A spreadsheet Lead Date must NEVER rewrite an existing lead's
    -- created_at (bulk import regression guard).
    created_at = leads.created_at,
    is_deleted = FALSE,
    deleted_at = NULL,
    updated_at = NOW()
  RETURNING *, (xmax = 0) AS _inserted`;

router.post('/leads', requireAuth, async (req: any, res) => {
  const perf = createPerf('lead.save');
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    const visibility = await resolveCallerVisibility(caller);
    perf.span('authz.visibility');
    const payload = req.body || {};

    // Determine if this is an update (existing lead) via lead_code or mobile
    let existingLead: any = null;
    // F12: an accidental duplicate is the silent case worth reporting. The
    // endpoint has always upserted on a matching mobile number (see
    // lead-authz-integration case 11 — a caller who owns the lead may upsert),
    // but it never told the caller that it MATCHED something, so an operator
    // adding the same prospect twice was told "Lead created successfully"
    // while the first record was being overwritten. We keep the upsert (that
    // is the documented contract) and report the match instead.
    let matchedBy: 'leadCode' | 'mobile' | null = null;
    const incomingLeadCode = String(payload.leadCode || payload.lead_code || payload.id || '').slice(0, 50).trim();
    const incomingMobile = clean(payload.mobile || payload.mobileNumber || payload.phone);

    if (useDb()) {
      const pool = getPool();
      if (incomingLeadCode) {
        const found = await pool.query(
          `SELECT * FROM leads WHERE (lead_code = $1 OR id = $2) AND is_deleted = FALSE LIMIT 1`,
          [incomingLeadCode, isCanonicalLowerUuid(incomingLeadCode) ? incomingLeadCode : null]
        );
        existingLead = found.rows[0] || null;
        if (existingLead) matchedBy = 'leadCode';
      }
      if (!existingLead && incomingMobile) {
        const foundMobile = await pool.query(
          `SELECT * FROM leads WHERE UPPER(mobile) = UPPER($1) AND is_deleted = FALSE LIMIT 1`,
          [incomingMobile]
        );
        existingLead = foundMobile.rows[0] || null;
        if (existingLead) matchedBy = 'mobile';
      }
    } else {
      // Demo mode lookup
      if (incomingLeadCode) {
        existingLead = fallbackStore.leads.find((l: any) => l.id === incomingLeadCode) || null;
        if (existingLead) matchedBy = 'leadCode';
      }
      if (!existingLead && incomingMobile) {
        existingLead = fallbackStore.leads.find((l: any) => String(l.mobile || '').toUpperCase() === incomingMobile.toUpperCase()) || null;
        if (existingLead) matchedBy = 'mobile';
      }
    }

    // Permission checks
    if (existingLead) {
      // Must have edit permission and access to existing lead
      if (!(await hasPermissionCode(caller, 'leads.edit'))) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to edit leads.' });
      }
      if (!isLeadAccessible(existingLead, visibility, caller)) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to update this lead. It is outside your authorized scope.' });
      }
    } else {
      if (!(await hasPermissionCode(caller, 'leads.create'))) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to create leads.' });
      }
    }

    // Resolve assignedTo target (prevent spoofing). For compatibility, the
    // client may send the existing lead shape on every update; the explicit
    // marker distinguishes an ownership action from a demographic edit.
    const preserveExistingAssignment = existingLead && payload._preserveAssignment === true;
    const assignmentRequested = !preserveExistingAssignment && Object.prototype.hasOwnProperty.call(payload, 'assignedTo');
    const existingLeadIsDbRow = Boolean(existingLead && Object.prototype.hasOwnProperty.call(existingLead, 'assigned_to'));
    let targetAssigned: { userId: string; employeeId: string } | null = null;
    if (assignmentRequested) {
      const requestedAssignee = clean(payload.assignedTo);
      if (requestedAssignee) {
        const resolved = await resolveAssignedTo(requestedAssignee);
        if (!resolved) {
          return sendJson(res, 400, { success: false, message: `Assigned user "${requestedAssignee}" not found.` });
        }
        if (!resolved.isActive) {
          // Mirror the bulk-import rule (an assignee must be an ACTIVE
          // user): a manual create / reassign / transfer may not route a
          // lead to a deactivated colleague. One exemption — re-saving a
          // lead whose CURRENT owner has since been deactivated, with the
          // payload still naming that same owner, performs no new
          // assignment and stays allowed; the deactivation flow owns
          // moving those leads to an active colleague.
          const currentOwnerKey = existingLead
            ? (existingLeadIsDbRow
              ? String(existingLead.assigned_to || '')
              : String(existingLead.assignedTo || '').toUpperCase())
            : '';
          const targetKey = existingLeadIsDbRow
            ? String(resolved.userId)
            : String(resolved.employeeId).toUpperCase();
          if (!existingLead || currentOwnerKey !== targetKey) {
            return sendJson(res, 400, { success: false, message: `Assigned user "${requestedAssignee}" is inactive and cannot be assigned leads.` });
          }
        }
        targetAssigned = resolved;
      } else {
        // An explicit blank is an authorized unassignment, not self-assignment.
        targetAssigned = null;
      }
    } else if (existingLead) {
      // Canonical assigned_to remains authoritative. Never promote stale
      // custom_fields.assignedTo data and never assign an unowned record to
      // the caller during a non-routing update.
      if (existingLead.assigned_to) {
        const empId = await managerEmployeeId(existingLead.assigned_to);
        targetAssigned = { userId: existingLead.assigned_to, employeeId: empId || String(existingLead.assigned_to) };
      } else if (!existingLeadIsDbRow && existingLead.assignedTo) {
        const resolved = await resolveAssignedTo(existingLead.assignedTo);
        targetAssigned = resolved || null;
      } else {
        targetAssigned = null;
      }
    } else {
      targetAssigned = { userId: caller.id, employeeId: caller.employee_id };
    }

    // Phase 3 auto-assignment (opt-in, default OFF — see
    // AutoAssignmentService): a brand-new lead with NO explicit assignee
    // would today default to the creator. When an admin has enabled the
    // switch, the least-loaded active member of the caller's assignment
    // scope receives it instead — by construction the same people a
    // manual assignment by this caller could target (the pool comes
    // from the caller's Data Visibility set). Explicit assignments and
    // updates of existing leads never reach this block; an empty pool
    // or the rule picking the creator keeps today's default untouched.
    let autoAssignPick: AutoAssignPick | null = null;
    const explicitAssigneeSupplied = assignmentRequested && clean(payload.assignedTo) !== '';
    if (!existingLead && !explicitAssigneeSupplied) {
      const pick = await resolveAutoAssignment(caller, visibility);
      if (pick && pick.userId !== caller.id && isAssignedToAllowed(pick, visibility, caller)) {
        autoAssignPick = pick;
        targetAssigned = { userId: pick.userId, employeeId: pick.employeeId };
      }
    }

    if (assignmentRequested && !isAssignedToAllowed(targetAssigned, visibility, caller)) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to assign leads to that user. Assignment is limited to your authorized scope.' });
    }

    // Normal assignment and unassignment require leads.assign. The
    // established PR #32 distinction is preserved for an existing owner
    // being moved to another owner: leads.transfer may authorize that
    // transfer as an alternative, but only after the same server-side
    // Data Visibility/assignment-scope check above succeeds.
    const existingAssignmentKey = existingLead
      ? (existingLead.assigned_to
        ? String(existingLead.assigned_to)
        : (!existingLeadIsDbRow ? String(existingLead.assignedTo || '') : ''))
      : '';
    const targetAssignmentKey = targetAssigned
      ? (existingLeadIsDbRow ? String(targetAssigned.userId) : String(targetAssigned.employeeId))
      : '';
    const assignmentChanged = Boolean(existingLead && existingAssignmentKey !== targetAssignmentKey);
    const createAssignmentToOther = Boolean(!existingLead && targetAssigned && targetAssigned.userId !== caller.id);
    const isExistingOwnerTransfer = Boolean(
      existingLead && assignmentRequested && assignmentChanged && existingAssignmentKey && targetAssignmentKey
    );
    if (assignmentRequested && (assignmentChanged || createAssignmentToOther)) {
      const [canAssign, canTransfer] = await Promise.all([
        hasPermissionCode(caller, 'leads.assign'),
        isExistingOwnerTransfer
          ? hasPermissionCode(caller, 'leads.transfer')
          : Promise.resolve(false),
      ]);
      const authorized = isExistingOwnerTransfer ? (canAssign || canTransfer) : canAssign;
      if (!authorized) {
        perf.span('authz.permissions');
        perf.finish(res);
        return sendJson(res, 403, { success: false, message: 'You do not have permission to assign, reassign, or transfer this lead.' });
      }
    }
    perf.span('authz.permissions');

    const record = await buildSecureLeadRecord(
      payload,
      caller,
      targetAssigned,
      { allowUnassigned: Boolean(existingLead && !targetAssigned) }
    );
    if ('error' in record) {
      return sendJson(res, 400, { success: false, message: record.error });
    }

    // For explicit routing actions, merge assignment history server-side.
    // This also records an explicit unassignment and removes any stale
    // custom-field owner shadow.
    if (existingLead && assignmentRequested && assignmentChanged) {
      const existingHistory = Array.isArray(existingLead.assignment_history) ? existingLead.assignment_history : [];
      const newEntry = {
        id: `assign_${Date.now()}`,
        fromEmployeeId: existingLead.assigned_to ? await managerEmployeeId(existingLead.assigned_to) || undefined : undefined,
        toEmployeeId: targetAssigned?.employeeId,
        changedBy: caller.employee_id,
        date: new Date().toISOString(),
        note: targetAssigned ? 'Reassigned via API' : 'Unassigned via API',
      };
      (record as any).assignmentHistory = [...existingHistory, newEntry];
      const nextCustomFields = { ...((record as any).customFields || {}) };
      delete nextCustomFields.assignedTo;
      delete nextCustomFields.assignedBy;
      delete nextCustomFields.assignedDate;
      if (targetAssigned) {
        nextCustomFields.assignedTo = targetAssigned.employeeId;
        nextCustomFields.assignedBy = caller.employee_id;
        nextCustomFields.assignedDate = new Date().toISOString();
      }
      (record as any).customFields = nextCustomFields;
    }

    // Auto-assigned creates carry the canonical assignment-history
    // entry naming the rule, so the routing decision is auditable from
    // the lead itself; the notification blocks below key off this
    // entry exactly like a manual assignment.
    if (autoAssignPick) {
      const autoEntry = buildAutoAssignHistoryEntry(
        autoAssignPick,
        caller.employee_id,
        `assign_auto_${Date.now()}`
      );
      (record as any).assignmentHistory = [
        ...(((record as any).assignmentHistory as any[]) || []),
        autoEntry,
      ];
    }

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      // Demo mode: ensure actor identity is always session-derived, never client payload
      // Preserve existing assignment history from stored lead if updating
      let finalAssignmentHistory = record.assignmentHistory;
      let finalStatusHistory = record.statusHistory;
      if (existingLead) {
        const existingAssignHist = Array.isArray((existingLead as any).assignmentHistory) ? (existingLead as any).assignmentHistory : (Array.isArray((existingLead as any).assignment_history) ? (existingLead as any).assignment_history : []);
        const existingStatusHist = Array.isArray((existingLead as any).statusHistory) ? (existingLead as any).statusHistory : (Array.isArray((existingLead as any).status_history) ? (existingLead as any).status_history : []);
        // If reassignment, we already merged in record above for DB path, but for demo we need to handle
        if (existingAssignHist.length > 0 && !(existingLead as any).assigned_to) {
          // Check if reassignment happened (target differs from existing assignedTo)
          const existingAssignedEmp = String((existingLead as any).assignedTo || '').toUpperCase();
          const newAssignedEmp = String(targetAssigned?.employeeId || '').toUpperCase();
          if (existingAssignedEmp && newAssignedEmp && existingAssignedEmp !== newAssignedEmp) {
            const newEntry = {
              id: `assign_${Date.now()}`,
              fromEmployeeId: existingAssignedEmp || undefined,
              toEmployeeId: targetAssigned?.employeeId,
              changedBy: caller.employee_id,
              date: new Date().toISOString(),
              note: 'Reassigned via API',
            };
            finalAssignmentHistory = [...existingAssignHist, newEntry];
          } else {
            // Preserve existing if not reassigning, but ensure no spoofed actor in preserved history? Keep legitimate history as is
            finalAssignmentHistory = existingAssignHist.length > 0 ? existingAssignHist : record.assignmentHistory;
            finalStatusHistory = existingStatusHist.length > 0 ? existingStatusHist : record.statusHistory;
          }
        }
      }
      const lead: any = {
        id: record.leadCode,
        prospectName: record.customerName,
        customerName: record.customerName,
        mobile: record.mobile,
        alternateMobile: record.alternateMobile,
        email: record.email,
        profession: record.occupation || 'Unknown',
        occupation: record.occupation || 'Unknown',
        area: record.area || 'Unknown',
        source: record.source || 'Unknown',
        currentStatus: record.currentStatus || 'New',
        projectedNCP: record.projectedNCP ?? 0,
        collectedNCP: record.collectedNCP ?? 0,
        assignedTo: targetAssigned?.employeeId || (existingLead ? '' : caller.employee_id),
        assignedBy: targetAssigned ? caller.employee_id : '',
        timestamp: new Date().toISOString(),
        customFields: record.customFields,
        assignmentHistory: finalAssignmentHistory,
        statusHistory: finalStatusHistory,
        // Explicitly ignore any client-supplied actor fields
        createdBy: (existingLead as any)?.createdBy || caller.id,
        updatedBy: caller.id,
      };
      const existingIndex = fallbackStore.leads.findIndex((item: any) => item.id === lead.id || String(item.mobile || '').toUpperCase() === String(lead.mobile || '').toUpperCase());
      if (existingIndex >= 0) fallbackStore.leads[existingIndex] = { ...fallbackStore.leads[existingIndex], ...lead };
      else fallbackStore.leads.push(lead);
      // Next-step calendar sync (demo mirror of the DB reconcile in
      // POST /leads; the demo lead object itself does not carry the
      // follow-up date, so the record's value wins when supplied).
      const storedLead: any = existingIndex >= 0 ? fallbackStore.leads[existingIndex] : lead;
      reconcileLeadNextStepCalendarDemo(fallbackStore as any, {
        lead: { ...storedLead, nextFollowUpDate: record.nextFollowUpDate ?? storedLead.nextFollowUpDate ?? null },
        actorId: caller.id,
        sourceKind: 'lead_save',
      });
      lead.leadQuality = scoreFallbackLead(
        lead,
        (fallbackStore as any).leadActivities || [],
        (fallbackStore as any).scheduledActivities || [],
        undefined,
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        await getLeadQualityConfig()
      );

      // Server-side notification for demo mode (replaces client fire-and-forget)
      const demoShouldNotify = Boolean(
        targetAssigned &&
        (assignmentChanged || createAssignmentToOther) &&
        targetAssigned.userId
      );
      if (demoShouldNotify) {
        const isDemoReassign = Boolean(existingLead && assignmentChanged && existingLead.assigned_to);
        const demoEventType = isDemoReassign ? 'lead-reassigned' : 'lead-assigned';
        const demoHistoryArr = Array.isArray(record.assignmentHistory) ? record.assignmentHistory : [];
        const demoLatestId = demoHistoryArr.length > 0
          ? (demoHistoryArr[demoHistoryArr.length - 1] as any).id
          : `assign_${lead.id}`;
        try {
          createAssignmentNotificationsDemo({
            leadId: String(lead.id),
            leadCode: String(record.leadCode || lead.id),
            prospectName: record.customerName || 'Unknown',
            assignedToUserId: targetAssigned!.userId,
            assignedToEmployeeId: targetAssigned!.employeeId,
            changedByEmployeeId: caller.employee_id,
            eventType: demoEventType,
            assignmentHistoryId: demoLatestId,
          });
        } catch (demoNotifErr) {
          console.warn('[leads/demo] Notification creation failed:', demoNotifErr);
        }
      }

      return sendJson(res, 200, { success: true, data: lead, matchedBy, autoAssigned: Boolean(autoAssignPick) });
    }

    // ── PostgreSQL path: transactional upsert + server-side notifications ──
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /* F12: when the request matched an EXISTING lead by mobile number, that
         match is the identity of the write — otherwise a second POST with the
         same phone silently inserted a second row (the upsert only conflicts
         on lead_code) while the permission checks had already treated the call
         as an edit of the matched lead. Honouring the match is what makes the
         "this record was updated" warning the operator sees true. An explicit
         incoming lead code still wins: the caller said which lead it means. */
      const explicitLeadCode = String(payload.leadCode || payload.lead_code || '').trim();
      const writeLeadCode = explicitLeadCode
        ? record.leadCode
        : (matchedBy === 'mobile' && existingLead
            ? String(existingLead.lead_code || existingLead.id || record.leadCode)
            : record.leadCode);
      const result = await client.query(LEAD_UPSERT_SQL, leadParams(record, writeLeadCode));
      perf.span('db.upsert');
      const row = result.rows[0];

      // Server-side notification generation for assignment/reassignment.
      // Runs in a SAVEPOINT inside the lead transaction so the
      // notification is durable when the lead state commits — but a
      // notification failure (e.g. missing table in test DB) does NOT
      // abort the lead save itself. The browser no longer needs to fire
      // a separate best-effort POST /notifications after the save.
      const shouldNotify = Boolean(
        targetAssigned &&
        (assignmentChanged || createAssignmentToOther) &&
        targetAssigned.userId
      );
      if (shouldNotify) {
        const isReassign = Boolean(existingLead && assignmentChanged && existingLead.assigned_to);
        const eventType = isReassign ? 'lead-reassigned' : 'lead-assigned';
        const assignmentHistoryArr: any[] = Array.isArray(record.assignmentHistory)
          ? record.assignmentHistory
          : [];
        const latestAssignmentId = assignmentHistoryArr.length > 0
          ? assignmentHistoryArr[assignmentHistoryArr.length - 1].id
          : `assign_${row.id}`;
        const prospectName = record.customerName || 'Unknown';
        // OPTION A — TRANSACTIONAL ATOMICITY: notification rows are part
        // of the same transaction as the lead upsert. If notification
        // persistence fails, the entire transaction (lead + history +
        // notifications) rolls back and the client receives failure.
        // No SAVEPOINT: notifications are required, not optional.
        await createAssignmentNotifications(client, {
          leadId: String(row.id),
          leadCode: String(row.lead_code || record.leadCode || ''),
          prospectName,
          assignedToUserId: targetAssigned!.userId,
          assignedToEmployeeId: targetAssigned!.employeeId,
          changedByEmployeeId: caller.employee_id,
          eventType,
          assignmentHistoryId: latestAssignmentId,
          excludeNotifyUserId: undefined,
        });
      }

      // Next-step calendar sync (PR A): the upsert may have set, moved
      // or cleared this lead's next_follow_up_at — mirror it onto the
      // Task Calendar inside the same transaction (see
      // services/NextStepCalendarSync.ts for the rules).
      await reconcileLeadNextStepCalendar(client, {
        leadId: String(row.id),
        actorId: caller.id,
        sourceKind: 'lead_save',
      });

      await client.query('COMMIT');
      perf.span('db.commit');

      // Machine-made routing decisions get an audit_logs entry on top
      // of the canonical assignment history (logAccessChange never
      // throws, and it runs only after the lead itself has committed).
      if (autoAssignPick) {
        await logAccessChange({
          actorId: caller.id,
          targetUserId: autoAssignPick.userId,
          actionCode: AUTO_ASSIGN_AUDIT_ACTION,
          entityType: 'lead',
          entityId: String(row.id),
          metadata: {
            rule: AUTO_ASSIGN_RULE,
            source: 'single_create',
            poolSize: autoAssignPick.poolSize,
            openLeadsAtPick: autoAssignPick.openLeads,
          },
        });
      }

      // One primary-key lookup for both joined employee ids (was two
      // sequential lookups on the response path).
      const employeeIds = await employeeIdsFor([row.assigned_to, row.assigned_by]);
      perf.span('db.responseJoins');
      const mappedLead: any = mapLeadRow({
        ...row,
        assigned_to_employee_id: employeeIds.get(String(row.assigned_to || '')) || null,
        assigned_by_employee_id: employeeIds.get(String(row.assigned_by || '')) || null,
      });
      // Fresh full quality for the saved row (two single-lead bulk-safe
      // queries) so in-place UI patches never carry a stale score.
      const [saveActivity, saveScheduled, saveQualityConfig] = await Promise.all([
        fetchActivityQualitySignals(pool, [String(row.id)]),
        fetchScheduledQualitySignals(pool, [String(row.id)]),
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        getLeadQualityConfig(),
      ]);
      mappedLead.leadQuality = scoreLeadRow(
        row,
        saveActivity.get(String(row.id)),
        saveScheduled.get(String(row.id)),
        undefined,
        saveQualityConfig
      );
      perf.span('db.qualitySignals');
      perf.finish(res);
      // `matchedBy === 'mobile'` means: this was NOT a new prospect, it was an
      // existing lead found by phone number, so the caller must not claim a
      // creation (F12).
      return sendJson(res, 200, { success: true, data: mappedLead, matchedBy, autoAssigned: Boolean(autoAssignPick) });
    } catch (error: any) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      perf.finish(res);
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead save failed' });
    } finally {
      try { client.release(); } catch { /* ignore */ }
    }
  } catch (error: any) {
    perf.finish(res);
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead save failed' });
  }
});

/* ====================================================================
   POST /leads/bulk — HARDENED BULK IMPORT (spreadsheet current-state)
   - Same single endpoint as before (no second import route).
   - Accepts BOTH the real spreadsheet headers (including "Assigned To",
     "Initial Status", "Follow up", "TAT", ...) AND the historical API
     payload shape — mapping lives in server/routes/leadImport.ts.
   - dryRun:true runs the FULL validation + duplicate-detection pipeline
     without writing anything. This powers the Bulk Upload preview and
     performs zero DB mutations.
   - Reference data (users, statuses, campaigns, existing leads,
     permissions) is resolved in bulk — no per-row N+1 queries.
   - Statuses are resolved against the canonical FollowUpStatus options;
     unknown statuses are row-level errors (never silently "New").
   - "Assigned To" must resolve to an ACTIVE users row via the canonical
     employee identifier (employee_id, e.g. "Monsoor_CTG"); a blank value
     leaves the lead unassigned (the schema allows it) instead of faking
     an assignment to the caller.
   - Row-level partial success inside ONE transaction with SAVEPOINTs;
     any hard failure rolls the whole import back and reports failure —
     success is never reported unless PostgreSQL committed.
   - Audit actors always derive from the authenticated session.
   - Phase 3: with the LeadAutoAssignment switch ON, blank-assignee
     rows that INSERT a new lead are auto-routed to the least-loaded
     active member of the importer's scope and counted in the
     response's `autoAssigned` field (see AutoAssignmentService).
==================================================================== */

interface PlannedImportRow {
  row: ImportRow;
  assigned: { userId: string; employeeId: string } | null;
  previousAssignedUserId: string | null;
  /** Resolved canonical status (latest known state) or '' when blank. */
  currentStatus: string;
  initialStatus: string;
  followUpStatus: string;
  tatValue: number | null;
  amountValue: number | null;
  customFields: Record<string, any>;
  fingerprint: string;
}

interface PlannedImportAction {
  planned: PlannedImportRow;
  action: 'insert' | 'update' | 'upsertByCode' | 'skip';
  existing: any | null;
  leadCode: string;
  batchDuplicateOf: number | null;
}

/** Build the lead payload for buildSecureLeadRecord from a validated row. */
function importRowPayload(p: PlannedImportRow): any {
  const row = p.row;
  const customFields: Record<string, any> = { ...p.customFields };
  if (row.tat !== '' && p.tatValue === null) customFields.tat = row.tat; // preserve non-numeric TAT as text
  if (row.interestedAmount !== '' && p.amountValue === null) customFields.interestedAmount = row.interestedAmount;
  return {
    leadCode: row.leadCode || '',
    prospectName: row.name,
    mobile: row.phone,
    email: row.email,
    area: row.area,
    source: row.source,
    productName: row.product,
    campaignName: row.campaign,
    otherInfo: row.otherInfo,
    notes: row.finalRemarks, // Final Remarks -> first-class notes column
    assignedDate: row.assignedDate || '',
    leadDate: row.leadDate || '',
    lastFollowUpDate: row.firstCallDate || '',
    nextFollowUpDate: row.followUpDate || '',
    currentStatus: p.currentStatus,
    projectedNCP: p.amountValue,
    previousAssignedTo: p.previousAssignedUserId || '',
    customFields,
  };
}

/**
 * Resolve a set of user references (employee_id / email / uuid) in ONE
 * query against the authoritative users table. The returned map is keyed
 * by UPPER(employee_id), UPPER(email) and raw uuid.
 */
export async function bulkResolveUserRefs(refs: string[]): Promise<Map<string, { userId: string; employeeId: string; isActive: boolean }>> {
  const map = new Map<string, { userId: string; employeeId: string; isActive: boolean }>();
  const values = Array.from(new Set(refs.map(r => String(r).trim()).filter(Boolean)));
  if (values.length === 0) return map;
  if (!useDb()) {
    for (const value of values) {
      const user = fallbackStore.users.find((u: any) =>
        u.id === value ||
        String(u.employeeId || '').toUpperCase() === value.toUpperCase() ||
        String(u.email || '').toLowerCase() === value.toLowerCase()
      );
      if (user) {
        const statusText = String((user as any).status ?? (user as any).employmentStatus ?? 'Active');
        const entry = { userId: user.id, employeeId: String(user.employeeId || ''), isActive: statusText.toLowerCase() !== 'inactive' };
        map.set(value.toUpperCase(), entry);
      }
    }
    return map;
  }
  const upper = values.map(v => v.toUpperCase());
  // Only canonical-lowercase UUIDs can match `users.id::text`; passing
  // exactly those as a uuid[] keeps this branch sargable AND result-
  // identical to the previous ::text comparison (see isCanonicalLowerUuid).
  const uuids = values.filter(isCanonicalLowerUuid);
  const result = await getPool().query(
    `SELECT id, employee_id, email, COALESCE(is_active, TRUE) AS is_active
     FROM users
     WHERE UPPER(employee_id) = ANY($1::text[])
        OR UPPER(email) = ANY($1::text[])
        OR ($2::uuid[] IS NOT NULL AND id = ANY($2::uuid[]))`,
    [upper, uuids.length ? uuids : null]
  );
  for (const row of result.rows) {
    const entry = { userId: String(row.id), employeeId: String(row.employee_id || ''), isActive: row.is_active === true };
    if (row.employee_id) map.set(String(row.employee_id).toUpperCase(), entry);
    if (row.email) map.set(String(row.email).toUpperCase(), entry);
    map.set(String(row.id), entry);
  }
  return map;
}

/**
 * Bulk-import UPDATE: the sheet is a current-state snapshot, so supplied
 * (non-blank) values overwrite and BLANK values preserve the existing
 * lead - a re-import must never wipe data because a cell was empty.
 */
const LEAD_BULK_UPDATE_SQL = `
  UPDATE leads SET
    customer_name = $2,
    alternate_mobile = COALESCE(NULLIF($3, ''), leads.alternate_mobile),
    email = COALESCE(NULLIF($4, ''), leads.email),
    marital_status = COALESCE(NULLIF($5, ''), leads.marital_status),
    occupation = COALESCE(NULLIF($6, ''), leads.occupation),
    address = COALESCE(NULLIF($7, ''), leads.address),
    area = COALESCE(NULLIF($8, ''), leads.area),
    district = COALESCE(NULLIF($9, ''), leads.district),
    division = COALESCE(NULLIF($10, ''), leads.division),
    source = COALESCE(NULLIF($11, ''), leads.source),
    priority = COALESCE(NULLIF($12, ''), leads.priority),
    expected_premium = COALESCE($13, leads.expected_premium),
    expected_value = COALESCE($14, leads.expected_value),
    notes = COALESCE(NULLIF($15, ''), leads.notes),
    assigned_to = COALESCE($16, leads.assigned_to),
    assigned_by = COALESCE($17, leads.assigned_by),
    assigned_at = COALESCE($18, leads.assigned_at),
    previous_assigned_to = COALESCE($19, leads.previous_assigned_to),
    last_contacted_at = COALESCE($20, leads.last_contacted_at),
    next_follow_up_at = COALESCE($21, leads.next_follow_up_at),
    current_status = COALESCE(NULLIF($22, ''), leads.current_status),
    assignment_history = CASE WHEN jsonb_array_length(COALESCE($23::jsonb, '[]'::jsonb)) > 0 THEN $23::jsonb ELSE leads.assignment_history END,
    status_history = CASE WHEN jsonb_array_length(COALESCE($24::jsonb, '[]'::jsonb)) > 0 THEN $24::jsonb ELSE leads.status_history END,
    documents = CASE WHEN jsonb_array_length(COALESCE($25::jsonb, '[]'::jsonb)) > 0 THEN $25::jsonb ELSE leads.documents END,
    tags = CASE WHEN jsonb_array_length(COALESCE($27::jsonb, '[]'::jsonb)) > 0 THEN $27::jsonb ELSE leads.tags END,
    custom_fields = leads.custom_fields || COALESCE($26::jsonb, '{}'::jsonb),
    updated_by = $28,
    is_deleted = FALSE,
    deleted_at = NULL,
    updated_at = NOW()
  WHERE id = $1
  RETURNING id`;

function bulkUpdateParams(record: LeadRecord, existingId: string): any[] {
  return [
    existingId,
    record.customerName,
    record.alternateMobile || '',
    record.email || '',
    record.maritalStatus || '',
    record.occupation || '',
    record.address || '',
    record.area || '',
    record.district || '',
    record.division || '',
    record.source || '',
    record.priority || '',
    record.projectedNCP,
    record.sumAssured,
    record.notes || '',
    record.assignedTo,
    record.assignedBy,
    record.assignedAt,
    record.previousAssignedTo,
    record.lastFollowUpDate,
    record.nextFollowUpDate,
    record.currentStatus,
    JSON.stringify(record.assignmentHistory || []),
    JSON.stringify(record.statusHistory || []),
    JSON.stringify(record.documents || []),
    JSON.stringify(record.customFields || {}),
    JSON.stringify(record.tags || []),
    record.updatedBy,
  ];
}

router.post('/leads/bulk', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  const body: any = Array.isArray(req.body) ? { leads: req.body } : (req.body || {});
  const incoming: any[] = Array.isArray(body.leads) ? body.leads : Array.isArray(req.body) ? req.body : [];
  const dryRun = body.dryRun === true;
  if (incoming.length === 0) {
    return sendJson(res, 400, { success: false, message: 'No leads supplied for bulk import.' });
  }
  // DZ-2 (audit §4, G1): the row cap is a real Settings value now,
  // read at request time (ceiling 5000 = the old hardcoded value).
  const maxRows = await getLeadBulkImportMaxRows();
  if (incoming.length > maxRows) {
    return sendJson(res, 413, { success: false, message: `Bulk import is limited to ${maxRows} rows per request.` });
  }

  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    }
    const visibility = await resolveCallerVisibility(caller);

    // Permission checks: fetched ONCE for the whole request (never per row)
    // and in ONE parallel batch — the five codes are independent, so this is
    // one round trip of latency instead of five sequential ones.
    const [canImport, canCreate, canEdit, canAssign, canTransfer] = await Promise.all([
      hasPermissionCode(caller, 'leads.import'),
      hasPermissionCode(caller, 'leads.create'),
      hasPermissionCode(caller, 'leads.edit'),
      hasPermissionCode(caller, 'leads.assign'),
      hasPermissionCode(caller, 'leads.transfer'),
    ]);
    if (!canImport && !canCreate) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to bulk import leads.' });
    }

    /* ---- 1. Map rows (real spreadsheet headers + legacy API shape) ---- */
    const rows: ImportRow[] = incoming.map((raw, index) =>
      mapSpreadsheetRow(raw && typeof raw === 'object' ? raw : {}, index)
    );

    /* ---- 2. Reference data in bulk (no per-row queries) ---- */
    let userMap: Map<string, { userId: string; employeeId: string; isActive: boolean }>;
    try {
      userMap = await bulkResolveUserRefs([
        ...rows.map(r => r.assignedTo),
        ...rows.map(r => r.previouslyAssigned),
      ]);
    } catch (error: any) {
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not resolve assigned users.' });
    }

    // Canonical status dictionary = active FollowUpStatus options. When the
    // options table is not migrated/configured yet, fall back to the app's
    // documented built-in status list (the same defaults the UI uses) so
    // imports still resolve against a well-known taxonomy.
    let statusList: string[] = [];
    if (useDb()) {
      try {
        const statusRes = await getPool().query(
          `SELECT option_value FROM options WHERE field_key = 'FollowUpStatus' AND COALESCE(is_active, TRUE) = TRUE`
        );
        statusList = statusRes.rows.map((r: any) => String(r.option_value));
      } catch {
        statusList = [];
      }
    } else {
      statusList = fallbackStore.options
        .filter((o: any) => o.type === 'FollowUpStatus' && o.status !== 'Inactive')
        .map((o: any) => String(o.value));
    }
    if (statusList.length === 0) statusList = DEFAULT_STATUS_DICTIONARY;

    // Existing Campaign option values (for deterministic registration).
    const existingCampaigns = new Set<string>();
    if (useDb()) {
      try {
        const campRes = await getPool().query(`SELECT option_value FROM options WHERE field_key = 'Campaign'`);
        campRes.rows.forEach((r: any) => existingCampaigns.add(String(r.option_value).toLowerCase()));
      } catch {
        // options table not migrated - treat as empty (see registration below)
      }
    } else {
      fallbackStore.options
        .filter((o: any) => o.type === 'Campaign')
        .forEach((o: any) => existingCampaigns.add(String(o.value).toLowerCase()));
    }

    /* ---- 3. Validate every row (pure, no writes) ---- */
    const errors: Array<{ index: number; message: string }> = [];
    const warnings: Array<{ index: number; message: string }> = [];
    const planned: PlannedImportRow[] = [];

    for (const row of rows) {
      const rowErrors: string[] = [...row.issues];
      const rowWarnings: string[] = [];

      // Assignee resolution against the authoritative users data.
      let assigned: { userId: string; employeeId: string } | null = null;
      if (row.assignedTo) {
        const entry = userMap.get(row.assignedTo.toUpperCase()) || userMap.get(row.assignedTo);
        if (!entry || !entry.isActive) {
          rowErrors.push(`Assigned To "${row.assignedTo}" does not match an active user`);
        } else {
          assigned = { userId: entry.userId, employeeId: entry.employeeId };
        }
      }
      // A blank "Assigned To" stays blank: unassigned lead (schema allows
      // it) - never a fake assignment to the importing user.

      // Assignment authorization is finalized after duplicate/existing-lead
      // planning below: a transfer of an existing owner may use
      // leads.transfer, while new assignment still requires leads.assign.
      if (assigned && !isAssignedToAllowed(assigned, visibility, caller)) {
        rowErrors.push(`Cannot assign to "${row.assignedTo}" - outside your authorized scope`);
      }

      // Previously Assigned: informational. Link when resolvable, always
      // preserve the sheet text; never invalidate the row over it.
      let previousAssignedUserId: string | null = null;
      if (row.previouslyAssigned) {
        const entry = userMap.get(row.previouslyAssigned.toUpperCase()) || userMap.get(row.previouslyAssigned);
        if (entry) {
          previousAssignedUserId = entry.userId;
          if (!entry.isActive) rowWarnings.push(`Previously Assigned "${row.previouslyAssigned}" is inactive; linked for reference`);
        } else {
          rowWarnings.push(`Previously Assigned "${row.previouslyAssigned}" does not match a user; preserved as text`);
        }
      }

      // Status resolution against the canonical dictionary (+ the
      // centralized legacy alias table from leadImport.ts — the exact same
      // rules the client preview uses). Unknown statuses are ERRORS - never
      // silently replaced by "New".
      let initialStatus = '';
      if (row.initialStatus) {
        const resolved = resolveImportStatus(row.initialStatus, statusList);
        if (!resolved.ok) rowErrors.push(`Initial Status "${row.initialStatus}" is not a valid status`);
        else initialStatus = resolved.status;
      }
      let followUpStatus = '';
      if (row.followUp) {
        const resolved = resolveImportStatus(row.followUp, statusList);
        if (!resolved.ok) rowErrors.push(`Follow up "${row.followUp}" is not a valid status`);
        else followUpStatus = resolved.status;
      }
      // Legacy API-shaped rows carry the status in currentStatus - resolve
      // it against the same dictionary (never accepted blindly).
      let legacyStatus = '';
      if (!initialStatus && !followUpStatus && row.currentStatus) {
        const resolved = resolveImportStatus(row.currentStatus, statusList);
        if (!resolved.ok) rowErrors.push(`Current Status "${row.currentStatus}" is not a valid status`);
        else legacyStatus = resolved.status;
      }
      const currentStatus = followUpStatus || initialStatus || legacyStatus; // latest known state wins

      const tatValue = parseTat(row.tat);
      const amountValue = parseAmount(row.interestedAmount);

      if (rowErrors.length === 0) {
        const customFields: Record<string, any> = {};
        if (initialStatus) customFields.initialStatus = initialStatus;
        if (followUpStatus) customFields.followUpStatus = followUpStatus;
        // PR #13 contract: custom_fields.initialStatus / followUpStatus hold
        // the RESOLVED canonical value; the raw spreadsheet text is kept
        // alongside so a legacy alias ("Unreachable", "Follow up") never
        // loses its original wording. current_status only ever receives the
        // resolved canonical status.
        if (row.initialStatus) customFields.initialStatusRaw = row.initialStatus;
        if (row.followUp) customFields.followUpStatusRaw = row.followUp;
        if (row.initialRemarks) customFields.initialRemarks = row.initialRemarks;
        if (row.previouslyAssigned) customFields.previouslyAssigned = row.previouslyAssigned;
        if (row.tat !== '' && tatValue !== null) customFields.tat = tatValue;
        planned.push({
          row,
          assigned,
          previousAssignedUserId,
          currentStatus,
          initialStatus,
          followUpStatus,
          tatValue,
          amountValue,
          customFields,
          fingerprint: rowFingerprint(row, assigned ? assigned.employeeId : ''),
        });
      } else {
        for (const message of rowErrors) errors.push({ index: row.index, message });
        for (const message of rowWarnings) warnings.push({ index: row.index, message });
      }
    }

    /* ---- 4. Existing-lead lookup (one query) + duplicate planning ---- */
    const codeCandidates = Array.from(new Set(planned.map(p => p.row.leadCode).filter(Boolean)));
    const phoneCandidates = Array.from(new Set(planned.map(p => normalizePhoneKey(p.row.phone)).filter(Boolean)));
    const emailCandidates = Array.from(new Set(planned.map(p => p.row.email.toLowerCase()).filter(Boolean)));

      let codeMap = new Map<string, any>();
    let phoneMap = new Map<string, any[]>();
    let emailMap = new Map<string, any[]>();
    if (useDb()) {
      const existingRes = await getPool().query(
        `SELECT l.id, l.lead_code, l.mobile, l.email, l.assigned_to, l.current_status,
                l.custom_fields, l.created_by, l.assignment_history,
                au.employee_id AS assigned_employee_id
         FROM leads l
         LEFT JOIN users au ON au.id = l.assigned_to
         LEFT JOIN LATERAL (SELECT REGEXP_REPLACE(COALESCE(l.mobile, ''), '[^0-9]', '', 'g') AS d) ph ON TRUE
         WHERE l.is_deleted = FALSE
           AND (
             ($1::text[] IS NOT NULL AND l.lead_code = ANY($1::text[]))
             OR ($2::text[] IS NOT NULL AND
                 -- mirrors normalizePhoneKey(): strip 880 country code and
                 -- leading 0 so 01711001122 / 8801711001122 / 1711001122 match
                 CASE
                   WHEN LENGTH(ph.d) IN (13, 14) AND LEFT(ph.d, 3) = '880' THEN SUBSTRING(ph.d FROM 4)
                   WHEN LENGTH(ph.d) = 11 AND LEFT(ph.d, 1) = '0' THEN SUBSTRING(ph.d FROM 2)
                   ELSE ph.d
                 END = ANY($2::text[]))
             OR ($3::text[] IS NOT NULL AND UPPER(l.email) = ANY($3::text[]))
           )`,
        [
          codeCandidates.length ? codeCandidates : null,
          phoneCandidates.length ? phoneCandidates : null,
          emailCandidates.length ? emailCandidates.map(e => e.toUpperCase()) : null,
        ]
      );
      for (const lead of existingRes.rows) {
        if (lead.lead_code) codeMap.set(String(lead.lead_code), lead);
        const pkey = normalizePhoneKey(lead.mobile);
        if (pkey) {
          const list = phoneMap.get(pkey) || [];
          list.push(lead);
          phoneMap.set(pkey, list);
        }
        if (lead.email) {
          const ekey = String(lead.email).toLowerCase();
          const list = emailMap.get(ekey) || [];
          list.push(lead);
          emailMap.set(ekey, list);
        }
      }
    } else {
      for (const lead of fallbackStore.leads) {
        if (lead.id || lead.leadCode) codeMap.set(String(lead.id || lead.leadCode), lead);
        const pkey = normalizePhoneKey(lead.mobile);
        if (pkey) {
          const list = phoneMap.get(pkey) || [];
          list.push(lead);
          phoneMap.set(pkey, list);
        }
        if (lead.email) {
          const ekey = String(lead.email).toLowerCase();
          const list = emailMap.get(ekey) || [];
          list.push(lead);
          emailMap.set(ekey, list);
        }
      }
    }

    const actions: PlannedImportAction[] = [];
    const batchByPhone = new Map<string, number>(); // normalized phone -> index in actions[]

    const planErrorsFor = (p: PlannedImportRow, existing: any | null): string | null => {
      // New assigned records and ordinary assignment require leads.assign.
      if (!existing) {
        return p.assigned && !canAssign
          ? 'Assigning an imported lead requires the leads.assign permission'
          : null;
      }
      if (!isLeadAccessible(existing, visibility, caller)) {
        return 'Existing lead with this phone/email is outside your authorized scope';
      }
      if (!canEdit) return 'No permission to edit existing leads';

      const existingOwner = existing.assigned_to ? String(existing.assigned_to) : '';
      const targetOwner = p.assigned ? String(p.assigned.userId) : '';
      const ownershipChanged = existingOwner !== targetOwner;
      if (ownershipChanged) {
        const isOwnerTransfer = Boolean(existingOwner && targetOwner);
        const authorized = isOwnerTransfer ? (canAssign || canTransfer) : canAssign;
        if (!authorized) {
          return isOwnerTransfer
            ? 'Reassigning an existing lead requires leads.assign or leads.transfer'
            : 'Assigning or unassigning an existing lead requires the leads.assign permission';
        }
      }
      return null;
    };

    for (const p of planned) {
      const pkey = normalizePhoneKey(p.row.phone);
      const priorActionIdx = batchByPhone.get(pkey);

      if (priorActionIdx !== undefined) {
        // Duplicate within the same upload - deterministic handling.
        const prior = actions[priorActionIdx];
        if (prior.planned.fingerprint === p.fingerprint) {
          actions.push({ planned: p, action: 'skip', existing: null, leadCode: '', batchDuplicateOf: prior.planned.row.index });
          warnings.push({ index: p.row.index, message: `Exact duplicate of sheet row ${prior.planned.row.index + 1}; skipped` });
        } else {
          // Different content: deterministic last-wins update of the lead
          // the earlier row targets.
          const conflictError = planErrorsFor(p, prior.existing);
          if (conflictError) {
            errors.push({ index: p.row.index, message: conflictError });
            continue;
          }
          warnings.push({ index: p.row.index, message: `Same phone as sheet row ${prior.planned.row.index + 1} with different data; this row wins` });
          actions.push({
            planned: p,
            action: 'upsertByCode',
            existing: prior.existing,
            leadCode: prior.leadCode || importLeadCode(p.row.phone),
            batchDuplicateOf: prior.planned.row.index,
          });
        }
        batchByPhone.set(pkey, actions.length - 1);
        continue;
      }

      // Match against existing leads: lead_code first, then normalized
      // phone, then email as an additional candidate. Ambiguities fail
      // the row instead of silently overwriting the wrong lead.
      let existing: any | null = null;
      let matchError: string | null = null;
      if (p.row.leadCode && codeMap.has(p.row.leadCode)) {
        existing = codeMap.get(p.row.leadCode);
      }
      if (!existing) {
        const phoneMatches = phoneMap.get(pkey) || [];
        if (phoneMatches.length > 1) {
          matchError = `Phone matches ${phoneMatches.length} existing leads - ambiguous, not imported`;
        } else if (phoneMatches.length === 1) {
          existing = phoneMatches[0];
        }
      }
      if (!matchError && p.row.email) {
        const emailMatches = emailMap.get(p.row.email.toLowerCase()) || [];
        if (emailMatches.length > 1) {
          matchError = `Email matches ${emailMatches.length} existing leads - ambiguous, not imported`;
        } else if (emailMatches.length === 1) {
          if (existing && String(existing.id) !== String(emailMatches[0].id)) {
            matchError = 'Phone and email match two different existing leads - ambiguous, not imported';
          } else if (!existing) {
            existing = emailMatches[0];
          }
        }
      }

      if (matchError) {
        errors.push({ index: p.row.index, message: matchError });
        continue;
      }

      if (existing) {
        const conflictError = planErrorsFor(p, existing);
        if (conflictError) {
          errors.push({ index: p.row.index, message: conflictError });
          continue;
        }
        actions.push({ planned: p, action: 'update', existing, leadCode: String(existing.lead_code || ''), batchDuplicateOf: null });
      } else {
        actions.push({ planned: p, action: 'insert', existing: null, leadCode: p.row.leadCode || importLeadCode(p.row.phone), batchDuplicateOf: null });
      }
      batchByPhone.set(pkey, actions.length - 1);
    }

    const summarize = (extra: Record<string, any> = {}) => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const action of actions) {
        if (action.action === 'insert') inserted++;
        else if (action.action === 'skip') skipped++;
        else if (action.action === 'update' || action.action === 'upsertByCode') updated++;
      }
      const failed = rows.length - inserted - updated - skipped;
      return { inserted, updated, skipped, failed, total: rows.length, errors, warnings, ...extra };
    };

    /* ---- 5. Dry run: report the plan without writing anything ---- */
    if (dryRun) {
      return sendJson(res, 200, { success: true, data: summarize({ dryRun: true, autoAssigned: 0 }) });
    }

    /* ---- 6. Commit ---- */
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      // Dev-demo in-memory mode: same planning, non-persistent store. Never
      // active in production and never reported as a DB success.
      // Phase 3 auto-assignment mirrors the DB path: blank-assignee
      // INSERT rows are routed by the same rule when the switch is on,
      // with loads advanced in memory so the batch distributes.
      const demoAutoCandidates = (await isAutoAssignmentEnabled())
        ? buildDemoAutoAssignCandidates(visibility.all ? null : visibility.userIds)
        : [];
      let demoAutoAssigned = 0;
      for (const action of actions) {
        const p = action.planned;
        if (action.action === 'skip') continue;
        let rowAutoPick: AutoAssignPick | null = null;
        try {
          let effectivePlanned = p;
          if (!p.assigned && action.action === 'insert' && demoAutoCandidates.length > 0) {
            const candidate = pickAutoAssignee(demoAutoCandidates);
            if (candidate) {
              rowAutoPick = { ...candidate, poolSize: demoAutoCandidates.length };
              effectivePlanned = { ...p, assigned: { userId: candidate.userId, employeeId: candidate.employeeId } };
            }
          }
          const record = buildDemoImportRecord(effectivePlanned, caller);
          if (rowAutoPick) {
            record.assignmentHistory = [
              buildAutoAssignHistoryEntry(rowAutoPick, caller.employee_id, `assign_auto_${Date.now()}_${p.row.index}`),
            ];
          }
          if (action.action === 'insert') {
            fallbackStore.leads.push(record);
          } else if (action.existing) {
            Object.assign(action.existing, record, { id: (action.existing as any).id });
          } else {
            const idx = fallbackStore.leads.findIndex((l: any) => String(l.id) === String(action.leadCode));
            if (idx >= 0) fallbackStore.leads[idx] = { ...fallbackStore.leads[idx], ...record };
            else fallbackStore.leads.push(record);
          }
          if (rowAutoPick) {
            demoAutoAssigned++;
            const chosen = demoAutoCandidates.find(c => c.userId === rowAutoPick!.userId);
            if (chosen) {
              chosen.openLeads += 1;
              chosen.lastAssignedAt = new Date().toISOString();
            }
          }
        } catch (err: any) {
          errors.push({ index: p.row.index, message: err?.message || 'Row failed (demo mode)' });
        }
      }
      return sendJson(res, 200, { success: true, data: summarize({ autoAssigned: demoAutoAssigned }) });
    }

    // Phase 3 auto-assignment (opt-in, default OFF): rows with a
    // blank "Assigned To" that INSERT a new lead are routed to the
    // least-loaded active member of the importer's assignment scope.
    // Pool loads are read once here and advanced in memory per pick,
    // so one import distributes its rows across the team in row order.
    // UPDATE rows keep the bulk contract — a blank cell preserves the
    // existing owner, never re-routes.
    // NOTE: the flag read + candidate load MUST stay before BEGIN.
    // They are advisory reads that fail closed (flag OFF / empty pool)
    // when their tables are missing — but on a single-connection
    // backend (PGlite) even a swallowed query error would abort the
    // import transaction if it ran inside it.
    const autoCandidates = (await isAutoAssignmentEnabled())
      ? await loadAutoAssignCandidates(getPool(), visibility.all ? null : visibility.userIds)
      : [];
    let autoAssignedCount = 0;
    const autoAssignedLeadCodes: string[] = [];

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deterministic campaign auto-registration AFTER validation, inside
      // the same transaction: no duplicate options, and no side effects if
      // the import rolls back.
      const newCampaigns = Array.from(new Set(planned.map(p => p.row.campaign).filter(Boolean)))
        .filter(c => !existingCampaigns.has(c.toLowerCase()));
      let campaignsRegistered = 0;
      if (newCampaigns.length > 0) {
        try {
          const campRes = await client.query(
            `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
             SELECT 'Campaign', c, c,
                    COALESCE((SELECT MAX(sort_order) FROM options WHERE field_key = 'Campaign'), 0) + ROW_NUMBER() OVER (ORDER BY c),
                    FALSE, TRUE, '{}'::jsonb, NOW(), NOW()
             FROM unnest($1::text[]) AS c
             ON CONFLICT (field_key, option_value) DO NOTHING`,
            [newCampaigns]
          );
          campaignsRegistered = campRes.rowCount ?? 0;
        } catch (campErr: any) {
          // Campaign registration is an option-list side effect; the lead
          // data itself is unaffected. Surface it instead of failing rows.
          warnings.push({ index: -1, message: `Campaign auto-registration skipped: ${campErr?.message || 'options table unavailable'}` });
        }
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const action of actions) {
        const p = action.planned;
        if (action.action === 'skip') { skipped++; continue; }
        let rowAutoPick: AutoAssignPick | null = null;
        try {
          await client.query('SAVEPOINT bulk_row');
          // Auto-assignment applies to NEW leads only (insert, or the
          // batch-internal upsert that creates the lead): an explicit
          // "Assigned To" is never overridden, and existing leads keep
          // their owner (the update path below preserves blanks).
          let rowAssigned = p.assigned;
          if (!p.assigned && action.action !== 'update' && autoCandidates.length > 0) {
            const candidate = pickAutoAssignee(autoCandidates);
            if (candidate) {
              rowAutoPick = { ...candidate, poolSize: autoCandidates.length };
              rowAssigned = { userId: candidate.userId, employeeId: candidate.employeeId };
            }
          }
          const record = await buildSecureLeadRecord(
            importRowPayload(p),
            caller,
            rowAssigned,
            { allowUnassigned: true, preserveSuppliedDates: true }
          );
          if ('error' in record) throw new Error(record.error);
          if (rowAutoPick) {
            (record as any).assignmentHistory = [
              ...(((record as any).assignmentHistory as any[]) || []),
              buildAutoAssignHistoryEntry(rowAutoPick, caller.employee_id, `assign_auto_${Date.now()}_${p.row.index}`),
            ];
          }

          // Server-side assignment history merge when reassigning an
          // existing lead (actor = authenticated caller).
          // Source of truth is the CANONICAL leads.assignment_history column -
          // never the custom_fields bag (which must not silently shadow it).
          if ((action.action === 'update' || action.action === 'upsertByCode') && action.existing) {
            const existing = action.existing;
            if (existing.assigned_to && p.assigned && String(existing.assigned_to) !== String(p.assigned.userId)) {
              // Canonical DB column first; camelCase fallback only for the
              // dev-demo in-memory store shape (never present in PG rows).
              const existingHistory = Array.isArray(existing.assignment_history)
                ? existing.assignment_history
                : (Array.isArray((existing as any).assignmentHistory) ? (existing as any).assignmentHistory : []);
              const fromEmployeeId = existing.assigned_employee_id || existing.custom_fields?.assignedTo || undefined;
              (record as any).assignmentHistory = [
                ...existingHistory,
                {
                  id: `assign_${Date.now()}_${p.row.index}`,
                  fromEmployeeId,
                  toEmployeeId: p.assigned.employeeId,
                  changedBy: caller.employee_id,
                  date: new Date().toISOString(),
                  note: 'Reassigned via bulk import',
                },
              ];
              (record as any).customFields = {
                ...(record as any).customFields,
                assignedTo: p.assigned.employeeId,
                assignedBy: caller.employee_id,
                assignedDate: new Date().toISOString(),
              };
            }
          }

          let writtenLeadId: string | null = action.action === 'update' ? String(action.existing.id) : null;
          if (action.action === 'insert') {
            const ins = await client.query(LEAD_UPSERT_SQL, leadParams(record, action.leadCode));
            if (!ins.rows[0]) throw new Error('Insert did not return a row');
            writtenLeadId = String(ins.rows[0].id);
            // xmax=0 means the row was truly inserted; a conflict-triggered
            // update (e.g. soft-deleted lead resurrected) counts as updated.
            if (ins.rows[0]._inserted === false) updated++;
            else inserted++;
          } else if (action.action === 'update') {
            const upd = await client.query(LEAD_BULK_UPDATE_SQL, bulkUpdateParams(record, String(action.existing.id)));
            if ((upd.rowCount ?? 0) > 0) updated++;
            else throw new Error('Existing lead no longer exists');
          } else { // upsertByCode - duplicate within the same upload
            const ups = await client.query(LEAD_UPSERT_SQL, leadParams(record, action.leadCode));
            if (!ups.rows[0]) throw new Error('Upsert did not return a row');
            writtenLeadId = String(ups.rows[0].id);
            if (ups.rows[0]._inserted === false) updated++;
            else inserted++;
          }
          // Next-step calendar sync (PR A): only a row whose sheet
          // actually supplied a follow-up date can change the lead's
          // next-step commitment (the bulk UPDATE preserves blanks via
          // COALESCE; the upsert writes the record's value), so only
          // those rows reconcile the lead's calendar entry — inside
          // this row's savepoint, like every other row effect.
          if (writtenLeadId && record.nextFollowUpDate) {
            await reconcileLeadNextStepCalendar(client, {
              leadId: writtenLeadId,
              actorId: caller.id,
              sourceKind: 'bulk_import',
            });
          }
          if (rowAutoPick) {
            autoAssignedCount++;
            autoAssignedLeadCodes.push(action.leadCode);
            const chosen = autoCandidates.find(c => c.userId === rowAutoPick!.userId);
            if (chosen) {
              chosen.openLeads += 1;
              chosen.lastAssignedAt = new Date().toISOString();
            }
          }
          await client.query('RELEASE SAVEPOINT bulk_row');
        } catch (rowErr: any) {
          try { await client.query('ROLLBACK TO SAVEPOINT bulk_row'); } catch {}
          errors.push({ index: p.row.index, message: rowErr?.message || 'Row failed' });
        }
      }

      await client.query('COMMIT');
      // One audit_logs entry per import that auto-assigned (written
      // only after the import committed, so it can never claim
      // assignments a rollback discarded); each affected lead also
      // carries its own canonical assignment-history entry.
      if (autoAssignedCount > 0) {
        await logAccessChange({
          actorId: caller.id,
          targetUserId: null,
          actionCode: AUTO_ASSIGN_AUDIT_ACTION,
          entityType: 'lead_import',
          entityId: null,
          metadata: {
            rule: AUTO_ASSIGN_RULE,
            source: 'bulk_import',
            autoAssigned: autoAssignedCount,
            leadCodes: autoAssignedLeadCodes.slice(0, AUDIT_CHANGE_CAP),
            truncated: autoAssignedLeadCodes.length > AUDIT_CHANGE_CAP,
          },
        });
      }
      const failed = rows.length - inserted - updated - skipped;
      return sendJson(res, 200, {
        success: true,
        data: {
          inserted,
          updated,
          skipped,
          failed,
          total: rows.length,
          errors,
          warnings,
          campaignsRegistered,
          autoAssigned: autoAssignedCount,
        },
      });
    } catch (error: any) {
      try { await client.query('ROLLBACK'); } catch {}
      // No partial success, no fake success: nothing is committed and the
      // response is an explicit failure.
      return sendJson(res, 500, {
        success: false,
        message: error?.message || 'Bulk import failed - no rows were committed.',
        data: { inserted: 0, updated: 0, skipped: 0, failed: rows.length, total: rows.length, errors, warnings, dryRun: false },
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Bulk import failed' });
  }
});

/** Dev-demo (in-memory) snapshot for one planned import row. Never used when a database is configured. */
function buildDemoImportRecord(p: PlannedImportRow, caller: CallerDbInfo): any {
  const row = p.row;
  const leadCode = row.leadCode || importLeadCode(row.phone) || createId('lead');
  const customFields: Record<string, any> = {
    ...p.customFields,
    otherInfo: row.otherInfo || '',
    campaignName: row.campaign || '',
    productName: row.product || '',
    assignedTo: p.assigned ? p.assigned.employeeId : '',
    assignedBy: p.assigned ? caller.employee_id : '',
    assignedDate: row.assignedDate || '',
    tat: p.tatValue ?? row.tat,
  };
  if (row.interestedAmount !== '' && p.amountValue === null) customFields.interestedAmount = row.interestedAmount;
  return {
    id: leadCode,
    leadCode,
    prospectName: row.name,
    customerName: row.name,
    mobile: row.phone,
    email: row.email,
    area: row.area,
    source: row.source,
    productName: row.product || '',
    campaignName: row.campaign || '',
    otherInfo: row.otherInfo || '',
    notes: row.finalRemarks || '',
    assignedTo: p.assigned ? p.assigned.employeeId : '',
    assignedBy: p.assigned ? caller.employee_id : '',
    assignedDate: row.assignedDate || '',
    creationDate: row.leadDate || new Date().toISOString(),
    currentStatus: p.currentStatus || 'New',
    projectedNCP: p.amountValue ?? 0,
    collectedNCP: 0,
    customFields,
    createdBy: caller.id,
    updatedBy: caller.id,
    timestamp: new Date().toISOString(),
  };
}



/** Param array for the canonical lead upsert (now includes created_by, updated_by, created_at, previous_assigned_to). */
function leadParams(record: LeadRecord, leadCode: string): any[] {
  return [
    leadCode,
    record.customerName,
    record.mobile,
    record.alternateMobile,
    record.email,
    record.maritalStatus,
    record.occupation,
    record.address,
    record.area,
    record.district,
    record.division,
    record.source,
    record.priority,
    record.projectedNCP,
    record.sumAssured,
    record.notes,
    record.assignedTo,
    record.assignedBy,
    record.assignedAt,
    record.lastFollowUpDate,
    record.nextFollowUpDate,
    record.currentStatus,
    JSON.stringify(record.statusHistory),
    JSON.stringify(record.assignmentHistory),
    JSON.stringify(record.documents),
    JSON.stringify(record.customFields),
    JSON.stringify(record.tags),
    record.createdBy,
    record.updatedBy,
    record.createdAt,
    record.previousAssignedTo,
  ];
}

/**
 * Server-side guard for single-lead deletion - HARDENED
 * - Requires authentication
 * - Requires leads.delete permission (admin bypass)
 * - Enforces data-scope: caller must have visibility to the lead
 * - FA can only delete own leads (via visibility Own)
 * - Manager can delete downline leads (via DownTeam visibility)
 * - Admin can delete any
 */
async function checkLeadDeletePermission(req: any, res: any): Promise<boolean> {
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
      return false;
    }
    const role = normalizeRole(caller.role_code);
    if (role === 'ADMIN' || role === 'SUPERADMIN') return true;

    const visibility = await resolveCallerVisibility(caller);

    // Fetch lead
    let leadRow: any = null;
    if (useDb()) {
      const pool = getPool();
      const leadResult = await pool.query(
        `SELECT id, assigned_to, custom_fields, created_by FROM leads
         WHERE (lead_code = $1 OR id = $2) AND is_deleted = FALSE
         LIMIT 1`,
        [req.params.id, isCanonicalLowerUuid(req.params.id) ? req.params.id : null]
      );
      leadRow = leadResult.rows[0] || null;
    } else {
      leadRow = fallbackStore.leads.find((l: any) => l.id === req.params.id) || null;
      if (leadRow) {
        // Adapt demo shape to expected fields
        leadRow = {
          assigned_to: null,
          custom_fields: { assignedTo: leadRow.assignedTo },
          created_by: null,
        };
      }
    }

    if (!leadRow) return true; // let handler return 404

    if (!isLeadAccessible(leadRow, visibility, caller)) {
      sendJson(res, 403, { success: false, message: 'You do not have permission to delete this lead. It is outside your authorized scope.' });
      return false;
    }

    if (!(await hasPermissionCode(caller, 'leads.delete'))) {
      sendJson(res, 403, { success: false, message: 'You do not have permission to delete leads.' });
      return false;
    }

    return true;
  } catch (error: any) {
    sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead delete check failed' });
    return false;
  }
}

/* ====================================================================
   LEADS — SERVER-AUTHORITATIVE FOLLOW-UP / ACTIVITY HISTORY
   - Appendix for PR 4A: dedicated append-only activity path
   - New table lead_activities is authoritative for NEW follow-up events
   - leads.status_history JSONB remains for backward compat (server appends)
   - Status validation reuses canonical FollowUpStatus dictionary (bulk import)
==================================================================== */

/**
 * Resolve a lead by UUID or lead_code (including fallbackStore) with
 * soft-delete filtering. Returns the raw DB row (with joined employee
 * columns when available) or fallback lead object.
 */
/* ------------------------------------------------------------------
   GET /leads/stage-rules — effective per-status required fields (DZ-6)
   MUST be registered BEFORE /leads/:id so "stage-rules" is never an id.
   Any authenticated lead editor may read it: the client form
   (LeadUpdate) validates from this same list the server enforces on
   POST /leads/:id/follow-up, so the two can never drift. Both sides
   fall back to the code-default table when the DB list cannot be read.
------------------------------------------------------------------- */
router.get('/leads/stage-rules', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const rules = await getEffectiveStageRules();
    const terminalNames = await getTerminalStatusNames();
    return sendJson(res, 200, {
      success: true,
      data: { rules, terminalNames },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Stage rules failed.' });
  }
});

/* ------------------------------------------------------------------
   GET /leads/follow-ups — operational follow-up queue (Step 4B)
   MUST be registered BEFORE /leads/:id so "follow-ups" is never an id.
------------------------------------------------------------------- */
const FOLLOWUP_QUEUE_MAX_LIMIT = 200;
const FOLLOWUP_QUEUE_DEFAULT_LIMIT = 50;

router.get('/leads/follow-ups', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    // Independent of each other and both derived from the caller: overlap
    // them so the queue costs one round trip of authorization latency
    // instead of two. Request-scoped memoization keeps the later
    // resolveCallerVisibility() call free.
    const [canViewQueue, visibility] = await Promise.all([
      hasPermissionCode(caller, 'leads.view'),
      resolveCallerVisibility(caller),
    ]);
    if (!canViewQueue) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }

    const rawBucket = String(req.query?.bucket || 'all').toLowerCase().trim();
    if (rawBucket && !['overdue', 'today', 'upcoming', 'all'].includes(rawBucket)) {
      return sendJson(res, 400, { success: false, message: 'bucket must be overdue, today, upcoming, or all.' });
    }
    const bucket = (rawBucket || 'all') as string;
    const includeTerminal = String(req.query?.includeTerminal || '').toLowerCase() === 'true';
    const statusFilter = req.query?.status ? canonicalizeLegacyStatusValue(req.query.status) : '';
    const assignedToRaw = req.query?.assignedTo ? String(req.query.assignedTo).trim() : '';
    const fromYmd = parseYmd(req.query?.from ? String(req.query.from) : null);
    const toYmd = parseYmd(req.query?.to ? String(req.query.to) : null);
    if (req.query?.from && !fromYmd) {
      return sendJson(res, 400, { success: false, message: 'from must be YYYY-MM-DD.' });
    }
    if (req.query?.to && !toYmd) {
      return sendJson(res, 400, { success: false, message: 'to must be YYYY-MM-DD.' });
    }

    let limit = Number(req.query?.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = FOLLOWUP_QUEUE_DEFAULT_LIMIT;
    limit = Math.min(Math.floor(limit), FOLLOWUP_QUEUE_MAX_LIMIT);
    let offset = Number(req.query?.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    offset = Math.floor(offset);

    const bounds = getDhakaBusinessDayBounds(new Date());
    // First-contact SLA (Phase 3 PR #3): config read once per request;
    // when the switch is OFF nothing below changes — items carry no
    // `sla` field and the response shape is exactly as before.
    const slaConfig = await getLeadSlaConfig();
    const slaNow = new Date();
    // `visibility` was resolved with the permission check above (request-
    // scoped memo — no second lookup).

    let assignedFilter: { userId: string; employeeId: string } | null = null;
    let assignedOutOfScope = false;
    if (assignedToRaw) {
      const resolved = await resolveAssignedTo(assignedToRaw);
      if (!resolved || !isAssignedToAllowed(resolved, visibility, caller)) {
        assignedOutOfScope = true;
      } else {
        assignedFilter = resolved;
      }
    }

    const emptyPayload = (extra: Record<string, any> = {}) =>
      sendJson(res, 200, {
        success: true,
        data: {
          bucket,
          timezone: BUSINESS_TIMEZONE,
          todayDate: bounds.todayDate,
          bounds: { todayStart: bounds.todayStartIso, tomorrowStart: bounds.tomorrowStartIso },
          items: [],
          counts: { overdue: 0, today: 0, upcoming: 0, all: 0 },
          pagination: { limit, offset, total: 0 },
          ...extra,
        },
      });

    if (assignedOutOfScope) {
      return emptyPayload({ assignedToRejected: true });
    }

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      // DZ-6: demo mirror of the dictionary terminal set.
      const terminal = new Set(getTerminalStatusNamesFallback().map(s => s.toLowerCase()));
      let rows = (fallbackStore.leads || []).filter((l: any) => {
        if (l.is_deleted === true) return false;
        const nfd = l.nextFollowUpDate || l.next_follow_up_at;
        if (!nfd) return false;
        // THE lead-access predicate — same unified rule as the DB
        // queue's buildDashboardVisibilitySql scope (assignee in scope
        // OR creator in scope); this demo filter used to check the
        // assignee only.
        if (!isLeadAccessible(
          { assignedTo: (l as any).assignedTo, createdBy: (l as any).createdBy ?? null } as any,
          visibility,
          caller
        )) return false;
        const st = String(l.currentStatus || '');
        if (!includeTerminal && terminal.has(st.toLowerCase())) return false;
        if (statusFilter && st !== statusFilter) return false;
        if (assignedFilter && String(l.assignedTo || '').toUpperCase() !== assignedFilter.employeeId.toUpperCase()) return false;
        const t = new Date(nfd).getTime();
        if (fromYmd) {
          const fromStart = dhakaStartUtc(fromYmd.y, fromYmd.m, fromYmd.d).getTime();
          if (t < fromStart) return false;
        }
        if (toYmd) {
          const next = addCalendarDays(toYmd.y, toYmd.m, toYmd.d, 1);
          const toEnd = dhakaStartUtc(next.y, next.m, next.d).getTime();
          if (t >= toEnd) return false;
        }
        return true;
      });
      const classify = (l: any) => {
        const t = new Date(l.nextFollowUpDate || l.next_follow_up_at).getTime();
        if (t < bounds.todayStart.getTime()) return 'overdue';
        if (t < bounds.tomorrowStart.getTime()) return 'today';
        return 'upcoming';
      };
      const counts = { overdue: 0, today: 0, upcoming: 0, all: rows.length };
      for (const l of rows) {
        const b = classify(l) as 'overdue' | 'today' | 'upcoming';
        counts[b]++;
      }
      if (bucket !== 'all') rows = rows.filter((l: any) => classify(l) === bucket);
      const total = rows.length;
      rows.sort((a: any, b: any) => new Date(a.nextFollowUpDate || 0).getTime() - new Date(b.nextFollowUpDate || 0).getTime());
      const page = rows.slice(offset, offset + limit);
      const demoQualityById = compactQualityForFallbackLeads(
        page,
        (fallbackStore as any).leadActivities || [],
        (fallbackStore as any).scheduledActivities || [],
        undefined,
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        await getLeadQualityConfig()
      );
      const items = page.map((l: any) => {
        const nfd = l.nextFollowUpDate || l.next_follow_up_at;
        // Demo SLA mirror: same clock-start chain the demo
        // auto-assignment rule uses (assignedDate → timestamp →
        // creationDate); contact stamp is lastFollowUpDate.
        const sla = slaConfig.enabled
          ? computeLeadSla(
              {
                assignedTo: l.assignedTo,
                assignedAt: l.assignedDate || l.timestamp || null,
                createdAt: l.creationDate || l.timestamp || null,
                lastContactedAt: l.lastFollowUpDate || null,
                currentStatus: l.currentStatus,
              },
              slaConfig.firstContactHours,
              slaNow,
              [...terminal]
            )
          : null;
        return {
          id: l.id,
          leadCode: l.id,
          prospectName: l.prospectName || l.customerName,
          customerName: l.customerName || l.prospectName,
          mobile: l.mobile,
          assignedTo: l.assignedTo,
          assignedEmployeeName: l.assignedTo,
          currentStatus: l.currentStatus,
          nextFollowUpAt: nfd,
          lastContactedAt: l.lastFollowUpDate || null,
          followUpCount: l.followUpCount || 0,
          campaign: l.campaignName || '',
          product: l.productName || '',
          area: l.area || '',
          priority: l.priority || 'NORMAL',
          overdueDays: overdueDays(nfd, bounds),
          dueState: classify(l),
          latestActivity: null,
          leadQuality: demoQualityById.get(String(l.id)),
          ...(sla ? { sla } : {}),
        };
      });
      return sendJson(res, 200, {
        success: true,
        data: {
          bucket,
          timezone: BUSINESS_TIMEZONE,
          todayDate: bounds.todayDate,
          bounds: { todayStart: bounds.todayStartIso, tomorrowStart: bounds.tomorrowStartIso },
          items,
          counts,
          pagination: { limit, offset, total },
        },
      });
    }

    const pool = getPool();
    const params: any[] = [];
    const where: string[] = [
      'l.is_deleted = FALSE',
      'l.next_follow_up_at IS NOT NULL',
    ];

    // DZ-6: the terminal set is the dictionary's isTerminal flag —
    // one resolution for the queue filter AND the per-row SLA below.
    const terminalNames = await getTerminalStatusNames();
    if (!includeTerminal) {
      params.push(terminalNames);
      where.push(`l.current_status <> ALL($${params.length}::text[])`);
    }
    if (statusFilter) {
      params.push(statusFilter);
      where.push(`l.current_status = $${params.length}`);
    }
    if (assignedFilter) {
      params.push(assignedFilter.userId);
      // assignedFilter.userId is a server-resolved users.id (canonical
      // uuid). The uuid-typed comparison lets PostgreSQL use the partial
      // composite idx_leads_assigned_next_follow_up_active (migration
      // 038); the previous ::text cast made that index unreachable.
      where.push(`l.assigned_to = $${params.length}::uuid`);
    }
    if (fromYmd) {
      params.push(dhakaStartUtc(fromYmd.y, fromYmd.m, fromYmd.d).toISOString());
      where.push(`l.next_follow_up_at >= $${params.length}::timestamp`);
    }
    if (toYmd) {
      const next = addCalendarDays(toYmd.y, toYmd.m, toYmd.d, 1);
      params.push(dhakaStartUtc(next.y, next.m, next.d).toISOString());
      where.push(`l.next_follow_up_at < $${params.length}::timestamp`);
    }
    // THE lead-visibility predicate — one shared definition
    // (buildDashboardVisibilitySql), identical to the leads list.
    where.push(buildDashboardVisibilitySql(visibility, params));

    const todayLit = bounds.todayStartIso.replace(/'/g, "''");
    const tomorrowLit = bounds.tomorrowStartIso.replace(/'/g, "''");
    const bucketExpr = `CASE WHEN l.next_follow_up_at < '${todayLit}'::timestamp THEN 'overdue' WHEN l.next_follow_up_at < '${tomorrowLit}'::timestamp THEN 'today' ELSE 'upcoming' END`;

    // --- one aggregate round trip, and a SARGABLE list predicate ---------
    // `CASE WHEN ... = 'today'` cannot use idx_leads_assigned_next_follow_up_active
    // (038): the expression forces a full scan before the filter. The
    // half-open range below is logically identical — the buckets are
    // 'overdue' (< todayStart), 'today' [todayStart, tomorrowStart) and
    // 'upcoming' (>= tomorrowStart) — but leaves next_follow_up_at bare, so
    // the partial index serves the page query directly.
    const bucketRangePredicate =
      bucket === 'overdue'
        ? `l.next_follow_up_at < '${todayLit}'::timestamp`
        : bucket === 'today'
          ? `l.next_follow_up_at >= '${todayLit}'::timestamp AND l.next_follow_up_at < '${tomorrowLit}'::timestamp`
          : bucket === 'upcoming'
            ? `l.next_follow_up_at >= '${tomorrowLit}'::timestamp`
            : null;

    const countSql = `SELECT ${bucketExpr} AS bucket, COUNT(*)::int AS cnt FROM leads l WHERE ${where.join(' AND ')} GROUP BY 1`;
    // The bucket aggregate already carries the exact total for each bucket,
    // so the extra per-bucket COUNT is redundant: the page query is issued
    // in parallel with the aggregate and the total is read from it.
    const listWhere = bucketRangePredicate ? [...where, bucketRangePredicate] : where;
    const listParams = [...params, limit, offset];
    const pLimit = listParams.length - 1;
    const pOffset = listParams.length;

    const listSql = `
      SELECT l.id, l.lead_code, l.customer_name, l.mobile, l.area, l.priority,
             l.current_status, l.next_follow_up_at, l.last_contacted_at,
             l.created_at, l.assigned_at, l.assigned_to, l.expected_premium,
             COALESCE(l.follow_up_count, 0) AS follow_up_count,
             l.custom_fields,
             au.employee_id AS assigned_to_employee_id,
             au.full_name AS assigned_to_full_name,
             ${bucketExpr} AS due_state,
             latest.status AS latest_activity_status,
             latest.remarks AS latest_activity_remarks,
             latest.created_at AS latest_activity_at
      FROM leads l
      LEFT JOIN users au ON au.id = l.assigned_to
      LEFT JOIN LATERAL (
        SELECT a.status, a.remarks, a.created_at
        FROM lead_activities a
        WHERE a.lead_id = l.id
        ORDER BY a.created_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE ${listWhere.join(' AND ')}
      ORDER BY l.next_follow_up_at ASC
      LIMIT $${pLimit} OFFSET $${pOffset}
    `;
    // Both statements are started before either is awaited: the page and the
    // bucket counts do not depend on each other, so they cost one round trip
    // of latency instead of two. (Previously the list ran only after BOTH
    // the bucket aggregate and a redundant per-bucket COUNT had returned.)
    const [countRes, listRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(listSql, listParams),
    ]);

    const counts = { overdue: 0, today: 0, upcoming: 0, all: 0 };
    for (const row of countRes.rows) {
      const b = String(row.bucket);
      const c = Number(row.cnt) || 0;
      if (b === 'overdue' || b === 'today' || b === 'upcoming') counts[b] = c;
      counts.all += c;
    }
    // `bucket=all` is the sum of every bucket; a specific bucket reads its
    // own exact count. Identical numbers to the previous COUNT query, one
    // fewer round trip.
    const total = counts[(bucket as keyof typeof counts)] ?? 0;

    // Lead Quality for the page: two bulk signal queries for all returned
    // leads — never per-lead. Scores attach to visible rows only.
    const queueIds = (listRes.rows || []).map((r: any) => String(r.id));
    const [queueActivity, queueScheduled, queueQualityConfig] = await Promise.all([
      fetchActivityQualitySignals(pool, queueIds),
      fetchScheduledQualitySignals(pool, queueIds),
      // DZ-3: the stored Lead Quality config (code defaults when unset).
      getLeadQualityConfig(),
    ]);
    const items = listRes.rows.map((row: any) => {
      const cf = row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {};
      const nfd = row.next_follow_up_at;
      // First-contact SLA for this row (Phase 3 PR #3) — null (and
      // therefore absent from the item) when the switch is OFF, the
      // lead is unassigned, or its status is terminal.
      const sla = slaConfig.enabled
        ? computeLeadSla(
            {
              assignedTo: row.assigned_to,
              assignedAt: row.assigned_at,
              createdAt: row.created_at,
              lastContactedAt: row.last_contacted_at,
              currentStatus: row.current_status,
            },
            slaConfig.firstContactHours,
            slaNow,
            terminalNames
          )
        : null;
      return {
        id: row.lead_code || row.id,
        dbId: row.id,
        leadCode: row.lead_code,
        prospectName: row.customer_name,
        customerName: row.customer_name,
        mobile: row.mobile || '',
        assignedTo: row.assigned_to != null && String(row.assigned_to).trim() !== ''
          ? (row.assigned_to_employee_id || '')
          : '',
        assignedEmployeeName: row.assigned_to_full_name || row.assigned_to_employee_id || '',
        currentStatus: row.current_status,
        nextFollowUpAt: nfd,
        lastContactedAt: row.last_contacted_at || null,
        followUpCount: Number(row.follow_up_count) || 0,
        campaign: cf.campaignName || '',
        product: cf.productName || '',
        area: row.area || '',
        priority: row.priority || 'NORMAL',
        overdueDays: overdueDays(nfd, bounds),
        dueState: String(row.due_state || 'upcoming'),
        latestActivity: row.latest_activity_at
          ? { status: row.latest_activity_status, remarks: row.latest_activity_remarks, createdAt: row.latest_activity_at }
          : null,
        leadQuality: compactScoreLeadRow(
          row,
          queueActivity.get(String(row.id)),
          queueScheduled.get(String(row.id)),
          undefined,
          queueQualityConfig
        ),
        ...(sla ? { sla } : {}),
      };
    });

    return sendJson(res, 200, {
      success: true,
      data: {
        bucket,
        timezone: BUSINESS_TIMEZONE,
        todayDate: bounds.todayDate,
        bounds: { todayStart: bounds.todayStartIso, tomorrowStart: bounds.tomorrowStartIso },
        items,
        counts,
        pagination: { limit, offset, total },
      },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Follow-up queue fetch failed.' });
  }
});

/* ------------------------------------------------------------------
   GET /leads/:id — direct single-lead retrieval (visibility enforced)
------------------------------------------------------------------- */
router.get('/leads/:id', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const param = String(req.params.id || '').trim();
    if (!param) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === param);
      if (!lead) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      const visibility = await resolveCallerVisibility(caller);
      const fakeRow = { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy || null };
      if (!isLeadAccessible(fakeRow as any, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      return sendJson(res, 200, {
        ...lead,
        leadQuality: scoreFallbackLead(
          lead,
          (fallbackStore as any).leadActivities || [],
          (fallbackStore as any).scheduledActivities || [],
          undefined,
          // DZ-3: the stored Lead Quality config (code defaults when unset).
          await getLeadQualityConfig()
        ),
      });
    }

    const row = await findLeadByIdRaw(param, false);
    if (!row) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    const visibility = await resolveCallerVisibility(caller);
    if (!isLeadAccessible(row, visibility, caller)) {
      return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    }
    const mappedSingle: any = mapLeadRow(row);
    const [singleActivity, singleScheduled, singleQualityConfig] = await Promise.all([
      fetchActivityQualitySignals(getPool(), [String(row.id)]),
      fetchScheduledQualitySignals(getPool(), [String(row.id)]),
      // DZ-3: the stored Lead Quality config (code defaults when unset).
      getLeadQualityConfig(),
    ]);
    mappedSingle.leadQuality = scoreLeadRow(
      row,
      singleActivity.get(String(row.id)),
      singleScheduled.get(String(row.id)),
      undefined,
      singleQualityConfig
    );
    return sendJson(res, 200, mappedSingle);
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead fetch failed' });
  }
});

/* ------------------------------------------------------------------
   GET /leads/:id/quality — full Lead Quality explanation (Lead360)
   Server-authoritative, deterministic, read-only. Same visibility and
   permission boundary as the lead itself (`leads.view` + scope check);
   the score never grants access.
------------------------------------------------------------------- */
router.get('/leads/:id/quality', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const param = String(req.params.id || '').trim();
    if (!param) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });
    const visibility = await resolveCallerVisibility(caller);

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === param);
      if (!lead) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      const fakeRow = { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy || null };
      if (!isLeadAccessible(fakeRow as any, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      return sendJson(res, 200, {
        success: true,
        data: scoreFallbackLead(
          lead,
          (fallbackStore as any).leadActivities || [],
          (fallbackStore as any).scheduledActivities || [],
          undefined,
          // DZ-3: the stored Lead Quality config (code defaults when unset).
          await getLeadQualityConfig()
        ),
      });
    }

    const row = await findLeadByIdRaw(param, false);
    if (!row) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    if (!isLeadAccessible(row, visibility, caller)) {
      return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    }
    const [qualityActivity, qualityScheduled, qualityConfig] = await Promise.all([
      fetchActivityQualitySignals(getPool(), [String(row.id)]),
      fetchScheduledQualitySignals(getPool(), [String(row.id)]),
      // DZ-3: the stored Lead Quality config (code defaults when unset).
      getLeadQualityConfig(),
    ]);
    return sendJson(res, 200, {
      success: true,
      data: scoreLeadRow(
        row,
        qualityActivity.get(String(row.id)),
        qualityScheduled.get(String(row.id)),
        undefined,
        qualityConfig
      ),
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead quality fetch failed' });
  }
});

/* ------------------------------------------------------------------
   GET /leads/:id/activities — chronological activity history
------------------------------------------------------------------- */
router.get('/leads/:id/activities', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const param = String(req.params.id || '').trim();
    if (!param) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === param);
      if (!lead) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      const visibility = await resolveCallerVisibility(caller);
      const fakeRow = { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy || null };
      if (!isLeadAccessible(fakeRow as any, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      const acts = (fallbackStore.leadActivities || []).filter((a: any) => String(a.leadId) === String(lead.id) || String(a.lead_id) === String(lead.id));
      // Return most recent first (reverse chronological) for UI convenience
      acts.sort((a: any, b: any) => new Date(b.createdAt || b.created_at).getTime() - new Date(a.createdAt || a.created_at).getTime());
      return sendJson(res, 200, acts.map(mapActivityRow));
    }

    const leadRow = await findLeadByIdRaw(param, false);
    if (!leadRow) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    const visibility = await resolveCallerVisibility(caller);
    if (!isLeadAccessible(leadRow, visibility, caller)) {
      return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    }
    // Fetch activities + actor employee_id for UI
    const activities = await getPool().query(
      `SELECT a.*, u.employee_id AS actor_employee_id
       FROM lead_activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.lead_id = $1
       ORDER BY a.created_at DESC`,
      [leadRow.id]
    );
    return sendJson(res, 200, activities.rows.map(mapActivityRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Activity fetch failed' });
  }
});

/* ------------------------------------------------------------------
   POST /leads/:id/follow-up — server-authoritative follow-up
   Body whitelist: status/currentStatus, remarks, nextFollowUpDate,
   nextCallDate, meetingDate, meetingType, collectedNCP, projectedNCP,
   sumAssured, productName, lossReason
   Spoofable fields ignored: changedBy, updatedBy, createdBy, actor,
   date, timestamp, statusHistory, assignmentHistory
------------------------------------------------------------------- */
router.post('/leads/:id/follow-up', requireAuth, async (req: any, res) => {
  const perf = createPerf('lead.followUp');
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.edit'))) {
      perf.span('authz.permission');
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'You do not have permission to update leads.' });
    }
    perf.span('authz.permission');
    const param = String(req.params.id || '').trim();
    if (!param) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });

    // Whitelisted payload extraction (ignore everything else, including spoofable keys)
    const body = req.body || {};
    // Explicitly ignore spoofable keys even if client tries to send them under alias
    const rawStatus = body.status ?? body.currentStatus ?? body.current_status;
    const rawRemarks = body.remarks;
    const rawNextFollowUpDate = body.nextFollowUpDate ?? body.next_follow_up_at ?? body.nextFollowUpAt;
    const rawNextCallDate = body.nextCallDate ?? body.next_call_at ?? body.nextCallAt;
    const rawMeetingDate = body.meetingDate ?? body.meeting_at ?? body.meetingAt;
    const rawMeetingType = body.meetingType ?? body.meeting_type;
    const rawCollectedNCP = body.collectedNCP ?? body.collected_ncp ?? body.collectedNcp;
    const rawProjectedNCP = body.projectedNCP ?? body.projected_ncp ?? body.projectedNcp;
    const rawSumAssured = body.sumAssured ?? body.sum_assured ?? body.sumAssured;
    const rawProductName = body.productName ?? body.product_name ?? body.product;
    const rawLossReason = body.lossReason ?? body.loss_reason ?? body.lossReason;
    // 'nextAction' is the form's shortcut out of 'Interested' (Need Follow-Up /
    // Meeting Fixed / Proposal Sent / Not Interested). It is resolved to the
    // canonical status here, so the API keeps the UI's semantics.
    const rawNextAction = body.nextAction ?? body.next_action;
    // Offline-capture idempotency key (Phase 3 PR #2): an optional UUID
    // the client mints per user submission and reuses on every retry of
    // that submission (its on-device outbox flushes until it gets a
    // definitive answer). When present, the mutation is applied exactly
    // once — see the claim/replay logic in both write paths below and
    // migration 050. Absent => behaviour is exactly as before.
    const clientMutationId = asUuid(body.clientMutationId ?? body.client_mutation_id);
    if ((body.clientMutationId ?? body.client_mutation_id) != null && !clientMutationId) {
      return sendJson(res, 400, { success: false, message: 'Invalid clientMutationId.' });
    }

    // Normalize
    const statusInput = rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '' ? String(rawStatus).trim() : undefined;
    const remarksInput = rawRemarks !== undefined && rawRemarks !== null ? String(rawRemarks).trim() : undefined;
    const nextFollowUpDateInput = rawNextFollowUpDate !== undefined && rawNextFollowUpDate !== null && String(rawNextFollowUpDate).trim() !== '' ? dateOrNull(rawNextFollowUpDate) : undefined;
    const nextCallDateInput = rawNextCallDate !== undefined && rawNextCallDate !== null && String(rawNextCallDate).trim() !== '' ? dateOrNull(rawNextCallDate) : undefined;
    const meetingDateInput = rawMeetingDate !== undefined && rawMeetingDate !== null && String(rawMeetingDate).trim() !== '' ? dateOrNull(rawMeetingDate) : undefined;
    const meetingTypeInput = rawMeetingType !== undefined && rawMeetingType !== null && String(rawMeetingType).trim() !== '' ? String(rawMeetingType).trim().slice(0, 255) : undefined;
    const collectedNCPInput = rawCollectedNCP !== undefined && rawCollectedNCP !== null && String(rawCollectedNCP).trim() !== '' ? parseNumeric(rawCollectedNCP) : undefined;
    const projectedNCPInput = rawProjectedNCP !== undefined && rawProjectedNCP !== null && String(rawProjectedNCP).trim() !== '' ? parseNumeric(rawProjectedNCP) : undefined;
    const sumAssuredInput = rawSumAssured !== undefined && rawSumAssured !== null && String(rawSumAssured).trim() !== '' ? parseNumeric(rawSumAssured) : undefined;
    const productNameInput = rawProductName !== undefined && rawProductName !== null && String(rawProductName).trim() !== '' ? String(rawProductName).trim().slice(0, 255) : undefined;
    const lossReasonInput = rawLossReason !== undefined && rawLossReason !== null && String(rawLossReason).trim() !== '' ? String(rawLossReason).trim() : undefined;

    // Validate dates when supplied but unparseable
    if (rawNextFollowUpDate !== undefined && rawNextFollowUpDate !== null && String(rawNextFollowUpDate).trim() !== '' && nextFollowUpDateInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid nextFollowUpDate.' });
    }
    if (rawNextCallDate !== undefined && rawNextCallDate !== null && String(rawNextCallDate).trim() !== '' && nextCallDateInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid nextCallDate.' });
    }
    if (rawMeetingDate !== undefined && rawMeetingDate !== null && String(rawMeetingDate).trim() !== '' && meetingDateInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid meetingDate.' });
    }
    // Validate numerics when supplied but not numeric
    if (rawCollectedNCP !== undefined && rawCollectedNCP !== null && String(rawCollectedNCP).trim() !== '' && collectedNCPInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid collectedNCP.' });
    }
    if (rawProjectedNCP !== undefined && rawProjectedNCP !== null && String(rawProjectedNCP).trim() !== '' && projectedNCPInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid projectedNCP.' });
    }
    if (rawSumAssured !== undefined && rawSumAssured !== null && String(rawSumAssured).trim() !== '' && sumAssuredInput === null) {
      return sendJson(res, 400, { success: false, message: 'Invalid sumAssured.' });
    }

    // Status validation against canonical dictionary (unknown => fail clearly, never silently New)
    let validatedStatus: string | undefined = undefined;
    if (statusInput !== undefined) {
      const dict = await getFollowUpStatusValues();
      const resolved = resolveImportStatus(statusInput, dict);
      if (!resolved.ok) {
        return sendJson(res, 400, { success: false, message: `Unknown status \"${statusInput}\".` });
      }
      validatedStatus = resolved.status;
      if (!validatedStatus) {
        return sendJson(res, 400, { success: false, message: `Unknown status \"${statusInput}\".` });
      }
      // Interested + a Next Action = the status the form would have sent.
      // Only a VALID choice resolves; an unknown nextAction is ignored (it is
      // a UI hint) and the explicit status wins.
      if (normalizeStatusKey(validatedStatus) === 'interested') {
        const resolvedNextAction = resolveNextActionStatus(rawNextAction);
        if (resolvedNextAction) validatedStatus = resolvedNextAction;
      }
    }

    // At least one business field should be present; otherwise it's a no-op
    const hasAnyField = validatedStatus !== undefined || remarksInput !== undefined || nextFollowUpDateInput !== undefined || nextCallDateInput !== undefined || meetingDateInput !== undefined || meetingTypeInput !== undefined || collectedNCPInput !== undefined || projectedNCPInput !== undefined || sumAssuredInput !== undefined || productNameInput !== undefined || lossReasonInput !== undefined;
    if (!hasAnyField) {
      return sendJson(res, 400, { success: false, message: 'No valid follow-up fields supplied.' });
    }

    /* ---- F6: per-status required fields (server-authoritative) ----------------
       The conditionals used to live only in the Update form, so any other
       caller could park a lead in "Meeting Fixed" with no meeting, "Converted"
       with no premium, or "Not Interested" with no reason. DZ-6: the rules
       live in the lead_stage_rules table, keyed by dictionary-entry id
       (StageRulesService), and are resolved to current names at request
       time — renaming a status keeps its rule. The client form fetches
       the same effective list (GET /leads/stage-rules); both sides fall
       back to the code-default table when the DB list cannot be read.
       A partial update (remarks only, no status) keeps working: the rule is
       keyed on the status being written.                                          */
    if (validatedStatus !== undefined) {
      const violations = await validateLeadStatusFieldsAsync(validatedStatus, {
        nextFollowUpDate: nextFollowUpDateInput,
        meetingDate: meetingDateInput,
        productName: productNameInput,
        sumAssured: sumAssuredInput,
        projectedNCP: projectedNCPInput,
        collectedNCP: collectedNCPInput,
        lossReason: lossReasonInput,
      });
      if (violations.length > 0) {
        perf.finish(res);
        return sendJson(res, 400, {
          success: false,
          message: leadStatusViolationMessage(violations),
          errors: violations,
        });
      }
    }

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === param);
      if (!lead) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      if ((lead as any).is_deleted === true) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      const visibility = await resolveCallerVisibility(caller);
      const fakeRow = { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy || null };
      if (!isLeadAccessible(fakeRow as any, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to update this lead.' });
      }

      // Idempotency replay (demo mirror of the DB claim below): this
      // mutation was already applied — answer from the recorded outcome
      // WITHOUT applying it a second time.
      if (clientMutationId) {
        const prior = ((fallbackStore as any).processedFollowupMutations || [])
          .find((m: any) => m.mutationId === clientMutationId);
        if (prior) {
          return sendJson(res, 200, { ...(prior.responseBody || {}), deduplicated: true });
        }
      }

      const nowIso = new Date().toISOString();
      // Determine new status (preserve existing when not supplied)
      const newStatus = validatedStatus !== undefined ? validatedStatus : (lead as any).currentStatus || 'New';

      // Build server-authoritative history entry
      const historyEntry: Record<string, any> = {
        status: newStatus,
        date: nowIso,
        remarks: remarksInput !== undefined ? remarksInput : '',
        nextFollowUpDate: nextFollowUpDateInput !== undefined ? nextFollowUpDateInput! : (lead as any).nextFollowUpDate,
        nextCallDate: nextCallDateInput !== undefined ? nextCallDateInput! : (lead as any).nextCallDate,
        meetingDate: meetingDateInput !== undefined ? meetingDateInput! : (lead as any).meetingDate,
        sumAssured: sumAssuredInput !== undefined ? sumAssuredInput! : (lead as any).sumAssured,
        productName: productNameInput !== undefined ? productNameInput! : (lead as any).productName,
        lossReason: lossReasonInput !== undefined ? lossReasonInput! : (lead as any).lossReason,
        meetingType: meetingTypeInput !== undefined ? meetingTypeInput! : (lead as any).meetingType,
        collectedNCP: collectedNCPInput !== undefined ? collectedNCPInput! : (lead as any).collectedNCP,
        projectedNCP: projectedNCPInput !== undefined ? projectedNCPInput! : (lead as any).projectedNCP,
        updatedBy: caller.employee_id,
        changedBy: caller.employee_id,
        actor: caller.employee_id,
      };

      // Update lead current state (partial-update semantics, preserve unrelated data)
      if (validatedStatus !== undefined) (lead as any).currentStatus = newStatus;
      if (remarksInput !== undefined) (lead as any).notes = remarksInput;
      if (nextFollowUpDateInput !== undefined) (lead as any).nextFollowUpDate = nextFollowUpDateInput;
      if (nextCallDateInput !== undefined) (lead as any).nextCallDate = nextCallDateInput;
      if (meetingDateInput !== undefined) (lead as any).meetingDate = meetingDateInput;
      if (meetingTypeInput !== undefined) (lead as any).meetingType = meetingTypeInput;
      if (productNameInput !== undefined) (lead as any).productName = productNameInput;
      if (lossReasonInput !== undefined) (lead as any).lossReason = lossReasonInput;
      if (collectedNCPInput !== undefined) (lead as any).collectedNCP = collectedNCPInput;
      if (projectedNCPInput !== undefined) (lead as any).projectedNCP = projectedNCPInput;
      if (sumAssuredInput !== undefined) (lead as any).sumAssured = sumAssuredInput;
      (lead as any).lastFollowUpDate = nowIso;
      (lead as any).timestamp = nowIso;
      (lead as any).updatedBy = caller.employee_id;
      // Also keep customFields in sync for UI that reads from custom fields
      const cf = (lead as any).customFields || {};
      if (nextCallDateInput !== undefined) cf.nextCallDate = nextCallDateInput;
      if (meetingDateInput !== undefined) cf.meetingDate = meetingDateInput;
      if (meetingTypeInput !== undefined) cf.meetingType = meetingTypeInput;
      if (productNameInput !== undefined) cf.productName = productNameInput;
      if (lossReasonInput !== undefined) cf.lossReason = lossReasonInput;
      if (collectedNCPInput !== undefined) cf.collectedNCP = collectedNCPInput;
      if (projectedNCPInput !== undefined) cf.projectedNCP = projectedNCPInput;
      if (sumAssuredInput !== undefined) cf.sumAssured = sumAssuredInput;
      (lead as any).customFields = cf;

      // Append to statusHistory (authoritative)
      const existingHistory: any[] = Array.isArray((lead as any).statusHistory) ? (lead as any).statusHistory : [];
      (lead as any).statusHistory = [...existingHistory, historyEntry];

      // Insert append-only activity (in-memory)
      const activity: any = {
        id: createId('activity'),
        leadId: (lead as any).id,
        activityType: 'follow_up',
        status: newStatus,
        remarks: remarksInput,
        nextFollowUpAt: nextFollowUpDateInput,
        nextCallAt: nextCallDateInput,
        meetingAt: meetingDateInput,
        meetingType: meetingTypeInput,
        collectedNcp: collectedNCPInput,
        projectedNcp: projectedNCPInput,
        sumAssured: sumAssuredInput,
        productName: productNameInput,
        lossReason: lossReasonInput,
        createdBy: caller.id,
        createdAt: nowIso,
        // camelCase aliases for UI
        nextFollowUpDate: nextFollowUpDateInput,
        nextCallDate: nextCallDateInput,
        meetingDate: meetingDateInput,
        collectedNCP: collectedNCPInput,
        projectedNCP: projectedNCPInput,
        updatedBy: caller.employee_id,
        actor: caller.employee_id,
      };
      if (!Array.isArray((fallbackStore as any).leadActivities)) (fallbackStore as any).leadActivities = [];
      (fallbackStore as any).leadActivities.push(activity);

      // Next-step calendar sync (demo mirror of the DB sync below).
      const demoStep = resolveNextStep({
        meetingAt: meetingDateInput ?? null,
        nextCallAt: nextCallDateInput ?? null,
        nextFollowUpAt: nextFollowUpDateInput ?? null,
      });
      syncNextStepAfterFollowUpDemo(fallbackStore as any, {
        leadId: String((lead as any).id),
        sourceActivityId: String(activity.id),
        sourceKind: 'follow_up',
        actorId: caller.id,
        assignedTo: (lead as any).assignedTo ?? null,
        customerName: (lead as any).prospectName || (lead as any).customerName || null,
        nextStepAt: demoStep?.at ?? null,
        kind: demoStep?.kind ?? 'follow_up',
        meetingType: meetingTypeInput ?? null,
        remarks: remarksInput !== undefined ? remarksInput : null,
        leadStatusAfter: newStatus,
      });

      const mappedActivity = mapActivityRow(activity);
      // Return lead (authoritative) + activity, with fresh quality so the
      // UI in-place patch never carries a stale score after a status move.
      (lead as any).leadQuality = scoreFallbackLead(
        lead,
        (fallbackStore as any).leadActivities || [],
        (fallbackStore as any).scheduledActivities || [],
        undefined,
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        await getLeadQualityConfig()
      );
      const demoResponseBody = { success: true, data: { lead: lead, activity: mappedActivity } };
      if (clientMutationId) {
        if (!Array.isArray((fallbackStore as any).processedFollowupMutations)) (fallbackStore as any).processedFollowupMutations = [];
        (fallbackStore as any).processedFollowupMutations.push({
          mutationId: clientMutationId,
          leadId: String((lead as any).id),
          userId: caller.id,
          appliedAt: nowIso,
          // Snapshot must not alias the live lead object (it keeps
          // mutating) — store a deep copy, like the DB JSONB snapshot.
          responseBody: JSON.parse(JSON.stringify(demoResponseBody)),
        });
      }
      return sendJson(res, 200, demoResponseBody);
    }

    // ---------- PostgreSQL path (transactional atomic) ----------
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Idempotency claim (Phase 3 PR #2, migration 050): inside the
      // SAME transaction that applies the follow-up. Only the claim
      // winner proceeds; a concurrent/late retry blocks on the PK until
      // the winner commits, then replays the stored outcome below. If
      // this transaction rolls back, the claim rolls back with it, so a
      // failed application never burns the mutation id.
      let mutationClaimed = false;
      if (clientMutationId) {
        const claim = await client.query(
          `INSERT INTO processed_followup_mutations (mutation_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (mutation_id) DO NOTHING
           RETURNING mutation_id`,
          [clientMutationId, caller.id]
        );
        if (claim.rows.length === 0) {
          const prior = await client.query(
            `SELECT response_body FROM processed_followup_mutations WHERE mutation_id = $1`,
            [clientMutationId]
          );
          await client.query('COMMIT');
          const stored = prior.rows[0]?.response_body;
          perf.finish(res);
          if (stored) {
            return sendJson(res, 200, { ...stored, deduplicated: true });
          }
          // Claimed and committed but no snapshot survived (only
          // reachable if the winner crashed between COMMIT and the
          // snapshot write): the follow-up WAS applied exactly once —
          // say so honestly instead of re-applying or pretending.
          return sendJson(res, 409, { success: false, message: 'This follow-up was already submitted and applied. Please refresh the lead to see it.' });
        }
        mutationClaimed = true;
      }
      // Lock the lead row to prevent lost updates / concurrent history overwrite.
      // Same sargable dual lookup as findLeadByIdRaw: lead_code equality or
      // PK equality (id branch only for canonical-lowercase UUID input, the
      // only inputs the legacy id::text comparison could match).
      const leadRes = await client.query(
        `SELECT l.* FROM leads l WHERE (l.lead_code = $1 OR l.id = $2) AND l.is_deleted = FALSE LIMIT 1 FOR UPDATE`,
        [param, isCanonicalLowerUuid(param) ? param : null]
      );
      perf.span('db.lockLead');
      const leadRow = leadRes.rows[0];
      if (!leadRow) {
        await client.query('ROLLBACK');
        perf.finish(res);
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      const visibility = await resolveCallerVisibility(caller);
      perf.span('authz.visibility');
      if (!isLeadAccessible(leadRow, visibility, caller)) {
        await client.query('ROLLBACK');
        perf.finish(res);
        return sendJson(res, 403, { success: false, message: 'You do not have permission to update this lead.' });
      }

      if (mutationClaimed) {
        await client.query(
          `UPDATE processed_followup_mutations SET lead_id = $1 WHERE mutation_id = $2`,
          [leadRow.id, clientMutationId]
        );
      }

      // Server timestamp (authoritative) — one instant for both the activity and the lead update
      const nowIso: string = new Date().toISOString();
      const nowForDb: string = nowIso; // for TIMESTAMP columns, PG will parse ISO

      const newStatus = validatedStatus !== undefined ? validatedStatus : (leadRow.current_status || 'New');

      // Build history entry (server-authoritative)
      const existingHistory: any[] = Array.isArray(leadRow.status_history) ? leadRow.status_history : (Array.isArray(leadRow.statusHistory) ? leadRow.statusHistory : []);
      const historyEntry: Record<string, any> = {
        status: newStatus,
        date: nowIso,
        remarks: remarksInput !== undefined ? remarksInput : '',
        nextFollowUpDate: nextFollowUpDateInput !== undefined ? nextFollowUpDateInput! : (leadRow.next_follow_up_at ? new Date(leadRow.next_follow_up_at).toISOString() : undefined),
        nextCallDate: nextCallDateInput !== undefined ? nextCallDateInput! : undefined,
        meetingDate: meetingDateInput !== undefined ? meetingDateInput! : undefined,
        sumAssured: sumAssuredInput !== undefined ? sumAssuredInput! : (leadRow.expected_value != null ? Number(leadRow.expected_value) : undefined),
        productName: productNameInput !== undefined ? productNameInput! : undefined,
        lossReason: lossReasonInput !== undefined ? lossReasonInput! : undefined,
        meetingType: meetingTypeInput !== undefined ? meetingTypeInput! : undefined,
        collectedNCP: collectedNCPInput !== undefined ? collectedNCPInput! : undefined,
        projectedNCP: projectedNCPInput !== undefined ? projectedNCPInput! : undefined,
        updatedBy: caller.employee_id,
        changedBy: caller.employee_id,
        // Preserve additional fields for backward compat if existing history had them
      };
      // Fill missing history fields from existing custom_fields when not supplied
      const cfExisting: Record<string, any> = leadRow.custom_fields && typeof leadRow.custom_fields === 'object' ? leadRow.custom_fields : {};
      if (historyEntry.nextCallDate === undefined && cfExisting.nextCallDate) historyEntry.nextCallDate = cfExisting.nextCallDate;
      if (historyEntry.meetingDate === undefined && cfExisting.meetingDate) historyEntry.meetingDate = cfExisting.meetingDate;
      if (historyEntry.productName === undefined && cfExisting.productName) historyEntry.productName = cfExisting.productName;
      if (historyEntry.lossReason === undefined && cfExisting.lossReason) historyEntry.lossReason = cfExisting.lossReason;
      if (historyEntry.meetingType === undefined && cfExisting.meetingType) historyEntry.meetingType = cfExisting.meetingType;
      if (historyEntry.collectedNCP === undefined && cfExisting.collectedNCP != null) historyEntry.collectedNCP = cfExisting.collectedNCP;
      if (historyEntry.projectedNCP === undefined && cfExisting.projectedNCP != null) historyEntry.projectedNCP = cfExisting.projectedNCP;
      if (historyEntry.sumAssured === undefined && cfExisting.sumAssured != null) historyEntry.sumAssured = cfExisting.sumAssured;

      const newHistory = [...existingHistory, historyEntry];

      // Prepare lead update — partial, preserve-on-undefined
      // Build custom_fields merge
      const newCustomFields: Record<string, any> = { ...(cfExisting || {}) };
      if (nextCallDateInput !== undefined) newCustomFields.nextCallDate = nextCallDateInput;
      if (meetingDateInput !== undefined) newCustomFields.meetingDate = meetingDateInput;
      if (meetingTypeInput !== undefined) newCustomFields.meetingType = meetingTypeInput;
      if (productNameInput !== undefined) newCustomFields.productName = productNameInput;
      if (lossReasonInput !== undefined) newCustomFields.lossReason = lossReasonInput;
      if (collectedNCPInput !== undefined) newCustomFields.collectedNCP = collectedNCPInput;
      if (projectedNCPInput !== undefined) newCustomFields.projectedNCP = projectedNCPInput;
      if (sumAssuredInput !== undefined) newCustomFields.sumAssured = sumAssuredInput;

      // Build dynamic SET for leads update. Use parameterized query to avoid undefined wipes.
      const setClauses: string[] = [];
      const params: any[] = [];
      let idx = 1;

      // current_status
      if (validatedStatus !== undefined) {
        setClauses.push(`current_status = $${idx++}`);
        params.push(newStatus);
      }
      // notes / remarks
      if (remarksInput !== undefined) {
        setClauses.push(`notes = $${idx++}`);
        params.push(remarksInput);
      }
      // next_follow_up_at
      if (nextFollowUpDateInput !== undefined) {
        setClauses.push(`next_follow_up_at = $${idx++}`);
        params.push(nextFollowUpDateInput);
      }
      // last_contacted_at = now (semantically correct for a follow-up)
      setClauses.push(`last_contacted_at = $${idx++}`);
      params.push(nowForDb);

      // expected_premium / expected_value
      if (projectedNCPInput !== undefined) {
        setClauses.push(`expected_premium = $${idx++}`);
        params.push(projectedNCPInput);
      }
      if (sumAssuredInput !== undefined) {
        setClauses.push(`expected_value = $${idx++}`);
        params.push(sumAssuredInput);
      }

      // status_history
      setClauses.push(`status_history = $${idx++}::jsonb`);
      params.push(JSON.stringify(newHistory));

      // custom_fields merge
      setClauses.push(`custom_fields = $${idx++}::jsonb`);
      params.push(JSON.stringify(newCustomFields));

      // updated_by / updated_at
      setClauses.push(`updated_by = $${idx++}`);
      params.push(caller.id);
      setClauses.push(`updated_at = NOW()`);

      // increment follow_up_count (optional but keeps stats)
      setClauses.push(`follow_up_count = COALESCE(follow_up_count, 0) + 1`);

      const leadIdParamIdx = idx++;
      params.push(leadRow.id);

      const updateSql = `UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${leadIdParamIdx} RETURNING *`;
      const updatedLeadRes = await client.query(updateSql, params);
      if (!updatedLeadRes.rows[0]) {
        await client.query('ROLLBACK');
        return sendJson(res, 500, { success: false, message: 'Lead update failed.' });
      }
      const updatedRow = updatedLeadRes.rows[0];

      // Insert activity row
      const activityInsert = await client.query(
        `INSERT INTO lead_activities
           (lead_id, activity_type, status, remarks, next_follow_up_at, next_call_at, meeting_at, meeting_type, collected_ncp, projected_ncp, sum_assured, product_name, loss_reason, created_by, created_at)
         VALUES
           ($1, 'follow_up', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          updatedRow.id,
          newStatus,
          remarksInput !== undefined ? remarksInput : null,
          nextFollowUpDateInput !== undefined ? nextFollowUpDateInput : null,
          nextCallDateInput !== undefined ? nextCallDateInput : null,
          meetingDateInput !== undefined ? meetingDateInput : null,
          meetingTypeInput !== undefined ? meetingTypeInput : null,
          collectedNCPInput !== undefined ? collectedNCPInput : null,
          projectedNCPInput !== undefined ? projectedNCPInput : null,
          sumAssuredInput !== undefined ? sumAssuredInput : null,
          productNameInput !== undefined ? productNameInput : null,
          lossReasonInput !== undefined ? lossReasonInput : null,
          caller.id,
          nowForDb,
        ]
      );
      if (!activityInsert.rows[0]) {
        await client.query('ROLLBACK');
        return sendJson(res, 500, { success: false, message: 'Activity insertion failed.' });
      }

      // Next-step calendar sync (PR A): mirror this follow-up's next
      // step onto the Task Calendar inside the same transaction — a
      // status update that sets a next-step date/time now lands on
      // the calendar date-wise (services/NextStepCalendarSync.ts).
      const step = resolveNextStep({
        meetingAt: meetingDateInput ?? null,
        nextCallAt: nextCallDateInput ?? null,
        nextFollowUpAt: nextFollowUpDateInput ?? null,
      });
      await syncNextStepAfterFollowUp(client, {
        leadId: String(updatedRow.id),
        sourceActivityId: String(activityInsert.rows[0].id),
        sourceKind: 'follow_up',
        actorId: caller.id,
        assignedTo: updatedRow.assigned_to ?? null,
        customerName: updatedRow.customer_name ?? null,
        nextStepAt: step?.at ?? null,
        kind: step?.kind ?? 'follow_up',
        meetingType: meetingTypeInput ?? null,
        remarks: remarksInput !== undefined ? remarksInput : null,
        leadStatusAfter: newStatus,
      });

      perf.span('db.updateAndActivity');
      await client.query('COMMIT');
      perf.span('db.commit');

      // The UPDATE above already RETURNED the full row; the only joined
      // columns are the employee ids of assigned_to/assigned_by, which this
      // follow-up does not change. One primary-key lookup therefore
      // replaces the previous post-commit LEAD_SELECT re-fetch.
      const employeeIds = await employeeIdsFor([updatedRow.assigned_to, updatedRow.assigned_by]);
      perf.span('db.responseJoins');
      const mappedLead: any = mapLeadRow({
        ...updatedRow,
        assigned_to_employee_id: employeeIds.get(String(updatedRow.assigned_to || '')) || null,
        assigned_by_employee_id: employeeIds.get(String(updatedRow.assigned_by || '')) || null,
      });
      // Fresh full quality for the updated row (two single-lead bulk-safe
      // queries) — the follow-up changed status/recency/follow-up signals.
      const [fuActivity, fuScheduled, fuQualityConfig] = await Promise.all([
        fetchActivityQualitySignals(getPool(), [String(updatedRow.id)]),
        fetchScheduledQualitySignals(getPool(), [String(updatedRow.id)]),
        // DZ-3: the stored Lead Quality config (code defaults when unset).
        getLeadQualityConfig(),
      ]);
      mappedLead.leadQuality = scoreLeadRow(
        updatedRow,
        fuActivity.get(String(updatedRow.id)),
        fuScheduled.get(String(updatedRow.id)),
        undefined,
        fuQualityConfig
      );
      perf.span('db.qualitySignals');
      const mappedActivity = mapActivityRow({ ...activityInsert.rows[0], actor_employee_id: caller.employee_id });
      perf.finish(res);

      const responseBody = { success: true, data: { lead: mappedLead, activity: mappedActivity } };
      if (mutationClaimed) {
        // Record the outcome so a retry of this mutation replays it
        // instead of re-applying. Best-effort by design: the claim row
        // already guarantees once-only application, and a missing
        // snapshot degrades a retry to the honest 409 above — never to
        // a double application.
        try {
          await getPool().query(
            `UPDATE processed_followup_mutations SET response_body = $1::jsonb WHERE mutation_id = $2`,
            [JSON.stringify(responseBody), clientMutationId]
          );
        } catch { /* snapshot is best-effort; see note above */ }
      }
      return sendJson(res, 200, responseBody);
    } catch (error: any) {
      try { await client.query('ROLLBACK'); } catch {}
      perf.finish(res);
      return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Follow-up failed.' });
    } finally {
      try { client.release(); } catch {}
    }
  } catch (error: any) {
    perf.finish(res);
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Follow-up failed.' });
  }
});

router.delete('/leads/:id', requireAuth, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    // Demo mode: enforce scope
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found.' });
    const visibility = await resolveCallerVisibility(caller);
    const lead = fallbackStore.leads.find((l: any) => l.id === req.params.id);
    if (lead) {
      const fakeRow = { assignedTo: lead.assignedTo, createdBy: lead.createdBy || null };
      if (!isLeadAccessible(fakeRow, visibility, caller) && !callerIsAdmin(req)) {
        return sendJson(res, 403, { success: false, message: 'You do not have permission to delete this lead.' });
      }
    }
    fallbackStore.leads = fallbackStore.leads.filter((l: any) => l.id !== req.params.id);
    return sendJson(res, 200, { success: true, message: 'Lead deleted' });
  }
  if (!(await checkLeadDeletePermission(req, res))) return;
  try {
    const caller = await getCallerDbInfo(req);
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
       WHERE (lead_code = $1 OR id = $3) AND is_deleted = FALSE
       RETURNING id`,
      [req.params.id, caller?.id || null, isCanonicalLowerUuid(req.params.id) ? req.params.id : null]
    );
    if (!result.rows[0]) return sendJson(res, 404, { success: false, message: 'Lead not found' });
    return sendJson(res, 200, { success: true, message: 'Lead deleted' });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead delete failed' });
  }
});

router.delete('/leads/campaign/:campaign', requireAuth, requireAdmin, async (req, res) => {
  // Campaign purge intentionally remains the established PR #32
  // ADMIN/SUPERADMIN-only capability. It is not a leads.delete action.
  const campaign = req.params.campaign;
  // Phase 0 safety rail: bulk destruction requires a typed confirmation —
  // the request body must repeat the exact campaign name. requireAdmin has
  // already run as middleware, so non-admins still fail 403 before this
  // gate is ever evaluated.
  if ((req.body || {}).confirm !== campaign) {
    return sendJson(res, 400, { success: false, message: `Confirmation required: type "${campaign}" to purge this campaign's leads.` });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.leads = fallbackStore.leads.filter((l: any) => l.campaignName !== campaign);
    return sendJson(res, 200, { success: true, message: 'Campaign leads deleted' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    // Snapshot the affected leads BEFORE the purge (first 200, plus the
    // true total) so the audit ledger records exactly what was removed.
    // Rows are soft-deleted either way, so recovery stays possible.
    const snapshotCount = await getPool().query(
      `SELECT COUNT(*)::int AS total FROM leads WHERE custom_fields->>'campaignName' = $1 AND is_deleted = FALSE`,
      [campaign]
    );
    const snapshotRows = await getPool().query(
      `SELECT id, lead_code, customer_name, mobile FROM leads
       WHERE custom_fields->>'campaignName' = $1 AND is_deleted = FALSE
       ORDER BY created_at ASC LIMIT 200`,
      [campaign]
    );
    const snapshotTotal = snapshotCount.rows[0]?.total ?? snapshotRows.rows.length;
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $2, updated_by = $2, updated_at = NOW()
       WHERE custom_fields->>'campaignName' = $1 AND is_deleted = FALSE
       RETURNING id`,
      [campaign, caller?.id || null]
    );
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'leads.campaign_purge',
      entityType: 'lead',
      entityId: null,
      metadata: {
        campaign,
        deletedCount: result.rows.length,
        snapshotTotal,
        snapshot: snapshotRows.rows.map((r: any) => ({ leadCode: r.lead_code, name: r.customer_name, mobile: r.mobile })),
        snapshotTruncated: snapshotTotal > snapshotRows.rows.length,
      },
    });
    return sendJson(res, 200, {
      success: true,
      message: result.rows.length > 0 ? 'Campaign leads deleted' : 'No leads found for that campaign',
      deleted: result.rows.length,
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Campaign leads delete failed' });
  }
});

router.post('/leads/clear-all', requireAuth, requireAdmin, async (req, res) => {
  // Phase 0 safety rail: bulk destruction requires a typed confirmation —
  // the request body must contain confirm: "CLEAR_ALL". requireAdmin has
  // already run as middleware, so non-admins still fail 403 before this
  // gate is ever evaluated.
  if ((req.body || {}).confirm !== 'CLEAR_ALL') {
    return sendJson(res, 400, { success: false, message: 'Confirmation required: type CLEAR_ALL to purge all leads.' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.leads = [];
    return sendJson(res, 200, { success: true, message: 'All leads cleared' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    // Snapshot the affected leads BEFORE the purge (first 200, plus the
    // true total) so the audit ledger records exactly what was removed.
    // Rows are soft-deleted either way, so recovery stays possible.
    const snapshotCount = await getPool().query(
      `SELECT COUNT(*)::int AS total FROM leads WHERE is_deleted = FALSE`
    );
    const snapshotRows = await getPool().query(
      `SELECT id, lead_code, customer_name, mobile FROM leads
       WHERE is_deleted = FALSE
       ORDER BY created_at ASC LIMIT 200`
    );
    const snapshotTotal = snapshotCount.rows[0]?.total ?? snapshotRows.rows.length;
    const result = await getPool().query(
      `UPDATE leads SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = $1, updated_by = $1, updated_at = NOW()
       WHERE is_deleted = FALSE RETURNING id`,
      [caller?.id || null]
    );
    await logAccessChange({
      actorId: req.currentUser?.id,
      actionCode: 'leads.clear_all',
      entityType: 'lead',
      entityId: null,
      metadata: {
        deletedCount: result.rows.length,
        snapshotTotal,
        snapshot: snapshotRows.rows.map((r: any) => ({ leadCode: r.lead_code, name: r.customer_name, mobile: r.mobile })),
        snapshotTruncated: snapshotTotal > snapshotRows.rows.length,
      },
    });
    return sendJson(res, 200, { success: true, message: 'All leads cleared', deleted: result.rows.length });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead clear failed' });
  }
});

/* ------------------------------------------------------------------
   GET /leads/:id/scheduled-activities — convenience listing for a lead
------------------------------------------------------------------- */
router.get('/leads/:id/scheduled-activities', requireAuth, async (req: any, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const leadParam = String(req.params.id || '').trim();
    if (!leadParam) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });

    const visibility = await resolveCallerVisibility(caller);
    let leadRow: any = null;
    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const lead = fallbackStore.leads.find((l: any) => String(l.id) === leadParam);
      if (!lead) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      if ((lead as any).is_deleted === true) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      // THE lead-access predicate — identical to the DB branch below
      // (this demo branch used to check the assignee only).
      if (!isLeadAccessible(
        { assignedTo: (lead as any).assignedTo, createdBy: (lead as any).createdBy ?? null } as any,
        visibility,
        caller
      )) {
        return sendJson(res, 404, { success: false, message: 'Lead not found.' });
      }
      leadRow = lead;
      const items = ((fallbackStore as any).scheduledActivities || [])
        .filter((sa: any) => String(sa.leadId || sa.lead_id) === String(leadRow.id))
        .sort((a: any, b: any) => new Date(a.scheduledAt || a.scheduled_at).getTime() - new Date(b.scheduledAt || b.scheduled_at).getTime())
        .map((r: any) => mapScheduledActivityRow({ ...r, lead_customer_name: (leadRow as any).prospectName, lead_mobile: (leadRow as any).mobile, lead_current_status: (leadRow as any).currentStatus }));
      return sendJson(res, 200, { success: true, data: items });
    }

    leadRow = await findLeadByIdRaw(leadParam, false);
    if (!leadRow) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    if (leadRow.is_deleted === true) return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    if (!isLeadAccessible(leadRow, visibility, caller)) return sendJson(res, 404, { success: false, message: 'Lead not found.' });

    const r = await getPool().query(
      `SELECT sa.*, l.customer_name AS lead_customer_name, l.mobile AS lead_mobile, l.current_status AS lead_current_status
       FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id
       WHERE sa.lead_id = $1 ORDER BY sa.scheduled_at ASC`,
      [leadRow.id]
    );
    return sendJson(res, 200, { success: true, data: r.rows.map(mapScheduledActivityRow) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Scheduled activities fetch failed.' });
  }
});

export default router;
