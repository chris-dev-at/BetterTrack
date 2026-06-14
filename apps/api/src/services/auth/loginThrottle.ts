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
 * Drop all failed-login / lockout state for a user so they can authenticate
 * immediately. Called on successful login, admin password reset, and re-enable.
 */
export const clearLoginThrottle = (redis: Redis, userId: string): Promise<number> =>
  redis.del(failCountKey(userId), failHourKey(userId), lockKey(userId));
