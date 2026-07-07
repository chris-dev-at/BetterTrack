import type { EventBus, Unsubscribe } from '../../events';
import type {
  AlertTriggeredEvent,
  FriendAcceptedEvent,
  FriendRequestEvent,
  PortfolioSharedEvent,
} from '../../events';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { AlertNotificationContext } from '../../data/repositories/alertRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { alertBody, alertTitle } from '../alerts/alertMessages';
import type { EmailService } from '../email/emailService';
import type { Logger } from '../../logger';

/**
 * Notification dispatcher (PROJECTPLAN.md §9, §6.10). Subscribes to the V1
 * social domain events and fans each out to the recipient's enabled channels:
 * an **in-app** notification row and, when the email channel is enabled, an
 * email via {@link EmailService} (which writes the `email_log` row).
 *
 * Rules from §6.10:
 *  - **In-app and email are on by default.** A user with no
 *    `notification_settings` row for a channel still gets it; only an explicit
 *    `enabled = false` suppresses that channel.
 *  - **Deduped per (user, event key).** Each event has a deterministic
 *    {@link eventKeyFor} key stamped into the in-app row's `payload.eventKey`;
 *    an at-least-once redelivery finds the row and no-ops, so neither a
 *    duplicate row nor a duplicate email is produced.
 *  - **Email is best-effort.** {@link EmailService} never throws (it logs the
 *    attempt as sent/failed/suppressed), so a mail problem never blocks the
 *    in-app row or the consumer.
 *
 * A new consumer subscribes without touching producers (§9): the dispatcher is a
 * pure subscriber over the typed bus.
 */

/** The social events the dispatcher fans out to in-app notifications. */
export type SocialDispatchEvent = FriendRequestEvent | FriendAcceptedEvent | PortfolioSharedEvent;

/** Every event the dispatcher turns into a matrix-routed notification (§6.10, §14). */
export type DispatchableEvent = SocialDispatchEvent | AlertTriggeredEvent;

const DISPATCHED_EVENT_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'alert.triggered',
] as const satisfies ReadonlyArray<DispatchableEvent['type']>;

/**
 * Resolves an `alert.triggered` event's display context (asset + rule) at
 * dispatch time (§14). Injected so the dispatcher stays a thin bus subscriber
 * and doesn't own the alert tables. Returns null if the alert is already gone.
 */
export type AlertContextResolver = (alertId: string) => Promise<AlertNotificationContext | null>;

/** The rendered in-app notification for a dispatchable event. */
interface RenderedNotification {
  eventKey: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

/**
 * The dedupe key for an event: type + the identifier that makes the *logical*
 * event unique. Combined with the recipient `userId` (applied by the repository)
 * this is the "(user, event key)" of §6.10.
 */
function eventKeyFor(event: SocialDispatchEvent): string {
  switch (event.type) {
    case 'friend.request':
      return `friend.request:${event.requestId}`;
    case 'friend.accepted':
      return `friend.accepted:${event.requestId}`;
    case 'portfolio.shared':
      // Same portfolio shared by the same owner is one logical event per friend;
      // the recipient userId (repo-side) keeps friends' rows distinct.
      return `portfolio.shared:${event.portfolioId}:${event.actorId}`;
  }
}

/** Render the human-readable in-app notification for a social event (§6.10). */
function render(event: SocialDispatchEvent): RenderedNotification {
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
      };
  }
}

export interface NotificationDispatcherDeps {
  bus: EventBus;
  repo: NotificationRepository;
  /** Email channel (§6.10). Omit to disable email fan-out (e.g. in-app-only tests). */
  email?: EmailService;
  /** Resolves the recipient's address for the email channel. Required with `email`. */
  users?: Pick<UserRepository, 'findById'>;
  /** Resolves `alert.triggered` display context (§14). Omit to ignore alert events. */
  resolveAlert?: AlertContextResolver;
  logger?: Logger;
}

export interface NotificationDispatcher {
  /** Subscribe to the dispatchable events. Idempotent — a second call re-subscribes only once. */
  start(): Promise<void>;
  /** Drop all subscriptions. */
  stop(): Promise<void>;
  /**
   * Handle a single event: resolve the recipient's in-app setting, dedupe, and
   * insert. Exposed for direct/synchronous testing without a pub/sub round-trip.
   */
  dispatch(event: DispatchableEvent): Promise<void>;
}

