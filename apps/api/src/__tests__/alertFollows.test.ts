import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Quote } from '@bettertrack/contracts';

import { createAlertRepository } from '../data/repositories/alertRepository';
import { createUserFollowsRepository } from '../data/repositories/userFollowsRepository';
import * as schema from '../data/schema';
import { runAlertsEvaluation } from '../services/alerts/alertEvaluator';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Alert follows (#455): per-followed-person `notifyOnAlertCreate` /
 * `notifyOnAlertFire` triggers + the owner's `alerts_visible_to_followers`
 * privacy gate. Covers the issue's acceptance criteria end-to-end through the
 * REAL pipeline (HTTP surface → services → notification center → synchronous
 * dispatcher → inbox rows):
 *  - the four trigger combinations are independent (created-only, fired-only,
 *    both, neither), both defaulting OFF;
 *  - a follower is notified ONLY while the owner shares their alerts; the ack
 *    is required to enable sharing; unsharing stops delivery immediately;
 *  - the owner's own `alert.triggered` delivery is unchanged and never doubled;
 *  - triggers are settable at follow time and via PATCH later, per person.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Seed the global catalog asset alerts reference. */
async function seedAsset(symbol = 'AAPL'): Promise<string> {
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Inc.`,
      currency: 'USD',
    })
    .returning({ id: schema.assets.id });
  return asset!.id;
}

/** Non-hidden notification rows for a user, optionally filtered by type. */
async function notifs(userId: string, type?: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden && (type === undefined || r.type === type));
}

function follow(
  agent: Agent,
  userId: string,
  prefs?: { notifyOnAlertCreate?: boolean; notifyOnAlertFire?: boolean },
): Promise<request.Response> {
  return agent
    .post('/api/v1/social/follows')
    .set(...XRW)
    .send({ userId, ...prefs });
}

/** Enable the owner's alert sharing through the real endpoint (ack included). */
async function shareAlerts(agent: Agent): Promise<void> {
  const res = await agent
    .put('/api/v1/alerts/sharing')
    .set(...XRW)
    .send({ visibleToFollowers: true, acknowledgeFollowers: true });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ visibleToFollowers: true });
}

async function createAlert(agent: Agent, assetId: string, threshold = 1) {
  const res = await agent
    .post('/api/v1/alerts')
    .set(...XRW)
    .send({ assetId, kind: 'price_above', threshold });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

function quoteResult(price: number): { value: Quote; stale: boolean; asOf: number } {
  return {
    value: { price, currency: 'USD', dayChangePct: null, asOf: '2026-07-14T12:00:00.000Z' },
    stale: false,
    asOf: 0,
  };
}

/** One evaluator tick with the follower fan-out wired exactly like the job. */
async function evaluate(now: number, price = 500) {
  const followsRepo = createUserFollowsRepository(harness.db);
  return runAlertsEvaluation({
    alertRepo: createAlertRepository(harness.db),
    marketData: createStubMarketData({ quote: () => quoteResult(price) }),
    redis: harness.ctx.redis,
    notify: harness.ctx.notify,
    followFanout: {
      listFireRecipients: (ownerId) => followsRepo.listAlertFollowRecipients(ownerId, 'fire'),
    },
    logger: harness.ctx.logger,
    now: () => now,
  });
}

describe('alert-follow prefs — settable at follow time and via PATCH, per person', () => {
  it('defaults OFF, honours follow-time prefs, and PATCHes each trigger independently', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const other = await harness.seedUser({ email: 'other@bt.test', username: 'other' });
    const me = await harness.seedUser({ email: 'me@bt.test', username: 'me' });
    const agent = await loginAgent(harness.app, me.email, me.password);

    // Follow-time prefs on one person; plain follow on the other (defaults OFF).
    expect((await follow(agent, owner.id, { notifyOnAlertFire: true })).status).toBe(202);
    expect((await follow(agent, other.id)).status).toBe(202);

    let list = (await agent.get('/api/v1/social/follows')).body;
    expect(
      Object.fromEntries(
        list.following.map((f: { user: { username: string } } & Record<string, unknown>) => [
          f.user.username,
          [f.notifyOnAlertCreate, f.notifyOnAlertFire],
        ]),
      ),
    ).toEqual({ owner: [false, true], other: [false, false] });

    // PATCH one trigger — the sibling and the other person are untouched.
    const patch = await agent
      .patch(`/api/v1/social/follows/${owner.id}`)
      .set(...XRW)
      .send({ notifyOnAlertCreate: true });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ notifyOnAlertCreate: true, notifyOnAlertFire: true });

    const off = await agent
      .patch(`/api/v1/social/follows/${owner.id}`)
      .set(...XRW)
      .send({ notifyOnAlertFire: false });
    expect(off.body).toMatchObject({ notifyOnAlertCreate: true, notifyOnAlertFire: false });

    list = (await agent.get('/api/v1/social/follows')).body;
    const other2 = list.following.find(
      (f: { user: { username: string } }) => f.user.username === 'other',
    );
    expect(other2).toMatchObject({ notifyOnAlertCreate: false, notifyOnAlertFire: false });

    // A repeat follow never flips existing prefs (#439 rule extended).
    await follow(agent, owner.id, { notifyOnAlertCreate: false });
    list = (await agent.get('/api/v1/social/follows')).body;
    const owner2 = list.following.find(
      (f: { user: { username: string } }) => f.user.username === 'owner',
    );
    expect(owner2).toMatchObject({ notifyOnAlertCreate: true, notifyOnAlertFire: false });
  });
});

describe('alert sharing endpoint — the §16 friction ladder', () => {
  it('defaults OFF, requires the ack to enable, disables without one', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const agent = await loginAgent(harness.app, owner.email, owner.password);

    expect((await agent.get('/api/v1/alerts/sharing')).body).toEqual({
      visibleToFollowers: false,
    });

    // Enabling without the acknowledgment is rejected server-side.
    const noAck = await agent
      .put('/api/v1/alerts/sharing')
      .set(...XRW)
      .send({ visibleToFollowers: true });
    expect(noAck.status).toBe(400);
    expect(noAck.body.error.code).toBe('ALERT_SHARING_ACK_REQUIRED');
    expect((await agent.get('/api/v1/alerts/sharing')).body).toEqual({
      visibleToFollowers: false,
    });

    await shareAlerts(agent);
    expect((await agent.get('/api/v1/alerts/sharing')).body).toEqual({
      visibleToFollowers: true,
    });

    // Disabling needs no ack.
    const off = await agent
      .put('/api/v1/alerts/sharing')
      .set(...XRW)
      .send({ visibleToFollowers: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ visibleToFollowers: false });
  });
});

describe('trigger matrix — created-only, fired-only, both, neither (all four combinations)', () => {
  it('routes create news and fire news independently per follower', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const createOnly = await harness.seedUser({ email: 'c@bt.test', username: 'createonly' });
    const fireOnly = await harness.seedUser({ email: 'f@bt.test', username: 'fireonly' });
    const both = await harness.seedUser({ email: 'b@bt.test', username: 'bothon' });
    const neither = await harness.seedUser({ email: 'n@bt.test', username: 'neitheron' });

    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    await shareAlerts(ownerAgent);

    const agents: Array<
      [typeof createOnly, { notifyOnAlertCreate?: boolean; notifyOnAlertFire?: boolean }]
    > = [
      [createOnly, { notifyOnAlertCreate: true }],
      [fireOnly, { notifyOnAlertFire: true }],
      [both, { notifyOnAlertCreate: true, notifyOnAlertFire: true }],
      [neither, {}],
    ];
    for (const [user, prefs] of agents) {
      const a = await loginAgent(harness.app, user.email, user.password);
      expect((await follow(a, owner.id, prefs)).status).toBe(202);
    }

    const assetId = await seedAsset();
    const created = await createAlert(ownerAgent, assetId, 100);

    // Create news: ONLY the created-only and both followers.
    expect(await notifs(createOnly.id, 'follow.alert.created')).toHaveLength(1);
    expect(await notifs(both.id, 'follow.alert.created')).toHaveLength(1);
    expect(await notifs(fireOnly.id, 'follow.alert.created')).toHaveLength(0);
    expect(await notifs(neither.id, 'follow.alert.created')).toHaveLength(0);
    // Creating an alert is not a fire — nobody gets fire news yet, nor the owner.
    expect(await notifs(fireOnly.id, 'follow.alert.fired')).toHaveLength(0);
    expect(await notifs(owner.id, 'alert.triggered')).toHaveLength(0);

    const [createRow] = await notifs(both.id, 'follow.alert.created');
    expect(createRow!.title).toBe('New alert from owner');
    expect(createRow!.body).toBe('owner created a price alert: AAPL above 100 USD.');

    // Fire it (price 500 > threshold 100): fire news ONLY to fired-only + both.
    const result = await evaluate(Date.parse('2026-07-14T12:00:00.000Z'));
    expect(result).toEqual({ evaluated: 1, fired: 1 });

    expect(await notifs(fireOnly.id, 'follow.alert.fired')).toHaveLength(1);
    expect(await notifs(both.id, 'follow.alert.fired')).toHaveLength(1);
    expect(await notifs(createOnly.id, 'follow.alert.fired')).toHaveLength(0);
    expect(await notifs(neither.id, 'follow.alert.fired')).toHaveLength(0);

    const [fireRow] = await notifs(fireOnly.id, 'follow.alert.fired');
    expect(fireRow!.title).toBe("owner's alert fired");
    expect(fireRow!.body).toBe("owner's price alert fired: AAPL above 100 USD.");

    // The OWNER's own delivery: exactly one `alert.triggered`, never a
    // follow.alert.* row — the fan-outs are disjoint from the owner.
    expect(await notifs(owner.id, 'alert.triggered')).toHaveLength(1);
    expect(await notifs(owner.id, 'follow.alert.fired')).toHaveLength(0);
    expect(await notifs(owner.id, 'follow.alert.created')).toHaveLength(0);

    // The neither follower stayed completely silent.
    expect(await notifs(neither.id)).toHaveLength(0);

    // Sanity: the created alert id rode the payloads (deep-link data).
    expect(createRow!.payload).toMatchObject({ alertId: created.id, actorUsername: 'owner' });
  });
});

describe('visibility — the owner controls whether followers get anything', () => {
  it('no sharing → no news; unsharing stops delivery immediately; owner unchanged', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const follower = await harness.seedUser({ email: 'fan@bt.test', username: 'fan' });

    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const followerAgent = await loginAgent(harness.app, follower.email, follower.password);
    await follow(followerAgent, owner.id, { notifyOnAlertCreate: true, notifyOnAlertFire: true });

    const assetId = await seedAsset();

    // Sharing OFF (default): both triggers on, yet a created alert notifies nobody.
    await createAlert(ownerAgent, assetId, 100);
    expect(await notifs(follower.id)).toHaveLength(0);

    // ... and a FIRE notifies only the owner.
    let tick = await evaluate(Date.parse('2026-07-14T12:00:00.000Z'));
    expect(tick).toEqual({ evaluated: 1, fired: 1 });
    expect(await notifs(follower.id)).toHaveLength(0);
    expect(await notifs(owner.id, 'alert.triggered')).toHaveLength(1);

    // Owner enables sharing: the next create + fire reach the follower.
    await shareAlerts(ownerAgent);
    const second = await createAlert(ownerAgent, assetId, 200);
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1);
    tick = await evaluate(Date.parse('2026-07-14T12:01:00.000Z'));
    expect(tick.fired).toBe(1); // the second alert (the first is a spent one-shot)
    expect(await notifs(follower.id, 'follow.alert.fired')).toHaveLength(1);

    // Owner unshares: delivery stops IMMEDIATELY — re-arm and re-fire the same
    // alert in a fresh window; the follower gets nothing new, the owner still
    // gets their own notification.
    const off = await ownerAgent
      .put('/api/v1/alerts/sharing')
      .set(...XRW)
      .send({ visibleToFollowers: false });
    expect(off.status).toBe(200);
    const rearm = await ownerAgent
      .post(`/api/v1/alerts/${second.id}/rearm`)
      .set(...XRW)
      .send();
    expect(rearm.status).toBe(200);

    tick = await evaluate(Date.parse('2026-07-14T12:02:00.000Z'));
    expect(tick.fired).toBe(1);
    expect(await notifs(follower.id, 'follow.alert.fired')).toHaveLength(1); // unchanged
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1); // unchanged
    expect(await notifs(owner.id, 'alert.triggered').then((r) => r.length)).toBeGreaterThanOrEqual(
      2,
    );

    // A new alert while unshared: still silence for the follower.
    await createAlert(ownerAgent, assetId, 300);
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1);
  });

  it('unfollowing (or flipping a trigger off) stops the news too', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const follower = await harness.seedUser({ email: 'fan@bt.test', username: 'fan' });

    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const followerAgent = await loginAgent(harness.app, follower.email, follower.password);
    await shareAlerts(ownerAgent);
    await follow(followerAgent, owner.id, { notifyOnAlertCreate: true });

    const assetId = await seedAsset();
    await createAlert(ownerAgent, assetId, 100);
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1);

    // Trigger off → the next create is silent.
    await followerAgent
      .patch(`/api/v1/social/follows/${owner.id}`)
      .set(...XRW)
      .send({ notifyOnAlertCreate: false });
    await createAlert(ownerAgent, assetId, 200);
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1);

    // Trigger back on, then unfollow entirely → silent again.
    await followerAgent
      .patch(`/api/v1/social/follows/${owner.id}`)
      .set(...XRW)
      .send({ notifyOnAlertCreate: true });
    await followerAgent
      .delete(`/api/v1/social/follows/${owner.id}`)
      .set(...XRW)
      .send();
    await createAlert(ownerAgent, assetId, 300);
    expect(await notifs(follower.id, 'follow.alert.created')).toHaveLength(1);
  });
});
