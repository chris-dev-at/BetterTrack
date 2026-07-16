import type { EventBus } from '../../events';
import type {
  AccountDataExportEvent,
  AccountTempPasswordEvent,
  AlertTriggeredEvent,
  ChatMessageEvent,
  ConglomerateSharedEvent,
  FollowAlertCreatedEvent,
  FollowAlertFiredEvent,
  FollowPublishedEvent,
  FriendAcceptedEvent,
  FriendActivityEvent,
  FriendRequestEvent,
  PortfolioSharedEvent,
  WatchlistSharedEvent,
} from '../../events';
import type {
  NotificationRepository,
  TypeRouting,
} from '../../data/repositories/notificationRepository';
import type { AlertNotificationContext } from '../../data/repositories/alertRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { alertBody, alertRuleSummary, alertTitle } from '../alerts/alertMessages';
import type { EmailService } from '../email/emailService';
import type { Logger } from '../../logger';

import type { DiscordChannel } from './discordChannel';
import type { FcmChannel, PushMessage } from './fcm';
import type { PresenceStore } from './presence';
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
  | ChatMessageEvent;

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
  'chat.message',
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
    case 'chat.message':
      return `chat.message:${event.messageId}`;
  }
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
    logger,
  } = deps;

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

    // Channel fan-out past the marker is best-effort: each channel isolates its
    // own failure (§6.10 email philosophy) so one bad transport never blocks
    // the others — and never re-throws into the queue (the marker exists; a
    // retry would no-op anyway).
    if (routing.email && email && recipient.email) {
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

    const pushMessage: PushMessage = {
      type: event.type,
      title: rendered.title,
      body: rendered.body,
      data: rendered.data,
    };
    if (routing.push && fcm) {
      try {
        await fcm.deliver(event.userId, pushMessage);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'FCM fan-out failed');
      }
    }
    if (routing.webpush && webPush) {
      try {
        await webPush.deliver(event.userId, pushMessage);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'web-push fan-out failed');
      }
    }
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
