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
import {
  ParanoidModeError,
  type ParanoidModeGuard,
} from '../../services/account/paranoidEnforcement';
import type { NotificationCenter } from '../../services/notifications/notificationCenter';
import type { DispatchableEvent } from '../../services/notifications/notificationDispatcher';
import { createStubMarketData } from '../../testing/marketDataStubs';
import { alertFireLockKey, alertFireWindowStart } from '../../services/alerts/alertEvaluator';
import { createDeadLetter } from '../deadLetter';
import {
  ALERTS_EVALUATE_INTERVAL_MS,
  ALERTS_EVALUATE_SCHEDULER_ID,
  createAlertsEvaluateJob,
} from '../definitions/alertsJob';
import { featureFlagForQueue, type JobContext } from '../types';
import { runJobDefinition } from '../worker';

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

/**
 * A job context whose kill-switch read is LIVE: `flags.alerts` is consulted on
 * every call, the way the production context consults the flag service's shared
 * snapshot — so a test can flip the switch between two runs of the same
 * definition and context.
 */
function makeCtx(events: EventBus, flags: { alerts: boolean } = { alerts: true }): JobContext {
  const redis = new RedisMock() as unknown as Redis;
  return {
    events,
    deadLetter: createDeadLetter(redis),
    redis,
    logger,
    isFeatureEnabled: async (key) => (key === 'alerts' ? flags.alerts : true),
  };
}

/**
 * A job picked up at `processedOn` whose `timestamp` is one full period stale —
 * BullMQ stamps `timestamp` when the delayed job is created, at the previous
 * iteration's pickup (#1543). The evaluator must anchor its trigger window to
 * `processedOn`.
 */
function makeJob(processedOn: number): Job<Record<string, never>> {
  return {
    id: 'job-1',
    name: 'alerts.evaluate',
    data: {},
    timestamp: processedOn - ALERTS_EVALUATE_INTERVAL_MS,
    processedOn,
  } as unknown as Job<Record<string, never>>;
}

