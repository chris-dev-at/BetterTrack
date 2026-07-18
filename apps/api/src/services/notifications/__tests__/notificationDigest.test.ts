import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuditRepository } from '../../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../../data/repositories/emailLogRepository';
import { createNotificationDigestRepository } from '../../../data/repositories/notificationDigestRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { Database } from '../../../data/db';
import { notificationDigestQueue, notificationSettings, notifications } from '../../../data/schema';
import type { FriendRequestEvent, WatchlistSharedEvent } from '../../../events';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAuditService } from '../../audit/auditService';
import { createEmailService, type EmailService } from '../../email/emailService';
import type { MailTransport, OutgoingMail } from '../../email/transport';
import { createDigestService, digestPeriodKey, type DigestService } from '../digestService';
import type { PushMessage } from '../fcm';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';

/**
 * V5-P3 digest mode (#575). Proves: a deferred (daily/weekly) type still lands
 * in the in-app bell INSTANTLY but its outbound channels are queued; the digest
 * job renders exactly ONE summary per (user, period) honouring the channel
 * matrix; delivery is idempotent per (user, period); and an empty period sends
 * nothing.
 */

const OCCURRED_AT = '2026-07-18T09:00:00.000Z';

// SMTP env flips config.email.enabled on so the email service actually delivers.
const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

let harness: TestHarness;
let db: Database;
let dispatcher: NotificationDispatcher;
let digestService: DigestService;
let transport: MailTransport & { sent: OutgoingMail[] };
let digestRepo: ReturnType<typeof createNotificationDigestRepository>;
let email: EmailService;

/**
 * The digest cron only delivers *complete* periods. The dispatcher stamps each
 * queued item with the wall-clock period at dispatch time, so the delivery run
 * must sit in a later period for the item's day/week to count as closed. Eight
 * days ahead of the real clock guarantees a strictly later daily AND weekly key.
 */
function deliverLater(): Date {
  return new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
}

beforeEach(async () => {
  harness = await createTestApp({ env: SMTP_ENV });
  db = harness.db;
  transport = recordingTransport();
  email = createEmailService({
    config: harness.ctx.config,
    logger: harness.ctx.logger,
    audit: createAuditService(createAuditRepository(db)),
    emailLog: createEmailLogRepository(db),
    transport,
  });
  digestRepo = createNotificationDigestRepository(db);
  dispatcher = createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    email,
    users: createUserRepository(db),
    digest: {
      cadenceFor: (userId, type) => digestRepo.cadenceFor(userId, type),
      enqueue: (item) => digestRepo.enqueue(item),
    },
    logger: harness.ctx.logger,
  });
  digestService = createDigestService({
    repo: digestRepo,
    users: createUserRepository(db),
    email,
    now: deliverLater,
    logger: harness.ctx.logger,
  });
});

afterEach(async () => {
  await harness.ctx.events.close();
});

async function visibleInappRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => !r.hidden);
}

async function emailQueueFor(userId: string) {
  const rows = await db
    .select()
    .from(notificationDigestQueue)
    .where(eq(notificationDigestQueue.userId, userId));
  return rows.filter((r) => r.channel === 'email');
}

