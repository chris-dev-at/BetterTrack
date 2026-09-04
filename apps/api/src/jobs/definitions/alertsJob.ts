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
 *
 * **Kill switch (§6.12, §13.5 V5-P2 arc (c)).** This is the producer the
 * `alerts` switch owns, declared through `featureFlag` and shed centrally in
 * `runJobDefinition`. Flipped OFF, a scheduled run does not load alerts, does
 * not quote, does not fire and does not enqueue — and takes no `(alert, window)`
 * idempotency key, so no window is burnt while the switch is off.
 *
 * **Semantics across the off-window (pinned).** Nothing is queued up and
 * replayed on resume: the evaluator is level-triggered on the CURRENT quote, so
 * the first run after the switch goes back ON fires every alert whose rule the
 * quote still meets, and a condition that was true only while the switch was off
 * is lost. Alerts themselves are untouched by the off-window — a one-shot alert
 * stays `active` (it never flipped to `triggered`) and a repeat alert takes no
 * cooldown — so nothing is silently skipped forever: the alert is still armed
 * and fires on the next run whose quote meets it. Replaying missed windows would
 * mean firing "price crossed 100" notifications minutes or hours late, for a
 * price that has since moved, which is worse than the miss.
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
      // The `alerts` kill switch (§6.12) owns this producer, not just the
      // `/alerts` router: flipped OFF, the whole run is shed by
      // `runJobDefinition` before this handler is entered.
      featureFlag: 'alerts',
      async handler(job, ctx) {
        // Anchor the trigger window to the run's execution instant so a run's
        // fires all share one (alert, window) idempotency bucket. NOT the job's
        // creation `timestamp`: BullMQ stamps that when the delayed job is
        // created, i.e. at the previous iteration's pickup, one full period ago.
        const now = job.processedOn ?? Date.now();
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
