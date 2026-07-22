import {
  isAccountSecurityNotificationType,
  type DigestCadence,
  type NotificationCadence,
} from '@bettertrack/contracts';

import type { EventBus } from '../../events';
import type {
  AccountDataExportEvent,
  AccountTempPasswordEvent,
  AlertTriggeredEvent,
  BudgetExceededEvent,
  ChatMessageEvent,
  ConglomerateSharedEvent,
  DividendEventNotice,
  EarningsReminderEvent,
  FollowAlertCreatedEvent,
  FollowAlertFiredEvent,
  FollowPublishedEvent,
  FriendAcceptedEvent,
  FriendActivityEvent,
  FriendRequestEvent,
  MirrorNotificationEvent,
  PortfolioSharedEvent,
  WatchlistSharedEvent,
} from '../../events';
import type {
  NotificationRepository,
  TypeRouting,
} from '../../data/repositories/notificationRepository';
import type {
  EnqueueDeferredItemInput,
  EnqueueDigestItemInput,
} from '../../data/repositories/notificationDigestRepository';
import type { AlertNotificationContext } from '../../data/repositories/alertRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { alertBody, alertRuleSummary, alertTitle } from '../alerts/alertMessages';
import type { EmailService } from '../email/emailService';
import type { MirrorEmailVariant } from '../email/templates';
import type { Logger } from '../../logger';

import type { DiscordChannel } from './discordChannel';
import { digestPeriodKey } from './digestService';
import type { FcmChannel, PushMessage } from './fcm';
import type { PresenceStore } from './presence';
import { isInQuietHours, quietHoursWindowEnd } from './quietHours';
import { quietHoursConfigForUser } from './quietHoursConfig';
import type { TelegramChannel } from './telegramChannel';
import type { WebPushChannel } from './webPush';

/**
 * The central notification dispatcher (#368 Notifications v2; PROJECTPLAN.md
 * §6.10, §9, §14). ONE delivery core every notification-producing subsystem
 * feeds — never a per-source fork: an event arrives (via the durable
 * `notifications.dispatch` BullMQ job in production, directly in tests), the
 * dispatcher resolves the recipient's per-type × per-channel matrix and fans
 * out to the enabled channels: in-app inbox row, email, phone push (FCM),
 * browser push (web-push). Sources NEVER talk to channels directly.
 *
 * Delivery rules:
 *  - **Idempotent under at-least-once.** Every dispatch writes exactly one
 *    `notifications` row per (recipient, eventKey) — visible when in-app is
 *    routed, `hidden` (a pure dedupe marker) when it isn't — so a BullMQ retry
 *    or a duplicate emit re-reads the marker and no-ops. Channels after the
 *    marker are best-effort by design (the §6.10 email philosophy, extended to
 *    push): a transport failure logs and never throws back into the job.
 *  - **Global mute** (`users.notifications_muted`) suppresses every channel;
 *    only the hidden dedupe marker is written.
 *  - **Presence suppression** (#368 owner mandate): when the recipient is
 *    actively viewing the surface an event belongs to (v1: the chat
 *    conversation of a `chat.message`, TTL-bounded via {@link PresenceStore}),
 *    nothing notifies — the row persists already-read (no unread bump, no
 *    bell push, no email/push) and the message simply lands in the open thread.
 *  - **Defaults on.** A user with no settings row gets every channel; only an
 *    explicit override (or mute/presence) suppresses.
 *
 * The dispatcher is NOT a bus subscriber anymore: the Redis pub/sub bus stays
 * strictly ephemeral (realtime fan-out — it still carries the
 * `notification.created` bell push this dispatcher publishes after a visible
 * insert). Durable event transport is the BullMQ queue (`notificationCenter`).
 */

/** Every event the center turns into a matrix-routed notification. */
export type DispatchableEvent =
  | FriendRequestEvent
  | FriendAcceptedEvent
  | PortfolioSharedEvent
  | WatchlistSharedEvent
  | ConglomerateSharedEvent
  | FriendActivityEvent
  | FollowPublishedEvent
  | FollowAlertCreatedEvent
  | FollowAlertFiredEvent
  | AccountTempPasswordEvent
  | AccountDataExportEvent
  | AlertTriggeredEvent
  | EarningsReminderEvent
  | ChatMessageEvent
  | DividendEventNotice
  | BudgetExceededEvent
  | MirrorNotificationEvent;

