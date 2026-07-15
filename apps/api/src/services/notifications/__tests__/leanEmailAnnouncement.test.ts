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
    expect(result).toEqual({ users: 2, inserted: 2 });

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
    expect(second).toEqual({ users: 1, inserted: 0 });

    expect(await announcementRowsFor(user.id)).toHaveLength(1);
  });
});
