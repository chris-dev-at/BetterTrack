import {
  accountSettingsResponseSchema,
  discordSettingsResponseSchema,
  discordTestResponseSchema,
  notificationSettingsResponseSchema,
  taxSettingsResponseSchema,
  telegramConfirmResponseSchema,
  telegramSettingsResponseSchema,
  type AccountSettingsResponse,
  type DiscordSettingsResponse,
  type DiscordTestResponse,
  type DiscordWebhookRequest,
  type NotificationSettingsResponse,
  type TaxSettingsResponse,
  type TelegramConfirmResponse,
  type TelegramSettingsResponse,
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

// ── Telegram + Discord channels (§13.4 V4-P10) ──────────────────────────────

/** `GET /settings/telegram` — the caller's Telegram link state. */
export async function getTelegramSettings(signal?: AbortSignal): Promise<TelegramSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/telegram', { signal });
  return telegramSettingsResponseSchema.parse(data);
}

/** `POST /settings/telegram/link` — mint a fresh link code + deep link. */
export async function startTelegramLink(): Promise<TelegramSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/telegram/link', { method: 'POST' });
  return telegramSettingsResponseSchema.parse(data);
}

/**
 * `POST /settings/telegram/confirm` — poll for the bot's `/start` update. The
 * SPA polls this while `pending` is true; success flips to `linked`.
 */
export async function confirmTelegramLink(): Promise<TelegramConfirmResponse> {
  const data = await apiRequest<unknown>('/settings/telegram/confirm', { method: 'POST' });
  return telegramConfirmResponseSchema.parse(data);
}

/** `DELETE /settings/telegram` — unlink; idempotent. */
export async function unlinkTelegram(): Promise<TelegramSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/telegram', { method: 'DELETE' });
  return telegramSettingsResponseSchema.parse(data);
}

/** `GET /settings/discord` — the caller's Discord webhook state (masked). */
export async function getDiscordSettings(signal?: AbortSignal): Promise<DiscordSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/discord', { signal });
  return discordSettingsResponseSchema.parse(data);
}

/**
 * `POST /settings/discord/webhook` — save or replace the caller's webhook.
 * The API validates the URL shape AND live-tests it before persisting.
 */
export async function saveDiscordWebhook(
  body: DiscordWebhookRequest,
): Promise<DiscordSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/discord/webhook', { method: 'POST', body });
  return discordSettingsResponseSchema.parse(data);
}

/** `POST /settings/discord/test` — send a diagnostic message to the saved webhook. */
export async function testDiscordWebhook(): Promise<DiscordTestResponse> {
  const data = await apiRequest<unknown>('/settings/discord/test', { method: 'POST' });
  return discordTestResponseSchema.parse(data);
}

/** `DELETE /settings/discord` — remove the caller's webhook. */
export async function removeDiscordWebhook(): Promise<DiscordSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/discord', { method: 'DELETE' });
  return discordSettingsResponseSchema.parse(data);
}
