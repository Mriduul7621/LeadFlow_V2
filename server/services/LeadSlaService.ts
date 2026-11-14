/**
 * LeadSlaService — first-contact SLA tracking + breach alerts
 * (Phase 3 PR #3).
 * ------------------------------------------------------------------
 * A newly assigned lead that gets NO first contact inside the SLA
 * window quietly goes cold. When an admin enables this feature:
 *
 *   - the follow-up queue (GET /leads/follow-ups — the Workbench
 *     feed) carries an `sla` object per item, and the Workbench
 *     badges breached (red) / due-soon (amber) leads;
 *   - the existing morning push run (PushReminderService) also runs
 *     breach detection: each newly-breached lead creates exactly ONE
 *     in-app alert to its assignee and ONE escalation to the
 *     assignee's direct manager, and the assignee's push summary
 *     gains a breach-count line. No new cron, no extra sends.
 *
 * DEFINITIONS (from the app's own data model — see recon notes in
 * the PR body):
 *   clock start    = leads.assigned_at — the current assignment
 *                    episode's start. It is written when a lead is
 *                    created with an assignee, refreshed by the API
 *                    reassignment path, and set to NOW() by the
 *                    deactivation transfer; PR #97's rule already
 *                    treats it as the episode timestamp. Legacy rows
 *                    with a NULL assigned_at fall back to created_at.
 *   first contact  = leads.last_contacted_at >= clock start. The
 *                    server-authoritative follow-up handler
 *                    (POST /leads/:id/follow-up) unconditionally sets
 *                    last_contacted_at = NOW() and inserts a
 *                    'follow_up' activity; scheduled-activity
 *                    completion does the same — last_contacted_at IS
 *                    the app's canonical "contacted" stamp. A contact
 *                    stamped BEFORE the current assignment belongs to
 *                    the previous episode and does not count.
 *   window         = wall-clock hours (default 24), NOT a business-
 *                    hour calendar.
 *   terminal leads (dictionary isTerminal flag, DZ-6) and unassigned
 *   leads are excluded entirely.
 *
 * THE SWITCH: Metadata Engine options, group 'LeadSla' (seeded by
 * migration 051) — ('LeadSla','enabled') is_active is the switch,
 * ('LeadSla','firstContactHours') carries meta.hours. OFF (or rows
 * missing) = zero behaviour change on every surface; every read
 * fails closed to OFF with the 24h default.
 *
 * DEDUPE: alerts ride the notification idempotency machinery
 * (migration 040): key = eventType:leadId:recipientId:episodeStart.
 * The episode start (assigned_at) is part of the key, so a lead
 * alerts exactly once per assignment episode — reassignment starts
 * a new episode (new clock, new key) and can alert again. No new
 * table or marker column is needed.
 */

import { getPool } from '../database/connection.js';
import { createId, fallbackStore } from '../fallbackStore.js';
import { getTerminalStatusNames, getTerminalStatusNamesFallback } from './StageRulesService.js';
import { useDb } from '../routes/production/shared.js';
import {
  buildIdempotencyKey,
  insertNotificationWithIdempotency,
  resolveUplineRecipients,
} from './NotificationService.js';

/* ====================================================================
   Configuration (Metadata Engine options; fails closed to OFF / 24h)
==================================================================== */

export const SLA_OPTION_TYPE = 'LeadSla';
export const SLA_ENABLED_OPTION_VALUE = 'enabled';
export const SLA_HOURS_OPTION_VALUE = 'firstContactHours';
export const DEFAULT_SLA_HOURS = 24;
export const MIN_SLA_HOURS = 1;
export const MAX_SLA_HOURS = 720;

export const SLA_BREACH_EVENT = 'lead-sla-breached';
export const SLA_ESCALATION_EVENT = 'lead-sla-escalated';

export interface LeadSlaConfig {
  enabled: boolean;
  firstContactHours: number;
}

/** Clamp an arbitrary stored value to a sane SLA window. Pure. */
export function normalizeSlaHours(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SLA_HOURS;
  const rounded = Math.round(n);
  if (rounded < MIN_SLA_HOURS) return MIN_SLA_HOURS;
  if (rounded > MAX_SLA_HOURS) return MAX_SLA_HOURS;
  return rounded;
}

