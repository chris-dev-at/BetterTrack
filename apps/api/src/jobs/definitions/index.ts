import type { JobDefinition } from '../types';

import { createAlertsEvaluateJob, type AlertsJobDeps } from './alertsJob';
import { heartbeatJob } from './heartbeat';
import {
  createFxRefreshSpotJob,
  createPricesBackfillJob,
  createPricesRefreshDailyJob,
  type MarketDataJobDeps,
} from './marketDataJobs';

/**
 * Every scheduled job the worker process runs. The heartbeat smoke-test needs
 * nothing; the §9 market-data jobs close over their domain dependencies (`db`,
 * `marketData`) and the alert evaluator additionally over the notification
 * center (#368), so the worker bootstrap builds the full list by passing those
 * in here. The event-driven `notifications.dispatch` job is composed separately
 * (it needs the fully-built dispatcher).
 */
export function createJobDefinitions(
  deps: MarketDataJobDeps & AlertsJobDeps,
): readonly JobDefinition[] {
  return [
    heartbeatJob,
    createPricesRefreshDailyJob(deps),
    createPricesBackfillJob(deps),
    createFxRefreshSpotJob(deps),
    createAlertsEvaluateJob(deps),
  ];
}

export {
  heartbeatJob,
  HEARTBEAT_SCHEDULER_ID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_ASSET_ID,
  HEARTBEAT_LAST_KEY,
} from './heartbeat';

export {
  createAlertsEvaluateJob,
  ALERTS_EVALUATE_SCHEDULER_ID,
  ALERTS_EVALUATE_INTERVAL_MS,
  type AlertsJobDeps,
} from './alertsJob';

export {
  createNotificationsDispatchJob,
  type NotificationsDispatchJobDeps,
} from './notificationsJob';

export {
  createExportBuildJob,
  createExportCleanupJob,
  EXPORT_CLEANUP_SCHEDULER_ID,
  EXPORT_CLEANUP_CRON,
  EXPORT_CLEANUP_TZ,
  type ExportJobDeps,
} from './exportJobs';

export {
  createSnapshotsRecomputeJob,
  createSnapshotsBackfillJob,
  SNAPSHOTS_BACKFILL_SCHEDULER_ID,
  SNAPSHOTS_BACKFILL_CRON,
  SNAPSHOTS_BACKFILL_TZ,
  SNAPSHOT_HEAL_WINDOW_DAYS,
  type SnapshotJobDeps,
} from './snapshotJobs';

export {
  createUsageRollupJob,
  USAGE_ROLLUP_SCHEDULER_ID,
  USAGE_ROLLUP_CRON,
  USAGE_ROLLUP_TZ,
  type UsageRollupJobDeps,
} from './usageAnalyticsJobs';

export {
  createPricesRefreshDailyJob,
  createPricesBackfillJob,
  createFxRefreshSpotJob,
  PRICES_REFRESH_DAILY_SCHEDULER_ID,
  PRICES_REFRESH_DAILY_CRON,
  PRICES_REFRESH_DAILY_TZ,
  FX_REFRESH_SPOT_SCHEDULER_ID,
  FX_REFRESH_SPOT_CRON,
  REFRESH_DAILY_RANGE,
  BACKFILL_RANGE,
  DAILY_INTERVAL,
  BACKFILL_LIMITER,
  type MarketDataJobDeps,
} from './marketDataJobs';
