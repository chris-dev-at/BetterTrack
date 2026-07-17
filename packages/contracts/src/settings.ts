import { z } from 'zod';

import { MAX_PASSWORD_LENGTH } from './auth';
import { localeSchema } from './i18n';
import { NOTIFICATION_TYPES, type NotificationType } from './notifications';
import { portfolioVisibilitySchema } from './portfolio';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8; #368
 * Notifications v2). The `GET/PATCH /settings/notifications` surface exposes a
 * **per-type × channel matrix**: each {@link NOTIFICATION_TYPES} entry routes
 * independently to the **in-app bell**, **email**, **phone push** (FCM) and
 * **browser push** (web-push/VAPID), every cell defaulting to *on*.
 *
 * The push channels are deployment-gated: `channels` reports which are actually
 * configured on the server (SMTP for email, `BT_FCM_SERVICE_ACCOUNT_FILE` for
 * push, VAPID keys for webpush) so the UI only renders live columns — matrix
 * cells for an unconfigured channel still persist, they just deliver nothing
 * until the channel comes online. `muted` is the global kill switch: while set,
 * the dispatcher suppresses every channel regardless of the matrix.
 */

/** The user-toggleable notification channels (grid columns), in display order. */
export const NOTIFICATION_SETTING_CHANNELS = [
  'inapp',
  'email',
  'telegram',
  'discord',
  'push',
  'webpush',
] as const;
export type NotificationSettingChannel = (typeof NOTIFICATION_SETTING_CHANNELS)[number];

/**
 * One notification type's routing: which channels it fans out to. All-false =
 * muted for that type. Telegram + Discord (V4-P10) are additive channels that
 * default ON per type once the user configures them (matching the push
 * channels' behaviour), so an existing user with no override lights the cell
 * up as soon as the link/webhook is saved.
 */
export const notificationTypeRoutingSchema = z
  .object({
    inapp: z.boolean(),
    email: z.boolean(),
    telegram: z.boolean(),
    discord: z.boolean(),
    push: z.boolean(),
    webpush: z.boolean(),
  })
  .strict();
export type NotificationTypeRouting = z.infer<typeof notificationTypeRoutingSchema>;

// Build the matrix object schema keyed by every V1 type. Explicit per-type keys
// (rather than z.record) let the response guarantee every type is present with
// defaults applied, and give the SPA a fully-typed matrix.
const requiredMatrixShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationTypeRoutingSchema]),
) as Record<NotificationType, typeof notificationTypeRoutingSchema>;

const partialMatrixShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationTypeRoutingSchema.optional()]),
) as Record<NotificationType, z.ZodOptional<typeof notificationTypeRoutingSchema>>;

/** The full matrix: every type present, defaults applied — the GET response shape. */
export const notificationMatrixSchema = z.object(requiredMatrixShape).strict();
export type NotificationMatrix = z.infer<typeof notificationMatrixSchema>;

/**
 * Which channels the deployment can actually deliver on. `inapp` is always
 * true; the rest reflect server config (SMTP / FCM service account / VAPID)
 * plus per-user setup for the V4-P10 channels: `telegram` reports whether the
 * caller has a linked chat (bot token set AND link confirmed), `discord`
 * whether the caller has saved a validated webhook. Rendering the matrix
 * column keys off this so an unconfigured channel never surfaces.
 */
export const notificationChannelAvailabilitySchema = z
  .object({
    inapp: z.boolean(),
    email: z.boolean(),
    telegram: z.boolean(),
    discord: z.boolean(),
    push: z.boolean(),
    webpush: z.boolean(),
  })
  .strict();
export type NotificationChannelAvailability = z.infer<typeof notificationChannelAvailabilitySchema>;

/**
 * Deployment-level "is this channel offered at all in this build?" flags for
 * the V4-P10 additive channels (V5-P0 kill-switch). Distinct from
 * {@link notificationChannelAvailabilitySchema} — which conflates deployment
 * config with per-user linked state — these flip strictly with the
 * `BT_TELEGRAM_DISCORD_ENABLED` env kill-switch (Telegram also requires a bot
 * token). Drives whether the SPA renders the setup cards at all so it never
 * needs to probe the setup endpoints to decide.
 */
