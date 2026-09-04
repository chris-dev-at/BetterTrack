import { USAGE_ANALYTICS_WINDOW_DAYS, type UsageAnalyticsResponse } from '@bettertrack/contracts';

import type {
  UsageAnalyticsRepository,
  UsageEventUpsert,
} from '../../data/repositories/usageAnalyticsRepository';
import type { Logger } from '../../logger';

/**
 * Admin usage-analytics service (PROJECTPLAN.md §13.5 V5-P2 arc (b)) — the
 * FIRST-PARTY usage stream, kept strictly separate from the user-facing
 * portfolio `analyticsService`. It has two sides:
 *
 *  - **capture** — the request middleware calls {@link UsageAnalyticsService.capture}
 *    on every authenticated request. That is pure in-memory bookkeeping (a Map
 *    keyed by user/feature/asset/day with a hit counter), so it never touches
 *    the DB on the hot path. A timer (production only) periodically flushes the
 *    buffer with one folded upsert per key; tests flush explicitly. The buffer
 *    is capped ({@link DEFAULT_MAX_BUFFERED_ROWS}) so residency is bounded as
 *    well as write count.
 *  - **read** — {@link UsageAnalyticsService.overview} assembles DAU/WAU/MAU
 *    (distinct active users over the trailing 1/7/30-day windows), per-feature
 *    counters, top viewed assets and the registration funnel. The per-feature
 *    counters and daily activity series are served from the materialized
 *    {@link usageDaily} rollup; the read refreshes TODAY's rollup first — spaced
 *    by {@link DEFAULT_READ_ROLLUP_MIN_INTERVAL_MS} and deduped across
 *    concurrent reads — so the current day stays fresh between cron runs without
 *    a refresh loop buying a scan per page load. The funnel's
 *    `activated` stage is a LIFETIME figure and comes from the durable
 *    `usage_activations` marker, not from raw events — those are swept by
 *    `BT_USAGE_EVENT_RETENTION_DAYS` and would make it decay (#1680).
 *
 * No third-party trackers feed any of this — only our own request/auth stream.
 */

const DAY_MS = 86_400_000;
const DEFAULT_FLUSH_INTERVAL_MS = 15_000;
/**
 * Ceiling on distinct fold keys held between flushes. Folding bounds how many
 * rows a flush WRITES; only this bounds how many the process HOLDS, and 15 s of
 * authenticated traffic across many users × features × assets has no natural
 * ceiling. Same order as `problemService`'s `MAX_TRACKED_FINGERPRINTS` (5 000),
 * for the same reason: reached only by a storm, and then it is a bound, not a
 * leak.
 */
const DEFAULT_MAX_BUFFERED_ROWS = 5_000;
/**
 * Minimum spacing between the on-read refreshes of TODAY's rollup. Each one is a
 * DELETE + INSERT over the day's raw events, so an admin refresh loop must not
 * buy one per page load; a 30 s floor keeps "today stays fresh" (capture itself
 * only reaches the DB every {@link DEFAULT_FLUSH_INTERVAL_MS}) while making the
 * scan work per unit time constant instead of proportional to reads.
 */
const DEFAULT_READ_ROLLUP_MIN_INTERVAL_MS = 30_000;
/**
 * The reporting window every windowed metric reads (DAU/WAU/MAU, feature
 * counters, top assets, the activity series). Defined in `@bettertrack/contracts`
 * rather than here because the env schema refines `BT_USAGE_EVENT_RETENTION_DAYS`
 * against the SAME number (#1680), and `config/` must not import a service
 * module to reach it.
 */
const DEFAULT_WINDOW_DAYS = USAGE_ANALYTICS_WINDOW_DAYS;
const DEFAULT_TOP_ASSETS_LIMIT = 10;
/** Trailing days the rollup cron re-materializes on each run (heals late data). */
const DEFAULT_ROLLUP_WINDOW_DAYS = 3;

/** A single captured signal (from the request middleware). */
export interface UsageSignal {
  userId: string;
  feature: string;
  /** Asset the request concerned, if any (empty string means none). */
  assetId?: string | null;
  /**
   * Portfolio attribution retained only in memory until the write boundary.
   * It is never persisted; the repository re-checks that the target is still
   * a plain portfolio while holding the account transition lock.
   */
  targetPortfolioId?: string | null;
  /** Asset quotes have no portfolio attribution and must be dropped at flush
   * if the account has acquired any vaulted portfolio in the meantime. */
  suppressIfAnyVault?: boolean;
  /** When it happened; defaults to now at capture time. */
  occurredAt?: Date;
}

