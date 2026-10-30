import type { Redis } from 'ioredis';

import { SELF_ISSUED_FACTOR_HOLD_HOURS } from '@bettertrack/contracts';

import { hashToken } from '../crypto/tokens';

/**
 * Which credential issued an account's newest second-factor material (R-05).
 *
 * The in-body step-up on the destructive account routes accepts a TOTP code or
 * a recovery code in place of the password. That is only a proof of a PRIOR
 * credential when the factor was not just minted by the very credential now
 * presenting it: a bearer that regenerates the recovery codes (or confirms a
 * TOTP) would otherwise turn "needs a second credential" into "needs nothing".
 * Cookie sessions are already safe by construction — every factor mint bumps
 * the security generation and destroys all sessions, the acting one included —
 * but bearers read the live generation and survive their own mint.
 *
 * So every factor mint records `(user, credential) → issuedAt`, and the
 * step-up routes refuse a factor-only credential from a credential whose record
 * is younger than {@link SELF_ISSUED_FACTOR_HOLD_HOURS}. The password always
 * works; other credentials are unaffected.
 *
 * Storage: one Redis hash per user, `field = credential key`, `value = epoch ms`.
 * The whole hash expires one hold window after its newest write; entries older
 * than the window are ignored on read. Idempotency key: (userId, credentialKey)
 * — a repeated mint by the same credential only moves its timestamp forward.
 * The record is written BEFORE the factor commit, so a Redis failure fails the
 * mint closed instead of minting an unrecorded factor. A lost record (Redis
 * flush) lets the hold lapse early; the per-route step-up still applies.
 */
export const SELF_ISSUED_FACTOR_HOLD_MS = SELF_ISSUED_FACTOR_HOLD_HOURS * 60 * 60 * 1000;

const issuedByKey = (userId: string) => `2fa_issued_by:${userId}`;

/**
 * The stable identity of the credential behind a request. A personal key is its
 * key row; an OAuth token is its GRANT (every install family of one consent
 * shares it); a cookie session is the hash of its id (never the raw id). Null
 * when the request carries no authenticated principal.
 */
export function stepUpCredentialKey(principal: {
  sessionId?: string;
  apiKey?: { id: string; kind: 'personal' | 'oauth' };
}): string | null {
  if (principal.apiKey) return `${principal.apiKey.kind}:${principal.apiKey.id}`;
  if (principal.sessionId) return `session:${hashToken(principal.sessionId)}`;
  return null;
}

/** Record that `credentialKey` just issued second-factor material for `userId`. */
export async function recordFactorIssuance(
  redis: Redis,
  userId: string,
  credentialKey: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const key = issuedByKey(userId);
  const results = await redis
    .multi()
    .hset(key, credentialKey, String(nowMs))
    .pexpire(key, SELF_ISSUED_FACTOR_HOLD_MS)
    .exec();
  // A MULTI that did not run (or a command inside it that failed) must not be
  // mistaken for a recorded issuance: the mint that follows would be unfenced.
  if (!results || results.some(([err]) => err)) {
    throw new Error('factor issuance could not be recorded');
  }
}

/** True when `credentialKey` issued factor material for `userId` inside the hold window. */
export async function issuedFactorRecently(
  redis: Redis,
  userId: string,
  credentialKey: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const raw = await redis.hget(issuedByKey(userId), credentialKey);
  if (raw === null) return false;
  const issuedAt = Number(raw);
  // An unreadable record fails closed: it can only have been written by us.
  if (!Number.isFinite(issuedAt)) return true;
  return nowMs - issuedAt < SELF_ISSUED_FACTOR_HOLD_MS;
}
