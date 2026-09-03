import type { MarketIntelRepository } from '../../data/repositories/marketIntelRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { MarketDataService } from '../../providers';
import { runEarningsReminderScan, type EarningsNotifyGate } from '../../services/marketIntel';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `notifications.earningsRemind` — the §13.5 V5-P5 daily earnings-reminder scan.
 * Once a day it sweeps every user's held + watched assets and emits the opt-in
 * `earnings.reminder` for those with a known report inside the lead window,
 * through the durable notification center (#368). Idempotency key:
 * `(user_id, asset_id, report_date)`; a per-key Redis lock + the dispatcher's
 * eventKey mean a daily re-scan across the multi-day window never re-notifies.
 *
 * The type is off by default, so the scan takes a per-user opt-in gate
 * ({@link earningsNotifyGate}) and skips a recipient who never enabled it — both
 * side effects (the lock and the dispatcher's hidden dedupe row) would otherwise
 * mask a later enable for that same report. Same rule as the dividend scan.
 *
 * Gated by `MARKET_INTEL_ENABLED`: off ⇒ the scan is a no-op (no reminders when
 * the arc is unconfigured). Built from
 * `{ db-repo, marketData, notify, isEnabled, enabled }` like the alert
 * evaluator; the Redis idempotency store + logger come from the
 * {@link JobContext} at run time.
 */

export const EARNINGS_REMINDER_SCHEDULER_ID = 'notifications.earningsRemind';
/** Daily at 06:00 Europe/Vienna — after the overnight price/refresh jobs. */
export const EARNINGS_REMINDER_CRON = '0 6 * * *';
export const EARNINGS_REMINDER_TZ = 'Europe/Vienna';

export interface EarningsReminderJobDeps {
  intelRepo: Pick<
    MarketIntelRepository,
    'listAllWatchAssets' | 'listNormalUserIds' | 'listUserWatchAndHoldAssets'
  >;
  marketData: Pick<MarketDataService, 'intelCapabilities' | 'getEarningsEvents'>;
  notify: NotificationCenter;
  /** Per-user opt-in gate (skip a recipient who never enabled the type). */
  isEnabled: EarningsNotifyGate;
  /** The `MARKET_INTEL_ENABLED` gate; false ⇒ the scan no-ops. */
  enabled: boolean;
  runIfAllowed: (userId: string, action: () => Promise<void>) => Promise<boolean>;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Build a per-user opt-in gate from the notification repository: enabled iff the
 * `earnings.reminder` type routes to at least one channel (mirrors
 * `dividendNotifyGate`).
 */
export function earningsNotifyGate(
  repo: Pick<NotificationRepository, 'routingFor'>,
): EarningsNotifyGate {
  return async (userId: string) => {
    const routing = await repo.routingFor(userId, 'earnings.reminder');
    return (
      routing.inapp ||
      routing.email ||
      routing.push ||
      routing.webpush ||
      routing.telegram ||
      routing.discord
    );
  };
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
      // The REAL execution instant. A repeatable job's creation `timestamp`
      // is stamped when BullMQ *creates* the delayed job — i.e. at the PREVIOUS
      // iteration's pickup, a full period (here: a day) stale. Reading that as
      // "now" would shift the whole lead window by that period.
      const now = job.processedOn ?? Date.now();
      const result = await runEarningsReminderScan({
        intelRepo: deps.intelRepo,
        marketData: deps.marketData,
        redis: ctx.redis,
        notify: deps.notify,
        isEnabled: deps.isEnabled,
        enabled: deps.enabled,
        runIfAllowed: deps.runIfAllowed,
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
