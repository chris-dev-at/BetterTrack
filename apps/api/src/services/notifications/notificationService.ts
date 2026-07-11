import type {
  DevicePlatform,
  MarkReadRequest,
  Notification,
  NotificationListResponse,
  WebPushSubscribeRequest,
} from '@bettertrack/contracts';

import type { DeviceTokenRepository } from '../../data/repositories/deviceTokenRepository';
import type {
  NotificationRecord,
  NotificationRepository,
} from '../../data/repositories/notificationRepository';
import type { PushSubscriptionRepository } from '../../data/repositories/pushSubscriptionRepository';

/**
 * User-scoped notification surface (PROJECTPLAN.md §6.10, §8; #368): inbox
 * read/mark-read plus the push registrations — FCM device tokens and web-push
 * subscriptions. Every read and write is scoped to the caller through the
 * repositories' `user_id` filters, so another user's notification id (or
 * token) is indistinguishable from a missing one — no IDOR by construction
 * (§10). Registration endpoints work even while the matching push channel is
 * unconfigured: tokens are stored for the moment the channel comes online.
 */

const DEFAULT_LIMIT = 20;

export interface NotificationServiceDeps {
  repo: NotificationRepository;
  devices: DeviceTokenRepository;
  webPushSubs: PushSubscriptionRepository;
}

function toNotification(record: NotificationRecord): Notification {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    payload: record.payload ?? undefined,
    readAt: record.readAt ? record.readAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface NotificationService {
  list(
    userId: string,
    params: { cursor?: string; limit?: number },
  ): Promise<NotificationListResponse>;
  markRead(userId: string, body: MarkReadRequest): Promise<void>;
  /** Idempotent FCM device registration — upsert by token, re-bound to the caller. */
  registerDevice(userId: string, token: string, platform: DevicePlatform): Promise<void>;
  /** Remove one of the caller's device tokens (idempotent; never another user's). */
  deleteDevice(userId: string, token: string): Promise<void>;
  /** Idempotent web-push subscription — upsert by endpoint, re-bound to the caller. */
  subscribeWebPush(userId: string, sub: WebPushSubscribeRequest): Promise<void>;
  /** Remove one of the caller's web-push subscriptions (idempotent). */
  unsubscribeWebPush(userId: string, endpoint: string): Promise<void>;
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { repo, devices, webPushSubs } = deps;

  return {
    async list(userId, params) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const [{ items, nextCursor }, unreadCount] = await Promise.all([
        repo.listForUser(userId, { cursor: params.cursor, limit }),
        repo.countUnread(userId),
      ]);
      return { items: items.map(toNotification), nextCursor, unreadCount };
    },

    async markRead(userId, body) {
      if ('all' in body) {
        await repo.markAllRead(userId);
      } else {
        await repo.markRead(userId, body.ids);
      }
    },

    registerDevice: (userId, token, platform) => devices.upsert(userId, token, platform),

    deleteDevice: (userId, token) => devices.deleteForUser(userId, token),

    subscribeWebPush: (userId, sub) =>
      webPushSubs.upsert(userId, {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      }),

    unsubscribeWebPush: (userId, endpoint) => webPushSubs.deleteForUser(userId, endpoint),
  };
}
