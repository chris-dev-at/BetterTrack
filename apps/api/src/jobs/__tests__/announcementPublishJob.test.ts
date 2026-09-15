import { and, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Job } from 'bullmq';

import type { Database } from '../../data/db';
import { notifications as notificationsTable } from '../../data/schema';
import { createAnnouncementRepository } from '../../data/repositories/announcementRepository';
import { createAuditRepository } from '../../data/repositories/auditRepository';
import { createNotificationRepository } from '../../data/repositories/notificationRepository';
import { createUserRepository, type UserRepository } from '../../data/repositories/userRepository';
import type { Logger } from '../../logger';
import { createAuditService } from '../../services/audit/auditService';
import {
  announcementEventKey,
  createAnnouncementService,
  ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS,
  type AnnouncementPublishRequest,
  type AnnouncementService,
} from '../../services/announcements/announcementService';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import {
  createAnnouncementPublishJob,
  ANNOUNCEMENT_PUBLISH_CRON,
  ANNOUNCEMENT_PUBLISH_SCHEDULER_ID,
  ANNOUNCEMENT_PUBLISH_TZ,
} from '../definitions/announcementJobs';
import type { JobContext, JobPayload } from '../types';

/**
 * `announcements.publishDue` (ADMIN-W7a, #1909).
 *
 * The job's core runs against the real repositories and a real Postgres/PGlite
 * harness, with no Redis anywhere — `config.isTest` builds the context with
 * `queues === null`, so the enqueue side is a recorded seam and the handler is
 * invoked directly, exactly as the other job suites in this folder do it.
 *
 * What is proven here is the §9 idempotency contract, in the two shapes that
 * actually bite:
 *
 *  • **run it twice** — one fan-out, no duplicate inbox row, no double count;
 *  • **kill it mid-walk** — the next run finishes the job.
 *
 * plus the concurrency claim, the window refusal, and the bounded single retry
 * that replaced #1723's permanent re-fire.
 */

const logger = pino({ level: 'silent' }) as unknown as Logger;

let harness: TestHarness;
let db: Database;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function ctx(): JobContext {
  return {
    events: harness.ctx.events,
    deadLetter: {} as JobContext['deadLetter'],
    redis: harness.ctx.redis,
    logger,
    isFeatureEnabled: async () => true,
  };
}

/** Invoke the handler the way BullMQ would, with a payload and nothing else. */
function run(
  job: ReturnType<typeof createAnnouncementPublishJob>,
  data: JobPayload<'announcements.publishDue'> = {},
) {
  return job.handler({ data } as Job<JobPayload<'announcements.publishDue'>>, ctx());
}

interface Built {
  service: AnnouncementService;
  job: ReturnType<typeof createAnnouncementPublishJob>;
  repo: ReturnType<typeof createAnnouncementRepository>;
  notifications: ReturnType<typeof createNotificationRepository>;
  audit: ReturnType<typeof createAuditRepository>;
  enqueued: AnnouncementPublishRequest[];
  inserts: string[];
}

function build(
  clock: () => Date,
  options: {
    insert?: (
      input: Parameters<ReturnType<typeof createNotificationRepository>['insert']>[0],
      real: ReturnType<typeof createNotificationRepository>,
    ) => Promise<string | null>;
    users?: Pick<UserRepository, 'listRecipientsAfter'>;
    fanOutPageSize?: number;
  } = {},
): Built {
  const repo = createAnnouncementRepository(db);
  const notifications = createNotificationRepository(db);
  const auditRepo = createAuditRepository(db);
  const enqueued: AnnouncementPublishRequest[] = [];
  const inserts: string[] = [];
  const service = createAnnouncementService({
    repo,
    users: options.users ?? createUserRepository(db),
    notifications: {
      insert: async (input) => {
        inserts.push(input.userId);
        return options.insert ? options.insert(input, notifications) : notifications.insert(input);
      },
    },
    audit: createAuditService(auditRepo),
    enqueuePublish: async (request) => {
      enqueued.push(request);
    },
    now: clock,
    ...(options.fanOutPageSize !== undefined ? { fanOutPageSize: options.fanOutPageSize } : {}),
    logger,
  });
  return {
    service,
    job: createAnnouncementPublishJob({ announcements: service }),
    repo,
    notifications,
    audit: auditRepo,
    enqueued,
    inserts,
  };
}

const BODY = {
  severity: 'info',
  titleEn: 'Scheduled maintenance',
  bodyEn: 'Brief downtime tonight.',
  titleDe: 'Geplante Wartung',
  bodyDe: 'Heute Abend kurze Ausfallzeit.',
} as const;

