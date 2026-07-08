import type { Database } from '../../data/db';
import { createAlertRepository } from '../../data/repositories/alertRepository';
import type { MarketDataService } from '../../providers';
import { runAlertsEvaluation } from '../../services/alerts/alertEvaluator';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `alerts.evaluate` — the §14 minute evaluator (V3-P10 arc b). Every minute it
 * loads every active price alert, reads each referenced asset's quote once from
 * the cached §5.3 core, and fires the ones whose rule is met — publishing
 * `alert.triggered` on the bus for the notification dispatcher to fan out.
 *
 * Built from `{ db, marketData }` like the other §9 jobs; the cross-cutting infra
 * (bus, Redis idempotency store, logger) comes from the {@link JobContext} at run
 * time.
 */

export const ALERTS_EVALUATE_SCHEDULER_ID = 'alerts.evaluate';
/** How often the evaluator runs (§14: "evaluated every minute"). */
export const ALERTS_EVALUATE_INTERVAL_MS = 60_000;

export interface AlertsJobDeps {
  db: Database;
  marketData: MarketDataService;
}

export function createAlertsEvaluateJob(deps: AlertsJobDeps): JobDefinition<'alerts.evaluate'> {
  const alertRepo = createAlertRepository(deps.db);
  return {
    name: QUEUE_NAMES.alertsEvaluate,
    schedule: { id: ALERTS_EVALUATE_SCHEDULER_ID, every: ALERTS_EVALUATE_INTERVAL_MS },
    async handler(job, ctx) {
      // Anchor the trigger window to the job's scheduled time so a run's fires
      // all share one (alert, window) idempotency bucket.
      const now = job.timestamp || Date.now();
      const result = await runAlertsEvaluation({
        alertRepo,
        marketData: deps.marketData,
        redis: ctx.redis,
        events: ctx.events,
        logger: ctx.logger,
        now: () => now,
      });
      ctx.logger.info(
        { evaluated: result.evaluated, fired: result.fired },
        'alerts.evaluate complete',
      );
    },
  };
}