export interface UsageAnalyticsService {
  /** Buffer one usage signal. Pure in-memory — safe to call on the hot path. */
  capture(signal: UsageSignal): void;
  /** Fold keys currently buffered (never above the configured ceiling). */
  bufferedRows(): number;
  /**
   * Signals dropped since boot because the buffer was full AND a flush was
   * already in flight — the overflow is counted and logged, never silent.
   */
  droppedCaptures(): number;
  /** Persist the buffered signals (folded per key). For the flush timer + tests. */
  flush(): Promise<void>;
  /** Re-materialize the trailing rollup window (the cron job body). */
  rollupRecent(days?: number): Promise<void>;
  /** Re-materialize one day's rollup (tests / on-read freshness). */
  rollupDay(day: string): Promise<void>;
  /** Assemble the admin usage-analytics payload. */
  overview(): Promise<UsageAnalyticsResponse>;
  /** Stop the flush timer and drain the buffer (graceful shutdown). */
  stop(): Promise<void>;
}

export interface UsageAnalyticsServiceDeps {
  repo: UsageAnalyticsRepository;
  logger?: Logger;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Start the background flush timer. Defaults to false (off in tests). */
  startTimer?: boolean;
  /** Flush cadence in ms when the timer runs. */
  flushIntervalMs?: number;
  /** Reporting window for feature counters / top assets / series. */
  windowDays?: number;
  /** How many top assets the overview returns. */
  topAssetsLimit?: number;
  /** Trailing days {@link rollupRecent} re-materializes with no arg. */
  rollupWindowDays?: number;
  /** Ceiling on buffered fold keys before overflow handling kicks in. */
  maxBufferedRows?: number;
  /** Minimum spacing between on-read refreshes of today's rollup. */
  readRollupMinIntervalMs?: number;
}

interface BufferedRow {
  userId: string;
  feature: string;
  assetId: string;
  targetPortfolioId: string | null;
  suppressIfAnyVault: boolean;
  day: string;
  hits: number;
  lastSeenAt: Date;
}