function hoursFromOptionRow(row: any): number {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return normalizeSlaHours((meta as any).hours);
}

/**
 * Read the SLA config. DB: options rows; demo: fallbackStore mirror.
 * Any failure (missing table, bad row) fails closed: OFF + default.
 */
export async function getLeadSlaConfig(): Promise<LeadSlaConfig> {
  if (!useDb()) {
    const rows = (fallbackStore.options as any[]).filter(
      (o: any) => o.type === SLA_OPTION_TYPE
    );
    const enabledRow = rows.find((o: any) => o.value === SLA_ENABLED_OPTION_VALUE);
    const hoursRow = rows.find((o: any) => o.value === SLA_HOURS_OPTION_VALUE);
    return {
      enabled: Boolean(enabledRow) && enabledRow.status !== 'Inactive',
      firstContactHours: hoursRow ? hoursFromOptionRow(hoursRow) : DEFAULT_SLA_HOURS,
    };
  }
  try {
    const result = await getPool().query(
      `SELECT option_value, is_active, meta FROM options WHERE field_key = $1`,
      [SLA_OPTION_TYPE]
    );
    let enabled = false;
    let hours = DEFAULT_SLA_HOURS;
    for (const row of result.rows) {
      if (row.option_value === SLA_ENABLED_OPTION_VALUE) enabled = row.is_active === true;
      if (row.option_value === SLA_HOURS_OPTION_VALUE) hours = hoursFromOptionRow(row);
    }
    return { enabled, firstContactHours: hours };
  } catch {
    // No options table (minimal schema) or read failure: OFF.
    return { enabled: false, firstContactHours: DEFAULT_SLA_HOURS };
  }
}

/* ====================================================================
   Pure SLA computation
==================================================================== */

export type LeadSlaState = 'within' | 'due_soon' | 'breached' | 'met';

export interface LeadSlaInput {
  /** Assignee identity (users.id or employee id); null/'' = unassigned. */
  assignedTo: string | null | undefined;
  assignedAt: string | Date | null | undefined;
  createdAt: string | Date | null | undefined;
  lastContactedAt: string | Date | null | undefined;
  currentStatus: string | null | undefined;
}

