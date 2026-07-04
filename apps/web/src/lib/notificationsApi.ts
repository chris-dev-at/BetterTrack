import {
  notificationListResponseSchema,
  okResponseSchema,
  type MarkReadRequest,
  type NotificationListResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the notification read/mark-read surface (PROJECTPLAN.md
 * §6.10), mirroring `socialApi.ts` / `portfolioApi.ts`.
 */

/** `GET /notifications?cursor=` — newest-first, keyset paginated, with unreadCount. */
export async function listNotifications(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<NotificationListResponse> {
  const data = await apiRequest<unknown>('/notifications', {
    query: { cursor: params.cursor, limit: params.limit },
    signal,
  });
  return notificationListResponseSchema.parse(data);
}

/** `POST /notifications/mark-read {ids|all}` — idempotent. */
export async function markNotificationsRead(body: MarkReadRequest): Promise<void> {
  const data = await apiRequest<unknown>('/notifications/mark-read', { method: 'POST', body });
  okResponseSchema.parse(data);
}
