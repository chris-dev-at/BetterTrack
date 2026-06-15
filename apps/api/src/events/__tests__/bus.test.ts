import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DomainEvent, DomainEventType } from '../types';
import { channelForType, createEventBus, typeForChannel, type EventBus } from '../bus';

let publisher: Redis;
let subscriber: Redis;
let bus: EventBus;

beforeEach(async () => {
  publisher = new RedisMock() as unknown as Redis;
  subscriber = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one in-memory store across instances; pub/sub channels
  // are likewise shared, which is exactly what a real cross-connection bus does.
  await publisher.flushall();
  bus = createEventBus({ publisher, subscriber });
});

afterEach(async () => {
  await bus.close();
});

/** Resolve once a handler is invoked, or reject after `ms`. */
function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for event')), ms);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const quoteEvent: DomainEvent = {
  type: 'quote.updated',
  assetId: 'asset-1',
  occurredAt: '2026-06-15T00:00:00.000Z',
};

describe('channel helpers', () => {
  it('maps every type to a namespaced channel and back', () => {
    const types: DomainEventType[] = [
      'alert.triggered',
      'notification.created',
      'quote.updated',
      'conglomerate.updated',
      'portfolio.changed',
    ];
    for (const type of types) {
      const channel = channelForType(type);
      expect(channel).toBe(`bt:events:${type}`);
      expect(typeForChannel(channel)).toBe(type);
    }
  });

  it('rejects channels outside our namespace', () => {
    expect(typeForChannel('some:other:channel')).toBeNull();
  });
});

describe('EventBus publish → subscribe', () => {
  it('round-trips a typed event to a subscriber', async () => {
    const received = waitFor<DomainEvent>((resolve) => {
      void bus.subscribe('quote.updated', (event) => resolve(event));
    });
    // Give the subscribe a tick to register before publishing.
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish(quoteEvent);
    expect(await received).toEqual(quoteEvent);
  });

  it('delivers an event to every subscriber of its type', async () => {
    const seen: string[] = [];
    const both = Promise.all([
      waitFor<void>((resolve) =>
        bus.subscribe('portfolio.changed', () => {
          seen.push('a');
          resolve();
        }),
      ),
      waitFor<void>((resolve) =>
        bus.subscribe('portfolio.changed', () => {
          seen.push('b');
          resolve();
        }),
      ),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish({
      type: 'portfolio.changed',
      userId: 'u1',
      portfolioId: 'p1',
      occurredAt: '2026-06-15T00:00:00.000Z',
    });
    await both;
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('only delivers to handlers of the matching type', async () => {
    const wrongType: DomainEventType[] = [];
    await bus.subscribe('alert.triggered', () => {
      wrongType.push('alert.triggered');
    });
    const right = waitFor<void>((resolve) => bus.subscribe('quote.updated', () => resolve()));
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish(quoteEvent);
    await right;
    // Let any stray cross-delivery flush.
    await new Promise((r) => setTimeout(r, 30));
    expect(wrongType).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    let count = 0;
    const unsubscribe = await bus.subscribe('quote.updated', () => {
      count += 1;
    });
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish(quoteEvent);
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(1);

    await unsubscribe();
    await bus.publish(quoteEvent);
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(1); // no further deliveries
  });

  it('isolates a throwing handler from its siblings', async () => {
    const good = waitFor<void>((resolve) => bus.subscribe('quote.updated', () => resolve()));
    await bus.subscribe('quote.updated', () => {
      throw new Error('handler boom');
    });
    await new Promise((r) => setTimeout(r, 20));
    await bus.publish(quoteEvent);
    // The good handler still fires despite the sibling throwing.
    await expect(good).resolves.toBeUndefined();
  });
});
