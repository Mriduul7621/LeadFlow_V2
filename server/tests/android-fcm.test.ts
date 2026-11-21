/**
 * android-fcm.test.ts — FCM push for the installed Android app
 * ------------------------------------------------------------------
 * Topic-based delivery, NO token storage (Mahadi 2026-11-21, shared
 * across Hub + Learning Hub + LeadFlow): one Firebase project
 * ("Shanta Life Apps"), the app subscribes on sign-in to topic
 * `user-{employeeId}`, the server publishes every user notification
 * there. Sending is direct FCM HTTP v1 with a service-account JWT
 * (no firebase-admin — see server/services/FcmService.ts).
 *
 * Coverage:
 *   1. Pure units — pushRouting (topic name, safe route, tap
 *      target incl. foreign-source → home), FcmService config
 *      parsing, the exact FCM message shape, tap-route mapping.
 *   2. Publish + subscribe behind the fetch seam — OAuth token
 *      mint + caching, exact send/IID payloads, graceful no-op
 *      when unconfigured, failures never throw.
 *   3. The insert hook — insertNotificationWithIdempotency
 *      publishes on a created row and NEVER on an idempotent skip.
 *   4. Daily runner (demo mode) — the morning summary publishes
 *      to FCM alongside Web Push; web push behaviour unchanged.
 *   5. Meeting demo deliver — invite publishes with the calendar
 *      route; dedupe replay publishes nothing.
 *   6. Source guards — wiring (main.tsx, App.tsx, push module),
 *      the workflow's google-services step (lenient by design),
 *      .gitignore, env catalog, docs §8.
 *   7. HTTP integration (PGlite) — the fcm-subscribe route
 *      (200/400/401/503) and the generic POST /api/notifications
 *      FCM fan-out.
 *
 * No test here touches the network: every Google call goes through
 * the _setFcmFetchForTest seam with a recorded stub.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  resolvePushTarget,
  safePushRoute,
  userPushTopic,
} from '../../src/native/pushRouting.js';
import {
  buildFcmMessage,
  fcmRouteForNotification,
  getFirebaseAccessToken,
  isFcmConfigured,
  parseServiceAccount,
  publishToUserTopic,
  subscribeTokenToUserTopic,
  _resetFcmTokenCacheForTest,
  _setFcmFetchForTest,
} from '../services/FcmService.js';
import { insertNotificationWithIdempotency } from '../services/NotificationService.js';
import { notifyMeetingInvites } from '../services/MeetingNotificationService.js';
import {
  runDailyPushReminders,
  upsertPushSubscription,
  _setPushSenderForTest,
} from '../services/PushReminderService.js';
import { fallbackStore } from '../fallbackStore.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';
import { JWT_SECRET as SHARED_JWT_SECRET } from '../routes/production/shared.js';
import type { CallerDbInfo } from '../routes/production/shared.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ====================================================================
   Fake service account + recorded fetch stub (shared by §2–§5, §7)
==================================================================== */

/** Throwaway RSA key generated for tests only (never deployed). */
const { privateKey: TEST_RSA_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAKE_SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'shanta-life-apps-test',
  client_email: 'fcm-test@shanta-life-apps-test.iam.gserviceaccount.com',
  private_key: TEST_RSA_KEY.export({ type: 'pkcs8', format: 'pem' }) as string,
};
const FAKE_SA_B64 = Buffer.from(JSON.stringify(FAKE_SERVICE_ACCOUNT)).toString('base64');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL =
  'https://fcm.googleapis.com/v1/projects/shanta-life-apps-test/messages:send';
const IID_URL = 'https://iid.googleapis.com/iid/v1:batchAdd';

interface FcmCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string | null;
}
const fcmCalls: FcmCall[] = [];
let fcmSendStatus = 200;
let fcmIidStatus = 200;
let fcmIidResults: any[] = [{}];
let fcmTokenStatus = 200;
let fcmFetchShouldThrow = false;