export const notificationChannelsConfigurableSchema = z
  .object({
    telegram: z.boolean(),
    discord: z.boolean(),
  })
  .strict();
export type NotificationChannelsConfigurable = z.infer<
  typeof notificationChannelsConfigurableSchema
>;

/**
 * `GET /settings/notifications` response — the session user's full type × channel
 * matrix (every type present, defaults applied), the global-mute flag, which
 * channels this deployment has configured, which of the V4-P10 additive channels
 * are OFFERED by this build at all (V5-P0 kill-switch), and — when browser push
 * is live — the VAPID public key the SPA needs for `PushManager.subscribe`.
 */
export const notificationSettingsResponseSchema = z
  .object({
    matrix: notificationMatrixSchema,
    muted: z.boolean(),
    channels: notificationChannelAvailabilitySchema,
    channelsConfigurable: notificationChannelsConfigurableSchema,
    webPushPublicKey: z.string().nullable(),
  })
  .strict();
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponseSchema>;

/**
 * `PATCH /settings/notifications` body — a partial matrix and/or the global-mute
 * flag; at least one of the two is required. Each supplied type carries its full
 * four-channel routing.
 */
export const updateNotificationSettingsRequestSchema = z
  .object({
    matrix: z.object(partialMatrixShape).strict().optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.muted !== undefined || Object.keys(body.matrix ?? {}).length > 0, {
    message: 'At least one notification type or the muted flag is required.',
  });
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;

// --- Account settings (§6.9, §6.11, §13.2 V2-P9, §13.3 V3-P10d) ------------

/**
 * The base currencies a user can pick (§5.4, §13.3 V3-P10d). EUR is the
 * default; the initial set covers the owner-approved USD/CHF/GBP. Growing the
 * set is a one-line change here — every conversion already routes through the
 * §5.4 keystone with the base as a parameter, and FX crosses through EUR via
 * Yahoo's `EUR{CCY}=X` pairs, so no per-currency code exists anywhere.
 */
export const BASE_CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];
export const baseCurrencySchema = z.enum(BASE_CURRENCIES);

/**
 * Settings → Account defaults (§6.9, V2-P9; §13.3 V3-P1 + V3-P10d):
 *  - **default portfolio visibility** applied when a new portfolio is created —
 *    `private` (default) or `friends`. Changing it only affects the *default*
 *    at creation time: existing portfolios and per-item toggles are untouched.
 *  - **locale** — the UI-language preference (§13.3 V3-P1); EN by default.
 *  - **baseCurrency** — the currency every valuation/graph/report is rendered
 *    in (§5.4: a read-time parameter only; stored amounts stay native).
 */
export const accountSettingsResponseSchema = z
  .object({
    defaultPortfolioVisibility: portfolioVisibilitySchema,
    /** The user's UI-language preference (§13.3 V3-P1); EN by default. */
    locale: localeSchema,
    /** The user's base currency (§13.3 V3-P10d); EUR by default. */
    baseCurrency: baseCurrencySchema,
  })
  .strict();
export type AccountSettingsResponse = z.infer<typeof accountSettingsResponseSchema>;

/**
 * `PATCH /settings/account` body — a **partial** account-settings update: supply
 * any of the default portfolio visibility, the UI language, or the base
 * currency. At least one field is required, mirroring the notification-matrix
 * PATCH. Omitted fields are left untouched.
 */
