/**
 * LeadExportService — FIX-2 scoped lead export.
 * ------------------------------------------------------------------
 * Pure shaping logic for the lead export workbook (the route in
 * production/leads.routes.ts owns SQL, permission gating, the audit
 * row and the HTTP response):
 *
 *  - `ExportLead` / `ExportActivity` are the NORMALIZED row shapes.
 *    The DB path builds them from `leads` / `lead_activities` rows;
 *    the dev-demo path builds them from fallbackStore records. All
 *    workbook shaping below works only on these shapes, so both modes
 *    produce identical files.
 *
 *  - The History sheet mirrors the Lead360 timeline's data path
 *    (src/modules/leads/pages/Lead360.tsx): server-authoritative
 *    `lead_activities` first, legacy `status_history` entries merged
 *    in only when they do not duplicate an activity (same status +
 *    same instant), and `assignment_history` entries as assignment
 *    events. Statuses are chained chronologically so each status
 *    event can render its old -> new transition.
 *
 *  - Lead Quality is NEVER recomputed here: the column is filled
 *    only when a score already rides on the row (the list endpoint
 *    computes scores per page; the export path deliberately does
 *    not), otherwise it stays blank.
 */
import { formatDhakaDateTime } from './MeetingNotificationService.js';

export type ExportScope = 'own' | 'team' | 'teamwise';
export type ExportBasis = 'added' | 'updated';

export const EXPORT_SCOPES: ExportScope[] = ['own', 'team', 'teamwise'];
export const EXPORT_BASES: ExportBasis[] = ['added', 'updated'];

