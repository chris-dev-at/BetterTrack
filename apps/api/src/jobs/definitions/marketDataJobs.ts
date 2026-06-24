import type { HistoryInterval, HistoryRange, PricePoint } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import {
  createPriceJobsRepository,
  type DailyClose,
  type JobAsset,
} from '../../data/repositories/priceJobsRepository';
import type { MarketDataService } from '../../providers';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * The §9 market-data job bodies, dropped onto the BullMQ harness from #16:
 *
 *  - `prices.refreshDaily` — nightly at 03:00 Europe/Vienna: upsert recent daily
 *    closes for every referenced asset + every FX pair into `price_history`.
 *  - `prices.backfill` — on demand (first time an asset is used): fetch its
 *    max-range daily history, throttled to ~1 asset/sec.
 *  - `fx.refreshSpot` — hourly: refresh the cached spot quotes the currency
 *    service reads its current FX rates from (§5.4).
 *
 * Each is built from `{ db, marketData }` so the handlers close over their domain
 * dependencies, keeping {@link JobContext} to cross-cutting infra (events,
 * dead-letter, redis, logger) — the same DI shape as the rest of the services.
 */

/** Stable scheduler id + cron for the nightly daily-close refresh (§9). */
export const PRICES_REFRESH_DAILY_SCHEDULER_ID = 'prices.refreshDaily';
export const PRICES_REFRESH_DAILY_CRON = '0 3 * * *';
export const PRICES_REFRESH_DAILY_TZ = 'Europe/Vienna';

/** Stable scheduler id + cron for the hourly FX spot refresh (§9). */
export const FX_REFRESH_SPOT_SCHEDULER_ID = 'fx.refreshSpot';
export const FX_REFRESH_SPOT_CRON = '0 * * * *';

/**
 * Window the nightly job re-fetches. A short recent window (rather than a single
 * literal "yesterday") makes the upsert self-healing — a night the worker missed,
 * or a close the provider revised, is corrected on the next run — while still
 * always covering yesterday's close. Idempotent on the `(asset_id, date)` PK.
 */
export const REFRESH_DAILY_RANGE: HistoryRange = '1M';
/** Backfill pulls the full available history (§9 "max-range daily history"). */
export const BACKFILL_RANGE: HistoryRange = 'MAX';
/** Both price jobs persist *daily* closes (§5.3), so they force the 1d interval. */
export const DAILY_INTERVAL: HistoryInterval = '1d';

/**
 * Worker rate limit for `prices.backfill`: at most one job per second across the
 * queue, i.e. ~1 asset/sec (§9 "polite"). BullMQ throttles job starts queue-wide,
 * so however many backfills are enqueued at once, they drain one per second.
 */
export const BACKFILL_LIMITER = { max: 1, duration: 1000 } as const;

export interface MarketDataJobDeps {
  db: Database;
  marketData: MarketDataService;
}

/** ISO timestamp the job's events are stamped with (mirrors the heartbeat job). */
function occurredAtOf(job: { timestamp?: number }): string {
  return new Date(job.timestamp || Date.now()).toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dedupeById(list: JobAsset[]): JobAsset[] {
  const byId = new Map<string, JobAsset>();
  for (const asset of list) byId.set(asset.id, asset);
  return [...byId.values()];
}

/**
 * Collapse a provider price series into one close per calendar day, keyed by the
 * `YYYY-MM-DD` portion of each point's timestamp. The last point of any given day
 * wins, so the result has no duplicate dates — a hard requirement for the single
 * `ON CONFLICT DO UPDATE` upsert. Closes keep full precision (no rounding, §5.4).
 */
function toDailyCloses(points: PricePoint[]): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const point of points) {
    const date = point.time.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!Number.isFinite(point.close)) continue;
    byDate.set(date, point.close);
  }
  return [...byDate.entries()].map(([date, close]) => ({ date, close: String(close) }));
}

/**
 * `prices.refreshDaily` — nightly upsert of recent daily closes into
 * `price_history` for every referenced asset + every FX pair in use (§9).
 *
 * Assets are processed independently: one asset's provider failure is logged and
 * collected, never aborting the others. If any asset failed, the handler throws
 * at the end so BullMQ retries (and, on exhausted attempts, dead-letters) — the
 * upserts already done are idempotent, so the retry safely re-runs the batch.
 */
