import type {
  MarkReadRequest,
  Notification,
  NotificationListResponse,
} from '@bettertrack/contracts';

import type {
  NotificationRecord,
  NotificationRepository,
} from '../../data/repositories/notificationRepository';

/**
 * User-scoped notification read/mark-read orchestration (PROJECTPLAN.md §6.10,
 * §8). Every read and write is scoped to the caller through the repository's
 * `user_id` filter, so another user's notification id is indistinguishable
 * from a missing one — no IDOR by construction (§10).
 */

const DEFAULT_LIMIT = 20;

export interface NotificationServiceDeps {
  repo: NotificationRepository;
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
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { repo } = deps;

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
  };
}