function installFcmStub(): void {
  fcmCalls.length = 0;
  _setFcmFetchForTest(async (url, init) => {
    if (fcmFetchShouldThrow) throw new Error('network down (test stub)');
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    let body: any = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    fcmCalls.push({
      url,
      method: String(init?.method || 'GET'),
      headers: (init?.headers || {}) as Record<string, string>,
      body,
      rawBody,
    });
    if (url === TOKEN_URL) {
      return {
        ok: fcmTokenStatus === 200,
        status: fcmTokenStatus,
        json: async () => ({ access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' }),
      };
    }
    if (url === SEND_URL) {
      return {
        ok: fcmSendStatus === 200,
        status: fcmSendStatus,
        json: async () => ({ name: 'projects/shanta-life-apps-test/messages/abc123' }),
      };
    }
    if (url === IID_URL) {
      return {
        ok: fcmIidStatus === 200,
        status: fcmIidStatus,
        json: async () => ({ results: fcmIidResults }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function resetFcmStubState(): void {
  fcmCalls.length = 0;
  fcmSendStatus = 200;
  fcmIidStatus = 200;
  fcmIidResults = [{}];
  fcmTokenStatus = 200;
  fcmFetchShouldThrow = false;
}

const fcmSends = () => fcmCalls.filter((c) => c.url === SEND_URL);
const fcmTokenCalls = () => fcmCalls.filter((c) => c.url === TOKEN_URL);
const fcmIidCalls = () => fcmCalls.filter((c) => c.url === IID_URL);

/** Fire-and-forget publishes resolve on the next microtasks; poll for them. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Install the fake service account + stub; returns a restore fn. */
function enableFcm(): () => void {
  const saved = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  process.env.FIREBASE_SERVICE_ACCOUNT_B64 = FAKE_SA_B64;
  _resetFcmTokenCacheForTest();
  resetFcmStubState();
  installFcmStub();
  return () => {
    _setFcmFetchForTest(null);
    _resetFcmTokenCacheForTest();
    resetFcmStubState();
    if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    else process.env.FIREBASE_SERVICE_ACCOUNT_B64 = saved;
  };
}

/* ====================================================================
   1. Pure units — pushRouting
==================================================================== */

describe('FCM pushRouting — topic names', () => {
  it('derives user-{employeeId}', () => {
    assert.equal(userPushTopic('2025019'), 'user-2025019');
    assert.equal(userPushTopic('EMP_DEMO'), 'user-EMP_DEMO');
  });

  it('trims and rejects anything FCM cannot use as a topic', () => {
    assert.equal(userPushTopic(' 2025019 '), 'user-2025019');
    assert.equal(userPushTopic(''), null);
    assert.equal(userPushTopic('   '), null);
    assert.equal(userPushTopic(null), null);
    assert.equal(userPushTopic(undefined), null);
    assert.equal(userPushTopic(2025019), null);
    assert.equal(userPushTopic('has space'), null);
    assert.equal(userPushTopic('has/slash'), null);
    assert.equal(userPushTopic('x'.repeat(101)), null);
  });
});

describe('FCM pushRouting — safe routes', () => {
  it('keeps safe relative paths incl. query strings', () => {
    assert.equal(safePushRoute('/workbench'), '/workbench');
    assert.equal(safePushRoute('/leads?leadId=LD-1'), '/leads?leadId=LD-1');
    assert.equal(safePushRoute('/task-calendar'), '/task-calendar');
    assert.equal(safePushRoute('/'), '/');
  });

  it('drops fragments and rejects anything that is not a relative path', () => {
    assert.equal(safePushRoute('/workbench#top'), '/workbench');
    assert.equal(safePushRoute('https://evil.example.com/x'), '');
    assert.equal(safePushRoute('//evil.example.com/x'), '');
    assert.equal(safePushRoute('workbench'), '');
    assert.equal(safePushRoute('/has space'), '');
    assert.equal(safePushRoute('/back\\slash'), '');
    assert.equal(safePushRoute(''), '');
    assert.equal(safePushRoute(null), '');
    assert.equal(safePushRoute(undefined), '');
    assert.equal(safePushRoute(42), '');
  });
});

describe('FCM pushRouting — tap targets', () => {
  it('honours the route of LeadFlow’s own notifications', () => {
    assert.equal(
      resolvePushTarget({ source: 'leadflow', route: '/workbench' }),
      '/workbench'
    );
    assert.equal(
      resolvePushTarget({ source: 'leadflow', route: '/leads?leadId=LD-1' }),
      '/leads?leadId=LD-1'
    );
    assert.equal(
      resolvePushTarget({ source: 'lead-flow', route: '/task-calendar' }),
      '/task-calendar',
      'lead-flow alias is accepted'
    );
    assert.equal(
      resolvePushTarget({ module: 'leadflow', route: '/workbench' }),
      '/workbench',
      'module falls back when source is absent'
    );
  });

  it('opens Home for a missing or unsafe route', () => {
    assert.equal(resolvePushTarget({ source: 'leadflow' }), '/');
    assert.equal(resolvePushTarget({ source: 'leadflow', route: '' }), '/');
    assert.equal(
      resolvePushTarget({ source: 'leadflow', route: 'https://evil.example.com' }),
      '/'
    );
    assert.equal(resolvePushTarget({ source: 'leadflow', route: '//evil.example.com' }), '/');
  });

  it('opens Home for foreign sources — never a bogus route, never a crash', () => {
    assert.equal(resolvePushTarget({ source: 'agenthub', route: '/modules/x' }), '/');
    assert.equal(resolvePushTarget({ source: 'learning', route: '/learn/1' }), '/');
    assert.equal(resolvePushTarget({ source: 'unknown', route: '/workbench' }), '/');
    assert.equal(resolvePushTarget({}), '/');
    assert.equal(resolvePushTarget(null), '/');
    assert.equal(resolvePushTarget(undefined), '/');
    assert.equal(resolvePushTarget('leadflow'), '/');
  });
});

/* ====================================================================
   1b. Pure units — FcmService config, message shape, route mapping
==================================================================== */

describe('FCM service-account config', () => {
  it('parses a valid base64 service-account JSON', () => {
    const account = parseServiceAccount({
      FIREBASE_SERVICE_ACCOUNT_B64: FAKE_SA_B64,
    } as any);
    assert.ok(account);
    assert.equal(account!.project_id, 'shanta-life-apps-test');
    assert.equal(account!.client_email, 'fcm-test@shanta-life-apps-test.iam.gserviceaccount.com');
    assert.ok(account!.private_key.includes('BEGIN PRIVATE KEY'));
    assert.equal(isFcmConfigured({ FIREBASE_SERVICE_ACCOUNT_B64: FAKE_SA_B64 } as any), true);
  });

  it('returns null for unset, malformed or incomplete credentials', () => {
    assert.equal(parseServiceAccount({} as any), null);
    assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_B64: '' } as any), null);
    assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_B64: '!!!not-base64!!!' } as any), null);
    assert.equal(
      parseServiceAccount({
        FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from('not json').toString('base64'),
      } as any),
      null
    );
    const wrongType = Buffer.from(JSON.stringify({
      type: 'authorized_user', project_id: 'p', client_email: 'e', private_key: 'k',
    })).toString('base64');
    assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_B64: wrongType } as any), null);
    const missingKey = Buffer.from(JSON.stringify({
      type: 'service_account', project_id: 'p', client_email: 'e',
    })).toString('base64');
    assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_B64: missingKey } as any), null);
    assert.equal(isFcmConfigured({} as any), false);
  });
});

