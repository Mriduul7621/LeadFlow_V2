/**
 * lead-write-hygiene.test.ts
 * ------------------------------------------------------------------
 * Three small write-path defects from the review (F10–F12) that all share
 * one shape: the app quietly changed data the operator never chose.
 *
 *   F10 — the Update form pre-filled the follow-up AND meeting pickers with
 *         "now + 1 hour". Saving without touching them booked an appointment
 *         at a time nobody agreed to (and mirrored it onto the Task Calendar).
 *   F11 — `GET /api/leads` accepted `offset` and ignored it, so paging
 *         clients re-read page 1 forever.
 *   F12 — a manual lead that reused an existing mobile number silently
 *         UPDATED that lead while the UI said "Lead created successfully".
 *
 * The live proofs (a real database) live in the qa harness; this file pins
 * the source contracts so they cannot silently regress.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Lead write hygiene — F10 / F11 / F12', () => {
  it('F10. the update form never invents an appointment time (and says so)', () => {
    const form = read('src/modules/leads/pages/LeadUpdate.tsx');
    assert.ok(!/function defaultLocalDateTime/.test(form), 'the "now + 1 hour" default must be gone');
    assert.ok(!/Date\.now\(\) \+ 60 \* 60 \* 1000/.test(form), 'no invented instant may be built in the form');
    assert.ok(form.includes('function localDateTimeValue('), 'the form may only format a REAL instant');
    assert.ok(form.includes("const [followUpAt, setFollowUpAt] = useState('');"), 'the follow-up picker starts empty');
    assert.ok(form.includes("const [meetingAt, setMeetingAt] = useState('');"), 'the meeting picker starts empty');
    // …and it explains itself, because an empty required field needs a reason.
    assert.ok(form.includes('No time is assumed'), 'the operator must be told why the field is empty');
    assert.ok(form.includes('mirrored onto the Task Calendar'), 'the meeting hint must mention the calendar effect');
    // The real value is still surfaced when the lead has one.
    assert.ok(/const existing = \(fetched as any\)\.nextFollowUpDate/.test(form), 'an existing follow-up date is prefilled');
  });

  it('F10. a pre-existing follow-up is pre-filled from the SERVER value, not from the clock', () => {
    const form = read('src/modules/leads/pages/LeadUpdate.tsx');
    const fn = form.slice(form.indexOf('function localDateTimeValue('), form.indexOf('function localDateTimeValue(') + 700);
    assert.ok(!/Date\.now\(\)/.test(fn), 'the formatter must not read the clock');
    assert.ok(/Number\.isNaN\(d\.getTime\(\)\)/.test(fn), 'an unparseable server value yields an empty field, not a wrong time');
  });

  it('F11. GET /api/leads applies the requested offset, with a ceiling', () => {
    const route = read('server/routes/production.routes.ts');
    assert.ok(route.includes('const listOffset ='), 'the endpoint must compute an offset');
    assert.ok(/LIMIT \$\{listLimit\} OFFSET \$\{listOffset\}/.test(route), 'the SQL must carry the offset');
    assert.ok(route.includes('LIST_OFFSET_CEILING'), 'a hostile offset must be clamped');
    assert.ok(!/LIMIT \$\{listLimit\}`/.test(route), 'the old offset-less query must be gone');
    // The response shape is unchanged: the client still receives a bare array.
    assert.ok(route.includes('applyQualityListOptions(scored, req.query || {})'), 'the list response contract must not change');
  });

  it('F12. the server reports a mobile-number match instead of a silent overwrite', () => {
    const route = read('server/routes/production.routes.ts');
    assert.ok(route.includes("let matchedBy: 'leadCode' | 'mobile' | null = null;"), 'the match must be tracked');
    assert.ok(route.includes("if (existingLead) matchedBy = 'mobile';"), 'a phone match is recorded as such');
    assert.ok(route.includes('data: mappedLead, matchedBy }'), 'the response must carry the match');
    assert.ok(route.includes('data: lead, matchedBy }'), 'the demo path must carry it too');
    // The documented upsert itself must NOT become an error (case 11 in
    // lead-authz-integration asserts an owner may upsert the same mobile).
    assert.ok(!/409[\s\S]{0,80}DUPLICATE_LEAD/.test(route), 'the upsert contract stays a 200');
  });

  it('F12. the Add Lead screen tells the operator which of the two happened', () => {
    const page = read('src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(page.includes('onMatch: info => { matchedBy = info.matchedBy; }'), 'the page must consume the match info');
    assert.ok(/if \(matchedBy === 'mobile'\)/.test(page), 'a phone match must be handled separately');
    assert.ok(page.includes('already existed — that record was updated instead of creating a duplicate'), 'the warning must be explicit');
    assert.ok(page.includes("toast.success(t('leadCreatedSuccess'))"), 'a real creation still reports success');

    const service = read('src/modules/leads/services/leadService.ts');
    assert.ok(service.includes('apiRequestEnvelope<Lead>'), 'the service must read the envelope to see matchedBy');
    assert.ok(service.includes('options.onMatch?.('), 'the service must forward the match');
  });
});
