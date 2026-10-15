import {
  LEAD_STAGE_RULES,
  leadStatusViolationMessage,
  ruleForLeadStatus,
  validateLeadStatusFields,
} from '../../src/modules/leads/utils/leadStatusRules';

/**
 * leadStatusRules (server wrapper) — F6 enforcement.
 * ------------------------------------------------------------------
 * The rules themselves live in `src/modules/leads/utils/leadStatusRules.ts`
 * because the client form must show the same requirements it is judged by;
 * this module is the server's entry point so the route file stays readable
 * and the tests can import one stable path.
 *
 * Contract enforced on POST /api/leads/:id/follow-up:
 *   Follow-up Set   -> nextFollowUpDate
 *   Meeting Fixed   -> meetingDate            (+ mirrored to the calendar by the client)
 *   Proposal Sent   -> productName, sumAssured, projectedNCP
 *   Converted       -> productName, sumAssured, collectedNCP (all > 0)
 *   Not Interested  -> lossReason
 *
 * "Interested" is NOT one of them on purpose: it is a real dictionary status
 * that a lead can legitimately sit in, and the app's own history/tests treat
 * it that way. The Next Action the form asks for is simply a shortcut that
 * resolves Interested into the final status client-side — and, from this
 * release on, server-side too via `resolveNextActionStatus()`.
 */
export { LEAD_STAGE_RULES, ruleForLeadStatus, validateLeadStatusFields, leadStatusViolationMessage };

/** Next Action choices offered once a lead is marked Interested. */
export const NEXT_ACTION_CHOICES = [
  'Need Follow-Up',
  'Meeting Fixed',
  'Proposal Sent',
  'Not Interested',
] as const;

/**
 * Maps a Next Action to the status actually persisted.
 *
 * `Need Follow-Up` is a NEXT ACTION, not a status: the dictionary calls the
 * resulting state `Follow-up Set`. Mirrors `statusForNextAction()` in
 * `LeadUpdate.tsx`, so a caller that sends `{ status: 'Interested',
 * nextAction: 'Need Follow-Up' }` lands in exactly the same state as the UI.
 * Returns `null` when the value is not one of the four choices.
 */
export function resolveNextActionStatus(nextAction: unknown): string | null {
  const raw = String(nextAction == null ? '' : nextAction).trim();
  if (!raw) return null;
  const match = NEXT_ACTION_CHOICES.find(
    choice => choice.toLowerCase().replace(/[\s_-]+/g, '') === raw.toLowerCase().replace(/[\s_-]+/g, ''),
  );
  if (!match) return null;
  return match === 'Need Follow-Up' ? 'Follow-up Set' : match;
}
