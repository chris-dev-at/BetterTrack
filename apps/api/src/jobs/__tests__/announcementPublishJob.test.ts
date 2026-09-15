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
  ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
  ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT,
  ANNOUNCEMENT_PUBLISH_RETRY_DELAY_MS,
  ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS,
  type AnnouncementPublishEnqueued,
  type AnnouncementPublishRequest,
  type AnnouncementService,
} from '../../services/announcements/announcementService';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import {
  announcementPublishJobId,
  createAnnouncementPublishEnqueuer,
  createAnnouncementPublishJob,
  ANNOUNCEMENT_PUBLISH_CRON,
  ANNOUNCEMENT_PUBLISH_DEDUPE_WINDOW_MS,
  ANNOUNCEMENT_PUBLISH_SCHEDULER_ID,
  ANNOUNCEMENT_PUBLISH_TZ,
} from '../definitions/announcementJobs';
import type { QueueRegistry } from '../queues';
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
    /** Replace the recorder with a real transport (the job-id dedupe proof). */
    enqueuePublish?: (request: AnnouncementPublishRequest) => Promise<AnnouncementPublishEnqueued>;
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
      if (options.enqueuePublish) return options.enqueuePublish(request);
      // The recorder still answers with the id the REAL transport would mint,
      // so nothing downstream of an enqueue is tested against a shape the
      // queue never produces.
      return {
        jobId: announcementPublishJobId(
          request.announcementId,
          request.attempt,
          clock().getTime(),
          request.dedupeWindowMs,
        ),
      };
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

/**
 * #1941 review, low 1: the sweep acted on the batch snapshot it had taken
 * before the first walk. An operator who switched an announcement off between
 * `listDuePublications` and that row's turn still got a full fan-out to every
 * account and a `published_at` stamp, because the claim conditioned on
 * `published_at IS NULL` alone.
 */
