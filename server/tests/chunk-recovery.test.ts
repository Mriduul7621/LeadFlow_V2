/**
 * chunk-recovery.test.ts
 * ------------------------------------------------------------------
 * Graceful recovery from stale dynamic chunks after a deployment.
 *
 * After every deployment the old hashed route chunks are gone. A user
 * whose tab still runs the previous session requests a chunk URL that
 * no longer exists → the dynamic import rejects → before this change
 * nothing handled it and React unmounted the whole app (white screen
 * until a manual refresh).
 *
 * Two halves, mirroring the repo's test style:
 *   1. Behavior — `isChunkLoadError` signature matching (every browser
 *      dialect in, generic network/API failures out) and the guarded
 *      single-reload cooldown (loop prevention, force bypass, sessionStorage
 *      persistence across the reload).
 *   2. Source guards — the wiring must exist exactly where it was
 *      promised: LazyPage wraps Suspense in ChunkErrorBoundary, main.tsx
 *      installs the window-level net, the boundary only handles chunk
 *      errors and reloads manually with force, the bilingual strings
 *      exist, and vercel.json still 404s missing /assets instead of
 *      serving index.html as a JS module.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  isChunkLoadError,
  shouldAttemptRecovery,
  recoverFromChunkError,
  _resetChunkRecoveryForTests,
} from '../../src/utils/chunkRecovery.js';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Minimal window shim: sessionStorage map + counted location.reload(). */
function ensureWindowShim() {
  const store = new Map<string, string>();
  let reloads = 0;
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    location: {
      reload: () => void (reloads += 1),
    },
  };
  return { store, getReloads: () => reloads };
}

describe('Chunk recovery — isChunkLoadError signatures', () => {
  it('A. matches every known stale-dynamic-import dialect', () => {
    const stale = (msg: string) => new TypeError(msg);
    const positives: Array<[string, unknown]> = [
      ['Chromium', stale('Failed to fetch dynamically imported module: https://app.test/assets/Dashboard-abc123.js')],
      ['Firefox', stale('error loading dynamically imported module: https://app.test/assets/AllLeads-def456.js')],
      ['Safari', stale('Importing a module script failed.')],
      ['webpack JS chunk', stale('Loading chunk 5 failed.\n(error: https://app.test/5.abc.js)')],
      ['webpack CSS chunk', stale('Loading CSS chunk 7 failed.')],
      ['ChunkLoadError name', Object.assign(new Error('whatever'), { name: 'ChunkLoadError' })],
      ['Vite preload helper', stale('Unable to preload CSS for /assets/index-abc123.css')],
      ['HTML fallback (Chromium)', stale('Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".')],
      ['HTML fallback (Firefox)', stale('Loading module from “https://app.test/assets/x.js” was blocked because of a disallowed MIME type (“text/html”).')],
      // Wrapper shapes: PromiseRejectionEvent-like payloads unwrap to reason.
      ['wrapped rejection reason', { reason: stale('Failed to fetch dynamically imported module: https://app.test/assets/x.js') }],
      ['plain string payload', 'Importing a module script failed.'],
    ];
    for (const [label, payload] of positives) {
      assert.ok(isChunkLoadError(payload), `${label} must be recognized as a chunk load error`);
    }
  });

  it('B. never matches ordinary network/API/runtime failures', () => {
    const negatives: Array<[string, unknown]> = [
      ['bare fetch failure (generic network)', new TypeError('Failed to fetch')],
      ['API HTTP error', new Error('Request failed with status code 500')],
      ['API 404', new Error('Request failed with status code 404')],
      ['offline fetch', new TypeError('NetworkError when attempting to fetch resource.')],
      ['abort', Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })],
      ['business error', new Error('LEAD-4042: lead already converted')],
      ['empty / null / undefined', ['', null, undefined]],
    ];
    for (const [label, payload] of negatives) {
      assert.ok(!isChunkLoadError(payload), `${label} must NOT be treated as a chunk load error`);
    }
  });
});

