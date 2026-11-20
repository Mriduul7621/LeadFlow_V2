/**
 * FCM push — pure routing helpers (no Capacitor imports, no side
 * effects), so they are unit-testable in Node (server/tests/
 * android-fcm.test.ts) and reusable by the server's FCM publish
 * path (server/services/FcmService.ts imports userPushTopic from
 * here — one definition of the topic name on both sides).
 *
 * Delivery design (Mahadi 2026-11-21, shared across Hub + Learning
 * Hub + LeadFlow): ONE Firebase project ("Shanta Life Apps"), topic
 * delivery, NO token storage anywhere. Each app subscribes the
 * device to the topic `user-{employeeId}` on native sign-in; the
 * LF/LH servers publish each user notification to that topic, so a
 * notification lands in every subscribed app — including LeadFlow
 * receiving Hub/LH notifications, and vice versa.
 *
 * Tap payload (sent by the LF/LH servers):
 *   { source: 'leadflow' | 'learning', title, body,
 *     route, module: 'leadflow' | 'learning' }
 * `route` is an optional path INSIDE the source module (e.g.
 * `/workbench`). It is only honoured as a relative path — an
 * absolute URL in push data must never drive navigation (open
 * redirect). A notification from ANOTHER app (foreign source) still
 * displays, but tapping it opens LeadFlow Home — its route is
 * meaningless inside LeadFlow.
 */

/** FCM topic names must match `[a-zA-Z0-9-_.~%]+`. */
const TOPIC_NAME_RE = /^[a-zA-Z0-9-_.~%]+$/;
/** Employee IDs are short; anything longer is not an ID. */
const MAX_EMPLOYEE_ID_LENGTH = 100;

/**
 * The FCM topic for one employee: `user-{employeeId}`. Returns null
 * for anything that is not a usable ID (empty, whitespace, or
 * characters FCM rejects) — the caller then skips subscribing
 * silently instead of sending a bad topic to FCM.
 */
export function userPushTopic(employeeId: unknown): string | null {
  if (typeof employeeId !== 'string') return null;
  const id = employeeId.trim();
  if (id.length === 0 || id.length > MAX_EMPLOYEE_ID_LENGTH) return null;
  const topic = `user-${id}`;
  return TOPIC_NAME_RE.test(topic) ? topic : null;
}

/** The data payload LF/LH attach to a notification (all fields optional). */
export interface PushNotificationData {
  source?: unknown;
  module?: unknown;
  route?: unknown;
  title?: unknown;
  body?: unknown;
}

/**
 * A `route` is safe only as a relative path inside the app: it must
 * start with exactly one `/` (no `//` protocol-relative, no absolute
 * URL, no backslash, no whitespace). Any `#fragment` is dropped —
 * push data must never inject a fragment. Returns the cleaned path,
 * or '' when the route is unusable.
 */
export function safePushRoute(route: unknown): string {
  if (typeof route !== 'string') return '';
  const path = route.split('#')[0];
  if (!path.startsWith('/')) return '';
  if (path.startsWith('//')) return '';
  if (path.includes('\\') || /\s/.test(path)) return '';
  return path;
}

/**
 * Where a notification tap navigates (in-app, via the router —
 * same-tab, no reload). LeadFlow's own notifications honour their
 * `route` when it is a safe relative path; anything else (a foreign
 * app's notification, unknown data, a missing route) opens LeadFlow
 * Home ('/'). The tap must never crash and never navigate to a
 * bogus route.
 *
 * Source aliases: 'lead-flow' is accepted alongside the canonical
 * 'leadflow' — the server sends the canonical value, but a tap must
 * not fail on the longer form.
 */
export function resolvePushTarget(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '/';
  const d = data as PushNotificationData;
  const rawSource =
    typeof d.source === 'string' ? d.source : typeof d.module === 'string' ? d.module : '';
  const source = rawSource.trim().toLowerCase();
  if (source !== 'leadflow' && source !== 'lead-flow') return '/';
  return safePushRoute(d.route) || '/';
}