describe('FCM message shape', () => {
  it('builds the exact FCM HTTP v1 message (topic + banner + data)', () => {
    const built = buildFcmMessage({
      employeeId: '2025019',
      title: 'New Lead Assigned',
      body: 'Lead X assigned to you.',
      route: '/workbench',
    });
    assert.deepEqual(built, {
      topic: 'user-2025019',
      message: {
        topic: 'user-2025019',
        notification: { title: 'New Lead Assigned', body: 'Lead X assigned to you.' },
        data: {
          source: 'leadflow',
          title: 'New Lead Assigned',
          body: 'Lead X assigned to you.',
          route: '/workbench',
          module: 'leadflow',
        },
      },
    });
  });

  it('keeps every data value a string (FCM requires it)', () => {
    const built = buildFcmMessage({ employeeId: '2025019', title: 'T', body: 'B' });
    assert.ok(built);
    for (const [key, value] of Object.entries((built!.message as any).data)) {
      assert.equal(typeof value, 'string', `data.${key} must be a string`);
    }
  });

  it('defaults an omitted or unsafe route to Home, and rejects bad IDs', () => {
    const routeOf = (built: NonNullable<ReturnType<typeof buildFcmMessage>>) =>
      (built.message.data as { route: string }).route;
    assert.equal(routeOf(buildFcmMessage({ employeeId: '2025019', title: 'T', body: 'B' })!), '/');
    assert.equal(
      routeOf(buildFcmMessage({ employeeId: '2025019', title: 'T', body: 'B', route: 'https://evil.example.com' })!),
      '/'
    );
    assert.equal(buildFcmMessage({ employeeId: '', title: 'T', body: 'B' }), null);
    assert.equal(buildFcmMessage({ employeeId: 'has space', title: 'T', body: 'B' }), null);
  });
});

describe('FCM tap-route mapping (mirrors the in-app bell)', () => {
  it('maps delete requests to the admin review page', () => {
    assert.equal(
      fcmRouteForNotification({ eventType: 'lead-delete-request', referenceType: 'lead_delete_request', leadId: 'l1' }),
      '/leads/delete-requests'
    );
    assert.equal(
      fcmRouteForNotification({ referenceType: 'lead_delete_request' }),
      '/leads/delete-requests'
    );
  });

  it('maps meetings to the Task Calendar', () => {
    assert.equal(
      fcmRouteForNotification({ eventType: 'meeting-invited', referenceType: 'scheduled_activity' }),
      '/task-calendar'
    );
    assert.equal(fcmRouteForNotification({ eventType: 'meeting-reminder' }), '/task-calendar');
  });

  it('maps lead events to the lead-list deep link (code preferred)', () => {
    assert.equal(
      fcmRouteForNotification({ eventType: 'lead-assigned', referenceType: 'lead', leadId: 'uuid-1', leadCode: 'LD-1' }),
      '/leads?leadId=LD-1'
    );
    assert.equal(
      fcmRouteForNotification({ referenceType: 'lead', leadId: 'uuid-1' }),
      '/leads?leadId=uuid-1'
    );
    assert.equal(fcmRouteForNotification({}), '/');
  });
});

/* ====================================================================
   2. Publish + subscribe behind the fetch seam
==================================================================== */