export function createPricesRefreshDailyJob(
  deps: MarketDataJobDeps,
): JobDefinition<'prices.refreshDaily'> {
  const repo = createPriceJobsRepository(deps.db);
  return {
    name: QUEUE_NAMES.pricesRefreshDaily,
    schedule: {
      id: PRICES_REFRESH_DAILY_SCHEDULER_ID,
      pattern: PRICES_REFRESH_DAILY_CRON,
      tz: PRICES_REFRESH_DAILY_TZ,
    },
    async handler(job, ctx) {
      const occurredAt = occurredAtOf(job);
      const [referenced, fx] = await Promise.all([
        repo.listReferencedAssets(),
        repo.listFxAssets(),
      ]);
      const targets = dedupeById([...referenced, ...fx]);

      const failures: string[] = [];
      for (const asset of targets) {
        try {
          const result = await deps.marketData.getHistory(
            { providerId: asset.providerId, providerRef: asset.providerRef },
            REFRESH_DAILY_RANGE,
            DAILY_INTERVAL,
          );
          const written = await repo.upsertDailyCloses(asset.id, toDailyCloses(result.value));
          if (written > 0) {
            await ctx.events.publish({ type: 'quote.updated', assetId: asset.id, occurredAt });
          }
        } catch (err) {
          failures.push(asset.id);
          ctx.logger.warn(
            { assetId: asset.id, providerRef: asset.providerRef, err: errorMessage(err) },
            'prices.refreshDaily: asset refresh failed',
          );
        }
      }

      ctx.logger.info(
        { total: targets.length, failed: failures.length },
        'prices.refreshDaily complete',
      );
      if (failures.length > 0) {
        throw new Error(
          `prices.refreshDaily: ${failures.length}/${targets.length} assets failed (first: ${failures[0]})`,
        );
      }
    },
  };
}

/**
 * `prices.backfill` — on-demand max-range daily history for a single asset (§9),
 * enqueued the first time an asset is referenced (§6.2). Idempotent on the
 * `(asset_id, date)` PK, and rate-limited to ~1 asset/sec by {@link BACKFILL_LIMITER}.
 *
 * A missing asset (deleted between enqueue and run) is a no-op, not a failure —
 * there is nothing to backfill, so dead-lettering it would be noise.
 */
export function createPricesBackfillJob(deps: MarketDataJobDeps): JobDefinition<'prices.backfill'> {
  const repo = createPriceJobsRepository(deps.db);
  return {
    name: QUEUE_NAMES.pricesBackfill,
    workerOptions: { limiter: { ...BACKFILL_LIMITER } },
    async handler(job, ctx) {
      const occurredAt = occurredAtOf(job);
      const { assetId } = job.data;
      const asset = await repo.findAssetById(assetId);
      if (!asset) {
        ctx.logger.warn({ assetId }, 'prices.backfill: asset no longer exists, skipping');
        return;
      }

      const result = await deps.marketData.getHistory(
        { providerId: asset.providerId, providerRef: asset.providerRef },
        BACKFILL_RANGE,
        DAILY_INTERVAL,
      );
      const written = await repo.upsertDailyCloses(asset.id, toDailyCloses(result.value));
      ctx.logger.info({ assetId: asset.id, written }, 'prices.backfill complete');
      if (written > 0) {
        await ctx.events.publish({ type: 'quote.updated', assetId: asset.id, occurredAt });
      }
    },
  };
}

/**
 * `fx.refreshSpot` — hourly refresh of the cached spot quotes the currency
 * service sources current FX rates from (§5.4, §9). Walks every FX-pair asset and
 * fetches its quote, which warms the §5.3 quote cache; no durable write (FX *daily*
 * closes are the nightly `prices.refreshDaily` job's responsibility).
 *
 * Like the daily refresh, FX pairs are processed independently and a failure
 * after the loop triggers the retry/dead-letter path.
 */
export function createFxRefreshSpotJob(deps: MarketDataJobDeps): JobDefinition<'fx.refreshSpot'> {
  const repo = createPriceJobsRepository(deps.db);
  return {
    name: QUEUE_NAMES.fxRefreshSpot,
    schedule: { id: FX_REFRESH_SPOT_SCHEDULER_ID, pattern: FX_REFRESH_SPOT_CRON },
    async handler(job, ctx) {
      const occurredAt = occurredAtOf(job);
      const fx = await repo.listFxAssets();

      const failures: string[] = [];
      for (const asset of fx) {
        try {
          await deps.marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          await ctx.events.publish({ type: 'quote.updated', assetId: asset.id, occurredAt });
        } catch (err) {
          failures.push(asset.id);
          ctx.logger.warn(
            { assetId: asset.id, providerRef: asset.providerRef, err: errorMessage(err) },
            'fx.refreshSpot: pair refresh failed',
          );
        }
      }

      ctx.logger.info({ total: fx.length, failed: failures.length }, 'fx.refreshSpot complete');
      if (failures.length > 0) {
        throw new Error(
          `fx.refreshSpot: ${failures.length}/${fx.length} FX pairs failed (first: ${failures[0]})`,
        );
      }
    },
  };
}
