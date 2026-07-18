import type { UsageAnalyticsResponse } from '@bettertrack/contracts';

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
 *    buffer with one folded upsert per key; tests flush explicitly.
 *  - **read** — {@link UsageAnalyticsService.overview} assembles DAU/WAU/MAU
 *    (distinct active users over the trailing 1/7/30-day windows), per-feature
 *    counters, top viewed assets and the registration funnel. The per-feature
 *    counters and daily activity series are served from the materialized
 *    {@link usageDaily} rollup; the read refreshes TODAY's rollup first so the
 *    current day is always fresh even between cron runs.
 *
 * No third-party trackers feed any of this — only our own request/auth stream.
 */

const DAY_MS = 86_400_000;
const DEFAULT_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_TOP_ASSETS_LIMIT = 10;
/** Trailing days the rollup cron re-materializes on each run (heals late data). */
const DEFAULT_ROLLUP_WINDOW_DAYS = 3;

/** A single captured signal (from the request middleware). */
export interface UsageSignal {
  userId: string;
  feature: string;
  /** Asset the request concerned, if any (empty string means none). */
  assetId?: string | null;
  /** When it happened; defaults to now at capture time. */
  occurredAt?: Date;
}

export interface UsageAnalyticsService {
  /** Buffer one usage signal. Pure in-memory — safe to call on the hot path. */
  capture(signal: UsageSignal): void;
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
}

interface BufferedRow {
  userId: string;
  feature: string;
  assetId: string;
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

  // Buffer keyed by (user|feature|asset|day) so repeated hits fold before they
  // ever reach the DB — capture stays O(1) and writes stay bounded.
  let buffer = new Map<string, BufferedRow>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (buffer.size === 0) return;
    const rows: UsageEventUpsert[] = [...buffer.values()];
    buffer = new Map();
    try {
      await repo.upsertEvents(rows);
    } catch (err) {
      logger?.error({ err }, 'failed to flush usage events');
    }
  };

  // Production flushes on a timer; tests leave it off and flush explicitly.
  // Unref'd so it never keeps the process alive just to persist usage counters.
  if (deps.startTimer && flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref();
  }

  const cutoffDay = (days: number): string => dayOf(now() - (days - 1) * DAY_MS);

  const overview = async (): Promise<UsageAnalyticsResponse> => {
    // Keep the current day fresh between cron runs, then read the rollup.
    await repo.rollupDay(dayOf(now()));
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
      const key = `${signal.userId}|${signal.feature}|${assetId}|${day}`;
      const existing = buffer.get(key);
      if (existing) {
        existing.hits += 1;
        existing.lastSeenAt = occurredAt;
      } else {
        buffer.set(key, {
          userId: signal.userId,
          feature: signal.feature,
          assetId,
          day,
          hits: 1,
          lastSeenAt: occurredAt,
        });
      }
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
