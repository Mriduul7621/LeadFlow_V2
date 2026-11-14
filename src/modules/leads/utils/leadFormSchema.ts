import * as z from 'zod';
import { FormField } from '../../shared/types';

/**
 * Builds the Zod validation schema for the Add Lead form dynamically from
 * the admin's Form Builder configuration.
 *
 * THE RULE (owner decision, 2026-11-11): the Form Builder "Required"
 * toggle (`isMandatory`) is the ONLY source of required-ness for a form
 * field. Conditional logic in this schema may decide WHEN a field applies
 * (e.g. Number of Children only applies when the marital status is not
 * Single), but it must NEVER make a field required on its own — a
 * conditional requirement is always ANDed with the field's Form Builder
 * flag. Before this rule was pinned, the children check below ignored the
 * flag entirely: Children was seeded `mandatory: false`, the admin had it
 * off, and the form still refused to save a Married lead without it.
 */
export function buildLeadSchema(fieldConfigMap: Record<string, FormField>) {
  const isMandatory = (key: string, fallback: boolean) =>
    fieldConfigMap[key] ? fieldConfigMap[key].isMandatory : fallback;

  const req = (key: string, fallback: boolean, message = 'Required') =>
    isMandatory(key, fallback) ? z.string().min(1, message) : z.string().optional().default('');

  return z.object({
    prospectName: z.string().min(3, 'Required'),
    mobile: z.string()
      .length(11, 'Mobile number must be exactly 11 digits')
      .refine(val => /^\d+$/.test(val), 'Mobile number must contain only numbers')
      .refine(val => val.startsWith('01'), 'Mobile number must start with 01'),
    profession: req('profession', true),
    occupation: req('occupation', false),
    priority: req('priority', false),
    maritalStatus: req('maritalStatus', true),
    noOfChildren: z.string().optional(),
    familyMember: req('familyMember', false),
    division: req('division', true),
    district: req('district', true),
    thana: req('thana', true),
    residenceAddress: req('residenceAddress', false),
    officeAddress: req('officeAddress', false),
    source: req('source', true),
    productName: req('productName', true),
    campaignName: req('campaignName', true),
    otherInfo: req('otherInfo', false),
    customFields: z.record(z.string(), z.string()).optional(),
  }).superRefine((data, ctx) => {
    // Conditional SHOW/APPLY rule: the children field only applies to
    // non-Single marital statuses (the form renders it only then). Whether
    // it is REQUIRED is the admin's Form Builder decision alone — see THE
    // RULE above. Fallback when no config row exists: not required (matches
    // the seed, form.seed.ts: noOfChildren mandatory: false).
    const childrenApplies = ['Married', 'Divorced', 'Widowed', 'Widow'].includes(data.maritalStatus);
    if (childrenApplies && isMandatory('noOfChildren', false)) {
      if (!data.noOfChildren || data.noOfChildren.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Number of children is required',
          path: ['noOfChildren'],
        });
      }
    }
  });
}
