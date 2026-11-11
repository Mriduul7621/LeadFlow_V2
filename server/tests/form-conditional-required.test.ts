/**
 * Form Builder conditional-required rule (owner report, 2026-11-11).
 *
 * Bug: in the Add Lead form, selecting a Marital Status other than Single
 * made Children mandatory even though the admin had NOT set Children as
 * Required in Settings > Form Builder.
 *
 * Diagnosed mechanism: `src/modules/leads/pages/LeadGenerate.tsx` (pre-fix
 * lines 66-78) — the Zod schema's `.superRefine` hardcoded
 * `['Married','Divorced','Widowed','Widow'].includes(maritalStatus) &&
 * children empty -> "Number of children is required"` WITHOUT consulting
 * `fieldConfigMap.noOfChildren.isMandatory`. The seed was innocent
 * (form.seed.ts: noOfChildren mandatory: false — pinned below), and the
 * server never validated children at all (leads.routes.ts just passes
 * `noOfChildren || null` through — pinned below).
 *
 * Fix: the schema builder moved to `src/modules/leads/utils/
 * leadFormSchema.ts`, where the conditional rule is ANDed with the Form
 * Builder flag — the flag is the ONLY source of required-ness; conditional
 * logic only decides WHEN a field applies. The label asterisk in
 * LeadGenerate now follows the flag too (same pattern as familyMember).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLeadSchema } from '../../src/modules/leads/utils/leadFormSchema';
import type { FormField } from '../../src/modules/shared/types';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const field = (fieldKey: string, isMandatory: boolean): FormField => ({
  id: `id-${fieldKey}`,
  fieldKey,
  label: fieldKey,
  fieldType: 'text',
  section: 'Identity',
  isMandatory,
  isVisible: true,
  sortOrder: 0,
  isSystem: true,
});

/** A payload that satisfies every OTHER rule, so only the children rule can fail it. */
const validPayload = (overrides: Record<string, string> = {}) => ({
  prospectName: 'Test Person',
  mobile: '01712345678',
  profession: 'Service',
  occupation: '',
  priority: '',
  maritalStatus: 'Married',
  noOfChildren: '',
  familyMember: '',
  division: 'Dhaka',
  district: 'Dhaka',
  thana: 'Tejgaon',
  residenceAddress: '',
  officeAddress: '',
  source: 'Walk-in',
  productName: 'Endowment',
  campaignName: 'General',
  otherInfo: '',
  ...overrides,
});

const childrenIssue = (result: any) =>
  result.success ? null : result.error.issues.find((i: any) => i.path[0] === 'noOfChildren');

describe('conditional fields follow the Form Builder Required flag', () => {
  it("owner's case: Married + children empty + Children NOT Required -> saves", () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', false) });
    const result = schema.safeParse(validPayload({ maritalStatus: 'Married', noOfChildren: '' }));
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  it('every non-Single status behaves the same when the flag is off', () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', false) });
    for (const maritalStatus of ['Married', 'Divorced', 'Widowed', 'Widow']) {
      const result = schema.safeParse(validPayload({ maritalStatus, noOfChildren: '' }));
      assert.equal(result.success, true, `${maritalStatus} should save with the flag off`);
    }
  });

  it('no config row at all -> fallback is NOT required (matches the seed)', () => {
    const schema = buildLeadSchema({});
    const result = schema.safeParse(validPayload({ maritalStatus: 'Widowed', noOfChildren: '' }));
    assert.equal(result.success, true);
  });

  it("admin's real setting honoured: Children Required + Married + empty -> refused", () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', true) });
    const result = schema.safeParse(validPayload({ maritalStatus: 'Married', noOfChildren: '' }));
    assert.equal(result.success, false);
    const issue = childrenIssue(result);
    assert.ok(issue, 'expected a noOfChildren issue');
    assert.equal(issue.message, 'Number of children is required');
  });

  it('Children Required + Married + a value -> saves', () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', true) });
    const result = schema.safeParse(validPayload({ maritalStatus: 'Married', noOfChildren: '2' }));
    assert.equal(result.success, true);
  });

  it('Children Required + Single -> still saves (the field is not shown for Single, so it cannot block)', () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', true) });
    const result = schema.safeParse(validPayload({ maritalStatus: 'Single', noOfChildren: '' }));
    assert.equal(result.success, true);
  });

  it('Single behaviour unchanged with the flag off', () => {
    const schema = buildLeadSchema({ noOfChildren: field('noOfChildren', false) });
    const result = schema.safeParse(validPayload({ maritalStatus: 'Single', noOfChildren: '' }));
    assert.equal(result.success, true);
  });
});

describe('the mechanism cannot come back', () => {
  it('LeadGenerate no longer carries its own conditional-required logic', () => {
    const page = read('../../src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(!page.includes('superRefine'), 'the page must not re-grow a superRefine');
    assert.ok(!page.includes('Number of children is required'));
    assert.ok(page.includes("from '../utils/leadFormSchema'"), 'page must use the shared schema builder');
  });

  it('the conditional rule in the schema builder is gated on isMandatory', () => {
    const util = read('../../src/modules/leads/utils/leadFormSchema.ts');
    const refineAt = util.indexOf('superRefine');
    assert.ok(refineAt > 0);
    const refineBody = util.slice(refineAt);
    assert.ok(refineBody.includes("isMandatory('noOfChildren', false)"),
      'the children condition must AND with the Form Builder flag');
  });

  it('the children label asterisk follows the flag (not hardcoded)', () => {
    const page = read('../../src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(page.includes('fieldConfigMap.noOfChildren?.isMandatory'),
      'label must show * only when the admin set Required');
    assert.ok(!page.includes('{t("numberOfChildren")} *'), 'hardcoded asterisk must stay gone');
  });

  it('server lead writes never required children (pass-through only)', () => {
    const routes = read('../routes/production/leads.routes.ts');
    assert.ok(!/children is required/i.test(routes));
    assert.ok(routes.includes('noOfChildren: lead.noOfChildren || null'));
  });

  it('the seed agrees with the owner: Children is NOT mandatory by default', () => {
    const seed = read('../database/seeds/form.seed.ts');
    const row = seed.split('\n').find(l => l.includes('"noOfChildren"'));
    assert.ok(row && row.includes('mandatory: false'), `seed row: ${row}`);
  });
});
