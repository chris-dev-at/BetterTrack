import { z } from 'zod';

import { NOTIFICATION_TYPES, type NotificationType } from './notifications';
import { portfolioVisibilitySchema } from './portfolio';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8). The
 * `GET/PATCH /settings/notifications` surface exposes a **per-type × channel
 * matrix**: each V1 notification type (`friend.request`, `friend.accepted`,
 * `portfolio.shared`, `account.invite`, `account.temp_password`) can be routed
 * independently to the **in-app bell**, **email**, both, or neither (muted).
 *
 * V1 ships two channels: **in-app** and **email**, each defaulting to *on* for a
 * type that has no override. The stored overrides live in the existing
 * `notification_settings.config` jsonb column (per (userId, channel) row), so this
 * surface needs no schema migration. The other `notification_channel` values
 * (telegram, discord) are post-v1 and not represented here.
 */

/** The V1 user-toggleable notification channels (matrix columns). */
export const NOTIFICATION_SETTING_CHANNELS = ['inapp', 'email'] as const;
export type NotificationSettingChannel = (typeof NOTIFICATION_SETTING_CHANNELS)[number];

/**
 * One notification type's routing: whether it reaches the in-app bell and/or
 * email. `{ inapp: true, email: true }` = both; `{ inapp: false, email: false }` =
 * muted; the mixed forms are bell-only / email-only.
 */
export const notificationTypeRoutingSchema = z
  .object({ inapp: z.boolean(), email: z.boolean() })
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
 * `GET /settings/notifications` response — the session user's full type × channel
 * matrix. Every type is present; a type with no stored override reads at the
 * channel default (in-app on, email on).
 */
export const notificationSettingsResponseSchema = z
  .object({ matrix: notificationMatrixSchema })
  .strict();
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponseSchema>;

/**
 * `PATCH /settings/notifications` body — a partial matrix; only the supplied types
 * are updated and at least one type is required. Each supplied type carries its
 * full routing (`inapp` + `email`).
 */
export const updateNotificationSettingsRequestSchema = z
  .object({ matrix: z.object(partialMatrixShape).strict() })
  .strict()
  .refine((body) => Object.keys(body.matrix).length > 0, {
    message: 'At least one notification type is required.',
  });
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;

// --- Account settings (§6.9, §6.11, §13.2 V2-P9) ---------------------------

/**
 * Settings → Account defaults (§6.9, V2-P9). Currently one field: the
 * **default portfolio visibility** applied when a new portfolio is created —
 * `private` (default) or `friends` (all of my friends). "Selected friends" is
 * future work; the enum is the shared two-value visibility so it can extend
 * later. Changing this only affects the *default* at creation time: existing
 * portfolios and explicit per-item toggles are untouched.
 */
export const accountSettingsResponseSchema = z
  .object({ defaultPortfolioVisibility: portfolioVisibilitySchema })
  .strict();
export type AccountSettingsResponse = z.infer<typeof accountSettingsResponseSchema>;

/** `PATCH /settings/account` body — update the default portfolio visibility. */
export const updateAccountSettingsRequestSchema = z
  .object({ defaultPortfolioVisibility: portfolioVisibilitySchema })
  .strict();
export type UpdateAccountSettingsRequest = z.infer<typeof updateAccountSettingsRequestSchema>;
