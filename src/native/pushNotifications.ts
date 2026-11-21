/**
 * FCM push notifications for the native Android app — real mobile
 * push for the installed LeadFlow app (the Web Push opt-in cannot
 * work inside a WebView: PushManager does not exist there).
 *
 * How it works (Mahadi 2026-11-21, shared across Hub + Learning Hub
 * + LeadFlow): ONE Firebase project ("Shanta Life Apps"), topic
 * delivery, NO token storage anywhere. On native sign-in the app
 * subscribes the device to the topic `user-{employeeId}`; the LF/LH
 * servers publish each user notification to that topic, so it lands
 * in every subscribed app — including LeadFlow receiving Hub/LH
 * notifications (tapping one of those opens LeadFlow Home — its
 * route is meaningless here).
 *
 * One thing the design leans on: @capacitor/push-notifications has
 * NO topic subscribe/unsubscribe API (verified against the 8.1.3
 * sources in node_modules — its methods are only check/request
 * Permissions, register/unregister, delivered-notification and
 * channel calls). So the subscription itself goes through the
 * LeadFlow server: the client sends its FCM token + LF JWT to
 * POST /api/notifications/push/fcm-subscribe, and the route
 * subscribes that token to the topic with FCM's IID API. The topic
 * is derived from the verified session's employeeId SERVER-side — a
 * client must never choose whose topic it joins. The token is used
 * in the request and forgotten; nothing stores it. Unsubscribe
 * needs no route at all: `unregister()` deletes the FCM token, and
 * FCM drops a dead token from every topic.
 *
 * Lifetime (Mahadi 2026-11-21 — the subscription belongs to the
 * DEVICE, not the session, like WhatsApp/Gmail): session EXPIRY
 * (30-min inactivity timeout, 1h JWT expiry, 401 rejection) only
 * forgets the session in memory — the FCM token and the topic
 * subscription STAY, so the agent keeps receiving notifications
 * and tapping one brings them to sign-in, then inside. Only an
 * EXPLICIT sign-out (the user taps Log out) unregisters, via
 * unregisterPush() from the sign-out handlers — never from the
 * session-null sync, which cannot tell expiry from sign-out.
 *
 * Lifecycle (wired in main.tsx via initPushNotifications):
 * - Sign-in / session restore → the auth-store subscription calls
 *   syncPushSubscription(user, token): permission (requested once,
 *   only while undecided) → register() → POST the token to the
 *   subscribe route. Denied permission stays silent forever — no
 *   nagging; the in-app bell still works. Re-sign-in after an
 *   expiry is idempotent: the subscription is still live, so the
 *   already-subscribed check skips the redundant call.
 * - Session expiry → syncPushSubscription(null, null): forgets the
 *   session only. The token + topic subscription survive.
 * - Explicit sign-out → unregisterPush() from the Log out handler:
 *   unregister() + forget everything. Best-effort, never throws.
 * - Token refresh → the `registration` listener re-subscribes the
 *   new token for the current session.
 *
 * Tap routing (src/native/pushRouting.ts): a tap navigates in-app
 * via the router — LeadFlow's own notifications honour their
 * `route`, anything else opens Home. Verified limits of the 8.1.3
 * plugin (read from its Android sources, not assumed):
 * - Cold start (app killed, tap launches it) does NOT deep-link:
 *   the plugin only fires `pushNotificationActionPerformed` from
 *   `onNewIntent`, and never inspects the launch intent — the tap
 *   just opens LeadFlow Home.
 * - A notification received while the app is in the FOREGROUND
 *   shows no banner: the FCM SDK only auto-displays in the tray
 *   when the app is backgrounded. That is fine here — the in-app
 *   bell is the foreground surface (it polls the notifications
 *   table, which is also the durable record).
 *
 * Outside the app this module is inert: `Capacitor.isNativePlatform()`
 * is false in the browser and in the PWA, so the plugin is never
 * even imported there. The @capacitor/push-notifications import is
 * dynamic — the web bundle pays nothing for it on the web. Every
 * function here is safe to call on web: it returns immediately.
 * Nothing here ever throws into the caller.
 */
