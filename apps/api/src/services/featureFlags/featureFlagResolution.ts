import { createHash } from 'node:crypto';

import type { FeatureFlagConfig, FeatureFlagKey } from '@bettertrack/contracts';

/**
 * Resolution of a runtime feature flag against ONE principal (#1910, §6.12,
 * §13.5 V5-P2 arc (c)).
 *
 * Deliberately pure and dependency-free: the service reads the configuration
 * (one cached Redis snapshot) and then resolves many principals against it
 * without another round trip — which is what keeps the realtime sweep at one
 * flag read per pass rather than one per socket.
 */

/**
 * Who a flag is being resolved for. Three kinds, all explicit, because the three
 * answers genuinely differ and an omitted argument would silently pick one:
 *
 * - `user` — an authenticated account id. The only kind that can be bucketed or
 *   listed, and the only one a percentage rollout means anything for.
 * - `anonymous` — a caller with no identity (the public `GET /feature-flags`
 *   bootstrap). A partially-rolled feature reads OFF: advertising a module that
 *   90 % of accounts would then get `404 FEATURE_DISABLED` from is worse than
 *   not advertising it.
 * - `system` — a server-side gate that HAS no principal and must not invent one:
 *   a scheduled job's producer shed, and the pre-authentication handshake check.
 *   It reads the base kill switch and nothing else, so a percentage can never
 *   silently halve a background sweep or refuse every socket.
 */
export type FeatureFlagPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'anonymous' }
  | { kind: 'system' };

/** The public bootstrap's caller before login. */
export const ANONYMOUS_PRINCIPAL: FeatureFlagPrincipal = { kind: 'anonymous' };

/** A server-side gate with no principal — jobs, and the pre-auth handshake. */
export const SYSTEM_PRINCIPAL: FeatureFlagPrincipal = { kind: 'system' };

/** A principal for one account id. */
export function userPrincipal(userId: string): FeatureFlagPrincipal {
  return { kind: 'user', userId };
}

/**
 * A principal from an optionally-present request/socket user. `null`/`undefined`
 * means "no identity on this request", which is `anonymous` — never `system`:
 * `system` bypasses the rollout, so defaulting to it would hand an unidentified
 * caller the fully-rolled answer.
 */
export function principalFromUserId(userId: string | null | undefined): FeatureFlagPrincipal {
  return typeof userId === 'string' && userId.length > 0
    ? userPrincipal(userId)
    : ANONYMOUS_PRINCIPAL;
}

/** Buckets a rollout can land in: 0..99, so the percentage is a direct compare. */
export const FEATURE_FLAG_BUCKET_COUNT = 100;

/**
 * The stable per-user rollout bucket: a deterministic `0..99` from
 * `(flagKey, userId)`.
 *
 * STABLE is the whole requirement. `Math.random()` per request would flip a user
 * between two requests and — worse — let the HTTP answer disagree with the
 * socket answer inside one session, so a user would see a surface the API then
 * refuses. This is a pure function of its two inputs: same pair ⇒ same bucket,
 * in this process, in the worker process, and after a restart.
 *
 * WHY SHA-256 rather than a cheap FNV/djb2: the two properties that matter are
 * cross-process stability (so no implementation-defined string hashing) and
 * avalanche (so `(chat, u)` and `(alerts, u)` are independent — two flags at
 * 10 % must not select the identical decile of users, which a weak mix over a
 * short prefix does). One hash costs ~1 µs and is computed at most once per
 * flag per request, never per row.
 *
 * The flag key is length-prefixed into the digest input rather than merely
 * concatenated, so no `(key, userId)` pair can collide with another by moving
 * the separator — `('a', 'b:c')` and `('a:b', 'c')` hash differently.
 *
 * Modulo bias: 2^32 is not a multiple of 100, so buckets 0..95 are reachable by
 * one more 32-bit value than 96..99 — a relative bias below 3e-8, i.e. far under
 * the sampling noise of any population this will ever run against.
 */
export function featureFlagBucket(key: FeatureFlagKey, userId: string): number {
  const digest = createHash('sha256').update(`${key.length}:${key}:${userId}`, 'utf8').digest();
  return digest.readUInt32BE(0) % FEATURE_FLAG_BUCKET_COUNT;
}

/**
 * Resolve one flag for one principal. The precedence is the contract's, in
 * order, and this is the ONLY place it is expressed:
 *
 *  1. `enabled === false` ⇒ OFF for everyone, allowlist included. Proven by a
 *     test that puts a user in `allowUserIds` and asserts they are refused.
 *  2. `denyUserIds` ⇒ OFF. Beats the allowlist and beats a 100 % rollout.
 *  3. `allowUserIds` ⇒ ON. Ignores the percentage.
 *  4. the stable bucket vs `rolloutPercent`.
 *
 * `bucket < rolloutPercent` makes the two ends exact rather than approximate:
 * `0` is OFF for every principal (no bucket is below 0) and `100` is ON for
 * every principal (every bucket is below 100).
 *
 * Privacy mode / paranoid status are deliberately NOT inputs here and must never
 * become one (§13.5): a flag that resolved differently for a paranoid account
 * would make that account's mode observable through feature behaviour.
 */
export function resolveFeatureFlag(
  config: FeatureFlagConfig,
  key: FeatureFlagKey,
  principal: FeatureFlagPrincipal,
): boolean {
  if (!config.enabled) return false;
  switch (principal.kind) {
    case 'system':
      // The base kill switch only — see the `system` note on the type.
      return true;
    case 'anonymous':
      // Fully rolled, or nothing. An allowlist that is non-empty means the
      // feature is targeted at named accounts, and an anonymous caller is not
      // one of them.
      return (
        config.rolloutPercent === FEATURE_FLAG_BUCKET_COUNT && config.allowUserIds.length === 0
      );
    case 'user': {
      if (config.denyUserIds.includes(principal.userId)) return false;
      if (config.allowUserIds.includes(principal.userId)) return true;
      return featureFlagBucket(key, principal.userId) < config.rolloutPercent;
    }
  }
}
