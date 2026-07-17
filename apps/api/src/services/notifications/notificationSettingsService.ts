import {
  NOTIFICATION_TYPES,
  notificationChannelDefaultEnabled,
  type NotificationChannelsConfigurable,
  type NotificationMatrix,
  type NotificationSettingsResponse,
  type NotificationType,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import type {
  NotificationChannel,
  NotificationRepository,
} from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11; #368
 * Notifications v2). Reads and writes the per-user **per-type × channel**
 * matrix the dispatcher honors — four channels now: in-app bell, email, phone
 * push (FCM), browser push (web-push) — plus the global mute flag, for the
 * `GET/PATCH /settings/notifications` surface.
 *
 * §6.10 defaults, enforced here rather than in the schema (V4-P0c lean email
 * defaults, §16):
 *  - **In-app / push / web-push default on; email defaults on ONLY for the
 *    account/security category** ({@link notificationChannelDefaultEnabled}). A
 *    type with no stored override resolves to that per-(channel, type) default;
 *    only explicit overrides (or mute / a channel master-off) change delivery.
 *  - **Overrides live in `notification_settings.config`** (jsonb), one map per
 *    (userId, channel) row — additive for the two new channels, no migration of
 *    existing rows.
 *  - **Channel availability is deployment truth**, not user state: the response
 *    reports which channels the server can actually deliver on (SMTP / FCM key /
 *    VAPID keys) so the UI renders only live columns; cells persist regardless.
 *
 * Every read/write is `user_id`-scoped through the repositories (§10).
 */

export interface NotificationSettingsServiceDeps {
  repo: NotificationRepository;
  /** Global-mute storage (users.notifications_muted, #368). */
  users: Pick<UserRepository, 'findById' | 'setNotificationsMuted'>;
  /**
   * Which channels this deployment has configured. `email`/`push`/`webpush`
   * are deployment-scoped booleans (SMTP / FCM key / VAPID); `telegram` +
   * `discord` are **per-user** — a linked chat or a saved webhook — so those
   * two resolve to a lookup, keeping the settings surface honest about what
   * the caller can actually route on.
   */
  channelAvailability: {
    email: boolean;
    push: boolean;
    webpush: boolean;
    telegramFor: (userId: string) => Promise<boolean>;
    discordFor: (userId: string) => Promise<boolean>;
  };
  /**
   * Deployment-level "is this channel offered at all by this build?" for the
   * V4-P10 additive channels (V5-P0 kill-switch). Flipped OFF hides the setup
   * cards without probing the setup endpoints — the SPA reads this from the
   * settings response and skips rendering them.
   */
  channelsConfigurable: NotificationChannelsConfigurable;
  /** The VAPID public key the SPA needs to subscribe, when webpush is live. */
  webPushPublicKey: string | null;
}

export interface NotificationSettingsService {
  get(userId: string): Promise<NotificationSettingsResponse>;
  update(
    userId: string,
    body: UpdateNotificationSettingsRequest,
  ): Promise<NotificationSettingsResponse>;
}

const MATRIX_CHANNELS = ['inapp', 'email', 'telegram', 'discord', 'push', 'webpush'] as const;

export function createNotificationSettingsService(
  deps: NotificationSettingsServiceDeps,
): NotificationSettingsService {
  const { repo, users, channelAvailability, channelsConfigurable, webPushPublicKey } = deps;

  /**
   * Resolve one channel's effective state for a type from the stored channel
   * state, applying §6.10 precedence (V4-P0c): an explicit per-type override
   * wins; else a channel master-off (`enabled: false`) forces off; else the
   * per-(channel, type) default ({@link notificationChannelDefaultEnabled} —
   * email on only for account/security, every other channel on).
   */
  function effective(
    channel: 'inapp' | 'email' | 'telegram' | 'discord' | 'push' | 'webpush',
    state: { enabled: boolean; overrides: Record<string, boolean> } | undefined,
    type: NotificationType,
  ): boolean {
    const fallback = notificationChannelDefaultEnabled(channel, type);
    if (!state) return fallback;
    const override = state.overrides[type];
    if (typeof override === 'boolean') return override;
    return state.enabled ? fallback : false;
  }

  async function read(userId: string): Promise<NotificationSettingsResponse> {
    const [states, user] = await Promise.all([
      repo.channelStatesForUser(userId),
      users.findById(userId),
    ]);
    // The Telegram + Discord availability flags are per-user (linked chat /
    // saved webhook) — resolved from deps so the settings response reflects
    // both deployment env AND the caller's own setup.
    const [telegramAvailable, discordAvailable] = await Promise.all([
      channelAvailability.telegramFor(userId),
      channelAvailability.discordFor(userId),
    ]);
    const matrix = Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [
        type,
        {
          inapp: effective('inapp', states.inapp, type),
          email: effective('email', states.email, type),
          telegram: effective('telegram', states.telegram, type),
          discord: effective('discord', states.discord, type),
          push: effective('push', states.push, type),
          webpush: effective('webpush', states.webpush, type),
        },
      ]),
    ) as NotificationMatrix;
    return {
      matrix,
      muted: user?.notificationsMuted ?? false,
      channels: {
        inapp: true,
        email: channelAvailability.email,
        telegram: telegramAvailable,
        discord: discordAvailable,
        push: channelAvailability.push,
        webpush: channelAvailability.webpush,
      },
      channelsConfigurable,
      webPushPublicKey: channelAvailability.webpush ? webPushPublicKey : null,
    };
  }

  return {
    get: read,

    async update(userId, body) {
      // Split the partial matrix into per-channel override maps, then merge each
      // into the channel's `config` jsonb (other types + the row's channel-wide
      // flag are preserved by the repository).
      const overridesByChannel: Partial<Record<NotificationChannel, Record<string, boolean>>> = {};
      for (const [type, routing] of Object.entries(body.matrix ?? {})) {
        if (!routing) continue;
        for (const channel of MATRIX_CHANNELS) {
          (overridesByChannel[channel] ??= {})[type] = routing[channel];
        }
      }
      for (const channel of MATRIX_CHANNELS) {
        const overrides = overridesByChannel[channel];
        if (overrides && Object.keys(overrides).length > 0) {
          await repo.upsertChannelConfig(userId, channel, overrides);
        }
      }
      if (body.muted !== undefined) {
        await users.setNotificationsMuted(userId, body.muted);
      }
      return read(userId);
    },
  };
}
