import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import type { Database } from '../../../data/db';
import { friendships, notifications, notificationSettings } from '../../../data/schema';
import type {
  FriendAcceptedEvent,
  FriendRequestEvent,
  PortfolioSharedEvent,
} from '../../../events';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';

const OCCURRED_AT = '2026-07-04T00:00:00.000Z';

let harness: TestHarness;
let db: Database;
let dispatcher: NotificationDispatcher;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  dispatcher = createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    logger: harness.ctx.logger,
  });
});

afterEach(async () => {
  // Drop subscriptions so this file's dispatcher never handles another file's
  // events on the process-shared ioredis-mock pub/sub bus, then quit the bus's
  // duplicated connections so their message listeners don't accumulate.
  await dispatcher.stop();
  await harness.ctx.events.close();
});

async function notificationsFor(userId: string, type?: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return type ? rows.filter((r) => r.type === type) : rows;
}

/** Poll until at least one `type` notification exists for the user, or time out. */
async function waitForNotification(userId: string, type: string, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const rows = await notificationsFor(userId, type);
    if (rows.length > 0) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 15));
  }
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

    const rows = await notificationsFor(recipient.id);
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

    const byType = new Map((await notificationsFor(recipient.id)).map((r) => [r.type, r]));
    expect(byType.get('friend.accepted')?.body).toBe('bob accepted your friend request.');
    expect(byType.get('portfolio.shared')?.body).toBe('anna shared their portfolio with friends.');
  });

  it('dedupes: re-dispatching the same event does not create a second row', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    const event = friendRequestEvent({ userId: recipient.id });

    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(await notificationsFor(recipient.id)).toHaveLength(1);
  });

  it('treats the in-app channel as on by default when the user has no settings row', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await notificationsFor(recipient.id)).toHaveLength(1);
  });

  it('suppresses the row when the in-app channel is explicitly disabled', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await db
      .insert(notificationSettings)
      .values({ userId: recipient.id, channel: 'inapp', enabled: false });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await notificationsFor(recipient.id)).toHaveLength(0);
  });

  it('start() subscribes so a published event is dispatched end-to-end', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await dispatcher.start();

    await harness.ctx.events.publish(friendRequestEvent({ userId: recipient.id }));

    const rows = await waitForNotification(recipient.id, 'friend.request');
    expect(rows).toHaveLength(1);
  });
});

describe('producers → dispatcher (end-to-end over the bus)', () => {
  beforeEach(async () => {
    await dispatcher.start();
  });

  it('creating a friend request notifies the addressee', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    await harness.ctx.social.sendRequest(alice.id, 'bob');

    const rows = await waitForNotification(bob.id, 'friend.request');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('alice sent you a friend request.');
    // No self / requester notification.
    expect(await notificationsFor(alice.id, 'friend.request')).toHaveLength(0);
  });

  it('accepting a request notifies the original requester', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });

    await harness.ctx.social.sendRequest(alice.id, 'bob');
    const { incoming } = await harness.ctx.social.listRequests(bob.id);
    expect(incoming).toHaveLength(1);
    await harness.ctx.social.accept(bob.id, incoming[0]!.id);

    const rows = await waitForNotification(alice.id, 'friend.accepted');
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

    expect(await waitForNotification(f1.id, 'portfolio.shared')).toHaveLength(1);
    expect(await waitForNotification(f2.id, 'portfolio.shared')).toHaveLength(1);
    expect(await notificationsFor(stranger.id, 'portfolio.shared')).toHaveLength(0);
    // The owner never notifies themselves.
    expect(await notificationsFor(owner.id, 'portfolio.shared')).toHaveLength(0);
  });

  it('does not notify when visibility is unchanged or set to a non-friends value', async () => {
    const owner = await harness.seedUser({ email: 'owner@bt.test', username: 'owner' });
    const friend = await harness.seedUser({ email: 'f@bt.test', username: 'buddy' });
    await makeFriends(owner.id, friend.id);

    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
    // Share once → one notification.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });
    expect(await waitForNotification(friend.id, 'portfolio.shared')).toHaveLength(1);

    // A rename (visibility untouched) and a re-set to friends must not re-notify.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { name: 'Renamed' });
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });
    // Turning it off then on again is a fresh transition, but the event key is the
    // same (portfolio + owner), so dedupe keeps it at one row.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'private' });
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { visibility: 'friends' });

    // Give any stray publish time to land, then assert still exactly one.
    await new Promise((r) => setTimeout(r, 60));
    expect(await notificationsFor(friend.id, 'portfolio.shared')).toHaveLength(1);
  });
});
