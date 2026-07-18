import type { DigestCadence } from '@bettertrack/contracts';

import type {
  DigestQueueItem,
  NotificationDigestRepository,
} from '../../data/repositories/notificationDigestRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { EmailService } from '../email/emailService';
import { notificationCopy, resolveEmailLocale } from '../email/emailI18n';
import type { Logger } from '../../logger';

import type { FcmChannel, PushMessage } from './fcm';
import type { WebPushChannel } from './webPush';

/**
 * Digest delivery (PROJECTPLAN.md §13.5 V5-P3). Renders the ONE grouped summary
 * per (user, period) that a daily/weekly cadence produced, honouring the channel
 * matrix by construction: an item only reached the queue for a channel it routes
 * to, so a type disabled for email is simply absent from the email digest.
 *
 * Idempotency lives in the repository: {@link NotificationDigestRepository.claimPeriod}
 * stamps `delivered_at` in the same UPDATE it returns the rows, so a re-run or a
 * second worker claims zero rows and no second send happens. Delivery itself is
 * best-effort past the claim (the §6.10 channel philosophy) — the in-app center
 * already holds every item as the durable record.
 */

/** The UTC period key an item is grouped under — `d:YYYY-MM-DD` / `w:GGGG-Www`. */
export function digestPeriodKey(cadence: DigestCadence, date: Date): string {
  if (cadence === 'daily') return `d:${date.toISOString().slice(0, 10)}`;
  return `w:${isoWeekKey(date)}`;
}

/** ISO-8601 week key (`GGGG-Www`) in UTC — the year is the ISO week-numbering year. */
function isoWeekKey(date: Date): string {
  // Copy to a UTC midnight to strip the time component.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO: Thursday determines the week-numbering year. getUTCDay(): 0=Sun..6=Sat.
  const dayNum = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // move to the Thursday of this week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export interface DigestDeliveryResult {
  /** (user, period) groups claimed this run. */
  groups: number;
  /** Email/push/webpush digests actually dispatched. */
  sent: number;
}

export interface DigestServiceDeps {
  repo: NotificationDigestRepository;
  /** Recipient lookup: email address + locale. */
  users: Pick<UserRepository, 'findById'>;
  /** Email channel; omit/null to skip the email digest. */
  email?: Pick<EmailService, 'sendDigest'> | null;
  /** Phone-push channel; null/omitted = not configured. */
  fcm?: Pick<FcmChannel, 'deliver'> | null;
  /** Browser-push channel; null/omitted = not configured. */
  webPush?: Pick<WebPushChannel, 'deliver'> | null;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => Date;
  logger?: Logger;
}

export interface DigestService {
  /**
   * Deliver every pending digest for a cadence: claim each (user, period) group
   * atomically, then render one email + one push + one web-push summary from the
   * claimed items grouped by channel. Returns per-run counts.
   */
  deliverDue(cadence: DigestCadence): Promise<DigestDeliveryResult>;
}

export function createDigestService(deps: DigestServiceDeps): DigestService {
  const { repo, users, email, fcm, webPush, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Build the summary push message for a channel's claimed items (localized). */
  function pushDigest(
    cadence: DigestCadence,
    items: DigestQueueItem[],
    locale: string,
  ): PushMessage {
    const copy = notificationCopy(resolveEmailLocale(locale)).digest;
    const title = cadence === 'daily' ? copy.pushTitleDaily : copy.pushTitleWeekly;
    const body = copy.pushBody.replace('{count}', String(items.length));
    return { type: 'notifications.digest', title, body, data: { cadence } };
  }

  return {
    async deliverDue(cadence): Promise<DigestDeliveryResult> {
      const groups = await repo.pendingGroups(cadence);
      let sent = 0;
      for (const group of groups) {
        // Atomic claim — a second worker on the same group gets nothing back.
        const items = await repo.claimPeriod(group.userId, group.period, cadence, now());
        if (items.length === 0) continue;

        const recipient = await users.findById(group.userId);
        if (!recipient) continue;
        const locale = recipient.locale ?? 'en';

        const emailItems = items.filter((i) => i.channel === 'email');
        const pushItems = items.filter((i) => i.channel === 'push');
        const webpushItems = items.filter((i) => i.channel === 'webpush');

        if (emailItems.length > 0 && email && recipient.email) {
          try {
            await email.sendDigest({
              to: recipient.email,
              userId: recipient.id,
              cadence,
              items: emailItems.map((i) => ({ title: i.title, body: i.body })),
              locale,
            });
            sent += 1;
          } catch (err) {
            logger?.warn({ err, cadence }, 'digest email delivery failed');
          }
        }
        if (pushItems.length > 0 && fcm) {
          try {
            await fcm.deliver(recipient.id, pushDigest(cadence, pushItems, locale));
            sent += 1;
          } catch (err) {
            logger?.warn({ err, cadence }, 'digest FCM delivery failed');
          }
        }
        if (webpushItems.length > 0 && webPush) {
          try {
            await webPush.deliver(recipient.id, pushDigest(cadence, webpushItems, locale));
            sent += 1;
          } catch (err) {
            logger?.warn({ err, cadence }, 'digest web-push delivery failed');
          }
        }
      }
      return { groups: groups.length, sent };
    },
  };
}
