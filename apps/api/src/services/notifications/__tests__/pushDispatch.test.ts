import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { Database } from '../../../data/db';
import { notifications, notificationSettings } from '../../../data/schema';
import type { ChatMessageEvent } from '../../../events';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import type { FcmChannel, PushMessage } from '../fcm';
import { createPresenceStore, type PresenceStore } from '../presence';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';
import type { WebPushChannel } from '../webPush';

/**
 * The dispatcher's push fan-out + presence suppression (#368): both push
 * channels behind the matrix, and the owner-mandated "don't notify about the
 * conversation the user is looking at" rule across EVERY channel.
 */

let harness: TestHarness;
let db: Database;
let fcmSent: { userId: string; message: PushMessage }[];
let webSent: { userId: string; message: PushMessage }[];
let presence: PresenceStore;
let dispatcher: NotificationDispatcher;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
  fcmSent = [];
  webSent = [];
  presence = createPresenceStore({ redis: harness.ctx.redis });
  const fcm: FcmChannel = {
    async deliver(userId, message) {
      fcmSent.push({ userId, message });
    },
  };
  const webPush: WebPushChannel = {
    async deliver(userId, message) {
      webSent.push({ userId, message });
    },
  };
  dispatcher = createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    users: createUserRepository(db),
    fcm,
    webPush,
    presence,
    logger: harness.ctx.logger,
  });
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function chatEvent(userId: string, overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
  return {
    type: 'chat.message',
    userId,
    senderId: 'sender',
    senderUsername: 'anna',
    conversationId: '00000000-0000-7000-8000-00000000c001',
    messageId: '00000000-0000-7000-8000-00000000a001',
    bodyPreview: 'hi',
    hasChip: false,
    occurredAt: '2026-07-10T10:00:00.000Z',
    ...overrides,
  };
}

async function rowsFor(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId));
}

describe('push channels through the matrix (#368)', () => {
  it('delivers to FCM and web-push by default, with the canonical type in the message', async () => {
    const user = await harness.seedUser({ email: 'p@bt.test', username: 'pushee' });
    await dispatcher.dispatch(chatEvent(user.id));

    expect(fcmSent).toHaveLength(1);
    expect(fcmSent[0]!.userId).toBe(user.id);
    expect(fcmSent[0]!.message.type).toBe('chat.message');
    expect(fcmSent[0]!.message.data.conversationId).toBe('00000000-0000-7000-8000-00000000c001');
    expect(webSent).toHaveLength(1);
  });

  it('routes push and webpush independently via the matrix', async () => {
    const user = await harness.seedUser({ email: 'p@bt.test', username: 'pushee' });
    await db.insert(notificationSettings).values([
      { userId: user.id, channel: 'push', enabled: true, config: { 'chat.message': false } },
      { userId: user.id, channel: 'webpush', enabled: true, config: {} },
    ]);

    await dispatcher.dispatch(chatEvent(user.id));

    expect(fcmSent).toHaveLength(0);
    expect(webSent).toHaveLength(1);
    // The bell row still landed (in-app untouched).
    expect((await rowsFor(user.id)).filter((r) => !r.hidden)).toHaveLength(1);
  });

  it('a redelivered event never re-pushes (eventKey dedupe)', async () => {
    const user = await harness.seedUser({ email: 'p@bt.test', username: 'pushee' });
    const event = chatEvent(user.id);
    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);
    expect(fcmSent).toHaveLength(1);
    expect(webSent).toHaveLength(1);
  });
});

describe('presence suppression (#368 owner mandate)', () => {
  it('suppresses bell/push for the conversation the recipient is viewing; the row persists read', async () => {
    const user = await harness.seedUser({ email: 'v@bt.test', username: 'viewer' });
    const event = chatEvent(user.id);
    await presence.enter(user.id, 'chat', event.conversationId);

    const published: string[] = [];
    const unsubscribe = await harness.ctx.events.subscribe('notification.created', (e) => {
      published.push(e.notificationId);
    });
    await dispatcher.dispatch(event);
    await unsubscribe();

    // Persisted to the inbox as already read — no unread bump…
    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hidden).toBe(false);
    expect(rows[0]!.readAt).not.toBeNull();
    // …and NO channel fired: no bell push, no email, no phone/browser push.
    expect(published).toHaveLength(0);
    expect(fcmSent).toHaveLength(0);
    expect(webSent).toHaveLength(0);
  });

  it('presence on a DIFFERENT conversation does not suppress', async () => {
    const user = await harness.seedUser({ email: 'v@bt.test', username: 'viewer' });
    await presence.enter(user.id, 'chat', '00000000-0000-7000-8000-00000000beef');

    await dispatcher.dispatch(chatEvent(user.id));

    const rows = await rowsFor(user.id);
    expect(rows[0]!.readAt).toBeNull();
    expect(fcmSent).toHaveLength(1);
  });

  it('after presence clears (leave), delivery is back to normal', async () => {
    const user = await harness.seedUser({ email: 'v@bt.test', username: 'viewer' });
    const first = chatEvent(user.id);
    await presence.enter(user.id, 'chat', first.conversationId);
    await presence.leave(user.id, 'chat', first.conversationId);

    await dispatcher.dispatch(first);

    expect(fcmSent).toHaveLength(1);
    expect((await rowsFor(user.id))[0]!.readAt).toBeNull();
  });

  it('a presence-store failure fails OPEN (delivers) rather than swallowing', async () => {
    const user = await harness.seedUser({ email: 'v@bt.test', username: 'viewer' });
    const broken: PresenceStore = {
      enter: async () => undefined,
      leave: async () => undefined,
      isPresent: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    const failing = createNotificationDispatcher({
      bus: harness.ctx.events,
      repo: createNotificationRepository(db),
      users: createUserRepository(db),
      presence: broken,
      logger: harness.ctx.logger,
    });

    await failing.dispatch(chatEvent(user.id));

    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.readAt).toBeNull();
  });
});
