import {
  STANDING_ORDERS_SCAN_TZ,
  type StandingOrderService,
} from '../../services/standingOrders/standingOrderService';
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
 *
 * **Isolation, then retry.** The service isolates an unexpected per-order error
 * so the rest of the sweep still books, and reports it as `failed`. That tally
 * is not a mere log line: the handler logs it and then throws, so the standard
 * `attempts: 3` + exponential backoff (`options.ts`) re-runs the scan seconds
 * later — still inside the same calendar day, so the retry re-attempts the very
 * same period rather than letting it age into a reported drop — and a
 * persistently poisoned order ends up dead-lettered and on the admin Problems
 * page instead of masquerading as a green run. A retry cannot double-book: an
 * order booked in an earlier attempt exits on its watermark, and the run-ledger
 * claim catches it otherwise.
 *
 * Only `failed` fails the run. `deferred` is the designed graceful path (a
 * provider hiccup or insufficient cash) which already retries on the next daily
 * scan, and a post-claim booking failure is a deliberate at-most-once tombstone
 * that must never be retried — neither may turn into an immediate re-run.
 *
 * Idempotency key: `(standing_order_id, period_key)`, enforced by the unique
 * run-ledger claim before any money row is written.
 */

export const STANDING_ORDERS_SCHEDULER_ID = 'standingOrders.process';
/** Daily at 07:00 in the deploy timezone (after prices.refreshDaily / dividend scan). */
export const STANDING_ORDERS_CRON = '0 7 * * *';
/**
 * WHEN the scan fires and WHICH calendar day it books are one decision, so they
 * are one constant (#1793). Kept apart, a plausible containerisation edit
 * (`tz: 'UTC'` with a late-evening cron) resolved the fire instant in one zone
 * and `today` in another: a monthly order anchored on the 31st then skipped
 * March entirely and booked April a day early. Re-point
 * {@link STANDING_ORDERS_SCAN_TZ} to move both together, never one alone.
 */
export const STANDING_ORDERS_TZ = STANDING_ORDERS_SCAN_TZ;

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
      // Log first, so a failing run still reports everything that did book.
      ctx.logger.info(result, 'standingOrders.process complete');
      if (result.failed > 0) {
        // Deliberate trade-off: this re-runs the WHOLE sweep (bounded at 3
        // attempts). Booked orders exit on their watermark before any quote
        // fetch, so the extra cost is one uncached `pollQuote` per still-unbooked
        // buy per retry against the §5.3 budget — accepted for regaining the
        // retry → dead-letter coverage of a poisoned order.
        throw new Error(
          `standingOrders.process: ${result.failed}/${result.scanned} orders failed unexpectedly`,
        );
      }
    },
  };
}
