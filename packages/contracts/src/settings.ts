import { z } from 'zod';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8). The
 * `GET/PATCH /settings/notifications` surface exposes the per-channel toggles the
 * dispatcher honors. V1 ships two channels: **in-app** (always on — cannot be
 * disabled) and **email** (on by default). The other `notification_channel`
 * values (telegram, discord, push) are post-v1 and not toggleable here.
 */

/** The V1 user-toggleable notification channels. */
export const NOTIFICATION_SETTING_CHANNELS = ['inapp', 'email'] as const;
export type NotificationSettingChannel = (typeof NOTIFICATION_SETTING_CHANNELS)[number];

/** One channel's state as read/written by the settings API. */
export const notificationChannelStateSchema = z.object({ enabled: z.boolean() }).strict();
export type NotificationChannelState = z.infer<typeof notificationChannelStateSchema>;

/**
 * `GET /settings/notifications` response — the session user's per-channel state.
 * `inapp.enabled` is always `true` (§6.10); `email.enabled` reflects the user's
 * row, defaulting to `true` when no row exists.
 */
export const notificationSettingsResponseSchema = z
  .object({
    inapp: notificationChannelStateSchema,
    email: notificationChannelStateSchema,
  })
  .strict();
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponseSchema>;

/**
 * `PATCH /settings/notifications` body — partial per-channel toggles; at least one
 * channel is required. Passing `inapp` is accepted but ignored: in-app is always
 * on and cannot be disabled (§6.10).
 */
export const updateNotificationSettingsRequestSchema = z
  .object({
    inapp: notificationChannelStateSchema.optional(),
    email: notificationChannelStateSchema.optional(),
  })
  .strict()
  .refine((body) => body.inapp !== undefined || body.email !== undefined, {
    message: 'At least one channel toggle is required.',
  });
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;