describe('Chunk recovery — guarded single reload', () => {
  let shim: ReturnType<typeof ensureWindowShim>;

  beforeEach(() => {
    shim = ensureWindowShim();
    _resetChunkRecoveryForTests();
  });

  it('C. auto-recovers exactly once, then stands down inside the cooldown window', () => {
    const t0 = 1_000_000;
    assert.equal(shouldAttemptRecovery(t0), true, 'fresh session: auto recovery allowed');
    assert.equal(recoverFromChunkError({ now: t0 }), true, 'first failure triggers the reload');
    assert.equal(shim.getReloads(), 1);

    // Second stale-chunk failure right after the reload (deployment still
    // broken, or offline): the guard must refuse — no tight reload loop.
    assert.equal(shouldAttemptRecovery(t0 + 5_000), false);
    assert.equal(recoverFromChunkError({ now: t0 + 5_000 }), false);
    assert.equal(shim.getReloads(), 1, 'no second automatic reload inside the window');
  });

  it('D. the cooldown is measured from the LAST attempt (incl. forced), then re-arms', () => {
    const t0 = 2_000_000;
    assert.equal(recoverFromChunkError({ now: t0 }), true);
    assert.equal(recoverFromChunkError({ now: t0 + 10_000, force: true }), true, 'manual reload always allowed');
    assert.equal(shim.getReloads(), 2);
    assert.equal(recoverFromChunkError({ now: t0 + 69_999 }), false, 'auto still guarded 60s after the forced reload');
    assert.equal(recoverFromChunkError({ now: t0 + 70_000 }), true, 'window elapsed: a NEW deployment may recover automatically again');
    assert.equal(shim.getReloads(), 3);
  });

  it('E. the marker survives the reload itself via sessionStorage (not just in-memory)', () => {
    // Simulate the post-reload document: fresh module state, but the same
    // tab's sessionStorage still carries the marker.
    _resetChunkRecoveryForTests();
    shim.store.set('lf:chunk-recovery', JSON.stringify({ at: 100_000 }));
    assert.equal(shouldAttemptRecovery(159_999), false, 'marker read back from storage blocks a second auto reload');
    assert.equal(shouldAttemptRecovery(160_000), true, 'storage marker expires with the same window');
  });

  it('F. unavailable sessionStorage degrades to the in-memory marker', () => {
    let reloads = 0;
    (globalThis as any).window = { location: { reload: () => void (reloads += 1) } };
    _resetChunkRecoveryForTests();
    const t0 = 3_000_000;
    assert.equal(recoverFromChunkError({ now: t0 }), true);
    assert.equal(reloads, 1);
    assert.equal(recoverFromChunkError({ now: t0 + 1_000 }), false, 'memory marker still guards without storage');
  });
});

/* ==================================================================== */
/* Source guards — the wiring exists where it was promised              */
/* ==================================================================== */

