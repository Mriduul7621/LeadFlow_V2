/**
 * android-capacitor-app.test.ts
 * ------------------------------------------------------------------
 * The Android app used to be a Trusted Web Activity: a shell that opened a
 * remote URL. It shipped broken — the URL had no DNS, a TWA has no fallback,
 * so the launcher showed the browser error page — and nothing in the test suite
 * could have noticed, because every piece was individually "correct".
 *
 * The app is now a Capacitor build: the web bundle is packaged INSIDE the APK.
 * These guards keep the three things that can silently break it from breaking:
 *
 *   1. **the bundle exists and knows the API origin** — a Capacitor build with
 *      no `VITE_API_BASE_URL` installs fine and then fails on its first request
 *      from the WebView (whose own origin serves no API);
 *   2. **the API accepts the WebView origin** — Capacitor runs the app as
 *      `https://localhost`, so the server needs CORS for it (server-side tests
 *      in this suite, plus the pure resolver tests for lib/apiBase.ts);
 *   3. **the install path stays cheap** — same package id, same signing key and
 *      a rising `versionCode`, so a new APK upgrades the app already installed
 *      instead of asking for an uninstall first.
 *
 * DNS is deliberately NOT asserted: "does <host> resolve today" is a hosting
 * fact, not a code fact, and this suite must pass offline. The live check is the
 * documented `curl` in docs/ANDROID_APP.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import { normalizeApiBase, resolveApiBaseUrl, withApiBase } from '../../src/lib/apiBase';
import { applyProductionHttpSecurity, createApiCorsMiddleware, resolveAllowedCorsOrigins } from '../middleware.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

describe('Android app — Capacitor packaging', () => {
  const config = read('capacitor.config.ts');
  const workflow = read('.github/workflows/android-debug-apk.yml');
  const pkg = JSON.parse(read('package.json'));
  const docs = read('docs/ANDROID_APP.md');
  const apiClient = read('src/lib/apiClient.ts');
  const viteConfig = read('vite.config.ts');

  it('the Capacitor config bundles the web build under the shipped identity', () => {
    assert.match(config, /appId:\s*'com\.saudalmahi\.leadflow'/, 'the appId IS the installed app — changing it silently strands existing installs');
    assert.match(config, /appName:\s*'Shanta Life LeadFlow'/);
    assert.match(config, /webDir:\s*'dist'/, 'the built site must be the packaged asset directory (vite outDir)');
    assert.match(read('vite.config.ts'), /defineConfig/, 'sanity: vite config is readable');
    assert.equal(
      /outDir\s*:/.test(viteConfig),
      false,
      'vite must keep its default outDir ("dist") — capacitor.config.ts points there',
    );
    assert.match(config, /androidScheme:\s*'https'/, 'the WebView origin (and therefore the CORS allowlist) depends on this');
  });

  it('capacitor is a real dependency, not a global CLI hope', () => {
    assert.ok(pkg.dependencies['@capacitor/core'], '@capacitor/core must be a dependency (runtime)');
    assert.ok(pkg.dependencies['@capacitor/android'], '@capacitor/android must be a dependency (the platform package CI adds)');
    assert.ok(pkg.devDependencies['@capacitor/cli'], '@capacitor/cli must be a devDependency (npx cap add/sync)');
    assert.ok(pkg.scripts['build:web'], 'the web-only build must exist so the APK does not carry dist/server.cjs');
    assert.equal(pkg.scripts['build:web'].includes('esbuild'), false, 'build:web must not build the server bundle');
  });

  it('the workflow bakes the API origin into the bundle, and fails if it does not land', () => {
    assert.match(workflow, /VITE_API_BASE_URL:\s*\$\{\{\s*steps\.inputs\.outputs\.api_base\s*\}\}/, 'the bundle must be built with the API origin injected');
    assert.ok(workflow.includes('npm run build:web'), 'the APK is built from the web-only build');
    assert.ok(
      workflow.includes('grep -rlF "$VITE_API_BASE_URL" dist/assets'),
      'the build must verify the origin is IN the bundle before Gradle runs (a silent miss installs and then fails)',
    );
    assert.ok(workflow.includes('default: "https://lead-flow-jet.vercel.app"'), 'the default API base must be an origin that actually serves /api');
    // No leftover TWA machinery: the old wrapper decided which remote URL to
    // open (DEFAULT_HOST/appHost/manifest host). A bundled app has none of it.
    assert.equal(/DEFAULT_HOST/.test(workflow), false, 'no leftover TWA host input');
    assert.equal(/appHost|android:host/.test(workflow), false, 'no leftover TWA manifest host wiring');
    assert.equal(/npx @bubblewrap\/cli|bubblewrap/.test(workflow), false, 'the TWA toolchain must be gone');
  });

  it('the workflow packages, verifies and publishes the app', () => {
    assert.ok(workflow.includes('npx cap add android'), 'the Android platform is generated by Capacitor');
    assert.ok(workflow.includes('npx cap sync android'), 'the built assets must be synced into the platform before Gradle');
    assert.ok(workflow.includes('cp -R branding/android/res/mipmap-*'), 'the branded launcher icons must be applied');
    assert.equal(
      workflow.includes('cp -R branding/android/res/.'),
      false,
      'only the mipmaps may be copied: the generated project already defines values/*.xml and a blanket copy would duplicate a resource or strip @string/app_name',
    );
    assert.ok(workflow.includes('<string name="app_name">LeadFlow</string>'), 'the launcher label stays the short name the previous install used');
    assert.ok(workflow.includes('branding/android/debug.keystore'), 'the committed signing key must be used');
    assert.ok(workflow.includes('tag_name: android-debug'), 'the permanent download link must keep publishing');
    assert.ok(/push:\s*\n\s*branches:\s*\[main\]/.test(workflow), 'a push to main must republish — the assets live in the APK');
    // the APK is read back, not trusted
    assert.ok(workflow.includes('unzip -q -o "$APK" -d /tmp/apk'), 'the produced APK must be inspected');
    assert.ok(workflow.includes('assets/public/index.html'), 'the check must prove the web app is inside the APK');
  });

  it('the package identity and signing key on disk are the ones an existing install has', () => {
    // The app on a tester's phone is `com.saudalmahi.leadflow`, signed with this
    // keystore's certificate (public/.well-known/assetlinks.json records that
    // fingerprint for the App Links setup). If either drifts, Android refuses
    // the update and the tester has to uninstall first.
    const links = JSON.parse(read('public/.well-known/assetlinks.json'));
    const target = links[0].target;
    assert.equal(target.package_name, 'com.saudalmahi.leadflow', 'the assetlinks package must stay the app identity');
    assert.ok(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(target.sha256_cert_fingerprints[0]),
      'a real SHA-256 certificate fingerprint must be recorded',
    );
    const keyPath = `${repoRoot}branding/android/debug.keystore`;
    assert.ok(existsSync(keyPath), 'the signing key the workflow references must exist in the repo');
    assert.ok(statSync(keyPath).size > 500, 'and must actually contain a key (not a placeholder)');
  });

  it('the install path upgrades the app instead of forcing an uninstall', () => {
    assert.ok(workflow.includes('version_code=${{ github.run_number }}'), 'versionCode must rise every run, or Android refuses the update');
    assert.match(workflow, /versionCode\s+\d+'|versionCode \{version_code\}/, 'the generated Gradle project must have its versionCode patched');
    assert.ok(workflow.includes("storeFile file('../../branding/android/debug.keystore')"), 'the generated project must sign with the committed key');
  });

  it('the API client applies the base in ONE place (every call site inherits it)', () => {
    assert.ok(apiClient.includes("from './apiBase'"), 'apiClient must use the shared resolver');
    assert.ok(apiClient.includes('withApiBase(url, apiBase)'), 'the fetch patch must rewrite API paths');
    assert.ok(apiClient.includes('new Request(target, input as RequestInit)'), 'a Request instance must be remapped, not dropped');
    // and the resolver must be driven by the build-time value, not a literal
    assert.ok(viteConfig.includes("'import.meta.env.VITE_API_BASE_URL'"), 'vite must inject the API base (same pattern as the other public vars)');
  });

  it('the documentation describes the bundled app, not a remote-URL shell', () => {
    assert.ok(docs.includes('bundled'), 'the doc must say the app is bundled');
    assert.ok(docs.includes('CORS'), 'the doc must state the API-origin/CORS requirement');
    assert.ok(docs.includes('needs a new APK'), 'the doc must be honest that UI changes ship with a new APK');
    assert.equal(docs.includes('app.saudalmahi.com` full-screen'), false, 'no leftover claim that the app opens the branded domain');
  });
});

describe('API base resolution (pure)', () => {
  it('accepts an https origin, rejects everything else', () => {
    assert.equal(normalizeApiBase('https://lead-flow-jet.vercel.app'), 'https://lead-flow-jet.vercel.app');
    assert.equal(normalizeApiBase('https://example.com/'), 'https://example.com', 'trailing slash stripped');
    assert.equal(normalizeApiBase('https://example.com/some/path'), 'https://example.com', 'origin only — a base with a path would double up');
    assert.equal(normalizeApiBase('http://10.0.2.2:3000'), 'http://10.0.2.2:3000', 'a local/dev origin with a port is valid');
    assert.equal(normalizeApiBase(''), '');
    assert.equal(normalizeApiBase(null), '');
    assert.equal(normalizeApiBase('example.com'), '', 'a bare host is refused, not guessed');
    assert.equal(normalizeApiBase('javascript:alert(1)'), '');
    assert.equal(normalizeApiBase('file:///etc/passwd'), '');
  });

  it('prefers the runtime override, then the build-time value, and otherwise means "same origin"', () => {
    assert.equal(resolveApiBaseUrl('https://runtime.example'), 'https://runtime.example');
    assert.equal(resolveApiBaseUrl('not-an-origin'), '', 'a bad override must not silently become a base');
    // no override injected and no VITE_API_BASE_URL under node => same origin
    assert.equal(resolveApiBaseUrl(), '');
  });

  it('rewrites only same-origin API paths — nothing else', () => {
    const base = 'https://api.example';
    assert.equal(withApiBase('/api/leads', base), 'https://api.example/api/leads');
    assert.equal(withApiBase('/api/leads/123/history?x=1', base), 'https://api.example/api/leads/123/history?x=1');
    assert.equal(withApiBase('/assets/logo.png', base), '/assets/logo.png', 'non-API paths stay local (they are bundled)');
    assert.equal(withApiBase('https://other.example/api/leads', base), 'https://other.example/api/leads', 'an absolute URL was deliberate');
    assert.equal(withApiBase('//other.example/api/leads', base), '//other.example/api/leads', 'protocol-relative is left alone');
    assert.equal(withApiBase('/api/leads', ''), '/api/leads', 'no base configured => the web behaviour, unchanged');
    assert.equal(withApiBase('', base), '');
  });
});

describe('CORS for the WebView origin', () => {
  function run(origin: string | undefined, method = 'GET', extra: Record<string, string> = {}) {
    const middleware = createApiCorsMiddleware();
    const headers: Record<string, string> = {};
    const req: any = { method, headers: { ...(origin ? { origin } : {}), ...extra } };
    let status = 0;
    let ended = false;
    let nextCalled = false;
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (code: number) => { status = code; return res; },
      end: () => { ended = true; },
      json: () => { ended = true; },
    };
    middleware(req, res, () => { nextCalled = true; });
    return { headers, status, ended, nextCalled };
  }

  it('the WebView origins are always allowed, whatever the deployment configures', () => {
    const allowed = resolveAllowedCorsOrigins({ CORS_ALLOWED_ORIGINS: 'https://staging.example' } as any);
    for (const origin of ['https://localhost', 'capacitor://localhost', 'http://localhost']) {
      assert.ok(allowed.includes(origin), `${origin} must always be allowed — the Android app runs there`);
    }
    assert.ok(allowed.includes('https://staging.example'), 'an explicitly configured origin is additive');
  });

  it('answers a preflight from the app origin with exactly what the browser needs', () => {
    const result = run('https://localhost', 'OPTIONS', {
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    });
    assert.equal(result.status, 204, 'a preflight is answered, never left to the routes');
    assert.equal(result.ended, true);
    assert.equal(result.nextCalled, false, 'a preflight must not continue into the app');
    assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://localhost');
    assert.equal(result.headers['Vary'], 'Origin', 'the answer depends on the origin — caches must know');
    assert.match(result.headers['Access-Control-Allow-Methods'], /GET/);
    assert.match(result.headers['Access-Control-Allow-Headers'], /authorization/, 'the bearer header must be allowed, or every call fails');
  });

  it('a plain request from the app origin is allowed and still reaches the routes', () => {
    const result = run('https://localhost');
    assert.equal(result.headers['Access-Control-Allow-Origin'], 'https://localhost');
    assert.equal(result.nextCalled, true, 'the request must still be served');
  });

  it('same-origin traffic is untouched, and a foreign origin gets nothing', () => {
    const sameOrigin = run(undefined);
    assert.equal(sameOrigin.nextCalled, true);
    assert.deepEqual(sameOrigin.headers, {}, 'no Origin header => no CORS headers, exactly as before');

    const foreign = run('https://evil.example');
    assert.equal(foreign.nextCalled, true, 'the request is processed; the browser is what blocks the read');
    assert.equal('Access-Control-Allow-Origin' in foreign.headers, false, 'a foreign origin must never be granted');

    const foreignPreflight = run('https://evil.example', 'OPTIONS', { 'access-control-request-method': 'GET' });
    assert.equal(foreignPreflight.status, 403, 'a preflight from a foreign origin is refused outright');
    assert.equal('Access-Control-Allow-Origin' in foreignPreflight.headers, false);
  });
});

/**
 * The last mile: the SAME middleware stack the server and the Vercel function
 * run (`applyProductionHttpSecurity`), asked the exact questions a WebView asks
 * before it will send a request with an Authorization header. A unit test on the
 * middleware would still pass if the middleware were never mounted, or mounted
 * after the routes — this one would not.
 */
