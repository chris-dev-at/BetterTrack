import type { Redis } from 'ioredis';

/**
 * Per-account login throttle/lockout Redis keys (PROJECTPLAN.md §6.1, §10).
 * Owned here so both the auth service (which sets them) and the admin service
 * (which clears them on password reset / re-enable) share one definition —
 * the key format never drifts between writer and clearer.
 */
export const failCountKey = (userId: string) => `login_fail:${userId}`;
export const failHourKey = (userId: string) => `login_fail_hour:${userId}`;
export const lockKey = (userId: string) => `login_lock:${userId}`;

/**
 * Consecutive-failure counter for the PIN gate (§6.1). Kept separate from the
 * password counters above: five wrong PINs in a row drop the user back to full
 * login (the session is destroyed), so the gate can never be a lighter-weight
 * bypass of password brute-force protection.
 */
export const pinFailCountKey = (userId: string) => `pin_fail:${userId}`;

/** Wrong PINs in a row before the gate falls back to a full login (§6.1). */
export const PIN_FALLBACK_THRESHOLD = 5;

/**
 * Drop all failed-login / lockout state for a user so they can authenticate
 * immediately. Called on successful login, admin password reset, and re-enable.
 * Includes the PIN counter so a successful login also clears any pending
 * PIN-fallback tally.
 */
export const clearLoginThrottle = (redis: Redis, userId: string): Promise<number> =>
  redis.del(failCountKey(userId), failHourKey(userId), lockKey(userId), pinFailCountKey(userId));