/**
 * How many inbox rows one user holds for one announcement, counted straight off
 * the table. Deliberately NOT `existsForEventKey`: the claim under test is
 * "exactly one, ever", and a boolean cannot tell one row from three.
 */
async function noticeCount(userId: string, eventKey: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, userId),
        sql`${notificationsTable.payload} ->> 'eventKey' = ${eventKey}`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Every account the fan-out walks. Admin accounts are recipients too — that is
 * pre-existing announcement behaviour, not something this issue changes — so
 * the expected counts are read from the same source the walk uses rather than
 * guessed from the number of `seedUser` calls.
 */
async function recipientCount(): Promise<number> {
  return (await createUserRepository(db).listRecipientsAfter(null, 500)).length;
}

/** Every `announcement.publish` audit row for one announcement. */
async function publishAudits(built: Built, announcementId: string) {
  const { entries } = await built.audit.listForTarget({ targetId: announcementId, limit: 50 });
  return entries.filter((row) => row.action === 'announcement.publish');
}

describe('announcements.publishDue — schedule', () => {
  it('is a short repeatable sweep registered idempotently in the deploy timezone', () => {
    const { job } = build(() => new Date('2026-01-01T00:00:00.000Z'));
    expect(job.name).toBe('announcements.publishDue');
    expect(job.schedule).toEqual({
      id: ANNOUNCEMENT_PUBLISH_SCHEDULER_ID,
      pattern: ANNOUNCEMENT_PUBLISH_CRON,
      tz: ANNOUNCEMENT_PUBLISH_TZ,
    });
    // A banner is not a trading signal; five minutes is the whole budget.
    expect(ANNOUNCEMENT_PUBLISH_CRON).toBe('*/5 * * * *');
    // No kill switch owns it — an operator notice must survive the switches.
    expect(job.featureFlag).toBeUndefined();
  });
});

describe('announcements.publishDue — the window is the schedule', () => {
  it('defers a future startsAt, then publishes exactly once when the clock passes it', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'a@bt.test', username: 'alicepub' });
    const bob = await harness.seedUser({ email: 'b@bt.test', username: 'bobpub' });

    let now = new Date('2026-02-01T08:00:00.000Z');
    const built = build(() => now);
    const created = await built.service.create(
      { ...BODY, active: true, startsAt: '2026-02-03T09:00:00.000Z' },
      { id: admin.id },
    );
    const key = announcementEventKey(created.id);

    // Before the window opens the sweep sees nothing at all.
    expect(await run(built.job)).toMatchObject({ due: 0, published: 0, inserted: 0 });
    expect(built.inserts).toHaveLength(0);
    expect(await built.repo.hasBeenPublished(created.id)).toBe(false);

    // Past `startsAt`: one pass, every recipient, one stamp.
    now = new Date('2026-02-03T09:05:00.000Z');
    const recipients = await recipientCount();
    expect(await run(built.job)).toMatchObject({
      due: 1,
      published: 1,
      inserted: recipients,
      failed: 0,
      retriesScheduled: 0,
    });
    expect(await noticeCount(alice.id, key)).toBe(1);
    expect(await noticeCount(bob.id, key)).toBe(1);

    const row = (await built.repo.findById(created.id))!;
    expect(row.publishedAt).toEqual(now);
    expect(row.deliveredCount).toBe(recipients);
    expect(row.failedCount).toBe(0);
    expect(await publishAudits(built, created.id)).toHaveLength(1);
  });

  it('never publishes an announcement whose window has already closed', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'stale@bt.test', username: 'staleuser' });

    const now = () => new Date('2026-05-01T00:00:00.000Z');
    const built = build(now);
    const created = await built.service.create(
      {
        ...BODY,
        active: true,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-01-31T00:00:00.000Z',
      },
      { id: admin.id },
    );

    expect(await run(built.job)).toMatchObject({ due: 0, published: 0 });
    // …and addressed directly, the way a queued job from before the window
    // closed would arrive.
    expect(await run(built.job, { announcementId: created.id })).toMatchObject({ due: 0 });
    expect(built.inserts).toHaveLength(0);
    expect(await noticeCount(alice.id, announcementEventKey(created.id))).toBe(0);
    expect(await built.repo.hasBeenPublished(created.id)).toBe(false);
  });

  it('skips a targeted pass for an announcement switched off between enqueue and run', async () => {
    const admin = await harness.seedAdmin();
    await harness.seedUser({ email: 'off@bt.test', username: 'switchedoff' });

    const now = () => new Date('2026-02-01T00:00:00.000Z');
    const built = build(now);
    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    await built.service.update(created.id, { active: false }, { id: admin.id });

    expect(await run(built.job, { announcementId: created.id })).toMatchObject({ due: 0 });
    expect(built.inserts).toHaveLength(0);
  });
});

