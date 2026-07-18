import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationDigestRepository } from '../../../data/repositories/notificationDigestRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { AlertNotificationContext } from '../../../data/repositories/alertRepository';
import type { Database } from '../../../data/db';
import { notificationDigestQueue, notifications } from '../../../data/schema';
import type { AlertTriggeredEvent, FriendRequestEvent } from '../../../events';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createDigestService, type DigestService } from '../digestService';
import type { PushMessage } from '../fcm';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';

/**
 * V5-P3 quiet hours (#579). Proves: a non-urgent outbound notification fired
 * inside the quiet-hours window is deferred and delivered at window end; one
 * fired outside delivers immediately; the urgent-bypass class (account/security)
 * sends immediately inside the window while a price alert does NOT; deferred
 * delivery is idempotent and survives a worker restart; a digest whose delivery
 * moment lands inside the window is itself deferred; and a user without quiet
 * hours behaves byte-identically.
 */

const OCCURRED_AT = '2026-07-18T09:00:00.000Z';

// A UTC overnight window 22:00→07:00.
const QUIET_START = 22 * 60;
const QUIET_END = 7 * 60;

let harness: TestHarness;
let db: Database;
let digestRepo: ReturnType<typeof createNotificationDigestRepository>;
let userRepo: ReturnType<typeof createUserRepository>;
let fcmCalls: { userId: string; message: PushMessage }[];
let clock: Date;

function alertContext(userId: string): AlertNotificationContext {
  return {
    userId,
    assetId: 'asset-1',
    symbol: 'AAPL',
    name: 'Apple',
    currency: 'USD',
    kind: 'price_above',
    threshold: 200,
  };
}

function makeDispatcher(): NotificationDispatcher {
  return createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    users: userRepo,
    resolveAlert: async () => alertContext('will-be-overwritten'),
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        fcmCalls.push({ userId, message });
      },
      // The dispatcher only calls deliver; the rest of FcmChannel is unused here.
    } as never,
    digest: {
      cadenceFor: (userId, type) => digestRepo.cadenceFor(userId, type),
      enqueue: (item) => digestRepo.enqueue(item),
    },
    quietHours: { enqueueDeferred: (item) => digestRepo.enqueueDeferred(item) },
    now: () => clock,
    logger: harness.ctx.logger,
  });
}

function makeDeferredDelivery(): DigestService {
  return createDigestService({
    repo: digestRepo,
    users: userRepo,
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        fcmCalls.push({ userId, message });
      },
    },
    quietHours: digestRepo,
    now: () => clock,
    logger: harness.ctx.logger,
  });
}

function friendRequestEvent(userId: string, requestId: string): FriendRequestEvent {
  return {
    type: 'friend.request',
    userId,
    actorId: 'actor',
    actorUsername: 'alice',
    requestId,
    occurredAt: OCCURRED_AT,
  };
}

async function deferredRows(userId: string) {
  return db
    .select()
    .from(notificationDigestQueue)
    .where(
      and(
        eq(notificationDigestQueue.userId, userId),
        isNotNull(notificationDigestQueue.deliverAfter),
      ),
    );
}

async function visibleInappRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => !r.hidden);
}

async function enableQuietHours(
  userId: string,
  overrides: Partial<{ startMinute: number; endMinute: number; timezone: string | null }> = {},
) {
  await userRepo.setQuietHours(userId, {
    enabled: true,
    startMinute: overrides.startMinute ?? QUIET_START,
    endMinute: overrides.endMinute ?? QUIET_END,
    timezone: overrides.timezone ?? null,
  });
}

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  digestRepo = createNotificationDigestRepository(db);
  userRepo = createUserRepository(db);
  fcmCalls = [];
  clock = new Date('2026-07-18T23:00:00.000Z');
});

afterEach(async () => {
  await harness.ctx.events.close();
});

describe('quiet hours — instant deferral (§13.5 V5-P3)', () => {
  it('defers a non-urgent push fired inside the window and delivers it at window end', async () => {
    const user = await harness.seedUser({ email: 'q@bt.test', username: 'quietuser' });
    await enableQuietHours(user.id);

    clock = new Date('2026-07-18T23:00:00.000Z'); // inside the window
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'r1'));

    // The in-app bell still landed instantly; the push was held back.
    expect(await visibleInappRows(user.id)).toHaveLength(1);
    expect(fcmCalls).toHaveLength(0);
    const rows = await deferredRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliverAfter?.toISOString()).toBe('2026-07-19T07:00:00.000Z');
    expect(rows[0]!.deliveredAt).toBeNull();

    // Before window end nothing is due.
    clock = new Date('2026-07-19T06:59:00.000Z');
    expect((await makeDeferredDelivery().deliverDeferred()).sent).toBe(0);
    expect(fcmCalls).toHaveLength(0);

    // At/after window end the deferred push is delivered — exactly once.
    clock = new Date('2026-07-19T07:00:30.000Z');
    const res = await makeDeferredDelivery().deliverDeferred();
    expect(res.sent).toBe(1);
    expect(fcmCalls).toHaveLength(1);
    expect(fcmCalls[0]!.message.type).toBe('friend.request');
  });

  it('delivers immediately when fired OUTSIDE the window (no deferral)', async () => {
    const user = await harness.seedUser({ email: 'o@bt.test', username: 'outuser' });
    await enableQuietHours(user.id);

    clock = new Date('2026-07-18T12:00:00.000Z'); // awake
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'r1'));

    expect(fcmCalls).toHaveLength(1);
    expect(await deferredRows(user.id)).toHaveLength(0);
  });

  it('a user WITHOUT quiet hours behaves byte-identically (regression)', async () => {
    const user = await harness.seedUser({ email: 'n@bt.test', username: 'noquiet' });
    // No enableQuietHours — off by default.

    clock = new Date('2026-07-18T23:00:00.000Z'); // would be inside a window
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'r1'));

    expect(await visibleInappRows(user.id)).toHaveLength(1);
    expect(fcmCalls).toHaveLength(1);
    expect(await deferredRows(user.id)).toHaveLength(0);
  });
});

