import { isUrgentNotification, type DigestCadence } from '@bettertrack/contracts';

import type {
  DigestChannel,
  DigestQueueItem,
  EnqueueDeferredItemInput,
  NotificationDigestRepository,
} from '../../data/repositories/notificationDigestRepository';
import type {
  NotificationRepository,
  TypeRouting,
} from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { EmailService } from '../email/emailService';
import { notificationCopy, resolveEmailLocale } from '../email/emailI18n';
import type { Logger } from '../../logger';

import { notificationTypeShipsEmail } from './emailTypeRules';
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
 *
 * Everything a queued item was decided against at ENQUEUE time is re-evaluated
 * at RELEASE time (#1590), because a queue row can outlive the settings that
 * produced it: the global mute, the channel matrix, and — for a quiet-hours
 * deferral — the window itself. `deliver_after` is a frozen instant, so a user
 * who moves their timezone or window between defer and release would otherwise
 * be woken inside their NEW quiet window, the precise outcome quiet hours exist
 * to prevent; such a row is re-deferred to the new window end instead of sent.
 * That re-evaluation covers a deferred digest SUMMARY too (#1696): it carries a
 * manifest of the types it summarizes, so the matrix is re-checked against those
 * rather than waved through on the synthetic summary type.
 */

/**
 * The synthetic type a rendered digest summary carries. It is not a matrix type
 * — its constituent items were already routed at enqueue — so it cannot be fed
 * to the release-time matrix re-check directly; a summary is checked against the
 * types it CARRIES instead (see {@link DIGEST_SUMMARY_ITEMS_KEY}).
 */
export const DIGEST_SUMMARY_TYPE = 'notifications.digest';

/**
 * Reserved `data` key on a quiet-hours-deferred digest summary (#1696): the
 * manifest of the items that summary carries, so the release-time matrix
 * re-check can resolve the real types behind {@link DIGEST_SUMMARY_TYPE}. Pure
 * bookkeeping — it is stripped from the outbound push payload — and it rides in
 * the existing `data` column, so no migration is involved.
 */
export const DIGEST_SUMMARY_ITEMS_KEY = 'digestItems';

/** One item a deferred summary carries: its matrix type + its rendered line. */
interface CarriedDigestItem {
  type: string;
  /** The `title: body` line an email summary renders for it (email rows only). */
  line?: string;
}

/** The manifest for the items a summary of `channel` is about to carry. */
function carriedItemsOf(
  channel: DigestChannel,
  items: readonly DigestQueueItem[],
): CarriedDigestItem[] {
  return items.map((item) =>
    channel === 'email'
      ? { type: item.type, line: `${item.title}: ${item.body}` }
      : { type: item.type },
  );
}

/** The manifest as the row's `data` payload. */
function encodeCarried(carried: readonly CarriedDigestItem[]): Record<string, string> {
  return { [DIGEST_SUMMARY_ITEMS_KEY]: JSON.stringify(carried) };
}

/**
 * The manifest a claimed row carries, or `null` when it has none — a summary
 * queued before #1696, or anything unparseable. `null` means "no manifest to
 * check", which keeps the pre-#1696 behaviour (delivered as queued) rather than
 * silently dropping a row whose types cannot be resolved.
 */
function decodeCarried(data: Record<string, string> | null): CarriedDigestItem[] | null {
  const raw = data?.[DIGEST_SUMMARY_ITEMS_KEY];
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const carried: CarriedDigestItem[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { type, line } = entry as { type?: unknown; line?: unknown };
    if (typeof type !== 'string' || type.length === 0) return null;
    carried.push(typeof line === 'string' ? { type, line } : { type });
  }
  return carried.length > 0 ? carried : null;
}

/** The email summary body: one rendered line per carried item. */
function emailSummaryBody(carried: readonly CarriedDigestItem[]): string {
  return carried
    .map((item) => item.line ?? '')
    .filter((line) => line.length > 0)
    .join('\n');
}

/** A push payload never carries this module's own bookkeeping key outbound. */
function pushData(data: Record<string, string> | null): Record<string, string> {
  if (!data) return {};
  const rest = { ...data };
  delete rest[DIGEST_SUMMARY_ITEMS_KEY];
  return rest;
}

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
  /** Rows dropped at release: the recipient muted the type/channel meanwhile. */
  dropped: number;
  /** Rows re-deferred: the recipient's CURRENT window still covers now (#1590). */
  requeued: number;
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
  /**
   * Channel matrix as of RELEASE time (#1590). A queued item was routed when it
   * was enqueued, but the user may have turned that (type, channel) off since —
   * re-resolving here drops it instead of delivering a notification the user has
   * already switched off. Omit/null ⇒ no re-check (the pre-#1590 behaviour); the
   * global mute is read off the recipient row and is always honoured.
   */
  routing?: Pick<NotificationRepository, 'routingFor'> | null;
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
   *
   * Due is necessary, not sufficient (#1590): a claimed row is dropped if the
   * recipient has muted it since, and re-deferred to the CURRENT window end if
   * their (possibly since-changed) quiet-hours window covers this moment.
   */
  deliverDeferred(): Promise<DeferredDeliveryResult>;
}

export function createDigestService(deps: DigestServiceDeps): DigestService {
  const { repo, users, email, fcm, webPush, quietHours, routing, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Whether a claimed item's (type, channel) is STILL routed on, resolved once
   * per (user, type) within a run (#1590). Without the `routing` dep the answer
   * is yes — only an explicit off wins. {@link DIGEST_SUMMARY_TYPE} is not a
   * matrix type and never resolves here: a summary is checked against its
   * carried types instead (#1696), and a pre-#1696 summary with no manifest
   * keeps the old "deliver it" answer.
   */
  async function stillRouted(
    userId: string,
    type: string,
    channel: DigestChannel,
    cache: Map<string, TypeRouting>,
  ): Promise<boolean> {
    // A type that ships no e-mail is not deliverable on the e-mail channel, no
    // matter what the matrix says (#1816). The dispatcher no longer enqueues
    // such a row, so this only catches rows queued before that fix — and the
    // admin account-defaults grid, which can still persist the cell.
    if (channel === 'email' && !notificationTypeShipsEmail(type)) return false;
    if (!routing || type === DIGEST_SUMMARY_TYPE) return true;
    const key = `${userId} ${type}`;
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = await routing.routingFor(userId, type);
      cache.set(key, resolved);
    }
    return resolved[channel];
  }

  /** Build the summary push message for a channel's claimed items (localized). */
  function pushDigest(
    cadence: DigestCadence,
    items: DigestQueueItem[],
    locale: string,
  ): PushMessage {
    const copy = notificationCopy(resolveEmailLocale(locale)).digest;
    const title = cadence === 'daily' ? copy.pushTitleDaily : copy.pushTitleWeekly;
    return {
      type: DIGEST_SUMMARY_TYPE,
      title,
      body: pushSummaryBody(items.length, locale),
      data: { cadence },
    };
  }

  /** The push summary body for `count` items, localized. */
  function pushSummaryBody(count: number, locale: string): string {
    return notificationCopy(resolveEmailLocale(locale)).digest.pushBody.replace(
      '{count}',
      String(count),
    );
  }

  /**
   * Render the deferred summary a quiet-hours-blocked digest carries per channel
   * (§13.5 V5-P3). The deferred-delivery job sends this as a single message at
   * window end: email as generic title+body, push/webpush as the same message
   * the digest would have pushed. Content mirrors the digest (localized chrome,
   * the already-rendered item strings), so nothing is lost across the defer.
   *
   * The row also carries the manifest of the items it summarizes (#1696), which
   * is what lets the release-time matrix re-check resolve real types rather than
   * the synthetic summary type.
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
    const carried = carriedItemsOf(channel, items);
    if (channel === 'email') {
      const title = cadence === 'daily' ? copy.subjectDaily : copy.subjectWeekly;
      return {
        userId,
        type: DIGEST_SUMMARY_TYPE,
        channel,
        title,
        body: emailSummaryBody(carried),
        data: encodeCarried(carried),
        deliverAfter,
      };
    }
    const message = pushDigest(cadence, items, locale);
    return {
      userId,
      type: DIGEST_SUMMARY_TYPE,
      channel,
      title: message.title,
      body: message.body,
      data: { ...message.data, ...encodeCarried(carried) },
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
      const routingCache = new Map<string, TypeRouting>();
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
        const claimed = await repo.claimPeriod(group.userId, group.period, cadence, nowDate);
        if (claimed.length === 0) continue;
        processed += 1;
        const locale = recipient.locale ?? 'en';

        // Re-evaluate the suppression settings at RELEASE time (#1590): a queue
        // row can outlive the routing that produced it. A global mute drops the
        // whole group, a (type, channel) turned off since drops just that item —
        // dropped, not re-queued: the claim already consumed them and the in-app
        // bell holds each one as the durable record.
        if (recipient.notificationsMuted) continue;
        const items: DigestQueueItem[] = [];
        for (const item of claimed) {
          if (await stillRouted(item.userId, item.type, item.channel, routingCache)) {
            items.push(item);
          }
        }
        if (items.length === 0) continue;

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
            try {
              await quietHours.enqueueDeferred(
                deferredSummaryRow(cadence, 'email', emailItems, locale, recipient.id, deferUntil),
              );
              deferred += 1;
            } catch (err) {
              logger?.warn(
                { err, cadence, userId: recipient.id, period: group.period, channel: 'email' },
                'quiet-hours digest defer failed',
              );
            }
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
            try {
              await quietHours.enqueueDeferred(
                deferredSummaryRow(cadence, 'push', pushItems, locale, recipient.id, deferUntil),
              );
              deferred += 1;
            } catch (err) {
              logger?.warn(
                { err, cadence, userId: recipient.id, period: group.period, channel: 'push' },
                'quiet-hours digest defer failed',
              );
            }
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
            try {
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
            } catch (err) {
              logger?.warn(
                { err, cadence, userId: recipient.id, period: group.period, channel: 'webpush' },
                'quiet-hours digest defer failed',
              );
            }
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
      const nowDate = now();
      const items = await repo.claimDueDeferred(nowDate);
      const routingCache = new Map<string, TypeRouting>();
      let sent = 0;
      let dropped = 0;
      let requeued = 0;
      for (const item of items) {
        const recipient = await users.findById(item.userId);
        if (!recipient) continue;

        // Release-time re-evaluation (#1590). The stored `deliver_after` froze
        // the window as it stood at enqueue, and the matrix/mute may have moved
        // since — so mute, routing and the quiet-hours window are ALL resolved
        // against the recipient row as of now.
        if (recipient.notificationsMuted) {
          dropped += 1;
          continue;
        }
        const locale = recipient.locale ?? 'en';
        // A deferred digest SUMMARY is re-checked against the types it carries
        // (#1696), not against its synthetic type: these are the longest-lived
        // rows in the table — a whole quiet window sits between the enqueue-time
        // routing decision and this moment — so exempting them defeats the
        // release-time re-check precisely where it matters most. Items whose
        // (type, channel) went off meanwhile are dropped from the summary, which
        // is re-rendered from what remains; nothing left ⇒ the whole row is
        // dropped, exactly as the grouped path drops a claimed item. A row with
        // no manifest (queued before #1696) keeps the old behaviour.
        const carried = item.type === DIGEST_SUMMARY_TYPE ? decodeCarried(item.data) : null;
        let body = item.body;
        if (carried) {
          const routed: CarriedDigestItem[] = [];
          for (const entry of carried) {
            if (await stillRouted(item.userId, entry.type, item.channel, routingCache)) {
              routed.push(entry);
            }
          }
          if (routed.length === 0) {
            dropped += 1;
            continue;
          }
          if (routed.length < carried.length) {
            body =
              item.channel === 'email'
                ? emailSummaryBody(routed)
                : pushSummaryBody(routed.length, locale);
          }
        } else if (!(await stillRouted(item.userId, item.type, item.channel, routingCache))) {
          dropped += 1;
          continue;
        }
        const cfg = quietHoursConfigForUser(recipient);
        if (
          quietHours &&
          !isUrgentNotification({ type: item.type }) &&
          isInQuietHours(cfg, nowDate)
        ) {
          // The recipient changed timezone or window after the defer and is
          // asleep again (or still): re-defer to the CURRENT window end rather
          // than delivering inside the new window. The claim stays stamped, so
          // the re-queued row is the only live copy — never a duplicate.
          try {
            await quietHours.enqueueDeferred({
              userId: item.userId,
              type: item.type,
              channel: item.channel,
              title: item.title,
              body: item.body,
              data: item.data,
              deliverAfter: quietHoursWindowEnd(cfg, nowDate),
            });
            requeued += 1;
          } catch (err) {
            logger?.warn(
              { err, type: item.type, userId: item.userId, channel: item.channel },
              'quiet-hours deferral re-defer failed',
            );
          }
          continue;
        }
        if (item.channel === 'email') {
          if (email && recipient.email) {
            try {
              await email.sendDeferred({
                to: recipient.email,
                userId: recipient.id,
                title: item.title,
                body,
                // The row's own type + deep-link ids, so the e-mail links to the
                // notification's target rather than the app root (#1816).
                type: item.type,
                data: item.data,
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
          body,
          // The carried-items manifest is bookkeeping for the re-check above —
          // it never reaches the device.
          data: pushData(item.data),
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
      return { claimed: items.length, sent, dropped, requeued };
    },
  };
}
