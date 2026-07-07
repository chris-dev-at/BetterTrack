import type { JobDefinition } from '../types';

import { createAlertsEvaluateJob } from './alertsJob';
import { heartbeatJob } from './heartbeat';
import {
  createFxRefreshSpotJob,
  createPricesBackfillJob,
  createPricesRefreshDailyJob,
  type MarketDataJobDeps,
} from './marketDataJobs';

/**
 * Every job the worker process runs. The heartbeat smoke-test needs nothing; the
 * §9 market-data jobs close over their domain dependencies (`db`, `marketData`),
 * so the worker bootstrap builds the full list by passing those in here.
 */
export function createJobDefinitions(deps: MarketDataJobDeps): readonly JobDefinition[] {
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
} from './heartbeat';

export {
  createAlertsEvaluateJob,
  ALERTS_EVALUATE_SCHEDULER_ID,
  ALERTS_EVALUATE_INTERVAL_MS,
  type AlertsJobDeps,
} from './alertsJob';

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