describe('quiet hours — urgent bypass (§13.5 V5-P3, §16-logged)', () => {
  it('an account/security notification sends immediately inside the window', async () => {
    const user = await harness.seedUser({ email: 'u@bt.test', username: 'urgentuser' });
    await enableQuietHours(user.id);

    clock = new Date('2026-07-18T23:00:00.000Z');
    await makeDispatcher().dispatch({
      type: 'account.data_export',
      userId: user.id,
      occurredAt: OCCURRED_AT,
    });

    // Urgent class bypasses — pushed now, nothing deferred.
    expect(fcmCalls).toHaveLength(1);
    expect(fcmCalls[0]!.message.type).toBe('account.data_export');
    expect(await deferredRows(user.id)).toHaveLength(0);
  });

  it('a price alert does NOT bypass — it is deferred like any non-urgent item', async () => {
    const user = await harness.seedUser({ email: 'a@bt.test', username: 'alertuser' });
    await enableQuietHours(user.id);

    const dispatcher = createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(db),
      users: userRepo,
      resolveAlert: async () => alertContext(user.id),
      fcm: {
        async deliver(userId: string, message: PushMessage) {
          fcmCalls.push({ userId, message });
        },
      } as never,
      digest: {
        cadenceFor: (uid, type) => digestRepo.cadenceFor(uid, type),
        enqueue: (item) => digestRepo.enqueue(item),
      },
      quietHours: { enqueueDeferred: (item) => digestRepo.enqueueDeferred(item) },
      now: () => clock,
      logger: harness.ctx.logger,
    });

    clock = new Date('2026-07-18T23:00:00.000Z');
    const alertEvent: AlertTriggeredEvent = {
      type: 'alert.triggered',
      userId: user.id,
      alertId: 'alert-1',
      assetId: 'asset-1',
      occurredAt: OCCURRED_AT,
    };
    await dispatcher.dispatch(alertEvent);

    expect(fcmCalls).toHaveLength(0);
    expect(await deferredRows(user.id)).toHaveLength(1);
  });
});

describe('quiet hours — idempotent + restart-safe (§13.5 V5-P3)', () => {
  it('a deferred delivery survives a worker restart and never double-sends', async () => {
    const user = await harness.seedUser({ email: 'i@bt.test', username: 'idemuser' });
    await enableQuietHours(user.id);

    clock = new Date('2026-07-18T23:00:00.000Z');
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'r1'));
    expect(await deferredRows(user.id)).toHaveLength(1);

    // "Restart": a brand-new service instance reads the same durable queue.
    clock = new Date('2026-07-19T07:05:00.000Z');
    const first = await makeDeferredDelivery().deliverDeferred();
    expect(first.sent).toBe(1);
    expect(fcmCalls).toHaveLength(1);

    // A second run (or a second worker) claims nothing.
    const second = await makeDeferredDelivery().deliverDeferred();
    expect(second.sent).toBe(0);
    expect(fcmCalls).toHaveLength(1);
  });
});

describe('quiet hours — digest deferral + local-day bucketing (§13.5 V5-P3)', () => {
  it('a daily digest whose delivery lands in the window is deferred to window end', async () => {
    const user = await harness.seedUser({ email: 'd@bt.test', username: 'digestquiet' });
    // Sydney (UTC+10): buckets by local day, and quiet 22:00→07:00 local.
    await enableQuietHours(user.id, { timezone: 'Australia/Sydney' });
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    // Enqueue two events on the user's local 2026-07-18 (12:30 Sydney = 02:30 UTC).
    clock = new Date('2026-07-18T02:30:00.000Z');
    const dispatcher = makeDispatcher();
    await dispatcher.dispatch(friendRequestEvent(user.id, 'r1'));
    await dispatcher.dispatch(friendRequestEvent(user.id, 'r2'));
    // Deferred (digest) rows are grouped, not yet the quiet-hours deferral store.
    expect(await deferredRows(user.id)).toHaveLength(0);
    expect(fcmCalls).toHaveLength(0);

    // Run the daily digest at 06:30 Sydney on 2026-07-19 (20:30 UTC 07-18): the
    // 07-18 local period has closed AND it is inside the quiet window.
    clock = new Date('2026-07-18T20:30:00.000Z');
    const digestRun = await makeDeferredDelivery().deliverDue('daily');
    expect(digestRun.groups).toBe(1);
    expect(digestRun.sent).toBe(0); // not sent now — deferred
    expect(digestRun.deferred).toBe(1);
    expect(fcmCalls).toHaveLength(0);
    const rows = await deferredRows(user.id);
    expect(rows).toHaveLength(1);
    // Window end = 07:00 Sydney on 2026-07-19 = 21:00 UTC 07-18.
    expect(rows[0]!.deliverAfter?.toISOString()).toBe('2026-07-18T21:00:00.000Z');

    // After window end the deferred digest summary push is delivered once.
    clock = new Date('2026-07-18T21:00:30.000Z');
    const res = await makeDeferredDelivery().deliverDeferred();
    expect(res.sent).toBe(1);
    expect(fcmCalls).toHaveLength(1);
    expect(fcmCalls[0]!.message.body).toContain('2');
  });
});
