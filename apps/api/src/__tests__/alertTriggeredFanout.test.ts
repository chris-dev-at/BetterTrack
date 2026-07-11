import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Quote } from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import * as schema from '../data/schema';
import { createNotificationsDispatchJob, type JobContext, type JobPayload } from '../jobs';
import { runAlertsEvaluation } from '../services/alerts/alertEvaluator';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Regression for the 2026-07-11 P1: a BORN-BREACHED alert (rule already true at
 * creation — "BTC-EUR above €1" with spot ≈ €56k) fired in prod, flipped to
 * `triggered`, and yet neither an inbox row nor a push ever materialised.
 *
 * The pipeline CODE was correct; the prod deploy loop had stranded the worker
 * on a pre-notifications-v2 image whose evaluator published onto the retired
 * ephemeral bus (see infra/live/updater.sh + liveDeployTopology.test.ts for
 * that half). This suite pins down the in-code half end-to-end so any future
 * regression along the v2 path is caught where it runs:
 *
 *   evaluator (worker) → notification center → durable `{ event }` job payload
 *   → the REAL `notifications.dispatch` job definition (the exact consumer the
 *   worker registers) → dispatcher → visible inbox row.
 *
 * Two properties are load-bearing and must never drift:
 *  - **Born-breached alerts notify.** The evaluator's predicate is stateless —
 *    no armed→triggered transition across two runs is required, so an alert
 *    already in breach fires on its FIRST evaluation tick.
 *  - **repeat=off stays single-fire.** One visible row, alert flips to
 *    `triggered`, drops out of the active set, and at-least-once redelivery of
 *    the job no-ops.
 */

let harness: TestHarness;
/** The durable queue's contents — what the center enqueued (worker-side seam). */
let queued: DispatchableEvent[];

beforeEach(async () => {
  queued = [];
  harness = await createTestApp({
    // Cached quote: any BTC-EUR price satisfies "above €1" — born-breached.
    marketData: createStubMarketData({ quote: () => quoteResult(56_000) }),
    // The center's transport seam records instead of BullMQ (which cannot run
    // on ioredis-mock); the test drains it through the REAL job definition.
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
    value: { price, currency: 'EUR', dayChangePct: null, asOf: '2026-07-11T12:29:00.000Z' },
    stale: false,
    asOf: 0,
  };
}

/** Seed the global BTC-EUR catalog asset the alert references. */
async function seedBtcEur(): Promise<string> {
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BTC-EUR',
      type: 'crypto',
      symbol: 'BTC-EUR',
      name: 'Bitcoin EUR',
      currency: 'EUR',
    })
    .returning({ id: schema.assets.id });
  return asset!.id;
}

async function visibleNotifications(userId: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden);
}

/**
 * Consume one queued event EXACTLY like the worker does: the same typed
 * `{ event }` payload `registry.enqueue('notifications.dispatch', …)` produces,
 * handed to the same job definition `scripts/worker.ts` registers a Worker for.
 */
async function drainThroughDispatchJob(events: readonly DispatchableEvent[]): Promise<void> {
  const definition = createNotificationsDispatchJob({
    dispatcher: harness.ctx.notificationDispatcher,
  });
  const ctx = {
    events: harness.ctx.events,
    redis: harness.ctx.redis,
    logger: harness.ctx.logger,
    deadLetter: undefined,
  } as unknown as JobContext; // the dispatch handler never touches the context
  for (const event of events) {
    const payload: JobPayload<'notifications.dispatch'> = { event };
    await definition.handler({ data: payload } as unknown as Job<typeof payload>, ctx);
  }
}

describe('alert.triggered fan-out through the real worker pipeline (P1 2026-07-11)', () => {
  it('a born-breached repeat=off alert notifies on its FIRST evaluation and stays single-fire', async () => {
    const user = await harness.seedUser({ email: 'mobile@bt.test', username: 'mobiledev' });
    const assetId = await seedBtcEur();

    // Create through the REAL service (the POST /alerts path): born-breached —
    // threshold €1, spot €56k. Creation must NOT silently pre-trigger it.
    const created = await harness.ctx.alerts.create(user.id, {
      assetId,
      kind: 'price_above',
      threshold: 1,
      repeat: false,
    });
    expect(created.status).toBe('active');

    // ── First evaluator tick after creation: the stateless predicate fires
    // immediately — no armed→triggered transition across two runs is required.
    const alertRepo = createAlertRepository(harness.db);
    const firstTick = await runAlertsEvaluation({
      alertRepo,
      marketData: createStubMarketData({ quote: () => quoteResult(56_000) }),
      redis: harness.ctx.redis,
      notify: harness.ctx.notify,
      logger: harness.ctx.logger,
      now: () => Date.parse('2026-07-11T12:30:00.000Z'),
    });
    expect(firstTick).toEqual({ evaluated: 1, fired: 1 });

    // Durably enqueued, and only then flipped (repeat=off ⇒ `triggered`).
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'alert.triggered',
      alertId: created.id,
      assetId,
      userId: user.id,
    });
    const [flipped] = await harness.db
      .select({ status: schema.alerts.status })
      .from(schema.alerts)
      .where(eq(schema.alerts.id, created.id));
    expect(flipped!.status).toBe('triggered');

    // ── Consume through the REAL `notifications.dispatch` job definition —
    // the leg the stranded prod worker never ran. The inbox row must appear.
    await drainThroughDispatchJob(queued);
    const delivered = await visibleNotifications(user.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.type).toBe('alert.triggered');
    expect(delivered[0]!.title).toBe('Price alert: BTC-EUR');
    expect(delivered[0]!.body).toBe('BTC-EUR rose above 1 EUR.');
    expect(delivered[0]!.readAt).toBeNull(); // unread — nothing suppressed it

    // ── BullMQ is at-least-once: redelivering the same job must no-op.
    await drainThroughDispatchJob(queued);
    expect(await visibleNotifications(user.id)).toHaveLength(1);

    // ── Single-fire: the next window sees no active alert and re-fires nothing.
    const secondTick = await runAlertsEvaluation({
      alertRepo,
      marketData: createStubMarketData({ quote: () => quoteResult(56_000) }),
      redis: harness.ctx.redis,
      notify: harness.ctx.notify,
      logger: harness.ctx.logger,
      now: () => Date.parse('2026-07-11T12:31:00.000Z'),
    });
    expect(secondTick).toEqual({ evaluated: 0, fired: 0 });
    expect(queued).toHaveLength(1);
    expect(await visibleNotifications(user.id)).toHaveLength(1);
  });

  it('the dispatch job ignores a non-notification event instead of throwing (stray bus noise)', async () => {
    const user = await harness.seedUser({ email: 'noise@bt.test', username: 'noise' });
    await drainThroughDispatchJob([
      { type: 'system.noise', userId: user.id } as unknown as DispatchableEvent,
    ]);
    expect(await visibleNotifications(user.id)).toHaveLength(0);
  });
});
