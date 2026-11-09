/**
 * production/notifications.routes.ts — NOTIFICATIONS domain of the
 * production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the six notification
 * handlers that used to live inline in production.routes.ts — user
 * and lead-scoped reads, the generic create, mark-read, mark-all-read
 * and clear — moved verbatim, together with their exclusive row
 * mapper / select fragment. Shared helpers are imported from
 * ./shared.js (one definition, shared with the monolith).
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import {
  checkCronAuthorization,
  deleteOwnPushSubscription,
  getVapidConfig,
  runDailyPushReminders,
  upsertPushSubscription,
  validatePushSubscriptionInput,
} from '../../services/PushReminderService.js';
import { runMeetingReminders } from '../../services/MeetingNotificationService.js';
import {
  asUuid,
  callerIsAdmin,
  clean,
  dbErrorStatus,
  demoModeAllowed,
  findLeadByIdRaw,
  getCallerDbInfo,
  hasPermissionCode,
  isCanonicalLowerUuid,
  isLeadAccessible,
  isSelfRef,
  requireAuth,
  requireSelfOrAdmin,
  resolveCallerVisibility,
  resolveUserId,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';

const router = Router();

function mapNotificationRow(row: any) {
  return {
    id: row.id,
    userId: row.recipient_key || row.user_employee_id || row.user_id,
    title: row.title,
    message: row.message,
    leadId: row.lead_code || row.reference_id || '',
    read: row.is_read === true,
    date: row.created_at,
  };
}

const NOTIFICATION_SELECT = `
  SELECT n.*, u.employee_id AS user_employee_id
  FROM notifications n
  LEFT JOIN users u ON u.id = n.user_id
`;

/* ====================================================================
   NOTIFICATIONS
==================================================================== */

router.get('/notifications/users/:userId', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    const list = fallbackStore.notifications
      .filter(item => item.userId === req.params.userId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return sendJson(res, 200, list);
  }
  try {
    const pool = getPool();
    const uuid = asUuid(req.params.userId);
    // Performance audit (docs/DATABASE_PERFORMANCE_AUDIT.md):
    //  1. the legacy cast-to-text user_id branch was provably redundant
    //     (whenever it matched, $1 was a canonical uuid already covered
    //     by `n.user_id = $2`) — removed;
    //  2. the legacy `user_id IN (SELECT ... UPPER(employee_id) ...)`
    //     hashed SubPlan made the planner estimate ~50% of the table
    //     regardless of scale, defeating every index on this query.
    //     employee_id is UNIQUE, so that subquery returns at most one
    //     users.id — resolving it with one tiny indexed lookup first
    //     keeps the result set EXACTLY the same while every remaining
    //     branch is a plain equality the indexes can serve.
    const empMatch = await pool.query(
      `SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1) LIMIT 1`,
      [req.params.userId]
    );
    const empUserId = empMatch.rows[0]?.id || null;
    const result = await pool.query(
      `${NOTIFICATION_SELECT}
       WHERE n.recipient_key = $1 OR n.user_id = $2 OR n.user_id = $3
       ORDER BY n.created_at DESC`,
      [req.params.userId, uuid || null, empUserId]
    );
    return sendJson(res, 200, result.rows.map(mapNotificationRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification fetch failed' });
  }
});

/**
 * Lead-scoped read: the notification history of a lead is only exposed
 * for leads the caller is already allowed to see. Same boundary as
 * GET /leads/:id (leads.view + server-side Data Visibility); an
 * inaccessible lead answers 404 so lead existence is not leaked.
 * (Previously plain requireAuth: any authenticated employee could read
 * the notification history of any lead, bypassing Data Visibility.)
 */
router.get('/notifications/leads/:leadId', requireAuth, async (req, res) => {
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!(await hasPermissionCode(caller, 'leads.view'))) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view leads.' });
    }
    const leadParam = String(req.params.leadId || '').trim();
    if (!leadParam) return sendJson(res, 400, { success: false, message: 'Lead id is required.' });

    const visibility = await resolveCallerVisibility(caller);
    const leadRow = await findLeadByIdRaw(leadParam, false);
    if (!leadRow || !isLeadAccessible(leadRow, visibility, caller)) {
      return sendJson(res, 404, { success: false, message: 'Lead not found.' });
    }

    if (!useDb()) {
      const list = fallbackStore.notifications
        .filter(item => item.leadId === leadParam)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return sendJson(res, 200, list);
    }
    const uuid = asUuid(leadParam);
    // The legacy cast-to-text reference_id branch was provably redundant:
    // whenever it matched, the parameter was a canonical uuid already
    // covered by `n.reference_id = $2`. Removing it is result-identical
    // and leaves only sargable branches.
    const result = await getPool().query(
      `${NOTIFICATION_SELECT}
       WHERE n.lead_code = $1 OR n.reference_id = $2
       ORDER BY n.created_at DESC`,
      [leadParam, uuid || null]
    );
    return sendJson(res, 200, result.rows.map(mapNotificationRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification fetch failed' });
  }
});