describe('announcements.publishDue — idempotency (§9)', () => {
  it('running the job TWICE over the same due announcement fans out once', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'twice1@bt.test', username: 'twiceone' });
    const bob = await harness.seedUser({ email: 'twice2@bt.test', username: 'twicetwo' });

    const now = () => new Date('2026-02-10T00:00:00.000Z');
    const built = build(now);
    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);

    await run(built.job);
    const afterFirst = built.inserts.length;
    const second = await run(built.job);

    // The second sweep finds nothing due — `published_at IS NULL` is part of
    // the predicate — so it does not even walk the user table again.
    expect(second).toMatchObject({ due: 0, published: 0, inserted: 0 });
    expect(built.inserts).toHaveLength(afterFirst);

    // One inbox row per recipient, and the count was not doubled.
    for (const user of [alice, bob]) {
      expect(await noticeCount(user.id, key)).toBe(1);
    }
    const row = (await built.repo.findById(created.id))!;
    expect(row.deliveredCount).toBe(await recipientCount());
    expect(await publishAudits(built, created.id)).toHaveLength(1);
  });

  it('two CONCURRENT runs both walk, but only one claims, records and audits', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'race@bt.test', username: 'raceuser' });

    const now = () => new Date('2026-02-11T00:00:00.000Z');

    // A barrier inside the insert seam holds each run at the end of its walk
    // until BOTH have walked, so the two conditional stamps genuinely collide.
    let arrived = 0;
    let open!: () => void;
    const bothWalked = new Promise<void>((resolve) => {
      open = resolve;
    });
    const built = build(now, {
      insert: async (input, real) => {
        const id = await real.insert(input);
        arrived += 1;
        if (arrived >= 2) open();
        else await bothWalked;
        return id;
      },
    });

    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);

    const [first, second] = await Promise.all([
      built.service.publishAnnouncement(created.id),
      built.service.publishAnnouncement(created.id),
    ]);

    // Both runs really did walk the whole recipient set…
    const recipients = await recipientCount();
    expect(built.inserts).toHaveLength(recipients * 2);
    // …and exactly one won the conditional `WHERE published_at IS NULL` stamp.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['lost-claim', 'published']);

    // The loser left no trace: one inbox row, one count, one audit row.
    expect(await noticeCount(alice.id, key)).toBe(1);
    const row = (await built.repo.findById(created.id))!;
    expect(row.deliveredCount).toBe(recipients);
    expect(row.failedCount).toBe(0);
    expect(await publishAudits(built, created.id)).toHaveLength(1);
  });

  it('a run killed MID-WALK leaves the row re-publishable, and the next run completes it', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'crash1@bt.test', username: 'crashone' });
    const bob = await harness.seedUser({ email: 'crash2@bt.test', username: 'crashtwo' });

    const now = () => new Date('2026-02-12T00:00:00.000Z');
    const users = createUserRepository(db);
    // One recipient per keyset page, and the page read AFTER the first one
    // throws — the faithful shape of "the worker died with the walk half done",
    // since a per-recipient failure is caught and a page read is not.
    let pages = 0;
    const dying: Pick<UserRepository, 'listRecipientsAfter'> = {
      listRecipientsAfter: async (cursor, limit) => {
        pages += 1;
        if (pages === 2) throw new Error('worker died mid-walk');
        return users.listRecipientsAfter(cursor, limit);
      },
    };
    const crashing = build(now, { users: dying, fanOutPageSize: 1 });
    const created = await crashing.service.create({ ...BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);

    await expect(run(crashing.job)).rejects.toThrow('worker died mid-walk');

    // The first recipient has their notice; the row is NOT stamped, so it is
    // still due. That is the whole point of walking before claiming.
    const recipients = await recipientCount();
    const deliveredAfterCrash = await Promise.all(
      (await createUserRepository(db).listRecipientsAfter(null, 500)).map((r) =>
        noticeCount(r.id, key),
      ),
    );
    // Exactly the first keyset page landed; the rest of the walk never ran.
    expect(deliveredAfterCrash.reduce((a, b) => a + b, 0)).toBe(1);
    expect(recipients).toBeGreaterThan(1);
    expect(await crashing.repo.hasBeenPublished(created.id)).toBe(false);

    // The NEXT run — a healthy worker, same predicate — finishes it. The
    // per-recipient eventKey index makes the re-walk free for whoever was
    // already reached.
    const healthy = build(now);
    expect(await run(healthy.job)).toMatchObject({ due: 1, published: 1, failed: 0 });
    for (const user of [alice, bob]) {
      expect(await noticeCount(user.id, key)).toBe(1);
    }
    const row = (await healthy.repo.findById(created.id))!;
    expect(row.publishedAt).not.toBeNull();
    // Confirmations, not writes: the resumed pass re-walked every account and
    // inserted fewer rows than that, yet all are honestly reported delivered.
    expect(row.deliveredCount).toBe(recipients);
    expect(row.failedCount).toBe(0);
  });
});

