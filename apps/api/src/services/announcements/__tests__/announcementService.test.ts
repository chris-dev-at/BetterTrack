import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateAnnouncementRequest } from '@bettertrack/contracts';

import { createAnnouncementRepository } from '../../../data/repositories/announcementRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import { createAuditRepository } from '../../../data/repositories/auditRepository';
import type { Database } from '../../../data/db';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAuditService } from '../../audit/auditService';
import {
  createAnnouncementService,
  announcementEventKey,
  deriveAnnouncementDeliveryState,
  ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
  ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS,
  type AnnouncementPublishRequest,
} from '../announcementService';

/**
 * Service-level tests using a controlled clock.
 *
 * Two eras live here. The original V4-P5b criterion — "the banner honors the
 * active window (test with a fixed clock)" — and the ADMIN-W7a (#1909)
 * criterion that the SAME window now governs the inbox fan-out: saving an
 * announcement, however it is flagged, delivers nothing on the request path.
 * The publication side (double-run, concurrency, partial failure, resumption)
 * is exercised end-to-end in `jobs/__tests__/announcementPublishJob.test.ts`.
 */

let harness: TestHarness;
let db: Database;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function buildService(
  clock: () => Date,
  options: {
    notifications?: Pick<ReturnType<typeof createNotificationRepository>, 'insert'>;
    enqueued?: AnnouncementPublishRequest[];
  } = {},
) {
  const repo = createAnnouncementRepository(db);
  const notifications = createNotificationRepository(db);
  const users = createUserRepository(db);
  const audit = createAuditService(createAuditRepository(db));
  const enqueued = options.enqueued;
  return {
    service: createAnnouncementService({
      repo,
      users,
      notifications: options.notifications ?? notifications,
      audit,
      now: clock,
      ...(enqueued
        ? {
            enqueuePublish: async (request: AnnouncementPublishRequest) => {
              enqueued.push(request);
              return { jobId: `${request.announcementId}:${request.attempt}` };
            },
          }
        : {}),
    }),
    repo,
    notifications,
    users,
  };
}

const BASE_BODY: CreateAnnouncementRequest = {
  severity: 'info',
  titleEn: 'Test title EN',
  bodyEn: 'Test body EN',
  titleDe: 'Test-Titel DE',
  bodyDe: 'Test-Text DE',
  active: true,
};