export const updateAccountSettingsRequestSchema = z
  .object({
    defaultPortfolioVisibility: portfolioVisibilitySchema.optional(),
    locale: localeSchema.optional(),
    baseCurrency: baseCurrencySchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.defaultPortfolioVisibility !== undefined ||
      body.locale !== undefined ||
      body.baseCurrency !== undefined,
    {
      message: 'At least one setting is required.',
    },
  );
export type UpdateAccountSettingsRequest = z.infer<typeof updateAccountSettingsRequestSchema>;

// --- Account data export (§13.4 V4-P6a, #494) ------------------------------

/**
 * Settings → "Export my data": an async job assembles a zip of every
 * user-owned entity (JSON per entity + CSVs for transactions / cash movements /
 * holdings), delivered behind an expiring, re-auth-gated download.
 *
 * Flow (all on `/account/export`):
 *  1. `POST` — re-authenticate (password OR a fresh 2FA code / recovery code),
 *     rate-limited to 1/day. Returns the job id, its status, and the RAW
 *     download token ONCE. Only the token's SHA-256 hash is stored server-side,
 *     so this response is the sole delivery of the usable token (mirrors the
 *     invite / password-reset model). The token is minted behind the re-auth
 *     and short-lived, so it doubles as the download's "fresh re-auth" proof.
 *  2. `GET` — poll the latest job's status (no secret in the response).
 *  3. `GET /download?token=` — the session owner streams the zip while the
 *     token matches and the job is `ready` and unexpired; a foreign or expired
 *     token fails closed.
 */

/** Lifecycle of one export job. `expired` is a ready job past its download window. */
export const EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const exportStatusSchema = z.enum(EXPORT_STATUSES);

/**
 * `POST /account/export` body — the re-auth gate. Send the current password, or
 * (for a 2FA-enrolled account) a fresh TOTP `code` or an unused `recoveryCode`.
 * Exactly the credential shape the account-deletion flow uses, minus the typed
 * username confirmation (an export is non-destructive).
 */
export const exportRequestSchema = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    /** A fresh 6-digit authenticator (TOTP) code — 2FA-enrolled accounts only. */
    code: z.string().trim().min(4).max(16).optional(),
    /** An unused recovery code — consumed on success AND on a failed match. */
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  .strict()
  .refine((b) => b.password !== undefined || b.code !== undefined || b.recoveryCode !== undefined, {
    message: 'Re-authentication is required: send your password or a two-factor code.',
  });
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/**
 * `GET /account/export` response — the caller's latest export job, or
 * `status: null` when they have never requested one. Carries no secret; the
 * download token lives only in the {@link exportRequestResponseSchema}.
 */
export const exportStatusResponseSchema = z
  .object({
    status: exportStatusSchema.nullable(),
    jobId: z.string().uuid().nullable(),
    requestedAt: z.string().datetime().nullable(),
    /** When the ready file stops being downloadable (null until ready). */
    expiresAt: z.string().datetime().nullable(),
    /** Zip size in bytes once ready (null otherwise). */
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ExportStatusResponse = z.infer<typeof exportStatusResponseSchema>;

/**
 * `POST /account/export` response — the freshly-created job plus the RAW,
 * single-delivery download token. The client keeps it to build the download
 * URL once the job is `ready`; the server retains only its hash.
 */
export const exportRequestResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    status: exportStatusSchema,
    /** The raw download token — shown once; only its hash is persisted. */
    downloadToken: z.string().min(1),
  })
  .strict();
export type ExportRequestResponse = z.infer<typeof exportRequestResponseSchema>;

/** `GET /account/export/download?token=` query — the raw download token. */
export const exportDownloadQuerySchema = z.object({ token: z.string().min(1).max(200) }).strict();
export type ExportDownloadQuery = z.infer<typeof exportDownloadQuerySchema>;

// --- Telegram + Discord channels (§13.4 V4-P10) ----------------------------
//
// Two additive NotificationChannels the user configures per-account. The bot
// token is server-side / env-gated (Telegram); the Discord webhook URL is
// per-user, stored encrypted at rest. Both surface as extra matrix columns
// through `channels.telegram`/`channels.discord` in the notifications response.

/** Cap on the raw link-code characters returned by `/settings/telegram/link`. */
export const TELEGRAM_LINK_CODE_MAX = 24;

/**
 * `GET /settings/telegram` — the caller's Telegram link state.
 *  - `available` = deployment has the bot token configured (matrix column
 *    lights up); `null` in every other field when false.
 *  - `linked` = a chat is confirmed for the caller (`chatId` present, no
 *    pending code). The chatId is masked (last 4 digits) — the full value is
 *    never returned to the browser.
 *  - `pending` = a link code is issued and unused; `expiresAt` is set.
 *  - `botUsername` powers the deep link (`https://t.me/<bot>?start=<code>`).
 */
export const telegramSettingsResponseSchema = z
  .object({
    available: z.boolean(),
    linked: z.boolean(),
    pending: z.boolean(),
    /** Masked chat id (`…1234`) once linked; null otherwise. */
    chatIdMasked: z.string().nullable(),
    /** Bot @username served with the response so the SPA builds the deep link. */
    botUsername: z.string().nullable(),
    /** Raw code visible on the response of a link-start; else null. */
    pendingCode: z.string().max(TELEGRAM_LINK_CODE_MAX).nullable(),
    /** ISO datetime the pending code expires; null when there is no pending. */
    pendingExpiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type TelegramSettingsResponse = z.infer<typeof telegramSettingsResponseSchema>;

/**
 * `POST /settings/telegram/link` — issue a fresh single-use link code + expiry;
 * response carries the same shape as `GET /settings/telegram`, so the caller
 * immediately has the deep link's `start` parameter. An existing pending code
 * is replaced (short expiry, single use so idempotency is fine).
 */
export type TelegramLinkResponse = TelegramSettingsResponse;

/**
 * `POST /settings/telegram/confirm` — the SPA polls (or the user clicks
 * "I've started the bot") to check whether the bot has received `/start
 * <code>` yet. On success, transitions from `pending` → `linked`.
 */
export const telegramConfirmResponseSchema = z
  .object({
    linked: z.boolean(),
    settings: telegramSettingsResponseSchema,
  })
  .strict();
export type TelegramConfirmResponse = z.infer<typeof telegramConfirmResponseSchema>;

/**
 * `POST /settings/discord/webhook` body — a candidate Discord webhook URL that
 * MUST match the standard `discord(app)?.com/api/webhooks/...` shape. The
 * handler additionally sends a live test message and rejects on any non-2xx
 * from Discord (so a mistyped or stale URL never persists).
 */
export const discordWebhookRequestSchema = z
  .object({
    /** Raw webhook URL — refined below to keep the error UX clean. */
    url: z.string().min(1).max(2048),
  })
  .strict()
  .superRefine((body, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_url' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_scheme' });
      return;
    }
    const host = parsed.host.toLowerCase();
    const validHost =
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host === 'canary.discord.com' ||
      host === 'ptb.discord.com';
    if (!validHost) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_host' });
      return;
    }
    if (!parsed.pathname.startsWith('/api/webhooks/')) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_path' });
    }
  });
