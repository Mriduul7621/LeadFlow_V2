/**
 * FcmService — Firebase Cloud Messaging for the installed Android
 * app (direct FCM HTTP v1, no Firebase Admin SDK dependency).
 * ------------------------------------------------------------------
 * LeadFlow's servers publish every user notification to the FCM
 * topic `user-{employeeId}` (one Firebase project, "Shanta Life
 * Apps", shared with the Agent Hub + Learning Hub — Mahadi
 * 2026-11-21). Topic delivery, NO token storage anywhere: the app
 * subscribes its device token through
 * POST /api/notifications/push/fcm-subscribe, which derives the
 * topic from the verified session server-side and forgets the token
 * (the @capacitor/push-notifications plugin has no topic API, so
 * the route is the subscription mechanism — see
 * src/native/pushNotifications.ts).
 *
 * Sending uses the standard JWT-bearer grant (RFC 7523): sign a
 * short-lived RS256 JWT with the service account's private key
 * (node:crypto — no new dependency), exchange it at
 * oauth2.googleapis.com, then POST to the FCM HTTP v1
 * messages:send endpoint. This mirrors the Agent Hub's
 * api/_lib/googleOAuth.js exactly (same env var, same grant), so
 * the three apps share one credential shape. firebase-admin was
 * deliberately NOT used: it would add ~100 dependencies and
 * significant cold-start weight to the serverless function for one
 * operation (send to topic), where the direct HTTP call is ~100
 * lines and fully testable behind the fetch seam below.
 *
 * Credential (server env only, NEVER VITE_-prefixed):
 * - FIREBASE_SERVICE_ACCOUNT_B64 — base64 of the service-account
 *   JSON downloaded from Firebase console → Project settings →
 *   Service accounts → Generate new private key (project "Shanta
 *   Life Apps"). The file contains a private key: never commit it,
 *   never paste it into chat — same handling as the release
 *   keystore. When unset, every entry point degrades to a no-op,
 *   mirroring the VAPID pattern in PushReminderService.ts.
 *
 * FAILURE POLICY: FCM publish is fire-and-forget. It must NEVER
 * fail a request or a cron when FCM is unconfigured or a send
 * fails — every entry point catches, logs and continues. The
 * in-app notification row (or the Web Push attempt) is the durable
 * record; FCM is an additional surface, never a dependency.
 *
 * PUBLISH POINTS (all fire-and-forget, all through
 * publishToUserTopic):
 * - insertNotificationWithIdempotency (NotificationService.ts) —
 *   EVERY system notification created in the notifications table:
 *   lead assignment / reassignment, SLA breach + escalation,
 *   lead-delete-request, and every meeting event (the meeting
 *   service's DB path flows through the same insert). Only a
 *   row that was actually created publishes (idempotent skips do
 *   not re-push).
 * - The demo-mode creation paths (fallbackStore): assignment
 *   notifications, the SLA breach/escalation demo branch, the
 *   meeting deliver() demo branch, and the generic POST
 *   /api/notifications demo branch — same publish, same
 *   fire-and-forget.
 * - POST /api/notifications (notifications.routes.ts) — the
 *   generic create endpoint, DB branch.
 * - runDailyPushReminders (PushReminderService.ts) — the morning
 *   summary has NO in-app row, so the runner publishes to FCM
 *   alongside the Web Push fan-out, same users, same payload.
 * Deliberately NOT hooked: sendPushToUser — the meeting flows
 * call it AFTER creating the in-app row, so hooking it would
 * double-publish every meeting notification.
 *
 * PRE-COMMIT NOTE: insertNotificationWithIdempotency is sometimes
 * called inside a business transaction (lead assignment, delete
 * requests). The FCM publish fires when the insert returns a row,
 * which can be before the transaction commits — a later rollback
 * would leave a phantom push (the event was attempted, then
 * undone). That is accepted: push is best-effort, rollbacks there
 * are rare, and deferring past commit would require restructuring
 * every caller.
 */