const allowingParanoidGuard = {
  async runAllowed<T>(
    _userId: string,
    _capability: Parameters<ParanoidModeGuard['runAllowed']>[1],
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  },
  async runAllowedWithOptional<T>(
    _requiredUserIds: readonly string[],
    optionalUserIds: readonly string[],
    _capability: Parameters<ParanoidModeGuard['runAllowedWithOptional']>[2],
    action: (allowedOptionalUserIds: ReadonlySet<string>) => Promise<T>,
  ): Promise<T> {
    return action(new Set(optionalUserIds));
  },
} satisfies Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;

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
      paranoid: allowingParanoidGuard,
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
      paranoid: allowingParanoidGuard,
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

  it('keeps the private fire but suppresses follower fan-out when the owner is paranoid', async () => {
    const { userId, assetId } = await seedUserAndAsset(db);
    const [follower] = await db
      .insert(schema.users)
      .values({ email: 'f@bt.test', username: 'f', passwordHash: 'x' })
      .returning({ id: schema.users.id });
    await db
      .update(schema.users)
      .set({ alertsVisibleToFollowers: true })
      .where(eq(schema.users.id, userId));
    await db.insert(schema.userFollows).values({
      followerId: follower!.id,
      followedId: userId,
      notifyOnAlertFire: true,
    });
    const alert = await createAlertRepository(db).create({
      userId,
      assetId,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });
    const notify = recordingCenter();
    const denyingOwnerGuard = {
      async runAllowed<T>(): Promise<T> {
        throw new ParanoidModeError('sharing');
      },
      async runAllowedWithOptional<T>(
        _requiredUserIds: readonly string[],
        optionalUserIds: readonly string[],
        _capability: Parameters<ParanoidModeGuard['runAllowedWithOptional']>[2],
        action: (allowedOptionalUserIds: ReadonlySet<string>) => Promise<T>,
      ): Promise<T> {
        return action(new Set(optionalUserIds));
      },
    } satisfies Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
    const job = createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData({ quote: () => quoteResult(150) }),
      notify,
      paranoid: denyingOwnerGuard,
    });

    await job.handler(makeJob(Date.parse('2026-07-07T12:05:00.000Z')), makeCtx(recordingBus()));

    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', userId, alertId: alert.id }),
    ]);
  });

  it('never quotes, fires, or flips a paranoid account custom-asset alert', async () => {
    const { userId, assetId } = await seedUserAndAsset(db);
    const [customAsset] = await db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: `house:${userId}`,
        ownerId: userId,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'Private House',
        currency: 'EUR',
      })
      .returning({ id: schema.assets.id });
    const alertRepo = createAlertRepository(db);
    const globalAlert = await alertRepo.create({
      userId,
      assetId,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });
    const customAlert = await alertRepo.create({
      userId,
      assetId: customAsset!.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const quotedRefs: string[] = [];
    const notify = recordingCenter();
    const paranoidOwnerGuard = {
      async runAllowed<T>(): Promise<T> {
        // The account went paranoid: the custom-asset rail must abort BEFORE
        // the alerts are loaded, so no quote, emit, or state flip can land.
        throw new ParanoidModeError('portfolioServer');
      },
      async runAllowedWithOptional<T>(
        _requiredUserIds: readonly string[],
        optionalUserIds: readonly string[],
        _capability: Parameters<ParanoidModeGuard['runAllowedWithOptional']>[2],
        action: (allowedOptionalUserIds: ReadonlySet<string>) => Promise<T>,
      ): Promise<T> {
        return action(new Set(optionalUserIds));
      },
    } satisfies Pick<ParanoidModeGuard, 'runAllowed' | 'runAllowedWithOptional'>;
    const job = createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData({
        quote: (ref) => {
          quotedRefs.push(ref.providerRef);
          return quoteResult(150);
        },
      }),
      notify,
      paranoid: paranoidOwnerGuard,
    });

    await job.handler(makeJob(Date.parse('2026-07-07T12:10:00.000Z')), makeCtx(recordingBus()));

    // The manual (own-valuation) provider ref never reached the market core.
    expect(quotedRefs).toEqual(['AAPL']);
    // Only the global market alert fired and flipped.
    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', alertId: globalAlert.id }),
    ]);
    const rows = await db
      .select({ id: schema.alerts.id, status: schema.alerts.status })
      .from(schema.alerts);
    expect(rows.find((row) => row.id === globalAlert.id)!.status).toBe('triggered');
    expect(rows.find((row) => row.id === customAlert.id)!.status).toBe('active');
  });

  it('evaluates a normal account custom-asset alert inside its transition lock', async () => {
    const { userId } = await seedUserAndAsset(db);
    const [customAsset] = await db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: `house:${userId}`,
        ownerId: userId,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'Private House',
        currency: 'EUR',
      })
      .returning({ id: schema.assets.id });
    const customAlert = await createAlertRepository(db).create({
      userId,
      assetId: customAsset!.id,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const guarded: string[] = [];
    const notify = recordingCenter();
    const job = createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData({ quote: () => quoteResult(150) }),
      notify,
      paranoid: {
        async runAllowed<T>(
          user: string,
          _capability: Parameters<ParanoidModeGuard['runAllowed']>[1],
          action: () => Promise<T>,
        ): Promise<T> {
          guarded.push(user);
          return action();
        },
        runAllowedWithOptional: allowingParanoidGuard.runAllowedWithOptional,
      },
    });

    await job.handler(makeJob(Date.parse('2026-07-07T12:15:00.000Z')), makeCtx(recordingBus()));

    expect(guarded).toContain(userId);
    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', alertId: customAlert.id }),
    ]);
  });
});