import { Capacitor } from '@capacitor/core';
import { useAuthStore } from '../modules/auth/store/authStore';
import { navigateApp } from './appNavigation';
import { resolvePushTarget, userPushTopic } from './pushRouting';

/** How long to wait for the FCM token after register(). */
const REGISTRATION_TIMEOUT_MS = 15_000;

/** The session the listeners re-subscribe for on token refresh. */
let session: { employeeId: string; jwt: string } | null = null;
/** Topic + token of the subscription that actually succeeded. */
let subscribed: { topic: string; token: string } | null = null;
/** Latest FCM token seen (reused across syncs; cleared on unregister). */
let lastToken: string | null = null;
let listenersReady = false;
/** Monotonic guard: a newer sync supersedes an older in-flight one. */
let syncSeq = 0;

type TokenWaiter = { resolve: (token: string) => void; reject: (error: Error) => void };
let tokenWaiters: TokenWaiter[] = [];

function settleTokenWaiters(token: string | null, error?: Error): void {
  const waiters = tokenWaiters;
  tokenWaiters = [];
  for (const w of waiters) {
    if (token !== null) w.resolve(token);
    else w.reject(error ?? new Error('push registration failed'));
  }
}

function waitForToken(): Promise<string> {
  if (lastToken) return Promise.resolve(lastToken);
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      tokenWaiters = tokenWaiters.filter((w) => w.resolve !== resolve);
      reject(new Error('push registration timed out'));
    }, REGISTRATION_TIMEOUT_MS);
    tokenWaiters.push({
      resolve: (token: string) => {
        window.clearTimeout(timer);
        resolve(token);
      },
      reject: (error: Error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    });
  });
}

/**
 * Subscribe one FCM token to the caller's own topic via the server
 * route. The topic is NOT sent — the route derives it from the
 * verified session's employeeId server-side. Returns true only on a
 * confirmed subscription. 503 push_not_configured (no Firebase
 * service account yet) is an expected, silent outcome — push simply
 * is not live until the project + secret exist.
 */
