import { ADMIN_OPS_ERROR_MAX_LENGTH } from '@bettertrack/contracts';

import { REDACTED_ID, redactIdentifiers } from '../observability/scrubber';

/**
 * The single place free text is cleaned before it leaves the operations cockpit
 * (#1406 W4).
 *
 * Two strings on this surface originate outside our own code — a dead-lettered
 * job's `failedReason` and a tripped breaker's `lastError` — and both are error
 * messages, which is the category most likely to have swallowed something it
 * should not have. They get the same treatment the Problems page already gives
 * every captured message, plus a UUID pass and a hard length cap.
 *
 * Order matters: redact BEFORE truncating. Truncating first could cut a token
 * or an address in half and leave the readable half on screen, which is worse
 * than either alone — a half-token is still a lead, and a half-address still
 * identifies a person.
 */

/**
 * The identifier pass lives in the scrubber ({@link redactIdentifiers}, #1847),
 * because the Problems capture renders the same failure text and a second copy
 * here is exactly how the two surfaces came to disagree about one string. This
 * module keeps only its cap. Deliberately not applied to the projection's own
 * `jobId` field: a BullMQ job id is our own scheduling handle, not a user's
 * object, and losing it would cost the operator the one thing that makes two
 * identical error strings distinguishable.
 */
export { REDACTED_ID };

/**
 * Redact identifiers from a free-text operational string, then bound it.
 *
 * The cap is the CONTRACT's constant, so the wire limit and the schema's `.max()`
 * can never drift apart — the response would otherwise fail its own parse and
 * 500 the whole cockpit read on a long message.
 */
export function scrubOpsError(value: string): string {
  const redacted = redactIdentifiers(value);
  return redacted.length > ADMIN_OPS_ERROR_MAX_LENGTH
    ? `${redacted.slice(0, ADMIN_OPS_ERROR_MAX_LENGTH - 1)}…`
    : redacted;
}
