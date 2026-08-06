import {
  activeAnnouncementListResponseSchema,
  notificationListResponseSchema,
  okResponseSchema,
  readNotificationPayload,
  type ActiveAnnouncementListResponse,
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
 * Degrade each row's payload before validating the response (#1138). A tab
 * running an older build than the worker that wrote a row cannot read that
 * row's `message` descriptor (`key` is a closed enum, the descriptor is
 * `.strict()`); parsing as-is would reject the ENTIRE inbox over one row.
 * `readNotificationPayload` drops only the unreadable field, so the row still
 * renders from its persisted title/body and keeps `eventKey` plus every
 * deep-link id. Rows with no payload (historical ones, `null`) pass through.
 */
function withReadablePayloads(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return data;
  return {
    ...(data as Record<string, unknown>),
    items: items.map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const { payload } = item as { payload?: unknown };
      if (payload === undefined || payload === null) return item;
      return { ...(item as Record<string, unknown>), payload: readNotificationPayload(payload) };
    }),
  };
}

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
  return notificationListResponseSchema.parse(withReadablePayloads(data));
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

// ── Announcements banner (§13.4 V4-P5b) ─────────────────────────────────────

/**
 * `GET /notifications/announcements` — the currently-active, not-dismissed set
 * for the caller, rendered server-side in the viewer's locale (EN fallback).
 */
export async function listActiveAnnouncements(
  signal?: AbortSignal,
): Promise<ActiveAnnouncementListResponse> {
  const data = await apiRequest<unknown>('/notifications/announcements', { signal });
  return activeAnnouncementListResponseSchema.parse(data);
}

/**
 * `POST /notifications/announcements/:id/dismiss` — per-user dismissal.
 * Idempotent; a repeat is a no-op. A newly-published announcement re-appears
 * for the caller regardless of an earlier dismissal (per user AND per row).
 */
export async function dismissAnnouncement(id: string): Promise<void> {
  const data = await apiRequest<unknown>(
    `/notifications/announcements/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST' },
  );
  okResponseSchema.parse(data);
}
