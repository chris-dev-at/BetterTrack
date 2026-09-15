import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationDigestRepository } from '../../data/repositories/notificationDigestRepository';
import { createNotificationRepository } from '../../data/repositories/notificationRepository';
import { createUserRepository } from '../../data/repositories/userRepository';
import type { Database } from '../../data/db';
import type { FriendRequestEvent } from '../../events';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createDigestService } from '../../services/notifications/digestService';
import type { PushMessage } from '../../services/notifications/fcm';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../../services/notifications/notificationDispatcher';
import {
  DIGEST_DAILY_SCHEDULER_ID,
  DIGEST_SCAN_INTERVAL_MS,
  DIGEST_WEEKLY_SCHEDULER_ID,
  createDigestDailyJob,
  createDigestWeeklyJob,
} from '../definitions/digestJobs';

/**
 * V5-P3 digest scan cadence (#1590). A digest period is the RECIPIENT's local
 * day/week, and the service only claims a group once that user's own period has
 * closed — so the SCAN cadence decides when a boundary is observed. The former
 * single daily tick at 08:00 Europe/Vienna (06:00 UTC) is 23:00 the previous
 * local day at UTC−7: the group was still "current" at the only moment anyone
 * looked, so a daily digest slipped an extra day and a weekly one an extra week.
 *
 * The proof has two halves, both asserted below:
 *  - the SCHEDULE ticks at least hourly (the job specs), and
 *  - replaying those ticks delivers each user's summary on the FIRST tick after
 *    their own local period closes — never a period later, and never twice.
 */

const OCCURRED_AT = '2026-07-18T09:00:00.000Z';

let harness: TestHarness;
let db: Database;
let digestRepo: ReturnType<typeof createNotificationDigestRepository>;
let userRepo: ReturnType<typeof createUserRepository>;
let fcmCalls: { userId: string; message: PushMessage }[];
let clock: Date;

function makeDispatcher(): NotificationDispatcher {
  return createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    users: userRepo,
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        fcmCalls.push({ userId, message });
      },
    } as never,
    digest: {
      cadenceFor: (userId, type) => digestRepo.cadenceFor(userId, type),
      enqueue: (item) => digestRepo.enqueue(item),
    },
    now: () => clock,
    logger: harness.ctx.logger,
  });
}

function makeDigestService() {
  return createDigestService({
    repo: digestRepo,
    users: userRepo,
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        fcmCalls.push({ userId, message });
      },
    },
    routing: createNotificationRepository(db),
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

/** A digest job stub: the schedule specs are what these tests read off it. */
const DIGEST_JOB_STUB = {
  deliverDue: async () => ({ groups: 0, sent: 0, deferred: 0 }),
} as never;

/**
 * The real tick spacing of a cadence's sweep, read off the JOB DEFINITION (not a
 * local constant): a sweep put back on a once-a-day cron has no interval at all
 * and fails here rather than silently making the replay below optimistic.
 */
function scanIntervalMs(cadence: 'daily' | 'weekly'): number {
  const job =
    cadence === 'daily'
      ? createDigestDailyJob({ digest: DIGEST_JOB_STUB })
      : createDigestWeeklyJob({ digest: DIGEST_JOB_STUB });
  const every = job.schedule?.every;
  if (!every) throw new Error(`${cadence} digest sweep must run on an interval (#1590)`);
  return every;
}

/**
 * Replay the digest sweep on its real cadence between two instants and return
 * the instant of every tick that actually delivered a summary.
 */
async function sweep(cadence: 'daily' | 'weekly', from: Date, until: Date): Promise<Date[]> {
  const service = makeDigestService();
  const step = scanIntervalMs(cadence);
  const delivered: Date[] = [];
  for (let t = from.getTime(); t <= until.getTime(); t += step) {
    clock = new Date(t);
    const result = await service.deliverDue(cadence);
    if (result.sent > 0) delivered.push(new Date(t));
  }
  return delivered;
}

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  digestRepo = createNotificationDigestRepository(db);
  userRepo = createUserRepository(db);
  fcmCalls = [];
  clock = new Date('2026-07-18T20:00:00.000Z');
});

afterEach(async () => {
  await harness.ctx.events.close();
});