/**
 * Cross-user boundary (audit fix):
 *   - notifying SELF is a self-service action (authenticated only);
 *   - notifying ANOTHER user is a cross-user mutation. The only business
 *     flow that produces cross-user notifications is the lead
 *     assignment/transfer fan-out, so it requires one of the canonical
 *     routing grants (leads.assign / leads.transfer) — fail closed for
 *     everyone else instead of letting any authenticated employee push
 *     notifications to arbitrary accounts.
 */
router.post('/notifications', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const userIdRef = clean(payload.userId || payload.user_id);
  const title = clean(payload.title);
  const message = clean(payload.message);
  if (!userIdRef || !title) {
    return sendJson(res, 400, { success: false, message: 'userId and title are required' });
  }

  if (!isSelfRef(req, userIdRef)) {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    const [canAssign, canTransfer] = await Promise.all([
      hasPermissionCode(caller, 'leads.assign'),
      hasPermissionCode(caller, 'leads.transfer'),
    ]);
    if (!canAssign && !canTransfer) {
      return sendJson(res, 403, { success: false, message: 'You do not have permission to notify another user.' });
    }
  }

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = {
      id: payload.id || createId('notification'),
      userId: userIdRef,
      title,
      message: message || '',
      leadId: clean(payload.leadId),
      read: !!payload.read,
      date: payload.date || new Date().toISOString(),
    };
    fallbackStore.notifications.push(item);
    return sendJson(res, 200, { success: true, data: item });
  }

  try {
    const resolvedUserId = await resolveUserId(userIdRef);
    if (!resolvedUserId) {
      return sendJson(res, 400, { success: false, message: 'Recipient user does not exist.' });
    }
    const result = await getPool().query(
      `INSERT INTO notifications (user_id, recipient_key, title, message, lead_code, reference_id,
                                  is_read, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'info', NOW(), NOW())
       RETURNING *`,
      [resolvedUserId, userIdRef, title, message || null, clean(payload.leadId).slice(0, 50) || null,
        asUuid(payload.leadId), !!payload.read]
    );
    return sendJson(res, 201, { success: true, data: mapNotificationRow(result.rows[0]) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification save failed' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const item = fallbackStore.notifications.find(n => n.id === req.params.id);
    if (!item) return sendJson(res, 404, { success: false, message: 'Notification not found' });
    item.read = true;
    return sendJson(res, 200, { success: true, data: item });
  }
  try {
    // Sargable PK lookup; malformed (non-canonical-UUID) ids yield no row
    // and 404, exactly like the legacy id::text comparison.
    const found = await getPool().query(
      `SELECT n.*, u.employee_id AS user_employee_id, u.email AS user_email
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.id = $1 LIMIT 1`,
      [isCanonicalLowerUuid(req.params.id) ? req.params.id : null]
    );
    if (!found.rows[0]) return sendJson(res, 404, { success: false, message: 'Notification not found' });
    if (!callerIsAdmin(req)) {
      const row = found.rows[0];
      const owned = isSelfRef(req, row.recipient_key) ||
        isSelfRef(req, row.user_id) ||
        isSelfRef(req, row.user_employee_id) ||
        isSelfRef(req, row.user_email);
      if (!owned) {
        return sendJson(res, 403, { success: false, message: 'You can only access your own notifications.' });
      }
    }
    const result = await getPool().query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [found.rows[0].id]
    );
    return sendJson(res, 200, { success: true, data: mapNotificationRow(result.rows[0]) });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification update failed' });
  }
});

