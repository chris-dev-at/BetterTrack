import {
  createDeviceTokenRepository,
  type DeviceTokenRepository,
} from '../../data/repositories/deviceTokenRepository';
import {
  createDiscordWebhookRepository,
  type DiscordWebhookRepository,
} from '../../data/repositories/discordWebhookRepository';
import {
  createPushSubscriptionRepository,
  type PushSubscriptionRepository,
} from '../../data/repositories/pushSubscriptionRepository';
import {
  createTelegramLinkRepository,
  type TelegramLinkRepository,
} from '../../data/repositories/telegramLinkRepository';
import type { Database } from '../../data/db';
import type { AppConfig } from '../../config/env';
import type { Logger } from '../../logger';

import { createDiscordChannel, type DiscordChannel } from './discordChannel';
import { createFcmChannel, type FcmChannel } from './fcm';
import { createTelegramChannel, type TelegramChannel } from './telegramChannel';
import { createWebPushChannel, type WebPushChannel } from './webPush';

/**
 * The ONE place the outbound notification channels are built (#1723).
 *
 * Two processes run a notification dispatcher: the API (synchronous test
 * delivery + boot-time channel reporting) and the WORKER (the authoritative
 * `notifications.dispatch` consumer). Before this factory each assembled its
 * own channel list, and they drifted: the worker never built Telegram or
 * Discord, so with the V5-P0 kill-switch flipped ON every Telegram and Discord
 * notification was silently dropped in production — the dispatcher's
 * `routing.telegram && telegram` guard saw `undefined`.
 *
 * Building the set here makes that class of drift a compile error: a new
 * channel added to {@link NotificationChannelSet} lands in both entry points at
 * once, and `__tests__/liveDeployTopology.test.ts` asserts the two dispatcher
 * calls still receive the same dependency set.
 *
 * The per-channel repositories come back with the channels because the API also
 * needs them for the settings surfaces (device registration, webhook CRUD, the
 * Telegram link handshake) — building them twice would open a second, quieter
 * drift seam.
 */
export interface NotificationChannelSet {
  devices: DeviceTokenRepository;
  subscriptions: PushSubscriptionRepository;
  telegramLinks: TelegramLinkRepository;
  discordWebhooks: DiscordWebhookRepository;
  /** Null when the FCM service-account file is unset/unloadable (§11, #421). */
  fcm: FcmChannel | null;
  /** Null when `BT_VAPID_*` is unset (§11, #421). */
  webPush: WebPushChannel | null;
  /** Null when the V5-P0 kill-switch is OFF or the bot token is unset. */
  telegram: TelegramChannel | null;
  /** Null when the V5-P0 kill-switch is OFF (per-user webhook rows survive). */
  discord: DiscordChannel | null;
}

export interface CreateNotificationChannelSetDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
}

export function createNotificationChannelSet(
  deps: CreateNotificationChannelSetDeps,
): NotificationChannelSet {
  const { db, config, logger } = deps;

  const devices = createDeviceTokenRepository(db);
  const subscriptions = createPushSubscriptionRepository(db);
  // V4-P10 additive channels: Telegram (per-user chat link, bot token in env)
  // and Discord (per-user webhook URL, encrypted at rest via secretBox).
  const telegramLinks = createTelegramLinkRepository(db);
  const discordWebhooks = createDiscordWebhookRepository(db);

  // Push channels, env-gated (#421): null = unconfigured/unloadable (one warn
  // log inside the factory). The nulls also drive the settings surface's
  // channel-availability report, so the UI can only offer live columns.
  const fcm = createFcmChannel({
    serviceAccountFile: config.push.fcmServiceAccountFile,
    devices,
    logger,
  });
  const webPush = createWebPushChannel({
    vapid: config.webPush,
    subscriptions,
    logger,
  });
  // Telegram channel (V4-P10, V5-P0 kill-switch): null when the global env
  // kill-switch is OFF or BT_TELEGRAM_BOT_TOKEN is unset — the matrix column
  // stays hidden, the setup routes 404, and the dispatcher skips the channel
  // entirely. Existing rows are preserved for a later re-enable.
  const telegram = config.telegram.enabled
    ? createTelegramChannel({
        botToken: config.telegram.botToken,
        links: telegramLinks,
        logger,
      })
    : null;
  // Discord channel (V4-P10, V5-P0 kill-switch): null when the global env
  // kill-switch is OFF — same treatment as Telegram, per-user webhook rows are
  // preserved so a flip-back restores them.
  const discord = config.discord.enabled
    ? createDiscordChannel({
        webhooks: discordWebhooks,
        encryptionKey: config.recordEncryption,
        logger,
      })
    : null;

  return {
    devices,
    subscriptions,
    telegramLinks,
    discordWebhooks,
    fcm,
    webPush,
    telegram,
    discord,
  };
}