describe('AnnouncementService — active window', () => {
  it('honors an explicit start/end window under a fixed clock', async () => {
    // Real admin so audit.record has a valid actor id.
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser();

    let now = new Date('2026-01-01T00:00:00.000Z');
    const { service } = buildService(() => now);

    const created = await service.create(
      {
        ...BASE_BODY,
        startsAt: '2026-06-01T00:00:00.000Z',
        endsAt: '2026-06-30T23:59:59.000Z',
      },
      { id: admin.id, ip: null },
    );
    expect(created.active).toBe(true);

    // Before window: hidden for every user.
    const beforeStart = await service.listActiveForUser(alice.id, 'en');
    expect(beforeStart).toHaveLength(0);

    // Inside window: visible, rendered EN.
    now = new Date('2026-06-15T12:00:00.000Z');
    const inside = await service.listActiveForUser(alice.id, 'en');
    expect(inside).toHaveLength(1);
    expect(inside[0]!.title).toBe(BASE_BODY.titleEn);

    // After window: hidden again.
    now = new Date('2026-07-15T12:00:00.000Z');
    const afterEnd = await service.listActiveForUser(alice.id, 'en');
    expect(afterEnd).toHaveLength(0);
  });

  it('rejects a start > end window as INVALID_ANNOUNCEMENT_WINDOW (400)', async () => {
    const admin = await harness.seedAdmin();
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const { service } = buildService(now);

    const created = await service.create(BASE_BODY, { id: admin.id });
    await expect(
      service.update(
        created.id,
        {
          startsAt: '2027-01-01T00:00:00.000Z',
          endsAt: '2026-06-01T00:00:00.000Z',
        },
        { id: admin.id },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ANNOUNCEMENT_WINDOW' });
  });
});

/**
 * #1909's headline defect: a future `startsAt` used to defer only the banner.
 * `create()` ran the fan-out inline on the `active` flag alone, so "schedule it
 * for Monday" mailed the entire user base on Friday and then showed the banner
 * on Monday — while the composer's own helper text said the opposite.
 */
describe('AnnouncementService — a write never delivers (#1909)', () => {
  it('a FUTURE startsAt with active:true sends no notification at save time', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'sched@bt.test', username: 'scheduleduser' });

    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service, notifications } = buildService(now, { enqueued });

    const created = await service.create(
      { ...BASE_BODY, active: true, startsAt: '2026-01-05T09:00:00.000Z' },
      { id: admin.id },
    );

    // Nothing delivered, nothing stamped, and — the part that makes it a
    // schedule rather than a race — nothing even asked for.
    expect(await notifications.existsForEventKey(alice.id, announcementEventKey(created.id))).toBe(
      false,
    );
    expect(created.publishedAt).toBeNull();
    expect(created.deliveryState).toBe('scheduled');
    expect(created.deliveredCount).toBeNull();
    expect(enqueued).toHaveLength(0);
  });

  it('an OPEN window asks the worker to publish, and still delivers nothing inline', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'open@bt.test', username: 'openwindowuser' });

    const now = () => new Date('2026-01-10T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service, notifications } = buildService(now, { enqueued });

    const created = await service.create(
      { ...BASE_BODY, active: true, startsAt: '2026-01-01T00:00:00.000Z' },
      { id: admin.id },
    );

    expect(created.deliveryState).toBe('publishing');
    expect(created.publishedAt).toBeNull();
    // The request path did not walk the user table.
    expect(await notifications.existsForEventKey(alice.id, announcementEventKey(created.id))).toBe(
      false,
    );
    // It handed the work to the queue instead — first pass, no backoff.
    expect(enqueued).toEqual([{ announcementId: created.id, attempt: 0 }]);
  });

  it('flipping active on later hands the same open-window announcement over once', async () => {
    const admin = await harness.seedAdmin();
    const now = () => new Date('2026-01-10T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service } = buildService(now, { enqueued });

    const created = await service.create({ ...BASE_BODY, active: false }, { id: admin.id });
    expect(created.deliveryState).toBe('draft');
    expect(enqueued).toHaveLength(0);

    const activated = await service.update(created.id, { active: true }, { id: admin.id });
    expect(activated.deliveryState).toBe('publishing');
    expect(enqueued).toEqual([{ announcementId: created.id, attempt: 0 }]);
  });

  it('an already-closed window is never handed over, however it is re-saved', async () => {
    const admin = await harness.seedAdmin();
    const now = () => new Date('2026-06-01T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service, repo } = buildService(now, { enqueued });

    // Composed inactive with a window that closed months ago, then activated —
    // the exact sequence an operator performs when they "re-use" an old notice.
    const created = await service.create(
      {
        ...BASE_BODY,
        active: false,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-01-31T00:00:00.000Z',
      },
      { id: admin.id },
    );
    expect(created.deliveryState).toBe('expired');

    const reactivated = await service.update(created.id, { active: true }, { id: admin.id });
    expect(reactivated.deliveryState).toBe('expired');
    expect(enqueued).toHaveLength(0);

    // And the sweep refuses it too — the due predicate, not just the enqueue.
    const swept = await service.publishDue();
    expect(swept).toMatchObject({ due: 0, published: 0 });
    expect(await repo.hasBeenPublished(created.id)).toBe(false);

    // Even addressed by id, which is what a stale queued job would do.
    const targeted = await service.publishAnnouncement(created.id);
    expect(targeted).toEqual({ status: 'skipped', reason: 'expired' });
  });
});

describe('deriveAnnouncementDeliveryState', () => {
  const at = new Date('2026-03-15T12:00:00.000Z');
  const past = new Date('2026-01-01T00:00:00.000Z');
  const future = new Date('2026-06-01T00:00:00.000Z');

  it.each([
    ['draft', { active: false, startsAt: null, endsAt: null, publishedAt: null }],
    ['scheduled', { active: true, startsAt: future, endsAt: null, publishedAt: null }],
    ['publishing', { active: true, startsAt: past, endsAt: null, publishedAt: null }],
    ['publishing', { active: true, startsAt: null, endsAt: null, publishedAt: null }],
    ['published', { active: true, startsAt: past, endsAt: future, publishedAt: past }],
    ['expired', { active: true, startsAt: past, endsAt: past, publishedAt: past }],
    // A closed window outranks everything: the job refuses it and the banner
    // hides it, so no other reading would be honest.
    ['expired', { active: true, startsAt: null, endsAt: past, publishedAt: null }],
    ['expired', { active: false, startsAt: null, endsAt: past, publishedAt: null }],
    // Switched back off after a publication: users see nothing now, and the
    // row's own publishedAt still carries the history beside it.
    ['draft', { active: false, startsAt: past, endsAt: future, publishedAt: past }],
  ])('is %s', (expected, row) => {
    expect(deriveAnnouncementDeliveryState(row, at)).toBe(expected);
  });
});