/** UTC calendar day (`YYYY-MM-DD`) of a timestamp. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createUsageAnalyticsService(
  deps: UsageAnalyticsServiceDeps,
): UsageAnalyticsService {
  const { repo, logger } = deps;
  const now = deps.now ?? Date.now;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const topAssetsLimit = deps.topAssetsLimit ?? DEFAULT_TOP_ASSETS_LIMIT;
  const rollupWindowDays = deps.rollupWindowDays ?? DEFAULT_ROLLUP_WINDOW_DAYS;
  const maxBufferedRows = deps.maxBufferedRows ?? DEFAULT_MAX_BUFFERED_ROWS;
  const readRollupMinIntervalMs =
    deps.readRollupMinIntervalMs ?? DEFAULT_READ_ROLLUP_MIN_INTERVAL_MS;

  // Buffer keyed by (user|feature|asset|day|portfolio|vault-sensitivity). Two
  // separate guarantees, and they are not the same one (#1744):
  //  - folding bounds the WRITE COUNT — repeated hits on a key become one row,
  //    however many times they arrive, and capture stays O(1);
  //  - `maxBufferedRows` bounds RESIDENCY — how much a process holds between
  //    flushes. Distinct keys do not fold, so without a ceiling the buffer grows
  //    with the traffic's cardinality, not with the flush cadence.
  // At the ceiling capture first tries to drain early (nothing is lost); a
  // signal is only dropped when a flush is already in flight, and then it is
  // counted in `droppedCaptures()` and logged.
  let buffer = new Map<string, BufferedRow>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushesInFlight = 0;
  let dropped = 0;
  let droppedSinceFlush = 0;

  const flush = async (): Promise<void> => {
    // Report the overflow once per flush rather than once per dropped signal:
    // the drops arrive in storms, and a log line each would be its own storm.
    if (droppedSinceFlush > 0) {
      logger?.warn(
        { dropped: droppedSinceFlush, droppedTotal: dropped, maxBufferedRows },
        'usage captures dropped — buffer at its ceiling while a flush was in flight',
      );
      droppedSinceFlush = 0;
    }
    if (buffer.size === 0) return;
    const rows: UsageEventUpsert[] = [...buffer.values()];
    // Swapped synchronously, before the first await: residency falls to zero the
    // moment a flush starts, so the in-flight batch is the only other copy.
    buffer = new Map();
    flushesInFlight += 1;
    try {
      await repo.upsertEvents(rows);
    } catch (err) {
      logger?.error({ err }, 'failed to flush usage events');
    } finally {
      flushesInFlight -= 1;
    }
  };

  // Production flushes on a timer; tests leave it off and flush explicitly.
  // Unref'd so it never keeps the process alive just to persist usage counters.
  // The timer never stacks a second flush on a slow write: with a stalled DB
  // that would hold one batch per tick, so the ceiling would bound the buffer
  // and nothing else. Skipping keeps residency at one buffer + one batch, and
  // the folding/overflow path above absorbs the interval it sat out.
  if (deps.startTimer && flushIntervalMs > 0) {
    timer = setInterval(() => {
      if (flushesInFlight > 0) return;
      void flush();
    }, flushIntervalMs);
    timer.unref();
  }

  const cutoffDay = (days: number): string => dayOf(now() - (days - 1) * DAY_MS);

  /** Day of the last on-read refresh, and when it completed. */
  let lastReadRollupDay: string | null = null;
  let lastReadRollupAtMs = 0;
  /** The in-flight on-read refresh, so concurrent reads share one scan. */
  let readRollupInFlight: Promise<void> | null = null;

  /**
   * Keep TODAY's rollup fresh for the read — throttled and deduped. The nightly
   * cron owns the durable materialization (untouched); this exists only so the
   * current day is not missing from a mid-day read. Concurrent reads await the
   * same scan, and a refresh loop inside the window reuses the last one, so the
   * DELETE + INSERT over the day's events happens at most once per
   * `readRollupMinIntervalMs` per process instead of once per page load.
   *
   * A day boundary always refreshes immediately (the new day has no rollup yet),
   * and a failed refresh does not arm the throttle — the next read retries.
   */
  const refreshTodayRollup = async (): Promise<void> => {
    if (readRollupInFlight) {
      await readRollupInFlight;
      return;
    }
    const today = dayOf(now());
    if (today === lastReadRollupDay && now() - lastReadRollupAtMs < readRollupMinIntervalMs) return;
    const run = repo
      .rollupDay(today)
      .then(() => {
        lastReadRollupDay = today;
        lastReadRollupAtMs = now();
      })
      .finally(() => {
        readRollupInFlight = null;
      });
    readRollupInFlight = run;
    await run;
  };

  const overview = async (): Promise<UsageAnalyticsResponse> => {
    // Keep the current day fresh between cron runs, then read the rollup.
    await refreshTodayRollup();
    const since = cutoffDay(windowDays);
    const [daily, weekly, monthly, activated, registered, features, series, topAssets] =
      await Promise.all([
        repo.distinctActiveUsers(cutoffDay(1)),
        repo.distinctActiveUsers(cutoffDay(7)),
        repo.distinctActiveUsers(cutoffDay(30)),
        repo.activatedUsers(),
        repo.totalUsers(),
        repo.featureCounters(since),
        repo.dailySeries(since),
        repo.topAssets(since, topAssetsLimit),
      ]);

    return {
      activeUsers: { daily, weekly, monthly },
      features,
      topAssets,
      funnel: [
        { stage: 'registered', count: registered },
        { stage: 'activated', count: activated },
        { stage: 'weeklyActive', count: weekly },
        { stage: 'dailyActive', count: daily },
      ],
      series,
      windowDays,
      generatedAt: new Date(now()).toISOString(),
    };
  };

  return {
    capture(signal) {
      const occurredAt = signal.occurredAt ?? new Date(now());
      const day = dayOf(occurredAt.getTime());
      const assetId = signal.assetId ?? '';
      const targetPortfolioId = signal.targetPortfolioId ?? null;
      const suppressIfAnyVault = signal.suppressIfAnyVault === true;
      // The privacy attribution is part of the in-memory fold key even though
      // it is not persisted. Otherwise a plain and a later-vaulted request can
      // collapse before the repository has a chance to filter them separately.
      const key = `${signal.userId}|${signal.feature}|${assetId}|${day}|${targetPortfolioId ?? ''}|${suppressIfAnyVault ? 'vault-sensitive' : ''}`;
      const existing = buffer.get(key);
      if (existing) {
        existing.hits += 1;
        existing.lastSeenAt = occurredAt;
        return;
      }
      if (buffer.size >= maxBufferedRows) {
        // At the ceiling with a NEW key. Draining early costs nothing and loses
        // nothing — `flush` swaps the buffer synchronously, so the room is there
        // by the time this line returns. Only when a flush is ALREADY in flight
        // (the DB is not keeping up) is the signal dropped, which keeps memory
        // bounded by one buffer plus one in-flight batch. Every drop is counted
        // and reported at the next flush; capture never blocks and never throws.
        if (flushesInFlight > 0) {
          dropped += 1;
          droppedSinceFlush += 1;
          return;
        }
        void flush();
      }
      buffer.set(key, {
        userId: signal.userId,
        feature: signal.feature,
        assetId,
        targetPortfolioId,
        suppressIfAnyVault,
        day,
        hits: 1,
        lastSeenAt: occurredAt,
      });
    },

    bufferedRows() {
      return buffer.size;
    },

    droppedCaptures() {
      return dropped;
    },

    flush,

    async rollupRecent(days = rollupWindowDays) {
      for (let i = 0; i < days; i += 1) {
        await repo.rollupDay(dayOf(now() - i * DAY_MS));
      }
    },

    rollupDay(day) {
      return repo.rollupDay(day);
    },

    overview,

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await flush();
    },
  };
}
