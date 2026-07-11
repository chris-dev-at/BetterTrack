import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../data/db';
import { friendships, notifications, notificationSettings, users } from '../../../data/schema';
import type {
  FriendAcceptedEvent,
  FriendRequestEvent,
  PortfolioSharedEvent,
} from '../../../events';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { NotificationDispatcher } from '../notificationDispatcher';

const OCCURRED_AT = '2026-07-04T00:00:00.000Z';

let harness: TestHarness;
let db: Database;
let dispatcher: NotificationDispatcher;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  // The context's own delivery core — the exact instance the test-mode
  // notification center delivers through, so direct dispatch() calls and
  // producer-driven emits exercise ONE pipeline (#368).
  dispatcher = harness.ctx.notificationDispatcher;
});

afterEach(async () => {
  // Quit the bus's duplicated connections so message listeners don't accumulate
  // on the process-shared ioredis-mock pub/sub.
  await harness.ctx.events.close();
});

async function allRowsFor(userId: string, type?: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return type ? rows.filter((r) => r.type === type) : rows;
}

/** Only the rows the inbox would show (#368: hidden rows are dedupe markers). */
async function visibleRowsFor(userId: string, type?: string) {
  return (await allRowsFor(userId, type)).filter((r) => !r.hidden);
}

/** Canonical friendship insert (schema stores each pair once, `user_a < user_b`). */
async function makeFriends(a: string, b: string) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await db.insert(friendships).values({ userA: lo, userB: hi }).onConflictDoNothing();
}

function friendRequestEvent(overrides: Partial<FriendRequestEvent> = {}): FriendRequestEvent {
  return {
    type: 'friend.request',
    userId: 'recipient',
    actorId: 'actor',
    actorUsername: 'alice',
    requestId: 'req-1',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

describe('notificationDispatcher.dispatch', () => {
  it('creates one in-app row with a human-readable title/body for friend.request', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'ruser' });
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id, actorUsername: 'anna' }));

    const rows = await visibleRowsFor(recipient.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('friend.request');
    expect(rows[0]!.title).toBe('New friend request');
    expect(rows[0]!.body).toBe('anna sent you a friend request.');
    expect(rows[0]!.readAt).toBeNull();
  });

  it('renders friend.accepted and portfolio.shared for the recipient', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });

    const accepted: FriendAcceptedEvent = {
      type: 'friend.accepted',
      userId: recipient.id,
      actorId: 'actor',
      actorUsername: 'bob',
      requestId: 'req-9',
      occurredAt: OCCURRED_AT,
    };
    await dispatcher.dispatch(accepted);

    const shared: PortfolioSharedEvent = {
      type: 'portfolio.shared',
      userId: recipient.id,
      actorId: 'owner',
      actorUsername: 'anna',
      portfolioId: 'pf-1',
      occurredAt: OCCURRED_AT,
    };
    await dispatcher.dispatch(shared);

    const byType = new Map((await visibleRowsFor(recipient.id)).map((r) => [r.type, r]));
    expect(byType.get('friend.accepted')?.body).toBe('bob accepted your friend request.');
    expect(byType.get('portfolio.shared')?.body).toBe('anna shared their portfolio with friends.');
  });

  it('renders the v2 event catalog: watchlist/conglomerate shares, friend activity, temp password', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });

    await dispatcher.dispatch({
      type: 'watchlist.shared',
      userId: recipient.id,
      actorId: 'owner',
      actorUsername: 'anna',
      watchlistId: 'wl-1',
      occurredAt: OCCURRED_AT,
    });
    await dispatcher.dispatch({
      type: 'conglomerate.shared',
      userId: recipient.id,
      actorId: 'owner',
      actorUsername: 'anna',
      conglomerateId: 'cg-1',
      occurredAt: OCCURRED_AT,
    });
    await dispatcher.dispatch({
      type: 'friend.activity',
      userId: recipient.id,
      actorId: 'owner',
      actorUsername: 'anna',
      itemKind: 'portfolio',
      itemId: 'pf-1',
      activity: 'buy',
      assetSymbol: 'AAPL',
      refId: 'txn:1',
      occurredAt: OCCURRED_AT,
    });
    await dispatcher.dispatch({
      type: 'account.temp_password',
      userId: recipient.id,
      occurredAt: OCCURRED_AT,
    });

    const byType = new Map((await visibleRowsFor(recipient.id)).map((r) => [r.type, r]));
    expect(byType.get('watchlist.shared')?.body).toBe('anna shared a watchlist with you.');
    expect(byType.get('conglomerate.shared')?.body).toBe('anna shared a conglomerate with you.');
    expect(byType.get('friend.activity')?.body).toBe('anna bought AAPL.');
    expect(byType.get('account.temp_password')?.title).toBe('Password was reset');
  });

  it('dedupes: re-dispatching the same event does not create a second row', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    const event = friendRequestEvent({ userId: recipient.id });

    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(await allRowsFor(recipient.id)).toHaveLength(1);
  });

  it('treats the in-app channel as on by default when the user has no settings row', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await visibleRowsFor(recipient.id)).toHaveLength(1);
  });

  it('writes only a hidden, read dedupe marker when the in-app channel is disabled', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await db
      .insert(notificationSettings)
      .values({ userId: recipient.id, channel: 'inapp', enabled: false });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    // Nothing surfaces in the inbox…
    expect(await visibleRowsFor(recipient.id)).toHaveLength(0);
    // …but the durable marker exists (idempotency under at-least-once, #368)
    // and a redelivery stays a no-op.
    const markers = await allRowsFor(recipient.id);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.hidden).toBe(true);
    expect(markers[0]!.readAt).not.toBeNull();
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await allRowsFor(recipient.id)).toHaveLength(1);
  });

  it('suppresses the visible row when the type is muted via the matrix config', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    // Channel stays on globally, but friend.request is routed away from in-app.
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'inapp',
      enabled: true,
      config: { 'friend.request': false },
    });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await visibleRowsFor(recipient.id, 'friend.request')).toHaveLength(0);
  });

  it('keeps the in-app row for a type whose in-app override is on, ignoring other types', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    // Only friend.accepted is muted in-app; friend.request has no override.
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'inapp',
      enabled: true,
      config: { 'friend.accepted': false },
    });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await visibleRowsFor(recipient.id, 'friend.request')).toHaveLength(1);
  });

  it('global mute suppresses every channel, leaving only the hidden marker', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await db.update(users).set({ notificationsMuted: true }).where(eq(users.id, recipient.id));

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    expect(await visibleRowsFor(recipient.id)).toHaveLength(0);
    const markers = await allRowsFor(recipient.id);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.hidden).toBe(true);
  });

  it('ignores an event whose recipient no longer exists', async () => {
    await dispatcher.dispatch(
      friendRequestEvent({ userId: '00000000-0000-7000-8000-000000000000' }),
    );
    // Nothing thrown, nothing written.
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(0);
  });
});

