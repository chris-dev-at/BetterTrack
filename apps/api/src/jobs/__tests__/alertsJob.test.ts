import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Job } from 'bullmq';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Quote } from '@bettertrack/contracts';

import type { Database } from '../../data/db';
import { createAlertRepository } from '../../data/repositories/alertRepository';
import * as schema from '../../data/schema';
import type {
  DomainEvent,
  DomainEventType,
  EventBus,
  EventHandler,
  Unsubscribe,
} from '../../events';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import type { DispatchableEvent } from '../../services/notifications/notificationDispatcher';
import { createStubMarketData } from '../../testing/marketDataStubs';
import { createDeadLetter } from '../deadLetter';
import {
  ALERTS_EVALUATE_INTERVAL_MS,
  ALERTS_EVALUATE_SCHEDULER_ID,
  createAlertsEvaluateJob,
} from '../definitions/alertsJob';
import type { JobContext } from '../types';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

const logger = pino({ level: 'silent' }) as unknown as Logger;

async function makeDb(): Promise<Database> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migratePglite(db as never, { migrationsFolder });
  return db;
}

function recordingBus(): EventBus & { published: DomainEvent[] } {
  const published: DomainEvent[] = [];
  return {
    published,
    async publish(event) {
      published.push(event);
    },
    async subscribe<T extends DomainEventType>(_type: T, _handler: EventHandler<T>) {
      const unsub: Unsubscribe = async () => {};
      return unsub;
    },
    async close() {},
  };
}

/** Recording stand-in for the notification center (#368) — captures emits. */
function recordingCenter(): NotificationCenter & { emitted: DispatchableEvent[] } {
  const emitted: DispatchableEvent[] = [];
  return {
    emitted,
    async emit(event) {
      emitted.push(event);
      return true;
    },
  };
}

function makeCtx(events: EventBus): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return { events, deadLetter: createDeadLetter(redis), redis, logger };
}

function makeJob(timestamp: number): Job<Record<string, never>> {
  return { id: 'job-1', name: 'alerts.evaluate', data: {}, timestamp } as unknown as Job<
    Record<string, never>
  >;
}

function quoteResult(price: number): { value: Quote; stale: boolean; asOf: number } {
  return {
    value: { price, currency: 'USD', dayChangePct: null, asOf: '2026-07-07T00:00:00.000Z' },
    stale: false,
    asOf: 0,
  };
}

async function seedUserAndAsset(db: Database): Promise<{ userId: string; assetId: string }> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: 'u@bt.test', username: 'u', passwordHash: 'x' })
    .returning({ id: schema.users.id });
  const [asset] = await db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'AAPL',
      type: 'stock',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
    })
    .returning({ id: schema.assets.id });
  return { userId: user!.id, assetId: asset!.id };
}

describe('alerts.evaluate job (§14, V3-P10)', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('is scheduled every minute', () => {
    const job = createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData(),
      notify: recordingCenter(),
    });
    expect(job.name).toBe('alerts.evaluate');
    expect(job.schedule).toEqual({
      id: ALERTS_EVALUATE_SCHEDULER_ID,
      every: ALERTS_EVALUATE_INTERVAL_MS,
    });
    expect(ALERTS_EVALUATE_INTERVAL_MS).toBe(60_000);
  });

  it('fires a met alert and publishes alert.triggered, flipping the one-shot to triggered', async () => {
    const { userId, assetId } = await seedUserAndAsset(db);
    const alertRepo = createAlertRepository(db);
    const alert = await alertRepo.create({
      userId,
      assetId,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const events = recordingBus();
    const notify = recordingCenter();
    const ctx = makeCtx(events);
    const job = createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData({ quote: () => quoteResult(150) }),
      notify,
    });

    await job.handler(makeJob(Date.parse('2026-07-07T12:00:00.000Z')), ctx);

    // The fire enters the durable notification center (#368) — never the bus.
    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', userId, alertId: alert.id, assetId }),
    ]);
    expect(events.published).toEqual([]);
    const [row] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, alert.id));
    expect(row!.status).toBe('triggered');
  });
});