import { createSign } from 'node:crypto';
import { safePushRoute, userPushTopic } from '../../src/native/pushRouting.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SEND_URL = (projectId: string) =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
const IID_BATCH_ADD_URL = 'https://iid.googleapis.com/iid/v1:batchAdd';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const CLOCK_SKEW_SECONDS = 300;

/** The source value LeadFlow stamps on every FCM data payload. */
export const FCM_SOURCE = 'leadflow';

/* ====================================================================
   Configuration (service account + OAuth token)
==================================================================== */

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Parse + validate the service-account JSON from the env. Returns
 * the parsed account or null when unset, unparseable, or missing
 * the fields the grant needs. Never throws.
 */
export function parseServiceAccount(env: NodeJS.ProcessEnv = process.env): FcmServiceAccount | null {
  const b64 = env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (typeof b64 !== 'string' || b64 === '') return null;
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
    if (typeof json !== 'object' || json === null) return null;
    if (json.type !== 'service_account') return null;
    if (typeof json.client_email !== 'string' || json.client_email === '') return null;
    if (typeof json.private_key !== 'string' || json.private_key === '') return null;
    if (typeof json.project_id !== 'string' || json.project_id === '') return null;
    return {
      project_id: json.project_id,
      client_email: json.client_email,
      private_key: json.private_key,
    };
  } catch {
    return null;
  }
}

/** True when FCM sending is configured (service account present). */
export function isFcmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseServiceAccount(env) !== null;
}

/* ====================================================================
   Fetch seam + token cache (test seams mirror _setPushSenderForTest)
==================================================================== */

type FetchFn = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

let fetchOverride: FetchFn | null = null;

/** Test seam: replace the network fetch so tests never touch Google. */
export function _setFcmFetchForTest(fn: FetchFn | null): void {
  fetchOverride = fn;
}

function fcmFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  if (fetchOverride) return fetchOverride(url, init);
  return fetch(url, init) as unknown as Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
}

let cachedToken: { token: string; expiresAtMs: number } = { token: '', expiresAtMs: 0 };

/** Test seam: drop the cached OAuth token between cases. */
export function _resetFcmTokenCacheForTest(): void {
  cachedToken = { token: '', expiresAtMs: 0 };
}

function base64UrlEncode(bytes: Buffer | string): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A Google OAuth2 access token for FCM, or null when push is not
 * configured (no service account) or the exchange fails. Tokens are
 * cached in memory until 5 minutes before expiry (one mint per hour
 * per instance at most). Never throws.
 */
export async function getFirebaseAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (cachedToken.token && Date.now() < cachedToken.expiresAtMs) return cachedToken.token;
  const account = parseServiceAccount(env);
  if (!account) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(account.private_key);
    const assertion = `${unsigned}.${base64UrlEncode(signature)}`;

    const res = await fcmFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.access_token !== 'string' || data.access_token === '') return null;
    const ttl =
      typeof data.expires_in === 'number' && data.expires_in > CLOCK_SKEW_SECONDS
        ? data.expires_in
        : 3600;
    cachedToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + (ttl - CLOCK_SKEW_SECONDS) * 1000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
}

/* ====================================================================
   Message shape (pure) + tap-route mapping (pure)
==================================================================== */

export interface FcmPublishInput {
  employeeId: string;
  title: string;
  body: string;
  /** In-app path a tap opens (default '/'). Server-generated only. */
  route?: string;
}

/**
 * The FCM HTTP v1 message for one user notification. The
 * `notification` block makes the system show the banner; the `data`
 * block (ALL values strings — FCM requires it) carries the tap
 * payload the app routes on. Returns null when the employeeId
 * cannot form a valid topic.
 */
export function buildFcmMessage(input: FcmPublishInput): {
  topic: string;
  message: Record<string, unknown>;
} | null {
  const topic = userPushTopic(input.employeeId);
  if (!topic) return null;
  const route = safePushRoute(input.route) || '/';
  const title = String(input.title || '');
  const body = String(input.body || '');
  return {
    topic,
    message: {
      topic,
      notification: { title, body },
      data: {
        source: FCM_SOURCE,
        title,
        body,
        route,
        module: FCM_SOURCE,
      },
    },
  };
}

