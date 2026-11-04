/**
 * push-reminders.test.ts — FREE Web Push follow-up reminders (Phase 2 PR #2)
 * ------------------------------------------------------------------
 * Zero-cost design: Web Push protocol + the free `web-push` library.
 * Agents opt in per device; a daily cron sends ONE summary push —
 * "আজ Xটি follow-up due, Yটি overdue" — that opens /workbench.
 *
 * Coverage:
 *   1. Pure units — VAPID config, cron-secret check, subscription
 *      input validation, the Bangla payload builder.
 *   2. Migration 048 — registered as the last migration; schema shape
 *      guarded in source (table, endpoint uniqueness, user cascade).
 *   3. Frontend units — capability detection + VAPID key decoding
 *      (whatsapp-actions.test.ts style: src modules imported directly).
 *   4. Source guards — service worker handlers, Profile settings
 *      opt-in surface, exactly ONE vercel.json cron entry.
 *   5. Demo mode (no DB) — subscription storage on the fallbackStore
 *      mirror, visibility-scoped counts, and a full daily run through
 *      the injected sender seam (incl. 410 pruning). No network.
 *   6. HTTP integration (PGlite) — public-key enabled/disabled,
 *      subscribe validation + upsert, self-scoped unsubscribe, cron
 *      auth (unset secret → 503, wrong → 401), cron payload counts
 *      from fixture leads at the Dhaka day boundary, 410 pruning.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  buildDailyReminderPayload,
  checkCronAuthorization,
  computeFollowUpReminderCounts,
  deleteOwnPushSubscription,
  getVapidConfig,
  isPushConfigured,
  listPushSubscriptions,
  runDailyPushReminders,
  upsertPushSubscription,
  validatePushSubscriptionInput,
  _setPushSenderForTest,
} from '../services/PushReminderService.js';
import { up as pushSubscriptionsMigration } from '../database/migrations/048_push_subscriptions.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { fallbackStore } from '../fallbackStore.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';
import { JWT_SECRET as SHARED_JWT_SECRET } from '../routes/production/shared.js';
import type { CallerDbInfo } from '../routes/production/shared.js';
import {
  isPushSupported,
  urlBase64ToUint8Array,
} from '../../src/modules/notifications/services/pushService';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Throwaway VAPID pair generated for tests only (never deployed). */
const TEST_VAPID_PUBLIC =
  'BOGFAxhUn6vhqhmeak1DeFsynICRiOts4PzyscI50rly84U6BdCBSRxiuOU6AoT27GE2hQpwuVfW_pp5BsWg6XM';
const TEST_VAPID_PRIVATE = 'tKbBZatMgMVAR1mkB5TSIJZr2RSjdyBuk87V4MwIZQo';
const TEST_P256DH = TEST_VAPID_PUBLIC;
const TEST_AUTH = 'testauthsecret123456';
const TEST_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-device-1';

const validBody = () => ({
  endpoint: TEST_ENDPOINT,
  keys: { p256dh: TEST_P256DH, auth: TEST_AUTH },
});

/* ====================================================================
   1. Pure units
==================================================================== */

describe('VAPID config', () => {
  it('is disabled when either key is missing', () => {
    assert.equal(getVapidConfig({} as any), null);
    assert.equal(getVapidConfig({ VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC } as any), null);
    assert.equal(getVapidConfig({ VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE } as any), null);
    assert.equal(isPushConfigured({} as any), false);
  });

  it('returns the pair with the default subject when VAPID_SUBJECT is unset', () => {
    const cfg = getVapidConfig({
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
    } as any);
    assert.ok(cfg);
    assert.equal(cfg!.publicKey, TEST_VAPID_PUBLIC);
    assert.equal(cfg!.subject, 'mailto:admin@shantalife.com');
    assert.equal(isPushConfigured({
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
    } as any), true);
  });

  it('honours an explicit VAPID_SUBJECT', () => {
    const cfg = getVapidConfig({
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE,
      VAPID_SUBJECT: 'mailto:ops@example.com',
    } as any);
    assert.equal(cfg!.subject, 'mailto:ops@example.com');
  });
});