/** Hard cap on leads per export file (overridable for tests/ops). */
export function resolveExportMaxRows(): number {
  const configured = Number(process.env.LEADS_EXPORT_MAX_ROWS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return 10000;
}

export interface ExportLead {
  /** Display id (lead_code when present, else the row id). */
  id: string;
  /** Row id used to join activities (leads uuid in DB mode). */
  dbId: string;
  customerName: string;
  mobile: string;
  alternateMobile: string;
  email: string;
  profession: string;
  maritalStatus: string;
  address: string;
  area: string;
  district: string;
  division: string;
  source: string;
  campaign: string;
  product: string;
  priority: string;
  status: string;
  /** Grouping key for the team-wise sheet (assignee user id / employee id). */
  assigneeKey: string;
  assigneeName: string;
  assigneeEmployeeId: string;
  assignedAt: unknown;
  creatorName: string;
  creatorEmployeeId: string;
  createdAt: unknown;
  updatedAt: unknown;
  lastContactedAt: unknown;
  nextFollowUpAt: unknown;
  projectedNcp: number | null;
  sumAssured: number | null;
  followUpCount: number | null;
  /** Score only when one already rides on the row; never computed here. */
  qualityScore: number | string;
  statusHistory: any[];
  assignmentHistory: any[];
}

export interface ExportActivity {
  leadDbId: string;
  activityType: string;
  status: string;
  remarks: string;
  lossReason: string;
  meetingType: string;
  nextFollowUpAt: unknown;
  nextCallAt: unknown;
  meetingAt: unknown;
  productName: string;
  sumAssured: number | null;
  projectedNcp: number | null;
  collectedNcp: number | null;
  actorName: string;
  actorEmployeeId: string;
  createdAt: unknown;
}

export interface ExportHistoryEvent {
  leadId: string;
  customerName: string;
  time: unknown;
  actor: string;
  type: 'Status Change' | 'Assignment';
  detail: string;
}

/* ------------------------------------------------------------------ */
/* Column sets                                                         */
/* ------------------------------------------------------------------ */

export const LEAD_EXPORT_HEADERS = [
  'Lead ID',
  'Customer Name',
  'Mobile',
  'Alternate Mobile',
  'Email',
  'Profession',
  'Marital Status',
  'Address',
  'Area',
  'District',
  'Division',
  'Source',
  'Campaign',
  'Product',
  'Priority',
  'Status',
  'Assigned To',
  'Assigned To ID',
  'Assigned Date',
  'Created By',
  'Created By ID',
  'Created At',
  'Updated At',
  'Last Contacted',
  'Next Follow-up',
  'Projected NCP',
  'Sum Assured',
  'Follow-ups',
  'Lead Quality',
];

export const LEAD_EXPORT_WIDTHS = [
  16, 24, 15, 15, 26, 16, 13, 30, 14, 14, 12, 14, 20, 18, 10, 16,
  20, 13, 20, 20, 13, 20, 20, 20, 20, 13, 13, 10, 11,
];

export const HISTORY_EXPORT_HEADERS = [
  'Lead ID',
  'Customer Name',
  'Event Time',
  'Actor',
  'Event Type',
  'Detail',
];

export const HISTORY_EXPORT_WIDTHS = [16, 24, 22, 20, 15, 90];

/* ------------------------------------------------------------------ */
/* Row shaping                                                         */
/* ------------------------------------------------------------------ */

function dhaka(value: unknown): string {
  return formatDhakaDateTime(value) || '';
}

function timeMs(value: unknown): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

/** Shape one normalized lead into a Leads-sheet record. */
export function shapeLeadExportRow(lead: ExportLead): Record<string, any> {
  return {
    'Lead ID': lead.id,
    'Customer Name': lead.customerName,
    'Mobile': lead.mobile,
    'Alternate Mobile': lead.alternateMobile,
    'Email': lead.email,
    'Profession': lead.profession,
    'Marital Status': lead.maritalStatus,
    'Address': lead.address,
    'Area': lead.area,
    'District': lead.district,
    'Division': lead.division,
    'Source': lead.source,
    'Campaign': lead.campaign,
    'Product': lead.product,
    'Priority': lead.priority,
    'Status': lead.status,
    'Assigned To': lead.assigneeName,
    'Assigned To ID': lead.assigneeEmployeeId,
    'Assigned Date': dhaka(lead.assignedAt),
    'Created By': lead.creatorName,
    'Created By ID': lead.creatorEmployeeId,
    'Created At': dhaka(lead.createdAt),
    'Updated At': dhaka(lead.updatedAt),
    'Last Contacted': dhaka(lead.lastContactedAt),
    'Next Follow-up': dhaka(lead.nextFollowUpAt),
    'Projected NCP': lead.projectedNcp,
    'Sum Assured': lead.sumAssured,
    'Follow-ups': lead.followUpCount,
    'Lead Quality': lead.qualityScore,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting-tree ordering (team-wise grouping)                        */
/* ------------------------------------------------------------------ */

export interface ExportUserRef {
  id: string;
  fullName: string;
  employeeId: string;
  managerId: string | null;
}

/**
 * Order users the way the reporting tree reads: the anchor (caller)
 * first, then their downline breadth-first; anyone not reachable
 * from the anchor (e.g. org-wide exports anchored at the roots)
 * follows in tree order from the roots, then by name. Deterministic
 * for identical inputs.
 */
export function orderUsersByTree(users: ExportUserRef[], anchorId: string | null): ExportUserRef[] {
  const byId = new Map(users.map(u => [u.id, u]));
  const children = new Map<string, ExportUserRef[]>();
  for (const u of users) {
    if (u.managerId && byId.has(u.managerId) && u.managerId !== u.id) {
      const list = children.get(u.managerId) || [];
      list.push(u);
      children.set(u.managerId, list);
    }
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeId.localeCompare(b.employeeId));
  }
  const ordered: ExportUserRef[] = [];
  const seen = new Set<string>();
  const bfs = (roots: ExportUserRef[]) => {
    const queue = [...roots];
    while (queue.length > 0) {
      const u = queue.shift()!;
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      ordered.push(u);
      for (const child of children.get(u.id) || []) queue.push(child);
    }
  };
  const anchor = anchorId ? byId.get(anchorId) : undefined;
  if (anchor) bfs([anchor]);
  const roots = users
    .filter(u => !u.managerId || !byId.has(u.managerId) || u.managerId === u.id)
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeId.localeCompare(b.employeeId));
  bfs(roots);
  const rest = users
    .filter(u => !seen.has(u.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeId.localeCompare(b.employeeId));
  bfs(rest);
  return ordered;
}

/**
 * Team-wise Leads-sheet rows: per-person sections in tree order.
 * Each section is a header row ("-- Name (EMPID) --"), the person's
 * lead rows, and a subtotal row ("Subtotal -- Name: N leads").
 * Leads whose assignee is not among `orderedUsers` (including
 * unassigned leads) close the sheet in an "Unassigned / Other"
 * section so no exported lead ever disappears from the sheet.
 */
export function buildTeamwiseLeadRows(
  leads: ExportLead[],
  orderedUsers: ExportUserRef[]
): Array<Record<string, any>> {
  const rows: Array<Record<string, any>> = [];
  const byAssignee = new Map<string, ExportLead[]>();
  for (const lead of leads) {
    const list = byAssignee.get(lead.assigneeKey) || [];
    list.push(lead);
    byAssignee.set(lead.assigneeKey, list);
  }
  const emitSection = (title: string, sectionLeads: ExportLead[]) => {
    if (sectionLeads.length === 0) return;
    rows.push({ 'Lead ID': title });
    for (const lead of sectionLeads) rows.push(shapeLeadExportRow(lead));
    rows.push({ 'Lead ID': `Subtotal -- ${title.replace(/^--\s+|\s+--$/g, '')}: ${sectionLeads.length} leads` });
  };
  const known = new Set<string>();
  for (const user of orderedUsers) {
    known.add(user.id);
    const label = user.employeeId ? `${user.fullName} (${user.employeeId})` : user.fullName;
    emitSection(`-- ${label} --`, byAssignee.get(user.id) || []);
  }
  const others: ExportLead[] = [];
  for (const [key, list] of byAssignee.entries()) {
    if (!known.has(key)) others.push(...list);
  }
  emitSection('-- Unassigned / Other --', others);
  return rows;
}

/* ------------------------------------------------------------------ */
/* History events (Lead360 timeline data path)                         */
/* ------------------------------------------------------------------ */

function activityDetailParts(act: ExportActivity): string[] {
  const parts: string[] = [];
  if (act.remarks) parts.push(act.remarks);
  if (act.lossReason) parts.push(`Loss Reason: ${act.lossReason}`);
  if (act.meetingType) parts.push(`Meeting Type: ${act.meetingType}`);
  if (act.nextFollowUpAt) parts.push(`Next follow-up: ${dhaka(act.nextFollowUpAt)}`);
  if (act.nextCallAt) parts.push(`Next call: ${dhaka(act.nextCallAt)}`);
  if (act.meetingAt) parts.push(`Meeting: ${dhaka(act.meetingAt)}`);
  if (act.productName) parts.push(`Product: ${act.productName}`);
  if (act.sumAssured != null) parts.push(`Sum Assured: ${act.sumAssured}`);
  if (act.projectedNcp != null) parts.push(`Projected NCP: ${act.projectedNcp}`);
  if (act.collectedNcp != null) parts.push(`Collected NCP: ${act.collectedNcp}`);
  return parts;
}

function legacyDetailParts(h: any): string[] {
  const parts: string[] = [];
  if (h.remarks) parts.push(String(h.remarks));
  if (h.lossReason) parts.push(`Loss Reason: ${h.lossReason}`);
  if (h.meetingType) parts.push(`Meeting Type: ${h.meetingType}`);
  if (h.nextFollowUpDate) parts.push(`Next follow-up: ${dhaka(h.nextFollowUpDate)}`);
  if (h.nextCallDate) parts.push(`Next call: ${dhaka(h.nextCallDate)}`);
  if (h.meetingDate) parts.push(`Meeting: ${dhaka(h.meetingDate)}`);
  if (h.productName) parts.push(`Product: ${h.productName}`);
  if (h.sumAssured != null && h.sumAssured !== '') parts.push(`Sum Assured: ${h.sumAssured}`);
  return parts;
}

interface RawStatusEvent {
  time: unknown;
  status: string;
  actor: string;
  detailParts: string[];
}

/**
 * Build the History-sheet events for one lead, mirroring Lead360:
 * activities are authoritative; legacy status_history entries are
 * merged only when they do not duplicate an activity (same status
 * at the same instant -- Lead360 dedupes on title+date); assignment
 * history entries become Assignment events. Status events are
 * chained chronologically so each renders "old -> new".
 */
export function buildLeadHistoryEvents(
  lead: ExportLead,
  activities: ExportActivity[],
  nameByEmployeeId: Map<string, string>
): ExportHistoryEvent[] {
  const statusEvents: RawStatusEvent[] = [];

  const acts = [...activities].sort((a, b) => (timeMs(a.createdAt) || 0) - (timeMs(b.createdAt) || 0));
  for (const act of acts) {
    statusEvents.push({
      time: act.createdAt,
      status: act.status || 'Unknown',
      actor: act.actorName || act.actorEmployeeId || '',
      detailParts: activityDetailParts(act),
    });
  }

  // Legacy status_history -- Lead360's dedupe key is title+date where
  // the title embeds the status; the equivalent here is status +
  // instant. Entries surviving the dedupe join the chain.
  const seen = new Set(acts.map(a => `${a.status || 'Unknown'}|${timeMs(a.createdAt)}`));
  const history = Array.isArray(lead.statusHistory) ? lead.statusHistory : [];
  for (const h of history) {
    const status = String(h?.status || 'Unknown');
    const t = timeMs(h?.date);
    const key = `${status}|${t}`;
    if (acts.length > 0 && seen.has(key)) continue;
    const actorRef = String(h?.updatedBy || '');
    statusEvents.push({
      time: h?.date,
      status,
      actor: nameByEmployeeId.get(actorRef.toUpperCase()) || actorRef,
      detailParts: legacyDetailParts(h || {}),
    });
  }

  statusEvents.sort((a, b) => (timeMs(a.time) || 0) - (timeMs(b.time) || 0));

  const events: ExportHistoryEvent[] = [];
  let previousStatus = '';
  for (const ev of statusEvents) {
    const transition = previousStatus
      ? `Status: ${previousStatus} -> ${ev.status}`
      : `Status changed to "${ev.status}"`;
    const detail = [transition, ...ev.detailParts].filter(Boolean).join(' - ');
    events.push({
      leadId: lead.id,
      customerName: lead.customerName,
      time: ev.time,
      actor: ev.actor,
      type: 'Status Change',
      detail,
    });
    if (ev.status) previousStatus = ev.status;
  }

  const assignments = Array.isArray(lead.assignmentHistory) ? lead.assignmentHistory : [];
  for (const a of assignments) {
    const from = String(a?.fromEmployeeId || '');
    const to = String(a?.toEmployeeId || '');
    const detail = from
      ? `Reassigned: ${from} -> ${to}${a?.note ? ` - ${a.note}` : ''}`
      : `Assigned to ${to}${a?.note ? ` - ${a.note}` : ''}`;
    const actorRef = String(a?.changedBy || '');
    events.push({
      leadId: lead.id,
      customerName: lead.customerName,
      time: a?.date,
      actor: nameByEmployeeId.get(actorRef.toUpperCase()) || actorRef,
      type: 'Assignment',
      detail,
    });
  }

  events.sort((a, b) => (timeMs(a.time) || 0) - (timeMs(b.time) || 0));
  return events;
}

/** Shape one history event into a History-sheet record. */
export function shapeHistoryExportRow(event: ExportHistoryEvent): Record<string, any> {
  return {
    'Lead ID': event.leadId,
    'Customer Name': event.customerName,
    'Event Time': dhaka(event.time),
    'Actor': event.actor,
    'Event Type': event.type,
    'Detail': event.detail,
  };
}
