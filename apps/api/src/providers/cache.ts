import type { CachedResult } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import { cacheEventsTotal } from '../metrics';

import { releaseCacheLock } from './cacheLock';
import { AssetNotFoundError } from './errors';
import { NEGATIVE_TTL_SECONDS, STALE_TTL_SECONDS } from './ttl';

/**
 * Redis cache for provider values with request coalescing,
 * serve-stale-while-revalidate and negative caching (PROJECTPLAN.md §5.3).
 *
 * Redis keys backing every logical entry:
 *  - the **fresh** key, with the §5.3 TTL — its presence means "still fresh";
 *  - the **stale** key, with a long retention ({@link STALE_TTL_SECONDS}) — the
 *    last-known-good copy, served immediately marked `stale: true` whenever the
 *    fresh copy has expired (while one background refresh runs) or the upstream
 *    is unreachable;
 *  - the **negative** key ({@link NEGATIVE_TTL_SECONDS}) — a cached "does not
 *    exist" answer, so repeated misses for an unknown symbol make no further
 *    upstream calls within the window;
 *  - the **lock** key — a short cross-process load lock, so concurrent misses
 *    across processes still produce exactly one upstream fetch.
 *
 * Request coalescing is two layers deep (§5.3): an in-process single-flight map
 * (concurrent misses in one process await the same load) backed by the Redis
 * `SET NX PX` lock across processes (losers poll for the winner's result).
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
/** Redis namespace for the cached negative (not-found) answer (§5.3). */
export const negativeCacheKey = (logicalKey: string): string => `mkt:neg:${logicalKey}`;
/** Redis namespace for the short cross-process load lock (§5.3 coalescing). */
export const loadLockKey = (logicalKey: string): string => `mkt:lock:${logicalKey}`;

/**
 * Delete every cached representation of account-owned manual assets. Paranoid
 * enable calls this only after local revalidations settle and while its account
 * transition lock excludes new owner-scoped reads.
 */
export async function purgeManualAssetCaches(
  redis: Redis,
  assetIds: readonly string[],
): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    for (const namespace of ['fresh', 'stale', 'neg', 'lock']) {
      let cursor = '0';
      const pattern = `mkt:${namespace}:manual:${assetId}:*`;
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = String(nextCursor);
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    }
  }
}

/**
 * An "empty" provider answer: a collection with no members. Storing one as the
 * *fresh* copy is legitimate (it is what upstream just said), but it must never
 * replace a non-empty **stale** copy: the stale key is the 7-day last-known-good
 * fallback, and blanking it turns one bad answer into an asset that contributes
 * nothing to every series read for the rest of the TTL window. Defence in depth
 * behind the providers' own not-found classification (§13.5 V5-P1c).
 */
