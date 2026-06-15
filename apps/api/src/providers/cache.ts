import type { CachedResult } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import { STALE_TTL_SECONDS } from './ttl';

/**
 * Redis cache for provider values with request coalescing and
 * stale-while-revalidate (PROJECTPLAN.md §5.1, §5.3).
 *
 * Two Redis keys back every logical entry:
 *  - the **fresh** key, with the §5.3 TTL — its presence means "still fresh";
 *  - the **stale** key, with a long retention ({@link STALE_TTL_SECONDS}) — the
 *    last-known-good copy, served marked `stale: true` only when an upstream
 *    refresh fails.
 *
 * Request coalescing is in-process single-flight: concurrent misses for the
 * same key await one shared load, so exactly one upstream call happens per key
 * per process (§5.3, "concurrent misses trigger exactly one upstream fetch").
 */

/** The logical cache key shape from §5.3: `{providerId}:{providerRef}:{kind}:{variant}`. */
export function cacheKey(
  providerId: string,
  providerRef: string,
  kind: string,
  variant: string,
): string {
  return `${providerId}:${providerRef}:${kind}:${variant}`;
}

/** Redis namespace for the fresh copy. */
export const freshCacheKey = (logicalKey: string): string => `mkt:fresh:${logicalKey}`;
/** Redis namespace for the long-lived stale copy. */
export const staleCacheKey = (logicalKey: string): string => `mkt:stale:${logicalKey}`;

interface StoredEntry<T> {
  value: T;
  /** Epoch ms when this value was fetched from upstream. */
  asOf: number;
}

export interface GetOrLoadParams<T> {
  /** Logical key from {@link cacheKey}. */
  key: string;
  /** Freshness TTL in seconds (from §5.3). */
  ttlSeconds: number;
  /** Fetches a fresh value from upstream when the cache misses. */
  loader: () => Promise<T>;
  /** Retention of the stale copy; defaults to {@link STALE_TTL_SECONDS}. */
  staleTtlSeconds?: number;
}

export interface MarketCache {
  /**
   * Return a fresh cached value, or load one. On loader failure, fall back to
   * the stale copy marked `stale: true`; if there is none, the error propagates.
   * Concurrent calls for the same key coalesce to a single load.
   */
  getOrLoad<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>>;
}

export interface CreateMarketCacheOptions {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export function createMarketCache(
  redis: Redis,
  options: CreateMarketCacheOptions = {},
): MarketCache {
  const now = options.now ?? Date.now;
  // Single-flight registry: key → in-progress load. Keyed by logical key, so a
  // quote and a history request for the same asset never collide.
  const inflight = new Map<string, Promise<CachedResult<unknown>>>();

  async function readEntry<T>(redisKey: string): Promise<StoredEntry<T> | null> {
    const raw = await redis.get(redisKey);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredEntry<T>;
      if (parsed && typeof parsed === 'object' && 'value' in parsed && 'asOf' in parsed) {
        return parsed;
      }
      return null;
    } catch {
      // Corrupt payload: treat as a miss and drop it.
      await redis.del(redisKey);
      return null;
    }
  }

  async function load<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>> {
    const { key, ttlSeconds, loader } = params;
    const staleTtl = params.staleTtlSeconds ?? STALE_TTL_SECONDS;
    try {
      const value = await loader();
      const entry: StoredEntry<T> = { value, asOf: now() };
      const payload = JSON.stringify(entry);
      // Fresh copy expires at the §5.3 TTL; stale copy is retained much longer.
      await redis.set(freshCacheKey(key), payload, 'EX', ttlSeconds);
      await redis.set(staleCacheKey(key), payload, 'EX', staleTtl);
      return { value, stale: false, asOf: entry.asOf };
    } catch (err) {
      // Stale-while-revalidate: upstream failed, serve last-known-good if we have it.
      const stale = await readEntry<T>(staleCacheKey(key));
      if (stale) {
        return { value: stale.value, stale: true, asOf: stale.asOf };
      }
      throw err;
    }
  }

  return {
    async getOrLoad<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>> {
      const { key } = params;

      const fresh = await readEntry<T>(freshCacheKey(key));
      if (fresh) {
        return { value: fresh.value, stale: false, asOf: fresh.asOf };
      }

      // Coalesce concurrent misses onto one shared load.
      const existing = inflight.get(key);
      if (existing) {
        return (await existing) as CachedResult<T>;
      }

      const pending = load(params).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending as Promise<CachedResult<unknown>>);
      return pending;
    },
  };
}
