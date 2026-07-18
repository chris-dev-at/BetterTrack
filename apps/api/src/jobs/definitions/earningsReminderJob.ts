import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { MarketDataService } from '../../providers';
import { runEarningsReminderScan } from '../../services/marketIntel';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `notifications.earningsRemind` — the §13.5 V5-P5 daily earnings-reminder scan.
 * Once a day it sweeps every user's held + watched assets and emits the opt-in
 * `earnings.reminder` for those with a known report inside the lead window,
 * through the durable notification center (#368). Idempotent per (user, asset,
 * report date): a per-key Redis lock + the dispatcher's eventKey mean a daily
 * re-scan across the multi-day window never re-notifies.
 *
 * Gated by `MARKET_INTEL_ENABLED`: off ⇒ the scan is a no-op (no reminders when
 * the arc is unconfigured). Built from `{ db-repo, marketData, notify, enabled }`
 * like the alert evaluator; the Redis idempotency store + logger come from the
 * {@link JobContext} at run time.
 */

export const EARNINGS_REMINDER_SCHEDULER_ID = 'notifications.earningsRemind';
/** Daily at 06:00 Europe/Vienna — after the overnight price/refresh jobs. */
export const EARNINGS_REMINDER_CRON = '0 6 * * *';
export const EARNINGS_REMINDER_TZ = 'Europe/Vienna';

export interface EarningsReminderJobDeps {
  intelRepo: Pick<MarketIntelRepository, 'listAllWatchAndHoldAssets'>;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getEarningsEvents'>;
  notify: NotificationCenter;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ the scan no-ops. */
  enabled: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export function createEarningsReminderJob(
  deps: EarningsReminderJobDeps,
): JobDefinition<'notifications.earningsRemind'> {
  return {
    name: QUEUE_NAMES.earningsRemind,
    schedule: {
      id: EARNINGS_REMINDER_SCHEDULER_ID,
      pattern: EARNINGS_REMINDER_CRON,
      tz: EARNINGS_REMINDER_TZ,
    },
    async handler(job, ctx) {
      const now = job.timestamp || Date.now();
      const result = await runEarningsReminderScan({
        intelRepo: deps.intelRepo,
        marketData: deps.marketData,
        redis: ctx.redis,
        notify: deps.notify,
        enabled: deps.enabled,
        logger: ctx.logger,
        now: () => (deps.now ? deps.now() : now),
      });
      ctx.logger.info(
        { scanned: result.scanned, reminded: result.reminded },
        'notifications.earningsRemind complete',
      );
    },
  };
}
