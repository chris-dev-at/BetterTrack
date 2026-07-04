import {
  notificationSettingsResponseSchema,
  type NotificationSettingsResponse,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the per-user settings surface (PROJECTPLAN.md §6.10, §6.11),
 * mirroring `notificationsApi.ts` / `socialApi.ts`. V1 covers the notification
 * channel toggles the dispatcher honors.
 */

/** `GET /settings/notifications` — the session user's per-channel state. */
export async function getNotificationSettings(
  signal?: AbortSignal,
): Promise<NotificationSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/notifications', { signal });
  return notificationSettingsResponseSchema.parse(data);
}

/** `PATCH /settings/notifications` — partial toggles; returns the new state. */
export async function updateNotificationSettings(
  body: UpdateNotificationSettingsRequest,
): Promise<NotificationSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/notifications', { method: 'PATCH', body });
  return notificationSettingsResponseSchema.parse(data);
}
