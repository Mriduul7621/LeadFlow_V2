/**
 * android-capacitor-app.test.ts
 * ------------------------------------------------------------------
 * The Android app used to be a Trusted Web Activity: a shell that opened a
 * remote URL. It shipped broken — the URL had no DNS, a TWA has no fallback,
 * so the launcher showed the browser error page — and nothing in the test suite
 * could have noticed, because every piece was individually "correct".
 *
 * It then became a Capacitor build with the web bundle packaged INSIDE the
 * APK, signed with a debug keystore that was committed to this public repo —
 * compromised by publication. No release-signed build can ever update those
 * installs in place, so the release app is a NEW app id with a NEW key, and
 * the old app is uninstalled once (see docs/ANDROID_RELEASE.md §5).
 *
 * The app is now a Capacitor 8 remote-load shell: it loads the live
 * production LeadFlow in its WebView, signed with the release keystore from
 * day one. These guards keep the things that can silently break it from
 * breaking:
 *
 *   1. **the shell points at production and nothing else** — server.url is
 *      the live URL (never a preview), androidScheme stays 'https', and
 *      allowNavigation stays empty (wa.me must open externally);
 *   2. **the release signing is real** — signingConfigs.release reads only
 *      from the environment, the assembleRelease guard fails fast without
 *      the keystore, and the debug keystore is gone from the tree;
 *   3. **the version is owned by a checked-in file** — never
 *      github.run_number, so a recreated workflow can never silently
 *      produce a downgrade build;
 *   4. **the API accepts the WebView origin** — the CORS localhost
 *      allowance is kept for v1 (harmless while the debug pipeline still
 *      ships), and the same-origin fallback is what remote-load uses
 *      (server-side tests in this suite, plus the pure resolver tests
 *      for lib/apiBase.ts).
 *
 * DNS is deliberately NOT asserted: "does <host> resolve today" is a hosting
 * fact, not a code fact, and this suite must pass offline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';

import { normalizeApiBase, resolveApiBaseUrl, withApiBase } from '../../src/lib/apiBase';
import { applyProductionHttpSecurity, createApiCorsMiddleware, resolveAllowedCorsOrigins } from '../middleware.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

describe('Android app — Capacitor release shell (remote-load)', () => {
  const config = read('capacitor.config.ts');
  const workflow = read('.github/workflows/android.yml');
  const pkg = JSON.parse(read('package.json'));
  const docs = read('docs/ANDROID_APP.md');
  const releaseDocs = read('docs/ANDROID_RELEASE.md');
  const apiClient = read('src/lib/apiClient.ts');
  const viteConfig = read('vite.config.ts');
  const appBuildGradle = read('android/app/build.gradle');
  const versionProps = read('android/version.properties');
  const variablesGradle = read('android/variables.gradle');
  const rootGradle = read('android/build.gradle');
  const wrapperProps = read('android/gradle/wrapper/gradle-wrapper.properties');
  const gitignore = read('.gitignore');
  const androidGitignore = read('android/.gitignore');
  const errorPage = read('android-web/index.html');
  const backButton = read('src/native/backButton.ts');
  const mainTsx = read('src/main.tsx');

  it('the Capacitor config remote-loads production under the new identity', () => {
    assert.match(config, /appId:\s*'com\.shantalife\.leadflow'/, 'the NEW app id — the old debug app id is retired (its signer was committed to this public repo)');
    assert.match(config, /appName:\s*'Shanta Life LeadFlow'/);
    assert.match(config, /webDir:\s*'android-web'/, 'webDir holds only the local error page, never the app');
    assert.equal(/webDir:\s*'dist'/.test(config), false, 'no bundled dist/ in the APK — the shell remote-loads');
    assert.match(config, /url:\s*'https:\/\/lead-flow-jet\.vercel\.app'/, 'server.url MUST be the production URL, never a preview');
    assert.match(config, /androidScheme:\s*'https'/, 'BLOCKING: the WebView must be a secure context (service worker + clipboard)');
    assert.equal(/allowNavigation\s*:/.test(config), false, 'allowNavigation stays empty — single-origin app; wa.me must open externally, never in the WebView');
    assert.match(config, /errorPath:\s*'index\.html'/, 'the no-connection page is wired');
    assert.match(config, /backgroundColor:\s*'#F7F7F2'/, 'the shell background matches the app background token');
    assert.match(config, /allowMixedContent:\s*false/);
  });

  it('capacitor 8 is a real dependency, with the back-button plugin and the icon renderer', () => {
    assert.match(pkg.dependencies['@capacitor/core'], /^\^?8\./, '@capacitor/core must be the 8.x line');
    assert.match(pkg.dependencies['@capacitor/android'], /^\^?8\./, '@capacitor/android must be the 8.x line');
    assert.match(pkg.devDependencies['@capacitor/cli'], /^\^?8\./, '@capacitor/cli must be the 8.x line');
    assert.ok(pkg.dependencies['@capacitor/app'], '@capacitor/app must be a dependency (back button)');
    assert.ok(pkg.devDependencies['@resvg/resvg-js'], '@resvg/resvg-js must be a devDependency (launcher icons render in CI)');
    assert.ok(pkg.scripts['android:assets'], 'npm run android:assets must exist (CI runs it before every build)');
    assert.ok(pkg.scripts['build:web'], 'the web-only build must still exist');
    assert.equal(pkg.scripts['build:web'].includes('esbuild'), false, 'build:web must not build the server bundle');
  });

  it('the workflow is dispatch-only and holds no JWT material', () => {
    // The trigger block is the lines between `on:` and the next top-level
    // key — read it, don't grep the whole file (the header comments
    // mention pushes and JWT in prose).
    const onBlock = workflow.split(/^permissions:/m)[0].split(/^on:/m)[1];
    assert.match(onBlock, /workflow_dispatch/, 'manual dispatch ONLY — no APK is ever produced by accident');
    assert.equal(/push:/.test(onBlock), false, 'no push trigger');
    assert.equal(/pull_request/.test(onBlock), false, 'no PR trigger');
    assert.equal(/VITE_API_BASE_URL/.test(workflow), false, 'no API-origin bake-in — remote-load is same-origin');
    assert.equal(workflow.includes('npm run build:web'), false, 'no web build in the APK pipeline');
    assert.equal(workflow.includes('npm run build '), false, 'no web build in the APK pipeline');
    // Every secrets reference must be a LEADFLOW_KEYSTORE_* signing secret.
    const secretRefs = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(secretRefs.length > 0, 'the workflow reads signing secrets');
    for (const ref of secretRefs) {
      assert.ok(ref.startsWith('LEADFLOW_'), `only LEADFLOW_* secrets may appear (found ${ref})`);
    }
    assert.ok(workflow.includes("node-version: '22'"), 'CI pins Node 22 (not the local VM\'s Node 24)');
    assert.ok(workflow.includes("java-version: '21'"), 'JDK 21');
    assert.ok(workflow.includes('gradle-version: 8.14.3'), 'Gradle 8.14.3 via setup-gradle (no wrapper jar)');
    assert.ok(workflow.includes('platforms;android-36'), 'Android SDK 36');
    assert.ok(workflow.includes('npm run android:assets'), 'icons regenerate from the SVG before the build');
    assert.ok(workflow.includes('npx cap sync android'), 'the shell syncs before Gradle');
    assert.equal(workflow.includes('npx cap add android'), false, 'the android/ tree is committed — CI never regenerates it');
    assert.equal(/DEFAULT_HOST|appHost|android:host/.test(workflow), false, 'no leftover TWA host wiring');
    assert.equal(/bubblewrap/.test(workflow), false, 'the TWA toolchain must be gone');
  });

  it('the workflow signs from the release keystore and verifies the signer', () => {
    assert.ok(workflow.includes('LEADFLOW_KEYSTORE_B64'), 'the keystore is restored from the base64 secret');
    assert.ok(workflow.includes('LEADFLOW_KEYSTORE_PASSWORD'));
    assert.ok(workflow.includes('LEADFLOW_KEY_ALIAS'));
    assert.ok(workflow.includes('LEADFLOW_KEY_PASSWORD'));
    assert.ok(workflow.includes('keytool -list -keystore'), 'fail fast if the keystore is corrupt or the alias/password is wrong');
    assert.ok(workflow.includes('gradle -p android :app:assembleRelease'), 'the release build runs via setup-gradle (no ./gradlew)');
    assert.ok(workflow.includes('apksigner') && workflow.includes('verify'), 'the APK signature must verify');
    // Fingerprint normalisation — the Agent Hub run #1 lesson: apksigner
    // prints SHA-256 lowercase WITHOUT colons, keytool uppercase WITH
    // colons; a plain string compare fails on the same fingerprint.
    assert.ok(workflow.includes("tr -d ':'"), 'the fingerprint compare must strip colons');
    assert.ok(workflow.includes("tr '[:lower:]' '[:upper:]'"), '...and normalise case');
    assert.equal(/debug\.keystore/.test(workflow), false, 'the debug keystore must never appear in the release pipeline');
    assert.equal(/github\.run_number/.test(workflow), false, 'the version never comes from run_number');
    assert.ok(workflow.includes('android/version.properties'), 'the version is read from the checked-in file');
    assert.ok(workflow.includes('aapt2') && workflow.includes('dump badging'), 'the APK version is read back, not trusted');
    assert.ok(workflow.includes('retention-days: 90'), 'artifact retention is 90 days');
  });

  it('the workflow publishes the friendly-named APK to `latest` (exactly one)', () => {
    assert.ok(workflow.includes('gh release upload latest'), 'each dispatch publishes to the rolling latest release');
    assert.ok(
      workflow.includes('LeadFlow-V-$VERSION.$CODE.apk'),
      'the published file carries the app name + version (LeadFlow-V-<versionName>.<versionCode>.apk)',
    );
    assert.ok(workflow.includes('gh release create latest'), 'a missing latest release is created first');
    assert.ok(workflow.includes('--clobber'), 'a re-run replaces the files instead of failing');
    assert.ok(workflow.includes('contents: write'), 'the publish job needs write permission');
    // The asset name changes with every version, so --clobber alone
    // would leave stale names piling up in `latest` — the previous
    // version's assets must be deleted before the new one uploads.
    assert.ok(workflow.includes('gh release delete-asset'), 'the previous version\u2019s assets are deleted first');
    assert.ok(
      workflow.includes('endswith(".apk") or endswith(".apk.sha256")'),
      'the cleanup deletes both the old APK and its .sha256 sidecar',
    );
    assert.ok(
      workflow.indexOf('gh release delete-asset') < workflow.indexOf('gh release upload latest'),
      'cleanup happens BEFORE the upload',
    );
  });

  it('assetlinks names the new package with no fingerprint recorded yet', () => {
    // The old file named the old package + the debug fingerprint. The new
    // app declares no App Links (no deep links by design) and the branded
    // domain has no DNS, so the file is inert today — but it must not
    // carry the dead identity or a fingerprint nobody verified.
    const links = JSON.parse(read('public/.well-known/assetlinks.json'));
    const target = links[0].target;
    assert.equal(target.package_name, 'com.shantalife.leadflow', 'the assetlinks package must be the new app id');
    assert.deepEqual(
      target.sha256_cert_fingerprints,
      [],
      'no fingerprint recorded yet — the release fingerprint goes in after the first release build (never the old debug fingerprint, never invented)',
    );
    assert.equal(
      read('public/.well-known/assetlinks.json').includes('85:9B:81:1A'),
      false,
      'the old debug fingerprint must be gone',
    );
  });

  it('the debug signing system is gone from the tree', () => {
    assert.equal(
      existsSync(`${repoRoot}branding/android/debug.keystore`),
      false,
      'the committed debug keystore is removed from the tree (it stays in git history — compromised forever — which is why the release key is new, not rotated)',
    );
    const brandingFiles = readdirSync(`${repoRoot}branding/android`);
    assert.equal(
      brandingFiles.some((f) => f.endsWith('.keystore') || f.endsWith('.jks')),
      false,
      'no keystore file may remain under branding/android',
    );
    assert.ok(gitignore.includes('*.keystore'), '.gitignore must block keystores repo-wide');
    assert.ok(gitignore.includes('*.jks'));
    assert.ok(gitignore.includes('*.apk'), '.gitignore must block installers repo-wide');
    assert.ok(gitignore.includes('*.aab'));
    assert.ok(gitignore.includes('google-services.json'));
    assert.ok(androidGitignore.includes('*.keystore'), 'android/.gitignore must block keystores too (the template ships them commented out)');
    assert.ok(androidGitignore.includes('gradle-wrapper.jar'), 'the wrapper jar is never committed');
    assert.ok(
      androidGitignore.includes('app/src/main/res/mipmap-*/ic_launcher*.png'),
      'generated launcher PNGs are never committed',
    );
    assert.equal(gitignore.includes('/android/'), false, 'the android/ tree IS committed now — the exclusion must be gone');
  });

  it('the committed Android tree signs releases from the environment only', () => {
    assert.match(appBuildGradle, /applicationId "com\.shantalife\.leadflow"/);
    assert.match(appBuildGradle, /namespace = "com\.shantalife\.leadflow"/);
    assert.match(appBuildGradle, /signingConfigs \{\s*\n\s*release \{/, 'a release signing config must exist');
    assert.ok(appBuildGradle.includes("System.getenv('LEADFLOW_KEYSTORE_PATH')"), 'the keystore path comes from the environment');
    assert.ok(appBuildGradle.includes("System.getenv('LEADFLOW_KEYSTORE_PASSWORD')"));
    assert.ok(appBuildGradle.includes("System.getenv('LEADFLOW_KEY_ALIAS')"));
    assert.ok(appBuildGradle.includes("System.getenv('LEADFLOW_KEY_PASSWORD')"));
    assert.equal(/storePassword '[^']*'/.test(appBuildGradle), false, 'no literal password in Gradle');
    assert.equal(/keyPassword '[^']*'/.test(appBuildGradle), false, 'no literal password in Gradle');
    assert.ok(appBuildGradle.includes('signingConfig signingConfigs.release'), 'the release build type is wired to the release signing config');
    assert.ok(appBuildGradle.includes('gradle.taskGraph.whenReady'), 'the assembleRelease guard exists');
    assert.ok(appBuildGradle.includes('assembleRelease needs LEADFLOW_KEYSTORE_PATH'), 'the guard fails fast with a clear message');
    assert.equal(/debug\.keystore/.test(appBuildGradle), false, 'the debug keystore must never appear in the release build');
    assert.ok(appBuildGradle.includes('version.properties'), 'the version comes from the checked-in file');
  });

  it('the version is owned by the checked-in file, first release 1 / 1.0.0', () => {
    assert.match(versionProps, /^versionCode=1$/m, 'the first release is versionCode 1');
    assert.match(versionProps, /^versionName=1\.0\.0$/m, 'the first release is versionName 1.0.0');
    const assignments = versionProps
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(
      assignments,
      ['versionCode=1', 'versionName=1.0.0'],
      'the version comes from the checked-in file alone — never from a CI counter (run_number)',
    );
  });

  it('the platform targets the Capacitor 8 toolchain', () => {
    assert.match(variablesGradle, /minSdkVersion = 24/, 'Capacitor 8 requires minSdk 24 (Android 7.0)');
    assert.match(variablesGradle, /compileSdkVersion = 36/);
    assert.match(variablesGradle, /targetSdkVersion = 36/);
    assert.match(rootGradle, /com\.android\.tools\.build:gradle:8\.13\.0/, 'AGP 8.13.0');
    assert.match(wrapperProps, /gradle-8\.14\.3/, 'Gradle 8.14.3');
    assert.equal(existsSync(`${repoRoot}android/gradle/wrapper/gradle-wrapper.jar`), false, 'the wrapper jar is a binary — never in the tree');
  });

  it('the API client applies the base in ONE place (every call site inherits it)', () => {
    assert.ok(apiClient.includes("from './apiBase'"), 'apiClient must use the shared resolver');
    assert.ok(apiClient.includes('withApiBase(url, apiBase)'), 'the fetch patch must rewrite API paths');
    assert.ok(apiClient.includes('new Request(target, input as RequestInit)'), 'a Request instance must be remapped, not dropped');
    // and the resolver must be driven by the build-time value, not a literal
    assert.ok(viteConfig.includes("'import.meta.env.VITE_API_BASE_URL'"), 'vite must inject the API base (same pattern as the other public vars)');
  });

  it('the error page and back button are wired', () => {
    assert.ok(errorPage.includes('No connection'), 'the error page names the problem');
    assert.ok(errorPage.includes('ইন্টারনেট সংযোগ নেই'), 'Bangla copy on the error page');
    assert.ok(errorPage.includes('id="retry"'), 'Retry button');
    assert.ok(errorPage.includes('addEventListener("online"'), 'auto-recover on connectivity return');
    assert.ok(errorPage.includes('https://lead-flow-jet.vercel.app'), 'Retry navigates to the live URL');
    assert.ok(backButton.includes("App.addListener('backButton'"), 'the back-button listener exists');
    assert.ok(backButton.includes("import('@capacitor/app')"), 'the plugin import is dynamic — the web bundle pays nothing');
    assert.ok(backButton.includes('Capacitor.isNativePlatform()'), 'inert outside the app');
    assert.ok(backButton.includes('App.exitApp()'), 'exits only at the root');
    assert.ok(mainTsx.includes('initAndroidBackButton'), 'main.tsx installs the back-button listener');
    assert.ok(mainTsx.includes("from './native/backButton'"));
  });

  it('the launcher label stays LeadFlow and the icon background is olive', () => {
    assert.ok(
      read('android/app/src/main/res/values/strings.xml').includes('<string name="app_name">LeadFlow</string>'),
      'the launcher label is the short name',
    );
    assert.ok(
      read('android/app/src/main/res/values/ic_launcher_background.xml').includes('#978C21'),
      'the adaptive icon background is the brand olive',
    );
    const styles = read('android/app/src/main/res/values/styles.xml');
    assert.ok(styles.includes('windowSplashScreenAnimatedIcon'), 'the launch theme uses the SplashScreen API (no binary splash PNGs)');
    assert.equal(
      styles.includes('<item name="android:background">@drawable/splash</item>'),
      false,
      'the template splash drawable must not be the launch background',
    );
    assert.ok(styles.includes('windowSplashScreenBackground'), 'the splash background is set');
  });

  it('the icon script regenerates from the brand master', () => {
    const script = read('scripts/android-assets.mjs');
    assert.ok(script.includes('public/icon.svg'), 'the PR #172 brand master is the icon source');
    assert.ok(script.includes('@resvg/resvg-js'), 'resvg renders the PNGs');
    assert.ok(script.includes('ic_launcher_foreground.png'), 'the adaptive foreground is generated');
    assert.ok(script.includes('ic_launcher_round.png'), 'the round icon is generated');
    assert.equal(script.includes('branding/android/res'), false, 'the TWA-era binaries are superseded — never reused');
  });

  it('the documentation describes the remote-load release app', () => {
    assert.ok(docs.includes('remote-load') || docs.includes('live production LeadFlow'), 'the doc must say the app remote-loads');
    assert.ok(docs.includes('com.shantalife.leadflow'), 'the doc must name the new app id');
    assert.ok(docs.includes('version.properties'), 'the doc must name the version source');
    assert.ok(docs.includes('/api/download-apk'), 'the doc must name the download route (the permanent link)');
    assert.ok(docs.includes('LeadFlow-V-'), 'the doc must name the friendly downloaded filename');
    assert.ok(releaseDocs.includes('LEADFLOW_KEYSTORE_B64'), 'the release guide must name the signing secrets');
    assert.ok(releaseDocs.includes('uninstall'), 'the release guide must carry the one-time uninstall migration');
    assert.ok(releaseDocs.includes('only works AFTER the first'), 'the release guide must carry the first-run sequencing caveat');
    assert.ok(read('docs/ANDROID_TWA.md').includes('HISTORY'), 'the TWA doc must be marked as history');
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
    assert.equal(withApiBase('/assets/logo.png', base), '/assets/logo.png', 'non-API paths stay same-origin (they are served by the app origin)');
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
