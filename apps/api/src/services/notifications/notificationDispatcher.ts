import type { EventBus, Unsubscribe } from '../../events';
import type { FriendAcceptedEvent, FriendRequestEvent, PortfolioSharedEvent } from '../../events';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { Logger } from '../../logger';

/**
 * Notification dispatcher (PROJECTPLAN.md §9, §6.10). Subscribes to the V1
 * social domain events and turns each into an **in-app** notification row for the
 * recipient. Email delivery + `email_log` and the other channels land in a
 * follow-up; this consumer only fans out to the in-app channel.
 *
 * Two rules from §6.10:
 *  - **In-app is on by default.** A user with no `notification_settings` row for
 *    the in-app channel still gets in-app notifications; only an explicit
 *    `enabled = false` suppresses them.
 *  - **Deduped per (user, event key).** Each event has a deterministic
 *    {@link eventKeyFor} key stamped into the row's `payload.eventKey`; an
 *    at-least-once redelivery of the same event finds the row and no-ops, so no
 *    duplicate is written.
 *
 * A new consumer subscribes without touching producers (§9): the dispatcher is a
 * pure subscriber over the typed bus.
 */

/** The three social events the V1 dispatcher fans out to in-app notifications. */
export type DispatchableEvent = FriendRequestEvent | FriendAcceptedEvent | PortfolioSharedEvent;

const DISPATCHED_EVENT_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
] as const satisfies ReadonlyArray<DispatchableEvent['type']>;

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
function eventKeyFor(event: DispatchableEvent): string {
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

/** Render the human-readable in-app notification for an event (§6.10). */
function render(event: DispatchableEvent): RenderedNotification {
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
  const { bus, repo, logger } = deps;
  const unsubscribers: Unsubscribe[] = [];

  async function dispatch(event: DispatchableEvent): Promise<void> {
    // In-app is on by default: only an explicit `false` suppresses it (§6.10).
    const enabled = await repo.channelEnabled(event.userId, 'inapp');
    if (enabled === false) return;

    const { eventKey, title, body, payload } = render(event);
    // At-least-once delivery: a redelivered event must not double-insert (§6.10).
    if (await repo.existsForEventKey(event.userId, eventKey)) return;

    await repo.insert({ userId: event.userId, type: event.type, title, body, payload });
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
