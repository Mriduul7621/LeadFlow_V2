/**
 * PushReminderService.ts — FREE Web Push follow-up reminders (Phase 2 PR #2)
 * ------------------------------------------------------------------
 * Once each morning (Asia/Dhaka), every agent who opted in receives ONE
 * summary push on their phone — "আজ Xটি follow-up due, Yটি overdue" —
 * and tapping it opens the Daily Workbench (/workbench). Nothing is
 * ever sent to customers; this reminds the AGENT about their own queue.
 *
 * ZERO-COST DESIGN: delivery uses the Web Push protocol via the free
 * `web-push` library and the push services browsers already operate
 * (FCM / Mozilla / Apple). There is no paid push provider, no SMS
 * gateway and no per-message charge. The feature is entirely opt-in
 * per device (push_subscriptions, migration 048) and fully DISABLED
 * when the VAPID env vars are unset — every entry point degrades to a
 * clean no-op / "not enabled" answer instead of an error.
 *
 * Pieces:
 *   - VAPID config + cron-secret check (pure, env-injectable);
 *   - subscription input validation (pure);
 *   - subscription storage (DB via push_subscriptions, or the
 *     fallbackStore demo mirror when no database is configured);
 *   - the daily counts, composed from the SAME filters the follow-up
 *     queue endpoint uses (server/utils/businessTime.ts day bounds +
 *     terminal-status exclusion + the caller's Data Visibility scope);
 *   - the payload builder (pure) and the cron runner, with the actual
 *     network sender behind an injectable seam (`_setPushSenderForTest`,
 *     mirroring connection.ts's `_setTestPoolForTest` convention) so
 *     tests never touch a real push service.
 */
import { timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import { getPool } from '../database/connection.js';
import { createId, fallbackStore } from '../fallbackStore.js';
import {
  classifyFollowUpBucket,
  getDhakaBusinessDayBounds,
  TERMINAL_LEAD_STATUSES,
} from '../utils/businessTime.js';
import {
  normalizeRole,
  resolveCallerVisibility,
  useDb,
  type CallerDbInfo,
} from '../routes/production/shared.js';

/* ====================================================================
   Configuration (VAPID + cron secret)
==================================================================== */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@shantalife.com';

/** The VAPID key pair, or null when push reminders are not configured. */
export function getVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) return null;
  const subject = String(env.VAPID_SUBJECT || '').trim() || DEFAULT_VAPID_SUBJECT;
  return { publicKey, privateKey, subject };
}

export function isPushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getVapidConfig(env) !== null;
}

export type CronAuthResult = 'ok' | 'disabled' | 'unauthorized';

/**
 * The daily cron endpoint is guarded by CRON_SECRET only (Vercel Cron
 * sends it as `Authorization: Bearer <secret>`; `x-cron-secret` is
 * accepted for manual/operator triggers). An unset secret DISABLES
 * the endpoint — it never falls back to "open".
 */
export function checkCronAuthorization(
  headers: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): CronAuthResult {
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) return 'disabled';
  const bearer = String(headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const headerSecret = String(headers['x-cron-secret'] || '');
  const matches = (candidate: string): boolean => {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return matches(bearer) || matches(headerSecret) ? 'ok' : 'unauthorized';
}

/* ====================================================================
   Subscription input validation (pure)
==================================================================== */

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSubscriptionValidation =
  | { ok: true; value: PushSubscriptionInput }
  | { ok: false; message: string };

const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Validate a browser PushSubscription JSON body:
 * `{ endpoint, keys: { p256dh, auth } }` (flat p256dh/auth also accepted).
 * Endpoints are always https URLs issued by a push service; p256dh is
 * the 65-byte ECDH public key (~87 base64url chars) and auth the 16-byte
 * secret (~22 chars) — bounds are generous, shape is strict.
 */
export function validatePushSubscriptionInput(body: any): PushSubscriptionValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'A push subscription object is required.' };
  }
  const endpoint = String(body.endpoint || '').trim();
  if (!endpoint || endpoint.length > 4096) {
    return { ok: false, message: 'A valid push subscription endpoint is required.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, message: 'The push subscription endpoint is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, message: 'The push subscription endpoint must be an https URL.' };
  }
  const keys = body.keys && typeof body.keys === 'object' ? body.keys : body;
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!p256dh || p256dh.length < 40 || p256dh.length > 200 || !BASE64URL_RE.test(p256dh)) {
    return { ok: false, message: 'The subscription p256dh key is missing or malformed.' };
  }
  if (!auth || auth.length < 8 || auth.length > 100 || !BASE64URL_RE.test(auth)) {
    return { ok: false, message: 'The subscription auth key is missing or malformed.' };
  }
  return { ok: true, value: { endpoint, p256dh, auth } };
}

