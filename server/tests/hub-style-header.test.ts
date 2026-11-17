/**
 * hub-style-header.test.ts — Learning Hub-style header for LeadFlow
 * ------------------------------------------------------------------
 * Guards for the header restyle (2026-11-04), retargeted at the
 * role-workspace shell (Phase 1, 2026-11-17):
 *
 *  - the topbar carries a LIVE Asia/Dhaka date + time — the formatter
 *    is pinned to Asia/Dhaka, ticks every second, and its interval is
 *    always cleaned up,
 *  - the shell is a fixed left sidebar (248px, 220px at <=1100px,
 *    slide-in drawer + overlay at <=760px) with a sticky topbar
 *    (breadcrumb, notifications button with dot, avatar) — the
 *    floating pill + utility bar are RETIRED (2026-11-17),
 *  - the profile chip (avatar + name) leads to the Profile page
 *    (/settings), mirroring the Hub; sign-out stays in the user menu,
 *  - nothing else about the shell moved: the drawer toggle and the
 *    notification panel keep their hooks.
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

  it('the topbar carries the live Dhaka clock and the breadcrumb', () => {
    const l = layout();
    assert.ok(l.includes('<DhakaClock className="lf-topbar-clock" />'),
      'the topbar must render the live Dhaka clock');
    assert.ok(l.includes("from './DhakaClock'"), 'the clock must come from the shared component');
    assert.ok(l.includes('lf-breadcrumb'), 'the topbar must render the breadcrumb');
    assert.ok(!l.includes('dhakaTime'), 'the old 60-second in-header clock state must be gone');
    assert.ok(!l.includes('layout-language-switcher'), 'no language switcher may sneak into the topbar');
  });

  it('the floating pill, the utility bar and the mobile bottom nav are retired', () => {
    const l = layout();
    const c = css();
    for (const retired of ['leadflow-utility-bar', 'leadflow-nav-pill', 'leadflow-mobile-nav', 'leadflow-desktop-nav']) {
      assert.ok(!l.includes(retired), `AppLayout must not reference the retired ${retired}`);
      assert.ok(!c.includes(`.${retired}`), `the CSS must not style the retired ${retired}`);
    }
    assert.ok(!l.includes('PRIMARY_NAV_ITEMS'), 'the pill destination list is retired with the pill');
    assert.ok(!l.includes('visiblePrimaryItems'), 'the pill visibility filter is retired with the pill');
  });

  it('the sidebar keeps every existing destination, gate and action', () => {
    const l = layout();
    // Role-based sidebar groups, built from the route gate.
    assert.ok(l.includes('buildSidebarGroups('), 'the sidebar is built by the role-aware builder');
    assert.ok(l.includes('resolveFeatureRouteAccess('), 'the route gate still filters the nav');
    assert.ok(l.includes('sidebarGroups.map('), 'the sidebar renders the built groups');
    // Drawer toggle and notification bell untouched.
    assert.ok(l.includes('lf-sidebar-toggle'), 'drawer toggle kept');
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

  it('the CSS carries the workspace geometry: 248px sidebar, 72px topbar, sample breakpoints', () => {
    const c = css();
    const sidebar = c.slice(c.indexOf('.lf-sidebar {'), c.indexOf('.lf-sidebar {') + 500);
    assert.match(sidebar, /width:\s*248px/, 'the sidebar is 248px wide');
    const topbar = c.slice(c.indexOf('.lf-topbar {'), c.indexOf('.lf-topbar {') + 500);
    assert.match(topbar, /height:\s*72px/, 'the topbar is 72px tall');
    assert.match(topbar, /position:\s*sticky/, 'the topbar sticks to the top of the viewport');
    assert.ok(c.includes('@media (max-width: 1100px)'), 'the 1100px breakpoint (220px sidebar) must exist');
    assert.ok(c.includes('@media (max-width: 760px)'), 'the 760px breakpoint (drawer) must exist');
    assert.match(c, /@media \(max-width: 1100px\) \{\s*\.lf-sidebar\s*\{\s*width:\s*220px/,
      'the sidebar narrows to 220px at <=1100px');
  });

  it('the topbar tightens on small screens instead of crushing the header', () => {
    const c = css();
    const mobile = c.slice(c.indexOf('@media (max-width: 760px)'));
    assert.ok(!/header\.sticky\s*\{\s*height:\s*58px/.test(mobile),
      'the old fixed 58px header height must not survive the restyle');
    assert.match(mobile, /\.lf-topbar\s*\{\s*height:\s*62px/,
      'the topbar tightens to 62px on small screens instead');
  });
});
