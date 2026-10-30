import { ApiError } from '../../../lib/apiClient';

/**
 * Which of the two §15 answers a step-up-gated call came back with, and the
 * message key that says so (#2028).
 *
 * A gated call refuses in exactly two ways the owner can act on:
 *
 *   • the credential was not accepted — a generic 401 that never names the
 *     wrong factor, which the dialog answers by keeping its entry open; and
 *   • a 429, which says nothing about whether THIS entry was right.
 *
 * The 429 is not always "never judged". On the attempt that trips the §15
 * step-up throttle the server did verify the credential, found it wrong,
 * consumed a failure, and answered 429 instead of 401 because that consume
 * crossed the limit. While the account is cooling, every verifier peeks the
 * throttle BEFORE verifying and refuses without consuming, so a correct
 * credential typed during the cooldown is neither judged nor counted — it
 * cannot deepen the ladder, and once the cooldown ends a correct entry resets
 * it. Either way the only honest reading of a 429 is "wait", never "wrong".
 *
 * Before this existed, every §15 dialog but `ConnectionsPanel` collapsed the
 * second answer into the first, so an owner holding a CORRECT credential was
 * told it was wrong — the harm #2028 names.
 *
 * ## Why the copy names neither the limiter nor the deadline
 *
 * Two limiters emit `RATE_LIMITED` on these routes: the §15 per-account
 * progressive step-up throttle and the module's own route limiter (also
 * progressive, on its own ladder). The copy these keys point at says only
 * "too many attempts, wait", and `ApiError.retryAfterSeconds` is deliberately
 * NOT rendered.
 *
 * That is a CONSISTENCY choice with `ConnectionsPanel` (#1999), not a secrecy
 * property: the two limiters are already distinguishable on the wire (the
 * route limiter sends a `Retry-After` header and its own message, the step-up
 * throttle only `details.retryAfter`), and anyone who can make the request can
 * read the raw response. The cost is the owner's precise deadline — on the
 * step-up ladder "wait a moment" can mean up to 15 minutes. Making the two
 * server 429s identical is a server change; until it lands, nothing here may
 * claim the surface hides which limiter fired.
 *
 * ## Why one helper
 *
 * Four dialogs, one rule. The three that got this wrong each had their own
 * shape — a message key, a boolean, a key plus a precondition branch — and a
 * per-dialog `error.code === 'RATE_LIMITED'` is three places for the fifth
 * gated dialog to be added without one. Callers name their two strings and get
 * the decision made for them.
 */
export function isStepUpThrottled(cause: unknown): boolean {
  // Keyed on the STATUS, with the code as a second spelling of the same fact.
  // A 429 without the JSON envelope (an edge or proxy limiter — production TLS
  // terminates at Cloudflare) parses to code `UNKNOWN`, and gated calls skip
  // the app-wide response policy, so a code-only check would hand that 429 the
  // credential-refusal line: the exact bug #2028 fixes. Every other 429 surface
  // in the app keys on status too (LoginPage, PinGate, DeleteAccountPage, the
  // toast in apiClient). On a gated route no 429 reads as anything but a wait.
  return cause instanceof ApiError && (cause.status === 429 || cause.code === 'RATE_LIMITED');
}

/**
 * The message key a §15 dialog should render for `cause`: `throttled` for any
 * 429 (enveloped or not), `refused` for everything else.
 *
 * `refused` is the fallback on purpose. A gated ceremony that fails for any
 * other reason — a network drop, a 500, a stale revision — has still not
 * happened, and the dialog's existing "nothing changed" line is the honest
 * thing to say. Only the throttle earns different words, because only the
 * throttle makes retrying NOW actively harmful.
 */
export function stepUpFailureCopy(
  cause: unknown,
  copy: { refused: string; throttled: string },
): string {
  return isStepUpThrottled(cause) ? copy.throttled : copy.refused;
}