describe('digest scan cadence (§13.5 V5-P3, #1590)', () => {
  it('both digest sweeps are scheduled at least hourly, so every zone boundary is observed', () => {
    expect(createDigestDailyJob({ digest: DIGEST_JOB_STUB }).schedule).toEqual({
      id: DIGEST_DAILY_SCHEDULER_ID,
      every: DIGEST_SCAN_INTERVAL_MS,
    });
    expect(createDigestWeeklyJob({ digest: DIGEST_JOB_STUB }).schedule).toEqual({
      id: DIGEST_WEEKLY_SCHEDULER_ID,
      every: DIGEST_SCAN_INTERVAL_MS,
    });
    // At most an hour between ticks: the worst-case lag behind ANY zone's local
    // midnight, including the :30/:45 offset zones.
    expect(DIGEST_SCAN_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('a negative-offset user gets the DAILY summary for their own completed local day', async () => {
    const user = await harness.seedUser({ email: 'la@bt.test', username: 'ladaily' });
    // Timezone only — quiet hours stay off, so nothing else can hold the send.
    await userRepo.setQuietHours(user.id, { timezone: 'America/Los_Angeles' });
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    // 13:00 PDT on 2026-07-18 — the recipient's local day d:2026-07-18.
    clock = new Date('2026-07-18T20:00:00.000Z');
    const dispatcher = makeDispatcher();
    await dispatcher.dispatch(friendRequestEvent(user.id, 'la-1'));
    await dispatcher.dispatch(friendRequestEvent(user.id, 'la-2'));
    expect(fcmCalls).toHaveLength(0); // deferred into the digest queue

    // That local day closes at 00:00 PDT on 07-19 = 07:00 UTC.
    const localMidnight = new Date('2026-07-19T07:00:00.000Z');
    const delivered = await sweep(
      'daily',
      clock,
      new Date(localMidnight.getTime() + 36 * 60 * 60 * 1000),
    );

    // Exactly one summary, on the first sweep after the user's own day closed —
    // not the following local day (the 06:00 UTC cron was still 07-18 for them).
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.getTime()).toBeGreaterThanOrEqual(localMidnight.getTime());
    expect(delivered[0]!.getTime() - localMidnight.getTime()).toBeLessThanOrEqual(
      DIGEST_SCAN_INTERVAL_MS,
    );
    expect(fcmCalls).toHaveLength(1);
    expect(fcmCalls[0]!.message.body).toContain('2');
  });

  it('a negative-offset user gets the WEEKLY summary without slipping an extra week', async () => {
    const user = await harness.seedUser({ email: 'la-w@bt.test', username: 'laweekly' });
    await userRepo.setQuietHours(user.id, { timezone: 'America/Los_Angeles' });
    await digestRepo.setCadences(user.id, { 'friend.request': 'weekly' });

    // Saturday 2026-07-18, 13:00 PDT — ISO week w:2026-W29 for this recipient.
    clock = new Date('2026-07-18T20:00:00.000Z');
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'la-w-1'));

    // The week closes at 00:00 PDT on Monday 2026-07-20 = 07:00 UTC.
    const localWeekEnd = new Date('2026-07-20T07:00:00.000Z');
    const delivered = await sweep(
      'weekly',
      clock,
      new Date(localWeekEnd.getTime() + 12 * 60 * 60 * 1000),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.getTime()).toBeGreaterThanOrEqual(localWeekEnd.getTime());
    expect(delivered[0]!.getTime() - localWeekEnd.getTime()).toBeLessThanOrEqual(
      DIGEST_SCAN_INTERVAL_MS,
    );
    expect(fcmCalls).toHaveLength(1);
  });

  it('a positive-offset user still gets exactly ONE summary per local day (no regression)', async () => {
    const user = await harness.seedUser({ email: 'syd@bt.test', username: 'syddaily' });
    await userRepo.setQuietHours(user.id, { timezone: 'Australia/Sydney' });
    await digestRepo.setCadences(user.id, { 'friend.request': 'daily' });

    // 12:30 Sydney on 2026-07-18 (UTC+10) — local day d:2026-07-18.
    clock = new Date('2026-07-18T02:30:00.000Z');
    const dispatcher = makeDispatcher();
    await dispatcher.dispatch(friendRequestEvent(user.id, 'syd-1'));
    await dispatcher.dispatch(friendRequestEvent(user.id, 'syd-2'));

    // That day closes at 00:00 Sydney on 07-19 = 14:00 UTC on 07-18.
    const firstClose = new Date('2026-07-18T14:00:00.000Z');
    const firstRun = await sweep('daily', clock, new Date('2026-07-19T02:00:00.000Z'));
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]!.getTime()).toBeGreaterThanOrEqual(firstClose.getTime());
    expect(firstRun[0]!.getTime() - firstClose.getTime()).toBeLessThanOrEqual(
      DIGEST_SCAN_INTERVAL_MS,
    );
    expect(fcmCalls).toHaveLength(1);

    // A second local day produces its own single summary — the hourly sweep in
    // between never splits or repeats a period.
    clock = new Date('2026-07-19T02:30:00.000Z'); // 12:30 Sydney on 07-19
    await makeDispatcher().dispatch(friendRequestEvent(user.id, 'syd-3'));
    const secondRun = await sweep(
      'daily',
      clock,
      new Date('2026-07-20T02:00:00.000Z'), // through the whole next local day
    );
    const secondClose = new Date('2026-07-19T14:00:00.000Z');
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]!.getTime()).toBeGreaterThanOrEqual(secondClose.getTime());
    expect(secondRun[0]!.getTime() - secondClose.getTime()).toBeLessThanOrEqual(
      DIGEST_SCAN_INTERVAL_MS,
    );
    expect(fcmCalls).toHaveLength(2);
    expect(fcmCalls[1]!.message.body).toContain('1');
  });
});
