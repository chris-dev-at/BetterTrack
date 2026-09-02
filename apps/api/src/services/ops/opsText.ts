import { ADMIN_OPS_ERROR_MAX_LENGTH } from '@bettertrack/contracts';

import { redactString } from '../observability/scrubber';

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
 * Canonical UUIDs (v1–v5 and the nil UUID) anywhere in a string.
 *
 * A job failure very often names the row it failed on — "portfolio
 * 550e8400-… not found" — and that identifier is a user's object, not
 * diagnostic information. The operator needs to know WHICH QUEUE is failing and
 * WHY, which survives redaction intact. Deliberately not applied to the
 * projection's own `jobId` field: a BullMQ job id is our own scheduling handle,
 * not a user's object, and losing it would cost the operator the one thing that
 * makes two identical error strings distinguishable.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const REDACTED_ID = '[redacted-id]';

/**
 * Redact identifiers from a free-text operational string, then bound it.
 *
 * The cap is the CONTRACT's constant, so the wire limit and the schema's `.max()`
 * can never drift apart — the response would otherwise fail its own parse and
 * 500 the whole cockpit read on a long message.
 */
export function scrubOpsError(value: string): string {
  const redacted = redactString(value).replace(UUID_RE, REDACTED_ID);
  return redacted.length > ADMIN_OPS_ERROR_MAX_LENGTH
    ? `${redacted.slice(0, ADMIN_OPS_ERROR_MAX_LENGTH - 1)}…`
    : redacted;
}
