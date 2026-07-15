import type {
  DevicePlatform,
  MarkReadRequest,
  Notification,
  NotificationListResponse,
  NotificationView,
  WebPushSubscribeRequest,
} from '@bettertrack/contracts';

import type { DeviceTokenRepository } from '../../data/repositories/deviceTokenRepository';
import type {
  NotificationRecord,
  NotificationRepository,
} from '../../data/repositories/notificationRepository';
import type { PushSubscriptionRepository } from '../../data/repositories/pushSubscriptionRepository';
import { notFound } from '../../errors';

/**
 * User-scoped notification surface (PROJECTPLAN.md §6.10, §8; #368, #437):
 * inbox read/mark-read, archive state + hard deletion, plus the push
 * registrations — FCM device tokens and web-push subscriptions. Every read and
 * write is scoped to the caller through the repositories' `user_id` filters,
 * so another user's notification id (or token) is indistinguishable from a
 * missing one — no IDOR by construction (§10). Registration endpoints work
 * even while the matching push channel is unconfigured: tokens are stored for
 * the moment the channel comes online.
 */

const DEFAULT_LIMIT = 20;

export interface NotificationServiceDeps {
  repo: NotificationRepository;
  devices: DeviceTokenRepository;
  webPushSubs: PushSubscriptionRepository;
  /** Clock seam so read=archive stamping is deterministic under test (#437, V4-P0c). */
  now?: () => Date;
}

function toNotification(record: NotificationRecord): Notification {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    payload: record.payload ?? undefined,
    readAt: record.readAt ? record.readAt.toISOString() : null,
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface NotificationService {
  list(
    userId: string,
    params: { cursor?: string; limit?: number; view?: NotificationView },
  ): Promise<NotificationListResponse>;
  markRead(userId: string, body: MarkReadRequest): Promise<void>;
  /** Archive one owned row; marks it read too (#437). 404s on a foreign/unknown id. */
  archive(userId: string, id: string): Promise<void>;
  /** Bring one owned row back to active (#437). 404s on a foreign/unknown id. */
  unarchive(userId: string, id: string): Promise<void>;
  /** Archive every read, still-active row (bulk, idempotent; #437). */
  archiveAllRead(userId: string): Promise<void>;
  /** Hard-delete one owned row (#437). 404s on a foreign/unknown/repeated id. */
  remove(userId: string, id: string): Promise<void>;
  /** Bulk hard delete (#437): exactly the archived set, or everything. */
  removeBulk(userId: string, scope: 'archived' | 'all'): Promise<void>;
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
  const now = deps.now ?? (() => new Date());

  const notificationNotFound = () => notFound('Notification not found.', 'NOTIFICATION_NOT_FOUND');

  return {
    async list(userId, params) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      // Read ⟺ archived (V4-P0c): reading a notification archives it eagerly at
      // mark-read time, so the active view already shows unread only — no lazy
      // sweep needed (the #437 threshold sweep is superseded).
      const [{ items, nextCursor }, unreadCount] = await Promise.all([
        repo.listForUser(userId, { cursor: params.cursor, limit, view: params.view ?? 'active' }),
        // Unread among ACTIVE only (#437) — the badge, identical in every view.
        repo.countUnread(userId),
      ]);
      return { items: items.map(toNotification), nextCursor, unreadCount };
    },

    async markRead(userId, body) {
      // Reading archives (V4-P0c): the row leaves the active inbox and lands
      // under Archived in the same stroke.
      if ('all' in body) {
        await repo.markAllRead(userId, now());
      } else {
        await repo.markRead(userId, body.ids, now());
      }
    },

    async archive(userId, id) {
      if (!(await repo.archive(userId, id, now()))) throw notificationNotFound();
    },

    async unarchive(userId, id) {
      if (!(await repo.unarchive(userId, id))) throw notificationNotFound();
    },

    async archiveAllRead(userId) {
      await repo.archiveAllRead(userId, now());
    },

    async remove(userId, id) {
      if (!(await repo.deleteOne(userId, id))) throw notificationNotFound();
    },

    async removeBulk(userId, scope) {
      await repo.deleteBulk(userId, scope);
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
