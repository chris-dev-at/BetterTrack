import type { Redis } from 'ioredis';

import { AiCapExceededError } from './errors';

/**
 * Per-user, per-UTC-day AI completion budget (PROJECTPLAN.md §13.5 V5-P12). A
 * plain Redis counter keyed by user + UTC day — NO new table/migration, as the
 * composer mandated. The counter self-cleans via a bounded TTL and the day-scoped
 * key rolls over naturally at UTC midnight. `consume` is increment-first so it is
 * race-free: a request that would exceed the limit is rolled back and rejected
 * with a typed 429.
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
  /** Return one spent completion — used when a provider call fails after consuming. */
  refund(userId: string): Promise<void>;
}

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
    const next = await redis.incr(key);
    // First spend of the day — bound the key's lifetime so it self-cleans.
    if (next === 1) await redis.expire(key, AI_CAP_TTL_SECONDS);
    if (next > limit) {
      await redis.decr(key);
      throw new AiCapExceededError(secondsUntilUtcMidnight(at));
    }
    return { used: next, remaining: Math.max(0, limit - next) };
  }

  async function refund(userId: string): Promise<void> {
    const key = keyFor(userId, now());
    if (parseCount(await redis.get(key)) > 0) await redis.decr(key);
  }

  return { usage, consume, refund };
}
