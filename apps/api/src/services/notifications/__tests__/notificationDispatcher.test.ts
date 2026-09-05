import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../data/db';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import { friendships, notifications, notificationSettings, users } from '../../../data/schema';
import type {
  FriendAcceptedEvent,
  FriendRequestEvent,
  PortfolioSharedEvent,
} from '../../../events';
import type { Logger } from '../../../logger';
import { notificationChannelSkippedTotal, readCounter } from '../../../metrics';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { TelegramChannel } from '../telegramChannel';
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

  it('renders a dropped standing-order period with its deep-link payload', async () => {
    const recipient = await harness.seedUser({ email: 'orders@bt.test', username: 'orders' });
    await dispatcher.dispatch({
      type: 'standing_order.skipped',
      userId: recipient.id,
      standingOrderId: '00000000-0000-7000-8000-00000000a111',
      periodKey: '2026-04-01',
      outcome: 'dropped',
      droppedCount: 3,
      orderLabel: 'Netflix',
      occurredAt: '2026-05-01T10:00:00.000Z',
    });

    const [row] = await visibleRowsFor(recipient.id, 'standing_order.skipped');
    expect(row).toMatchObject({
      type: 'standing_order.skipped',
      title: '3 standing order periods skipped',
      body: '3 scheduled occurrences for “Netflix”, through 2026-04-01, were not recorded before the newest period became due.',
      payload: {
        standingOrderId: '00000000-0000-7000-8000-00000000a111',
        periodKey: '2026-04-01',
        outcome: 'dropped',
        droppedCount: 3,
      },
    });
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
    await harness.ctx.portfolio.updatePortfolioWithVisibility(owner.id, portfolioId, {
      visibility: 'friends',
      confirmWiden: true,
    });

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
    await harness.ctx.portfolio.updatePortfolioWithVisibility(owner.id, portfolioId, {
      visibility: 'friends',
      confirmWiden: true,
    });
    expect(await visibleRowsFor(friend.id, 'portfolio.shared')).toHaveLength(1);

    // A rename (visibility untouched) and a re-set to friends must not re-notify.
    await harness.ctx.portfolio.updatePortfolio(owner.id, portfolioId, { name: 'Renamed' });
    await harness.ctx.portfolio.updatePortfolioWithVisibility(owner.id, portfolioId, {
      visibility: 'friends',
      confirmWiden: true,
    });
    // Turning it off then on again is a fresh transition, but the event key is the
    // same (portfolio + owner), so dedupe keeps it at one row.
    await harness.ctx.portfolio.updatePortfolioWithVisibility(owner.id, portfolioId, {
      visibility: 'private',
    });
    await harness.ctx.portfolio.updatePortfolioWithVisibility(owner.id, portfolioId, {
      visibility: 'friends',
      confirmWiden: true,
    });

    expect(await allRowsFor(friend.id, 'portfolio.shared')).toHaveLength(1);
  });
});