/** The `type` strings the dispatcher accepts (guards the job payload). */
export const DISPATCHABLE_EVENT_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'watchlist.shared',
  'conglomerate.shared',
  'friend.activity',
  'follow.published',
  'follow.alert.created',
  'follow.alert.fired',
  'account.temp_password',
  'account.data_export',
  'alert.triggered',
  'earnings.reminder',
  'chat.message',
  'dividend.event',
  'budget.exceeded',
  'mirror.invite',
  'mirror.member_joined',
  'mirror.member_left',
  'mirror.member_removed',
  'mirror.removed',
  'mirror.ownership_transferred',
  'mirror.chain_dissolved',
  'mirror.sync_stalled',
] as const satisfies ReadonlyArray<DispatchableEvent['type']>;

export function isDispatchableEvent(event: { type: string }): event is DispatchableEvent {
  return (DISPATCHABLE_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Resolves an `alert.triggered` event's display context (asset + rule) at
 * dispatch time (§14). Injected so the dispatcher doesn't own the alert tables.
 * Returns null if the alert is already gone.
 */
export type AlertContextResolver = (alertId: string) => Promise<AlertNotificationContext | null>;

/** The rendered notification for one event, shared by all channels. */
interface RenderedNotification {
  eventKey: string;
  title: string;
  body: string;
  /** Inbox payload (carries `eventKey` — the §6.10 dedupe key). */
  payload: Record<string, unknown>;
  /** String-valued deep-link ids for the push channels' data message. */
  data: Record<string, string>;
  /** The alert's symbol — only set for `alert.triggered` (email subject). */
  alertSymbol?: string;
}

/**
 * The dedupe key per event: type + what makes the *logical* event unique.
 * Combined with the recipient userId (repo-side) this is §6.10's
 * "(user, event key)".
 */
function eventKeyFor(event: DispatchableEvent): string {
  switch (event.type) {
    case 'friend.request':
      return `friend.request:${event.requestId}`;
    case 'friend.accepted':
      return `friend.accepted:${event.requestId}`;
    case 'portfolio.shared':
      // Same item shared by the same owner is one logical event per friend;
      // the recipient userId (repo-side) keeps friends' rows distinct.
      return `portfolio.shared:${event.portfolioId}:${event.actorId}`;
    case 'watchlist.shared':
      return `watchlist.shared:${event.watchlistId}:${event.actorId}`;
    case 'conglomerate.shared':
      return `conglomerate.shared:${event.conglomerateId}:${event.actorId}`;
    case 'friend.activity':
      return `friend.activity:${event.refId}`;
    case 'follow.published':
      // Deduped per (follower, item, UTC day): the date folds into the key so a
      // followed user flapping an item public→private→public within a day never
      // re-notifies (#438 anti-noise), while a genuine re-publish on a later day
      // is a fresh key. The recipient userId (repo-side) keeps followers distinct.
      return `follow.published:${event.itemKind}:${event.itemId}:${event.occurredAt.slice(0, 10)}`;
    case 'follow.alert.created':
      // One creation per alert, ever — the alert id alone keys it; the
      // recipient userId (repo-side) keeps followers distinct.
      return `follow.alert.created:${event.alertId}`;
    case 'follow.alert.fired':
      // Deduped per (alert, trigger window) exactly like the owner's
      // `alert.triggered` below — a redelivered fire no-ops, a repeat alert's
      // next window is fresh.
      return `follow.alert.fired:${event.alertId}:${event.occurredAt.slice(0, 16)}`;
    case 'account.temp_password':
      // Every reset is a fresh notice — the timestamp keys the occurrence.
      return `account.temp_password:${event.occurredAt}`;
    case 'account.data_export':
      // Every completed export is a fresh notice — the timestamp keys it.
      return `account.data_export:${event.occurredAt}`;
    case 'alert.triggered':
      // Deduped per (alert, trigger window): the occurredAt minute folds in, so
      // a redelivered fire no-ops while a repeat alert's next window is fresh.
      return `alert.triggered:${event.alertId}:${event.occurredAt.slice(0, 16)}`;
    case 'earnings.reminder':
      // Deduped per (asset, report date): one reminder per upcoming report, so a
      // daily re-scan across the multi-day lead window never re-notifies. The
      // recipient userId (repo-side) keeps every holder/watcher's row distinct.
      return `earnings.reminder:${event.assetId}:${event.earningsDate.slice(0, 10)}`;
    case 'chat.message':
      return `chat.message:${event.messageId}`;
    case 'dividend.event':
      // Deduped per (recipient, asset, ex-date): the daily scan re-sees the same
      // upcoming event for days on end, but only the first emit surfaces; the
      // recipient userId (repo-side) keeps holders distinct.
      return `dividend.event:${event.assetId}:${event.exDate.slice(0, 10)}`;
    case 'budget.exceeded':
      // Deduped per (budget, period): the producer already claims the
      // `expense_budget_fires` marker before emitting, and this key backs it up
      // at the dispatch layer so a redelivered/duplicated emit no-ops — exactly
      // one alert per budget per month.
      return `budget.exceeded:${event.budgetId}:${event.period}`;
    case 'mirror.invite':
    case 'mirror.member_joined':
    case 'mirror.member_left':
    case 'mirror.member_removed':
    case 'mirror.removed':
    case 'mirror.ownership_transferred':
    case 'mirror.chain_dissolved':
    case 'mirror.sync_stalled':
      // Deduped per (chain, occurrence): `refId` is the invite id / target
      // member id / stalled-copy watermark, so a redelivered membership notice
      // no-ops while a later distinct occurrence gets a fresh key (design §11).
      // The recipient userId (repo-side) keeps every member's row distinct.
      return `${event.type}:${event.chainId}:${event.refId}`;
  }
}

/**
 * MIRRORCHAIN notice copy (EN — inbox strings are stored rendered like every
 * other type; the email localizes its own from the `mirror` copy block). Names
 * the chain and, where relevant, the member the notice is about (design §11).
 */
function mirrorCopy(event: MirrorNotificationEvent): { title: string; body: string } {
  const chain = event.chainName;
  const actor = event.actorUsername;
  switch (event.type) {
    case 'mirror.invite':
      return {
        title: 'Group portfolio invite',
        body: `${actor} invited you to join the group portfolio ${chain}.`,
      };
    case 'mirror.member_joined':
      return {
        title: `New member in ${chain}`,
        body: `${actor} joined the group portfolio ${chain}.`,
      };
    case 'mirror.member_left':
      return {
        title: `A member left ${chain}`,
        body: `${actor} left the group portfolio ${chain}.`,
      };
    case 'mirror.member_removed':
      return {
        title: `A member left ${chain}`,
        body: `${actor} was removed from the group portfolio ${chain}.`,
      };
    case 'mirror.removed':
      return {
        title: `Removed from ${chain}`,
        body: `You were removed from the group portfolio ${chain}. You keep your copy — it just stops syncing.`,
      };
    case 'mirror.ownership_transferred':
      return {
        title: `Ownership of ${chain} changed`,
        body: `${actor} is now the owner of the group portfolio ${chain}.`,
      };
    case 'mirror.chain_dissolved':
      return {
        title: `${chain} was dissolved`,
        body: `The group portfolio ${chain} was dissolved. You keep your copy — it just stops syncing.`,
      };
    case 'mirror.sync_stalled':
      return {
        title: `Syncing ${chain} is stuck`,
        body: `The group portfolio ${chain} could not finish syncing. Open it and choose Retry sync.`,
      };
  }
}

/**
 * Budget-exceeded copy (EN — inbox strings are stored rendered like every other
 * type). Names the blown category, the target and the recorded spend so the
 * notification reads on its own; amounts render in the budget's currency.
 */
function budgetExceededCopy(event: BudgetExceededEvent): { title: string; body: string } {
  const target = `${event.amount} ${event.currency}`;
  const spent = `${event.spent} ${event.currency}`;
  return {
    title: `Budget exceeded: ${event.categoryName}`,
    body: `You spent ${spent} on ${event.categoryName} this month — over your ${target} budget.`,
  };
}

/**
 * Localizable-free dividend-event copy (EN — the inbox strings are stored
 * rendered, like every other type). "in N days" reads naturally for the common
 * near-term reminder; the payout amount is appended when the provider reported it.
 */
function dividendEventCopy(event: DividendEventNotice): { title: string; body: string } {
  const amountPart =
    event.amount != null && event.currency ? ` (${event.amount} ${event.currency} per share)` : '';
  const exDay = event.exDate.slice(0, 10);
  return {
    title: `${event.symbol} ex-dividend ${exDay}`,
    body: `${event.symbol} goes ex-dividend on ${exDay}${amountPart}.`,
  };
}

/** The English noun for a followed item's kind (#438). */
function followItemNoun(itemKind: FollowPublishedEvent['itemKind']): string {
  switch (itemKind) {
    case 'portfolio':
      return 'portfolio';
    case 'watchlist':
      return 'watchlist';
    case 'conglomerate':
      return 'conglomerate';
    case 'idea':
      return 'idea';
  }
}

/** The follow-published title + body (EN — inbox strings are stored rendered). */
function followPublishedCopy(event: FollowPublishedEvent): { title: string; body: string } {
  const noun = followItemNoun(event.itemKind);
  return {
    title: `New ${noun} from ${event.actorUsername}`,
    body: `${event.actorUsername} published a new ${noun}: ${event.itemName}.`,
  };
}

/** The friend-activity body sentence (EN — inbox strings are stored rendered). */
function friendActivityBody(event: FriendActivityEvent): string {
  switch (event.activity) {
    case 'buy':
      return `${event.actorUsername} bought ${event.assetSymbol}.`;
    case 'sell':
      return `${event.actorUsername} sold ${event.assetSymbol}.`;
    case 'watchlist_add':
      return `${event.actorUsername} added ${event.assetSymbol} to a shared watchlist.`;
  }
}

export interface NotificationDispatcherDeps {
  /** Publishes the ephemeral `notification.created` bell push (§4.5). */
  bus: Pick<EventBus, 'publish'>;
  repo: NotificationRepository;
  /** Recipient lookup: email address, locale, global mute. */
  users: Pick<UserRepository, 'findById'>;
  /** Email channel (§6.10). Omit to disable email fan-out (e.g. in-app-only tests). */
  email?: EmailService;
  /** Resolves `alert.triggered` display context (§14). Omit to ignore alert events. */
  resolveAlert?: AlertContextResolver;
  /** Phone-push channel; null/omitted = not configured (#368). */
  fcm?: FcmChannel | null;
  /** Browser-push channel; null/omitted = not configured (#368/#350). */
  webPush?: WebPushChannel | null;
  /** Telegram channel; null/omitted = bot token unset (V4-P10). */
  telegram?: TelegramChannel | null;
  /** Discord channel; always built when webhooks storage is wired. Deliveries no-op for a user with no saved webhook (V4-P10). */
  discord?: DiscordChannel | null;
  /** Active-view presence (#368). Omit to disable suppression (never suppresses). */
  presence?: PresenceStore;
  /**
   * Digest cadence + queue (V5-P3). Governs the OUTBOUND channels only
   * (email/push/webpush): a `daily`/`weekly` type is written to the in-app bell
   * instantly as always, but its outbound copies are deferred into the digest
   * queue instead of sent now. Omit/null ⇒ every type resolves to `instant` and
   * the fan-out is byte-identical to the pre-digest behaviour.
   */
  digest?: {
    cadenceFor(userId: string, type: string): Promise<NotificationCadence>;
    enqueue(item: EnqueueDigestItemInput): Promise<void>;
  } | null;
  /**
   * Quiet hours (§13.5 V5-P3). When the recipient is inside their quiet-hours
   * window and the event is NOT in the urgent-bypass class
   * ({@link isAccountSecurityNotificationType}), an INSTANT-cadence outbound
   * notification is deferred into the deferral store instead of sent now, and
   * delivered at window end by the deferred-delivery job. The in-app bell is
   * NEVER affected (it already landed above). Digest-cadence items keep deferring
   * into the digest queue regardless — their quiet-hours handling is at delivery
   * time. Omit/null ⇒ quiet hours never defer (byte-identical pre-V5-P3 fan-out);
   * the recipient's window/timezone are read from the recipient row itself.
   */
  quietHours?: {
    enqueueDeferred(item: EnqueueDeferredItemInput): Promise<void>;
  } | null;
  /** Injectable clock (tests) for the quiet-hours + period decision. */
  now?: () => Date;
  logger?: Logger;
}

export interface NotificationDispatcher {
  /**
   * Deliver a single event through the matrix: dedupe, write the inbox row /
   * marker, fan out to the enabled channels. Safe under at-least-once
   * redelivery. Throws only when even the dedupe marker could not be written
   * (so the durable queue retries); channel failures never propagate.
   */
  dispatch(event: DispatchableEvent): Promise<void>;
}

export function createNotificationDispatcher(
  deps: NotificationDispatcherDeps,
): NotificationDispatcher {
  const {
    bus,
    repo,
    users,
    email,
    resolveAlert,
    fcm,
    webPush,
    telegram,
    discord,
    presence,
    digest,
    quietHours,
    logger,
  } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Render an event to its channel-shared strings. Async because the alert
   * context resolves at dispatch time; returns null when the event has nothing
   * to render (alert vanished, or alerts not wired here).
   */
  async function render(event: DispatchableEvent): Promise<RenderedNotification | null> {
    const eventKey = eventKeyFor(event);
    switch (event.type) {
      case 'friend.request':
        return {
          eventKey,
          title: 'New friend request',
          body: `${event.actorUsername} sent you a friend request.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            requestId: event.requestId,
          },
          data: { requestId: event.requestId },
        };
      case 'friend.accepted':
        return {
          eventKey,
          title: 'Friend request accepted',
          body: `${event.actorUsername} accepted your friend request.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            requestId: event.requestId,
          },
          data: { requestId: event.requestId },
        };
      case 'portfolio.shared':
        return {
          eventKey,
          title: 'Portfolio shared',
          body: `${event.actorUsername} shared their portfolio with friends.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            portfolioId: event.portfolioId,
          },
          data: { portfolioId: event.portfolioId },
        };
      case 'watchlist.shared':
        return {
          eventKey,
          title: 'Watchlist shared',
          body: `${event.actorUsername} shared a watchlist with you.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            watchlistId: event.watchlistId,
          },
          data: { watchlistId: event.watchlistId },
        };
      case 'conglomerate.shared':
        return {
          eventKey,
          title: 'Conglomerate shared',
          body: `${event.actorUsername} shared a conglomerate with you.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            conglomerateId: event.conglomerateId,
          },
          data: { conglomerateId: event.conglomerateId },
        };
      case 'friend.activity':
        return {
          eventKey,
          title: 'Friend activity',
          body: friendActivityBody(event),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            itemKind: event.itemKind,
            itemId: event.itemId,
            activity: event.activity,
            assetSymbol: event.assetSymbol,
          },
          // `username` (public-profile slug) mirrors `follow.published` so the
          // deep link lands on the actor's profile on both web and FCM (V4-P0c).
          data: {
            itemKind: event.itemKind,
            itemId: event.itemId,
            username: event.actorUsername,
          },
        };
      case 'follow.published': {
        const { title, body } = followPublishedCopy(event);
        return {
          eventKey,
          title,
          body,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            itemKind: event.itemKind,
            itemId: event.itemId,
            itemName: event.itemName,
          },
          // The public-profile slug (`username`) drives the deep link — a
          // newly-public item lives on the followed user's public profile.
          data: {
            itemKind: event.itemKind,
            itemId: event.itemId,
            username: event.actorUsername,
          },
        };
      }
      case 'follow.alert.created':
      case 'follow.alert.fired': {
        // Same dispatch-time context resolution as `alert.triggered`: the alert
        // vanished (or alerts aren't wired here) → nothing to render, no row.
        if (!resolveAlert) return null;
        const context = await resolveAlert(event.alertId);
        if (!context) return null;
        const rule = alertRuleSummary({
          kind: context.kind,
          symbol: context.symbol,
          threshold: context.threshold,
          currency: context.currency,
        });
        const created = event.type === 'follow.alert.created';
        return {
          eventKey,
          title: created
            ? `New alert from ${event.actorUsername}`
            : `${event.actorUsername}'s alert fired`,
          body: created
            ? `${event.actorUsername} created a price alert: ${rule}.`
            : `${event.actorUsername}'s price alert fired: ${rule}.`,
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            alertId: event.alertId,
            assetId: event.assetId,
            kind: context.kind,
          },
          data: { alertId: event.alertId, assetId: event.assetId },
          alertSymbol: context.symbol,
        };
      }
      case 'account.temp_password':
        return {
          eventKey,
          title: 'Password was reset',
          body: 'An administrator reset your password. Check your email for the temporary password.',
          payload: { eventKey },
          data: {},
        };
      case 'account.data_export':
        return {
          eventKey,
          title: 'Your data export is ready',
          body: 'Your account data export has finished. Open Settings → Account to download it.',
          payload: { eventKey },
          data: {},
        };
      case 'alert.triggered': {
        if (!resolveAlert) return null;
        const context = await resolveAlert(event.alertId);
        if (!context) return null;
        return {
          eventKey,
          title: alertTitle(context.symbol),
          body: alertBody({
            kind: context.kind,
            symbol: context.symbol,
            threshold: context.threshold,
            currency: context.currency,
          }),
          payload: {
            eventKey,
            alertId: event.alertId,
            assetId: event.assetId,
            kind: context.kind,
          },
          data: { alertId: event.alertId, assetId: event.assetId },
          alertSymbol: context.symbol,
        };
      }
      case 'earnings.reminder': {
        // Inbox strings are stored rendered (EN); the email localizes its own.
        const dateLabel = event.earningsDate.slice(0, 10);
        return {
          eventKey,
          title: `Earnings coming up: ${event.symbol}`,
          body: event.estimated
            ? `${event.name} (${event.symbol}) is expected to report earnings around ${dateLabel}.`
            : `${event.name} (${event.symbol}) reports earnings on ${dateLabel}.`,
          payload: {
            eventKey,
            assetId: event.assetId,
            symbol: event.symbol,
            earningsDate: event.earningsDate,
            estimated: event.estimated,
          },
          // Deep-links to the asset page (its earnings block) on web + push.
          data: { assetId: event.assetId },
        };
      }
      case 'chat.message':
        return {
          eventKey,
          title: 'New message',
          body: event.bodyPreview
            ? `${event.senderUsername}: ${event.bodyPreview}`
            : event.hasChip
              ? `${event.senderUsername} shared an item with you.`
              : `${event.senderUsername} sent you a message.`,
          payload: {
            eventKey,
            conversationId: event.conversationId,
            messageId: event.messageId,
            senderId: event.senderId,
            senderUsername: event.senderUsername,
          },
          data: { conversationId: event.conversationId, messageId: event.messageId },
        };
      case 'dividend.event': {
        const { title, body } = dividendEventCopy(event);
        return {
          eventKey,
          title,
          body,
          payload: {
            eventKey,
            assetId: event.assetId,
            symbol: event.symbol,
            exDate: event.exDate,
            payDate: event.payDate,
          },
          data: { assetId: event.assetId },
        };
      }
      case 'budget.exceeded': {
        const { title, body } = budgetExceededCopy(event);
        return {
          eventKey,
          title,
          body,
          payload: {
            eventKey,
            budgetId: event.budgetId,
            categoryId: event.categoryId,
            period: event.period,
            amount: event.amount,
            spent: event.spent,
            currency: event.currency,
          },
          // Deep-links to the expenses budgets surface on web + push.
          data: { categoryId: event.categoryId, period: event.period },
        };
      }
      case 'mirror.invite':
      case 'mirror.member_joined':
      case 'mirror.member_left':
      case 'mirror.member_removed':
      case 'mirror.removed':
      case 'mirror.ownership_transferred':
      case 'mirror.chain_dissolved':
      case 'mirror.sync_stalled': {
        const { title, body } = mirrorCopy(event);
        return {
          eventKey,
          title,
          body,
          payload: {
            eventKey,
            chainId: event.chainId,
            chainName: event.chainName,
            actorUsername: event.actorUsername,
            // The invite id for the Social request list deep link; the target
            // member id / stall watermark otherwise (design §11).
            refId: event.refId,
          },
          // Deep-links to the chain (its member sheet) on web + push; an invite
          // also carries its id so the push can open the Social request entry.
          data:
            event.type === 'mirror.invite'
              ? { chainId: event.chainId, inviteId: event.refId }
              : { chainId: event.chainId },
        };
      }
    }
  }

  /**
   * The surface an event belongs to for presence suppression. v1: only chat —
   * extend here to generalize ("actively viewing it → don't notify").
   */
  function presenceTarget(event: DispatchableEvent): { surface: 'chat'; id: string } | null {
    if (event.type === 'chat.message') return { surface: 'chat', id: event.conversationId };
    return null;
  }

  /**
   * Send the event's email in the recipient's stored locale (§13.3 V3-P1).
   * `account.temp_password` deliberately has NO dispatcher email: the
   * transactional mail carrying the credential is sent directly at the source
   * (never through the queue) and would only be duplicated here.
   */
  async function sendEmail(
    event: DispatchableEvent,
    rendered: RenderedNotification,
    recipient: { id: string; email: string; locale: string },
  ): Promise<void> {
    if (!email) return;
    const { email: to, id: userId, locale } = recipient;
    switch (event.type) {
      case 'friend.request':
        await email.sendFriendRequest({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'friend.accepted':
        await email.sendFriendAccepted({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'portfolio.shared':
        await email.sendPortfolioShared({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'watchlist.shared':
        await email.sendWatchlistShared({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'conglomerate.shared':
        await email.sendConglomerateShared({
          to,
          userId,
          actorUsername: event.actorUsername,
          locale,
        });
        return;
      case 'friend.activity':
        await email.sendFriendActivity({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.published':
        // The rendered body already names the actor + item; the email reuses it
        // verbatim in the recipient's locale (#438).
        await email.sendFollowPublished({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.alert.created':
        await email.sendFollowAlertCreated({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.alert.fired':
        await email.sendFollowAlertFired({ to, userId, body: rendered.body, locale });
        return;
      case 'alert.triggered':
        await email.sendAlertTriggered({
          to,
          userId,
          symbol: rendered.alertSymbol ?? '',
          body: rendered.body,
          locale,
        });
        return;
      case 'earnings.reminder':
        await email.sendEarningsReminder({
          to,
          userId,
          symbol: event.symbol,
          name: event.name,
          earningsDate: event.earningsDate,
          estimated: event.estimated,
          locale,
        });
        return;
      case 'chat.message':
        // Deliberately no message content (privacy) — just that one is waiting.
        await email.sendChatMessage({ to, userId, actorUsername: event.senderUsername, locale });
        return;
      case 'account.temp_password':
        return;
      case 'account.data_export':
        // No dispatcher email: the export-ready notice is in-app / push only
        // (the download is gated by a token the requester already holds, so an
        // email would carry no actionable link). Mirrors account.temp_password.
        return;
      case 'dividend.event':
        // The rendered body already names the asset + ex-date; the email reuses
        // it verbatim in the recipient's locale (V5-P5).
        await email.sendDividendEvent({ to, userId, body: rendered.body, locale });
        return;
      case 'budget.exceeded':
        // In-app / push only (its email cell is locked in the settings grid): a
        // budget alert is a lightweight nudge and the dashboards are the system
        // of record — no localized budget email template ships (V5-P9, issue 3/3).
        return;
      case 'mirror.invite':
      case 'mirror.member_joined':
      case 'mirror.member_left':
      case 'mirror.member_removed':
      case 'mirror.removed':
      case 'mirror.ownership_transferred':
      case 'mirror.chain_dissolved':
      case 'mirror.sync_stalled':
        // Fully localized from the `mirror` copy block (§13.5 V5-P7): the type's
        // suffix IS the email variant (`mirror.member_joined` → `member_joined`).
        await email.sendMirrorNotification({
          to,
          userId,
          variant: event.type.slice('mirror.'.length) as MirrorEmailVariant,
          chainName: event.chainName,
          actorUsername: event.actorUsername,
          locale,
        });
        return;
    }
  }

  async function dispatch(event: DispatchableEvent): Promise<void> {
    const rendered = await render(event);
    if (!rendered) return;

    const recipient = await users.findById(event.userId);
    if (!recipient) return;

    // At-least-once delivery: the (user, eventKey) row — visible or hidden — is
    // the durable dedupe marker for EVERY channel (§6.10, #368).
    if (await repo.existsForEventKey(event.userId, rendered.eventKey)) return;

    const muted = recipient.notificationsMuted;
    const routing: TypeRouting = await repo.routingFor(event.userId, event.type);

    // Presence suppression (#368): never on stale data — the store's TTL bounds
    // it. Errors fail open (deliver rather than swallow) and log.
    let suppressedByPresence = false;
    const target = presenceTarget(event);
    if (!muted && target && presence) {
      try {
        suppressedByPresence = await presence.isPresent(event.userId, target.surface, target.id);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'presence check failed; delivering normally');
      }
    }

    // The inbox row doubles as the dedupe marker, so ONE row is always written:
    //  - routed + live                → visible, unread, bell push
    //  - routed + presence-suppressed → visible, already read (it's on their screen)
    //  - in-app off / muted           → hidden marker, already read — presence
    //    never resurrects a channel the user routed off.
    const visible = !muted && routing.inapp;
    const alreadyRead = muted || suppressedByPresence || !routing.inapp;
    const notificationId = await repo.insert({
      userId: event.userId,
      type: event.type,
      title: rendered.title,
      body: rendered.body,
      payload: rendered.payload,
      hidden: !visible,
      readAt: alreadyRead ? new Date() : null,
    });
    // Insert lost the (user, eventKey) unique race — a concurrent dispatch of
    // the same event (second worker replica) already wrote the marker and is
    // handling the fan-out.
    if (!notificationId) return;

    if (visible && !alreadyRead) {
      // Ephemeral bell push (§4.5) — best-effort; the SPA poll catches up.
      try {
        await bus.publish({
          type: 'notification.created',
          userId: event.userId,
          notificationId,
          occurredAt: new Date().toISOString(),
        });
      } catch (err) {
        logger?.warn({ err, notificationId }, 'notification.created publish failed');
      }
    }

    if (muted || suppressedByPresence) return;

    // Outbound delivery cadence (V5-P3). `instant` (default, and always when no
    // digest wiring is present) delivers now — byte-identical to the pre-digest
    // fan-out below; `daily`/`weekly` defer the outbound channels into the
    // digest queue instead. The in-app row above already landed instantly
    // regardless: the bell is the record a digest summarizes.
    const cadence: NotificationCadence = digest
      ? await digest.cadenceFor(event.userId, event.type)
      : 'instant';
    // Non-null only when the outbound channels defer (daily/weekly) AND a digest
    // sink is wired; a single UTC period stamp per dispatch keeps every channel's
    // row in the same group (computed per user so quiet-hours can align later).
    const deferredCadence: DigestCadence | null =
      digest && (cadence === 'daily' || cadence === 'weekly') ? cadence : null;
    // The period stamp is computed in the recipient's timezone (V5-P3 quiet
    // hours) so a daily/weekly digest buckets by the user's LOCAL day; a user
    // with no timezone resolves to UTC — byte-identical to the pre-quiet-hours
    // stamp.
    const period = deferredCadence
      ? digestPeriodKey(deferredCadence, now(), recipient.timezone ?? null)
      : null;

    // Quiet hours (V5-P3): an INSTANT outbound notification fired inside the
    // recipient's window is deferred to window end — UNLESS it is in the urgent-
    // bypass class (account/security types). Digest-cadence items keep deferring
    // into the digest queue above; quiet hours handles them at delivery time. So
    // this only ever fires when the item is NOT already a digest deferral.
    const urgent = isAccountSecurityNotificationType(event.type);
    let quietDeferUntil: Date | null = null;
    if (quietHours && !urgent && deferredCadence === null) {
      const cfg = quietHoursConfigForUser(recipient);
      const nowDate = now();
      if (isInQuietHours(cfg, nowDate)) quietDeferUntil = quietHoursWindowEnd(cfg, nowDate);
    }

    // Channel fan-out past the marker is best-effort: each channel isolates its
    // own failure (§6.10 email philosophy) so one bad transport never blocks
    // the others — and never re-throws into the queue (the marker exists; a
    // retry would no-op anyway).
    if (routing.email && email && recipient.email) {
      if (digest && deferredCadence && period) {
        try {
          await digest.enqueue({
            userId: event.userId,
            type: event.type,
            channel: 'email',
            cadence: deferredCadence,
            period,
            title: rendered.title,
            body: rendered.body,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'digest email enqueue failed');
        }
      } else if (quietHours && quietDeferUntil) {
        try {
          await quietHours.enqueueDeferred({
            userId: event.userId,
            type: event.type,
            channel: 'email',
            title: rendered.title,
            body: rendered.body,
            deliverAfter: quietDeferUntil,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'quiet-hours email defer failed');
        }
      } else {
        try {
          await sendEmail(event, rendered, {
            id: recipient.id,
            email: recipient.email,
            locale: recipient.locale,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'notification email fan-out failed');
        }
      }
    }

    const pushMessage: PushMessage = {
      type: event.type,
      title: rendered.title,
      body: rendered.body,
      data: rendered.data,
    };
    if (routing.push && fcm) {
      if (digest && deferredCadence && period) {
        try {
          await digest.enqueue({
            userId: event.userId,
            type: event.type,
            channel: 'push',
            cadence: deferredCadence,
            period,
            title: rendered.title,
            body: rendered.body,
            data: rendered.data,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'digest push enqueue failed');
        }
      } else if (quietHours && quietDeferUntil) {
        try {
          await quietHours.enqueueDeferred({
            userId: event.userId,
            type: event.type,
            channel: 'push',
            title: rendered.title,
            body: rendered.body,
            data: rendered.data,
            deliverAfter: quietDeferUntil,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'quiet-hours push defer failed');
        }
      } else {
        try {
          await fcm.deliver(event.userId, pushMessage);
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'FCM fan-out failed');
        }
      }
    }
    if (routing.webpush && webPush) {
      if (digest && deferredCadence && period) {
        try {
          await digest.enqueue({
            userId: event.userId,
            type: event.type,
            channel: 'webpush',
            cadence: deferredCadence,
            period,
            title: rendered.title,
            body: rendered.body,
            data: rendered.data,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'digest web-push enqueue failed');
        }
      } else if (quietHours && quietDeferUntil) {
        try {
          await quietHours.enqueueDeferred({
            userId: event.userId,
            type: event.type,
            channel: 'webpush',
            title: rendered.title,
            body: rendered.body,
            data: rendered.data,
            deliverAfter: quietDeferUntil,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'quiet-hours web-push defer failed');
        }
      } else {
        try {
          await webPush.deliver(event.userId, pushMessage);
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'web-push fan-out failed');
        }
      }
    }
    // Telegram/Discord (globally deactivated) stay on the instant path — cadence
    // governs email/push/webpush only (V5-P3 scope).
    if (routing.telegram && telegram) {
      try {
        await telegram.deliver(event.userId, pushMessage);
      } catch (err) {
        // Secret-safe: the channel already sanitizes its own errors, but re-log
        // through the redactor here too (Pino serializes the `err` object).
        logger?.warn({ err, type: event.type }, 'telegram fan-out failed');
      }
    }
    if (routing.discord && discord) {
      try {
        await discord.deliver(event.userId, pushMessage);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'discord fan-out failed');
      }
    }
  }

  return { dispatch };
}