/* ====================================================================
   Subscription storage (DB or demo fallback mirror)
==================================================================== */

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

function mapSubscriptionRow(row: any): StoredPushSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent || null,
  };
}

/** Insert or refresh the subscription for an endpoint (endpoint is unique). */
export async function upsertPushSubscription(
  userId: string,
  input: PushSubscriptionInput,
  userAgent: string | null,
): Promise<StoredPushSubscription> {
  if (!useDb()) {
    const nowIso = new Date().toISOString();
    const existing = fallbackStore.pushSubscriptions.find(s => s.endpoint === input.endpoint);
    if (existing) {
      existing.userId = userId;
      existing.p256dh = input.p256dh;
      existing.auth = input.auth;
      existing.userAgent = userAgent || undefined;
      existing.lastSeenAt = nowIso;
      return {
        id: existing.id, userId: existing.userId, endpoint: existing.endpoint,
        p256dh: existing.p256dh, auth: existing.auth, userAgent: existing.userAgent || null,
      };
    }
    const record = {
      id: createId('pushsub'),
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: userAgent || undefined,
      createdAt: nowIso,
      lastSeenAt: nowIso,
    };
    fallbackStore.pushSubscriptions.push(record);
    return {
      id: record.id, userId: record.userId, endpoint: record.endpoint,
      p256dh: record.p256dh, auth: record.auth, userAgent: record.userAgent || null,
    };
  }
  const result = await getPool().query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           last_seen_at = NOW()
     RETURNING *`,
    [userId, input.endpoint, input.p256dh, input.auth, userAgent],
  );
  return mapSubscriptionRow(result.rows[0]);
}

/**
 * Delete the caller's OWN subscription for an endpoint. Scoped by
 * user_id on purpose: one user can never remove another user's device.
 * Returns true when a row was actually removed.
 */
export async function deleteOwnPushSubscription(userId: string, endpoint: string): Promise<boolean> {
  if (!useDb()) {
    const before = fallbackStore.pushSubscriptions.length;
    fallbackStore.pushSubscriptions = fallbackStore.pushSubscriptions.filter(
      s => !(s.endpoint === endpoint && s.userId === userId),
    );
    return fallbackStore.pushSubscriptions.length < before;
  }
  const result = await getPool().query(
    `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
    [endpoint, userId],
  );
  return (result.rowCount || 0) > 0;
}

/** Every subscription (cron fan-out). Endpoints are unique by schema. */
export async function listPushSubscriptions(): Promise<StoredPushSubscription[]> {
  if (!useDb()) {
    return fallbackStore.pushSubscriptions.map(s => ({
      id: s.id, userId: s.userId, endpoint: s.endpoint,
      p256dh: s.p256dh, auth: s.auth, userAgent: s.userAgent || null,
    }));
  }
  const result = await getPool().query(
    `SELECT * FROM push_subscriptions ORDER BY user_id, created_at`,
  );
  return result.rows.map(mapSubscriptionRow);
}

async function deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  if (!useDb()) {
    fallbackStore.pushSubscriptions = fallbackStore.pushSubscriptions.filter(s => s.endpoint !== endpoint);
    return;
  }
  await getPool().query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

async function touchPushSubscription(endpoint: string): Promise<void> {
  if (!useDb()) {
    const record = fallbackStore.pushSubscriptions.find(s => s.endpoint === endpoint);
    if (record) record.lastSeenAt = new Date().toISOString();
    return;
  }
  await getPool().query(
    `UPDATE push_subscriptions SET last_seen_at = NOW() WHERE endpoint = $1`,
    [endpoint],
  );
}

/* ====================================================================
   Daily follow-up counts (same rules as GET /leads/follow-ups)
==================================================================== */

export interface FollowUpReminderCounts {
  dueToday: number;
  overdue: number;
}

