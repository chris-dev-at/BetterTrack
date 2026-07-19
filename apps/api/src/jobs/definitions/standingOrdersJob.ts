import type { StandingOrderService } from '../../services/standingOrders/standingOrderService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `standingOrders.process` — the daily standing-orders scan (PROJECTPLAN.md
 * §13.5 V5-P6b arc (a), issue #593). Once a day it books every active order's
 * single most-recent due occurrence exactly once ({@link
 * StandingOrderService.processDueOrders}); the per-period claim makes it safe to
 * re-run (a manual re-trigger, a BullMQ retry, or a worker restart never
 * double-books). It runs after the morning price refresh so a buy's quote is
 * fresh, and degrades gracefully — a per-order provider failure or insufficient
 * cash just defers that period to the next run, never aborting the sweep.
 */

export const STANDING_ORDERS_SCHEDULER_ID = 'standingOrders.process';
/** Daily at 07:00 in the deploy timezone (after prices.refreshDaily / dividend scan). */
export const STANDING_ORDERS_CRON = '0 7 * * *';
export const STANDING_ORDERS_TZ = 'Europe/Vienna';

export interface StandingOrdersJobDeps {
  standingOrders: Pick<StandingOrderService, 'processDueOrders'>;
}

export function createStandingOrdersJob(
  deps: StandingOrdersJobDeps,
): JobDefinition<'standingOrders.process'> {
  return {
    name: QUEUE_NAMES.standingOrdersProcess,
    schedule: {
      id: STANDING_ORDERS_SCHEDULER_ID,
      pattern: STANDING_ORDERS_CRON,
      tz: STANDING_ORDERS_TZ,
    },
    async handler(_job, ctx) {
      const result = await deps.standingOrders.processDueOrders();
      ctx.logger.info(result, 'standingOrders.process complete');
    },
  };
}