/**
 * #1723's fix made a partial fan-out resumable by leaving `published_at` NULL.
 * That turned out to be a permanent re-fire: the row stayed "active but never
 * published", so every LATER edit re-entered the fan-out and re-walked every
 * account, forever, over one transient insert error.
 */
describe('announcements.publishDue — partial failure stops being a permanent re-fire', () => {
  it('stamps, records, audits and retries exactly once — then stops re-walking', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'p1@bt.test', username: 'partone' });
    const bob = await harness.seedUser({ email: 'p2@bt.test', username: 'parttwo' });
    const carol = await harness.seedUser({ email: 'p3@bt.test', username: 'partthree' });

    const now = () => new Date('2026-02-13T00:00:00.000Z');
    let failing = true;
    const built = build(now, {
      insert: async (input, real) => {
        if (failing && input.userId === bob.id) throw new Error('insert boom');
        return real.insert(input);
      },
    });

    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);

    const recipients = await recipientCount();
    const first = await run(built.job);
    expect(first).toMatchObject({ due: 1, published: 1, failed: 1, retriesScheduled: 1 });

    // Stamped despite the failure — the old `failed === 0` condition is what
    // made this row re-walk every account on every later edit.
    const afterFirst = (await built.repo.findById(created.id))!;
    expect(afterFirst.publishedAt).not.toBeNull();
    expect(afterFirst.failedCount).toBe(1);
    expect(afterFirst.deliveredCount).toBe(recipients - 1);
    expect(await noticeCount(bob.id, key)).toBe(0);
    expect(await noticeCount(alice.id, key)).toBe(1);
    expect(await noticeCount(carol.id, key)).toBe(1);

    // The failure is visible in the audit trail, not just a log line (W6 reads it).
    const audits = await publishAudits(built, created.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toMatchObject({
      users: recipients,
      inserted: recipients - 1,
      failed: 1,
    });

    // Exactly one bounded retry, with backoff — a ladder, not a loop. (The
    // `attempt: 0` entry is the save's own "publish now" hand-off.)
    const retries = () => built.enqueued.filter((r) => r.attempt > 0);
    expect(retries()).toEqual([
      { announcementId: created.id, attempt: 1, delayMs: ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS },
    ]);

    // The retry delivers precisely the missing row and clears the failure.
    failing = false;
    const insertsBeforeRetry = built.inserts.length;
    expect(await run(built.job, { announcementId: created.id, attempt: 1 })).toMatchObject({
      due: 1,
      failed: 0,
      retriesScheduled: 0,
    });
    expect(await noticeCount(bob.id, key)).toBe(1);
    const afterRetry = (await built.repo.findById(created.id))!;
    expect(afterRetry.failedCount).toBe(0);
    expect(afterRetry.deliveredCount).toBe(recipients);
    // No second retry was ever asked for.
    expect(retries()).toHaveLength(1);
    expect(built.inserts.length).toBeGreaterThan(insertsBeforeRetry);

    // Nobody was notified twice.
    for (const user of [alice, bob, carol]) {
      expect(await noticeCount(user.id, key)).toBe(1);
    }

    // And an unrelated later edit does NOT re-walk the user table — the defect
    // this issue removes. The sweep finds nothing due either.
    const insertsAfterRetry = built.inserts.length;
    await built.service.update(created.id, { titleEn: 'Edited copy' }, { id: admin.id });
    await built.service.update(created.id, { active: true }, { id: admin.id });
    expect(await run(built.job)).toMatchObject({ due: 0, inserted: 0 });
    expect(built.inserts).toHaveLength(insertsAfterRetry);
  });
});
