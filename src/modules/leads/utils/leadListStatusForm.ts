import { validateLeadStatusFields } from './leadStatusRules';
import type { RequiredFieldViolation } from '../../shared/utils/statusFieldRules';

/**
 * leadListStatusForm.ts
 * ------------------------------------------------------------------
 * FIX-1 — the Leads-page update modal (LeadList.tsx) now derives its
 * conditional fields from the SAME rule table the server enforces
 * (`leadStatusRules.ts`, F6), exactly like LeadUpdate.tsx does.
 *
 * The modal used to hardcode its own field list and had NO loss-reason
 * field at all, so "Not Interested" from the Leads page ALWAYS failed
 * on the server with a bare "Failed to update lead status" toast —
 * the agent could never learn why. This module is the modal's single
 * source of truth for:
 *
 *   - the EFFECTIVE status (the modal's "Meeting Completed" step is a
 *     UI shortcut that resolves to its sub-status, mirroring the
 *     existing behaviour);
 *   - rule-table validation of the effective status (the caller
 *     toasts `leadStatusViolationMessage(violations)` and stops);
 *   - the exact argument set handed to `leadService.updateLeadStatus`
 *     (including the loss reason the old call never sent).
 *
 * Pure functions only — the modal keeps its React state and passes it
 * in, which is what makes the whole status walk testable.
 */

export interface LeadListStatusFormState {
  /** Status chosen in the modal's Target Status select (may be 'Meeting Completed'). */
  formStatus: string;
  /** Sub-status for 'Meeting Completed' ('Pipeline Locked' | 'Not Interested' | ''). */
  formSubStatus: string;
  formNextFollowUpDate: string;
  formNextCallDate: string;
  formMeetingDate: string;
  formProductName: string;
  formSumAssured: number;
  formProjectedNCP: number;
  formCollectedNCP: number;
  formLossReason: string;
}

/** The status that will actually be persisted for this form state. */
export function effectiveLeadListStatus(state: Pick<LeadListStatusFormState, 'formStatus' | 'formSubStatus'>): string {
  if (state.formStatus === 'Meeting Completed') return state.formSubStatus || '';
  return state.formStatus || '';
}

/** The rule-table payload view of the form, keyed by API field name. */
export function leadListStatusRulePayload(
  state: LeadListStatusFormState,
  remarks?: string,
): Record<string, unknown> {
  return {
    nextFollowUpDate: state.formNextFollowUpDate || undefined,
    meetingDate: state.formMeetingDate || undefined,
    productName: state.formProductName || undefined,
    sumAssured: state.formSumAssured > 0 ? state.formSumAssured : undefined,
    projectedNCP: state.formProjectedNCP > 0 ? state.formProjectedNCP : undefined,
    collectedNCP: state.formCollectedNCP > 0 ? state.formCollectedNCP : undefined,
    lossReason: state.formLossReason || undefined,
    note: remarks || undefined,
  };
}

/**
 * Validate the form against the shared F6 rule table for the
 * EFFECTIVE status. Empty result = the server will accept the fields
 * (the modal's own extras — mandatory remarks, the No Response call
 * date, the follow-up date for Interested/Busy — stay enforced by the
 * modal itself, as before).
 */
export function validateLeadListStatusForm(
  state: LeadListStatusFormState,
): RequiredFieldViolation[] {
  const effective = effectiveLeadListStatus(state);
  if (!effective) return [];
  return validateLeadStatusFields(effective, leadListStatusRulePayload(state));
}

export interface LeadListFollowUpArgs {
  status: string;
  ncp?: number;
  remarks?: string;
  nextFollowUpDate?: string;
  nextCallDate?: string;
  meetingDate?: string;
  sumAssured?: number;
  productName?: string;
  projectedNCP?: number;
  lossReason?: string;
}

/**
 * Build the `leadService.updateLeadStatus` arguments for the form, in
 * the modal's long-standing semantics:
 *   - Follow-up Set / Interested / Busy carry the next follow-up date;
 *   - No Response carries the next call date; Meeting Fixed the
 *     meeting date (both keyed on the CHOSEN status, as before);
 *   - Pipeline Locked (incl. via Meeting Completed), Proposal Sent
 *     and Converted carry product + sum assured (+ projected FYCP for
 *     the first two, collected FYCP as `ncp` for Converted);
 *   - Not Interested (direct or via Meeting Completed) carries the
 *     loss reason — the field whose absence broke this path (FIX-1).
 */
export function buildLeadListFollowUpArgs(
  state: LeadListStatusFormState,
  remarks: string,
): LeadListFollowUpArgs {
  const finalStatus = effectiveLeadListStatus(state);
  const isPipelineLocked =
    finalStatus === 'Pipeline Locked';
  const isProposalSent = finalStatus === 'Proposal Sent';
  const isConverted = finalStatus === 'Converted';
  const isNotInterested = finalStatus === 'Not Interested';

  return {
    status: finalStatus,
    ncp: isConverted ? state.formCollectedNCP : undefined,
    remarks,
    nextFollowUpDate:
      finalStatus === 'Follow-up Set' || finalStatus === 'Interested' || finalStatus === 'Busy'
        ? state.formNextFollowUpDate || undefined
        : undefined,
    nextCallDate: state.formStatus === 'No Response' ? state.formNextCallDate || undefined : undefined,
    meetingDate: state.formStatus === 'Meeting Fixed' ? state.formMeetingDate || undefined : undefined,
    sumAssured: isPipelineLocked || isProposalSent || isConverted ? state.formSumAssured : undefined,
    productName: isPipelineLocked || isProposalSent || isConverted ? state.formProductName || undefined : undefined,
    projectedNCP: isPipelineLocked || isProposalSent ? state.formProjectedNCP : undefined,
    lossReason: isNotInterested ? state.formLossReason || undefined : undefined,
  };
}