async function subscribeToken(token: string, jwt: string): Promise<boolean> {
  try {
    const res = await fetch('/api/notifications/push/fcm-subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    // LF sendJson shape: { success: true, data: { ok: true } }.
    const data: unknown = await res.json().catch(() => null);
    if (typeof data !== 'object' || data === null) return false;
    const body = data as { success?: unknown; data?: { ok?: unknown } | null };
    return body.success === true && body.data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Register the push listeners once (called from main.tsx).
 * Native-only; inert on web. The tap listener navigates in-app via
 * the router; the registration listener feeds the token waiter and
 * re-subscribes on token refresh. Also subscribes to the auth store,
 * so sign-in / sign-out / session restore / session expiry all keep
 * the topic subscription in step without touching the auth store.
 */
export function initPushNotifications(): void {
  if (!Capacitor.isNativePlatform()) return;
  if (listenersReady) return;
  listenersReady = true;

  void (async () => {
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications');

      await PushNotifications.addListener('registration', ({ value }) => {
        lastToken = value;
        settleTokenWaiters(value);
        // Token refresh: re-subscribe the NEW token for the current
        // session (the old token's subscription dies with the old
        // token — FCM invalidates it on refresh).
        if (session && subscribed && subscribed.token !== value) {
          const topic = userPushTopic(session.employeeId);
          if (!topic) return;
          void subscribeToken(value, session.jwt).then((ok) => {
            if (ok) subscribed = { topic, token: value };
          });
        }
      });

      await PushNotifications.addListener('registrationError', ({ error }) => {
        settleTokenWaiters(null, new Error(error));
      });

      // Foreground receipt: deliberately a no-op. The FCM SDK only
      // auto-displays in the tray when the app is backgrounded, and
      // the in-app bell is the foreground surface (it polls the
      // notifications table).
      await PushNotifications.addListener('pushNotificationReceived', () => {});

      await PushNotifications.addListener('pushNotificationActionPerformed', ({ actionId, notification }) => {
        if (actionId !== 'tap') return;
        navigateApp(resolvePushTarget(notification?.data));
      });
    } catch {
      // No plugin (should not happen in the shipped shell) — push is
      // simply unavailable; the app works without it.
      listenersReady = false;
    }
  })();

  // Auth lifecycle: keep the subscription in step with the session.
  // Only the (authenticated, employeeId, token) triple matters —
  // profile refreshes (setUser) must not re-trigger a sync.
  let prevKey = '';
  const syncFromStore = (): void => {
    const state = useAuthStore.getState();
    const key = state.isAuthenticated
      ? `in:${state.user?.employeeId || ''}:${state.token || ''}`
      : 'out';
    if (key === prevKey) return;
    prevKey = key;
    if (state.isAuthenticated && state.user?.employeeId && state.token) {
      void syncPushSubscription(
        { employeeId: state.user.employeeId },
        state.token,
      );
    } else {
      void syncPushSubscription(null, null);
    }
  };
  useAuthStore.subscribe(syncFromStore);
  // The store may already hold a restored session (persist
  // rehydration) — sync once now instead of waiting for a change.
  syncFromStore();
}

/**
 * Keep the FCM topic subscription in step with the auth session.
 * Native-only; a no-op on web. Never throws — push must never break
 * sign-in or sign-out.
 */
export async function syncPushSubscription(
  user: { employeeId: string } | null,
  jwt: string | null,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const seq = ++syncSeq;
  const isCurrent = () => seq === syncSeq;

  try {
    if (!user || !jwt) {
      // Session gone (expiry OR sign-out — this sync cannot tell
      // them apart): forget the session ONLY. The FCM token and the
      // topic subscription belong to the device and stay alive, so
      // the agent keeps receiving notifications after an expiry.
      // Unregistering lives in unregisterPush(), called only from
      // the explicit Log out handlers.
      session = null;
      return;
    }

    session = { employeeId: user.employeeId, jwt };
    const topic = userPushTopic(user.employeeId);
    if (!topic) return;

    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Permission: ask once, only while undecided. Denied (or
    // previously denied) stays silent forever — no nagging; the
    // in-app bell still works.
    const current = await PushNotifications.checkPermissions();
    if (current.receive !== 'granted') {
      if (current.receive === 'denied') return;
      const asked = await PushNotifications.requestPermissions();
      if (asked.receive !== 'granted') return;
    }
    if (!isCurrent()) return;

    // Already subscribed for this exact topic + token — skip.
    if (subscribed?.topic === topic && lastToken && subscribed.token === lastToken) return;

    await PushNotifications.register();
    const token = await waitForToken();
    if (!isCurrent()) return;

    const ok = await subscribeToken(token, jwt);
    if (!ok || !isCurrent()) return;
    subscribed = { topic, token };
  } catch {
    // Push is best-effort: a failure here (no Firebase project yet,
    // no network, plugin missing) must never surface in auth.
  }
}

/**
 * Explicit sign-out only: delete the FCM token and forget the
 * subscription. Unregister deletes the token, and FCM drops a dead
 * token from every topic — so this IS the unsubscribe, and it needs
 * no JWT. Called ONLY from the Log out handlers (AppLayout,
 * MorePages, Settings) — never from the session-null sync and never
 * from any expiry path (inactivity timeout, 401 rejection, startup
 * validation), where the subscription must survive.
 *
 * Native-only; a no-op on web. Never throws.
 */
export async function unregisterPush(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  // Supersede any in-flight subscribe — the user is leaving.
  syncSeq++;
  session = null;
  subscribed = null;
  lastToken = null;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.unregister();
  } catch {
    // Already unregistered, or no plugin — nothing to do.
  }
}
