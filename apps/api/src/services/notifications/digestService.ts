import type { DigestCadence } from '@bettertrack/contracts';

import type {
  DigestQueueItem,
  EnqueueDeferredItemInput,
  NotificationDigestRepository,
} from '../../data/repositories/notificationDigestRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { EmailService } from '../email/emailService';
import { notificationCopy, resolveEmailLocale } from '../email/emailI18n';
import type { Logger } from '../../logger';

import type { FcmChannel, PushMessage } from './fcm';
import { isInQuietHours, quietHoursWindowEnd, zonedCalendarDate } from './quietHours';
import { quietHoursConfigForUser } from './quietHoursConfig';
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

/**
 * The period key an item is grouped under — `d:YYYY-MM-DD` / `w:GGGG-Www` — in
 * the user's LOCAL calendar (§13.5 V5-P3 quiet hours). `timezone` null (a user
 * with none set) computes in UTC, byte-identical to the pre-quiet-hours digest.
 * With a timezone set, a daily digest buckets by the user's local day so it
 * lands in their morning, not a server-global hour.
 */
export function digestPeriodKey(
  cadence: DigestCadence,
  date: Date,
  timezone: string | null = null,
): string {
  const { year, month, day } = zonedCalendarDate(date, timezone);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  if (cadence === 'daily') return `d:${year}-${mm}-${dd}`;
  // ISO-week math operates on the calendar date only: pin the local Y/M/D to a
  // UTC midnight and run the standard ISO-8601 week computation on it.
  return `w:${isoWeekKey(new Date(Date.UTC(year, month - 1, day)))}`;
}

/** ISO-8601 week key (`GGGG-Www`) — the year is the ISO week-numbering year. */
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
  /** (user, period) groups claimed and processed this run (sent or deferred). */
  groups: number;
  /** Email/push/webpush digests actually dispatched now (excludes deferrals). */
  sent: number;
  /** Digest summaries deferred to a user's quiet-hours window end (§13.5 V5-P3). */
  deferred: number;
}

export interface DeferredDeliveryResult {
  /** Deferred rows claimed this run (all due rows). */
  claimed: number;
  /** Email/push/webpush deferrals actually dispatched. */
  sent: number;
}

export interface DigestServiceDeps {
  repo: NotificationDigestRepository;
  /** Recipient lookup: email + locale + quiet-hours/timezone columns. */
  users: Pick<UserRepository, 'findById'>;
  /** Email channel; omit/null to skip the email digest. */
  email?: Pick<EmailService, 'sendDigest' | 'sendDeferred'> | null;
  /** Phone-push channel; null/omitted = not configured. */
  fcm?: Pick<FcmChannel, 'deliver'> | null;
  /** Browser-push channel; null/omitted = not configured. */
  webPush?: Pick<WebPushChannel, 'deliver'> | null;
  /**
   * Quiet-hours deferral (§13.5 V5-P3). When a digest's delivery moment falls
   * inside the recipient's quiet-hours window, its per-channel summary is queued
   * here (deliver_after = window end) instead of sent now — the deferred-delivery
   * job sends it at window end. Omit/null ⇒ quiet hours never defer a digest
   * (the pre-quiet-hours behaviour; existing users have quiet hours off anyway).
   */
  quietHours?: Pick<NotificationDigestRepository, 'enqueueDeferred'> | null;
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
  /**
   * Deliver every quiet-hours-deferred item now due (§13.5 V5-P3): claim the due
   * rows atomically and send each INDIVIDUALLY (email as a single notification,
   * push/webpush as the same message). Idempotent (the claim stamps
   * `delivered_at`) and restart-safe (pending rows persist in the DB).
   */
  deliverDeferred(): Promise<DeferredDeliveryResult>;
}

