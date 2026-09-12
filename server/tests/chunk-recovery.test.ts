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
 * Three halves, mirroring the repo's test style:
 *   1. Behavior — `isChunkLoadError` signature matching (every browser
 *      dialect in, generic network/API failures out) and the guarded
 *      single-reload cooldown (loop prevention, force bypass,
 *      sessionStorage persistence across the reload).
 *   2. Boundary behavior — the route error boundary is RENDERED (real
 *      React, renderToStaticMarkup like auth-flow-integration): a
 *      stale chunk error triggers exactly one guarded recovery; a
 *      second one cannot loop; a GENERIC render error must never
 *      auto-recover and gets the safe generic fallback instead (with
 *      no raw error text/stack exposure); normal children render
 *      unchanged.
 *   3. Source guards — the wiring must exist exactly where it was
 *      promised: LazyPage wraps Suspense in ChunkErrorBoundary, main.tsx
 *      installs the window-level net, the boundary distinguishes all
 *      three phases and renders only fixed strings, the bilingual
 *      strings exist, and vercel.json still 404s missing /assets
 *      instead of serving index.html as a JS module.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import {
  isChunkLoadError,
  shouldAttemptRecovery,
  recoverFromChunkError,
  _resetChunkRecoveryForTests,
} from '../../src/utils/chunkRecovery.js';
import ChunkErrorBoundary from '../../src/modules/shared/components/ChunkErrorBoundary';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

/** Minimal window shim: sessionStorage map + counted location.reload(). */
function ensureWindowShim(pathname = '/leads') {
  const store = new Map<string, string>();
  let reloads = 0;
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    location: {
      pathname,
      reload: () => void (reloads += 1),
    },
  };
  return { store, getReloads: () => reloads };
}

/** A healthy child used to prove unchanged rendering. */
function HealthyChild(): React.ReactElement {
  return React.createElement('div', null, 'LEADFLOWS-OK-CHILD');
}

/**
 * Drive the boundary's real lifecycle the way React does during a
 * client render: `getDerivedStateFromError` classifies, then the
 * instance's `render()` produces the replacement tree (rendered here
 * with renderToStaticMarkup inside the Router context the fallbacks
 * use). renderToStaticMarkup itself never dispatches to boundaries —
 * dispatching is React's client job, so the test drives the contract
 * methods directly and asserts their observable side effects.
 */
function boundaryAfterError(error: unknown): ChunkErrorBoundary {
  const boundary = new ChunkErrorBoundary({ children: null });
  boundary.state = ChunkErrorBoundary.getDerivedStateFromError(error) as any;
  return boundary;
}

function renderBoundaryTree(boundary: ChunkErrorBoundary, pathname = '/leads'): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      React.createElement(React.Fragment, null, boundary.render()),
    ),
  );
}

const CHUNK_ERROR = () =>
  new TypeError(
    'Failed to fetch dynamically imported module: https://app.test/assets/Dashboard-abc123.js',
  );

/* ==================================================================== */
/* 1. isChunkLoadError signatures                                       */
/* ==================================================================== */

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

/* ==================================================================== */
/* 2. Guarded single reload (utility behavior)                          */
/* ==================================================================== */

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
/* 3. Boundary behavior — RENDERED through real React                   */
/* ==================================================================== */

