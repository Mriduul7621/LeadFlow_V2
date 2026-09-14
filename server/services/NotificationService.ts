/**
 * NotificationService — server-side reliable notification delivery
 * ------------------------------------------------------------------
 * Server-authoritative notification creation for business events.
 * Replaces client-driven fire-and-forget notification fan-out with
 * durable, idempotent, transactional PostgreSQL writes.
 *
 * DESIGN:
 *   - Every system notification carries an idempotency_key derived from
 *     stable business data (event_type + entity_id + recipient + version).
 *     A DB unique partial index enforces at-most-once delivery.
 *   - Recipient resolution uses the authoritative users.manager_id graph
 *     (reporting_chain column), never client-supplied IDs.
 *   - Hierarchy traversal is bounded and cycle-safe.
 *   - Notifications are created in the same DB transaction as the
 *     business mutation. If notification INSERT fails, the entire
 *     transaction rolls back (Option A — transactional atomicity).
 *
 * This module is imported ONLY by production.routes.ts — it never
 * touches the client-side notificationService.ts.
 */

import { getPool, isDatabaseConfigured } from '../database/connection.js';
import { fallbackStore, createId } from '../fallbackStore.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SystemNotificationInput {
  userId: string;          // users.id (UUID) of recipient
  recipientKey: string;    // employee_id used as display key
  title: string;
  message: string;
  eventType: string;       // e.g. 'lead-assigned', 'lead-reassigned'
  idempotencyKey: string;  // deterministic dedupe key
  leadId?: string;         // leads.id (UUID) reference
  leadCode?: string;       // lead_code display reference
  referenceType?: string;  // 'lead', 'scheduled_activity', etc.
}

export interface UplineRecipient {
  userId: string;
  employeeId: string;
}

// ── Idempotency Key Construction ────────────────────────────────────

/**
 * Build a stable idempotency key for a system notification.
 * Format: eventType:entityId:recipientId:version
 *
 * This key is deterministic for the same business event + recipient,
 * so retries of the same mutation never create duplicate rows.
 */
export function buildIdempotencyKey(
  eventType: string,
  entityId: string,
  recipientId: string,
  version: string = 'v1',
): string {
  return `${eventType}:${entityId}:${recipientId}:${version}`;
}

// ── Hierarchy Resolution (Server-Side) ──────────────────────────────

/**
 * Resolve upline manager chain for a user using the authoritative
 * users.reporting_chain column (JSONB array of employee_ids, ordered
 * from direct manager up to CEO).
 *
 * Falls back to manager_id traversal when reporting_chain is empty.
 *
 * Returns de-duplicated active managers, excluding the starting user.
 * Bounded to 20 levels to prevent runaway traversal on corrupt data.
 */
export async function resolveUplineRecipients(
  exec: { query: Function },
  startUserId: string,
  startEmployeeId: string,
  excludeUserId?: string,
): Promise<UplineRecipient[]> {
  const recipients: UplineRecipient[] = [];
  const visited = new Set<string>();

  // Don't notify the starting user
  visited.add(startUserId.toUpperCase());
  if (excludeUserId) visited.add(excludeUserId.toUpperCase());

  if (!isDatabaseConfigured()) {
    // Dev-demo fallback: walk fallbackStore users by managerId
    const allUsers = fallbackStore.users;
    let currentEmpId = startEmployeeId;
    let depth = 0;
    while (currentEmpId && depth < 20) {
      const current = allUsers.find(
        u => String(u.employeeId || '').toUpperCase() === currentEmpId.toUpperCase()
      );
      if (!current) break;
      const mgrId = String(current.managerId || current.reportingManagerId || '');
      if (!mgrId) break;
      const manager = allUsers.find(
        u => String(u.employeeId || '').toUpperCase() === mgrId.toUpperCase()
      );
      if (!manager) break;
      const mgrUserId = manager.id;
      const mgrEmpId = String(manager.employeeId || '');
      if (!visited.has(mgrUserId.toUpperCase())) {
        visited.add(mgrUserId.toUpperCase());
        if (String(manager.status || '').toLowerCase() !== 'inactive' &&
            manager.isActive !== false) {
          recipients.push({ userId: mgrUserId, employeeId: mgrEmpId });
        }
      }
      currentEmpId = mgrEmpId;
      depth++;
    }
    return recipients;
  }

  // PostgreSQL path: use reporting_chain for efficiency
  const result = await exec.query(
    `SELECT u.id, u.employee_id, u.reporting_chain, u.is_active, u.manager_id
     FROM users u
     WHERE u.id = $1
     LIMIT 1`,
    [startUserId],
  );
  const user = result.rows[0];
  if (!user) return recipients;

  const chain: string[] = Array.isArray(user.reporting_chain)
    ? user.reporting_chain
    : [];

  if (chain.length > 0) {
    // reporting_chain is an array of employee_ids from direct manager upward
    // Resolve them to user IDs in one query
    const chainResult = await exec.query(
      `SELECT u.id, u.employee_id, u.is_active
       FROM users u
       WHERE UPPER(u.employee_id) = ANY($1::text[])
         AND u.is_active = TRUE
       ORDER BY u.created_at ASC`,
      [chain.map((e: string) => String(e).toUpperCase())],
    );

    // Preserve chain order (direct manager first)
    const empOrder = chain.map((e: string) => String(e).toUpperCase());
    const sorted = chainResult.rows.sort((a: any, b: any) => {
      const ai = empOrder.indexOf(String(a.employee_id).toUpperCase());
      const bi = empOrder.indexOf(String(b.employee_id).toUpperCase());
      return ai - bi;
    });

    for (const row of sorted) {
      const uid = String(row.id);
      if (!visited.has(uid.toUpperCase())) {
        visited.add(uid.toUpperCase());
        recipients.push({ userId: uid, employeeId: String(row.employee_id) });
      }
    }
  } else {
    // Fallback: walk manager_id chain
    let currentManagerId: string | null = user.manager_id;
    let depth = 0;
    while (currentManagerId && depth < 20) {
      if (visited.has(currentManagerId.toUpperCase())) break;
      const mgrResult = await exec.query(
        `SELECT u.id, u.employee_id, u.is_active, u.manager_id
         FROM users u
         WHERE u.id = $1
         LIMIT 1`,
        [currentManagerId],
      );
      const mgr = mgrResult.rows[0];
      if (!mgr) break;
      const mgrId = String(mgr.id);
      visited.add(mgrId.toUpperCase());
      if (mgr.is_active !== false) {
        recipients.push({ userId: mgrId, employeeId: String(mgr.employee_id) });
      }
      currentManagerId = mgr.manager_id || null;
      depth++;
    }
  }

  return recipients;
}

