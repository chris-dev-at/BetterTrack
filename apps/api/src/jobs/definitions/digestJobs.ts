import type { DigestService } from '../../services/notifications/digestService';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * The V5-P3 digest jobs (#575). Two repeatable schedules render the deferred
 * daily/weekly notifications into ONE grouped summary per user per period:
 *
 *  - `notifications.digestDaily` — every morning; delivers each pending daily
 *    (user, period) group.
 *  - `notifications.digestWeekly` — Monday mornings; delivers the weekly groups.
 *
 * Both are idempotent by construction: the digest service claims each group
 * atomically (stamping `delivered_at` as it reads), so a retry or a second
 * worker replica never double-sends. The boundary times are fixed server crons
 * for now — the quiet-hours follow-up adds per-user timezone alignment (the
 * period key is already computed per user so that change stays small).
 */

export const DIGEST_DAILY_SCHEDULER_ID = 'notifications.digestDaily';
export const DIGEST_DAILY_CRON = '0 8 * * *';
export const DIGEST_WEEKLY_SCHEDULER_ID = 'notifications.digestWeekly';
export const DIGEST_WEEKLY_CRON = '0 8 * * 1';
export const DIGEST_TZ = 'Europe/Vienna';

export interface DigestJobDeps {
  digest: DigestService;
}

export function createDigestDailyJob(
  deps: DigestJobDeps,
): JobDefinition<'notifications.digestDaily'> {
  return {
    name: QUEUE_NAMES.notificationsDigestDaily,
    schedule: { id: DIGEST_DAILY_SCHEDULER_ID, pattern: DIGEST_DAILY_CRON, tz: DIGEST_TZ },
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
    schedule: { id: DIGEST_WEEKLY_SCHEDULER_ID, pattern: DIGEST_WEEKLY_CRON, tz: DIGEST_TZ },
    async handler(_job, ctx) {
      const result = await deps.digest.deliverDue('weekly');
      ctx.logger.info(result, 'notifications.digestWeekly complete');
    },
  };
}