describe('announcements.publishDue — a cancelled announcement is not published', () => {
  it('re-reads before walking: deactivated between the batch snapshot and its turn → no fan-out, no stamp', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'cancel@bt.test', username: 'canceluser' });

    const now = () => new Date('2026-02-20T00:00:00.000Z');

    // TWO due announcements, so the sweep's own batch genuinely spans a window
    // in which an operator can act. Deactivating BEFORE `run()` would prove
    // nothing — `listDuePublications` filters on `active` and would simply not
    // return the row. The interleaving only exists mid-batch, so the switch-off
    // is fired from inside the FIRST announcement's walk.
    const sideChannel = createAnnouncementRepository(db);
    let cancelled = false;
    let second = '';
    const built = build(now, {
      insert: async (input, real) => {
        const id = await real.insert(input);
        if (!cancelled && second) {
          cancelled = true;
          await sideChannel.update(second, { active: false });
        }
        return id;
      },
    });

    const first = await built.service.create(
      { ...BODY, titleEn: 'First', active: true },
      { id: admin.id },
    );
    const cancelledRow = await built.service.create(
      { ...BODY, titleEn: 'Second', active: true },
      { id: admin.id },
    );
    second = cancelledRow.id;

    // Both are in the batch the sweep is about to take.
    const listed = await built.repo.listDuePublications(now(), 20);
    expect(listed.map((r) => r.id).sort()).toEqual([first.id, cancelledRow.id].sort());

    const summary = await run(built.job);
    expect(cancelled).toBe(true);

    // The first one published; the cancelled one was never walked or stamped.
    expect(summary).toMatchObject({ due: 2, published: 1 });
    expect(await noticeCount(alice.id, announcementEventKey(first.id))).toBe(1);
    expect(await noticeCount(alice.id, announcementEventKey(cancelledRow.id))).toBe(0);
    expect(await built.repo.hasBeenPublished(cancelledRow.id)).toBe(false);
    const row = (await built.repo.findById(cancelledRow.id))!;
    expect(row.deliveredCount).toBeNull();
    expect(await publishAudits(built, cancelledRow.id)).toHaveLength(0);

    // And switching it back on still publishes it — a refused claim must leave
    // the announcement re-publishable, not quietly spent.
    await built.service.update(cancelledRow.id, { active: true }, { id: admin.id });
    expect(await run(built.job)).toMatchObject({ due: 1, published: 1 });
    expect(await noticeCount(alice.id, announcementEventKey(cancelledRow.id))).toBe(1);
  });

  it('refuses the claim for an announcement switched off DURING the walk', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'midwalk@bt.test', username: 'midwalkuser' });

    const now = () => new Date('2026-02-21T00:00:00.000Z');
    let deactivate: (() => Promise<void>) | null = null;
    const built = build(now, {
      // Switch it off after the first recipient insert — past every pre-walk
      // re-read, so only the claim's own `active = true` can catch it.
      insert: async (input, real) => {
        const id = await real.insert(input);
        if (deactivate) {
          const run = deactivate;
          deactivate = null;
          await run();
        }
        return id;
      },
    });

    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);
    deactivate = async () => {
      await built.repo.update(created.id, { active: false });
    };

    const outcome = await built.service.publishAnnouncement(created.id);
    expect(outcome.status).toBe('lost-claim');
    // The walk had already begun, so some rows exist — but nothing was
    // recorded, so the announcement is still re-publishable.
    expect(await built.repo.hasBeenPublished(created.id)).toBe(false);
    const row = (await built.repo.findById(created.id))!;
    expect(row.deliveredCount).toBeNull();
    expect(row.failedCount).toBeNull();
    expect(await publishAudits(built, created.id)).toHaveLength(0);
    // Nobody was notified twice by the abandoned pass.
    expect(await noticeCount(alice.id, key)).toBeLessThanOrEqual(1);
  });

  it('skips a row whose window closes between the batch snapshot and its turn', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'straddle@bt.test', username: 'straddleuser' });

    let clock = new Date('2026-03-01T09:00:00.000Z');
    // Again the interleaving has to happen INSIDE the batch: the first
    // announcement's walk pushes the clock past the second's `endsAt`, so the
    // batch snapshot is stale by the time the second row's turn arrives.
    let advanced = false;
    const built = build(() => clock, {
      insert: async (input, real) => {
        const id = await real.insert(input);
        if (!advanced) {
          advanced = true;
          clock = new Date('2026-03-01T11:00:00.000Z');
        }
        return id;
      },
    });

    const first = await built.service.create(
      { ...BODY, titleEn: 'Opens the batch', active: true },
      { id: admin.id },
    );
    const straddler = await built.service.create(
      {
        ...BODY,
        titleEn: 'Window closes mid-batch',
        active: true,
        endsAt: '2026-03-01T10:00:00.000Z',
      },
      { id: admin.id },
    );

    const listed = await built.repo.listDuePublications(clock, 20);
    expect(listed.map((r) => r.id).sort()).toEqual([first.id, straddler.id].sort());

    const summary = await run(built.job);
    expect(advanced).toBe(true);
    expect(summary).toMatchObject({ due: 2, published: 1 });
    expect(await noticeCount(alice.id, announcementEventKey(straddler.id))).toBe(0);
    expect(await built.repo.hasBeenPublished(straddler.id)).toBe(false);
  });
});

/**
 * #1941 review, low 2: every `update()` on an open window asks for a "publish
 * now" pass, so an operator fixing a typo three times enqueued three full walks
 * of the user table. BullMQ coalesces adds that share a job id.
 */
/** A QueueRegistry that records what was enqueued, instead of a real queue. */
function recordingQueues() {
  const calls: Array<{ name: string; data: unknown; opts?: { jobId?: string; delay?: number } }> =
    [];
  const queues = {
    get: () => {
      throw new Error('not used');
    },
    enqueue: async (name: string, data: unknown, opts?: { jobId?: string; delay?: number }) => {
      calls.push({ name, data, opts });
      return {} as never;
    },
    close: async () => {},
  } as unknown as QueueRegistry;
  return { queues, calls };
}