describe('FCM publish (stubbed fetch)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = enableFcm();
  });
  afterEach(() => {
    restore();
  });

  it('mints an OAuth token once and posts the exact send payload', async () => {
    const result = await publishToUserTopic({
      employeeId: '2025019',
      title: 'New Lead Assigned',
      body: 'Lead X assigned to you.',
      route: '/leads?leadId=LD-1',
    });
    assert.deepEqual(result, { configured: true, sent: true });

    assert.equal(fcmTokenCalls().length, 1, 'one OAuth mint');
    assert.equal(fcmTokenCalls()[0].method, 'POST');
    assert.match(
      fcmTokenCalls()[0].rawBody || '',
      /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/,
      'JWT-bearer grant'
    );
    assert.match(fcmTokenCalls()[0].rawBody || '', /assertion=/, 'RS256 assertion sent');

    assert.equal(fcmSends().length, 1);
    const send = fcmSends()[0];
    assert.equal(send.url, SEND_URL, 'project id from the service account');
    assert.equal(send.headers.Authorization, 'Bearer fake-access-token');
    assert.deepEqual(send.body, {
      message: {
        topic: 'user-2025019',
        notification: { title: 'New Lead Assigned', body: 'Lead X assigned to you.' },
        data: {
          source: 'leadflow',
          title: 'New Lead Assigned',
          body: 'Lead X assigned to you.',
          route: '/leads?leadId=LD-1',
          module: 'leadflow',
        },
      },
    });
  });

  it('caches the OAuth token across publishes', async () => {
    await publishToUserTopic({ employeeId: '2025019', title: 'T1', body: 'B1' });
    await publishToUserTopic({ employeeId: '2025019', title: 'T2', body: 'B2' });
    assert.equal(fcmTokenCalls().length, 1, 'second publish reuses the cached token');
    assert.equal(fcmSends().length, 2);
  });

  it('is a silent no-op when the service account is unset', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    _resetFcmTokenCacheForTest();
    const result = await publishToUserTopic({ employeeId: '2025019', title: 'T', body: 'B' });
    assert.deepEqual(result, { configured: false, sent: false });
    assert.equal(fcmCalls.length, 0, 'no network at all when unconfigured');
  });

  it('never throws on a failed send, a failed token mint, or a network error', async () => {
    fcmSendStatus = 500;
    const failed = await publishToUserTopic({ employeeId: '2025019', title: 'T', body: 'B' });
    assert.deepEqual(failed, { configured: true, sent: false });

    fcmSendStatus = 200;
    fcmTokenStatus = 500;
    _resetFcmTokenCacheForTest();
    const noToken = await publishToUserTopic({ employeeId: '2025019', title: 'T', body: 'B' });
    assert.deepEqual(noToken, { configured: true, sent: false });

    fcmTokenStatus = 200;
    fcmFetchShouldThrow = true;
    _resetFcmTokenCacheForTest();
    const threw = await publishToUserTopic({ employeeId: '2025019', title: 'T', body: 'B' });
    assert.deepEqual(threw, { configured: true, sent: false });
  });

  it('getFirebaseAccessToken returns the stubbed token and null when unconfigured', async () => {
    assert.equal(await getFirebaseAccessToken(), 'fake-access-token');
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    _resetFcmTokenCacheForTest();
    assert.equal(await getFirebaseAccessToken(), null);
  });
});

describe('FCM topic subscribe (stubbed fetch)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = enableFcm();
  });
  afterEach(() => {
    restore();
  });

  it('subscribes the token to user-{employeeId} via the IID API', async () => {
    const result = await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'fcm-token-abc' });
    assert.deepEqual(result, { ok: true });
    assert.equal(fcmIidCalls().length, 1);
    assert.equal(fcmIidCalls()[0].url, IID_URL);
    assert.equal(fcmIidCalls()[0].headers.Authorization, 'Bearer fake-access-token');
    // IID requires this header for OAuth tokens — without it the
    // subscribe call answers 401 and no device ever joins the topic
    // (Agent Hub finding, 2026-11-21).
    assert.equal(fcmIidCalls()[0].headers.access_token_auth, 'true');
    assert.deepEqual(fcmIidCalls()[0].body, {
      to: '/topics/user-2025019',
      registration_tokens: ['fcm-token-abc'],
    });
  });

  it('reports push_not_configured when the service account is unset', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    _resetFcmTokenCacheForTest();
    const result = await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'tok' });
    assert.deepEqual(result, { ok: false, error: 'push_not_configured' });
    assert.equal(fcmCalls.length, 0);
  });

  it('rejects invalid tokens and IID failures without throwing', async () => {
    assert.deepEqual(
      await subscribeTokenToUserTopic({ employeeId: '2025019', token: '' }),
      { ok: false, error: 'push_subscribe_failed' }
    );
    assert.deepEqual(
      await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'has space' }),
      { ok: false, error: 'push_subscribe_failed' }
    );
    assert.deepEqual(
      await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'x'.repeat(1025) }),
      { ok: false, error: 'push_subscribe_failed' }
    );
    assert.equal(fcmIidCalls().length, 0, 'invalid tokens never reach FCM');

    fcmIidStatus = 500;
    assert.deepEqual(
      await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'tok' }),
      { ok: false, error: 'push_subscribe_failed' }
    );

    fcmIidStatus = 200;
    fcmIidResults = [{ error: 'INVALID_ARGUMENT' }];
    assert.deepEqual(
      await subscribeTokenToUserTopic({ employeeId: '2025019', token: 'tok' }),
      { ok: false, error: 'push_subscribe_failed' }
    );
  });
});

/* ====================================================================
   3. The insert hook — the shared creation point
==================================================================== */