export interface LeadSlaResult {
  state: LeadSlaState;
  /** When the current assignment episode started (ISO). */
  clockStartAt: string;
  /** clockStart + window (ISO). */
  deadlineAt: string;
  /** Milliseconds left until the deadline (0 once breached/met). */
  remainingMs: number;
  /** Milliseconds past the deadline (0 unless breached). */
  overdueMs: number;
  /** The first-contact stamp that satisfied the SLA, when met. */
  firstContactAt: string | null;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute one lead's SLA state. Pure and deterministic.
 *
 * Returns null when the SLA does not apply: unassigned lead,
 * terminal status, or no usable clock start.
 *
 * Boundaries: a contact stamped exactly at the clock start counts
 * (met). Exactly at the deadline with no contact is breached
 * (the window has fully elapsed). due_soon begins when the time
 * left is <= 25% of the window.
 *
 * DZ-6: which statuses are terminal comes from the dictionary's
 * isTerminal flag (terminalStatuses, resolved by the caller from
 * StageRulesService). The default is the canonical fallback pair,
 * used by the demo mirror and whenever the caller has nothing
 * better — never a second source of truth.
 */
export function computeLeadSla(
  input: LeadSlaInput,
  firstContactHours: number,
  now: Date = new Date(),
  terminalStatuses: readonly string[] = getTerminalStatusNamesFallback()
): LeadSlaResult | null {
  if (!input.assignedTo || String(input.assignedTo).trim() === '') return null;
  const terminalSet = new Set(
    (terminalStatuses || []).map(s => String(s).trim().toLowerCase())
  );
  if (terminalSet.has(String(input.currentStatus || '').toLowerCase())) return null;

  const clockStartMs = toMs(input.assignedAt) ?? toMs(input.createdAt);
  if (clockStartMs == null) return null;

  const hours = normalizeSlaHours(firstContactHours);
  const windowMs = hours * 60 * 60 * 1000;
  const deadlineMs = clockStartMs + windowMs;
  const nowMs = now.getTime();

  const contactMs = toMs(input.lastContactedAt);
  const firstContactAt =
    contactMs != null && contactMs >= clockStartMs
      ? new Date(contactMs).toISOString()
      : null;

  const base = {
    clockStartAt: new Date(clockStartMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
  };

  if (firstContactAt) {
    return { ...base, state: 'met', remainingMs: 0, overdueMs: 0, firstContactAt };
  }
  if (nowMs >= deadlineMs) {
    return {
      ...base,
      state: 'breached',
      remainingMs: 0,
      overdueMs: nowMs - deadlineMs,
      firstContactAt: null,
    };
  }
  const remainingMs = deadlineMs - nowMs;
  return {
    ...base,
    state: remainingMs <= windowMs * 0.25 ? 'due_soon' : 'within',
    remainingMs,
    overdueMs: 0,
    firstContactAt: null,
  };
}

/* ====================================================================
   Breach scan (all currently-breached open assigned leads)
==================================================================== */

export interface SlaBreach {
  leadId: string;
  leadCode: string;
  customerName: string;
  assigneeUserId: string;
  assigneeEmployeeId: string;
  sla: LeadSlaResult;
}

async function scanBreachesDb(
  config: LeadSlaConfig,
  now: Date
): Promise<SlaBreach[]> {
  // DZ-6: the terminal set is the dictionary's isTerminal flag.
  const terminal = await getTerminalStatusNames();
  const result = await getPool().query(
    `SELECT l.id, l.lead_code, l.customer_name, l.assigned_to,
            l.assigned_at, l.created_at, l.last_contacted_at, l.current_status,
            au.employee_id AS assignee_employee_id
       FROM leads l
       JOIN users au ON au.id = l.assigned_to AND au.is_active = TRUE
      WHERE l.is_deleted = FALSE
        AND l.assigned_to IS NOT NULL
        AND l.current_status <> ALL($1::text[])
        AND COALESCE(l.assigned_at, l.created_at) IS NOT NULL
        AND COALESCE(l.assigned_at, l.created_at) < $2`,
    [terminal, now.toISOString()]
  );
  const breaches: SlaBreach[] = [];
  for (const row of result.rows) {
    const sla = computeLeadSla(
      {
        assignedTo: row.assigned_to,
        assignedAt: row.assigned_at,
        createdAt: row.created_at,
        lastContactedAt: row.last_contacted_at,
        currentStatus: row.current_status,
      },
      config.firstContactHours,
      now,
      terminal
    );
    if (sla && sla.state === 'breached') {
      breaches.push({
        leadId: String(row.id),
        leadCode: row.lead_code || String(row.id),
        customerName: row.customer_name || 'Unknown',
        assigneeUserId: String(row.assigned_to),
        assigneeEmployeeId: String(row.assignee_employee_id || ''),
        sla,
      });
    }
  }
  return breaches;
}

function demoUserIsActive(u: any): boolean {
  return String(u?.status || '').toLowerCase() !== 'inactive' && u?.isActive !== false;
}

function scanBreachesDemo(config: LeadSlaConfig, now: Date): SlaBreach[] {
  const breaches: SlaBreach[] = [];
  for (const lead of (fallbackStore.leads as any[]) || []) {
    if (lead.is_deleted === true) continue;
    const assignedTo = String(lead.assignedTo || '').trim();
    if (!assignedTo) continue;
    const assignee = (fallbackStore.users as any[]).find(
      u => String(u.employeeId || '').toUpperCase() === assignedTo.toUpperCase()
    );
    if (!assignee || !demoUserIsActive(assignee)) continue;
    const sla = computeLeadSla(
      {
        assignedTo,
        // Same demo clock-start chain the auto-assignment rule uses.
        assignedAt: lead.assignedDate || lead.timestamp || lead.creationDate || null,
        createdAt: lead.creationDate || lead.timestamp || null,
        lastContactedAt: lead.lastFollowUpDate || null,
        currentStatus: lead.currentStatus,
      },
      config.firstContactHours,
      now
    );
    if (sla && sla.state === 'breached') {
      breaches.push({
        leadId: String(lead.id),
        leadCode: String(lead.id),
        customerName: lead.customerName || lead.prospectName || 'Unknown',
        assigneeUserId: String(assignee.id),
        assigneeEmployeeId: String(assignee.employeeId || ''),
        sla,
      });
    }
  }
  return breaches;
}

/** Every currently-breached lead (empty when the feature is OFF). */
export async function findSlaBreaches(
  config: LeadSlaConfig,
  now: Date = new Date()
): Promise<SlaBreach[]> {
  if (!config.enabled) return [];
  return useDb() ? scanBreachesDb(config, now) : scanBreachesDemo(config, now);
}

/** Count of currently-breached leads for ONE assignee (0 when OFF). */
export async function countSlaBreachesForAssignee(
  assigneeUserId: string,
  config: LeadSlaConfig,
  now: Date = new Date()
): Promise<number> {
  if (!config.enabled || !assigneeUserId) return 0;
  const breaches = await findSlaBreaches(config, now);
  return breaches.filter(b => b.assigneeUserId === assigneeUserId).length;
}

/* ====================================================================
   Breach alerts (idempotent notifications; rides the morning run)
==================================================================== */

export interface SlaBreachRunSummary {
  enabled: boolean;
  /** Currently-breached leads seen this run. */
  breached: number;
  /** Assignee alerts actually created (dedupe skips excluded). */
  alerted: number;
  /** Manager escalations actually created. */
  escalated: number;
  /** Inserts skipped because this episode already alerted. */
  deduped: number;
  /** Current breach counts per assignee user id (for push bodies). */
  breachesByAssignee: Map<string, number>;
}

const EMPTY_RUN: SlaBreachRunSummary = {
  enabled: false,
  breached: 0,
  alerted: 0,
  escalated: 0,
  deduped: 0,
  breachesByAssignee: new Map(),
};

function overdueHoursText(sla: LeadSlaResult): string {
  return String(Math.max(1, Math.round(sla.overdueMs / (60 * 60 * 1000))));
}

async function alertBreachDb(
  breach: SlaBreach,
  config: LeadSlaConfig,
  summary: SlaBreachRunSummary
): Promise<void> {
  const pool = getPool();
  const episode = breach.sla.clockStartAt;
  const overdueH = overdueHoursText(breach.sla);

  const assigneeRow = await insertNotificationWithIdempotency(pool, {
    userId: breach.assigneeUserId,
    recipientKey: breach.assigneeEmployeeId,
    title: 'First-Contact SLA Breached',
    message:
      `Lead '${breach.customerName}' (${breach.leadCode}) was assigned ${overdueH}h ago ` +
      `past the ${config.firstContactHours}h first-contact SLA and still has no recorded contact. ` +
      `Please contact the customer now.`,
    eventType: SLA_BREACH_EVENT,
    idempotencyKey: buildIdempotencyKey(
      SLA_BREACH_EVENT, breach.leadId, breach.assigneeUserId, episode
    ),
    leadId: breach.leadId,
    leadCode: breach.leadCode,
    referenceType: 'lead',
  });
  if (assigneeRow) summary.alerted++;
  else summary.deduped++;

  // One escalation: the DIRECT manager only (first upline entry).
  const upline = await resolveUplineRecipients(
    pool, breach.assigneeUserId, breach.assigneeEmployeeId
  );
  const manager = upline.find(m => m.userId !== breach.assigneeUserId);
  if (manager) {
    const mgrRow = await insertNotificationWithIdempotency(pool, {
      userId: manager.userId,
      recipientKey: manager.employeeId,
      title: 'Team First-Contact SLA Breach',
      message:
        `Lead '${breach.customerName}' (${breach.leadCode}) assigned to ${breach.assigneeEmployeeId} ` +
        `has passed the ${config.firstContactHours}h first-contact SLA by ${overdueH}h with no recorded contact.`,
      eventType: SLA_ESCALATION_EVENT,
      idempotencyKey: buildIdempotencyKey(
        SLA_ESCALATION_EVENT, breach.leadId, manager.userId, episode
      ),
      leadId: breach.leadId,
      leadCode: breach.leadCode,
      referenceType: 'lead',
    });
    if (mgrRow) summary.escalated++;
    else summary.deduped++;
  }
}

function alertBreachDemo(
  breach: SlaBreach,
  config: LeadSlaConfig,
  summary: SlaBreachRunSummary
): void {
  const store = fallbackStore as any;
  if (!Array.isArray(store.notifications)) store.notifications = [];
  const existingKeys = new Set(
    store.notifications.map((n: any) => n.idempotencyKey).filter(Boolean)
  );
  const episode = breach.sla.clockStartAt;
  const overdueH = overdueHoursText(breach.sla);

  // Demo convention (mirrors createAssignmentNotificationsDemo):
  // keys are built on the recipient's employee id.
  const assigneeKey = buildIdempotencyKey(
    SLA_BREACH_EVENT, breach.leadId, breach.assigneeEmployeeId, episode
  );
  if (!existingKeys.has(assigneeKey)) {
    store.notifications.push({
      id: createId('notification'),
      userId: breach.assigneeUserId,
      title: 'First-Contact SLA Breached',
      message:
        `Lead '${breach.customerName}' (${breach.leadCode}) was assigned ${overdueH}h ago ` +
        `past the ${config.firstContactHours}h first-contact SLA and still has no recorded contact. ` +
        `Please contact the customer now.`,
      leadId: breach.leadId,
      read: false,
      date: new Date().toISOString(),
      eventType: SLA_BREACH_EVENT,
      idempotencyKey: assigneeKey,
    });
    summary.alerted++;
    existingKeys.add(assigneeKey);
  } else {
    summary.deduped++;
  }

  // Direct manager = first hop of the demo managerId walk.
  const assignee = (fallbackStore.users as any[]).find(
    u => String(u.id) === breach.assigneeUserId
  );
  const mgrEmpId = String(assignee?.managerId || assignee?.reportingManagerId || '');
  const manager = mgrEmpId
    ? (fallbackStore.users as any[]).find(
        u => String(u.employeeId || '').toUpperCase() === mgrEmpId.toUpperCase()
      )
    : null;
  if (manager && demoUserIsActive(manager)) {
    const mgrKey = buildIdempotencyKey(
      SLA_ESCALATION_EVENT, breach.leadId, String(manager.employeeId), episode
    );
    if (!existingKeys.has(mgrKey)) {
      store.notifications.push({
        id: createId('notification'),
        userId: manager.id,
        title: 'Team First-Contact SLA Breach',
        message:
          `Lead '${breach.customerName}' (${breach.leadCode}) assigned to ${breach.assigneeEmployeeId} ` +
          `has passed the ${config.firstContactHours}h first-contact SLA by ${overdueH}h with no recorded contact.`,
        leadId: breach.leadId,
        read: false,
        date: new Date().toISOString(),
        eventType: SLA_ESCALATION_EVENT,
        idempotencyKey: mgrKey,
      });
      summary.escalated++;
      existingKeys.add(mgrKey);
    } else {
      summary.deduped++;
    }
  }
}

/**
 * One detection pass: create the assignee + direct-manager alerts for
 * every currently-breached lead that has not alerted in its current
 * assignment episode. Idempotent — re-running creates nothing new.
 * Individual lead failures are counted in the log line, never fatal.
 */
export async function runLeadSlaBreachAlerts(
  now: Date = new Date()
): Promise<SlaBreachRunSummary> {
  const config = await getLeadSlaConfig();
  if (!config.enabled) return { ...EMPTY_RUN, breachesByAssignee: new Map() };

  const summary: SlaBreachRunSummary = {
    enabled: true,
    breached: 0,
    alerted: 0,
    escalated: 0,
    deduped: 0,
    breachesByAssignee: new Map(),
  };

  const breaches = await findSlaBreaches(config, now);
  summary.breached = breaches.length;
  for (const breach of breaches) {
    summary.breachesByAssignee.set(
      breach.assigneeUserId,
      (summary.breachesByAssignee.get(breach.assigneeUserId) || 0) + 1
    );
    try {
      if (useDb()) await alertBreachDb(breach, config, summary);
      else alertBreachDemo(breach, config, summary);
    } catch (error: any) {
      console.warn(
        `[lead-sla] alert failed for lead ${breach.leadCode}: ${error?.message || 'unknown error'}`
      );
    }
  }

  console.log(
    `[lead-sla] breach run complete: breached=${summary.breached} alerted=${summary.alerted} ` +
    `escalated=${summary.escalated} deduped=${summary.deduped}`
  );
  return summary;
}
