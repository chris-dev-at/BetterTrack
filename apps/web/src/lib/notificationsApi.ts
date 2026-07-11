import {
  notificationListResponseSchema,
  okResponseSchema,
  type MarkReadRequest,
  type NotificationListResponse,
  type NotificationView,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the notification read/mark-read + archive/delete surface
 * (PROJECTPLAN.md §6.10; #437), mirroring `socialApi.ts` / `portfolioApi.ts`.
 */

/**
 * `GET /notifications?view=&cursor=` — newest-first, keyset paginated, with
 * unreadCount (unread among ACTIVE only). `view` defaults server-side to
 * `active`, i.e. archived rows are hidden unless asked for (#437).
 */
export async function listNotifications(
  params: { cursor?: string; limit?: number; view?: NotificationView } = {},
  signal?: AbortSignal,
): Promise<NotificationListResponse> {
  const data = await apiRequest<unknown>('/notifications', {
    query: { cursor: params.cursor, limit: params.limit, view: params.view },
    signal,
  });
  return notificationListResponseSchema.parse(data);
}

/** `POST /notifications/mark-read {ids|all}` — idempotent. */
export async function markNotificationsRead(body: MarkReadRequest): Promise<void> {
  const data = await apiRequest<unknown>('/notifications/mark-read', { method: 'POST', body });
  okResponseSchema.parse(data);
}

/** `POST /notifications/:id/archive` — also marks the row read (#437). */
export async function archiveNotification(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/notifications/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `POST /notifications/:id/unarchive` — back to active, stays read (#437). */
export async function unarchiveNotification(id: string): Promise<void> {
  const data = await apiRequest<unknown>(`/notifications/${encodeURIComponent(id)}/unarchive`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `POST /notifications/archive-all-read` — bulk, idempotent (#437). */
export async function archiveAllReadNotifications(): Promise<void> {
  const data = await apiRequest<unknown>('/notifications/archive-all-read', { method: 'POST' });
  okResponseSchema.parse(data);
}

/** `DELETE /notifications/:id` — hard delete; a repeat 404s (#437). */
export async function deleteNotification(id: string): Promise<void> {
  await apiRequest<unknown>(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * `DELETE /notifications?scope=archived|all` — bulk hard delete (#437):
 * exactly the archived set, or absolutely everything of the caller's.
 */
export async function deleteNotifications(scope: 'archived' | 'all'): Promise<void> {
  await apiRequest<unknown>('/notifications', { method: 'DELETE', query: { scope } });
}
