import {
  accountSettingsResponseSchema,
  discordSettingsResponseSchema,
  discordTestResponseSchema,
  homeLayoutEnvelopeSchema,
  notificationSettingsResponseSchema,
  taxSettingsResponseSchema,
  taxYearChangesResponseSchema,
  telegramConfirmResponseSchema,
  telegramSettingsResponseSchema,
  type AccountSettingsResponse,
  type DiscordSettingsResponse,
  type DiscordTestResponse,
  type DiscordWebhookRequest,
  type HomeLayoutEnvelope,
  type NotificationSettingsResponse,
  type TaxSettingsResponse,
  type TaxYearChangesResponse,
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
 * pair); every derivable tax year remains living documentation under it.
 */
export async function updateTaxSettings(
  body: UpdateTaxSettingsRequest,
): Promise<TaxSettingsResponse> {
  const data = await apiRequest<unknown>('/settings/taxes', { method: 'PATCH', body });
  return taxSettingsResponseSchema.parse(data);
}

/** `GET /settings/taxes/years` — account-wide living-documentation markers. */
export async function getTaxYearChanges(signal?: AbortSignal): Promise<TaxYearChangesResponse> {
  const data = await apiRequest<unknown>('/settings/taxes/years', { signal });
  return taxYearChangesResponseSchema.parse(data);
}

// ── Home widget board (R2 home-widgets) ─────────────────────────────────────
//
// Both calls parse only the ENVELOPE (`homeLayoutEnvelopeSchema`) and hand the
// layout through as `unknown`. Validating the board against this build's own
// schema would mean a document saved by a newer web deploy failing the response
// parse and blanking Home; instead `parseHomeLayout` degrades it — keeping the
// widgets this build knows and dropping the rest WITHOUT rewriting anything.

/** `GET /settings/home` — the caller's board; both fields null when none was saved. */
export async function getHomeLayout(signal?: AbortSignal): Promise<HomeLayoutEnvelope> {
  const data = await apiRequest<unknown>('/settings/home', { signal });
  return homeLayoutEnvelopeSchema.parse(data);
}

/**
 * `PUT /settings/home` — replace the board outright (`null` clears it). Returns
 * the stored revision, which the caller records as its last-synced marker.
 *
 * `keepalive` is set by the `pagehide` flush only: the browser then finishes the
 * request after the tab is gone, so the last edit before a fast close is not lost.
 */
export async function putHomeLayout(
  layout: unknown,
  options: { keepalive?: boolean } = {},
): Promise<HomeLayoutEnvelope> {
  const data = await apiRequest<unknown>('/settings/home', {
    method: 'PUT',
    body: { layout },
    keepalive: options.keepalive,
  });
  return homeLayoutEnvelopeSchema.parse(data);
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