function isEmptyCollection(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

interface StoredEntry<T> {
  value: T;
  /** Epoch ms when this value was fetched from upstream. */
  asOf: number;
}

interface NegativeEntry {
  /** Message of the original not-found error, re-thrown on negative hits. */
  message: string;
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
  /** Retention of a cached negative answer; defaults to {@link NEGATIVE_TTL_SECONDS}. */
  negativeTtlSeconds?: number;
  /**
   * Classifies a loader error as a definitive "does not exist" (→ negative
   * cached) versus transient (→ never cached). Defaults to caching nothing.
   */
  isNotFound?: (err: unknown) => boolean;
  /**
   * Gate for the background revalidation of an expired entry. Return false to
   * keep serving the stale copy without any upstream attempt — this is how an
   * open circuit breaker "stretches TTLs instead of erroring users" (§5.3).
   * Defaults to always revalidating.
   */
  shouldRevalidate?: () => boolean;
}

export interface MarketCache {
  /**
   * Return a fresh cached value, or load one. An expired entry is returned
   * immediately marked `stale: true` while a single background refresh runs
   * (serve-stale-while-revalidate, §5.3). A cached negative answer re-throws
   * {@link AssetNotFoundError} without an upstream call. Concurrent misses for
   * the same key coalesce to a single load, in-process and cross-process.
   */
  getOrLoad<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>>;
  /**
   * Write a value the caller already fetched upstream (fresh + stale copies,
   * clearing any negative entry) — exactly what a successful load stores. This
   * is how the Live Mode poll loop (§6.3, V3-P7b) keeps the regular quote path
   * served from cache while it streams: its fresh reads prime the same key the
   * 60 s poll fallback hits, so N surfaces still cost one upstream stream.
   */
  prime<T>(
    params: Pick<GetOrLoadParams<T>, 'key' | 'ttlSeconds' | 'staleTtlSeconds'>,
    value: T,
  ): Promise<CachedResult<T>>;
  /**
   * Resolves once every background revalidation currently in flight has
   * finished (graceful shutdown, deterministic tests).
   */
  settled(): Promise<void>;
}

export interface CreateMarketCacheOptions {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * TTL of the cross-process load lock, and the longest a lock loser polls for
   * the winner's result. Must comfortably exceed one upstream attempt chain
   * (5 s timeout × retry-once, §5.1); defaults to 10 s.
   */
  lockTtlMs?: number;
  /** How often a lock loser re-checks for the winner's result. Default 50 ms. */
  pollIntervalMs?: number;
  /** Injectable sleep (tests). Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes swallowed background-refresh failures (logging hook). */
  onBackgroundError?: (key: string, err: unknown) => void;
}

const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMarketCache(
  redis: Redis,
  options: CreateMarketCacheOptions = {},
): MarketCache {
  const now = options.now ?? Date.now;
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;
  const onBackgroundError = options.onBackgroundError ?? (() => {});

  // In-process single-flight for blocking (cold-miss) loads: key → shared load.
  const inflight = new Map<string, Promise<CachedResult<unknown>>>();
  // Keys with a background revalidation in flight (one refresh per key), plus
  // the task set `settled()` awaits.
  const refreshing = new Set<string>();
  const background = new Set<Promise<void>>();
  let lockCounter = 0;

  async function readJson<T>(redisKey: string): Promise<T | null> {
    const raw = await redis.get(redisKey);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt payload: treat as a miss and drop it.
      await redis.del(redisKey);
      return null;
    }
  }

  function parseEntry<T>(raw: string | null | undefined): StoredEntry<T> | null {
    if (raw == null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredEntry<T>;
      if (parsed && typeof parsed === 'object' && 'value' in parsed && 'asOf' in parsed) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function readEntry<T>(redisKey: string): Promise<StoredEntry<T> | null> {
    const parsed = await readJson<StoredEntry<T>>(redisKey);
    if (parsed && typeof parsed === 'object' && 'value' in parsed && 'asOf' in parsed) {
      return parsed;
    }
    return null;
  }

  async function readNegative(key: string): Promise<NegativeEntry | null> {
    const parsed = await readJson<NegativeEntry>(negativeCacheKey(key));
    if (parsed && typeof parsed === 'object' && 'message' in parsed) return parsed;
    return null;
  }

  async function acquireLock(key: string): Promise<string | null> {
    lockCounter += 1;
    const token = `${lockCounter}:${Math.random().toString(36).slice(2)}`;
    const result = await redis.set(loadLockKey(key), token, 'PX', lockTtlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /**
   * True when writing `value` would replace a non-empty stale copy with an empty
   * one — the last-known-good copy wins (see {@link isEmptyCollection}). Only an
   * empty value pays for the extra read, so the common path is unchanged.
   */
  async function staleWouldRegress(key: string, value: unknown): Promise<boolean> {
    if (!isEmptyCollection(value)) return false;
    const existing = await readEntry<unknown>(staleCacheKey(key));
    return existing !== null && !isEmptyCollection(existing.value);
  }

  async function store<T>(
    params: Pick<GetOrLoadParams<T>, 'key' | 'ttlSeconds' | 'staleTtlSeconds'>,
    value: T,
  ): Promise<CachedResult<T>> {
    const entry: StoredEntry<T> = { value, asOf: now() };
    const payload = JSON.stringify(entry);
    // Fresh copy expires at the §5.3 TTL; stale copy is retained much longer.
    await redis.set(freshCacheKey(params.key), payload, 'EX', params.ttlSeconds);
    if (!(await staleWouldRegress(params.key, value))) {
      await redis.set(
        staleCacheKey(params.key),
        payload,
        'EX',
        params.staleTtlSeconds ?? STALE_TTL_SECONDS,
      );
    }
    // A successful load supersedes any negative answer written by a racing process.
    await redis.del(negativeCacheKey(params.key));
    return { value, stale: false, asOf: entry.asOf };
  }

  /** One upstream fetch: store on success, negative-cache a definitive not-found. */
  async function loadAndStore<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>> {
    try {
      const value = await params.loader();
      return await store(params, value);
    } catch (err) {
      if (params.isNotFound?.(err)) {
        const entry: NegativeEntry = {
          message: err instanceof Error ? err.message : String(err),
          asOf: now(),
        };
        await redis.set(
          negativeCacheKey(params.key),
          JSON.stringify(entry),
          'EX',
          params.negativeTtlSeconds ?? NEGATIVE_TTL_SECONDS,
        );
      }
      throw err;
    }
  }

  /**
   * Blocking load for a cold miss (no fresh, stale or negative copy). Exactly
   * one process fetches (the lock winner); losers poll for its result and only
   * fetch themselves if the winner disappears without producing one.
   */
  async function loadBlocking<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>> {
    const token = await acquireLock(params.key);
    if (token) {
      try {
        return await loadAndStore(params);
      } finally {
        await releaseCacheLock(redis, loadLockKey(params.key), token);
      }
    }

    const deadline = now() + lockTtlMs;
    for (;;) {
      await sleep(pollIntervalMs);
      const fresh = await readEntry<T>(freshCacheKey(params.key));
      if (fresh) return { value: fresh.value, stale: false, asOf: fresh.asOf };
      const negative = await readNegative(params.key);
      if (negative) throw new AssetNotFoundError(negative.message, true);
      const lockGone = (await redis.exists(loadLockKey(params.key))) === 0;
      if (lockGone || now() >= deadline) break;
    }
    // The winner may have stored its result between our last read and the lock
    // check above — one final re-read before falling back avoids a duplicate
    // upstream fetch.
    const fresh = await readEntry<T>(freshCacheKey(params.key));
    if (fresh) return { value: fresh.value, stale: false, asOf: fresh.asOf };
    const negative = await readNegative(params.key);
    if (negative) throw new AssetNotFoundError(negative.message, true);
    // The winner failed transiently or died without a result: fetch ourselves
    // rather than error the caller.
    return loadAndStore(params);
  }

  /** Start at most one background refresh for an expired-but-stale-served key. */
  function maybeRevalidate<T>(params: GetOrLoadParams<T>): void {
    // TTL stretch (§5.3): while the gate is closed (circuit open), keep serving
    // stale with no upstream attempt at all.
    if (params.shouldRevalidate && !params.shouldRevalidate()) return;
    if (refreshing.has(params.key)) return;
    refreshing.add(params.key);

    const run = async (): Promise<void> => {
      try {
        // A live negative window means upstream already said "does not exist"
        // recently — no refresh attempt.
        if ((await redis.exists(negativeCacheKey(params.key))) === 1) return;
        const token = await acquireLock(params.key);
        if (!token) return; // another process is already refreshing
        try {
          await loadAndStore(params);
        } finally {
          await releaseCacheLock(redis, loadLockKey(params.key), token);
        }
      } catch (err) {
        // The caller already got the stale copy; a failed refresh must never
        // surface. Not-found was negative-cached by loadAndStore.
        onBackgroundError(params.key, err);
      }
    };

    const task: Promise<void> = run().finally(() => {
      refreshing.delete(params.key);
      background.delete(task);
    });
    background.add(task);
  }

  return {
    async getOrLoad<T>(params: GetOrLoadParams<T>): Promise<CachedResult<T>> {
      const { key } = params;

      // One MGET snapshots fresh + stale together, so a store racing between
      // two separate reads can't make us serve stale while fresh exists.
      const [freshRaw, staleRaw] = await redis.mget(freshCacheKey(key), staleCacheKey(key));
      const fresh = parseEntry<T>(freshRaw);
      if (fresh) {
        cacheEventsTotal.inc({ result: 'hit' });
        return { value: fresh.value, stale: false, asOf: fresh.asOf };
      }

      // Serve-stale-while-revalidate (§5.3): an expired entry is returned
      // immediately marked stale while one background refresh runs.
      const stale = parseEntry<T>(staleRaw);
      if (stale) {
        cacheEventsTotal.inc({ result: 'stale' });
        maybeRevalidate(params);
        return { value: stale.value, stale: true, asOf: stale.asOf };
      }

      // Negative cache (§5.3): a recent "does not exist" answers without upstream.
      const negative = await readNegative(key);
      if (negative) {
        cacheEventsTotal.inc({ result: 'negative' });
        throw new AssetNotFoundError(negative.message, true);
      }

      // A cold miss: no fresh, stale or negative copy for this key.
      cacheEventsTotal.inc({ result: 'miss' });

      // Coalesce concurrent cold misses onto one shared load.
      const existing = inflight.get(key);
      if (existing) {
        return (await existing) as CachedResult<T>;
      }
      const pending = loadBlocking(params).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending as Promise<CachedResult<unknown>>);
      return pending;
    },

    prime(params, value) {
      return store(params, value);
    },

    async settled(): Promise<void> {
      while (background.size > 0) {
        await Promise.allSettled([...background]);
      }
    },
  };
}
