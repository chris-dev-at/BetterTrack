import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventBus, type DomainEvent, type EventBus } from '../../events';
import type { Logger } from '../../logger';
import { createDeadLetter } from '../deadLetter';
import { HEARTBEAT_ASSET_ID, heartbeatJob } from '../definitions';
import type { JobContext } from '../types';

let bus: EventBus;
let ctx: JobContext;

const logger = pino({ level: 'silent' }) as unknown as Logger;

beforeEach(async () => {
  const publisher = new RedisMock() as unknown as Redis;
  const subscriber = new RedisMock() as unknown as Redis;
  const redis = new RedisMock() as unknown as Redis;
  await publisher.flushall();
  bus = createEventBus({ publisher, subscriber });
  ctx = { events: bus, deadLetter: createDeadLetter(redis), redis, logger };
});

afterEach(async () => {
  await bus.close();
});

describe('heartbeat job', () => {
  it('is a repeatable definition on the heartbeat queue', () => {
    expect(heartbeatJob.name).toBe('system.heartbeat');
    expect(heartbeatJob.schedule).toMatchObject({ id: 'system.heartbeat', every: 60_000 });
  });

  it('publishes a typed quote.updated proof event through the bus when run', async () => {
    const received = new Promise<DomainEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event published')), 1000);
      void bus.subscribe('quote.updated', (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
    await new Promise((r) => setTimeout(r, 20));

    const job = {
      id: 'hb-1',
      name: 'system.heartbeat',
      data: {},
      timestamp: Date.parse('2026-06-15T08:00:00.000Z'),
    } as unknown as Job<Record<string, never>>;

    await heartbeatJob.handler(job, ctx);

    const event = await received;
    expect(event).toEqual({
      type: 'quote.updated',
      assetId: HEARTBEAT_ASSET_ID,
      occurredAt: '2026-06-15T08:00:00.000Z',
    });
  });
});