/**
 * Where a tap on a table-created notification opens — mirrors the
 * in-app bell's click routing (AppLayout.handleNotificationClick):
 * a lead-delete-request notification opens the admin review page,
 * meetings open the Task Calendar, lead events keep the lead-list
 * deep link, everything else opens Home.
 */
export function fcmRouteForNotification(input: {
  eventType?: string;
  referenceType?: string;
  leadId?: string;
  leadCode?: string;
}): string {
  const eventType = String(input.eventType || '');
  const referenceType = String(input.referenceType || '');
  if (eventType === 'lead-delete-request' || referenceType === 'lead_delete_request') {
    return '/leads/delete-requests';
  }
  if (referenceType === 'scheduled_activity' || eventType.startsWith('meeting-')) {
    return '/task-calendar';
  }
  const leadRef = String(input.leadCode || input.leadId || '').trim();
  if (leadRef) return `/leads?leadId=${leadRef}`;
  return '/';
}

/* ====================================================================
   Publish + subscribe (fire-and-forget — never throw)
==================================================================== */

export interface FcmPublishResult {
  /** False when FCM is not configured — the call was a no-op. */
  configured: boolean;
  sent: boolean;
}

/**
 * Publish one notification to a user's FCM topic. Fire-and-forget:
 * returns {configured:false} when FCM is unconfigured, logs and
 * returns {sent:false} on any failure, and NEVER throws — the
 * caller must never fail a request or a cron because push failed.
 */
export async function publishToUserTopic(input: FcmPublishInput): Promise<FcmPublishResult> {
  const built = buildFcmMessage(input);
  if (!built) return { configured: isFcmConfigured(), sent: false };
  const account = parseServiceAccount();
  if (!account) return { configured: false, sent: false };
  try {
    const accessToken = await getFirebaseAccessToken();
    if (!accessToken) return { configured: true, sent: false };
    const res = await fcmFetch(FCM_SEND_URL(account.project_id), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: built.message }),
    });
    if (!res.ok) {
      console.warn(`[fcm] publish to topic ${built.topic} failed: HTTP ${res.status}`);
      return { configured: true, sent: false };
    }
    return { configured: true, sent: true };
  } catch (error: any) {
    console.warn(`[fcm] publish to topic ${built.topic} failed: ${error?.message || 'unknown error'}`);
    return { configured: true, sent: false };
  }
}

export type FcmSubscribeResult =
  | { ok: true }
  | { ok: false; error: 'push_not_configured' | 'push_subscribe_failed' };

/**
 * Subscribe one FCM token to a user's topic through FCM's IID API.
 * The caller (the subscribe route) derives the employeeId from the
 * verified session — never from the request body. The token is used
 * in this one request and forgotten: it is never logged, never
 * stored, never returned. Never throws.
 */
export async function subscribeTokenToUserTopic(input: {
  employeeId: string;
  token: string;
}): Promise<FcmSubscribeResult> {
  const topic = userPushTopic(input.employeeId);
  const token = String(input.token || '');
  if (!topic || token.length === 0 || token.length > 1024 || /\s/.test(token)) {
    return { ok: false, error: 'push_subscribe_failed' };
  }
  try {
    const accessToken = await getFirebaseAccessToken();
    if (!accessToken) return { ok: false, error: 'push_not_configured' };
    const res = await fcmFetch(IID_BATCH_ADD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: `/topics/${topic}`, registration_tokens: [token] }),
    });
    if (!res.ok) return { ok: false, error: 'push_subscribe_failed' };
    const data = await res.json().catch(() => ({}));
    const first = Array.isArray(data.results) ? data.results[0] : null;
    if (!first || typeof first !== 'object' || (first as any).error) {
      return { ok: false, error: 'push_subscribe_failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'push_subscribe_failed' };
  }
}
