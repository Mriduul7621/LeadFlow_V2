/**
 * app-icon-set.test.ts
 * ------------------------------------------------------------------
 * Brand app icon set (2026-11-20, Mahadi): the LeadFlow funnel icon
 * (olive tile, cream funnel + flow line, orange drop) wired as the
 * app's favicon, install icons and push-notification icon.
 *
 * Source guards only — the wiring is static files, so the pins are:
 *   - index.html carries the theme colour, the manifest link and the
 *     SVG-first favicon set, and no longer references the old root
 *     favicon files;
 *   - site.webmanifest is valid JSON, keeps LeadFlow's own identity
 *     fields, and lists exactly the new icon set;
 *   - public/icon.svg is byte-identical to the handed-off master
 *     (SHA-256 from ~/workspace/leadflow-branding/README.md);
 *   - the push service worker shows the new icon on notifications.
 *
 * Deliberately NOT asserted: the six PNGs under public/icons/ —
 * they are binary, the connector cannot push them, and Mahadi
 * uploads them by hand after this PR lands. The SVG favicon works
 * from this PR alone; the PNG install icons appear after his upload.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** SHA-256 of the handed-off SVG master (leadflow-branding/README.md). */
const ICON_SVG_SHA256 = '27773cd52b95a3bf8dae9ed9e7e0f6f0000499d6ca08fade103dc5dbcb5c74a3';

describe('app icon set — index.html wiring', () => {
  it('links the manifest, theme colour and the SVG-first favicon set', () => {
    const html = read('index.html');
    assert.ok(html.includes('<meta name="theme-color" content="#978c21" />'), 'theme colour is the brand olive');
    assert.ok(html.includes('<meta name="apple-mobile-web-app-capable" content="yes" />'), 'iOS web-app capable');
    assert.ok(html.includes('<link rel="manifest" href="/site.webmanifest" />'), 'manifest link stays site.webmanifest');
    assert.ok(html.includes('<link rel="icon" type="image/svg+xml" href="/icon.svg" />'), 'SVG favicon first');
    assert.ok(html.includes('<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />'), 'PNG 32 fallback');
    assert.ok(html.includes('<link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png" />'), 'PNG 48 fallback');
    assert.ok(html.includes('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />'), 'Apple touch icon');
    // SVG favicon precedes the PNG fallbacks.
    assert.ok(
      html.indexOf('href="/icon.svg"') < html.indexOf('href="/icons/favicon-32.png"'),
      'the SVG favicon must come before the PNG fallbacks'
    );
    // The old root favicon files are no longer referenced.
    for (const old of ['/favicon.ico', '/favicon-32x32.png', '/favicon-16x16.png', 'href="/apple-touch-icon.png"']) {
      assert.ok(!html.includes(old), `index.html must not reference ${old}`);
    }
    assert.ok(html.includes('<title>LeadFlow</title>'), 'title unchanged');
  });
});

describe('app icon set — manifest', () => {
  it('is valid JSON with LeadFlow identity and exactly the new icon set', () => {
    const manifest = JSON.parse(read('public/site.webmanifest'));
    assert.equal(manifest.name, 'LeadFlow — Shanta Life', 'name unchanged');
    assert.equal(manifest.short_name, 'LeadFlow', 'short name unchanged');
    assert.equal(manifest.background_color, '#ffffff', 'background colour unchanged');
    assert.equal(manifest.display, 'standalone', 'display unchanged');
    assert.equal(manifest.theme_color, '#978c21', 'theme colour matches the brand olive');
    assert.deepEqual(manifest.icons, [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });
});

describe('app icon set — SVG master and service worker', () => {
  it('public/icon.svg is byte-identical to the handed-off master', () => {
    const svg = fs.readFileSync(path.join(repoRoot, 'public/icon.svg'));
    const sha = crypto.createHash('sha256').update(svg).digest('hex');
    assert.equal(sha, ICON_SVG_SHA256, 'icon.svg must match the handed-off master byte for byte');
    const text = svg.toString('utf8');
    assert.ok(text.includes('fill="#978C21"'), 'olive tile');
    assert.ok(text.includes('fill="#F37021"'), 'orange drop');
  });

  it('push notifications show the new brand icon', () => {
    const sw = read('public/sw.js');
    assert.ok(sw.includes("icon: '/icons/icon-192.png'"), 'notification icon is the new brand icon');
    assert.ok(sw.includes("badge: '/icons/icon-192.png'"), 'notification badge is the new brand icon');
    assert.ok(!sw.includes('android-chrome'), 'no reference to the old icon files remains');
  });
});
