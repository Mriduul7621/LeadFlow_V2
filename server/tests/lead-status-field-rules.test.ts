/**
 * lead-status-field-rules.test.ts
 * ------------------------------------------------------------------
 * F6 — the per-status conditional fields are a SERVER rule now.
 *
 * The rules used to be a client convention (`LeadUpdate.tsx validate()`), so
 * `POST /api/leads/:id/follow-up` happily stored "Converted" with no premium,
 * "Meeting Fixed" with no meeting, or "Not Interested" with no reason — and
 * every report built on those fields (FYCP, loss analysis, the calendar
 * mirror) silently counted half-filled records.
 *
 * This file pins the specification itself and the client/server parity; the
 * end-to-end enforcement over HTTP lives in lead-followup-integration.test.ts
 * (cases Z1–Z8).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEAD_STAGE_RULES,
  ruleForLeadStatus,
  validateLeadStatusFields,
  leadStatusViolationMessage,
} from '../../src/modules/leads/utils/leadStatusRules';
import {
  isBlank,
  normalizeStatusKey,
  requireNumber,
} from '../../src/modules/shared/utils/statusFieldRules';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('F6 — per-status required fields (specification)', () => {
  it('A. the rule table covers exactly the five conditional statuses', () => {
    const byStatus = Object.fromEntries(LEAD_STAGE_RULES.map(r => [r.status, r.required.map(f => f.field)]));
    assert.deepEqual(byStatus, {
      'Follow-up Set': ['nextFollowUpDate'],
      'Meeting Fixed': ['meetingDate'],
      'Proposal Sent': ['productName', 'sumAssured', 'projectedNCP'],
      Converted: ['productName', 'sumAssured', 'collectedNCP'],
      'Not Interested': ['lossReason'],
    });
    // 'Interested' is deliberately NOT in the table: it is a real state a lead
    // can sit in (the app's own history and tests assert exactly that), and
    // the "Next Action" step is the form's shortcut out of it — enforced for
    // the RESOLVED status, not for Interested itself.
    assert.equal(ruleForLeadStatus('Interested'), undefined);
    assert.equal(ruleForLeadStatus('New'), undefined);
    assert.equal(ruleForLeadStatus('Contacted'), undefined);
  });

  it('B. lookup is dictionary-spelling tolerant, and unknown statuses are free', () => {
    assert.equal(ruleForLeadStatus('follow-up set')?.status, 'Follow-up Set');
    assert.equal(ruleForLeadStatus('  MEETING   FIXED ')?.status, 'Meeting Fixed');
    assert.equal(ruleForLeadStatus('not_interested')?.status, 'Not Interested');
    assert.equal(ruleForLeadStatus(''), undefined);
    assert.equal(ruleForLeadStatus('Some Custom Status'), undefined);
    assert.deepEqual(validateLeadStatusFields('Some Custom Status', {}), [], 'a custom dictionary value adds no requirement');
  });

  it('C. missing, blank and zero all fail; valid values pass', () => {
    // Follow-up Set
    assert.equal(validateLeadStatusFields('Follow-up Set', {}).length, 1);
    assert.equal(validateLeadStatusFields('Follow-up Set', { nextFollowUpDate: '' }).length, 1);
    assert.equal(validateLeadStatusFields('Follow-up Set', { nextFollowUpDate: '   ' }).length, 1);
    assert.equal(validateLeadStatusFields('Follow-up Set', { nextFollowUpDate: '2026-10-20T10:00:00.000Z' }).length, 0);

    // Meeting Fixed
    assert.equal(validateLeadStatusFields('Meeting Fixed', { meetingDate: null }).length, 1);
    assert.equal(validateLeadStatusFields('Meeting Fixed', { meetingDate: '2026-10-20T10:00:00.000Z' }).length, 0);

    // Proposal Sent / Converted — numbers must be real amounts
    const proposal = validateLeadStatusFields('Proposal Sent', { productName: 'SCEP' });
    assert.deepEqual(proposal.map(v => v.field), ['sumAssured', 'projectedNCP']);
    assert.equal(validateLeadStatusFields('Proposal Sent', { productName: 'SCEP', sumAssured: '0', projectedNCP: 0 }).length, 2, 'zero is not a premium');
    assert.equal(validateLeadStatusFields('Proposal Sent', { productName: 'SCEP', sumAssured: -1, projectedNCP: -1 }).length, 2);
    assert.equal(validateLeadStatusFields('Proposal Sent', { productName: 'SCEP', sumAssured: 'abc', projectedNCP: 10 }).length, 1);
    assert.equal(validateLeadStatusFields('Proposal Sent', { productName: 'SCEP', sumAssured: '500000', projectedNCP: 25000 }).length, 0, 'numeric strings are accepted (that is what JSON forms send)');
    assert.equal(validateLeadStatusFields('Converted', { productName: 'SCEP', sumAssured: 500000, collectedNCP: 30000 }).length, 0);

    // Not Interested
    assert.equal(validateLeadStatusFields('Not Interested', {}).length, 1);
    assert.equal(validateLeadStatusFields('Not Interested', { lossReason: '   ' }).length, 1);
    assert.equal(validateLeadStatusFields('Not Interested', { lossReason: 'Price' }).length, 0);
  });

  it('D. every violation names the field, the label and the status', () => {
    const violations = validateLeadStatusFields('Converted', {});
    assert.equal(violations.length, 3);
    for (const v of violations) {
      assert.ok(v.field && v.label && v.message, 'a violation must be actionable');
      assert.match(v.message, /Converted/, 'the message must say which status triggered it');
    }
    const message = leadStatusViolationMessage(violations);
    assert.match(message, /Product/);
    assert.match(message, /Sum Assured/);
    assert.match(message, /Collected FYCP/);
    // A single violation reads as one clean sentence for the UI toast.
    assert.equal(
      leadStatusViolationMessage(validateLeadStatusFields('Not Interested', {})),
      'Loss reason is required when the status is "Not Interested".'
    );
    assert.equal(leadStatusViolationMessage([]), '');
  });

  it('E. the primitives behave (blank / number parsing is shared by both sides)', () => {
    assert.equal(isBlank(undefined), true);
    assert.equal(isBlank(null), true);
    assert.equal(isBlank('  '), true);
    assert.equal(isBlank(0), false, 'zero is a value; the POSITIVE rule rejects it separately');
    assert.equal(requireNumber('', 'positive'), 'missing');
    assert.equal(requireNumber('12.5', 'positive'), null);
    assert.equal(requireNumber('0', 'positive'), 'zero');
    assert.equal(requireNumber('-3', 'positive'), 'zero');
    assert.equal(requireNumber('abc', 'finite'), 'invalid');
    assert.equal(normalizeStatusKey('Follow-up Set'), 'followupset');
  });

  it('F. server wiring: the endpoint enforces the table BEFORE it writes', () => {
    const route = read('server/routes/production.routes.ts');
    const start = route.indexOf("router.post('/leads/:id/follow-up'");
    assert.ok(start > 0, 'the follow-up endpoint must exist');
    const handler = route.slice(start, start + 12000);
    const enforcement = handler.indexOf('validateLeadStatusFields(');
    const firstWrite = Math.min(
      ...['INSERT INTO lead_activities', 'UPDATE leads', 'insertLeadActivity', 'pool.query(`UPDATE']
        .map(marker => handler.indexOf(marker))
        .filter(index => index > -1),
    );
    assert.ok(enforcement > -1, 'the endpoint must call the shared validator');
    assert.ok(firstWrite > -1, 'sanity: the handler does write');
    assert.ok(enforcement < firstWrite, 'validation must run before any write');

    // The body carries the machine-readable list as well as the sentence, so
    // a non-UI caller can map errors back to its own fields.
    assert.match(handler.slice(enforcement - 400, enforcement + 1200), /errors: violations/);
    // And the Next Action shortcut is resolved server-side.
    assert.match(handler, /resolveNextActionStatus\(rawNextAction\)/);
    assert.ok(read('server/utils/leadStatusRules.ts').includes("Next Action choices offered once a lead is marked Interested".replace('Next Action', 'Next Action')), 'the server wrapper documents the mapping');
  });

  it('G. client parity: the form shows exactly what the server enforces', () => {
    const form = read('src/modules/leads/pages/LeadUpdate.tsx');
    assert.ok(form.includes("from '../utils/leadStatusRules'"), 'the form must import the shared table');
    assert.ok(form.includes('validateLeadStatusFields(effectiveStatus'), 'the form must run the shared validation');
    // The old hand-written per-status checks must be gone (they could drift).
    assert.ok(!/if \(needsProposalFields\) \{/.test(form), 'no duplicated Proposal Sent checks');
    assert.ok(!/if \(needsConvertedFields\) \{/.test(form), 'no duplicated Converted checks');
    assert.ok(!/if \(needsLossReason && !lossReason\)/.test(form), 'no duplicated loss-reason check');
    // The Next Action gate stays a client affordance (it is a shortcut, not a rule).
    assert.ok(form.includes("if (needsNextAction && !nextAction) e.nextAction = t('updErrNextAction');"));

    // Shared module hygiene: no React, no API layer — importable from Node.
    const rules = read('src/modules/leads/utils/leadStatusRules.ts');
    assert.ok(!/from 'react'/.test(rules), 'the rule table must stay framework-free');
    assert.ok(!/services\//.test(rules), 'the rule table must not reach into the API layer');
  });
});
