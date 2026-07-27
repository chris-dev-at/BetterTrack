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
 * credential check).
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

/**
 * Keep the decision and every state mutation in one Redis script. `consume()` is
 * called concurrently by requests that may land on different API replicas, so a
 * process-local queue (or a sequence of ordinary Redis commands) would allow two
 * requests to both cross the allowance boundary. Redis executes one script at a
 * time, which gives each overflow window exactly one transition. `EVAL` is also
 * implemented by the in-memory ioredis-mock used by the API test suite.
 */
const CONSUME_SCRIPT = `
local cooldown = redis.call('TTL', KEYS[1])
local level = tonumber(redis.call('GET', KEYS[3]) or '0')
if not level or level <= 0 then
  level = 0
end

if cooldown > 0 then
  return { 0, cooldown, level }
end

local count = redis.call('INCR', KEYS[2])
if count == 1 then
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end

if count <= tonumber(ARGV[2]) then
  return { 1, 0, level }
end

local rungCount = tonumber(ARGV[4])
local rungIndex = math.min(level + 1, rungCount)
local retryAfterSec = tonumber(ARGV[4 + rungIndex])
local nextLevel = math.min(level + 1, rungCount)

redis.call('SET', KEYS[1], '1', 'EX', retryAfterSec)
redis.call('SET', KEYS[3], tostring(nextLevel), 'EX', ARGV[3])
redis.call('DEL', KEYS[2])

return { 0, retryAfterSec, nextLevel }
`;

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

  return {
    async consume(id) {
      const k = keys(id);
      const result = (await redis.eval(
        CONSUME_SCRIPT,
        3,
        k.cooldown,
        k.count,
        k.level,
        schedule.windowSec,
        schedule.limit,
        schedule.decaySec,
        schedule.cooldownsSec.length,
        ...schedule.cooldownsSec,
      )) as [number, number, number];
      const [allowed, retryAfterSec, level] = result;
      return { allowed: allowed === 1, retryAfterSec, level };
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
