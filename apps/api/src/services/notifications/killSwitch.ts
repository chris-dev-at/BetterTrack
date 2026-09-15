import {
  NOTIFICATION_TYPES,
  type NotificationChannelsConfigurable,
  type NotificationMatrix,
  type NotificationType,
  type NotificationTypeRouting,
} from '@bettertrack/contracts';

import type { TypeRouting } from '../../data/repositories/notificationRepository';

/**
 * The V5-P0 kill-switch, applied to the notification MATRIX (§13.5 V5-P0 (b),
 * #1795).
 *
 * `BT_TELEGRAM_DISCORD_ENABLED` deactivates Telegram + Discord: the setup
 * routes refuse, no channel object is built, nothing is ever delivered. The
 * matrix used to be exempt from that boundary — `GET` reported cells for both
 * channels and `PATCH` persisted overrides for them, so a caller could route a
 * type to a channel this build refuses to expose and end up with a type that
 * has no live destination at all.
 *
 * ONE rule, applied by every surface that reads or writes a matrix (user
 * settings and admin account-defaults):
 *  - **Read masks**: a deactivated channel's cells report `false`, so the
 *    response says exactly what the deployment will do.
 *  - **Write preserves**: an incoming cell for a deactivated channel never
 *    reaches storage — the STORED value survives untouched, so flipping the env
 *    back ON restores the user's (or the admin's) original routing. Deactivate,
 *    not delete, extends to the matrix.
 * The admin surface additionally REFUSES an explicit `true` (below), because an
 * admin seeding new-account defaults for a channel the build does not expose is
 * a mistake worth naming rather than silently dropping; the per-user surface
 * drops silently because the SPA round-trips the whole matrix on every toggle.
 */

/**
 * Which of the deactivatable channels this deployment can actually deliver on —
 * `config.telegram.enabled` / `config.discord.enabled`, i.e. exactly the
 * channels `createNotificationChannelSet` built a channel object for.
 */
export interface OfferedChannels {
  telegram: boolean;
  discord: boolean;
}

/**
 * Whether a type's routing still reaches SOMETHING in this deployment (#1795).
 *
 * The market-intel notify gates ask this before doing a scan's provider work:
 * counting a deactivated channel as "the user wants this type" spends the whole
 * scan on a notification that cannot be delivered — and, before the dispatcher's
 * rule above, permanently consumed the event on arrival.
 */
export function routingHasLiveChannel(routing: TypeRouting, offered: OfferedChannels): boolean {
  return (
    routing.inapp ||
    routing.email ||
    routing.push ||
    routing.webpush ||
    (routing.telegram && offered.telegram) ||
    (routing.discord && offered.discord)
  );
}

/** The two additive channels the kill-switch can deactivate (§6.10 V4-P10). */
export const DEACTIVATABLE_CHANNELS = ['telegram', 'discord'] as const;
export type DeactivatableChannel = (typeof DEACTIVATABLE_CHANNELS)[number];

/** The channels this build does NOT expose, per the deployment's flags. */
export function deactivatedChannels(
  configurable: NotificationChannelsConfigurable,
): DeactivatableChannel[] {
  return DEACTIVATABLE_CHANNELS.filter((channel) => !configurable[channel]);
}

/** Whether a matrix cell may be read/written for this channel at all. */
export function channelIsOffered(
  channel: string,
  configurable: NotificationChannelsConfigurable,
): boolean {
  return !(DEACTIVATABLE_CHANNELS as readonly string[]).includes(channel)
    ? true
    : configurable[channel as DeactivatableChannel];
}

/** Report a deactivated channel's cells as `false`, leaving storage untouched. */
export function maskMatrix(
  matrix: NotificationMatrix,
  configurable: NotificationChannelsConfigurable,
): NotificationMatrix {
  const dead = deactivatedChannels(configurable);
  if (dead.length === 0) return matrix;
  const masked = Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => {
      const routing = matrix[type];
      const patched: NotificationTypeRouting = { ...routing };
      for (const channel of dead) patched[channel] = false;
      return [type, patched];
    }),
  ) as NotificationMatrix;
  return masked;
}

/**
 * The deactivated channels an incoming (possibly partial) matrix tries to turn
 * ON. `false` cells are not offenders: the admin UI hides the columns and
 * round-trips the server's own masked `false` values, and refusing those would
 * break every legitimate save.
 */
export function deactivatedChannelsRequested(
  matrix: Partial<Record<NotificationType, NotificationTypeRouting | undefined>>,
  configurable: NotificationChannelsConfigurable,
): DeactivatableChannel[] {
  const dead = deactivatedChannels(configurable);
  return dead.filter((channel) =>
    Object.values(matrix).some((routing) => routing?.[channel] === true),
  );
}

/**
 * Merge an incoming full matrix over the stored one while keeping every
 * deactivated channel's STORED cells — the write half of the rule above.
 */
export function preserveDeactivatedCells(
  incoming: NotificationMatrix,
  stored: NotificationMatrix,
  configurable: NotificationChannelsConfigurable,
): NotificationMatrix {
  const dead = deactivatedChannels(configurable);
  if (dead.length === 0) return incoming;
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => {
      const patched: NotificationTypeRouting = { ...incoming[type] };
      for (const channel of dead) patched[channel] = stored[type][channel];
      return [type, patched];
    }),
  ) as NotificationMatrix;
}
