/**
 * hub-style-header.test.ts — Learning Hub-style header for LeadFlow
 * ------------------------------------------------------------------
 * Guards for the header restyle (2026-11-04):
 *
 *  - the topbar carries a LIVE Asia/Dhaka date + time — the formatter
 *    is pinned to Asia/Dhaka, ticks every second, and its interval is
 *    always cleaned up,
 *  - the profile chip (avatar + name) leads to the Profile page
 *    (/settings), mirroring the Hub; sign-out stays in the user menu,
 *  - nothing else about the shell moved: the drawer toggle and the
 *    notification panel keep their hooks.
 *
 * Enterprise Preview (2026-11-19): the Hub-style shell itself — the
 * utility bar, the floating pill, the five centred primary tabs and
 * the mobile bottom nav — was retired and replaced by the sample's
 * enterprise shell (250px sticky sidebar, 70px topbar, breadcrumb).
 * The shell-structure guards below now pin the NEW geometry; the
 * DhakaClock guards above are unchanged.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const {
  formatDhakaDateTime,
  subscribeDhakaClock,
} = await import('../../src/layouts/DhakaClock.js');

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Hub-style header — Dhaka utility-bar clock', () => {
  it('formats a fixed instant as the full Dhaka date + time line', () => {
    // 05:59:24 UTC is 11:59:24 in Dhaka (UTC+6) on the same morning.
    assert.equal(
      formatDhakaDateTime(new Date('2026-11-04T05:59:24Z')),
      'Wednesday, 4 November 2026 · 11:59:24 AM',
    );
  });

  it('is pinned to Asia/Dhaka, not the viewer device timezone', () => {
    // 18:30 UTC on 4 Nov is already 00:30 on 5 Nov in Dhaka — the date
    // must roll over even though UTC (and any US/EU device) has not.
    assert.equal(
      formatDhakaDateTime(new Date('2026-11-04T18:30:00Z')),
      'Thursday, 5 November 2026 · 12:30:00 AM',
    );
    assert.equal(
      formatDhakaDateTime(new Date('2026-01-01T00:00:00Z')),
      'Thursday, 1 January 2026 · 6:00:00 AM',
    );
  });

  it('ticks once per second and stops dead after unsubscribe', () => {
    mock.timers.enable({
      apis: ['setInterval', 'Date'],
      now: new Date('2026-11-04T05:59:24Z'),
    });
    try {
      const ticks: number[] = [];
      const unsubscribe = subscribeDhakaClock((now) => ticks.push(now.getTime()));
      // Advance one second at a time: the mock clock reports the final
      // instant of a multi-second tick to every callback in the batch.
      mock.timers.tick(1000);
      mock.timers.tick(1000);
      mock.timers.tick(1000);
      assert.deepEqual(ticks, [
        Date.parse('2026-11-04T05:59:25Z'),
        Date.parse('2026-11-04T05:59:26Z'),
        Date.parse('2026-11-04T05:59:27Z'),
      ]);
      unsubscribe();
      mock.timers.tick(5000);
      assert.equal(ticks.length, 3, 'no tick may fire after cleanup');
    } finally {
      mock.timers.reset();
    }
  });

  it('the component wires the ticker through an effect with cleanup', () => {
    const clock = read('src/layouts/DhakaClock.tsx');
    assert.ok(clock.includes("const DHAKA_TIME_ZONE = 'Asia/Dhaka'"), 'timezone must be a pinned constant');
    assert.ok((clock.match(/timeZone: DHAKA_TIME_ZONE/g) || []).length >= 2, 'both formatters must use the pinned zone');
    assert.ok(clock.includes('useEffect(() => subscribeDhakaClock(setNow, intervalMs), [intervalMs])'),
      'the hook must subscribe inside an effect whose cleanup unsubscribes');
    assert.ok(clock.includes('clearInterval(id)'), 'unsubscribe must clear the interval');
    assert.ok(clock.includes('intervalMs = 1000'), 'the default tick is one second (seconds are displayed)');
  });
});

describe('Hub-style header — shell structure (source guards)', () => {
  const layout = () => read('src/layouts/AppLayout.tsx');
  const css = () => read('src/index.css');

  it('the topbar carries the live Dhaka clock (and the retired shell is gone)', () => {
    const l = layout();
    assert.ok(l.includes('<DhakaClock className="ep-topbar-clock" />'),
      'the topbar must render the live Dhaka clock');
    assert.ok(l.includes("from './DhakaClock'"), 'the clock must come from the shared component');
    assert.ok(!l.includes('dhakaTime'), 'the old 60-second in-header clock state must be gone');
    assert.ok(!l.includes('layout-language-switcher'), 'no language switcher may sneak into the topbar');
    // The Hub-style shell is retired: no utility bar, no floating pill,
    // no primary tabs in the live layout.
    assert.ok(!l.includes('leadflow-utility-bar'), 'the utility bar must not return');
    assert.ok(!l.includes('leadflow-nav-pill'), 'the floating pill must not return');
    assert.ok(!l.includes('PRIMARY_NAV_ITEMS'), 'the five primary tabs must not return');
    assert.ok(!l.includes('leadflow-mobile-nav'), 'the mobile bottom nav must not return');
  });

  it('the sidebar keeps every existing destination, gate and action', () => {
    const l = layout();
    // Same destinations, same visibility rule: the sidebar renders from
    // the enterprise nav builder, filtered by the route gate + the
    // functional permission — never a hardcoded list.
    assert.ok(l.includes('buildEnterpriseNavGroups'), 'sidebar renders from the enterprise nav builder');
    assert.ok(l.includes('resolveFeatureRouteAccess'), 'route-level visibility filtering unchanged');
    assert.ok(l.includes('canAccess'), 'functional permission filtering unchanged');
    // Drawer toggle and notification bell untouched.
    assert.ok(l.includes('id="leadflow-sidebar-toggle"'), 'drawer toggle kept');
    assert.ok(l.includes('aria-label="Notifications"'), 'notification bell kept');
    assert.ok(l.includes('unreadCount'), 'bell count kept');
    // Sign-out still lives in the user menu.
    assert.ok(l.includes('Logged in as') && l.includes('Logout'), 'user menu contents kept');
  });

  it('the profile chip leads to the Profile page and shows the user name', () => {
    const l = layout();
    const chipIdx = l.indexOf('ep-profile-chip');
    assert.ok(chipIdx !== -1, 'the profile chip must exist');
    const chip = l.slice(chipIdx - 200, chipIdx + 1200);
    assert.ok(chip.includes('to="/settings"'), 'the chip must link to the Profile page (/settings)');
    assert.ok(chip.includes('{user.name}'), 'the chip must show the signed-in user name');
    assert.ok(chip.includes('user.avatarUrl'), 'the chip must use the user avatar when present');
  });

  it('the CSS carries the enterprise geometry: 250px sidebar, 70px topbar, soft active', () => {
    const c = css();
    const shell = c.slice(c.indexOf('.ep-shell {'), c.indexOf('.ep-shell {') + 400);
    assert.match(shell, /grid-template-columns:\s*250px 1fr/, 'the shell is a 250px sidebar + content grid');
    const topbar = c.slice(c.indexOf('.ep-topbar {'), c.indexOf('.ep-topbar {') + 400);
    assert.match(topbar, /height:\s*70px/, 'the topbar is 70px tall like the sample');
    const active = c.slice(c.indexOf('.ep-navitem.active {'), c.indexOf('.ep-navitem.active {') + 200);
    assert.match(active, /background:\s*var\(--ep-soft\)/, 'the active nav item uses the soft background');
    assert.match(active, /color:\s*var\(--ep-deep\)/, 'the active nav item uses the deep text colour');
  });

  it('the mobile rules turn the sidebar into a drawer at 720px', () => {
    const c = css();
    const mobile = c.slice(c.indexOf('@media (max-width: 720px)'));
    assert.match(mobile, /\.ep-sidebar\s*\{\s*position:\s*fixed[^}]*left:\s*-270px/,
      'the sidebar hides off-canvas on small screens');
    assert.match(mobile, /\.ep-sidebar\.open\s*\{\s*left:\s*0/,
      'the open drawer slides in from the left');
    assert.match(mobile, /\.ep-topbar\s*\{\s*height:\s*60px/,
      'the topbar tightens to 60px on small screens');
    assert.match(mobile, /\.ep-hamburger\s*\{\s*display:\s*inline-flex/,
      'the hamburger appears on small screens');
  });
});
