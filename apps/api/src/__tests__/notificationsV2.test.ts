import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_SECURITY_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  notificationSettingsResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createProfileRepository } from '../data/repositories/profileRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Notifications v2 platform surface (#368): FCM device-token registration,
 * web-push subscriptions, the four-channel settings response with global mute
 * and channel availability, and the friend-activity / share-event producers.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function deviceRows() {
  return harness.db.select().from(schema.deviceTokens);
}

async function subscriptionRows() {
  return harness.db.select().from(schema.pushSubscriptions);
}

async function visibleNotifications(userId: string, type?: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden && (type === undefined || r.type === type));
}

/** Canonical friendship insert (schema stores each pair once, `user_a < user_b`). */
async function makeFriends(a: string, b: string) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await harness.db
    .insert(schema.friendships)
    .values({ userA: lo, userB: hi })
    .onConflictDoNothing();
}

describe('POST/DELETE /api/v1/notifications/devices (#368/#351)', () => {
  it('registers a token, refreshes idempotently, and re-binds it across accounts', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    const first = await aliceAgent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'fcm-token-1', platform: 'android' });
    expect(first.status).toBe(200);

    // Re-registering the same token is an upsert, never a duplicate.
    await aliceAgent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'fcm-token-1', platform: 'android' });
    let rows = await deviceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(alice.id);

    // The same physical device logs into Bob's account → the token MOVES with
    // it, so Alice can never keep receiving Bob's pushes.
    await bobAgent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'fcm-token-1', platform: 'android' });
    rows = await deviceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(bob.id);
  });

  it('DELETE removes only the caller’s own token (someone else’s is untouched)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    await aliceAgent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'alice-token', platform: 'ios' });

    // Bob cannot delete Alice's token — the delete is silently scoped to Bob.
    const foreign = await bobAgent
      .delete('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'alice-token' });
    expect(foreign.status).toBe(200);
    expect(await deviceRows()).toHaveLength(1);

    // Alice deletes her own; idempotent on repeat.
    await aliceAgent
      .delete('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'alice-token' });
    expect(await deviceRows()).toHaveLength(0);
    const again = await aliceAgent
      .delete('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 'alice-token' });
    expect(again.status).toBe(200);
  });

  it('rejects a malformed registration (unknown platform / missing token)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const badPlatform = await agent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 't', platform: 'blackberry' });
    expect(badPlatform.status).toBe(400);
    const noToken = await agent
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ platform: 'android' });
    expect(noToken.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(harness.app)
      .post('/api/v1/notifications/devices')
      .set(...XRW)
      .send({ token: 't', platform: 'android' });
    expect(res.status).toBe(401);
  });
});

describe('POST/DELETE /api/v1/notifications/web-push (#368/#350)', () => {
  const SUB = {
    endpoint: 'https://push.example.com/sub/1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
  };

  it('stores a subscription, upserts by endpoint, and unsubscribes the caller’s own', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    expect(
      (
        await agent
          .post('/api/v1/notifications/web-push')
          .set(...XRW)
          .send(SUB)
      ).status,
    ).toBe(200);
    await agent
      .post('/api/v1/notifications/web-push')
      .set(...XRW)
      .send({ ...SUB, keys: { p256dh: 'rotated', auth: 'rotated' } });

    let rows = await subscriptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('rotated');

    await agent
      .delete('/api/v1/notifications/web-push')
      .set(...XRW)
      .send({ endpoint: SUB.endpoint });
    rows = await subscriptionRows();
    expect(rows).toHaveLength(0);
  });
});

