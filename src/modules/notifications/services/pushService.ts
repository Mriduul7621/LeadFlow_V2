/**
 * pushService.ts — Web Push follow-up reminders (client side).
 * ------------------------------------------------------------------
 * Pairs with the server endpoints in
 * server/routes/production/notifications.routes.ts
 * (GET /api/notifications/push/public-key, POST .../subscribe,
 * POST .../unsubscribe) and the service worker in public/sw.js.
 *
 * ZERO-COST DESIGN: the Web Push protocol only — no paid push
 * provider. The agent opts in per device; the server stores the
 * browser-issued subscription and the daily cron sends ONE summary
 * push ("আজ Xটি follow-up due, Yটি overdue") that opens /workbench.
 *
 * Permission is requested ONLY from enablePushReminders(), which runs
 * from an explicit user toggle — never on page load.
 */
import { apiRequest, jsonBody } from '../../shared/api/http';

export type PushReminderState =
  | 'unsupported' // browser has no ServiceWorker/PushManager/Notification
  | 'server-disabled' // server has no VAPID keys (or is unreachable)
  | 'denied' // the user blocked notifications for this site
  | 'subscribed'
  | 'unsubscribed';

interface PushPublicKeyResponse {
  enabled: boolean;
  publicKey?: string;
}

function defaultGlobals(): any {
  return typeof window !== 'undefined' ? window : globalThis;
}

/**
 * Capability detection. Takes the globals object so it stays unit
 * testable outside a browser (server/tests style).
 */
export function isPushSupported(g: any = defaultGlobals()): boolean {
  if (!g) return false;
  const nav = g.navigator;
  if (!nav || !('serviceWorker' in nav)) return false;
  if (!('PushManager' in g)) return false;
  if (!('Notification' in g)) return false;
  return true;
}

/** VAPID public keys travel as base64url; PushManager wants bytes. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Register public/sw.js. Idempotent and failure-proof: returns null
 * instead of throwing so app boot can never break on it. Called once
 * from src/main.tsx and again (cheaply) from the enable flow.
 */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

async function fetchPublicKey(): Promise<PushPublicKeyResponse> {
  return apiRequest<PushPublicKeyResponse>('/api/notifications/push/public-key');
}

/** Current opt-in state for THIS device (drives the settings toggle). */
export async function getPushReminderState(): Promise<PushReminderState> {
  if (!isPushSupported()) return 'unsupported';
  let key: PushPublicKeyResponse;
  try {
    key = await fetchPublicKey();
  } catch {
    return 'server-disabled';
  }
  if (!key.enabled || !key.publicKey) return 'server-disabled';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await registerPushServiceWorker();
  if (!registration) return 'unsubscribed';
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

/**
 * Opt this device in. MUST be called from a user gesture (the settings
 * toggle): this is the only place notification permission is requested.
 * Returns the resulting state; throws only on server/network failure
 * so the UI can toast a meaningful message.
 */
export async function enablePushReminders(): Promise<PushReminderState> {
  if (!isPushSupported()) return 'unsupported';
  const key = await fetchPublicKey();
  if (!key.enabled || !key.publicKey) return 'server-disabled';

  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'unsubscribed';

  const registration = await registerPushServiceWorker();
  if (!registration) return 'unsupported';

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key.publicKey),
    }));

  await apiRequest('/api/notifications/push/subscribe', {
    method: 'POST',
    ...jsonBody(subscription.toJSON()),
  });
  return 'subscribed';
}

/** Opt this device out: tell the server, then drop the local subscription. */
export async function disablePushReminders(): Promise<PushReminderState> {
  if (!isPushSupported()) return 'unsupported';
  const registration = await registerPushServiceWorker();
  const subscription = registration
    ? await registration.pushManager.getSubscription()
    : null;
  if (subscription) {
    try {
      await apiRequest('/api/notifications/push/unsubscribe', {
        method: 'POST',
        ...jsonBody({ endpoint: subscription.endpoint }),
      });
    } catch {
      // Best effort: the local unsubscribe below still stops pushes to
      // this device, and the server prunes dead endpoints on 404/410.
    }
    await subscription.unsubscribe();
  }
  return 'unsubscribed';
}
