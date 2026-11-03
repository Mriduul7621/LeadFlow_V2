/**
 * whatsapp-actions.test.ts
 * ------------------------------------------------------------------
 * Phase 2 PR #1 — free WhatsApp click-to-chat (wa.me) actions with
 * prefilled Bangla templates. Zero-cost by design: no WhatsApp
 * Business API, no gateway, no backend sending; the agent sends
 * from their own WhatsApp via a wa.me deep link.
 *
 * Three halves, mirroring the repo's test style:
 *   1. Behavior — BD mobile normalization (every accepted written
 *      form in, non-BD / landline / malformed numbers out as null),
 *      template interpolation (incl. the blank-name fallback), and
 *      href building (Bangla text percent-encoded, exact href for a
 *      fixture lead).
 *   2. Rendering — WhatsAppTemplateLinks RENDERED (renderToStaticMarkup
 *      like chunk-recovery / dashboard-productivity-refinement): a
 *      fixture lead produces one wa.me anchor per template with the
 *      lead name inside the decoded message; WhatsAppAction renders
 *      nothing at all for an unreachable number.
 *   3. Source guards — the placements exist where promised (Lead360
 *      beside the tel: contact row, Daily Workbench quick actions),
 *      and the zero-cost contract holds in source: wa.me links only,
 *      no Business API hosts, no backend request in the component.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeBdMobileIntl } from '../../src/modules/shared/utils/phone';
import {
  WHATSAPP_TEMPLATES,
  getWhatsAppTemplate,
  renderWhatsAppTemplate,
  buildWhatsAppHref,
} from '../../src/modules/leads/utils/whatsappTemplates';
import WhatsAppAction, {
  WhatsAppTemplateLinks,
} from '../../src/modules/leads/components/WhatsAppAction';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FIXTURE = { mobile: '01711001122', name: 'Ayesha Rahman' };
const FIXTURE_INTL = '8801711001122';

describe('normalizeBdMobileIntl', () => {
  it('accepts the local 01X form', () => {
    assert.equal(normalizeBdMobileIntl('01711001122'), FIXTURE_INTL);
  });

  it('accepts +880 and bare 880 international forms', () => {
    assert.equal(normalizeBdMobileIntl('+8801711001122'), FIXTURE_INTL);
    assert.equal(normalizeBdMobileIntl('8801711001122'), FIXTURE_INTL);
  });

  it('accepts the bare national significant number', () => {
    assert.equal(normalizeBdMobileIntl('1711001122'), FIXTURE_INTL);
  });

  it('tolerates spaces, dashes and parentheses', () => {
    assert.equal(normalizeBdMobileIntl('+880 1711-001122'), FIXTURE_INTL);
    assert.equal(normalizeBdMobileIntl('01711 001 122'), FIXTURE_INTL);
    assert.equal(normalizeBdMobileIntl('(01711) 001-122'), FIXTURE_INTL);
  });

  it('accepts every valid operator prefix range', () => {
    assert.equal(normalizeBdMobileIntl('01311001122'), '8801311001122');
    assert.equal(normalizeBdMobileIntl('01911001122'), '8801911001122');
  });

  it('rejects empty and missing values', () => {
    assert.equal(normalizeBdMobileIntl(''), null);
    assert.equal(normalizeBdMobileIntl('   '), null);
    assert.equal(normalizeBdMobileIntl(null), null);
    assert.equal(normalizeBdMobileIntl(undefined), null);
  });

  it('rejects non-BD country codes', () => {
    assert.equal(normalizeBdMobileIntl('+14155552671'), null);
    assert.equal(normalizeBdMobileIntl('+919876543210'), null);
    assert.equal(normalizeBdMobileIntl('00441711001122'), null);
  });

  it('rejects landlines and invalid operator prefixes', () => {
    assert.equal(normalizeBdMobileIntl('0229612345'), null);
    assert.equal(normalizeBdMobileIntl('01211001122'), null);
    assert.equal(normalizeBdMobileIntl('01011001122'), null);
  });

  it('rejects too-short and too-long numbers', () => {
    assert.equal(normalizeBdMobileIntl('0171100112'), null);
    assert.equal(normalizeBdMobileIntl('017110011223'), null);
    assert.equal(normalizeBdMobileIntl('01711'), null);
    assert.equal(normalizeBdMobileIntl('+880171100112'), null);
  });

  it('rejects letters and other junk', () => {
    assert.equal(normalizeBdMobileIntl('01711abc122'), null);
    assert.equal(normalizeBdMobileIntl('call me'), null);
  });
});

describe('WhatsApp templates', () => {
  it('ships exactly the three built-in templates, each with a {name} slot', () => {
    assert.deepEqual(
      WHATSAPP_TEMPLATES.map((t) => t.id),
      ['first_contact', 'follow_up', 'meeting_confirmation'],
    );
    for (const t of WHATSAPP_TEMPLATES) {
      assert.ok(t.body.includes('{name}'), `${t.id} must interpolate the lead name`);
      assert.ok(t.label.length > 0);
    }
  });

  it('interpolates the lead name and leaves no placeholder behind', () => {
    const text = renderWhatsAppTemplate(getWhatsAppTemplate('first_contact'), FIXTURE.name);
    assert.ok(text.includes(FIXTURE.name));
    assert.ok(!text.includes('{name}'));
  });

  it('falls back to a respectful generic address for a blank name', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const text = renderWhatsAppTemplate(getWhatsAppTemplate('follow_up'), blank);
      assert.ok(!text.includes('{name}'));
      assert.ok(text.includes('স্যার/ম্যাডাম'));
    }
  });

  it('makes no pricing or commitment claims in any template', () => {
    for (const t of WHATSAPP_TEMPLATES) {
      assert.ok(!/premium|price|টাকা|%|guarantee/i.test(t.body), `${t.id} must stay claim-free`);
    }
  });
});

describe('buildWhatsAppHref', () => {
  it('builds the exact wa.me href for a fixture lead', () => {
    const href = buildWhatsAppHref(FIXTURE.mobile, 'first_contact', FIXTURE.name);
    const expectedText = renderWhatsAppTemplate(getWhatsAppTemplate('first_contact'), FIXTURE.name);
    assert.equal(href, `https://wa.me/${FIXTURE_INTL}?text=${encodeURIComponent(expectedText)}`);
  });

  it('percent-encodes the Bangla message (no raw Bangla in the href)', () => {
    const href = buildWhatsAppHref(FIXTURE.mobile, 'meeting_confirmation', FIXTURE.name)!;
    const textParam = href.split('?text=')[1];
    assert.ok(!/[^\x00-\x7F]/.test(textParam), 'href text param must be pure ASCII after encoding');
    assert.equal(decodeURIComponent(textParam), renderWhatsAppTemplate(getWhatsAppTemplate('meeting_confirmation'), FIXTURE.name));
  });

  it('returns null for an unreachable number', () => {
    assert.equal(buildWhatsAppHref('01211001122', 'first_contact', FIXTURE.name), null);
    assert.equal(buildWhatsAppHref('', 'follow_up', FIXTURE.name), null);
  });
});

describe('WhatsAppAction rendering', () => {
  it('renders one wa.me anchor per template for a fixture lead', () => {
    const html = renderToStaticMarkup(
      React.createElement(WhatsAppTemplateLinks, { mobile: FIXTURE.mobile, name: FIXTURE.name }),
    );
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(hrefs.length, WHATSAPP_TEMPLATES.length);
    for (const href of hrefs) {
      assert.ok(href.startsWith(`https://wa.me/${FIXTURE_INTL}?text=`), href);
      assert.ok(decodeURIComponent(href.split('?text=')[1]).includes(FIXTURE.name));
    }
    for (const t of WHATSAPP_TEMPLATES) assert.ok(html.includes(t.label));
  });

  it('renders the labelled button for a valid number', () => {
    const html = renderToStaticMarkup(
      React.createElement(WhatsAppAction, { mobile: FIXTURE.mobile, name: FIXTURE.name }),
    );
    assert.ok(html.includes('WhatsApp'));
    assert.ok(html.includes('aria-haspopup="menu"'));
  });

  it('renders nothing for an invalid number', () => {
    const html = renderToStaticMarkup(
      React.createElement(WhatsAppAction, { mobile: '01211001122', name: FIXTURE.name }),
    );
    assert.equal(html, '');
  });
});

describe('WhatsApp placement + zero-cost source guards', () => {
  it('Lead360 places WhatsAppAction beside the contact actions and keeps the tel: link', () => {
    const src = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(src.includes("from '../components/WhatsAppAction'"));
    assert.ok(src.includes('<WhatsAppAction mobile={lead.mobile} name={lead.prospectName} />'));
    assert.ok(src.includes('<WhatsAppAction variant="icon" mobile={lead.mobile} name={lead.prospectName} />'));
    assert.ok(src.includes('href={`tel:${lead.mobile}`}'), 'existing call link must remain');
  });

  it('Daily Workbench quick actions include WhatsAppAction fed from the selected item', () => {
    const src = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(src.includes("from '../../leads/components/WhatsAppAction'"));
    assert.ok(src.includes('<WhatsAppAction mobile={selectedMobile} name={selectedItem.leadName} />'));
  });

  it('zero-cost contract: wa.me only — no Business API, no backend send', () => {
    const component = read('src/modules/leads/components/WhatsAppAction.tsx');
    const templates = read('src/modules/leads/utils/whatsappTemplates.ts');
    for (const src of [component, templates]) {
      assert.ok(!src.includes('api.whatsapp.com'), 'must not use the WhatsApp Business API host');
      assert.ok(!src.includes('graph.facebook.com'), 'must not use the Meta Graph API');
    }
    assert.ok(templates.includes('https://wa.me/'));
    assert.ok(!component.includes('apiRequest'), 'clicking must not call the backend');
    assert.ok(!component.includes('fetch('), 'clicking must not call the backend');
  });

  it('phone normalization lives in the single shared util used by the templates module', () => {
    const templates = read('src/modules/leads/utils/whatsappTemplates.ts');
    assert.ok(templates.includes("from '../../shared/utils/phone'"));
    assert.ok(templates.includes('normalizeBdMobileIntl'));
  });
});