/**
 * Due-today + overdue counts for ONE caller, under that caller's own
 * Data Visibility scope — the exact filters of the follow-up queue:
 * not deleted, a next follow-up exists, terminal statuses excluded,
 * Dhaka business-day bounds. A user only ever gets counts for leads
 * they are allowed to see (managers: their visible downline, matching
 * the Workbench they land on).
 */
export async function computeFollowUpReminderCounts(
  caller: CallerDbInfo,
  now: Date = new Date(),
): Promise<FollowUpReminderCounts> {
  const bounds = getDhakaBusinessDayBounds(now);
  const visibility = await resolveCallerVisibility(caller);

  if (!useDb()) {
    const terminal = new Set(TERMINAL_LEAD_STATUSES.map(s => s.toLowerCase()));
    const visEmp = (visibility.employeeIds || []).map((e: string) => String(e).toUpperCase());
    let dueToday = 0;
    let overdue = 0;
    for (const lead of fallbackStore.leads || []) {
      if ((lead as any).is_deleted === true) continue;
      const nfd = (lead as any).nextFollowUpDate || (lead as any).next_follow_up_at;
      if (!nfd) continue;
      if (!visibility.all) {
        const assigned = String((lead as any).assignedTo || '').toUpperCase();
        if (!assigned || !visEmp.includes(assigned)) continue;
      }
      if (terminal.has(String((lead as any).currentStatus || '').toLowerCase())) continue;
      const bucket = classifyFollowUpBucket(nfd, bounds);
      if (bucket === 'today') dueToday++;
      else if (bucket === 'overdue') overdue++;
    }
    return { dueToday, overdue };
  }

  const params: any[] = [[...TERMINAL_LEAD_STATUSES], bounds.todayStartIso, bounds.tomorrowStartIso];
  let visibilityClause = '';
  if (!visibility.all) {
    params.push(visibility.userIds);
    visibilityClause = `AND (l.assigned_to = ANY($${params.length}::uuid[]) OR l.created_by = ANY($${params.length}::uuid[]))`;
  }
  const result = await getPool().query(
    `SELECT CASE WHEN l.next_follow_up_at < $2::timestamp THEN 'overdue'
                 WHEN l.next_follow_up_at < $3::timestamp THEN 'today'
                 ELSE 'upcoming' END AS bucket,
            COUNT(*)::int AS cnt
     FROM leads l
     WHERE l.is_deleted = FALSE
       AND l.next_follow_up_at IS NOT NULL
       AND l.current_status <> ALL($1::text[])
       ${visibilityClause}
     GROUP BY 1`,
    params,
  );
  const counts: FollowUpReminderCounts = { dueToday: 0, overdue: 0 };
  for (const row of result.rows) {
    if (row.bucket === 'today') counts.dueToday = Number(row.cnt) || 0;
    else if (row.bucket === 'overdue') counts.overdue = Number(row.cnt) || 0;
  }
  return counts;
}

/* ====================================================================
   Payload (pure)
==================================================================== */

export const PUSH_REMINDER_URL = '/workbench';
export const PUSH_REMINDER_TITLE = 'LeadFlow — ফলো-আপ রিমাইন্ডার';

/**
 * The notification payload the service worker renders. Body wording is
 * fixed Bangla, counts first: "আজ Xটি follow-up due, Yটি overdue আছে।"
 * A part is omitted when its count is zero (the runner never calls
 * this with both zero — users with nothing due get no push at all).
 */
export function buildDailyReminderPayload(
  counts: FollowUpReminderCounts,
  url: string = PUSH_REMINDER_URL,
): { title: string; body: string; url: string } {
  const parts: string[] = [];
  if (counts.dueToday > 0) parts.push(`আজ ${counts.dueToday}টি follow-up due`);
  if (counts.overdue > 0) parts.push(`${counts.overdue}টি overdue`);
  const body = parts.length
    ? `${parts.join(', ')} আছে। Workbench-এ দেখে নিন।`
    : 'আজ কোনো follow-up due নেই।';
  return { title: PUSH_REMINDER_TITLE, body, url };
}

/* ====================================================================
   Sender seam + daily runner
==================================================================== */

export interface PushSendTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSenderFn = (target: PushSendTarget, payloadJson: string) => Promise<void>;