describe('announcements.publishDue — the targeted enqueue is deduped by job id', () => {
  it('gives every enqueue in one window the same job id, so BullMQ collapses them', async () => {
    const t0 = Date.parse('2026-04-01T12:00:00.000Z');
    const { queues, calls } = recordingQueues();
    let clock = t0;
    const enqueue = createAnnouncementPublishEnqueuer(queues, () => clock);

    await enqueue({ announcementId: 'a-1', attempt: 0 });
    clock = t0 + 30_000;
    await enqueue({ announcementId: 'a-1', attempt: 0 });
    clock = t0 + 90_000;
    await enqueue({ announcementId: 'a-1', attempt: 0 });

    expect(calls).toHaveLength(3);
    const ids = new Set(calls.map((c) => c.opts?.jobId));
    // Three asks, ONE job identity — which is what makes BullMQ keep one job.
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(announcementPublishJobId('a-1', 0, t0));
    expect(calls[0]!.name).toBe('announcements.publishDue');
    expect(calls[0]!.data).toEqual({ announcementId: 'a-1', attempt: 0 });
    // A first pass carries no delay; only the bounded retry does.
    expect(calls[0]!.opts?.delay).toBeUndefined();
  });

  it('keeps the retry, a different announcement and a later window distinct', async () => {
    const t0 = Date.parse('2026-04-01T12:00:00.000Z');
    const { queues, calls } = recordingQueues();
    let clock = t0;
    const enqueue = createAnnouncementPublishEnqueuer(queues, () => clock);

    await enqueue({ announcementId: 'a-1', attempt: 0 });
    // The bounded retry is a real second pass — it must not be swallowed.
    await enqueue({ announcementId: 'a-1', attempt: 1, delayMs: 60_000 });
    await enqueue({ announcementId: 'a-2', attempt: 0 });
    // A publish window later (the queue keeps completed jobs, so a bare
    // `<id>:<attempt>` would be refused forever after the first one).
    clock = t0 + ANNOUNCEMENT_PUBLISH_DEDUPE_WINDOW_MS * 2;
    await enqueue({ announcementId: 'a-1', attempt: 0 });

    const ids = calls.map((c) => c.opts?.jobId);
    expect(new Set(ids).size).toBe(4);
    expect(calls[1]!.opts?.delay).toBe(60_000);
  });

  it('two edits of one unstamped announcement enqueue ONE job, not two user-table walks', async () => {
    const admin = await harness.seedAdmin();
    await harness.seedUser({ email: 'edit@bt.test', username: 'edituser' });

    const at = Date.parse('2026-04-02T08:00:00.000Z');
    const { queues, calls } = recordingQueues();
    // The service's transport is the REAL enqueuer here, so what is asserted is
    // what BullMQ would actually receive — not a job id the test computed for
    // itself.
    const built = build(() => new Date(at), {
      enqueuePublish: createAnnouncementPublishEnqueuer(queues, () => at),
    });
    const created = await built.service.create({ ...BODY, active: true }, { id: admin.id });

    await built.service.update(created.id, { titleEn: 'Typo fixed' }, { id: admin.id });
    await built.service.update(created.id, { titleEn: 'Typo fixed again' }, { id: admin.id });

    // The service asks once per write — it does not try to be clever…
    const asks = calls.filter(
      (c) => (c.data as { announcementId?: string }).announcementId === created.id,
    );
    expect(asks.length).toBeGreaterThanOrEqual(3);
    // …and every ask carries ONE job identity, so BullMQ keeps one job and the
    // user table is walked once instead of three times.
    expect(new Set(asks.map((c) => c.opts?.jobId)).size).toBe(1);
    expect(asks[0]!.opts?.jobId).toBe(announcementPublishJobId(created.id, 0, at));
  });
});