// ─── V5-P0 kill-switch: a deactivated channel never consumes an event (#1795) ──
//
// THE RULE under test (documented at the dispatcher): an event whose only routed
// destinations are deactivated channels is left undelivered AND re-deliverable —
// no inbox row, no dedupe marker — so the same event dispatched after the env
// flip delivers exactly once instead of being swallowed forever.
describe('deactivated Telegram/Discord (V5-P0 kill-switch, #1795)', () => {
  /** Route `friend.request` to Telegram only: in-app off, telegram on. */
  async function routeToTelegramOnly(userId: string) {
    await db.insert(notificationSettings).values({
      userId,
      channel: 'inapp',
      enabled: true,
      config: { 'friend.request': false },
    });
    await db.insert(notificationSettings).values({
      userId,
      channel: 'telegram',
      enabled: true,
      config: { 'friend.request': true },
    });
  }

  async function skipped(channel: string, outcome: string): Promise<number> {
    const samples = await readCounter(notificationChannelSkippedTotal);
    return (
      samples.find((s) => s.labels.channel === channel && s.labels.outcome === outcome)?.value ?? 0
    );
  }

  function capturingLogger() {
    const warns: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    const logger = {
      warn: (payload: Record<string, unknown>, msg: string) => warns.push({ payload, msg }),
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    return { warns, logger };
  }

  /**
   * A dispatcher wired the way `context.ts` wires it for a given switch state.
   * `linked` stands in for the preserved Telegram link row the kill-switch
   * keeps — the thing that makes a skipped fan-out a real lost delivery.
   */
  function dispatcherWith(
    telegram: TelegramChannel | null,
    logger?: Logger,
    linked: { telegram?: boolean; discord?: boolean } = { telegram: true },
  ) {
    return createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(db),
      users: createUserRepository(db),
      telegram,
      discord: null,
      deactivatedLinks: {
        telegram: async () => linked.telegram ?? false,
        discord: async () => linked.discord ?? false,
      },
      logger,
    });
  }

  it('writes NO row for an event whose only channel is deactivated, and delivers it once after the flip', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await routeToTelegramOnly(recipient.id);

    // Switch OFF — the channel set builds no Telegram channel.
    const off = dispatcherWith(null);
    await off.dispatch(friendRequestEvent({ userId: recipient.id }));
    // Not even the hidden dedupe marker: writing one here is what used to
    // consume the event permanently and invisibly.
    expect(await allRowsFor(recipient.id)).toHaveLength(0);

    // Re-dispatching while still off stays a no-op (nothing delivered twice).
    await off.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(await allRowsFor(recipient.id)).toHaveLength(0);

    // Operator flips BT_TELEGRAM_DISCORD_ENABLED back on: same event, same
    // routing — now it delivers, exactly once.
    const deliver = vi.fn(async () => undefined);
    const on = dispatcherWith({ deliver } as unknown as TelegramChannel);
    await on.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(deliver).toHaveBeenCalledTimes(1);
    // The marker exists now (in-app is routed off for this type, so it is the
    // hidden variety) and a redelivery is deduped against it.
    const rows = await allRowsFor(recipient.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hidden).toBe(true);
    await on.dispatch(friendRequestEvent({ userId: recipient.id }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await allRowsFor(recipient.id)).toHaveLength(1);
  });

  it('gives the operator a counter and one log line for the skipped fan-out', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await routeToTelegramOnly(recipient.id);

    const before = await skipped('telegram', 'deferred');
    const { warns, logger } = capturingLogger();
    const off = dispatcherWith(null, logger);
    await off.dispatch(friendRequestEvent({ userId: recipient.id, requestId: 'req-a' }));
    await off.dispatch(friendRequestEvent({ userId: recipient.id, requestId: 'req-b' }));

    // Every skip is counted…
    expect(await skipped('telegram', 'deferred')).toBe(before + 2);
    // …and the discovery is logged once per (channel, outcome), not per event.
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload).toMatchObject({ channel: 'telegram', outcome: 'deferred' });
    expect(warns[0]!.msg).toContain('BT_TELEGRAM_DISCORD_ENABLED');
  });

  it('still delivers — and counts the skip as dropped — when another channel is live', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    // In-app stays on (default) and Telegram is routed on as well.
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'telegram',
      enabled: true,
      config: { 'friend.request': true },
    });

    const before = await skipped('telegram', 'dropped');
    const { warns, logger } = capturingLogger();
    await dispatcherWith(null, logger).dispatch(friendRequestEvent({ userId: recipient.id }));

    // The bell still gets it — only the dead channel's copy is lost…
    expect(await visibleRowsFor(recipient.id)).toHaveLength(1);
    // …and that loss is visible to the operator rather than silent.
    expect(await skipped('telegram', 'dropped')).toBe(before + 1);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.payload).toMatchObject({ channel: 'telegram', outcome: 'dropped' });
  });

  it('leaves a globally muted recipient on the existing hidden-marker path', async () => {
    const recipient = await harness.seedUser({ email: 'r@bt.test', username: 'rec' });
    await routeToTelegramOnly(recipient.id);
    await db.update(users).set({ notificationsMuted: true }).where(eq(users.id, recipient.id));

    await dispatcherWith(null).dispatch(friendRequestEvent({ userId: recipient.id }));

    // Mute is the user's own decision, not a deployment failure: the marker is
    // still written, so a redelivery cannot resurrect a muted notification.
    const rows = await allRowsFor(recipient.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hidden).toBe(true);
  });
});
