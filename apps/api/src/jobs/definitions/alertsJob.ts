import type { Database } from '../../data/db';
import { createAlertRepository } from '../../data/repositories/alertRepository';
import { createUserFollowsRepository } from '../../data/repositories/userFollowsRepository';
import type { MarketDataService } from '../../providers';
import type { ParanoidModeGuard } from '../../services/account/paranoidEnforcement';
import { runAlertsEvaluation } from '../../services/alerts/alertEvaluator';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import { bindParanoidJob } from '../paranoidJobs';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `alerts.evaluate` — the §14 minute evaluator (V3-P10 arc b). Every minute it
 * loads every active price alert, reads each referenced asset's quote once from
 * the cached §5.3 core, and fires the ones whose rule is met — emitting
 * `alert.triggered` through the notification center onto the DURABLE
 * `notifications.dispatch` queue (#368; never the at-most-once bus).
 *
 * Built from `{ db, marketData, notify }` like the other §9 jobs; the
 * cross-cutting infra (Redis idempotency store, logger) comes from the
 * {@link JobContext} at run time.
 */

export const ALERTS_EVALUATE_SCHEDULER_ID = 'alerts.evaluate';
/** How often the evaluator runs (§14: "evaluated every minute"). */
export const ALERTS_EVALUATE_INTERVAL_MS = 60_000;

export interface AlertsJobDeps {
  db: Database;
  marketData: MarketDataService;
  /** The central notification pipeline (#368) — fires are enqueued durably. */
  notify: NotificationCenter;
  /**
   * Filters the evaluator's account-owned rails: the custom-asset alerts it
   * may evaluate at all, and the follower-sharing fan-out on every fire.
   */
  paranoid: Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
}

export function createAlertsEvaluateJob(deps: AlertsJobDeps): JobDefinition<'alerts.evaluate'> {
  const alertRepo = createAlertRepository(deps.db);
  // Alert-follow fire fan-out (#455): opted-in followers of a sharing owner
  // receive `follow.alert.fired` in addition to the owner's own delivery.
  const followsRepo = createUserFollowsRepository(deps.db);
  // `internallyFiltered` (registry): the queue as a whole stays alive for
  // global market alerts, and the evaluator itself scopes every account-owned
  // read/side effect under that account's transition lock. The binding is what
  // makes that declaration a proof obligation instead of a comment.
  return bindParanoidJob(
    {
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
          notify: deps.notify,
          paranoid: deps.paranoid,
          followFanout: {
            follows: followsRepo,
            paranoid: deps.paranoid,
          },
          logger: ctx.logger,
          now: () => now,
        });
        ctx.logger.info(
          { evaluated: result.evaluated, fired: result.fired },
          'alerts.evaluate complete',
        );
      },
    },
    { mode: 'internallyFiltered' },
  );
}
