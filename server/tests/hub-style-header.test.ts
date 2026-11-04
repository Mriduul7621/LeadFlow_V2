/**
 * hub-style-header.test.ts — Learning Hub-style header for LeadFlow
 * ------------------------------------------------------------------
 * Guards for the header restyle (2026-11-04):
 *
 *  - the utility bar carries a LIVE Asia/Dhaka date + time where the
 *    Learning Hub carries its E-BOOK link and BN|EN switcher — the
 *    formatter is pinned to Asia/Dhaka, ticks every second, and its
 *    interval is always cleaned up,
 *  - the main navigation lives in a floating rounded pill: logo left,
 *    the same five permission-filtered primary destinations centred
 *    (active = Sunset Orange underline), bell + profile chip right,
 *  - the profile chip (avatar + name) leads to the Profile page
 *    (/settings), mirroring the Hub; sign-out stays in the user menu,
 *  - nothing else about the shell moved: the drawer toggle, the
 *    notification panel and the mobile bottom nav keep their hooks.
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

  it('the utility bar sits above the floating pill and carries the clock', () => {
    const l = layout();
    const utilityIdx = l.indexOf('leadflow-utility-bar');
    const pillIdx = l.indexOf('leadflow-nav-pill');
    assert.ok(utilityIdx !== -1 && pillIdx !== -1 && utilityIdx < pillIdx,
      'utility bar first, floating pill below it');
    assert.ok(l.includes('<DhakaClock className="leadflow-utility-clock" />'),
      'the utility bar must render the live Dhaka clock');
    assert.ok(l.includes("from './DhakaClock'"), 'the clock must come from the shared component');
    assert.ok(!l.includes('dhakaTime'), 'the old 60-second in-header clock state must be gone');
    assert.ok(!l.includes('layout-language-switcher'), 'no language switcher may sneak into the utility bar');
  });

  it('the pill keeps every existing destination, gate and action', () => {
    const l = layout();
    // Same primary destinations, same visibility rule, same active logic.
    assert.ok(l.includes('PRIMARY_NAV_ITEMS'), 'primary destinations unchanged');
    assert.ok(l.includes('visiblePrimaryItems'), 'menu visibility filtering unchanged');
    assert.ok(l.includes('leadflow-desktop-nav'), 'desktop centre nav hook kept');
    assert.ok(l.includes('leadflow-mobile-nav'), 'mobile bottom nav kept');
    // Drawer toggle and notification bell untouched.
    assert.ok(l.includes('id="leadflow-sidebar-toggle"'), 'drawer toggle kept');
    assert.ok(l.includes('aria-label="Notifications"'), 'notification bell kept');
    assert.ok(l.includes('unreadCount'), 'bell count kept');
    // Sign-out still lives in the user menu.
    assert.ok(l.includes('Logged in as') && l.includes('Logout'), 'user menu contents kept');
  });

  it('the profile chip leads to the Profile page and shows the user name', () => {
    const l = layout();
    const chipIdx = l.indexOf('leadflow-profile-chip');
    assert.ok(chipIdx !== -1, 'the profile chip must exist');
    const chip = l.slice(chipIdx - 200, chipIdx + 1200);
    assert.ok(chip.includes('to="/settings"'), 'the chip must link to the Profile page (/settings)');
    assert.ok(chip.includes('{user.name}'), 'the chip must show the signed-in user name');
    assert.ok(chip.includes('user.avatarUrl'), 'the chip must use the user avatar when present');
  });

  it('the CSS carries the Hub geometry: utility bar, floating pill, orange underline', () => {
    const c = css();
    assert.ok(c.includes('.leadflow-utility-bar'), 'utility bar style must exist');
    const pill = c.slice(c.indexOf('.leadflow-nav-pill {'), c.indexOf('.leadflow-nav-pill {') + 500);
    assert.match(pill, /height:\s*56px/, 'the pill is 56px tall like the Hub nav');
    assert.match(pill, /border-radius:\s*16px/, 'the pill is rounded like the Hub nav');
    assert.match(pill, /box-shadow:/, 'the pill floats on a soft shadow');
    const desktop = c.slice(c.indexOf('@media (min-width: 1280px)'));
    assert.ok(desktop.includes('.leadflow-desktop-nav-item.is-active::after'),
      'the active centre link must carry an underline pseudo-element');
    const underline = desktop.slice(desktop.indexOf('.leadflow-desktop-nav-item.is-active::after'));
    assert.match(underline.slice(0, 400), /background:\s*#F37021/,
      'the active underline is Sunset Orange #F37021');
  });

  it('the mobile header rule no longer crushes the two-piece header to 58px', () => {
    const c = css();
    const mobile = c.slice(c.indexOf('@media (max-width: 767px)'));
    assert.ok(!/header\.sticky\s*\{\s*height:\s*58px/.test(mobile),
      'the old fixed 58px header height must not survive the restyle');
    assert.match(mobile, /\.leadflow-nav-pill\s*\{\s*height:\s*52px/,
      'the pill tightens to 52px on small screens instead');
  });
});