/** Opt a user into email for the given types (email defaults OFF for non-account types). */
async function enableEmailFor(userId: string, ...types: string[]): Promise<void> {
  await db.insert(notificationSettings).values({
    userId,
    channel: 'email',
    enabled: true,
    config: Object.fromEntries(types.map((type) => [type, true])),
  });
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

function watchlistSharedEvent(overrides: Partial<WatchlistSharedEvent> = {}): WatchlistSharedEvent {
  return {
    type: 'watchlist.shared',
    userId: 'recipient',
    actorId: 'actor',
    actorUsername: 'carol',
    watchlistId: 'wl-1',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

describe('digest mode (§13.5 V5-P3)', () => {
  it('a daily-digest user gets exactly ONE email covering the day; in-app stays instant; idempotent', async () => {
    const user = await harness.seedUser({ email: 'd@bt.test', username: 'dailyuser' });
    await enableEmailFor(user.id, 'friend.request');
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    await dispatcher.dispatch(
      friendRequestEvent({ userId: user.id, requestId: 'r1', actorUsername: 'alice' }),
    );
    await dispatcher.dispatch(
      friendRequestEvent({ userId: user.id, requestId: 'r2', actorUsername: 'bob' }),
    );

    // In-app center received both instantly (it is the record a digest summarizes).
    expect(await visibleInappRows(user.id)).toHaveLength(2);
    // No instant email — the outbound copies were deferred into the queue.
    expect(transport.sent).toHaveLength(0);
    expect(await emailQueueFor(user.id)).toHaveLength(2);

    // The digest job renders ONE summary email covering both events.
    const first = await digestService.deliverDue('daily');
    expect(first.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe('d@bt.test');
    expect(mail.subject.toLowerCase()).toContain('daily');
    expect(mail.text).toContain('alice');
    expect(mail.text).toContain('bob');

    // Idempotent per (user, period): a re-run delivers nothing more.
    const second = await digestService.deliverDue('daily');
    expect(second.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });

  it('the weekly cadence produces one weekly summary (same shape)', async () => {
    const user = await harness.seedUser({ email: 'w@bt.test', username: 'weeklyuser' });
    await enableEmailFor(user.id, 'friend.request');
    await digestRepo.setCadences(user.id, { 'friend.request': 'weekly' });

    await dispatcher.dispatch(
      friendRequestEvent({ userId: user.id, requestId: 'r1', actorUsername: 'alice' }),
    );
    await dispatcher.dispatch(
      friendRequestEvent({ userId: user.id, requestId: 'r2', actorUsername: 'bob' }),
    );

    // Nothing delivers under the daily job — the items are weekly-keyed.
    expect((await digestService.deliverDue('daily')).sent).toBe(0);

    const res = await digestService.deliverDue('weekly');
    expect(res.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject.toLowerCase()).toContain('weekly');
    expect(transport.sent[0]!.text).toContain('alice');
    expect(transport.sent[0]!.text).toContain('bob');
  });

  it('honours the channel matrix: a type disabled for email is absent from the email digest', async () => {
    const user = await harness.seedUser({ email: 'm@bt.test', username: 'matrixuser' });
    // Only friend.request is email-enabled; watchlist.shared keeps the email default (OFF).
    await enableEmailFor(user.id, 'friend.request');
    await digestRepo.setCadences(user.id, {
      'friend.request': 'daily',
      'watchlist.shared': 'daily',
    });

    await dispatcher.dispatch(friendRequestEvent({ userId: user.id, requestId: 'r1' }));
    await dispatcher.dispatch(watchlistSharedEvent({ userId: user.id }));

    // Both landed in the bell; only the email-routed one queued for the email digest.
    expect(await visibleInappRows(user.id)).toHaveLength(2);
    const queued = await emailQueueFor(user.id);
    expect(queued.map((r) => r.type)).toEqual(['friend.request']);

    await digestService.deliverDue('daily');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain('friend request');
    expect(transport.sent[0]!.text).not.toContain('watchlist');
  });

  it('never flushes the still-accumulating current period; delivers once it closes', async () => {
    const user = await harness.seedUser({ email: 'c@bt.test', username: 'currentuser' });
    await enableEmailFor(user.id, 'friend.request');
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    // Queued under the current (in-progress) UTC day.
    await dispatcher.dispatch(friendRequestEvent({ userId: user.id, requestId: 'r1' }));
    expect(await emailQueueFor(user.id)).toHaveLength(1);

    // A cron run *inside* the same period (as the misaligned 08:00 Vienna cron
    // does) must NOT flush the partial day — else a day splits across two sends.
    const inProgress = createDigestService({
      repo: digestRepo,
      users: createUserRepository(db),
      email,
      now: () => new Date(), // current period == the item's period
      logger: harness.ctx.logger,
    });
    const early = await inProgress.deliverDue('daily');
    expect(early.groups).toBe(0);
    expect(early.sent).toBe(0);
    expect(transport.sent).toHaveLength(0);
    // The item is still pending — nothing was claimed.
    expect(await emailQueueFor(user.id)).toHaveLength(1);

    // Once the period has closed (a later run), exactly one summary is delivered.
    const closed = await digestService.deliverDue('daily'); // now = +8 days
    expect(closed.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('an empty period produces NO digest send', async () => {
    const user = await harness.seedUser({ email: 'e@bt.test', username: 'emptyuser' });
    // Cadence set, but nothing dispatched — the queue is empty for this period.
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    const res = await digestService.deliverDue('daily');
    expect(res.groups).toBe(0);
    expect(res.sent).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('delivers the push digest analogously and stays idempotent', async () => {
    const user = await harness.seedUser({ email: 'p@bt.test', username: 'pushuser' });
    const fcmCalls: { userId: string; message: PushMessage }[] = [];
    const webpushCalls: { userId: string; message: PushMessage }[] = [];
    const pushDigestService = createDigestService({
      repo: digestRepo,
      users: createUserRepository(db),
      fcm: {
        deliver: async (userId, message) => {
          fcmCalls.push({ userId, message });
        },
      },
      webPush: {
        deliver: async (userId, message) => {
          webpushCalls.push({ userId, message });
        },
      },
      // Items below are keyed to OCCURRED_AT's day; deliver the next day so that
      // period counts as closed.
      now: () => new Date('2026-07-19T08:00:00.000Z'),
      logger: harness.ctx.logger,
    });

    const period = digestPeriodKey('daily', new Date(OCCURRED_AT));
    await digestRepo.enqueue({
      userId: user.id,
      type: 'friend.request',
      channel: 'push',
      cadence: 'daily',
      period,
      title: 'New friend request',
      body: 'alice sent you a friend request.',
      data: {},
    });
    await digestRepo.enqueue({
      userId: user.id,
      type: 'friend.accepted',
      channel: 'push',
      cadence: 'daily',
      period,
      title: 'Friend request accepted',
      body: 'bob accepted your friend request.',
      data: {},
    });
    await digestRepo.enqueue({
      userId: user.id,
      type: 'friend.request',
      channel: 'webpush',
      cadence: 'daily',
      period,
      title: 'New friend request',
      body: 'alice sent you a friend request.',
      data: {},
    });

    const res = await pushDigestService.deliverDue('daily');
    expect(res.sent).toBe(2); // one FCM digest + one web-push digest
    expect(fcmCalls).toHaveLength(1);
    expect(fcmCalls[0]!.message.body).toContain('2');
    expect(webpushCalls).toHaveLength(1);

    // Idempotent: a re-run claims nothing.
    await pushDigestService.deliverDue('daily');
    expect(fcmCalls).toHaveLength(1);
    expect(webpushCalls).toHaveLength(1);
  });
});