export function createDigestService(deps: DigestServiceDeps): DigestService {
  const { repo, users, email, fcm, webPush, quietHours, logger } = deps;
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

  /**
   * Render the deferred summary a quiet-hours-blocked digest carries per channel
   * (§13.5 V5-P3). The deferred-delivery job sends this as a single message at
   * window end: email as generic title+body, push/webpush as the same message
   * the digest would have pushed. Content mirrors the digest (localized chrome,
   * the already-rendered item strings), so nothing is lost across the defer.
   */
  function deferredSummaryRow(
    cadence: DigestCadence,
    channel: DigestQueueItem['channel'],
    items: DigestQueueItem[],
    locale: string,
    userId: string,
    deliverAfter: Date,
  ): EnqueueDeferredItemInput {
    const copy = notificationCopy(resolveEmailLocale(locale)).digest;
    if (channel === 'email') {
      const title = cadence === 'daily' ? copy.subjectDaily : copy.subjectWeekly;
      const body = items.map((i) => `${i.title}: ${i.body}`).join('\n');
      return { userId, type: 'notifications.digest', channel, title, body, deliverAfter };
    }
    const message = pushDigest(cadence, items, locale);
    return {
      userId,
      type: 'notifications.digest',
      channel,
      title: message.title,
      body: message.body,
      data: message.data,
      deliverAfter,
    };
  }

  return {
    async deliverDue(cadence): Promise<DigestDeliveryResult> {
      // Every currently-pending group for this cadence; completeness is decided
      // per user below (a user's local period must have closed) because with
      // timezone alignment "the current period" differs per recipient.
      const nowDate = now();
      const groups = await repo.pendingGroups(cadence);
      let sent = 0;
      let deferred = 0;
      let processed = 0;
      for (const group of groups) {
        const recipient = await users.findById(group.userId);
        if (!recipient) continue;
        const tz = recipient.timezone ?? null;
        // Deliver only *complete* periods: the cron does not sit on the local
        // period boundary, so claiming the still-accumulating current period
        // would split a day/week across two runs (and double-send). Skipping it
        // yields exactly one summary per period, the run after that period closes.
        if (group.period >= digestPeriodKey(cadence, nowDate, tz)) continue;

        // Atomic claim — a second worker on the same group gets nothing back.
        const items = await repo.claimPeriod(group.userId, group.period, cadence, nowDate);
        if (items.length === 0) continue;
        processed += 1;
        const locale = recipient.locale ?? 'en';

        // Quiet hours (§13.5 V5-P3): a digest whose delivery moment lands inside
        // the user's window is itself deferred to window end — re-queued as a
        // per-channel deferred summary the deferred-delivery job sends then.
        const cfg = quietHoursConfigForUser(recipient);
        const deferUntil =
          quietHours && isInQuietHours(cfg, nowDate) ? quietHoursWindowEnd(cfg, nowDate) : null;

        const emailItems = items.filter((i) => i.channel === 'email');
        const pushItems = items.filter((i) => i.channel === 'push');
        const webpushItems = items.filter((i) => i.channel === 'webpush');

        if (emailItems.length > 0 && email && recipient.email) {
          if (deferUntil && quietHours) {
            await quietHours.enqueueDeferred(
              deferredSummaryRow(cadence, 'email', emailItems, locale, recipient.id, deferUntil),
            );
            deferred += 1;
          } else {
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
        }
        if (pushItems.length > 0 && fcm) {
          if (deferUntil && quietHours) {
            await quietHours.enqueueDeferred(
              deferredSummaryRow(cadence, 'push', pushItems, locale, recipient.id, deferUntil),
            );
            deferred += 1;
          } else {
            try {
              await fcm.deliver(recipient.id, pushDigest(cadence, pushItems, locale));
              sent += 1;
            } catch (err) {
              logger?.warn({ err, cadence }, 'digest FCM delivery failed');
            }
          }
        }
        if (webpushItems.length > 0 && webPush) {
          if (deferUntil && quietHours) {
            await quietHours.enqueueDeferred(
              deferredSummaryRow(
                cadence,
                'webpush',
                webpushItems,
                locale,
                recipient.id,
                deferUntil,
              ),
            );
            deferred += 1;
          } else {
            try {
              await webPush.deliver(recipient.id, pushDigest(cadence, webpushItems, locale));
              sent += 1;
            } catch (err) {
              logger?.warn({ err, cadence }, 'digest web-push delivery failed');
            }
          }
        }
      }
      return { groups: processed, sent, deferred };
    },

    async deliverDeferred(): Promise<DeferredDeliveryResult> {
      // Claim every due row atomically up front — the claim is the idempotency
      // barrier, so a delivery that throws afterwards never redelivers (the
      // in-app center already holds each item as the durable record).
      const items = await repo.claimDueDeferred(now());
      let sent = 0;
      for (const item of items) {
        const recipient = await users.findById(item.userId);
        if (!recipient) continue;
        const locale = recipient.locale ?? 'en';
        if (item.channel === 'email') {
          if (email && recipient.email) {
            try {
              await email.sendDeferred({
                to: recipient.email,
                userId: recipient.id,
                title: item.title,
                body: item.body,
                locale,
              });
              sent += 1;
            } catch (err) {
              logger?.warn({ err, type: item.type }, 'deferred email delivery failed');
            }
          }
          continue;
        }
        const message: PushMessage = {
          type: item.type,
          title: item.title,
          body: item.body,
          data: item.data ?? {},
        };
        if (item.channel === 'push' && fcm) {
          try {
            await fcm.deliver(item.userId, message);
            sent += 1;
          } catch (err) {
            logger?.warn({ err, type: item.type }, 'deferred FCM delivery failed');
          }
        } else if (item.channel === 'webpush' && webPush) {
          try {
            await webPush.deliver(item.userId, message);
            sent += 1;
          } catch (err) {
            logger?.warn({ err, type: item.type }, 'deferred web-push delivery failed');
          }
        }
      }
      return { claimed: items.length, sent };
    },
  };
}