/**
 * ADMIN-W7c (#1943): the operator's own pass.
 *
 * #1941 made a partial delivery honest — the row is stamped, the counts are
 * recorded, one bounded retry runs — but deliberately stopped there. An
 * announcement whose delivery failed twice therefore sat in the console reading
 * "N failed" with nothing attached to it, and those recipients never got their
 * inbox row at all: `publishDue` only takes UNSTAMPED rows, so no sweep was
 * ever coming back for them.
 *
 * The redelivery is not a second fan-out. It is the SAME targeted pass the
 * bounded retry uses, asked for by a human and carrying their id.
 */
describe('announcements.publishDue — an operator redelivers the recipients it missed', () => {
  it('inserts exactly the missing rows, leaves the delivered ones alone, and updates the counts', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'r1@bt.test', username: 'redelivone' });
    const bob = await harness.seedUser({ email: 'r2@bt.test', username: 'redelivtwo' });
    const carol = await harness.seedUser({ email: 'r3@bt.test', username: 'redelivthree' });

    const now = () => new Date('2026-05-04T09:00:00.000Z');
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

    // The publication AND its single bounded retry both fail for Bob — the
    // state the console was showing with no action attached to it.
    expect(await run(built.job)).toMatchObject({ due: 1, published: 1, failed: 1 });
    expect(await run(built.job, { announcementId: created.id, attempt: 1 })).toMatchObject({
      failed: 1,
    });
    const stuck = (await built.repo.findById(created.id))!;
    expect(stuck.failedCount).toBe(1);
    expect(stuck.deliveredCount).toBe(recipients - 1);
    expect(await noticeCount(bob.id, key)).toBe(0);

    // The operator clicks. The REQUEST queues a pass and nothing else: no walk
    // happened on it — the inbox is exactly as the failed retry left it.
    failing = false;
    const insertsBeforeClick = built.inserts.length;
    const accepted = await built.service.redeliver(created.id, { id: admin.id, ip: '10.1.2.3' });
    expect(built.inserts).toHaveLength(insertsBeforeClick);
    expect(accepted).toMatchObject({
      announcementId: created.id,
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      failedCount: 1,
      deliveredCount: recipients - 1,
    });
    // Above the automatic ladder, so it can never schedule a retry of its own.
    expect(accepted.attempt).toBeGreaterThan(ANNOUNCEMENT_PUBLISH_MAX_ATTEMPT);
    const queued = built.enqueued.at(-1)!;
    expect(queued).toMatchObject({
      announcementId: created.id,
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      // The one pass that names a human — a click, not a sweep.
      actorId: admin.id,
    });

    // The worker runs it. ONE insert: the row Bob never got.
    const outcome = await run(built.job, {
      announcementId: created.id,
      attempt: queued.attempt,
      actorId: queued.actorId,
    });
    expect(outcome).toMatchObject({ due: 1, inserted: 1, failed: 0, retriesScheduled: 0 });
    expect(built.inserts.length).toBe(insertsBeforeClick + recipients);

    // Exactly one row each, for everybody — the eventKey index collapsed the
    // re-walk over the accounts that were already delivered.
    for (const user of [alice, bob, carol]) {
      expect(await noticeCount(user.id, key)).toBe(1);
    }

    const after = (await built.repo.findById(created.id))!;
    // Counts recomputed from the new outcome, never accumulated…
    expect(after.deliveredCount).toBe(recipients);
    expect(after.failedCount).toBe(0);
    // …and `published_at` is untouched: the claim is the only writer of that
    // column and this pass never reaches it, so a redelivery cannot re-stamp
    // the publication or move its timestamp.
    expect(after.publishedAt).toEqual(stuck.publishedAt);

    // One re-run per click: the pass asked for nothing further.
    expect(built.enqueued.filter((r) => r.attempt === ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT)).toEqual(
      [queued],
    );

    // The trail: the operator's ASK, and the pass's own outcome — both naming
    // them, unlike the automatic passes above, which are the job's.
    const { entries } = await built.audit.listForTarget({ targetId: created.id, limit: 50 });
    const asked = entries.filter((row) => row.action === 'announcement.redeliver');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.actorId).toBe(admin.id);
    expect(asked[0]!.meta).toMatchObject({
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      jobId: accepted.jobId,
      delivered: recipients - 1,
      failed: 1,
    });
    // `listForTarget` reads newest-first, so the operator's pass is entry 0 and
    // the two automatic ones behind it stay unattributed.
    const passes = await publishAudits(built, created.id);
    expect(passes.map((row) => row.actorId)).toEqual([admin.id, null, null]);
    expect(passes[0]!.meta).toMatchObject({
      users: recipients,
      inserted: 1,
      failed: 0,
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
    });
  });

  it('refuses a pass the worker would skip, and one with nothing left to deliver', async () => {
    const admin = await harness.seedAdmin();
    await harness.seedUser({ email: 'r4@bt.test', username: 'redelivfour' });

    const now = () => new Date('2026-05-05T09:00:00.000Z');
    const built = build(now);

    // Clean publication: nothing failed, so there is nothing to retry.
    const clean = await built.service.create({ ...BODY, active: true }, { id: admin.id });
    await run(built.job);
    expect((await built.repo.findById(clean.id))!.failedCount).toBe(0);
    await expect(built.service.redeliver(clean.id, { id: admin.id })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ANNOUNCEMENT_NOTHING_TO_REDELIVER',
    });

    // Never published: the sweep still owes it a first pass.
    const draft = await built.service.create({ ...BODY, active: false }, { id: admin.id });
    await expect(built.service.redeliver(draft.id, { id: admin.id })).rejects.toMatchObject({
      statusCode: 409,
    });

    // Unknown id — the same 404 the rest of the surface answers.
    await expect(
      built.service.redeliver('00000000-0000-4000-8000-000000000000', { id: admin.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ANNOUNCEMENT_NOT_FOUND' });

    // Nothing was queued by any of the three refusals.
    expect(built.enqueued.filter((r) => r.attempt === ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT)).toEqual(
      [],
    );
  });

  it('gives an impatient double-click one job id, and a deliberate retry a minute later its own', async () => {
    const t0 = Date.parse('2026-05-06T10:00:00.000Z');
    const { queues, calls } = recordingQueues();
    let clock = t0;
    const enqueue = createAnnouncementPublishEnqueuer(queues, () => clock);
    const manual = {
      announcementId: 'a-9',
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      dedupeWindowMs: ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS,
      actorId: 'admin-1',
    };

    const first = await enqueue(manual);
    clock = t0 + 2_000;
    const doubleClick = await enqueue(manual);
    clock = t0 + 60_000;
    const later = await enqueue(manual);

    // Two clicks in the same breath are one walk — a second identical re-walk
    // would deliver exactly what the first one does.
    expect(doubleClick.jobId).toBe(first.jobId);
    // A minute later is a genuine second ask, and it is NOT swallowed: nothing
    // re-runs a click, so the five-minute automatic window would have made the
    // button do nothing.
    expect(later.jobId).not.toBe(first.jobId);
    expect(new Set(calls.map((c) => c.opts?.jobId)).size).toBe(2);

    // A manual pass never collides with the automatic ladder: the attempt
    // segment differs, whatever the windows do.
    clock = t0;
    const automatic = await enqueue({ announcementId: 'a-9', attempt: 0 });
    expect(automatic.jobId).not.toBe(first.jobId);
    expect(calls.at(-1)!.data).toEqual({ announcementId: 'a-9', attempt: 0 });
    expect(calls[0]!.data).toEqual({
      announcementId: 'a-9',
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      actorId: 'admin-1',
    });
  });
});