export function createNotificationDispatcher(
  deps: NotificationDispatcherDeps,
): NotificationDispatcher {
  const { bus, repo, email, users, resolveAlert, logger } = deps;
  const unsubscribers: Unsubscribe[] = [];

  /**
   * Announce a freshly-written in-app row on the bus (§4.5): the realtime
   * gateway maps `notification.created` to a `notification.new` push in the
   * recipient's `user:{id}` room. Published only when the matrix actually
   * produced a row, so a bell-muted type never pushes. Best-effort — the row is
   * already persisted and the SPA's poll fallback catches up regardless.
   */
  async function publishCreated(userId: string, notificationId: string): Promise<void> {
    try {
      await bus.publish({
        type: 'notification.created',
        userId,
        notificationId,
        occurredAt: new Date().toISOString(),
      });
    } catch (err) {
      logger?.warn({ err, notificationId }, 'notification.created publish failed');
    }
  }

  /** Send the event's email on the recipient's enabled email channel (§6.10). */
  async function sendEmail(event: SocialDispatchEvent): Promise<void> {
    if (!email || !users) return;
    // Per-type × channel matrix (§6.10): email fans out only when this type is
    // routed to email. Defaults on; an explicit per-type override (or a
    // channel-wide off) suppresses it.
    if (!(await repo.typeChannelEnabled(event.userId, event.type, 'email'))) return;
    const recipient = await users.findById(event.userId);
    if (!recipient?.email) return;

    const to = recipient.email;
    const userId = recipient.id;
    switch (event.type) {
      case 'friend.request':
        await email.sendFriendRequest({ to, userId, actorUsername: event.actorUsername });
        return;
      case 'friend.accepted':
        await email.sendFriendAccepted({ to, userId, actorUsername: event.actorUsername });
        return;
      case 'portfolio.shared':
        await email.sendPortfolioShared({ to, userId, actorUsername: event.actorUsername });
        return;
    }
  }

  /**
   * Fan out a fired price alert (§14). Deduped per (user, trigger window):
   * the event's `occurredAt` minute is folded into the event key, so an
   * at-least-once redelivery of the same fire no-ops while a genuinely later
   * fire (a repeat alert's next 24 h window) still produces a fresh row.
   */
  async function dispatchAlert(event: AlertTriggeredEvent): Promise<void> {
    if (!resolveAlert) return;
    const context = await resolveAlert(event.alertId);
    if (!context) return;

    const eventKey = `alert.triggered:${event.alertId}:${event.occurredAt.slice(0, 16)}`;
    if (await repo.existsForEventKey(event.userId, eventKey)) return;

    const title = alertTitle(context.symbol);
    const body = alertBody({
      kind: context.kind,
      symbol: context.symbol,
      threshold: context.threshold,
      currency: context.currency,
    });
    const payload = {
      eventKey,
      alertId: event.alertId,
      assetId: event.assetId,
      kind: context.kind,
    };

    if (await repo.typeChannelEnabled(event.userId, 'alert.triggered', 'inapp')) {
      const notificationId = await repo.insert({
        userId: event.userId,
        type: 'alert.triggered',
        title,
        body,
        payload,
      });
      await publishCreated(event.userId, notificationId);
    }

    if (
      email &&
      users &&
      (await repo.typeChannelEnabled(event.userId, 'alert.triggered', 'email'))
    ) {
      const recipient = await users.findById(event.userId);
      if (recipient?.email) {
        await email.sendAlertTriggered({
          to: recipient.email,
          userId: recipient.id,
          symbol: context.symbol,
          body,
        });
      }
    }
  }

  async function dispatch(event: DispatchableEvent): Promise<void> {
    if (event.type === 'alert.triggered') {
      await dispatchAlert(event);
      return;
    }

    const { eventKey, title, body, payload } = render(event);
    // At-least-once delivery: a redelivered event must not fan out twice — the
    // in-app row is the dedupe marker for both channels (§6.10).
    if (await repo.existsForEventKey(event.userId, eventKey)) return;

    // Per-type × channel matrix (§6.10): the in-app bell row is written only when
    // this type is routed to in-app. Defaults on; an explicit per-type override
    // (bell-off / muted) suppresses it.
    if (await repo.typeChannelEnabled(event.userId, event.type, 'inapp')) {
      const notificationId = await repo.insert({
        userId: event.userId,
        type: event.type,
        title,
        body,
        payload,
      });
      await publishCreated(event.userId, notificationId);
    }

    await sendEmail(event);
  }

  return {
    async start(): Promise<void> {
      if (unsubscribers.length > 0) return;
      for (const type of DISPATCHED_EVENT_TYPES) {
        const unsubscribe = await bus.subscribe(type, (event) => {
          void dispatch(event as DispatchableEvent).catch((err) => {
            logger?.error({ err, type }, 'notification dispatch failed');
          });
        });
        unsubscribers.push(unsubscribe);
      }
    },

    async stop(): Promise<void> {
      const pending = unsubscribers.splice(0, unsubscribers.length);
      await Promise.allSettled(pending.map((unsubscribe) => unsubscribe()));
    },

    dispatch,
  };
}