describe('Chunk recovery — ChunkErrorBoundary behavior', () => {
  let shim: ReturnType<typeof ensureWindowShim>;

  beforeEach(() => {
    shim = ensureWindowShim();
    _resetChunkRecoveryForTests();
  });

  it('G. a normal child renders unchanged — no fallback, no recovery side effects', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/leads'] },
        React.createElement(ChunkErrorBoundary, null, React.createElement(HealthyChild)),
      ),
    );
    assert.ok(markup.includes('LEADFLOWS-OK-CHILD'), 'child content must render as-is');
    assert.ok(!markup.includes('Something went wrong'), 'generic fallback must not appear');
    assert.ok(!markup.includes('New version available'), 'chunk notice must not appear');
    assert.equal(shim.getReloads(), 0, 'no reload for healthy children');
    assert.equal(shim.store.has('lf:chunk-recovery'), false, 'no recovery marker written');
  });

  it('H. a NON-chunk render error never auto-recovers and renders the generic fallback', () => {
    const thrown = new Error('SECRET-STACK_TOKEN=abc123 at UserController.java:42');

    // React's dispatch: classify via getDerivedStateFromError, then hand
    // the error to componentDidCatch.
    const boundary = boundaryAfterError(thrown);
    boundary.componentDidCatch(thrown);

    assert.equal(shim.getReloads(), 0, 'generic render errors must NOT trigger recoverFromChunkError()');
    assert.equal(shim.store.has('lf:chunk-recovery'), false, 'no recovery marker for generic errors');
    assert.equal(shouldAttemptRecovery(5_000_000), true, 'auto recovery must remain armed after a generic error');

    const markup = renderBoundaryTree(boundary);
    assert.ok(markup.includes('Something went wrong'), 'generic fallback must render');
    assert.ok(markup.includes('Reload Application'), 'fallback must offer Reload Application');
    assert.ok(markup.includes('Go to Dashboard'), 'fallback must offer Go to Dashboard off the dashboard route');
    assert.ok(!markup.includes('New version available'), 'chunk notice must not appear for generic errors');
  });

  it('I. the generic fallback exposes no raw error message/stack/tokens', () => {
    const leak = 'SECRET-STACK_TOKEN=abc123 UserController.java:42';
    const markup = renderBoundaryTree(boundaryAfterError(new Error(leak)));
    assert.ok(!markup.includes('SECRET-STACK'), 'the exception text must never reach the DOM');
    assert.ok(!markup.includes('UserController'), 'stack frame text must never reach the DOM');
    assert.ok(!markup.includes('Error:'), 'no raw error prefix in the fallback');
    // And the boundary source can only render fixed strings — no error
    // interpolation, no console logging of the caught error.
    const boundary = read('src/modules/shared/components/ChunkErrorBoundary.tsx');
    for (const forbidden of ['error.message', 'error.stack', 'console.error', 'console.log', '{error}']) {
      assert.ok(!boundary.includes(forbidden), `boundary must not contain ${forbidden}`);
    }
  });

  it('J. a chunk error triggers exactly ONE guarded recovery and shows the notice', () => {
    const thrown = CHUNK_ERROR();
    const boundary = boundaryAfterError(thrown);
    boundary.componentDidCatch(thrown);

    assert.equal(shim.getReloads(), 1, 'exactly one automatic reload for the first chunk error');
    assert.equal(shim.store.has('lf:chunk-recovery'), true, 'the cooldown marker is recorded');

    const markup = renderBoundaryTree(boundary);
    assert.ok(markup.includes('New version available'), 'recovery notice renders (for the instant before reload lands)');
    assert.ok(markup.includes('Reload now'), 'the manual Reload now action is present');
    assert.ok(!markup.includes('Something went wrong'), 'generic fallback must not appear for chunk errors');
  });

  it('K. a second chunk failure cannot loop — notice renders, no further auto reload', () => {
    const first = boundaryAfterError(CHUNK_ERROR());
    first.componentDidCatch(CHUNK_ERROR());
    assert.equal(shim.getReloads(), 1);

    // Fresh boundary instance = the tab recovered into a document that
    // fails again. The guard (sessionStorage marker) must stand down.
    const second = boundaryAfterError(CHUNK_ERROR());
    second.componentDidCatch(CHUNK_ERROR());
    assert.equal(shim.getReloads(), 1, 'NO second automatic reload — the loop is impossible');

    const markup = renderBoundaryTree(second);
    assert.ok(markup.includes('New version available'), 'the explicit recovery UI still shows');
    assert.ok(markup.includes('Reload now'), 'the user-controlled action remains available');
  });

  it('K2. one boundary instance never auto-recovers twice, even if React re-reports', () => {
    const boundary = boundaryAfterError(CHUNK_ERROR());
    boundary.componentDidCatch(CHUNK_ERROR());
    boundary.componentDidCatch(CHUNK_ERROR());
    assert.equal(shim.getReloads(), 1, 'the instance-level once-guard holds');
  });

  it('L. on the dashboard route the generic fallback hides the (useless) dashboard action', () => {
    // Simulate the browser being ON the dashboard (the fallback reads the
    // real document URL, which BrowserRouter mirrors).
    shim = ensureWindowShim('/');
    const markup = renderBoundaryTree(boundaryAfterError(new Error('boom')), '/');
    assert.ok(markup.includes('Something went wrong'), 'generic fallback renders on the dashboard too');
    assert.ok(!markup.includes('Go to Dashboard'), 'navigating to the dashboard is not practical when already there');
    assert.ok(markup.includes('Reload Application'), 'Reload Application is always offered');
  });
});

/* ==================================================================== */
/* 4. Wiring source guards                                              */
/* ==================================================================== */