describe('the `alerts` kill switch stops the producer, not just the router (§13.5 V5-P2 arc (c))', () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  function alertsJob(notify: NotificationCenter, quoted: string[]) {
    return createAlertsEvaluateJob({
      db,
      marketData: createStubMarketData({
        quote: (ref) => {
          quoted.push(ref.providerRef);
          return quoteResult(150);
        },
      }),
      notify,
      paranoid: allowingParanoidGuard,
    });
  }

  it('declares the switch that owns its queue', () => {
    const job = alertsJob(recordingCenter(), []);
    expect(job.featureFlag).toBe('alerts');
    expect(featureFlagForQueue('alerts.evaluate')).toBe('alerts');
  });

  it('sheds the whole run while OFF — no evaluation, no fire, no enqueue, no (alert, window) bucket — and resumes on the next run when flipped back ON', async () => {
    const { userId, assetId } = await seedUserAndAsset(db);
    const alert = await createAlertRepository(db).create({
      userId,
      assetId,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: false,
    });

    const notify = recordingCenter();
    const quoted: string[] = [];
    const job = alertsJob(notify, quoted);
    // One definition, one context, flags read per run — exactly what the worker
    // holds for the process's lifetime.
    const flags = { alerts: false };
    const ctx = makeCtx(recordingBus(), flags);

    const offAt = Date.parse('2026-07-07T13:00:00.000Z');
    await runJobDefinition(job, makeJob(offAt), ctx);

    // Nothing was evaluated: no quote was read, so the run cost nothing either.
    expect(quoted).toEqual([]);
    expect(notify.emitted).toEqual([]);
    // The alert is untouched — still armed, so it is not silently skipped forever.
    const [offRow] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, alert.id));
    expect(offRow!.status).toBe('active');
    expect(offRow!.lastTriggeredAt).toBeNull();
    // …and the off-window's idempotency bucket was NOT consumed, so re-enabling
    // cannot find a window silently burnt by a run that never fired.
    expect(await ctx.redis.get(alertFireLockKey(alert.id, alertFireWindowStart(offAt)))).toBeNull();

    // The admin flips the switch back on; the very next run fires, on the same
    // context — the flag was never captured at startup.
    flags.alerts = true;
    const onAt = Date.parse('2026-07-07T13:01:00.000Z');
    await runJobDefinition(job, makeJob(onAt), ctx);

    expect(quoted).toEqual(['AAPL']);
    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', userId, alertId: alert.id, assetId }),
    ]);
    const [onRow] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, alert.id));
    expect(onRow!.status).toBe('triggered');
    expect(
      await ctx.redis.get(alertFireLockKey(alert.id, alertFireWindowStart(onAt))),
    ).not.toBeNull();
  });

  it('leaves a repeat alert without a cooldown across the off-window, so it fires on the first run after resume', async () => {
    const { userId, assetId } = await seedUserAndAsset(db);
    const alert = await createAlertRepository(db).create({
      userId,
      assetId,
      kind: 'price_above',
      threshold: 100,
      refPrice: null,
      repeat: true,
    });

    const notify = recordingCenter();
    const job = alertsJob(notify, []);
    const flags = { alerts: false };
    const ctx = makeCtx(recordingBus(), flags);

    await runJobDefinition(job, makeJob(Date.parse('2026-07-07T14:00:00.000Z')), ctx);
    expect(notify.emitted).toEqual([]);

    flags.alerts = true;
    await runJobDefinition(job, makeJob(Date.parse('2026-07-07T14:01:00.000Z')), ctx);

    expect(notify.emitted).toEqual([
      expect.objectContaining({ type: 'alert.triggered', alertId: alert.id }),
    ]);
    const [row] = await db.select().from(schema.alerts).where(eq(schema.alerts.id, alert.id));
    // A repeat alert stays active; the 24 h cooldown starts at the real fire,
    // never at a run the switch shed.
    expect(row!.status).toBe('active');
    expect(row!.lastTriggeredAt).not.toBeNull();
  });
});
