import type { DigestService } from '../../services/notifications/digestService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * The V5-P3 digest jobs (#575). Two repeatable schedules render the deferred
 * daily/weekly notifications into ONE grouped summary per user per period:
 *
 *  - `notifications.digestDaily` — delivers each pending daily (user, period)
 *    group once that user's own local day has closed.
 *  - `notifications.digestWeekly` — the same for the weekly groups.
 *
 * Both are idempotent by construction: the digest service claims each group
 * atomically (stamping `delivered_at` as it reads), so a retry or a second
 * worker replica never double-sends.
 *
 * Both SCAN HOURLY rather than on a server-local morning cron (#1590). A digest
 * period is the RECIPIENT's local day/week (§16 2026-07-18) and the service only
 * claims a group after that user's own period has closed, so the scan cadence —
 * not the period key — is what decides when a boundary is observed. The former
 * single daily tick at 08:00 Europe/Vienna is 06:00 UTC, i.e. 23:00 the PREVIOUS
 * local day for every recipient at UTC−7 or further west: at the only moment
 * anyone looked, their period was still the current one, so the group was
 * skipped — a daily digest slipped a full extra day and a weekly one (re-tested
 * only on the next Monday tick) a full extra WEEK, every week. An hourly sweep
 * observes every zone's boundary within an hour of it closing, including the
 * :30/:45 offset zones. Landing in the recipient's morning is quiet hours' job
 * (§16 2026-07-18), not the cron hour's: a user with a window set has the
 * summary held to window end anyway.
 */

export const DIGEST_DAILY_SCHEDULER_ID = 'notifications.digestDaily';
export const DIGEST_WEEKLY_SCHEDULER_ID = 'notifications.digestWeekly';
/** How often both digest sweeps look for a closed (user, period) group. */
export const DIGEST_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * V5-P3 quiet hours (#579): the deferred-delivery schedule. Runs every minute so
 * a notification held back past a user's quiet-hours window arrives shortly after
 * window end. Cheap (a single indexed claim) and idempotent by construction — the
 * claim stamps `delivered_at`, so an overlapping run sends nothing extra.
 */
export const DEFERRED_DELIVERY_SCHEDULER_ID = 'notifications.deferredDelivery';
export const DEFERRED_DELIVERY_INTERVAL_MS = 60_000;

export interface DigestJobDeps {
  digest: DigestService;
}

export function createDigestDailyJob(
  deps: DigestJobDeps,
): JobDefinition<'notifications.digestDaily'> {
  return {
    name: QUEUE_NAMES.notificationsDigestDaily,
    schedule: { id: DIGEST_DAILY_SCHEDULER_ID, every: DIGEST_SCAN_INTERVAL_MS },
    async handler(_job, ctx) {
      const result = await deps.digest.deliverDue('daily');
      ctx.logger.info(result, 'notifications.digestDaily complete');
    },
  };
}

export function createDigestWeeklyJob(
  deps: DigestJobDeps,
): JobDefinition<'notifications.digestWeekly'> {
  return {
    name: QUEUE_NAMES.notificationsDigestWeekly,
    schedule: { id: DIGEST_WEEKLY_SCHEDULER_ID, every: DIGEST_SCAN_INTERVAL_MS },
    async handler(_job, ctx) {
      const result = await deps.digest.deliverDue('weekly');
      ctx.logger.info(result, 'notifications.digestWeekly complete');
    },
  };
}

export function createDeferredDeliveryJob(
  deps: DigestJobDeps,
): JobDefinition<'notifications.deferredDelivery'> {
  return {
    name: QUEUE_NAMES.notificationsDeferredDelivery,
    schedule: { id: DEFERRED_DELIVERY_SCHEDULER_ID, every: DEFERRED_DELIVERY_INTERVAL_MS },
    async handler(_job, ctx) {
      const result = await deps.digest.deliverDeferred();
      if (result.claimed > 0) {
        ctx.logger.info(result, 'notifications.deferredDelivery complete');
      }
    },
  };
}
