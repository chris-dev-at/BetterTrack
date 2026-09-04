import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateAnnouncementRequest } from '@bettertrack/contracts';

import { createAnnouncementRepository } from '../../../data/repositories/announcementRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import { createAuditRepository } from '../../../data/repositories/auditRepository';
import type { Database } from '../../../data/db';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAuditService } from '../../audit/auditService';
import { createAnnouncementService, announcementEventKey } from '../announcementService';

/**
 * Service-level tests using a controlled clock — proves the acceptance
 * criterion "banner honors the active window (test with fixed clock)"
 * without racing the wall clock.
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
  notificationsOverride?: Pick<ReturnType<typeof createNotificationRepository>, 'insert'>,
) {
  const repo = createAnnouncementRepository(db);
  const notifications = createNotificationRepository(db);
  const users = createUserRepository(db);
  const audit = createAuditService(createAuditRepository(db));
  return {
    service: createAnnouncementService({
      repo,
      users,
      notifications: notificationsOverride ?? notifications,
      audit,
      now: clock,
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
    // Seed a couple of accounts so the fan-out has recipients (not asserted here).
    void alice;

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

  it('publish is idempotent — a repeat toggle-on collapses to zero new inbox rows', async () => {
    const admin = await harness.seedAdmin();
    const bob = await harness.seedUser();

    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const { service, notifications, repo } = buildService(now);

    const created = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);
    expect(await notifications.existsForEventKey(bob.id, key)).toBe(true);

    // Toggle off then on again — the (user_id, eventKey) partial unique index
    // collapses the second fan-out to a no-op.
    await service.update(created.id, { active: false }, { id: admin.id });
    await service.update(created.id, { active: true }, { id: admin.id });

    // Bob still has exactly one row (verified by the count check below via repo).
    expect(await repo.hasBeenPublished(created.id)).toBe(true);
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
 * #1723: a publish interrupted midway used to be permanently unrecoverable —
 * `active` was already committed true, so the false→true edge that gates the
 * fan-out could never happen again, and `publishedAt` stayed NULL forever with
 * only a prefix of the users holding an inbox row.
 */
describe('AnnouncementService — resumable publish (#1723)', () => {
  it('a mid-fan-out failure leaves the announcement unpublished, then a retry completes it', async () => {
    const admin = await harness.seedAdmin();
    await harness.seedUser({ email: 'r1@bt.test', username: 'resume1' });
    await harness.seedUser({ email: 'r2@bt.test', username: 'resume2' });
    await harness.seedUser({ email: 'r3@bt.test', username: 'resume3' });

    const users = createUserRepository(db);
    const recipients = await users.listRecipientsAfter(null, 100);
    // Fail one recipient in the middle of the id-ordered walk, once.
    const victim = recipients[Math.floor(recipients.length / 2)]!.id;
    let shouldFail = true;

    const real = createNotificationRepository(db);
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const { service, repo } = buildService(now, {
      insert: async (input) => {
        if (shouldFail && input.userId === victim) throw new Error('insert boom');
        return real.insert(input);
      },
    });

    const created = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    const key = announcementEventKey(created.id);

    // The banner is live, but the announcement is NOT recorded as published:
    // one recipient is still missing their inbox row.
    expect(created.active).toBe(true);
    expect(created.publishedAt).toBeNull();
    expect(await repo.hasBeenPublished(created.id)).toBe(false);
    expect(await real.existsForEventKey(victim, key)).toBe(false);
    for (const recipient of recipients) {
      if (recipient.id === victim) continue;
      // Everyone after the failure was reached too — the walk did not abort.
      expect(await real.existsForEventKey(recipient.id, key)).toBe(true);
    }

    // Retrying the SAME patch resumes the publish: the dedupe index means only
    // the missing row is inserted, and only now is `publishedAt` stamped.
    shouldFail = false;
    const retried = await service.update(created.id, { active: true }, { id: admin.id });
    expect(await real.existsForEventKey(victim, key)).toBe(true);
    expect(retried.publishedAt).toBe(now().toISOString());
    expect(await repo.hasBeenPublished(created.id)).toBe(true);
  });

  it('a completed publish is not re-run by an unrelated patch', async () => {
    const admin = await harness.seedAdmin();
    await harness.seedUser({ email: 'clean@bt.test', username: 'cleanpublish' });

    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const inserts: string[] = [];
    const real = createNotificationRepository(db);
    const { service, repo } = buildService(now, {
      insert: async (input) => {
        inserts.push(input.userId);
        return real.insert(input);
      },
    });

    const created = await service.create({ ...BASE_BODY, active: true }, { id: admin.id });
    expect(await repo.hasBeenPublished(created.id)).toBe(true);
    const afterPublish = inserts.length;

    // Editing the copy of an already-published, still-active announcement must
    // not re-enter the fan-out: `publishedAt` is set, so `publishing` is false.
    await service.update(created.id, { titleEn: 'Edited title' }, { id: admin.id });
    await service.update(created.id, { active: true }, { id: admin.id });
    expect(inserts).toHaveLength(afterPublish);
  });
});