describe('Chunk recovery — wiring source guards', () => {
  it('G. LazyPage wraps its Suspense boundary in ChunkErrorBoundary (shell stays up)', () => {
    const app = read('src/App.tsx');
    assert.match(
      app,
      /import\s+ChunkErrorBoundary\s+from\s+['"]\.\/modules\/shared\/components\/ChunkErrorBoundary['"]/,
      'App.tsx must import the boundary',
    );
    const lazyPage = app.slice(app.indexOf('function LazyPage'));
    assert.ok(lazyPage, 'LazyPage must still exist');
    const boundary = lazyPage.indexOf('<ChunkErrorBoundary>');
    const suspense = lazyPage.indexOf('<Suspense fallback=');
    assert.ok(boundary !== -1 && suspense !== -1 && boundary < suspense,
      'the boundary must wrap the Suspense boundary so route chunk failures are caught');
  });

  it('H. the route-splitting contract of Phase 2 is untouched', () => {
    const app = read('src/App.tsx');
    assert.match(app, /const\s+Dashboard\s*=\s*lazy\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]\.\/modules\/dashboard\/pages\/Dashboard['"]\s*\)/,
      'lazy route declarations keep their exact shape (loader unwrapped)');
    assert.equal(app.split('lazy((').length - 1 >= 18, true, 'all feature pages remain lazy');
  });

  it('I. main.tsx installs the global safety net after the authenticated fetch', () => {
    const main = read('src/main.tsx');
    const fetchInstall = main.indexOf('installAuthenticatedFetch()');
    const chunkInstall = main.indexOf('installGlobalChunkRecovery()');
    assert.ok(fetchInstall !== -1, 'authenticated fetch install must remain');
    assert.ok(chunkInstall !== -1, 'global chunk recovery must be installed at startup');
    assert.ok(fetchInstall < chunkInstall, 'chunk recovery installs after the fetch patch');
  });

  it('J. the boundary handles chunk errors only and reloads manually with force', () => {
    const boundary = read('src/modules/shared/components/ChunkErrorBoundary.tsx');
    assert.ok(boundary.includes('getDerivedStateFromError'), 'must implement getDerivedStateFromError');
    assert.ok(
      /return\s+isChunkLoadError\(error\)\s*\?\s*\{\s*staleChunk:\s*true\s*\}\s*:\s*null/.test(boundary),
      'non-chunk errors must return null (not be swallowed here)',
    );
    assert.ok(boundary.includes('recoverFromChunkError({ force: true })'), 'manual reload must bypass the cooldown');
    assert.ok(boundary.includes('role="alert"'), 'recovery notice must be an assertive live region');
    assert.match(boundary, /import\s+\{\s*isChunkLoadError,\s*recoverFromChunkError\s*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/utils\/chunkRecovery['"]/);
  });

  it('K. the recovery utility carries every browser signature and the reload guard', () => {
    const util = read('src/utils/chunkRecovery.ts');
    for (const signature of [
      'failed to fetch dynamically imported module',
      'error loading dynamically imported module',
      'importing a module script failed',
      'chunkloaderror',
      'unable to preload',
      'expected a javascript module script',
      'disallowed mime type',
    ]) {
      assert.ok(util.includes(signature), `signature missing: ${signature}`);
    }
    assert.ok(util.includes('RECOVERY_COOLDOWN_MS'), 'cooldown constant must exist');
    assert.ok(util.includes('sessionStorage'), 'marker must persist per tab via sessionStorage');
    assert.ok(/typeof\s+window\s*===\s*['"]undefined['"]/.test(util), 'must be SSR/node-safe');
  });

  it('L. bilingual recovery strings exist (en + bn)', () => {
    const dict = read('src/modules/shared/utils/translations.ts');
    assert.match(dict, /newVersionTitle:\s*"New version available"/, 'en title');
    assert.match(dict, /newVersionBody:\s*"LeadFlow was just updated/, 'en body');
    assert.match(dict, /reloadNow:\s*"Reload now"/, 'en action');
    assert.match(dict, /newVersionTitle:\s*"নতুন ভার্সন এসেছে"/, 'bn title');
    assert.match(dict, /newVersionBody:\s*"LeadFlow সবে আপডেট হয়েছে/, 'bn body');
    assert.match(dict, /reloadNow:\s*"এখনই রিফ্রেশ করুন"/, 'bn action');
  });

  it('M. vercel.json still serves /assets/* as files (404 when missing), never as index.html', () => {
    const cfg = JSON.parse(read('vercel.json')) as { routes: Array<{ src?: string; dest?: string }> };
    const assetRoute = cfg.routes.find((r) => r.src === '/assets/(.*)');
    assert.ok(assetRoute, 'the /assets route must exist');
    assert.equal(assetRoute.dest, '/assets/$1', 'missing assets must 404 — an HTML fallback here would turn stale chunks into MIME errors');
  });
});