// ── Notification Insert ─────────────────────────────────────────────

/**
 * Insert a single notification with idempotency protection.
 * Uses ON CONFLICT DO NOTHING on the idempotency_key unique index
 * so retries are safe.
 *
 * Returns the inserted row, or null if the idempotency key already existed.
 *
 * NOTE: This function does NOT catch errors. Callers must wrap the call
 * in a SAVEPOINT so that a notification failure (e.g. missing table in
 * test DB) does not abort the parent business transaction.
 */
export async function insertNotificationWithIdempotency(
  exec: { query: Function },
  input: SystemNotificationInput,
): Promise<any | null> {
  const result = await exec.query(
    `INSERT INTO notifications (
       user_id, recipient_key, title, message,
       event_type, idempotency_key,
       lead_code, reference_id, reference_type,
       is_read, type, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, 'info', NOW(), NOW())
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      input.userId,
      input.recipientKey,
      input.title,
      input.message,
      input.eventType,
      input.idempotencyKey,
      input.leadCode || null,
      input.leadId || null,
      input.referenceType || 'lead',
    ],
  );
  return result.rows[0] || null; // null = already existed (idempotent skip)
}

// ── Batch Assignment Notifications ──────────────────────────────────

/**
 * Create all notifications for a lead assignment/reassignment event.
 *
 * Notifications created:
 *   1. "New Lead Assigned" to the assignee
 *   2. "Team Lead Assigned Upline Alert" to each active manager in the
 *      assignee's reporting chain
 *
 * All inserts run inside the provided transaction client so they commit
 * atomically with the business mutation.
 *
 * @param exec     - transaction client (or pool)
 * @param leadId   - leads.id UUID
 * @param leadCode - lead_code display string
 * @param prospectName - customer name for notification text
 * @param assignedToUserId - users.id of the new assignee
 * @param assignedToEmployeeId - employee_id of the new assignee
 * @param changedByEmployeeId - employee_id of the person who made the change
 * @param eventType - 'lead-assigned' or 'lead-reassigned'
 * @param assignmentHistoryId - unique ID for the assignment event (for idempotency)
 * @param excludeNotifyUserId - optional user to exclude from notifications (e.g. the actor)
 */
export async function createAssignmentNotifications(
  exec: { query: Function },
  opts: {
    leadId: string;
    leadCode: string;
    prospectName: string;
    assignedToUserId: string;
    assignedToEmployeeId: string;
    changedByEmployeeId: string;
    eventType: string;
    assignmentHistoryId: string;
    excludeNotifyUserId?: string;
  },
): Promise<{ created: number; skipped: number; failed: number }> {
  const {
    leadId,
    leadCode,
    prospectName,
    assignedToUserId,
    assignedToEmployeeId,
    changedByEmployeeId,
    eventType,
    assignmentHistoryId,
    excludeNotifyUserId,
  } = opts;

  let created = 0;
  let skipped = 0;
  let failed = 0;

  // 1. Notify the assignee
  const assigneeKey = buildIdempotencyKey(eventType, assignmentHistoryId, assignedToUserId);
  const assigneeResult = await insertNotificationWithIdempotency(exec, {
    userId: assignedToUserId,
    recipientKey: assignedToEmployeeId,
    title: 'New Lead Assigned',
    message: `Lead '${prospectName}' has been assigned to you by ${changedByEmployeeId}.`,
    eventType,
    idempotencyKey: assigneeKey,
    leadId,
    leadCode,
    referenceType: 'lead',
  });
  if (assigneeResult) created++;
  else skipped++;

  // 2. Resolve and notify upline managers
  const upline = await resolveUplineRecipients(
    exec,
    assignedToUserId,
    assignedToEmployeeId,
    excludeNotifyUserId,
  );

  for (const manager of upline) {
    const mgrKey = buildIdempotencyKey(eventType, assignmentHistoryId, manager.userId);
    const mgrResult = await insertNotificationWithIdempotency(exec, {
      userId: manager.userId,
      recipientKey: manager.employeeId,
      title: 'Team Lead Assigned Upline Alert',
      message: `Lead '${prospectName}' under your team tracking has been routed to assignee: ${assignedToEmployeeId} by ${changedByEmployeeId}.`,
      eventType,
      idempotencyKey: mgrKey,
      leadId,
      leadCode,
      referenceType: 'lead',
    });
    if (mgrResult) created++;
    else skipped++;
  }

  return { created, skipped, failed };
}

/**
 * Create assignment notifications for demo mode (fallbackStore).
 * Mirrors createAssignmentNotifications for in-memory store.
 */
export function createAssignmentNotificationsDemo(
  opts: {
    leadId: string;
    leadCode: string;
    prospectName: string;
    assignedToUserId: string;
    assignedToEmployeeId: string;
    changedByEmployeeId: string;
    eventType: string;
    assignmentHistoryId: string;
  },
): { created: number; skipped: number } {
  const {
    leadId,
    prospectName,
    assignedToEmployeeId,
    changedByEmployeeId,
    eventType,
    assignmentHistoryId,
  } = opts;

  let created = 0;
  let skipped = 0;

  // Check for existing notification (demo-mode idempotency)
  const existing = (fallbackStore as any).notifications || [];
  const existingKeys = new Set(
    existing.map((n: any) => n.idempotencyKey).filter(Boolean)
  );

  // Notify assignee
  const assigneeKey = buildIdempotencyKey(eventType, assignmentHistoryId, assignedToEmployeeId);
  if (!existingKeys.has(assigneeKey)) {
    const assignee = fallbackStore.users.find(
      u => String(u.employeeId || '').toUpperCase() === assignedToEmployeeId.toUpperCase()
    );
    if (assignee) {
      (fallbackStore as any).notifications.push({
        id: createId('notification'),
        userId: assignee.id,
        title: 'New Lead Assigned',
        message: `Lead '${prospectName}' has been assigned to you by ${changedByEmployeeId}.`,
        leadId,
        read: false,
        date: new Date().toISOString(),
        eventType,
        idempotencyKey: assigneeKey,
      });
      created++;
    } else {
      skipped++;
    }
  } else {
    skipped++;
  }

  // Notify upline (demo mode hierarchy walk)
  let currentEmpId = assignedToEmployeeId;
  const visited = new Set<string>([assignedToEmployeeId.toUpperCase()]);
  let depth = 0;

  while (currentEmpId && depth < 20) {
    const current = fallbackStore.users.find(
      u => String(u.employeeId || '').toUpperCase() === currentEmpId.toUpperCase()
    );
    if (!current) break;
    const mgrId = String(current.managerId || current.reportingManagerId || '');
    if (!mgrId) break;
    if (visited.has(mgrId.toUpperCase())) break;
    visited.add(mgrId.toUpperCase());

    const manager = fallbackStore.users.find(
      u => String(u.employeeId || '').toUpperCase() === mgrId.toUpperCase()
    );
    if (manager && manager.isActive !== false && String(manager.status || '').toLowerCase() !== 'inactive') {
      const mgrKey = buildIdempotencyKey(eventType, assignmentHistoryId, String(manager.employeeId));
      if (!existingKeys.has(mgrKey)) {
        (fallbackStore as any).notifications.push({
          id: createId('notification'),
          userId: manager.id,
          title: 'Team Lead Assigned Upline Alert',
          message: `Lead '${prospectName}' under your team tracking has been routed to assignee: ${assignedToEmployeeId} by ${changedByEmployeeId}.`,
          leadId,
          read: false,
          date: new Date().toISOString(),
          eventType,
          idempotencyKey: mgrKey,
        });
        created++;
      } else {
        skipped++;
      }
    }
    currentEmpId = String(manager?.employeeId || '');
    depth++;
  }

  return { created, skipped };
}