describe('producers → center → dispatcher (one pipeline, #368)', () => {
  it('creating a friend request notifies the addressee', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    await harness.ctx.social.sendRequest(alice.id, 'bob');

    const rows = await visibleRowsFor(bob.id, 'friend.request');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('alice sent you a friend request.');
    // No self / requester notification.
    expect(await allRowsFor(alice.id, 'friend.request')).toHaveLength(0);
  });

  it('accepting a request notifies the original requester', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    await harness.ctx.social.sendRequest(alice.id, 'bob');
    const { incoming } = await harness.ctx.social.listRequests(bob.id);
    expect(incoming).toHaveLength(1);
    await harness.ctx.social.accept(bob.id, incoming[0]!.id);

    const rows = await visibleRowsFor(alice.id, 'friend.accepted');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('bob accepted your friend request.');
  });

  it('sharing a portfolio notifies each current friend, once', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const f1 = await harness.seedUser({ email: 'f1@bt.test', username: 'friendone' });
    const f2 = await harness.seedUser({ email: 'f2@bt.test', username: 'friendtwo' });
    const stranger = await harness.seedUser({ email: 's@bt.test', username: 'stranger' });
    await makeFriends(owner.id, f1.id);
    await makeFriends(owner.id, f2.id);

    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });

    expect(await visibleRowsFor(f1.id, 'portfolio.shared')).toHaveLength(1);
    expect(await visibleRowsFor(f2.id, 'portfolio.shared')).toHaveLength(1);
    expect(await allRowsFor(stranger.id, 'portfolio.shared')).toHaveLength(0);
    // The owner never notifies themselves.
    expect(await allRowsFor(owner.id, 'portfolio.shared')).toHaveLength(0);
  });

  it('does not notify when visibility is unchanged or set to a non-friends value', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const friend = await harness.seedUser({ email: 'f@bt.test', username: 'buddy' });
    await makeFriends(owner.id, friend.id);

    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    // Share once → one notification.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });
    expect(await visibleRowsFor(friend.id, 'portfolio.shared')).toHaveLength(1);

    // A rename (visibility untouched) and a re-set to friends must not re-notify.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { name: 'Renamed' });
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });
    // Turning it off then on again is a fresh transition, but the event key is the
    // same (portfolio + owner), so dedupe keeps it at one row.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'private' });
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });

    expect(await allRowsFor(friend.id, 'portfolio.shared')).toHaveLength(1);
  });
});