describe('GET/PATCH /api/v1/settings/notifications — v2 surface (#368)', () => {
  it('reports the four-channel matrix, mute, and deployment channel availability', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await agent.get('/api/v1/settings/notifications');
    expect(res.status).toBe(200);
    const settings = notificationSettingsResponseSchema.parse(res.body);
    expect(settings.muted).toBe(false);
    // Test env: SMTP unset, no FCM key, no VAPID, no Telegram bot token,
    // no Discord webhook — only in-app is live.
    expect(settings.channels).toEqual({
      inapp: true,
      email: false,
      telegram: false,
      discord: false,
      push: false,
      webpush: false,
    });
    expect(settings.webPushPublicKey).toBeNull();
    // Lean email defaults (V4-P0c): a non-account type defaults email OFF; the
    // bell / phone-push / web-push channels are unchanged (all ON). Telegram +
    // Discord default ON per-type once the user configures them (V4-P10).
    expect(settings.matrix['friend.activity']).toEqual({
      inapp: true,
      email: false,
      telegram: true,
      discord: true,
      push: true,
      webpush: true,
    });
  });

  it('new account: email defaults ON only for the account/security category, OFF everywhere else (V4-P0c)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await agent.get('/api/v1/settings/notifications');
    const settings = notificationSettingsResponseSchema.parse(res.body);

    const emailOn = ACCOUNT_SECURITY_NOTIFICATION_TYPES as readonly string[];
    for (const type of NOTIFICATION_TYPES) {
      const cell = settings.matrix[type];
      // Bell + both push channels + telegram + discord default ON for EVERY
      // type — unchanged/added by V4-P10.
      expect(cell).toMatchObject({
        inapp: true,
        push: true,
        webpush: true,
        telegram: true,
        discord: true,
      });
      // Email defaults ON only for account/security types.
      expect(cell.email).toBe(emailOn.includes(type));
    }
    // The account/security set is exactly the `account` category.
    expect([...emailOn].sort()).toEqual([
      'account.data_export',
      'account.invite',
      'account.temp_password',
    ]);
  });

  it('migration = pure default flip: explicit email overrides survive byte-identical (V4-P0c)', async () => {
    // An "existing user" who, before the flip, explicitly turned email ON for one
    // sharing type and OFF for another. The lean-defaults change is a pure
    // service-level flip (no settings rows migrated), so those explicit choices
    // survive untouched while every un-overridden non-account type flips to OFF.
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    await harness.db.insert(schema.notificationSettings).values({
      userId: alice.id,
      channel: 'email',
      enabled: true,
      config: { 'portfolio.shared': true, 'watchlist.shared': false },
    });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const settings = notificationSettingsResponseSchema.parse(
      (await agent.get('/api/v1/settings/notifications')).body,
    );
    // Explicit survivors — the exact cells the user set, unchanged.
    expect(settings.matrix['portfolio.shared'].email).toBe(true); // explicit ON survives
    expect(settings.matrix['watchlist.shared'].email).toBe(false); // explicit OFF survives
    // Un-overridden non-account types flipped to OFF…
    expect(settings.matrix['friend.activity'].email).toBe(false);
    expect(settings.matrix['alert.triggered'].email).toBe(false);
    // …and account/security stays ON.
    expect(settings.matrix['account.temp_password'].email).toBe(true);
    expect(settings.matrix['account.invite'].email).toBe(true);
  });

  it('global mute persists via PATCH and suppresses delivery end-to-end', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    const muted = await bobAgent
      .patch('/api/v1/settings/notifications')
      .set(...XRW)
      .send({ muted: true });
    expect(muted.status).toBe(200);
    expect(notificationSettingsResponseSchema.parse(muted.body).muted).toBe(true);

    // A friend request lands while Bob is muted → nothing surfaces anywhere.
    await harness.ctx.social.sendRequest(alice.id, 'bob');
    expect(await visibleNotifications(bob.id)).toHaveLength(0);

    // Unmute → future events deliver again (the muted one stays consumed).
    await bobAgent
      .patch('/api/v1/settings/notifications')
      .set(...XRW)
      .send({ muted: false });
    const unmuted = await bobAgent.get('/api/v1/settings/notifications');
    expect(notificationSettingsResponseSchema.parse(unmuted.body).muted).toBe(false);
  });
});

