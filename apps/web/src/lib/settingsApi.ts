import {
  accountSettingsResponseSchema,
  notificationSettingsResponseSchema,
  type AccountSettingsResponse,
  type NotificationSettingsResponse,
  type PortfolioVisibility,
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

/** `GET /settings/account` — the caller's account defaults (default portfolio visibility, §6.9). */
export async function getAccountSettings(signal?: AbortSignal): Promise<AccountSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/account', { signal });
  return accountSettingsResponseSchema.parse(data);
}

/** `PATCH /settings/account` — update the default portfolio visibility (§6.9, V2-P9). */
export async function updateAccountSettings(
  defaultPortfolioVisibility: PortfolioVisibility,
): Promise<AccountSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/account', {
    method: 'PATCH',
    body: { defaultPortfolioVisibility },
  });
  return accountSettingsResponseSchema.parse(data);
}