describe('cron authorization', () => {
  const env = { CRON_SECRET: 's3cr3t-value' } as any;

  it('is disabled when CRON_SECRET is unset (never falls back to open)', () => {
    assert.equal(checkCronAuthorization({ authorization: 'Bearer anything' }, {} as any), 'disabled');
    assert.equal(checkCronAuthorization({}, {} as any), 'disabled');
  });

  it('accepts the Vercel-style Bearer header', () => {
    assert.equal(checkCronAuthorization({ authorization: 'Bearer s3cr3t-value' }, env), 'ok');
  });

  it('accepts the x-cron-secret header', () => {
    assert.equal(checkCronAuthorization({ 'x-cron-secret': 's3cr3t-value' }, env), 'ok');
  });

  it('rejects missing and wrong secrets', () => {
    assert.equal(checkCronAuthorization({}, env), 'unauthorized');
    assert.equal(checkCronAuthorization({ authorization: 'Bearer wrong' }, env), 'unauthorized');
    assert.equal(checkCronAuthorization({ authorization: 'Bearer s3cr3t-value-extra' }, env), 'unauthorized');
  });
});

describe('subscription input validation', () => {
  it('accepts the standard PushSubscription JSON shape', () => {
    const result = validatePushSubscriptionInput(validBody());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.endpoint, TEST_ENDPOINT);
      assert.equal(result.value.p256dh, TEST_P256DH);
      assert.equal(result.value.auth, TEST_AUTH);
    }
  });

  it('accepts flat p256dh/auth fields', () => {
    const result = validatePushSubscriptionInput({
      endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: TEST_AUTH,
    });
    assert.equal(result.ok, true);
  });

  it('rejects non-objects and missing endpoints', () => {
    assert.equal(validatePushSubscriptionInput(null).ok, false);
    assert.equal(validatePushSubscriptionInput('nope').ok, false);
    assert.equal(validatePushSubscriptionInput({ keys: { p256dh: TEST_P256DH, auth: TEST_AUTH } }).ok, false);
  });

  it('rejects non-https and malformed endpoints', () => {
    assert.equal(validatePushSubscriptionInput({ endpoint: 'http://example.com/x', keys: { p256dh: TEST_P256DH, auth: TEST_AUTH } }).ok, false);
    assert.equal(validatePushSubscriptionInput({ endpoint: 'not a url', keys: { p256dh: TEST_P256DH, auth: TEST_AUTH } }).ok, false);
  });

  it('rejects missing, short or non-base64url keys', () => {
    assert.equal(validatePushSubscriptionInput({ endpoint: TEST_ENDPOINT, keys: { auth: TEST_AUTH } }).ok, false);
    assert.equal(validatePushSubscriptionInput({ endpoint: TEST_ENDPOINT, keys: { p256dh: 'short', auth: TEST_AUTH } }).ok, false);
    assert.equal(validatePushSubscriptionInput({ endpoint: TEST_ENDPOINT, keys: { p256dh: TEST_P256DH, auth: 'has spaces!!' } }).ok, false);
    assert.equal(validatePushSubscriptionInput({ endpoint: TEST_ENDPOINT, keys: { p256dh: TEST_P256DH } }).ok, false);
  });
});