describe('CORS end to end through the real middleware stack', () => {
  const buildApp = () => {
    const app = express();
    // Same call, same options as server.ts / api/index.ts.
    applyProductionHttpSecurity(app, { production: true });
    app.get('/api/db-status', (_req, res) => res.json({ connected: true }));
    app.post('/api/leads', (_req, res) => res.status(201).json({ ok: true }));
    return app;
  };

  it('a preflight from the app reaches the real stack and is answered with CORS', async () => {
    const response = await request(buildApp())
      .options('/api/db-status')
      .set('Origin', 'https://localhost')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'https://localhost');
    assert.match(response.headers['access-control-allow-headers'], /authorization/);
    assert.match(response.headers['access-control-allow-methods'], /POST/);
  });

  it('a real API call from the app is served and carries the allow-origin header', async () => {
    const response = await request(buildApp()).get('/api/db-status').set('Origin', 'https://localhost');
    assert.equal(response.status, 200);
    assert.equal(response.body.connected, true, 'the request must still be handled normally');
    assert.equal(response.headers['access-control-allow-origin'], 'https://localhost');
  });

  it('the web deployment stays exactly as it was (no Origin => no CORS headers)', async () => {
    const response = await request(buildApp()).get('/api/db-status');
    assert.equal(response.status, 200);
    assert.equal('access-control-allow-origin' in response.headers, false);
  });
});
