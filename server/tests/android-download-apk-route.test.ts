/**
 * android-download-apk-route.test.ts
 * ------------------------------------------------------------------
 * GET /api/download-apk — the Android APK download redirect route.
 *
 * The published APK carries a friendly, versioned filename
 * ("LeadFlow-V-1.0.0.1.apk"), so the web app never links to GitHub
 * directly: the popup and the login link point at this same-origin
 * route (one constant, ANDROID_APK_DOWNLOAD_URL), and the route asks
 * the GitHub Releases API for the `latest` release, picks its newest
 * .apk asset, and 302-redirects to that asset's browser_download_url
 * — which GitHub serves under its friendly stored name.
 *
 * These tests drive the real handler through a small Express app
 * with supertest, with globalThis.fetch stubbed (this suite must
 * pass offline — no live GitHub call). They pin the happy path
 * (newest APK wins), the 10-minute cache (a repeat call does not
 * re-ask GitHub), and the failure mode (ANY failure redirects to the
 * releases page instead of failing — never a dead end, never a 404).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import { downloadApkHandler, resetDownloadApkCache } from '../routes/downloadApk.js';
import { ANDROID_APK_DOWNLOAD_URL } from '../../src/native/androidPromo';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

const GITHUB_API_LATEST = 'https://api.github.com/repos/Mriduul7621/LeadFlow_V2/releases/latest';
const RELEASES_PAGE = 'https://github.com/Mriduul7621/LeadFlow_V2/releases/latest';
const OLD_APK_URL =
  'https://github.com/Mriduul7621/LeadFlow_V2/releases/download/latest/LeadFlow-V-1.0.0.1.apk';
const NEW_APK_URL =
  'https://github.com/Mriduul7621/LeadFlow_V2/releases/download/latest/LeadFlow-V-1.0.0.2.apk';

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const buildApp = () => {
  const app = express();
  app.get('/api/download-apk', downloadApkHandler);
  return app;
};

function githubReleaseResponse(assets: unknown[], status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ assets }),
  };
}

describe('GET /api/download-apk', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: string[] = [];
  let stubImpl: (url: string) => Promise<StubResponse>;

  beforeEach(() => {
    resetDownloadApkCache();
    fetchCalls = [];
    stubImpl = async () => githubReleaseResponse([]);
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(String(input));
      return stubImpl(String(input));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetDownloadApkCache();
  });

  it('302s to the NEWEST .apk asset in latest (a stale one never wins)', async () => {
    stubImpl = async () =>
      githubReleaseResponse([
        { name: 'LeadFlow-V-1.0.0.1.apk', browser_download_url: OLD_APK_URL, created_at: '2026-11-21T00:00:00Z' },
        { name: 'LeadFlow-V-1.0.0.1.apk.sha256', browser_download_url: `${OLD_APK_URL}.sha256`, created_at: '2026-11-21T00:00:00Z' },
        { name: 'LeadFlow-V-1.0.0.2.apk', browser_download_url: NEW_APK_URL, created_at: '2026-11-21T02:00:00Z' },
      ]);
    const response = await request(buildApp()).get('/api/download-apk').redirects(0);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, NEW_APK_URL, 'the newest asset wins, not the first listed');
    assert.equal(response.headers['cache-control'], 'no-store', 'a redirect must never be cached by the browser');
    assert.deepEqual(fetchCalls, [GITHUB_API_LATEST], 'GitHub is asked for the latest release of this repo');
  });

  it('caches the resolved URL: a repeat call does not re-ask GitHub', async () => {
    stubImpl = async () =>
      githubReleaseResponse([
        { name: 'LeadFlow-V-1.0.0.1.apk', browser_download_url: OLD_APK_URL, created_at: '2026-11-21T00:00:00Z' },
      ]);
    const app = buildApp();
    const first = await request(app).get('/api/download-apk').redirects(0);
    const second = await request(app).get('/api/download-apk').redirects(0);
    assert.equal(first.headers.location, OLD_APK_URL);
    assert.equal(second.headers.location, OLD_APK_URL);
    assert.equal(fetchCalls.length, 1, 'the second request is served from the 10-minute cache (60 unauthenticated GitHub calls/hour per IP)');
    resetDownloadApkCache();
    await request(app).get('/api/download-apk').redirects(0);
    assert.equal(fetchCalls.length, 2, 'after a cache reset the route re-asks GitHub');
  });

  it('a GitHub API failure redirects to the releases page (never a 500)', async () => {
    stubImpl = async () => githubReleaseResponse([], 403);
    const response = await request(buildApp()).get('/api/download-apk').redirects(0);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, RELEASES_PAGE, 'a rate limit still lands the user where they can tap the APK');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('a release with no APK yet redirects to the releases page (never a 404)', async () => {
    stubImpl = async () =>
      githubReleaseResponse([
        { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt', created_at: '2026-11-21T00:00:00Z' },
      ]);
    const response = await request(buildApp()).get('/api/download-apk').redirects(0);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, RELEASES_PAGE);
  });

  it('a network failure redirects to the releases page', async () => {
    stubImpl = async () => {
      throw new Error('fetch failed');
    };
    const response = await request(buildApp()).get('/api/download-apk').redirects(0);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, RELEASES_PAGE);
  });

  it('the route is registered on both entrypoints, and the web constant points at it', () => {
    const apiIndex = read('api/index.ts');
    const serverTs = read('server.ts');
    assert.ok(
      apiIndex.includes("app.get('/api/download-apk', downloadApkHandler)"),
      'the Vercel entrypoint serves the route',
    );
    assert.ok(
      serverTs.includes("app.get('/api/download-apk', downloadApkHandler)"),
      'the standalone entrypoint serves the route',
    );
    assert.ok(
      apiIndex.includes("from '../server/routes/downloadApk.js'"),
      'the Vercel entrypoint imports the shared handler',
    );
    assert.ok(
      serverTs.includes("from './server/routes/downloadApk.js'"),
      'the standalone entrypoint imports the shared handler',
    );
    assert.equal(
      ANDROID_APK_DOWNLOAD_URL,
      '/api/download-apk',
      'the popup and the login link point at this route — one constant, one destination',
    );
  });
});