describe('FCM insert hook (insertNotificationWithIdempotency)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = enableFcm();
  });
  afterEach(() => {
    restore();
  });

  const fakeExec = (rows: any[]) => ({
    query: async () => ({ rows }),
  });

  it('publishes when a row is created, with the lead deep link', async () => {
    const row = await insertNotificationWithIdempotency(fakeExec([{ id: 'n1' }]) as any, {
      userId: 'u1',
      recipientKey: 'EMP1',
      title: 'New Lead Assigned',
      message: 'Lead X assigned to you.',
      eventType: 'lead-assigned',
      idempotencyKey: 'k1',
      leadId: 'lead-1',
      leadCode: 'LD-1',
      referenceType: 'lead',
    });
    assert.equal(row.id, 'n1');
    await waitFor(() => fcmSends().length === 1);
    const data = fcmSends()[0].body.message.data;
    assert.equal(fcmSends()[0].body.message.topic, 'user-EMP1');
    assert.equal(data.title, 'New Lead Assigned');
    assert.equal(data.body, 'Lead X assigned to you.');
    assert.equal(data.route, '/leads?leadId=LD-1');
    assert.equal(data.source, 'leadflow');
  });

  it('publishes NOTHING on an idempotent skip (no re-push on retry)', async () => {
    const row = await insertNotificationWithIdempotency(fakeExec([]) as any, {
      userId: 'u1',
      recipientKey: 'EMP1',
      title: 'New Lead Assigned',
      message: 'Lead X assigned to you.',
      eventType: 'lead-assigned',
      idempotencyKey: 'k1',
      leadId: 'lead-1',
      leadCode: 'LD-1',
      referenceType: 'lead',
    });
    assert.equal(row, null);
    await sleep(150);
    assert.equal(fcmSends().length, 0, 'a skipped insert must not re-push');
  });

  it('routes meeting inserts to the calendar and delete requests to review', async () => {
    await insertNotificationWithIdempotency(fakeExec([{ id: 'n2' }]) as any, {
      userId: 'u1',
      recipientKey: 'EMP1',
      title: 'Meeting Invitation',
      message: 'You are invited.',
      eventType: 'meeting-invited',
      idempotencyKey: 'k2',
      referenceType: 'scheduled_activity',
    });
    await insertNotificationWithIdempotency(fakeExec([{ id: 'n3' }]) as any, {
      userId: 'u1',
      recipientKey: 'EMP1',
      title: 'Delete request: X',
      message: 'Please review.',
      eventType: 'lead-delete-request',
      idempotencyKey: 'k3',
      leadId: 'lead-1',
      leadCode: 'LD-1',
      referenceType: 'lead_delete_request',
    });
    await waitFor(() => fcmSends().length === 2);
    const routes = fcmSends().map((c) => c.body.message.data.route);
    assert.deepEqual(routes, ['/task-calendar', '/leads/delete-requests']);
  });
});

/* ====================================================================
   4. Daily runner (demo mode) — FCM alongside Web Push
==================================================================== */

/** Throwaway VAPID pair generated for tests only (never deployed). */
const TEST_VAPID_PUBLIC =
  'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM';
const TEST_VAPID_PRIVATE = 'tKbBZatMgMVAR1mkB5TSIJZr2RSjdyBuk87V4MwIZQo';
const TEST_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-device-1';