describe('daily reminder payload', () => {
  it('combines due-today and overdue counts in Bangla', () => {
    const payload = buildDailyReminderPayload({ dueToday: 3, overdue: 2 });
    assert.equal(payload.body, 'আজ 3টি follow-up due, 2টি overdue আছে। Workbench-এ দেখে নিন।');
    assert.equal(payload.url, '/workbench');
    assert.ok(payload.title.includes('রিমাইন্ডার'));
  });

  it('omits the overdue part when zero', () => {
    const payload = buildDailyReminderPayload({ dueToday: 5, overdue: 0 });
    assert.equal(payload.body, 'আজ 5টি follow-up due আছে। Workbench-এ দেখে নিন।');
  });

  it('omits the due-today part when zero', () => {
    const payload = buildDailyReminderPayload({ dueToday: 0, overdue: 4 });
    assert.equal(payload.body, '4টি overdue আছে। Workbench-এ দেখে নিন।');
  });

  it('honours a custom target url', () => {
    const payload = buildDailyReminderPayload({ dueToday: 1, overdue: 0 }, '/custom');
    assert.equal(payload.url, '/custom');
  });
});

/* ====================================================================
   2. Migration 048
==================================================================== */

describe('migration 048_push_subscriptions', () => {
  it('is registered in runMigrations (049_lead_auto_assignment_flag later became the tail)', () => {
    assert.ok(MIGRATION_IDS.includes('048_push_subscriptions'));
    assert.ok(read('server/database/runMigrations.ts').includes('048_push_subscriptions'));
  });

  it('creates the table with endpoint uniqueness and a cascading user FK', () => {
    const src = read('server/database/migrations/048_push_subscriptions.ts');
    assert.ok(src.includes('CREATE TABLE IF NOT EXISTS push_subscriptions'));
    assert.ok(src.includes('REFERENCES users(id) ON DELETE CASCADE'));
    assert.ok(src.includes('uq_push_subscriptions_endpoint'));
    assert.ok(src.includes('idx_push_subscriptions_user'));
  });
});

/* ====================================================================
   3. Frontend units
==================================================================== */

describe('frontend push capability detection', () => {
  const full = () => ({
    navigator: { serviceWorker: {} },
    PushManager: function PushManager() {},
    Notification: function Notification() {},
  });

  it('is supported only with serviceWorker + PushManager + Notification', () => {
    assert.equal(isPushSupported(full()), true);
    const noPm = full(); delete (noPm as any).PushManager;
    assert.equal(isPushSupported(noPm), false);
    const noSw = full(); (noSw as any).navigator = {};
    assert.equal(isPushSupported(noSw), false);
    const noNotif = full(); delete (noNotif as any).Notification;
    assert.equal(isPushSupported(noNotif), false);
    assert.equal(isPushSupported(null), false);
    assert.equal(isPushSupported(undefined), false);
  });

  it('decodes a VAPID public key to a 65-byte uncompressed point', () => {
    const bytes = urlBase64ToUint8Array(TEST_VAPID_PUBLIC);
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 0x04);
  });

  it('decodes base64url (not just base64) characters', () => {
    // 0xfb 0xff 0xfe encodes as "-__-" in base64url.
    assert.deepEqual([...urlBase64ToUint8Array('-__-')], [251, 255, 254]);
  });
});

/* ====================================================================
   4. Source guards
==================================================================== */

