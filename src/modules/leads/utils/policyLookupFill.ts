/**
 * policyLookupFill.ts — conversion auto-fill from a matched policy.
 * ------------------------------------------------------------------
 * Pure helpers for the PR-sync lookup (POST /api/leads/policy-lookup):
 * the server returns ONE matched policy; these map it onto the
 * Converted form fields. Kept pure (no React, no fetch) so the mapping
 * is unit-testable — the mapping is the contract Mahadi approved, so
 * it must not drift silently.
 *
 * Mapping (Due and Lapse Policy List = primary source):
 *   productName   <- Plan Name
 *   sumAssured    <- Sum Assured (blank for T-series — never 0)
 *   collectedNCP  <- Premium (M)
 *   term          <- Term
 *   payMode       <- Pay Mode
 *   policyNo      <- Policy No (stored as the matched reference)
 *   proposalNo    <- Proposal No (stored as the matched reference)
 */

/** One matched policy, as returned by POST /api/leads/policy-lookup. */
export interface MatchedPolicy {
  policyNo: string;
  proposalNo: string | null;
  productName: string;
  sumAssured: number | null;
  collectedNCP: number | null;
  term: string | null;
  payMode: string | null;
  faCode: string | null;
  commDate: string | null;
  source: 'due' | 'pr-database';
  isTermPolicy: boolean;
  /**
   * 064: the lead assignee's STORED IDRA FA Code, resolved by the
   * server from the assigneeEmployeeId sent with the lookup. Null
   * when no assignee was sent or the assignee has no code stored —
   * the mismatch check then stays silent (nothing to compare).
   */
  assigneeFaCode?: string | null;
}

/** The Converted form fields a matched policy fills (string form state). */
export interface PolicyMatchFormValues {
  productName: string;
  /** '' when the policy has no sum assured (T-series) — never '0'. */
  sumAssured: string;
  collectedNCP: string;
  term: string;
  payMode: string;
  policyNo: string;
  proposalNo: string;
}

const num = (value: number | null): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '' : String(value);

export function policyMatchToConvertedFields(matched: MatchedPolicy): PolicyMatchFormValues {
  return {
    productName: matched.productName || '',
    sumAssured: num(matched.sumAssured),
    collectedNCP: num(matched.collectedNCP),
    term: matched.term || '',
    payMode: matched.payMode || '',
    policyNo: matched.policyNo || '',
    proposalNo: matched.proposalNo || '',
  };
}

/**
 * Soft FA check: the sheet's FA Code vs the lead assignee's STORED
 * IDRA FA Code (064 — the server resolves it from the assignee's
 * Employee ID and returns it as MatchedPolicy.assigneeFaCode).
 * DSF staff sell under their FA code, so comparing against the
 * Employee ID warned on every correct conversion. A mismatch is a
 * NON-BLOCKING amber note only — the two systems may disagree, so
 * this can never refuse a save. Returns false when either side is
 * missing (nothing to compare — in particular when the assignee has
 * no FA code stored yet).
 */
export function isFaMismatch(faCode: string | null | undefined, assigneeFaCode: string | null | undefined): boolean {
  const a = String(faCode ?? '').trim().toLowerCase();
  const b = String(assigneeFaCode ?? '').trim().toLowerCase();
  if (!a || !b) return false;
  return a !== b;
}
