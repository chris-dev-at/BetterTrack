import {
  accountSettingsResponseSchema,
  notificationSettingsResponseSchema,
  taxSettingsResponseSchema,
  type AccountSettingsResponse,
  type NotificationSettingsResponse,
  type TaxSettingsResponse,
  type UpdateAccountSettingsRequest,
  type UpdateNotificationSettingsRequest,
  type UpdateTaxSettingsRequest,
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

/**
 * `PATCH /settings/account` — partial update of the caller's account prefs
 * (default portfolio visibility §6.9/V2-P9, and/or UI language §13.3/V3-P1).
 * Supply only the fields to change.
 */
export async function updateAccountSettings(
  patch: UpdateAccountSettingsRequest,
): Promise<AccountSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/account', {
    method: 'PATCH',
    body: patch,
  });
  return accountSettingsResponseSchema.parse(data);
}

/**
 * `GET /settings/taxes` — the caller's tax mode (V3-P4). `none` /
 * `manual_per_trade` / `country_specific` (with `country` set only in the last
 * case). Drives the manual per-trade field in `TransactionDialog` and the
 * per-year tax report page.
 */
export async function getTaxSettings(signal?: AbortSignal): Promise<TaxSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/taxes', { signal });
  return taxSettingsResponseSchema.parse(data);
}

/**
 * `PATCH /settings/taxes` — switch tax mode (V3-P4). `country` is required with
 * `country_specific` and rejected with any other mode (the contract enforces the
 * pair); switching applies forward only and never rewrites recorded rows.
 */
export async function updateTaxSettings(
  body: UpdateTaxSettingsRequest,
): Promise<TaxSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/taxes', { method: 'PATCH', body });
  return taxSettingsResponseSchema.parse(data);
}
