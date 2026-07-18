import type { UsageAnalyticsService } from '../../services/analytics/usageAnalyticsService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * The V5-P2 usage-analytics rollup job (#567, §13.5 arc (b)). Nightly at 03:10
 * Europe/Vienna it re-materializes the trailing usage-rollup window from the raw
 * `usage_events` into `usage_daily` — the aggregates the admin usage-analytics
 * page serves. Idempotent: each run replaces the affected days' rows, so a
 * re-run (or a crash+retry) converges to the same materialized state. Late data
 * (events flushed after a day's first roll) is healed by the trailing window.
 */
export const USAGE_ROLLUP_SCHEDULER_ID = 'usage.rollup';
export const USAGE_ROLLUP_CRON = '10 3 * * *';
export const USAGE_ROLLUP_TZ = 'Europe/Vienna';

export interface UsageRollupJobDeps {
  usageAnalytics: UsageAnalyticsService;
}

export function createUsageRollupJob(deps: UsageRollupJobDeps): JobDefinition<'usage.rollup'> {
  return {
    name: QUEUE_NAMES.usageRollup,
    schedule: {
      id: USAGE_ROLLUP_SCHEDULER_ID,
      pattern: USAGE_ROLLUP_CRON,
      tz: USAGE_ROLLUP_TZ,
    },
    async handler(_job, ctx) {
      // Persist anything still buffered, then re-materialize the recent window.
      await deps.usageAnalytics.flush();
      await deps.usageAnalytics.rollupRecent();
      ctx.logger.info('usage.rollup complete');
    },
  };
}
