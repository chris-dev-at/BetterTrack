import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Quote } from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import * as schema from '../data/schema';
import { runAlertsEvaluation } from '../services/alerts/alertEvaluator';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #368's HARD requirement (carried from #367): cross-process notification
 * delivery must be DURABLE. The old pub/sub hand-off was at-most-once — an
 * alert fired while the dispatcher was down/redeploying was marked
 * triggered/on-cooldown yet its notification silently evaporated, never
 * retried. v2 routes every notification event through the BullMQ
 * `notifications.dispatch` queue instead.
 *
 * This regression models that exact outage: the queue accepts the event while
 * NO dispatcher consumes (worker offline), the alert is already flipped — and
 * once the dispatcher comes back and drains the queue, the notification IS
 * delivered, exactly once, even when the queue redelivers (at-least-once).
 */

let harness: TestHarness;
/** The durable queue: everything emitted while the "worker" is offline. */
let queued: DispatchableEvent[];

beforeEach(async () => {
  queued = [];
  harness = await createTestApp({
    // The center's transport seam — a recording queue instead of BullMQ (which
    // cannot run on ioredis-mock). Nothing consumes until the test drains it.
    notificationEnqueue: async (event) => {
      queued.push(event);
    },
  });
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function quoteResult(price: number): { value: Quote; stale: boolean; asOf: number } {
  return {
    value: { price, currency: 'USD', dayChangePct: null, asOf: '2026-07-10T00:00:00.000Z' },
    stale: false,
    asOf: 0,
  };
}

async function seedAlert(userId: string): Promise<{ alertId: string; assetId: string }> {
  const [asset] = await harness.db
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
  const [alert] = await harness.db
    .insert(schema.alerts)
    .values({
      userId,
      assetId: asset!.id,
      kind: 'price_above',
      threshold: '100',
      repeat: false,
      status: 'active',
    })
    .returning({ id: schema.alerts.id });
  return { alertId: alert!.id, assetId: asset!.id };
}

async function visibleNotifications(userId: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden);
}

describe('durable notification delivery across a dispatcher outage (#368/#367)', () => {
  it('an alert fired while the dispatcher is offline is delivered once it comes back — exactly once', async () => {
    const user = await harness.seedUser({ email: 'ann@bt.test', username: 'ann' });
    const { alertId } = await seedAlert(user.id);
    const alertRepo = createAlertRepository(harness.db);

    // ── The outage: the evaluator runs (worker side), the dispatcher does NOT.
    const result = await runAlertsEvaluation({
      alertRepo,
      marketData: createStubMarketData({ quote: () => quoteResult(150) }),
      redis: harness.ctx.redis,
      notify: harness.ctx.notify,
      logger: harness.ctx.logger,
      now: () => Date.parse('2026-07-10T12:00:00.000Z'),
    });
    expect(result.fired).toBe(1);

    // The alert is already flipped/on-cooldown — the #367 danger window…
    const [alertRow] = await harness.db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.id, alertId));
    expect(alertRow!.status).toBe('triggered');
    // …the event sits SAFELY in the durable queue…
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'alert.triggered', alertId, userId: user.id });
    // …and nothing has been delivered yet (no dispatcher ran).
    expect(await visibleNotifications(user.id)).toHaveLength(0);

    // ── The worker comes back and drains the queue.
    for (const event of queued) {
      await harness.ctx.notificationDispatcher.dispatch(event);
    }
    const delivered = await visibleNotifications(user.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.type).toBe('alert.triggered');
    expect(delivered[0]!.title).toBe('Price alert: AAPL');

    // ── BullMQ is at-least-once: a redelivery of the same job must no-op.
    for (const event of queued) {
      await harness.ctx.notificationDispatcher.dispatch(event);
    }
    expect(await visibleNotifications(user.id)).toHaveLength(1);
  });

  it('the evaluator emits BEFORE flipping alert state — a crash between the two can only re-fire, never lose', async () => {
    const user = await harness.seedUser({ email: 'bo@bt.test', username: 'bo' });
    const { alertId } = await seedAlert(user.id);
    const alertRepo = createAlertRepository(harness.db);

    // Capture the alert's persisted status AT EMIT TIME.
    const statusAtEmit: string[] = [];
    await runAlertsEvaluation({
      alertRepo,
      marketData: createStubMarketData({ quote: () => quoteResult(150) }),
      redis: harness.ctx.redis,
      notify: {
        emit: async () => {
          const [row] = await harness.db
            .select({ status: schema.alerts.status })
            .from(schema.alerts)
            .where(eq(schema.alerts.id, alertId));
          statusAtEmit.push(row!.status);
        },
      },
      logger: harness.ctx.logger,
      now: () => Date.parse('2026-07-10T12:00:00.000Z'),
    });

    // The emit ran while the alert was still 'active' (not yet recorded): had
    // the process died right there, the alert would re-fire next window and
    // re-emit — delayed, deduped downstream, never silently lost (#367).
    expect(statusAtEmit).toEqual(['active']);
    const [after] = await harness.db
      .select({ status: schema.alerts.status })
      .from(schema.alerts)
      .where(eq(schema.alerts.id, alertId));
    expect(after!.status).toBe('triggered');
  });

  it('social events ride the same durable path: emitted while offline, delivered on drain', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    await harness.ctx.social.sendRequest(alice.id, 'bob');

    // Queued, not delivered — ONE pipeline for every source (#368).
    expect(queued.some((e) => e.type === 'friend.request')).toBe(true);
    expect(await visibleNotifications(bob.id)).toHaveLength(0);

    for (const event of queued) {
      await harness.ctx.notificationDispatcher.dispatch(event);
    }
    const rows = await visibleNotifications(bob.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('friend.request');
  });
});
