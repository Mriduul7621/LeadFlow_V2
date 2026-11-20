/**
 * branding-about-help.test.ts — Branding + About/Help polish
 * ------------------------------------------------------------------
 * Guards for the 2026-11-20 branding pass (Mahadi): the sidebar
 * shows the original Shanta Life logo (not the enterprise 'L'
 * monogram tile); the login heading names the Lead Management
 * System; the About page carries real detail about the app; the
 * Help page carries grouped how-tos with links to real routes.
 * Presentation/content only — no migration, no server change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
/** The .ep-logo rule body from index.css ('' when absent). */
function epLogoRule(css: string): string {
  const m = /\.ep-logo\s*\{([\s\S]*?)\}/.exec(css);
  return m ? m[1] : '';
}

describe('Branding + About/Help — source guards', () => {
  const layout = () => read('src/layouts/AppLayout.tsx');
  const login = () => read('src/modules/auth/pages/Login.tsx');
  const more = () => read('src/modules/navigation/pages/MorePages.tsx');
  const indexCss = () => read('src/index.css');
  const app = () => read('src/App.tsx');

  it('sidebar shows the Shanta Life logo image, not the L monogram', () => {
    const visible = stripComments(layout());
    assert.ok(
      visible.includes('<img className="ep-logo" src="/shanta-life-logo.png" alt="Shanta Life" />'),
      'sidebar brand must render the Shanta Life logo as an <img> with class ep-logo',
    );
    assert.ok(!visible.includes('>L</'), 'no L monogram tile may remain in the layout');
    assert.ok(!visible.includes('ep-logo" aria-hidden'), 'the old monogram div must be gone');
    // The LeadFlow wordmark next to the logo stays.
    assert.ok(visible.includes('<strong>LeadFlow</strong>'), 'LeadFlow wordmark stays next to the logo');
    assert.ok(visible.includes('<small>Sales workspace</small>'), 'Sales workspace subline stays');
    // The asset itself is in the repo (and still used on the login splash).
    assert.ok(fs.existsSync(path.join(ROOT, 'public/shanta-life-logo.png')), 'public/shanta-life-logo.png must exist');
    assert.ok(login().includes('/shanta-life-logo.png'), 'login still uses the same logo asset');
  });

  it('.ep-logo is styled as an image, not a monogram tile', () => {
    const rule = epLogoRule(indexCss());
    assert.ok(rule, '.ep-logo rule must exist in index.css');
    assert.ok(rule.includes('object-fit: contain'), '.ep-logo must contain the wide logo without cropping');
    assert.ok(rule.includes('height: 36px'), '.ep-logo keeps tile height');
    assert.ok(!rule.includes('background'), '.ep-logo must not carry the old deep-green tile background');
    assert.ok(!rule.includes('place-items'), '.ep-logo must not centre a letter any more');
    assert.ok(!rule.includes('font-size'), '.ep-logo must not size a letter any more');
  });

  it('login heading names the Lead Management System (both variants)', () => {
    const visible = stripComments(login());
    assert.ok(
      visible.includes('Sign in to your Lead Management System'),
      'sign-in heading must read "Sign in to your Lead Management System"',
    );
    assert.ok(
      visible.includes('Set up your Lead Management System'),
      'first-time setup heading must read "Set up your Lead Management System"',
    );
    assert.ok(!visible.includes('LeadFlow account'), 'no "LeadFlow account" string may remain on Login');
    assert.ok(!visible.includes('Managment'), 'the misspelling "Managment" must not appear');
  });

  it('About page carries real detail about the app', () => {
    const body = more().slice(more().indexOf('export function AboutPage'));
    const visible = stripComments(body);
    assert.ok(visible.includes('Lead Management System'), 'About must name the full product name');
    assert.ok(visible.includes("Shanta Life&apos;s lead workspace"), 'About must say what the app is');
    assert.ok(visible.includes('Training &amp; Development Department'), 'About must credit T&D');
    assert.ok(visible.includes('Shanta Life Insurance PLC'), 'About must name the company');
    for (const item of ['Leads', 'Follow-ups', 'Meetings', 'Roadshows', 'Performance']) {
      assert.ok(visible.includes(item), `About must list the ${item} coverage`);
    }
    for (const role of ['Agents', 'Team Leads', 'Managers', 'Admins']) {
      assert.ok(visible.includes(role), `About must name the ${role} role`);
    }
    assert.ok(
      visible.includes('you only ever see the leads, follow-ups and reports your role allows'),
      'About must carry the role-scoped visibility note',
    );
    // No invented facts: no version number, no year, no stats.
    assert.ok(!/v\d+\.\d+/.test(visible), 'About must not invent a version number');
    assert.ok(!/20\d\d/.test(visible), 'About must not invent a date');
  });

  it('Help page carries grouped how-tos, including account help and the lockout rule', () => {
    const src = more();
    const body = src.slice(src.indexOf('export function HelpPage'), src.indexOf('export function AboutPage'));
    const visible = stripComments(body);
    for (const group of ['Leads', 'Follow-ups &amp; meetings', 'Data &amp; reports', 'Account']) {
      assert.ok(visible.includes(group), `Help must have the "${group}" group`);
    }
    for (const section of [
      'Add a lead',
      'Find and update a lead',
      'Edit a lead',
      'Follow-up Queue',
      'WhatsApp a customer',
      'Meetings and Task Calendar',
      'Roadshows',
      'Import leads in bulk',
      'Reports and performance',
      'Notifications',
      'Your password',
      'Locked out?',
      'Access or data questions',
    ]) {
      assert.ok(visible.includes(section), `Help must have the "${section}" section`);
    }
    // Lockout rule, verified against the DZ-4 security-policy defaults
    // (SecurityPolicyService: threshold 10, 30 minutes, enabled).
    assert.ok(visible.includes('10 failed sign-in attempts'), 'Help must state the 10-attempt lockout threshold');
    assert.ok(visible.includes('locked for 30 minutes'), 'Help must state the 30-minute lockout');
    // Forgot password has no self-service reset in LeadFlow (the login
    // page's Forgot Password button tells the user to contact the admin).
    assert.ok(visible.includes('no self-service reset'), 'Help must say there is no self-service reset');
    assert.ok(
      visible.includes('Contact your workspace administrator if a page or action is unavailable for your role.'),
      'Help must keep the closing administrator line',
    );
    // No invented contact details.
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(visible), 'Help must not invent an email address');
    assert.ok(!/\+?880[\s-]?\d/.test(visible), 'Help must not invent a phone number');
  });

  it('every Help/About link points at a real App route', () => {
    const routes = new Set(
      [...app().matchAll(/path:\s*'([^']+)'/g)].map(m => m[1]).filter(p => !p.includes(':')),
    );
    const links = [...more().matchAll(/to="([^"]+)"/g)].map(m => m[1]);
    assert.ok(links.length > 0, 'MorePages must contain links');
    for (const link of links) {
      assert.ok(routes.has(link), `link ${link} must be a real route in App.tsx`);
    }
  });
});
