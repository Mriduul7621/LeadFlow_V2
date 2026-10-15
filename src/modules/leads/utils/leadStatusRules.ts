import {
  isBlank,
  normalizeStatusKey,
  requireNumber,
  type RequiredFieldViolation,
} from '../../shared/utils/statusFieldRules.js';

/**
 * leadStatusRules.ts
 * ------------------------------------------------------------------
 * F6 — the per-status conditional fields, as ONE specification consumed by
 * both sides of the wire.
 *
 * Field report: the "rules" lived only in the client (`LeadUpdate.tsx`
 * `validate()`), so any other caller — a script, a stale tab, the mobile
 * shell, curl — could move a lead to `Meeting Fixed` with no meeting date,
 * `Converted` with no sum assured, or `Not Interested` with no loss reason.
 * The behaviour was a UI convention, not a rule.
 *
 * The server now enforces the same table on `POST /api/leads/:id/follow-up`
 * (`enforceLeadStatusRules`), and `LeadUpdate.tsx` derives its messages from
 * it too, so they cannot drift.
 *
 * The status NAMES are the canonical FollowUpStatus dictionary values (an
 * admin can edit the dictionary, so every lookup here is by normalized key
 * and an unknown status simply has no extra requirement — the dictionary
 * check already rejected it).
 *
 * Note the one intentional difference of representation: the client sends
 * `nextFollowUpDate` because that is the field name the API accepts, while
 * `Follow-up Set` is what both surface as "Next Follow-Up date"; same for
 * `Meeting Fixed` → `meetingDate` (the client also mirrors the meeting onto
 * the Task Calendar — that is a UI side-effect, not a rule).
 */
export const FOLLOW_UP_SET = 'Follow-up Set';
export const MEETING_FIXED = 'Meeting Fixed';
export const PROPOSAL_SENT = 'Proposal Sent';
export const CONVERTED = 'Converted';
export const NOT_INTERESTED = 'Not Interested';

/** Human label of a field, used in the server's 400 message. */
export interface StageField {
  /** Canonical API field name (as the follow-up endpoint receives it). */
  field: string;
  /** Label the operator sees in the app. */
  label: string;
  /** True when the value must be a finite number. */
  numeric?: boolean;
  /** True when 0 is not an acceptable number (e.g. a collected premium). */
  positive?: boolean;
}

export interface StageRule {
  /** The dictionary status this rule applies to. */
  status: string;
  /** Fields that MUST be supplied and non-empty. */
  required: StageField[];
}

export const LEAD_STAGE_RULES: StageRule[] = [
  {
    status: FOLLOW_UP_SET,
    required: [
      { field: 'nextFollowUpDate', label: 'Next Follow-Up date & time' },
    ],
  },
  {
    status: MEETING_FIXED,
    required: [
      { field: 'meetingDate', label: 'Meeting date & time' },
    ],
  },
  {
    status: PROPOSAL_SENT,
    required: [
      { field: 'productName', label: 'Product' },
      { field: 'sumAssured', label: 'Sum Assured', numeric: true, positive: true },
      { field: 'projectedNCP', label: 'Projected FYCP', numeric: true, positive: true },
    ],
  },
  {
    status: CONVERTED,
    required: [
      { field: 'productName', label: 'Product' },
      { field: 'sumAssured', label: 'Sum Assured', numeric: true, positive: true },
      { field: 'collectedNCP', label: 'Collected FYCP', numeric: true, positive: true },
    ],
  },
  {
    status: NOT_INTERESTED,
    required: [
      { field: 'lossReason', label: 'Loss reason' },
    ],
  },
];

/** The rule for a status, matched on the dictionary spelling (case/space tolerant). */
export function ruleForLeadStatus(status: string): StageRule | undefined {
  const key = normalizeStatusKey(status);
  if (!key) return undefined;
  return LEAD_STAGE_RULES.find(rule => normalizeStatusKey(rule.status) === key);
}

/**
 * The single required-field check.
 *
 * @param status   the status being persisted (already resolved against the
 *                 dictionary — an unknown status never reaches this point)
 * @param payload  the normalized business fields of the request
 * @returns        every violation; empty means the update is allowed
 */
export function validateLeadStatusFields(
  status: string,
  payload: Record<string, unknown>,
): RequiredFieldViolation[] {
  const rule = ruleForLeadStatus(status);
  if (!rule) return [];

  const violations: RequiredFieldViolation[] = [];
  for (const field of rule.required) {
    const value = payload[field.field];

    if (field.numeric) {
      const problem = requireNumber(value, field.positive ? 'positive' : 'finite');
      if (problem === 'missing') {
        violations.push({
          field: field.field,
          label: field.label,
          message: `${field.label} is required when the status is "${rule.status}".`,
        });
      } else if (problem === 'invalid') {
        violations.push({
          field: field.field,
          label: field.label,
          message: `${field.label} must be a valid number.`,
        });
      } else if (problem === 'zero') {
        violations.push({
          field: field.field,
          label: field.label,
          message: `${field.label} must be greater than zero.`,
        });
      }
      continue;
    }

    if (isBlank(value)) {
      violations.push({
        field: field.field,
        label: field.label,
        message: `${field.label} is required when the status is "${rule.status}".`,
      });
    }
  }
  return violations;
}

/**
 * Server-side enforcement helper: the message for a 400 body.
 * Kept here (not in the route) so the wording is testable without a server.
 */
export function leadStatusViolationMessage(violations: RequiredFieldViolation[]): string {
  if (violations.length === 0) return '';
  if (violations.length === 1) return violations[0].message;
  return `${violations.map(v => v.message).join(' ')}`;
}
