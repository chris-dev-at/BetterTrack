import type { Redis } from 'ioredis';

/**
 * Progressive rate limiter (PROJECTPLAN.md §10, owner directive #79 "PROBLEM RATE
 * LIMIT"). Replaces the old fixed-window blocks: a well-behaved caller counts
 * against a generous steady-state allowance and never notices; the first
 * over-limit is a *short* cooldown, and only *repeated* violations escalate up an
 * ever-longer ladder. Escalation decays after a quiet period so a one-off burst
 * never leaves a caller in the penalty box for long.
 *
 * The primitive is deliberately transport-agnostic and I/O-only-on-Redis so it
 * can drive both request-rate limiting (HTTP middleware, one {@link consume} per
 * request) and failure tracking (the auth service, one {@link consume} per failed
 * credential check). It uses plain Redis commands — no Lua — so it runs unchanged
 * on the in-memory ioredis-mock the API test suite uses.
 */
export interface ProgressiveSchedule {
  /** Steady-state counting window, in seconds. */
  windowSec: number;
  /** Events allowed per window before a violation trips a cooldown. */
  limit: number;
  /**
   * Escalation ladder, in seconds. Index 0 is the first-violation cooldown; each
   * further violation (before the level decays) climbs one rung, capping at the
   * last entry. Must be non-empty.
   */
  cooldownsSec: readonly number[];
  /**
   * How long a caller must go without a violation before its escalation level
   * decays back to zero (§10 — "decays after ~15 min of good behavior").
   */
  decaySec: number;
}

export interface ProgressiveDecision {
  /** Whether the caller may proceed. */
  allowed: boolean;
  /** Seconds until the caller may retry; `0` when allowed. */
  retryAfterSec: number;
  /** Current escalation level (0 = clean; grows per violation, decays when quiet). */
  level: number;
}

export interface ProgressiveLimiter {
  /**
   * Count one event and decide. On steady-state traffic this just increments a
   * window counter; the event that overflows the window trips (or escalates) a
   * cooldown and returns `allowed: false` with the ladder duration.
   */
  consume(id: string): Promise<ProgressiveDecision>;
  /**
   * Read-only: seconds of cooldown remaining for `id` without counting anything.
   * Used to reject a caller that is already cooling down *before* doing expensive
   * work (e.g. the auth service checks this before verifying a password).
   */
  peek(id: string): Promise<number>;
  /** Clear all limiter state for `id` (e.g. on a successful login). */
  reset(id: string): Promise<void>;
}

const asLevel = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The three Redis keys a limiter uses for one `id` under `namespace`. */
export const progressiveKeys = (namespace: string, id: string) => ({
  cooldown: `rl:${namespace}:${id}:cd`,
  count: `rl:${namespace}:${id}:n`,
  level: `rl:${namespace}:${id}:lvl`,
});

/**
 * Clear a caller's limiter state without needing a schedule instance — used by
 * code that only ever resets (e.g. an admin clearing a locked account) so the key
 * layout stays defined in exactly one place.
 */
export async function resetProgressiveLimiter(
  redis: Redis,
  namespace: string,
  id: string,
): Promise<void> {
  const keys = progressiveKeys(namespace, id);
  await redis.del(keys.cooldown, keys.count, keys.level);
}

/**
 * Build a limiter over one Redis connection and `schedule`. `namespace` keeps
 * independent limiters (login-per-ip vs login-per-account vs general vs search)
 * from colliding — their counters, cooldowns and levels never share a key.
 */
export function createProgressiveLimiter(
  redis: Redis,
  namespace: string,
  schedule: ProgressiveSchedule,
): ProgressiveLimiter {
  if (schedule.cooldownsSec.length === 0) {
    throw new Error(`Progressive schedule "${namespace}" needs at least one cooldown rung.`);
  }
  const keys = (id: string) => progressiveKeys(namespace, id);
  const lastRung = schedule.cooldownsSec.length - 1;

  return {
    async consume(id) {
      const k = keys(id);
      // Already cooling down: reject without counting so blocked retries don't
      // themselves escalate the level — escalation only happens when a *fresh*
      // window overflows after the previous cooldown has elapsed.
      const cooling = await redis.ttl(k.cooldown);
      if (cooling > 0) {
        return { allowed: false, retryAfterSec: cooling, level: asLevel(await redis.get(k.level)) };
      }

      const count = await redis.incr(k.count);
      if (count === 1) await redis.expire(k.count, schedule.windowSec);

      if (count <= schedule.limit) {
        return { allowed: true, retryAfterSec: 0, level: asLevel(await redis.get(k.level)) };
      }

      // Violation: pick this level's rung, arm the cooldown, bump-and-refresh the
      // decaying level, and reset the window so a fresh allowance starts once the
      // cooldown clears.
      const level = asLevel(await redis.get(k.level));
      // `rung` is clamped to a valid index and the ladder is non-empty (checked
      // at construction), so the lookup is always defined.
      const retryAfterSec = schedule.cooldownsSec[Math.min(level, lastRung)]!;
      const nextLevel = Math.min(level + 1, schedule.cooldownsSec.length);

      await redis.set(k.cooldown, '1', 'EX', retryAfterSec);
      await redis.set(k.level, String(nextLevel), 'EX', schedule.decaySec);
      await redis.del(k.count);

      return { allowed: false, retryAfterSec, level: nextLevel };
    },

    async peek(id) {
      const cooling = await redis.ttl(keys(id).cooldown);
      return cooling > 0 ? cooling : 0;
    },

    async reset(id) {
      await resetProgressiveLimiter(redis, namespace, id);
    },
  };
}