let senderOverride: PushSenderFn | null = null;

/** Test seam (mirrors connection.ts `_setTestPoolForTest`): replace
 *  the real Web Push sender so tests never call a push service. */
export function _setPushSenderForTest(fn: PushSenderFn | null): void {
  senderOverride = fn;
}

async function defaultPushSender(target: PushSendTarget, payloadJson: string): Promise<void> {
  const vapid = getVapidConfig();
  if (!vapid) throw new Error('Web Push is not configured (VAPID env vars are unset).');
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    payloadJson,
  );
}

/** Push services answer 404/410 when a subscription is gone for good. */
function isSubscriptionGoneError(error: any): boolean {
  const statusCode = Number(error?.statusCode);
  return statusCode === 404 || statusCode === 410;
}

/** Resolve the CallerDbInfo for a subscribed user (cron has no request). */
async function resolveSubscribedUserCaller(userId: string): Promise<CallerDbInfo | null> {
  if (!useDb()) {
    const user = fallbackStore.users.find(u => u.id === userId);
    if (!user || user.status === 'Inactive' || user.isActive === false) return null;
    return {
      id: user.id,
      employee_id: user.employeeId,
      email: user.email,
      role_id: null,
      role_code: normalizeRole(user.roleCode || user.role),
      department_id: (user as any).departmentId || null,
    };
  }
  try {
    const result = await getPool().query(
      `SELECT u.id, u.employee_id, u.email, u.role_id, u.department_id, u.is_active, r.role_code
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row || row.is_active === false) return null;
    return {
      id: row.id,
      employee_id: row.employee_id,
      email: row.email || '',
      role_id: row.role_id || null,
      role_code: normalizeRole(row.role_code),
      department_id: row.department_id || null,
    };
  } catch {
    return null;
  }
}

export interface DailyPushRunSummary {
  enabled: boolean;
  usersTargeted: number;
  sent: number;
  pruned: number;
  failed: number;
  skippedNoDue: number;
}

/**
 * One daily run: for every user with at least one subscription, send
 * ONE summary push per device when (and only when) they have follow-ups
 * due today or overdue. Gone subscriptions (404/410) are pruned;
 * transient failures are counted, never fatal to the run.
 */
export async function runDailyPushReminders(now: Date = new Date()): Promise<DailyPushRunSummary> {
  const summary: DailyPushRunSummary = {
    enabled: false, usersTargeted: 0, sent: 0, pruned: 0, failed: 0, skippedNoDue: 0,
  };
  if (!isPushConfigured()) return summary;
  summary.enabled = true;

  const subscriptions = await listPushSubscriptions();
  const byUser = new Map<string, StoredPushSubscription[]>();
  const seenEndpoints = new Set<string>();
  for (const sub of subscriptions) {
    if (seenEndpoints.has(sub.endpoint)) continue;
    seenEndpoints.add(sub.endpoint);
    const list = byUser.get(sub.userId) || [];
    list.push(sub);
    byUser.set(sub.userId, list);
  }

  const send = senderOverride || defaultPushSender;
  for (const [userId, userSubs] of byUser) {
    const caller = await resolveSubscribedUserCaller(userId);
    if (!caller) continue;
    const counts = await computeFollowUpReminderCounts(caller, now);
    if (counts.dueToday + counts.overdue === 0) {
      summary.skippedNoDue++;
      continue;
    }
    summary.usersTargeted++;
    const payloadJson = JSON.stringify(buildDailyReminderPayload(counts));
    for (const sub of userSubs) {
      try {
        await send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payloadJson);
        summary.sent++;
        await touchPushSubscription(sub.endpoint);
      } catch (error: any) {
        if (isSubscriptionGoneError(error)) {
          await deletePushSubscriptionByEndpoint(sub.endpoint);
          summary.pruned++;
        } else {
          summary.failed++;
          console.warn(
            `[push-reminders] send failed (user ${userId}): ${error?.message || 'unknown error'}`,
          );
        }
      }
    }
  }

  console.log(
    `[push-reminders] daily run complete: targeted=${summary.usersTargeted} sent=${summary.sent} ` +
    `pruned=${summary.pruned} failed=${summary.failed} skippedNoDue=${summary.skippedNoDue}`,
  );
  return summary;
}
