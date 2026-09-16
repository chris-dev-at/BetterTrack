import { ApiError } from '../../../lib/apiClient';

/**
 * Which of the two §15 answers a step-up-gated call came back with, and the
 * message key that says so (#2028).
 *
 * A gated call refuses in exactly two ways the owner can act on:
 *
 *   • the credential was not accepted — a generic 401 that never names the
 *     wrong factor, which the dialog answers by keeping its entry open; and
 *   • `429 RATE_LIMITED`, which means the call was never judged at all.
 *
 * Before this existed, every §15 dialog but `ConnectionsPanel` collapsed the
 * second into the first. That is worse than merely unhelpful: an owner holding
 * a CORRECT credential is told it is wrong, re-enters it, and drives the
 * per-account progressive throttle deeper on every attempt — the exact failure
 * §15's own backoff is there to slow down.
 *
 * ## Why the copy may not name the limiter
 *
 * Two limiters emit `RATE_LIMITED` on these routes: the §15 per-account
 * progressive step-up throttle, and the module's own route limiter. They are
 * reached at different points — the route limiter before the credential is
 * examined, the step-up throttle only once the credential path is entered — so
 * naming which one fired would tell an attacker whether their request got as
 * far as being judged. §15 therefore requires them to be INDISTINGUISHABLE at
 * the surface, and the copy these keys point at says only "too many attempts,
 * wait".
 *
 * For the same reason `ApiError.retryAfterSeconds` is deliberately NOT rendered
 * even though the server sends `Retry-After`: the route limiter's window is
 * fixed while the step-up throttle's grows per failure, so a countdown IS the
 * disclosure, spelled in numbers. The owner loses a precise deadline; that is
 * the accepted trade (the same one `ConnectionsPanel` made in #1999).
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
  return cause instanceof ApiError && cause.code === 'RATE_LIMITED';
}

/**
 * The message key a §15 dialog should render for `cause`: `throttled` for a
 * 429, `refused` for everything else.
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