describe('push reminder source guards', () => {
  it('service worker handles push + notificationclick and opens the workbench', () => {
    const sw = read('public/sw.js');
    assert.ok(sw.includes("addEventListener('push'"));
    assert.ok(sw.includes("addEventListener('notificationclick'"));
    assert.ok(sw.includes('showNotification'));
    assert.ok(sw.includes('/workbench'));
    // The worker must stay push-only: no fetch interception, no caching.
    assert.ok(!sw.includes("addEventListener('fetch'"));
    assert.ok(!sw.includes('caches.open'));
  });

  it('Profile settings carries the opt-in toggle wired to pushService', () => {
    const page = read('src/modules/settings/pages/ProfileSettings.tsx');
    assert.ok(page.includes('Follow-up reminders'));
    assert.ok(page.includes('getPushReminderState'));
    assert.ok(page.includes('enablePushReminders'));
    assert.ok(page.includes('disablePushReminders'));
    assert.ok(page.includes('type="checkbox"'));
  });

  it('the service worker is registered from the app entry', () => {
    assert.ok(read('src/main.tsx').includes('registerPushServiceWorker'));
  });

  it('permission is requested only inside the enable flow, never at boot', () => {
    const svc = read('src/modules/notifications/services/pushService.ts');
    assert.ok(svc.includes('Notification.requestPermission()'));
    assert.ok(!read('src/main.tsx').includes('requestPermission'));
  });

  it('vercel.json schedules exactly one daily cron to the cron endpoint', () => {
    const vercel = JSON.parse(read('vercel.json'));
    assert.ok(Array.isArray(vercel.crons));
    assert.equal(vercel.crons.length, 1);
    assert.equal(vercel.crons[0].path, '/api/notifications/push/cron-daily');
    assert.equal(vercel.crons[0].schedule, '30 2 * * *');
  });

  it('.env.example documents the VAPID pair, generation and the cron secret', () => {
    const example = read('.env.example');
    assert.ok(example.includes('VAPID_PUBLIC_KEY'));
    assert.ok(example.includes('VAPID_PRIVATE_KEY'));
    assert.ok(example.includes('generate-vapid-keys'));
    assert.ok(example.includes('CRON_SECRET'));
  });
});

/* ====================================================================
   5. Demo mode (fallbackStore, no database)
==================================================================== */

describe('push reminders — demo mode storage, counts and run', () => {
  const savedUsers = [...fallbackStore.users];
  const savedLeads = [...fallbackStore.leads];
  const savedSubs = [...fallbackStore.pushSubscriptions];
  const savedDbUrl = process.env.DATABASE_URL;

  const demoCaller: CallerDbInfo = {
    id: 'demo-user-1',
    employee_id: 'EMP_DEMO',
    email: 'demo@test.com',
    role_id: null,
    role_code: 'EMPLOYEE',
    department_id: null,
  };

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
  });

  after(() => {
    fallbackStore.users = savedUsers;
    fallbackStore.leads = savedLeads;
    fallbackStore.pushSubscriptions = savedSubs;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    _setPushSenderForTest(null);
  });

  beforeEach(() => {
    fallbackStore.pushSubscriptions = [];
  });

  it('upserts by endpoint and lists the stored subscription', async () => {
    const first = await upsertPushSubscription('demo-user-1', { endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: TEST_AUTH }, 'TestAgent/1.0');
    assert.equal(first.userId, 'demo-user-1');
    const second = await upsertPushSubscription('demo-user-1', { endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: 'otherauthsecret999' }, 'TestAgent/1.0');
    assert.equal(second.id, first.id);
    const list = await listPushSubscriptions();
    assert.equal(list.length, 1);
    assert.equal(list[0].auth, 'otherauthsecret999');
  });

  it('unsubscribe removes only the owner\u2019s row', async () => {
    await upsertPushSubscription('demo-user-1', { endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: TEST_AUTH }, null);
    assert.equal(await deleteOwnPushSubscription('someone-else', TEST_ENDPOINT), false);
    assert.equal((await listPushSubscriptions()).length, 1);
    assert.equal(await deleteOwnPushSubscription('demo-user-1', TEST_ENDPOINT), true);
    assert.equal((await listPushSubscriptions()).length, 0);
  });

  it('counts only the caller\u2019s due-today + overdue, Dhaka bounds, terminal excluded', async () => {
    const counts = await computeFollowUpReminderCounts(demoCaller, new Date());
    assert.deepEqual(counts, { dueToday: 1, overdue: 1 });
  });

  it('daily run sends one summary per device with the composed payload', async () => {
    await upsertPushSubscription('demo-user-1', { endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: TEST_AUTH }, null);
    const sent: Array<{ endpoint: string; payload: any }> = [];
    _setPushSenderForTest(async (target, payloadJson) => {
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payloadJson) });
    });
    const summary = await runDailyPushReminders(new Date());
    assert.equal(summary.enabled, true);
    assert.equal(summary.usersTargeted, 1);
    assert.equal(summary.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, TEST_ENDPOINT);
    assert.equal(sent[0].payload.body, 'আজ 1টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।');
    assert.equal(sent[0].payload.url, '/workbench');
  });

  it('daily run prunes subscriptions the push service reports gone (410)', async () => {
    await upsertPushSubscription('demo-user-1', { endpoint: TEST_ENDPOINT, p256dh: TEST_P256DH, auth: TEST_AUTH }, null);
    _setPushSenderForTest(async () => {
      const err: any = new Error('subscription gone');
      err.statusCode = 410;
      throw err;
    });
    const summary = await runDailyPushReminders(new Date());
    assert.equal(summary.pruned, 1);
    assert.equal(summary.sent, 0);
    assert.equal((await listPushSubscriptions()).length, 0);
  });

  it('daily run is a clean no-op when VAPID is unset', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const summary = await runDailyPushReminders(new Date());
      assert.equal(summary.enabled, false);
      assert.equal(summary.sent, 0);
    } finally {
      process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
      process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    }
  });
});