describe('friend-activity events (#368, V3-P6 opt-in prefs)', () => {
  async function shareDefaultPortfolio(ownerId: string): Promise<string> {
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(ownerId);
    // Share through the V3-P5 audience picker — the ONE enforcement path the
    // friend-activity producer re-checks per viewer at emit time.
    await harness.ctx.social.setAudience(ownerId, 'portfolio', portfolioId, {
      audience: 'all_friends',
    });
    return portfolioId;
  }

  async function seedAsset(): Promise<string> {
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
    return asset!.id;
  }

  function buyInput(assetId: string) {
    return {
      assetId,
      side: 'buy' as const,
      quantity: 2,
      price: 10,
      fee: 0,
      executedAt: '2026-07-01T00:00:00.000Z',
    };
  }

  it('notifies an opted-in, authorized viewer about a buy — and never the rest', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const fan = await harness.seedUser({ email: 'fan@bt.test', username: 'fan' });
    const quiet = await harness.seedUser({ email: 'quiet@bt.test', username: 'quiet' });
    await makeFriends(owner.id, fan.id);
    await makeFriends(owner.id, quiet.id);
    const portfolioId = await shareDefaultPortfolio(owner.id);

    // Fan opted into activity alerts on this shared portfolio (V3-P6 toggle).
    const profile = createProfileRepository(harness.db);
    await profile.setActivityPref(fan.id, 'portfolio', portfolioId, true);

    const assetId = await seedAsset();
    await harness.ctx.portfolio.createTransactions(owner.id, portfolioId, [buyInput(assetId)]);

    const fanRows = await visibleNotifications(fan.id, 'friend.activity');
    expect(fanRows).toHaveLength(1);
    expect(fanRows[0]!.body).toBe('owner bought AAPL.');
    // No pref → no notification; the owner never notifies themselves.
    expect(await visibleNotifications(quiet.id, 'friend.activity')).toHaveLength(0);
    expect(await visibleNotifications(owner.id, 'friend.activity')).toHaveLength(0);
  });

  it('a pref that outlived a revoked share notifies NOBODY (privacy re-check at emit)', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const exFriend = await harness.seedUser({ email: 'ex@bt.test', username: 'exfriend' });
    await makeFriends(owner.id, exFriend.id);
    const portfolioId = await shareDefaultPortfolio(owner.id);
    const profile = createProfileRepository(harness.db);
    await profile.setActivityPref(exFriend.id, 'portfolio', portfolioId, true);

    // The share is revoked — the pref row remains, access does not.
    await harness.ctx.social.setAudience(owner.id, 'portfolio', portfolioId, {
      audience: 'private',
    });

    const assetId = await seedAsset();
    await harness.ctx.portfolio.createTransactions(owner.id, portfolioId, [buyInput(assetId)]);

    expect(await visibleNotifications(exFriend.id, 'friend.activity')).toHaveLength(0);
  });

  it('a watchlist add notifies the opted-in viewer of that shared list', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const fan = await harness.seedUser({ email: 'fan@bt.test', username: 'fan' });
    await makeFriends(owner.id, fan.id);

    const lists = await harness.ctx.workboard.listWatchlists(owner.id);
    const general = lists[0]!.id;
    await harness.ctx.workboard.setSharing(owner.id, 'friends');
    const profile = createProfileRepository(harness.db);
    await profile.setActivityPref(fan.id, 'watchlist', general, true);

    const assetId = await seedAsset();
    await harness.ctx.workboard.addItem(owner.id, assetId, general);

    const rows = await visibleNotifications(fan.id, 'friend.activity');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('owner added AAPL to a shared watchlist.');
  });
});

describe('watchlist/conglomerate share events via the audience picker (#368)', () => {
  it('sharing a watchlist to all friends notifies each of them once', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const f1 = await harness.seedUser({ email: 'f1@bt.test', username: 'friendone' });
    await makeFriends(owner.id, f1.id);

    const lists = await harness.ctx.workboard.listWatchlists(owner.id);
    const general = lists[0]!.id;
    await harness.ctx.social.setAudience(owner.id, 'watchlist', general, {
      audience: 'all_friends',
    });

    const rows = await visibleNotifications(f1.id, 'watchlist.shared');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('owner shared a watchlist with you.');

    // Re-setting the same audience (or narrowing + widening) never re-notifies.
    await harness.ctx.social.setAudience(owner.id, 'watchlist', general, {
      audience: 'all_friends',
    });
    expect(await visibleNotifications(f1.id, 'watchlist.shared')).toHaveLength(1);
  });

  it('specific-friends shares notify exactly the picked members', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const picked = await harness.seedUser({ email: 'p@bt.test', username: 'picked' });
    const skipped = await harness.seedUser({ email: 's@bt.test', username: 'skipped' });
    await makeFriends(owner.id, picked.id);
    await makeFriends(owner.id, skipped.id);

    const lists = await harness.ctx.workboard.listWatchlists(owner.id);
    await harness.ctx.social.setAudience(owner.id, 'watchlist', lists[0]!.id, {
      audience: 'specific_friends',
      friendIds: [picked.id],
    });

    expect(await visibleNotifications(picked.id, 'watchlist.shared')).toHaveLength(1);
    expect(await visibleNotifications(skipped.id, 'watchlist.shared')).toHaveLength(0);
  });
});