/**
 * ADMIN-W7c (#1943): the manual redelivery, at the service boundary.
 *
 * The end-to-end proof — a fault-injected recipient, the click, the missing row
 * and nothing else — lives in `jobs/__tests__/announcementPublishJob.test.ts`,
 * where the walk actually runs. What is pinned here is the contract around it:
 * a click never walks the user table, and it never answers "accepted" for a
 * pass that will not happen.
 */
describe('AnnouncementService — redelivering a partial publication (#1943)', () => {
  /** Publish `announcement`, then leave it standing at one failed recipient. */
  async function publishWithOneFailure(
    repo: ReturnType<typeof createAnnouncementRepository>,
    id: string,
    at: Date,
  ) {
    await repo.claimPublication(id, at, { delivered: 11, failed: 1 });
  }

  it('refuses a switched-off or expired announcement instead of queueing a pass the worker would skip', async () => {
    const admin = await harness.seedAdmin();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service, repo } = buildService(() => at, { enqueued });

    const off = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    await publishWithOneFailure(repo, off.id, at);
    await service.update(off.id, { active: false }, { id: admin.id });
    await expect(service.redeliver(off.id, { id: admin.id })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ANNOUNCEMENT_NOT_REDELIVERABLE',
    });

    const closed = await service.create(
      { ...BASE_BODY, active: true, endsAt: '2026-09-01T00:00:00.000Z' },
      { id: admin.id },
    );
    await publishWithOneFailure(repo, closed.id, at);
    // The window closes under the row: `publishOne` would re-read it and skip,
    // so accepting the click would be a 202 for nothing.
    const { service: afterClose } = buildService(() => new Date('2026-09-02T00:00:00.000Z'), {
      enqueued,
    });
    await expect(afterClose.redeliver(closed.id, { id: admin.id })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ANNOUNCEMENT_NOT_REDELIVERABLE',
    });

    // Neither refusal asked the queue for anything.
    expect(enqueued.filter((r) => r.attempt === ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT)).toEqual([]);
  });

  it('answers 503 rather than an accepted-looking 202 when there is no transport', async () => {
    const admin = await harness.seedAdmin();
    const at = new Date('2026-08-03T00:00:00.000Z');
    // No `enqueued` recorder → the service is built WITHOUT `enqueuePublish`,
    // exactly as the API context builds it when the queue is unavailable.
    const { service, repo } = buildService(() => at);

    const row = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    await publishWithOneFailure(repo, row.id, at);

    // The sweep does not stand behind this one: `publishDue` takes UNSTAMPED
    // rows only, so a silent acceptance here would never be delivered by
    // anything, ever.
    await expect(service.redeliver(row.id, { id: admin.id })).rejects.toMatchObject({
      statusCode: 503,
      code: 'ANNOUNCEMENT_REDELIVER_UNAVAILABLE',
    });
    // And it left no audit row claiming a redelivery that was never queued.
    const { entries } = await createAuditRepository(db).listForTarget({
      targetId: row.id,
      limit: 20,
    });
    expect(entries.filter((e) => e.action === 'announcement.redeliver')).toEqual([]);
  });

  it('queues one narrow-window pass carrying the operator, and delivers nothing inline', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'rd@bt.test', username: 'redeliveruser' });
    const at = new Date('2026-08-05T00:00:00.000Z');
    const enqueued: AnnouncementPublishRequest[] = [];
    const { service, repo, notifications } = buildService(() => at, { enqueued });

    const row = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    await publishWithOneFailure(repo, row.id, at);

    const accepted = await service.redeliver(row.id, { id: admin.id, ip: '10.9.9.9' });
    expect(accepted).toMatchObject({
      announcementId: row.id,
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      failedCount: 1,
      deliveredCount: 11,
    });
    expect(enqueued.at(-1)).toEqual({
      announcementId: row.id,
      attempt: ANNOUNCEMENT_MANUAL_PUBLISH_ATTEMPT,
      actorId: admin.id,
      dedupeWindowMs: ANNOUNCEMENT_REDELIVER_DEDUPE_WINDOW_MS,
    });
    // The request path did not walk the user table — the whole reason this is a
    // 202 and not a 200.
    expect(await notifications.existsForEventKey(alice.id, announcementEventKey(row.id))).toBe(
      false,
    );
    // Nor did it re-stamp or zero anything: the counts still describe the pass
    // that failed, until the queued one replaces them.
    const unchanged = (await repo.findById(row.id))!;
    expect(unchanged.failedCount).toBe(1);
    expect(unchanged.deliveredCount).toBe(11);
  });
});
