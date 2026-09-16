import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import { waitForEvent } from '../../test/waitFor';
import type { DomainEvent, DomainEventOf, DomainEventType } from '../types';
import {
  channelForType,
  createEventBus,
  typeForChannel,
  type EventBus,
  type Unsubscribe,
} from '../bus';

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

/**
 * Subscribe, and hand back both halves of the handshake this suite needs.
 *
 * `bus.subscribe` resolves only once Redis has acknowledged the SUBSCRIBE, so
 * awaiting it is the registration signal every `await sleep(20)` in this file
 * used to guess at (#1622): publish after the await and the delivery cannot be
 * missed, on any machine, at any load. `first` carries its own deadline, so a
 * delivery that never comes fails by name instead of hanging.
 */
async function subscribeAndCapture<T extends DomainEventType>(
  type: T,
): Promise<{ first: Promise<DomainEventOf<T>>; unsubscribe: Unsubscribe }> {
  let deliver!: (event: DomainEventOf<T>) => void;
  const first = waitForEvent<DomainEventOf<T>>(`a \`${type}\` delivery`, (handoff) => {
    deliver = handoff;
  });
  const unsubscribe = await bus.subscribe(type, (event) => {
    deliver(event);
  });
  return { first, unsubscribe };
}

const quoteEvent: DomainEvent = {
  type: 'quote.updated',
  assetId: 'asset-1',
  occurredAt: '2026-06-15T00:00:00.000Z',
};

const alertEvent: DomainEvent = {
  type: 'alert.triggered',
  userId: 'u1',
  alertId: 'alert-1',
  assetId: 'asset-1',
  occurredAt: '2026-06-15T00:00:01.000Z',
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
    const { first } = await subscribeAndCapture('quote.updated');
    await bus.publish(quoteEvent);
    expect(await first).toEqual(quoteEvent);
  });

  it('delivers an event to every subscriber of its type', async () => {
    const a = await subscribeAndCapture('portfolio.changed');
    const b = await subscribeAndCapture('portfolio.changed');
    const portfolioEvent: DomainEvent = {
      type: 'portfolio.changed',
      userId: 'u1',
      portfolioId: 'p1',
      occurredAt: '2026-06-15T00:00:00.000Z',
    };
    await bus.publish(portfolioEvent);
    // Both subscribers get the whole event, not merely "something".
    expect(await a.first).toEqual(portfolioEvent);
    expect(await b.first).toEqual(portfolioEvent);
  });

  it('only delivers to handlers of the matching type', async () => {
    const otherChannel: DomainEvent[] = [];
    await bus.subscribe('alert.triggered', (event) => {
      otherChannel.push(event);
    });
    const { first: rightChannel } = await subscribeAndCapture('quote.updated');

    await bus.publish(quoteEvent);
    expect(await rightChannel).toEqual(quoteEvent);

    // A real `alert.triggered` publish is the barrier the old 30 ms "let any
    // stray cross-delivery flush" sleep was standing in for: it is published
    // AFTER the quote event on the same publisher connection, so by the time
    // the alert handler has seen it, a leaked quote event would already be
    // sitting in front of it in `otherChannel`. Asserting the exact contents —
    // not just "empty" — also keeps the test from passing vacuously if the
    // alert subscription silently stopped working.
    await bus.publish(alertEvent);
    await vi.waitFor(() => expect(otherChannel).toHaveLength(1));
    expect(otherChannel).toEqual([alertEvent]);
  });

  it('stops delivering after unsubscribe', async () => {
    const delivered: DomainEvent[] = [];
    const unsubscribe = await bus.subscribe('quote.updated', (event) => {
      delivered.push(event);
    });
    await bus.publish(quoteEvent);
    await vi.waitFor(() => expect(delivered).toEqual([quoteEvent]));

    await unsubscribe();
    // A tracer on the same channel is the barrier: the bus dispatches one
    // message to every handler of a type in a single pass, so the moment the
    // tracer has the second publish, the unsubscribed handler has provably had
    // its chance at it — no quiet window needed.
    const tracer = vi.fn();
    await bus.subscribe('quote.updated', tracer);
    await bus.publish(quoteEvent);
    await vi.waitFor(() => expect(tracer).toHaveBeenCalledTimes(1));
    expect(delivered).toEqual([quoteEvent]); // no further deliveries
  });

  it('isolates a throwing handler from its siblings', async () => {
    const { first: good } = await subscribeAndCapture('quote.updated');
    await bus.subscribe('quote.updated', () => {
      throw new Error('handler boom');
    });
    await bus.publish(quoteEvent);
    // The good handler still fires — with the whole event — despite the sibling
    // throwing on the same dispatch.
    await expect(good).resolves.toEqual(quoteEvent);
  });

  it('warns and drops an unparseable message without invoking subscribers', async () => {
    const warn = vi.fn();
    const handler = vi.fn();
    bus = createEventBus({ publisher, subscriber, logger: { warn } as unknown as Logger });
    await bus.subscribe('quote.updated', handler);

    await publisher.publish(channelForType('quote.updated'), '{not-json');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      { channel: channelForType('quote.updated') },
      'event bus: dropped unparseable message',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs a rejected handler while still delivering once to a sibling', async () => {
    const error = vi.fn();
    const sibling = vi.fn();
    bus = createEventBus({ publisher, subscriber, logger: { error } as unknown as Logger });
    await bus.subscribe('quote.updated', () => Promise.reject(new Error('handler boom')));
    await bus.subscribe('quote.updated', sibling);

    await bus.publish(quoteEvent);

    // Waiting for the catch ensures the bus has drained the handler promise.
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledWith(quoteEvent);
    expect(error).toHaveBeenCalledWith(
      { err: expect.any(Error), type: 'quote.updated' },
      'event bus: subscriber handler failed',
    );
  });
});
