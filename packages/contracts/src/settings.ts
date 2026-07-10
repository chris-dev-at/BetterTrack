import { z } from 'zod';

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
export const NOTIFICATION_SETTING_CHANNELS = ['inapp', 'email', 'push', 'webpush'] as const;
export type NotificationSettingChannel = (typeof NOTIFICATION_SETTING_CHANNELS)[number];

/**
 * One notification type's routing: which channels it fans out to. All-false =
 * muted for that type.
 */
export const notificationTypeRoutingSchema = z
  .object({ inapp: z.boolean(), email: z.boolean(), push: z.boolean(), webpush: z.boolean() })
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
 * true; the rest reflect server config (SMTP / FCM service account / VAPID).
 */
export const notificationChannelAvailabilitySchema = z
  .object({ inapp: z.boolean(), email: z.boolean(), push: z.boolean(), webpush: z.boolean() })
  .strict();
export type NotificationChannelAvailability = z.infer<typeof notificationChannelAvailabilitySchema>;

/**
 * `GET /settings/notifications` response — the session user's full type × channel
 * matrix (every type present, defaults applied), the global-mute flag, which
 * channels this deployment has configured, and — when browser push is live —
 * the VAPID public key the SPA needs for `PushManager.subscribe`.
 */
export const notificationSettingsResponseSchema = z
  .object({
    matrix: notificationMatrixSchema,
    muted: z.boolean(),
    channels: notificationChannelAvailabilitySchema,
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