/* ====================================================================
   6. HTTP integration (PGlite, real production router + migration)
==================================================================== */

const INTEGRATION_JWT_SECRET = 'leadflow-ci-only-secret';

// NOTE on the signing secret: this file statically imports
// PushReminderService (and through it production/shared.js) at module
// load, BEFORE the integration before() hook can set JWT_SECRET — so
// shared.js captured its development fallback secret for this process.
// Tokens are therefore signed with the secret shared.js actually
// verifies against (its exported JWT_SECRET), which keeps the auth
// behaviour under test identical either way.
function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, SHARED_JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

describe('push reminders — HTTP integration', () => {
  let pool: any;
  let app: express.Express;
  let employeeA: any;
  let employeeB: any;
  let employeeC: any;

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
        hierarchy_level INT DEFAULT 0,
        data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB,
        actions JSONB,
        feature_permissions JSONB
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        is_active BOOLEAN DEFAULT TRUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        reporting_chain JSONB DEFAULT '[]'::jsonb,
        subordinates JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        permission_name VARCHAR(255)
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50) UNIQUE,
        customer_name VARCHAR(255) NOT NULL,
        mobile VARCHAR(30) NOT NULL,
        assigned_to UUID,
        assigned_by UUID,
        assigned_at TIMESTAMP,
        last_contacted_at TIMESTAMP,
        next_follow_up_at TIMESTAMP,
        current_status VARCHAR(255) DEFAULT 'New',
        status_history JSONB DEFAULT '[]'::jsonb,
        assignment_history JSONB DEFAULT '[]'::jsonb,
        documents JSONB DEFAULT '[]'::jsonb,
        custom_fields JSONB DEFAULT '{}'::jsonb,
        tags JSONB DEFAULT '[]'::jsonb,
        created_by UUID,
        updated_by UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP,
        deleted_by UUID,
        follow_up_count INT DEFAULT 0
      );
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_key VARCHAR(100) NOT NULL,
        option_value VARCHAR(255) NOT NULL,
        option_label VARCHAR(255),
        sort_order INT DEFAULT 0,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        meta JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(field_key, option_value)
      );
    `);
  }

  async function insertLead(opts: {
    code: string; assignedTo: string; nextAt: string | null; status?: string; deleted?: boolean;
  }) {
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, current_status, next_follow_up_at, is_deleted)
       VALUES ($1, $2, '01710000009', $3, $3, $4, $5, $6)`,
      [opts.code, opts.code, opts.assignedTo, opts.status || 'Contacted', opts.nextAt, opts.deleted === true],
    );
  }

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
    process.env.JWT_SECRET = INTEGRATION_JWT_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
    process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    process.env.CRON_SECRET = 'test-cron-secret';

    const { _setTestPoolForTest } = await import('../database/connection.js');
    const { getPGliteInstanceAsync, createPGlitePoolAsync } = await import('../database/pglitePool.js');
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);
    // The REAL migration under test creates push_subscriptions.
    await pushSubscriptionsMigration();

    const deptId = (await pool.query(
      `INSERT INTO departments (department_code, department_name) VALUES ('DEPT1', 'Sales') RETURNING id`,
    )).rows[0].id;
    const roleId = (await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`,
    )).rows[0].id;
    const mkUser = async (employeeId: string, email: string) => {
      const res = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, is_active)
         VALUES ($1, $2, $3, 'hashed', $4, $5, true) RETURNING id`,
        [employeeId, employeeId, email, roleId, deptId],
      );
      return { id: res.rows[0].id, employeeId, email, role: 'EMPLOYEE' };
    };
    employeeA = await mkUser('EMPA', 'empa@test.com');
    employeeB = await mkUser('EMPB', 'empb@test.com');
    employeeC = await mkUser('EMPC', 'empc@test.com');

    app = await createTestApp();
  });

  after(async () => {
    const { _resetPoolsForTest, closePool } = await import('../database/connection.js');
    const { resetPGlite } = await import('../database/pglitePool.js');
    _setPushSenderForTest(null);
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.CRON_SECRET;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM push_subscriptions`);
    await pool.query(`DELETE FROM leads`);
    _setPushSenderForTest(null);
  });

  it('public-key requires auth and returns the VAPID public key when enabled', async () => {
    const unauth = await request(app).get('/api/notifications/push/public-key');
    assert.equal(unauth.status, 401);
    const res = await request(app)
      .get('/api/notifications/push/public-key')
      .set('Authorization', `Bearer ${token(employeeA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.enabled, true);
    assert.equal(res.body.data.publicKey, TEST_VAPID_PUBLIC);
  });

  it('public-key reports enabled:false when VAPID is unset', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const res = await request(app)
        .get('/api/notifications/push/public-key')
        .set('Authorization', `Bearer ${token(employeeA)}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, { enabled: false });
    } finally {
      process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
      process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    }
  });

  it('subscribe rejects malformed bodies with 400 and stores nothing', async () => {
    const bad = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ endpoint: 'http://insecure.example/x', keys: { p256dh: TEST_P256DH, auth: TEST_AUTH } });
    assert.equal(bad.status, 400);
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`);
    assert.equal(count.rows[0].n, 0);
  });

  it('subscribe stores the caller\u2019s subscription and upserts on re-subscribe', async () => {
    const res = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send(validBody());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.subscribed, true);

    const again = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ endpoint: TEST_ENDPOINT, keys: { p256dh: TEST_P256DH, auth: 'rotatedauthsecret77' } });
    assert.equal(again.status, 200);

    const rows = await pool.query(`SELECT * FROM push_subscriptions`);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, employeeA.id);
    assert.equal(rows.rows[0].auth, 'rotatedauthsecret77');
  });

  it('subscribe answers 503 when push is not configured on the server', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const res = await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', `Bearer ${token(employeeA)}`)
        .send(validBody());
      assert.equal(res.status, 503);
    } finally {
      process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
      process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    }
  });

  it('unsubscribe is self-scoped: another user cannot remove my device', async () => {
    await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send(validBody());

    const byOther = await request(app)
      .post('/api/notifications/push/unsubscribe')
      .set('Authorization', `Bearer ${token(employeeB)}`)
      .send({ endpoint: TEST_ENDPOINT });
    assert.equal(byOther.status, 200);
    assert.equal(byOther.body.data.removed, false);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`)).rows[0].n, 1);

    const byOwner = await request(app)
      .post('/api/notifications/push/unsubscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send({ endpoint: TEST_ENDPOINT });
    assert.equal(byOwner.status, 200);
    assert.equal(byOwner.body.data.removed, true);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`)).rows[0].n, 0);
  });

  it('cron rejects a missing or wrong secret with 401', async () => {
    const missing = await request(app).get('/api/notifications/push/cron-daily');
    assert.equal(missing.status, 401);
    const wrong = await request(app)
      .get('/api/notifications/push/cron-daily')
      .set('Authorization', 'Bearer not-the-secret');
    assert.equal(wrong.status, 401);
  });

  it('cron is disabled (503) when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    try {
      const res = await request(app)
        .get('/api/notifications/push/cron-daily')
        .set('Authorization', 'Bearer test-cron-secret');
      assert.equal(res.status, 503);
    } finally {
      process.env.CRON_SECRET = 'test-cron-secret';
    }
  });

  it('cron no-ops cleanly (200, enabled:false) when VAPID is unset', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const res = await request(app)
        .get('/api/notifications/push/cron-daily')
        .set('Authorization', 'Bearer test-cron-secret');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.enabled, false);
      assert.equal(res.body.data.sent, 0);
    } finally {
      process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
      process.env.VAPID_PRIVATE_KEY = TEST_VAPID_PRIVATE;
    }
  });

  it('cron sends ONE summary per subscribed user with Dhaka-boundary counts', async () => {
    // Subscriptions: A (has due work) and C (nothing due). B never subscribes.
    await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send(validBody());
    await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeC)}`)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-c', keys: { p256dh: TEST_P256DH, auth: TEST_AUTH } });

    const b = getDhakaBusinessDayBounds(new Date());
    const at = (ms: number) => new Date(b.todayStart.getTime() + ms).toISOString();
    await insertLead({ code: 'cron-overdue', assignedTo: employeeA.id, nextAt: at(-2 * 3600000) });
    await insertLead({ code: 'cron-today-1', assignedTo: employeeA.id, nextAt: at(2 * 3600000) });
    await insertLead({ code: 'cron-today-2', assignedTo: employeeA.id, nextAt: at(5 * 3600000) });
    await insertLead({ code: 'cron-upcoming', assignedTo: employeeA.id, nextAt: at(26 * 3600000) });
    await insertLead({ code: 'cron-terminal', assignedTo: employeeA.id, nextAt: at(1 * 3600000), status: 'Converted' });
    await insertLead({ code: 'cron-deleted', assignedTo: employeeA.id, nextAt: at(1 * 3600000), deleted: true });
    await insertLead({ code: 'cron-other-user', assignedTo: employeeB.id, nextAt: at(1 * 3600000) });

    const sent: Array<{ endpoint: string; payload: any }> = [];
    _setPushSenderForTest(async (target, payloadJson) => {
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payloadJson) });
    });

    const res = await request(app)
      .get('/api/notifications/push/cron-daily')
      .set('Authorization', 'Bearer test-cron-secret');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.usersTargeted, 1);
    assert.equal(res.body.data.sent, 1);
    assert.equal(res.body.data.skippedNoDue, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, TEST_ENDPOINT);
    assert.equal(sent[0].payload.body, 'আজ 2টি follow-up due, 1টি overdue আছে। Workbench-এ দেখে নিন।');
    assert.equal(sent[0].payload.url, '/workbench');
  });

  it('cron prunes subscriptions whose push service answers 410', async () => {
    await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token(employeeA)}`)
      .send(validBody());
    const b = getDhakaBusinessDayBounds(new Date());
    await insertLead({
      code: 'cron-prune', assignedTo: employeeA.id,
      nextAt: new Date(b.todayStart.getTime() + 3600000).toISOString(),
    });
    _setPushSenderForTest(async () => {
      const err: any = new Error('gone');
      err.statusCode = 410;
      throw err;
    });
    const res = await request(app)
      .get('/api/notifications/push/cron-daily')
      .set('Authorization', 'Bearer test-cron-secret');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.pruned, 1);
    assert.equal(res.body.data.sent, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`)).rows[0].n, 0);
  });
});