describe('Chunk recovery — wiring source guards', () => {
  it('M. LazyPage wraps its Suspense boundary in ChunkErrorBoundary (shell stays up)', () => {
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

  it('N. the route-splitting contract of Phase 2 is untouched', () => {
    const app = read('src/App.tsx');
    assert.match(app, /const\s+Dashboard\s*=\s*lazy\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]\.\/modules\/dashboard\/pages\/Dashboard['"]\s*\)/,
      'lazy route declarations keep their exact shape (loader unwrapped)');
    assert.equal(app.split('lazy((').length - 1 >= 18, true, 'all feature pages remain lazy');
  });

  it('O. main.tsx installs the global safety net after the authenticated fetch', () => {
    const main = read('src/main.tsx');
    const fetchInstall = main.indexOf('installAuthenticatedFetch()');
    const chunkInstall = main.indexOf('installGlobalChunkRecovery()');
    assert.ok(fetchInstall !== -1, 'authenticated fetch install must remain');
    assert.ok(chunkInstall !== -1, 'global chunk recovery must be installed at startup');
    assert.ok(fetchInstall < chunkInstall, 'chunk recovery installs after the fetch patch');
  });

  it('P. the boundary distinguishes both error categories explicitly', () => {
    const boundary = read('src/modules/shared/components/ChunkErrorBoundary.tsx');
    // Three explicit phases — a caught render error must ALWAYS produce a
    // replacement tree; nothing "passes through" to the root.
    assert.match(boundary, /type\s+BoundaryPhase\s*=\s*'normal'\s*\|\s*'staleChunk'\s*\|\s*'runtimeError'/);
    assert.match(
      boundary,
      /getDerivedStateFromError[\s\S]*?isChunkLoadError\(error\)\s*\?\s*'staleChunk'\s*:\s*'runtimeError'/,
      'getDerivedStateFromError must classify chunk vs generic errors',
    );
    // Automatic recovery is gated to chunk errors ONLY.
    const didCatch = boundary.slice(
      boundary.indexOf('componentDidCatch'),
      boundary.indexOf('handleManualReload(): void'),
    );
    assert.ok(didCatch.includes('!isChunkLoadError(error)'), 'componentDidCatch must bail out for non-chunk errors');
    assert.ok(didCatch.includes('recoverFromChunkError()'), 'chunk errors must attempt the guarded reload');
    // Manual actions keep their contract.
    assert.ok(boundary.includes('recoverFromChunkError({ force: true })'), 'manual reload must bypass the cooldown');
    assert.ok(boundary.includes("window.location.reload()"), 'generic fallback reloads directly (never via the chunk guard)');
    // Both alerts are announced regions.
    assert.equal(boundary.split('role="alert"').length >= 3, true, 'both fallbacks must be role="alert" regions');
  });

  it('Q. the recovery utility carries every browser signature and the reload guard', () => {
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

  it('R. bilingual strings exist for both fallbacks (en + bn)', () => {
    const dict = read('src/modules/shared/utils/translations.ts');
    // Chunk recovery card
    assert.match(dict, /newVersionTitle:\s*"New version available"/, 'en title');
    assert.match(dict, /newVersionBody:\s*"LeadFlow was just updated/, 'en body');
    assert.match(dict, /reloadNow:\s*"Reload now"/, 'en action');
    assert.match(dict, /newVersionTitle:\s*"নতুন ভার্সন এসেছে"/, 'bn title');
    assert.match(dict, /newVersionBody:\s*"LeadFlow সবে আপডেট হয়েছে/, 'bn body');
    assert.match(dict, /reloadNow:\s*"এখনই রিফ্রেশ করুন"/, 'bn action');
    // Generic runtime fallback
    assert.match(dict, /somethingWentWrongTitle:\s*"Something went wrong"/, 'en generic title');
    assert.match(dict, /reloadApplication:\s*"Reload Application"/, 'en generic primary action');
    assert.match(dict, /goDashboard:\s*"Go to Dashboard"/, 'en generic secondary action');
    assert.match(dict, /somethingWentWrongTitle:\s*"কিছু একটা ভুল হয়েছে"/, 'bn generic title');
    assert.match(dict, /reloadApplication:\s*"অ্যাপ্লিকেশন রিফ্রেশ করুন"/, 'bn generic primary action');
    assert.match(dict, /goDashboard:\s*"ড্যাশবোর্ডে ফিরে যান"/, 'bn generic secondary action');
  });

  it('S. vercel.json still serves /assets/* as files (404 when missing), never as index.html', () => {
    const cfg = JSON.parse(read('vercel.json')) as { routes: Array<{ src?: string; dest?: string }> };
    const assetRoute = cfg.routes.find((r) => r.src === '/assets/(.*)');
    assert.ok(assetRoute, 'the /assets route must exist');
    assert.equal(assetRoute.dest, '/assets/$1', 'missing assets must 404 — an HTML fallback here would turn stale chunks into MIME errors');
  });

  it('T. the docs describe the final contract (no stale pass-through claims)', () => {
    const doc = read('docs/DEPLOYMENT_CHUNK_RECOVERY.md');
    assert.ok(!doc.includes('passes them through'), 'the old pass-through claim must be gone');
    assert.ok(!doc.includes('Surfaces at root'), 'the old surface-at-root claim must be gone');
    assert.match(doc, /safe generic fallback/i, 'docs must describe the generic fallback');
    assert.match(doc, /GenericErrorFallback/, 'docs must reference the generic fallback component');
    assert.match(doc, /never auto-reload/i, 'docs must state that generic errors never auto-reload');
  });
});
