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
 * Per-account wrong-second-factor throttle for the login 2FA challenge (§6.1,
 * §10, §13.2 V2-P5). Independent of the password-failure counter above and of the
 * per-IP request limiter the HTTP middleware keeps: a correct password that lands
 * on the 2FA step still gates code brute-forcing per account. Drives the same
 * {@link createProgressiveLimiter} with the `loginAccount` schedule.
 */
export const TWO_FACTOR_ACCOUNT_NAMESPACE = 'two_factor_account';

/**
 * Per-account brute-force throttle for bearer PIN verification (#361, §6.1, §10).
 * The session PIN gate (below) protects the cookie flow by destroying the
 * session after {@link PIN_FALLBACK_THRESHOLD} wrong PINs; a bearer request has
 * no session to drop, so the token PIN-verify endpoint gates a 4-digit PIN with
 * its own {@link createProgressiveLimiter} under this namespace instead —
 * independent of the per-IP HTTP limiter and of the session counter.
 */
export const PIN_TOKEN_ACCOUNT_NAMESPACE = 'pin_token_account';

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
 * Drop the per-account password-failure throttle and PIN-fallback state on a
 * correct password, WITHOUT touching the second-factor throttle. That 2FA
 * counter must survive a re-login so its §10 escalation lock accumulates across
 * challenges: a correct password is exactly what a 2FA-brute-forcing attacker
 * already holds, so if re-submitting it wiped the `two_factor_account` counter
 * the account lock would never accrue. The 2FA throttle is reset only on a
 * successful second-factor verify (and by {@link clearLoginThrottle} on admin
 * reset / re-enable, where a human has vouched for the account).
 */
export const clearPasswordThrottle = async (redis: Redis, userId: string): Promise<void> => {
  await resetProgressiveLimiter(redis, LOGIN_ACCOUNT_NAMESPACE, userId);
  await redis.del(pinFailCountKey(userId));
};

/**
 * Drop all per-account login-throttle state for a user — password-failure, PIN
 * fallback, AND the second-factor throttle — so they can authenticate
 * immediately. Called on a successful second-factor verify, admin password
 * reset, and re-enable. For a bare correct password (which still faces a 2FA
 * gate) use {@link clearPasswordThrottle} instead so the 2FA lock survives.
 */
export const clearLoginThrottle = async (redis: Redis, userId: string): Promise<void> => {
  await clearPasswordThrottle(redis, userId);
  await resetProgressiveLimiter(redis, TWO_FACTOR_ACCOUNT_NAMESPACE, userId);
};
