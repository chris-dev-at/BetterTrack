import type { Redis } from 'ioredis';

import type { Logger } from '../logger';

import type { DomainEvent, DomainEventOf, DomainEventType } from './types';

/**
 * Typed domain event bus over Redis pub/sub (PROJECTPLAN.md §9, §4.5).
 *
 * One Redis channel backs each event type (`bt:events:{type}`), so a subscriber
 * only receives traffic for the types it asked for. Publishing is fire-and-forget
 * across the cluster; delivery is at-most-once (pub/sub, not a durable queue) —
 * anything that must survive a restart goes through BullMQ, not the bus.
 *
 * Redis requires a **dedicated** connection in subscriber mode (a subscribed
 * connection cannot issue ordinary commands), so the bus is constructed with a
 * separate `publisher` and `subscriber` connection. {@link EventBus.close} quits
 * both.
 */

export const EVENT_CHANNEL_PREFIX = 'bt:events:';

/** The Redis pub/sub channel that carries a given event type. */
export function channelForType(type: DomainEventType): string {
  return `${EVENT_CHANNEL_PREFIX}${type}`;
}

/** Recover the event type from a channel name, or `null` if it is not ours. */
export function typeForChannel(channel: string): DomainEventType | null {
  if (!channel.startsWith(EVENT_CHANNEL_PREFIX)) return null;
  return channel.slice(EVENT_CHANNEL_PREFIX.length) as DomainEventType;
}

/** Handler for events of a single type `T`. May be sync or async. */
export type EventHandler<T extends DomainEventType> = (
  event: DomainEventOf<T>,
) => void | Promise<void>;

/** Removes a previously-registered subscription. Idempotent. */
export type Unsubscribe = () => Promise<void>;

export interface EventBus {
  /** Publish a typed domain event to its channel. */
  publish(event: DomainEvent): Promise<void>;
  /**
   * Subscribe to every event of `type`. The returned function unsubscribes that
   * one handler; the underlying Redis channel is dropped once its last handler
   * unsubscribes.
   */
  subscribe<T extends DomainEventType>(type: T, handler: EventHandler<T>): Promise<Unsubscribe>;
  /** Quit both Redis connections. */
  close(): Promise<void>;
}

export interface CreateEventBusDeps {
  /** Ordinary connection used only to PUBLISH. */
  publisher: Redis;
  /** Dedicated connection put into subscriber mode. */
  subscriber: Redis;
  logger?: Logger;
}

// Stored without the per-type generic so handlers of different types can share
// one Set; each handler is only ever invoked with events from its own channel.
type AnyHandler = (event: DomainEvent) => void | Promise<void>;

export function createEventBus(deps: CreateEventBusDeps): EventBus {
  const { publisher, subscriber, logger } = deps;
  const handlers = new Map<DomainEventType, Set<AnyHandler>>();
  let listenerAttached = false;

  function dispatch(channel: string, message: string): void {
    const type = typeForChannel(channel);
    if (type === null) return;
    const set = handlers.get(type);
    if (!set || set.size === 0) return;

    let event: DomainEvent;
    try {
      event = JSON.parse(message) as DomainEvent;
    } catch {
      logger?.warn({ channel }, 'event bus: dropped unparseable message');
      return;
    }

    // Snapshot so a handler that unsubscribes mid-dispatch doesn't mutate the
    // set we're iterating.
    for (const handler of [...set]) {
      // A throwing/rejecting handler must never take down the process or starve
      // its siblings — isolate each one.
      void Promise.resolve()
        .then(() => handler(event))
        .catch((err) => {
          logger?.error({ err, type }, 'event bus: subscriber handler failed');
        });
    }
  }

  function ensureListener(): void {
    if (listenerAttached) return;
    listenerAttached = true;
    subscriber.on('message', dispatch);
  }

  return {
    async publish(event: DomainEvent): Promise<void> {
      await publisher.publish(channelForType(event.type), JSON.stringify(event));
    },

    async subscribe<T extends DomainEventType>(
      type: T,
      handler: EventHandler<T>,
    ): Promise<Unsubscribe> {
      ensureListener();
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
        await subscriber.subscribe(channelForType(type));
      }
      set.add(handler as AnyHandler);

      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        set.delete(handler as AnyHandler);
        if (set.size === 0) {
          handlers.delete(type);
          await subscriber.unsubscribe(channelForType(type));
        }
      };
    },

    async close(): Promise<void> {
      handlers.clear();
      await Promise.allSettled([subscriber.quit(), publisher.quit()]);
    },
  };
}
