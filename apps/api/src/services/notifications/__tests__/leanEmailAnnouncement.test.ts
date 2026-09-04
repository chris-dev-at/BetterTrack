import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { Database } from '../../../data/db';
import { notifications } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  ANNOUNCEMENT_EVENT_KEY,
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  announceLeanEmailDefaults,
} from '../leanEmailAnnouncement';
import { fanOutAnnouncement } from '../announcementFanOut';

/**
 * V4-P0c one-time migration: every existing user gets exactly one localized
 * in-app announcement about the lean email defaults, and re-running is a no-op.
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

function run() {
  return announceLeanEmailDefaults({
    users: createUserRepository(db),
    notifications: createNotificationRepository(db),
  });
}

async function announcementRowsFor(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => r.type === ANNOUNCEMENT_NOTIFICATION_TYPE);
}

describe('announceLeanEmailDefaults (V4-P0c one-time migration)', () => {
  it('gives every existing user exactly one announcement, localized to their locale', async () => {
    const en = await harness.seedUser({ email: 'en@bt.test', username: 'ennglish' });
    const de = await harness.seedUser({ email: 'de@bt.test', username: 'deutsch' });
    await createUserRepository(db).setLocale(de.id, 'de');

    const result = await run();
    expect(result).toEqual({ users: 2, inserted: 2, failed: 0 });

    const enRows = await announcementRowsFor(en.id);
    expect(enRows).toHaveLength(1);
    expect(enRows[0]!.title).toBe('Email notifications are now off by default');
    expect((enRows[0]!.payload as { eventKey?: string }).eventKey).toBe(ANNOUNCEMENT_EVENT_KEY);
    // It surfaces in the inbox: visible + unread.
    expect(enRows[0]!.hidden).toBe(false);
    expect(enRows[0]!.readAt).toBeNull();

    const deRows = await announcementRowsFor(de.id);
    expect(deRows).toHaveLength(1);
    expect(deRows[0]!.title).toBe('E-Mail-Benachrichtigungen sind jetzt standardmäßig aus');
  });

  it('is idempotent — a second run inserts nothing more', async () => {
    const user = await harness.seedUser({ email: 'once@bt.test', username: 'once' });

    const first = await run();
    expect(first.inserted).toBe(1);

    const second = await run();
    expect(second).toEqual({ users: 1, inserted: 0, failed: 0 });

    expect(await announcementRowsFor(user.id)).toHaveLength(1);
  });
});

/**
 * Fan-out invariants the announcement publish path depends on (#1723): the
 * recipient walk is bounded, and one recipient's failure cannot swallow the
 * rest of the run.
 */
describe('fanOutAnnouncement — bounded pages + per-recipient isolation (#1723)', () => {
  const COPY = {
    en: { title: 'EN title', body: 'EN body' },
    de: { title: 'DE Titel', body: 'DE Text' },
  };

  it('walks recipients in bounded keyset pages, never one unbounded read', async () => {
    for (let i = 0; i < 5; i += 1) {
      await harness.seedUser({ email: `paged${i}@bt.test`, username: `paged${i}` });
    }
    const repo = createUserRepository(db);
    const pages: Array<{ afterId: string | null; size: number }> = [];
    const users = {
      listRecipientsAfter: async (afterId: string | null, limit: number) => {
        const page = await repo.listRecipientsAfter(afterId, limit);
        pages.push({ afterId, size: page.length });
        return page;
      },
    };

    const result = await fanOutAnnouncement({
      users,
      notifications: createNotificationRepository(db),
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      eventKey: 'account.notice:paging-test:v1',
      copy: COPY,
      pageSize: 2,
    });

    expect(result).toEqual({ users: 5, inserted: 5, failed: 0 });
    // 5 recipients at 2 per page: three full-ish pages then a short one ends it.
    expect(pages.map((p) => p.size)).toEqual([2, 2, 1]);
    expect(pages[0]!.afterId).toBeNull();
    expect(pages[1]!.afterId).not.toBeNull();
    // Every page is capped — no read ever returns the whole table.
    for (const page of pages) expect(page.size).toBeLessThanOrEqual(2);
  });

  it('isolates a failing recipient: the rest still land and the failure is counted', async () => {
    const first = await harness.seedUser({ email: 'iso1@bt.test', username: 'iso1' });
    const second = await harness.seedUser({ email: 'iso2@bt.test', username: 'iso2' });
    const third = await harness.seedUser({ email: 'iso3@bt.test', username: 'iso3' });
    const ids = [first.id, second.id, third.id].sort();
    // Fail a recipient in the MIDDLE of the walk — the old serial loop
    // propagated the throw, so everyone after it was never reached.
    const victim = ids[1]!;

    const real = createNotificationRepository(db);
    const eventKey = 'account.notice:isolation-test:v1';
    const result = await fanOutAnnouncement({
      users: createUserRepository(db),
      notifications: {
        insert: async (input) => {
          if (input.userId === victim) throw new Error('insert boom');
          return real.insert(input);
        },
      },
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      eventKey,
      copy: COPY,
    });

    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(result.users - 1);
    expect(await real.existsForEventKey(victim, eventKey)).toBe(false);
    for (const id of ids.filter((candidate) => candidate !== victim)) {
      expect(await real.existsForEventKey(id, eventKey)).toBe(true);
    }
  });
});