router.post('/notifications/users/:userId/read-all', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.notifications.filter(n => n.userId === req.params.userId).forEach(n => { n.read = true; });
    return sendJson(res, 200, { success: true });
  }
  try {
    const uuid = asUuid(req.params.userId);
    // Same shape as the notification list query: the cast-to-text branch
    // is gone and the employee_id subquery is pre-resolved to one users.id
    // (employee_id is UNIQUE), so every branch is an index-served equality.
    const empMatch = await getPool().query(
      `SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1) LIMIT 1`,
      [req.params.userId]
    );
    const empUserId = empMatch.rows[0]?.id || null;
    await getPool().query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE recipient_key = $1 OR user_id = $2 OR user_id = $3`,
      [req.params.userId, uuid || null, empUserId]
    );
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification update failed' });
  }
});

/* ====================================================================
   WEB PUSH — free follow-up reminders (Phase 2 PR #2)
   ------------------------------------------------------------------
   Opt-in per device: an agent enables reminders (Profile settings),
   the browser's PushSubscription is stored (migration 048), and the
   daily cron sends ONE summary push — "আজ Xটি follow-up due, Yটি
   overdue" — that opens the Daily Workbench. Zero-cost: Web Push
   protocol only. When the VAPID env vars are unset the whole feature
   is disabled gracefully (public-key answers enabled:false, subscribe
   answers 503, the cron no-ops) and nothing else changes.
==================================================================== */

router.get('/notifications/push/public-key', requireAuth, async (_req, res) => {
  const vapid = getVapidConfig();
  if (!vapid) return sendJson(res, 200, { success: true, data: { enabled: false } });
  return sendJson(res, 200, { success: true, data: { enabled: true, publicKey: vapid.publicKey } });
});

router.post('/notifications/push/subscribe', requireAuth, async (req, res) => {
  if (!getVapidConfig()) {
    return sendJson(res, 503, { success: false, message: 'Push reminders are not enabled on this server.' });
  }
  const validation = validatePushSubscriptionInput(req.body);
  if (validation.ok === false) {
    return sendJson(res, 400, { success: false, message: validation.message });
  }
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!useDb() && !demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    }
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const saved = await upsertPushSubscription(caller.id, validation.value, userAgent);
    return sendJson(res, 200, {
      success: true,
      data: { id: saved.id, endpoint: saved.endpoint, subscribed: true },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Push subscription failed' });
  }
});

router.post('/notifications/push/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || '').trim();
  if (!endpoint) {
    return sendJson(res, 400, { success: false, message: 'endpoint is required.' });
  }
  try {
    const caller = await getCallerDbInfo(req);
    if (!caller) {
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }
    if (!useDb() && !demoModeAllowed()) {
      return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    }
    // Self-scoped by construction: only the caller's own device row
    // for this endpoint can be removed (see PushReminderService).
    const removed = await deleteOwnPushSubscription(caller.id, endpoint);
    return sendJson(res, 200, { success: true, data: { removed } });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Push unsubscribe failed' });
  }
});

/**
 * Daily reminder cron. NOT user-authenticated: Vercel Cron invokes it
 * with `Authorization: Bearer <CRON_SECRET>` (accepted also as the
 * `x-cron-secret` header for operator triggers). CRON_SECRET unset →
 * the endpoint is disabled (503); a wrong secret → 401. VAPID unset →
 * a clean no-op (200, enabled:false) so a cron that fires before the
 * keys are configured can never error the schedule.
 */
router.get('/notifications/push/cron-daily', async (req, res) => {
  const auth = checkCronAuthorization(req.headers as Record<string, unknown>);
  if (auth === 'disabled') {
    return sendJson(res, 503, { success: false, message: 'The reminder cron is not configured (CRON_SECRET is unset).' });
  }
  if (auth === 'unauthorized') {
    return sendJson(res, 401, { success: false, message: 'Invalid cron secret.' });
  }
  try {
    const summary = await runDailyPushReminders(new Date());
    return sendJson(res, 200, { success: true, data: summary });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error?.message || 'Daily push run failed' });
  }
});

/**
 * Meeting-reminder runner (calendar upgrade PR E). Same cron-secret
 * guard as the daily endpoint above (CRON_SECRET unset → 503, wrong
 * secret → 401). There is deliberately NO high-frequency Vercel cron
 * for this — the free plan cannot run one — so an external scheduler
 * (e.g. cron-job.org) calls this endpoint every ~15 minutes with the
 * `x-cron-secret` header, exactly the documented fallback pattern of
 * the daily cron. Each run scans a 20-minute due window and delivery
 * is idempotent per (activity, recipient, scheduled_at), so
 * overlapping or repeated calls never double-send. In-app reminders
 * are created whether or not Web Push (VAPID) is configured.
 */
async function handleMeetingReminderCron(req: any, res: any) {
  const auth = checkCronAuthorization(req.headers as Record<string, unknown>);
  if (auth === 'disabled') {
    return sendJson(res, 503, { success: false, message: 'The reminder cron is not configured (CRON_SECRET is unset).' });
  }
  if (auth === 'unauthorized') {
    return sendJson(res, 401, { success: false, message: 'Invalid cron secret.' });
  }
  try {
    const summary = await runMeetingReminders(new Date());
    return sendJson(res, 200, { success: true, data: summary });
  } catch (error: any) {
    return sendJson(res, 500, { success: false, message: error?.message || 'Meeting reminder run failed' });
  }
}

router.get('/notifications/push/cron-meeting-reminders', handleMeetingReminderCron);
router.post('/notifications/push/cron-meeting-reminders', handleMeetingReminderCron);

router.delete('/notifications/users/:userId', requireAuth, requireSelfOrAdmin('userId'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.notifications = fallbackStore.notifications.filter(n => n.userId !== req.params.userId);
    return sendJson(res, 200, { success: true });
  }
  try {
    const uuid = asUuid(req.params.userId);
    // Same shape as the notification list query: the cast-to-text branch
    // is gone and the employee_id subquery is pre-resolved to one users.id
    // (employee_id is UNIQUE), so every branch is an index-served equality.
    const empMatch = await getPool().query(
      `SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1) LIMIT 1`,
      [req.params.userId]
    );
    const empUserId = empMatch.rows[0]?.id || null;
    await getPool().query(
      `DELETE FROM notifications
       WHERE recipient_key = $1 OR user_id = $2 OR user_id = $3`,
      [req.params.userId, uuid || null, empUserId]
    );
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Notification delete failed' });
  }
});

export default router;
