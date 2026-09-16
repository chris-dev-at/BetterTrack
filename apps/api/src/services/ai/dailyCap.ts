import type { Redis } from 'ioredis';

import { AiCapExceededError } from './errors';

/**
 * Per-user, per-UTC-day AI completion budget (PROJECTPLAN.md §13.5 V5-P12). A
 * plain Redis counter keyed by user + UTC day — NO new table/migration, as the
 * composer mandated. The counter self-cleans via a bounded TTL and the day-scoped
 * key rolls over naturally at UTC midnight.
 *
 * ## Both mutations are single round-trip Lua (#1656 defect 4)
 *
 * `consume` was already increment-first and therefore race-free on the limit
 * check, but `refund` was a GET-then-DECR across two round trips, and that is
 * not the same thing. Provider failures arrive in BURSTS (the Ollama box is
 * down, so every in-flight request fails at once): three concurrent refunds each
 * read the same positive value, each pass the `> 0` guard, and all three DECR.
 * The counter goes NEGATIVE, `parseCount` maps that to 0 on the way out, and the
 * user silently gets `limit + n` completions — drift that compounds every burst.
 *
 * So the read and the decrement are one script, and the floor is enforced inside
 * it. The idempotency contract this gives the caller: **one consumed unit may be
 * refunded at most once**, and a refund can never create budget that was not
 * spent, no matter how many callers race — a refund against a zero (or absent)
 * counter is a no-op rather than a credit. The call sites keep the other half of
 * that contract by refunding on exactly one path per consumed unit
 * (`aiService.complete`'s failure catch, or `aiFeaturesService`'s
 * unusable-output path — never both, because the second only runs after the
 * first returned successfully).
 *
 * The TTL is re-armed inside `consume` whenever the key has none, not only on
 * the first spend of the day. The old `next === 1` test was the only thing that
 * ever set it, so a counter that reached a TTL-less state (which the negative
 * drift above could produce) would have lived until it was evicted.
 */

export const AI_CAP_KEY_PREFIX = 'ai:cap:';
/** Key TTL — comfortably past a day so a spent counter self-expires. */
export const AI_CAP_TTL_SECONDS = 48 * 60 * 60;

/** The UTC calendar day (`YYYY-MM-DD`) a timestamp falls in. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function aiCapKey(userId: string, day: string): string {
  return `${AI_CAP_KEY_PREFIX}${userId}:${day}`;
}

/** Seconds from `now` until the next UTC midnight — the cap's reset horizon. */
export function secondsUntilUtcMidnight(now: Date): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}

export interface AiDailyCapDeps {
  redis: Redis;
  /** Injectable clock (tests). Defaults to the wall clock. */
  now?: () => Date;
}

export interface AiDailyCap {
  /** Completions the user has spent today (UTC). 0 when none. */
  usage(userId: string): Promise<number>;
  /**
   * Spend one completion against `limit`. Returns the new used/remaining counts,
   * or throws {@link AiCapExceededError} (with the reset horizon) when the user
   * is already at their limit — the increment is rolled back in that case so a
   * rejected call never counts.
   */
  consume(userId: string, limit: number): Promise<{ used: number; remaining: number }>;
  /**
   * Return one spent completion — used when a call fails (or its output turns
   * out unusable) after consuming.
   *
   * Idempotency key: the counter itself, `ai:cap:<userId>:<UTC day>`. The
   * operation floors at zero atomically, so it can never credit a unit that was
   * not spent; what it cannot do is tell two refunds of the SAME unit apart, so
   * each consumed unit must have exactly one refund site on its path.
   */
  refund(userId: string): Promise<void>;
}

/**
 * Spend one unit: increment, arm the TTL if the key has none, and roll the
 * increment back when it would exceed the limit — atomically, so a concurrent
 * reader never sees the transient over-count and a rejected call can never leave
 * the counter raised.
 *
 * Returns the new count, or `-1` when the limit is already spent.
 */
const CONSUME_SCRIPT = `
local next = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if next > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -1
end
return next
`;

/**
 * Return one spent unit, flooring at zero. Read and decrement in one atomic
 * step: concurrent refunds after a burst of provider failures cannot each see
 * the same positive value and all decrement past it.
 *
 * Returns the resulting count (0 when there was nothing to refund).
 */
const REFUND_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
return redis.call('DECR', KEYS[1])
`;

export function createAiDailyCap(deps: AiDailyCapDeps): AiDailyCap {
  const { redis } = deps;
  const now = deps.now ?? (() => new Date());

  function keyFor(userId: string, at: Date): string {
    return aiCapKey(userId, utcDayKey(at));
  }

  function parseCount(raw: string | null): number {
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function usage(userId: string): Promise<number> {
    return parseCount(await redis.get(keyFor(userId, now())));
  }

  async function consume(
    userId: string,
    limit: number,
  ): Promise<{ used: number; remaining: number }> {
    const at = now();
    const key = keyFor(userId, at);
    const next = Number(
      await redis.eval(CONSUME_SCRIPT, 1, key, String(limit), String(AI_CAP_TTL_SECONDS)),
    );
    if (next < 0) throw new AiCapExceededError(secondsUntilUtcMidnight(at));
    return { used: next, remaining: Math.max(0, limit - next) };
  }

  async function refund(userId: string): Promise<void> {
    await redis.eval(REFUND_SCRIPT, 1, keyFor(userId, now()));
  }

  return { usage, consume, refund };
}