export type DiscordWebhookRequest = z.infer<typeof discordWebhookRequestSchema>;

/**
 * `GET /settings/discord` — the caller's Discord webhook state. The URL is
 * NEVER returned to the browser (it is a secret); only whether one is
 * configured and a short label (`configuredAt` + a `webhookIdMasked` for the
 * user to recognize it) surface. `available` mirrors `linked` here — a webhook
 * either exists or the channel is unavailable to this account.
 */
export const discordSettingsResponseSchema = z
  .object({
    available: z.boolean(),
    linked: z.boolean(),
    /** Masked webhook id (`…abcd`) once configured; null otherwise. */
    webhookIdMasked: z.string().nullable(),
    /** ISO datetime the webhook was saved; null otherwise. */
    configuredAt: z.string().datetime().nullable(),
  })
  .strict();
export type DiscordSettingsResponse = z.infer<typeof discordSettingsResponseSchema>;

/**
 * `POST /settings/discord/test` — dispatch a diagnostic message via the saved
 * webhook. The handler returns `{ ok: true }` when Discord accepts the send;
 * anything else is a 4xx with an i18n'd reason (`no_webhook` when the caller
 * has none, `send_failed` when Discord rejected).
 */
export const discordTestResponseSchema = z.object({ ok: z.boolean() }).strict();
export type DiscordTestResponse = z.infer<typeof discordTestResponseSchema>;
