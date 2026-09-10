/**
 * requestAuthz.ts — request-scoped authorization memo context.
 * ------------------------------------------------------------------
 * Lead endpoints resolve the same caller, permission codes and visibility
 * scope multiple times per request (e.g. DELETE /leads/:id resolves the
 * caller once in the guard and again in the handler; POST /leads checks
 * create/edit/assign/transfer permissions sequentially). This module
 * memoizes those lookups for the LIFETIME OF ONE HTTP REQUEST only.
 *
 * Safety rules (this is a security-adjacent module):
 * - The caller memo lives on the `req` object, which is unique per
 *   request. Permission/visibility results are memoized on the resolved
 *   CALLER object, which is itself created per request (and shared by
 *   reference only inside that request). No authorization result can ever
 *   leak across users or across requests — there is no process-wide or
 *   long-lived security cache.
 * - It only memoizes the results of the exact same fail-closed helpers
 *   the routes already call; the resolution logic itself is unchanged.
 * - A request never outlives its security decisions (decisions are
 *   re-derived for the next request).
 */

const CALLER_MEMO_KEY = Symbol.for('leadflow.requestCaller');

/** Per-request memo bucket. Non-enumerable so it never serializes. */
interface RequestMemo {
  callerPromise: Promise<unknown> | null;
}

export function getRequestMemo(req: any): RequestMemo | null {
  if (!req) return null;
  let memo: RequestMemo | undefined = req[CALLER_MEMO_KEY];
  if (!memo) {
    memo = { callerPromise: null };
    try {
      Object.defineProperty(req, CALLER_MEMO_KEY, {
        value: memo,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } catch {
      req[CALLER_MEMO_KEY] = memo;
    }
  }
  return memo;
}
