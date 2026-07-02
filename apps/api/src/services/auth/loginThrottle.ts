import type { Redis } from 'ioredis';

import { resetProgressiveLimiter } from '../security/progressiveLimiter';

/**
 * Per-account progressive login throttle (PROJECTPLAN.md §6.1, §10). The auth
 * service tracks failed logins per account with a {@link createProgressiveLimiter}
 * under this namespace — independent of the per-IP counter the HTTP middleware
 * keeps. Owned here so both the auth service (which drives it) and the admin
 * service (which clears it on password reset / re-enable) name the namespace once
 * and never drift.
 */
export const LOGIN_ACCOUNT_NAMESPACE = 'login_account';

/**
 * Consecutive-failure counter for the PIN gate (§6.1). Kept separate from the
 * login throttle above: five wrong PINs in a row drop the user back to full login
 * (the session is destroyed), so the gate can never be a lighter-weight bypass of
 * password brute-force protection. Session/PIN fallback mechanics are their own
 * P2 issue — this counter is left untouched by the progressive-limit rework.
 */
export const pinFailCountKey = (userId: string) => `pin_fail:${userId}`;

/** Wrong PINs in a row before the gate falls back to a full login (§6.1). */
export const PIN_FALLBACK_THRESHOLD = 5;

/**
 * Drop all per-account login-throttle and PIN-fallback state for a user so they
 * can authenticate immediately. Called on successful login, admin password reset,
 * and re-enable.
 */
export const clearLoginThrottle = async (redis: Redis, userId: string): Promise<void> => {
  await resetProgressiveLimiter(redis, LOGIN_ACCOUNT_NAMESPACE, userId);
  await redis.del(pinFailCountKey(userId));
};