describe('FCM daily runner (demo mode)', () => {
  const savedUsers = [...fallbackStore.users];
  const savedLeads = [...fallbackStore.leads];
  const savedSubs = [...fallbackStore.pushSubscriptions];
  const savedNotifications = [...(fallbackStore as any).notifications];
  const savedDbUrl = process.env.DATABASE_URL;
  const savedFcmEnv = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  const demoCaller: CallerDbInfo = {
    id: 'demo-user-1',
    employee_id: 'EMP_DEMO',
    email: 'demo@test.com',
    role_id: null,
    role_code: 'EMPLOYEE',
    department_id: null,
  };
  void demoCaller;

  before(() => {
    delete process.env.DATABASE_URL;
    process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
    process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    fallbackStore.users = [
      {
        id: 'demo-user-1', employeeId: 'EMP_DEMO', fullName: 'Demo User', name: 'Demo User',
        email: 'demo@test.com', role: 'EMPLOYEE', roleCode: 'EMPLOYEE', status: 'Active', isActive: true,
      } as any,
    ];
    const b = getDhakaBusinessDayBounds(new Date());
    const at = (ms: number) => new Date(b.todayStart.getTime() + ms).toISOString();
    fallbackStore.leads = [
      { id: 'dl-overdue', prospectName: 'Overdue', mobile: '01710000001', assignedTo: 'EMP_DEMO', currentStatus: 'Contacted', nextFollowUpDate: at(-2 * 3600000) } as any,
      { id: 'dl-today', prospectName: 'Today', mobile: '01710000002', assignedTo: 'EMP_DEMO', currentStatus: 'Contacted', nextFollowUpDate: at(2 * 3600000) } as any,
      { id: 'dl-upcoming', prospectName: 'Upcoming', mobile: '01710000003', assignedTo: 'EMP_DEMO', currentStatus: 'Contacted', nextFollowUpDate: at(26 * 3600000) } as any,
      { id: 'dl-terminal', prospectName: 'Terminal', mobile: '01710000004', assignedTo: 'EMP_DEMO', currentStatus: 'Converted', nextFollowUpDate: at(1 * 3600000) } as any,
      { id: 'dl-other', prospectName: 'Other', mobile: '01710000005', assignedTo: 'EMP_OTHER', currentStatus: 'Contacted', nextFollowUpDate: at(1 * 3600000) } as any,
    ];
    fallbackStore.pushSubscriptions = [];
    (fallbackStore as any).notifications = [];
  });

  after(() => {
    fallbackStore.users = savedUsers;
    fallbackStore.leads = savedLeads;
    fallbackStore.pushSubscriptions = savedSubs;
    (fallbackStore as any).notifications = savedNotifications;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    _setPushSenderForTest(null);
    _setFcmFetchForTest(null);
    _resetFcmTokenCacheForTest();
    if (savedFcmEnv === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    else process.env.FIREBASE_SERVICE_ACCOUNT_B64 = savedFcmEnv;
  });

  beforeEach(() => {
    fallbackStore.pushSubscriptions = [];
    (fallbackStore as any).notifications = [];
    _setPushSenderForTest(null);
    _setFcmFetchForTest(null);
    _resetFcmTokenCacheForTest();
    resetFcmStubState();
  });

  async function runWithWebPush() {
    await upsertPushSubscription('demo-user-1', {
      endpoint: TEST_ENDPOINT, p256dh: TEST_VAPID_PUBLIC, auth: 'testauthsecret123456',
    }, null);
    const webSent: Array<{ endpoint: string; payload: any }> = [];
    _setPushSenderForTest(async (target, payloadJson) => {
      webSent.push({ endpoint: target.endpoint, payload: JSON.parse(payloadJson) });
    });
    return webSent;
  }

  it('publishes the same summary to FCM once per user; Web Push unchanged', async () => {
    const webSent = await runWithWebPush();
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 = FAKE_SA_B64;
    installFcmStub();
    try {
      const summary = await runDailyPushReminders(new Date());
      assert.equal(summary.enabled, true);
      assert.equal(summary.usersTargeted, 1);
      // Web Push: exactly as before (same device, same payload).
      assert.equal(summary.sent, 1);
      assert.equal(webSent.length, 1);
      assert.equal(webSent[0].endpoint, TEST_ENDPOINT);
      assert.equal(webSent[0].payload.body, 'আজ 1টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।');
      assert.equal(webSent[0].payload.url, '/workbench');
      // FCM: one publish per user (topics are per-user, not per-device).
      assert.equal(summary.fcmSent, 1);
      assert.equal(summary.fcmFailed, 0);
      const dailySends = fcmSends().filter(
        (c) => c.body.message.data.route === '/workbench'
      );
      assert.equal(dailySends.length, 1, 'exactly one daily-summary FCM publish');
      assert.equal(dailySends[0].body.message.topic, 'user-EMP_DEMO');
      assert.equal(dailySends[0].body.message.data.title, webSent[0].payload.title);
      assert.equal(dailySends[0].body.message.data.body, webSent[0].payload.body);
    } finally {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    }
  });

  it('counts an FCM failure without touching the Web Push fan-out', async () => {
    await runWithWebPush();
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 = FAKE_SA_B64;
    fcmSendStatus = 500;
    installFcmStub();
    try {
      const summary = await runDailyPushReminders(new Date());
      assert.equal(summary.sent, 1, 'web push still sent');
      assert.equal(summary.fcmSent, 0);
      assert.equal(summary.fcmFailed, 1);
    } finally {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    }
  });

  it('is a clean FCM no-op when the service account is unset', async () => {
    await runWithWebPush();
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    installFcmStub();
    const summary = await runDailyPushReminders(new Date());
    assert.equal(summary.sent, 1, 'web push still sent');
    assert.equal(summary.fcmSent, 0);
    assert.equal(summary.fcmFailed, 0, 'unconfigured FCM counts neither sent nor failed');
    assert.equal(fcmCalls.length, 0, 'no network at all when unconfigured');
  });
});

/* ====================================================================
   5. Meeting demo deliver — the demo branch publishes too
==================================================================== */

describe('FCM meeting notifications (demo mode)', () => {
  const savedUsers = [...fallbackStore.users];
  const savedNotifications = [...(fallbackStore as any).notifications];
  const savedActivities = [...(fallbackStore as any).scheduledActivities];
  const savedDbUrl = process.env.DATABASE_URL;
  const savedFcmEnv = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  const ORG = { id: 'demo-org', employeeId: 'ORG1', fullName: 'Organiser One', name: 'Organiser One', email: 'org@demo.test', role: 'EMPLOYEE', status: 'Active' };
  const ATT = { id: 'demo-att', employeeId: 'ATT1', fullName: 'Attendee One', name: 'Attendee One', email: 'att@demo.test', role: 'EMPLOYEE', status: 'Active' };
  const ACTIVITY = {
    id: 'demo-act-fcm', title: 'Demo Sync', activityType: 'meeting',
    scheduledAt: '2027-03-10T10:00:00.000Z', leadCustomerName: null, createdBy: ORG.id,
  };

  let restore: () => void;

  before(() => {
    delete process.env.DATABASE_URL;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  after(() => {
    (fallbackStore as any).users = savedUsers;
    (fallbackStore as any).notifications = savedNotifications;
    (fallbackStore as any).scheduledActivities = savedActivities;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    if (savedFcmEnv === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    else process.env.FIREBASE_SERVICE_ACCOUNT_B64 = savedFcmEnv;
  });

  beforeEach(() => {
    (fallbackStore as any).users = [ORG, ATT];
    (fallbackStore as any).notifications = [];
    (fallbackStore as any).scheduledActivities = [];
    (fallbackStore as any).pushSubscriptions = [];
    restore = enableFcm();
  });

  afterEach(() => {
    restore();
  });

  it('publishes an invite to the attendee topic with the calendar route', async () => {
    const summary = await notifyMeetingInvites({
      activity: ACTIVITY,
      organiserId: ORG.id,
      attendees: [{ userId: ATT.id, employeeId: ATT.employeeId }],
    });
    assert.equal(summary.created, 1);
    await waitFor(() => fcmSends().length === 1);
    assert.equal(fcmSends()[0].body.message.topic, 'user-ATT1');
    assert.equal(fcmSends()[0].body.message.data.title, 'Meeting Invitation');
    assert.match(fcmSends()[0].body.message.data.body, /^You are invited: Demo Sync — /);
    assert.equal(fcmSends()[0].body.message.data.route, '/task-calendar');
  });

  it('publishes nothing on a deduped replay', async () => {
    await notifyMeetingInvites({
      activity: ACTIVITY,
      organiserId: ORG.id,
      attendees: [{ userId: ATT.id, employeeId: ATT.employeeId }],
    });
    await waitFor(() => fcmSends().length === 1);
    const replay = await notifyMeetingInvites({
      activity: ACTIVITY,
      organiserId: ORG.id,
      attendees: [{ userId: ATT.id, employeeId: ATT.employeeId }],
    });
    assert.equal(replay.created, 0);
    await sleep(150);
    assert.equal(fcmSends().length, 1, 'the replay must not re-push');
  });
});

/* ====================================================================
   6. Source guards — wiring, workflow, docs
==================================================================== */

describe('FCM wiring — source guards', () => {
  it('main.tsx starts push init next to the back-button init', () => {
    const main = read('src/main.tsx');
    assert.ok(main.includes("import { initPushNotifications } from './native/pushNotifications';"));
    assert.ok(main.includes('initPushNotifications();'));
    assert.ok(
      main.indexOf('initAndroidBackButton();') < main.indexOf('initPushNotifications();'),
      'push init sits next to the back-button init'
    );
  });

  it('App.tsx registers the router navigator for tap navigation', () => {
    const app = read('src/App.tsx');
    assert.ok(app.includes("import { registerAppNavigator } from './native/appNavigation';"));
    assert.ok(app.includes('registerAppNavigator('));
    assert.ok(app.includes('router.navigate(path)'));
  });

  it('the push module subscribes via the server route and unregisters on sign-out', () => {
    const push = read('src/native/pushNotifications.ts');
    assert.ok(push.includes('/api/notifications/push/fcm-subscribe'), 'subscribe route');
    assert.ok(push.includes('PushNotifications.unregister()'), 'unregister on sign-out');
    assert.ok(push.includes('pushNotificationActionPerformed'), 'tap listener');
    assert.ok(push.includes('checkPermissions'), 'permission gate');
    assert.ok(push.includes('requestPermissions'), 'permission request');
    assert.ok(push.includes("Capacitor.isNativePlatform()"), 'native-only guard');
    assert.ok(!push.includes('userPushTopic(') || push.includes('derive'), 'topic derived server-side');
  });

  it('the appNavigation module falls back to a full load when no navigator is registered', () => {
    const nav = read('src/native/appNavigation.ts');
    assert.ok(nav.includes('registerAppNavigator'));
    assert.ok(nav.includes('navigateApp'));
    assert.ok(nav.includes('window.location.assign'), 'location fallback');
  });

  it('@capacitor/push-notifications is a dependency (Capacitor 8)', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies['@capacitor/push-notifications'], 'dependency present');
    assert.match(pkg.dependencies['@capacitor/push-notifications'], /^\^8\./);
  });

  it('the gradle shell applies google-services only when the config exists', () => {
    const gradle = read('android/app/build.gradle');
    assert.ok(gradle.includes("apply plugin: 'com.google.gms.google-services'"));
    assert.ok(gradle.includes("file('google-services.json')"), 'conditional on the file');
    assert.ok(gradle.includes('google-services.json not found'), 'warns when absent');
  });

  it('google-services.json is gitignored in both places', () => {
    assert.ok(read('.gitignore').includes('google-services.json'));
    assert.ok(read('android/.gitignore').includes('google-services.json'));
  });

  it('the workflow restores google-services.json from the LEADFLOW secret (lenient by design)', () => {
    const workflow = read('.github/workflows/android.yml');
    assert.ok(workflow.includes('Restore google-services.json from secrets'), 'step exists');
    assert.ok(workflow.includes('LEADFLOW_GOOGLE_SERVICES_JSON_B64'), 'CI secret name');
    assert.ok(workflow.includes('android/app/google-services.json'), 'restored into the app module');
    assert.ok(workflow.includes('com.shantalife.leadflow'), 'package validated');
    // LENIENT: a missing secret warns and the build continues WITHOUT
    // push (the Firebase project may not exist yet at first release).
    // This is a deliberate deviation from fail-fast — see FcmService
    // header + the step comment. If it ever flips to fail-fast, this
    // test must be updated deliberately, not silently.
    const stepStart = workflow.indexOf('Restore google-services.json from secrets');
    const stepEnd = workflow.indexOf('Build signed release APK', stepStart);
    const step = workflow.slice(stepStart, stepEnd);
    assert.ok(step.includes('::warning::'), 'missing secret warns, does not error');
    assert.ok(step.includes('exit 0'), 'the step succeeds without the secret');
    assert.ok(!step.includes('::error::LEADFLOW_GOOGLE_SERVICES_JSON_B64'), 'no fail-fast error for the missing secret');
    // Order: after the keystore restore, before the build.
    assert.ok(
      workflow.indexOf('Restore release keystore from secrets') < stepStart,
      'google-services step follows the keystore step'
    );
    assert.ok(stepEnd > stepStart, 'google-services step precedes the build');
  });

  it('the env catalog documents FIREBASE_SERVICE_ACCOUNT_B64 as OPTIONAL', () => {
    const env = read('server/config/env.ts');
    const idx = env.indexOf('FIREBASE_SERVICE_ACCOUNT_B64');
    assert.ok(idx > 0, 'catalog entry exists');
    assert.ok(env.slice(idx, idx + 400).includes("classification: 'OPTIONAL'"));
  });

  it('docs/ANDROID_RELEASE.md gains §8 (existing sections not renumbered)', () => {
    const docs = read('docs/ANDROID_RELEASE.md');
    assert.ok(docs.includes('## 1. Create the keystore'), '§1 intact');
    assert.ok(docs.includes('## 7. Device smoke test'), '§7 intact');
    assert.ok(docs.includes('## 8. Firebase + push notifications (FCM)'), '§8 added');
    assert.ok(docs.includes('LEADFLOW_GOOGLE_SERVICES_JSON_B64'));
    assert.ok(docs.includes('FIREBASE_SERVICE_ACCOUNT_B64'));
    assert.ok(docs.includes('user-{employeeId}'), 'topic design documented');
  });
});

/* ====================================================================
   7. HTTP integration (PGlite, real production router)
==================================================================== */

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, SHARED_JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  return import('../routes/production.routes.js').then((mod) => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

describe('FCM — HTTP integration', () => {
  let pool: any;
  let app: express.Express;
  let employeeA: any;
  let employeeB: any;

  const token = (user: any) =>
    signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });

  async function setupSchema(p: any) {
    await p.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(100),
        department_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(100) UNIQUE,
        role_name VARCHAR(255),
        hierarchy_level INTEGER,
        data_visibility VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(100) UNIQUE,
        full_name VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        role_id UUID REFERENCES roles(id),
        department_id UUID REFERENCES departments(id),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        recipient_key VARCHAR(100),
        title VARCHAR(255),
        message TEXT,
        lead_code VARCHAR(50),
        reference_id UUID,
        event_type VARCHAR(100),
        is_read BOOLEAN DEFAULT false,
        type VARCHAR(50) DEFAULT 'info',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
  }

  before(async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.JWT_SECRET = 'integration-test-secret';
    process.env.NODE_ENV = 'test';
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 = FAKE_SA_B64;

    const { _setTestPoolForTest } = await import('../database/connection.js');
    const { getPGliteInstanceAsync, createPGlitePoolAsync } = await import('../database/pglitePool.js');
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    const deptId = (
      await pool.query(
        `INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`
      )
    ).rows[0].id;
    const roleId = (
      await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`
      )
    ).rows[0].id;
    const mkUser = async (employeeId: string, email: string) => {
      const res = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, true) RETURNING id`,
        [employeeId, employeeId, email, roleId, deptId]
      );
      return { id: res.rows[0].id, employeeId, email, role: 'EMPLOYEE' };
    };
    employeeA = await mkUser('EMPA', 'empa@test.com');
    employeeB = await mkUser('EMPB', 'empb@test.com');

    app = await createTestApp();
    installFcmStub();
  });

  after(async () => {
    const { _resetPoolsForTest, closePool } = await import('../database/connection.js');
    const { resetPGlite } = await import('../database/pglitePool.js');
    _setFcmFetchForTest(null);
    _resetFcmTokenCacheForTest();
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM notifications`);
    resetFcmStubState();
    _resetFcmTokenCacheForTest();
    installFcmStub();
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 = FAKE_SA_B64;
  });

  it('fcm-subscribe subscribes the caller’s own topic and forgets the token', async () => {
    const res = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ token: 'fcm-token-abc' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, data: { ok: true } });
    assert.equal(fcmIidCalls().length, 1);
    assert.deepEqual(fcmIidCalls()[0].body, {
      to: '/topics/user-EMPA',
      registration_tokens: ['fcm-token-abc'],
    });
    // The token is never echoed back in any response field.
    assert.equal(JSON.stringify(res.body).includes('fcm-token-abc'), false);
  });

  it('fcm-subscribe derives the topic from the session, never the body', async () => {
    const res = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .set('Authorization', `Bearer ${token(employeeB)}`)
      .send({ token: 'fcm-token-b', topic: 'user-EMPA', employeeId: 'EMPA' });
    assert.equal(res.status, 200);
    assert.equal(fcmIidCalls()[0].body.to, '/topics/user-EMPB', 'body topic/employeeId ignored');
  });

  it('fcm-subscribe validates input and auth', async () => {
    const missing = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({});
    assert.equal(missing.status, 400);

    const spaced = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ token: 'has space' });
    assert.equal(spaced.status, 400);

    const unauth = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .send({ token: 'fcm-token-abc' });
    assert.equal(unauth.status, 401);
    assert.equal(fcmIidCalls().length, 0, 'no FCM call for rejected requests');
  });

  it('fcm-subscribe answers 503 push_not_configured without a service account', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    _resetFcmTokenCacheForTest();
    const res = await request(app)
      .post('/api/notifications/push/fcm-subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ token: 'fcm-token-abc' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'push_not_configured');
    assert.equal(fcmCalls.length, 0);
  });

  it('POST /api/notifications publishes the new row to FCM (lead deep link)', async () => {
    const res = await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ userId: 'EMPA', title: 'Hello', message: 'World', leadId: 'LD-100' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.title, 'Hello');

    await waitFor(() => fcmSends().length === 1);
    assert.equal(fcmSends()[0].body.message.topic, 'user-EMPA');
    assert.deepEqual(fcmSends()[0].body.message.data, {
      source: 'leadflow',
      title: 'Hello',
      body: 'World',
      route: '/leads?leadId=LD-100',
      module: 'leadflow',
    });
  });

  it('POST /api/notifications still succeeds when FCM is unconfigured', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    _resetFcmTokenCacheForTest();
    const res = await request(app)
      .post('/api/notifications')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ userId: 'EMPA', title: 'Hello', message: 'World' });
    assert.equal(res.status, 201, 'the notification is saved; push is best-effort');
    await sleep(150);
    assert.equal(fcmCalls.length, 0);
  });
});
