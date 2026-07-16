import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SECURITY_NOTIFICATION_TYPES,
  DEVICE_PLATFORMS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  isAccountSecurityNotificationType,
  notificationChannelDefaultEnabled,
  registerDeviceRequestSchema,
  webPushSubscribeRequestSchema,
} from './notifications';
import { NOTIFICATION_SETTING_CHANNELS, notificationSettingsResponseSchema } from './settings';

describe('notification taxonomy (#368)', () => {
  it('every canonical type appears in exactly one settings-grid category', () => {
    const grouped = NOTIFICATION_CATEGORIES.flatMap((c) => c.types);
    expect([...grouped].sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('pins the canonical strings shared with the mobile push client', () => {
    // These exact strings ride every FCM data message (`type`) and the mobile
    // repo's PUSH_NOTIFICATIONS_FOR_PLATFORM.md mirrors them — renaming one is
    // a cross-repo breaking change, never a refactor.
    expect(NOTIFICATION_TYPES).toEqual([
      'friend.request',
      'friend.accepted',
      'portfolio.shared',
      'watchlist.shared',
      'conglomerate.shared',
      'friend.activity',
      'follow.published',
      'follow.alert.created',
      'follow.alert.fired',
      'account.invite',
      'account.temp_password',
      'account.data_export',
      'alert.triggered',
      'chat.message',
    ]);
    expect(NOTIFICATION_SETTING_CHANNELS).toEqual([
      'inapp',
      'email',
      'telegram',
      'discord',
      'push',
      'webpush',
    ]);
    expect(DEVICE_PLATFORMS).toEqual(['android', 'ios', 'web']);
  });
});

describe('lean email defaults (V4-P0c)', () => {
  it('the account/security set is exactly the `account` category', () => {
    const accountCategory = NOTIFICATION_CATEGORIES.find((c) => c.key === 'account');
    expect([...ACCOUNT_SECURITY_NOTIFICATION_TYPES].sort()).toEqual(
      [...(accountCategory?.types ?? [])].sort(),
    );
    for (const type of ACCOUNT_SECURITY_NOTIFICATION_TYPES) {
      expect(isAccountSecurityNotificationType(type)).toBe(true);
    }
  });

  it('email defaults ON only for account/security; other channels default ON for every type', () => {
    for (const type of NOTIFICATION_TYPES) {
      const accountSecurity = isAccountSecurityNotificationType(type);
      expect(notificationChannelDefaultEnabled('email', type)).toBe(accountSecurity);
      expect(notificationChannelDefaultEnabled('inapp', type)).toBe(true);
      expect(notificationChannelDefaultEnabled('push', type)).toBe(true);
      expect(notificationChannelDefaultEnabled('webpush', type)).toBe(true);
      // V4-P10: telegram + discord follow the same "on once configured" rule.
      expect(notificationChannelDefaultEnabled('telegram', type)).toBe(true);
      expect(notificationChannelDefaultEnabled('discord', type)).toBe(true);
    }
  });
});

describe('push registration schemas (#368)', () => {
  it('accepts a device registration and rejects unknown platforms', () => {
    expect(
      registerDeviceRequestSchema.safeParse({ token: 'fcm-tok', platform: 'android' }).success,
    ).toBe(true);
    expect(
      registerDeviceRequestSchema.safeParse({ token: 'fcm-tok', platform: 'palm' }).success,
    ).toBe(false);
    expect(registerDeviceRequestSchema.safeParse({ platform: 'android' }).success).toBe(false);
  });

  it('accepts a standard PushSubscription transport triple', () => {
    const parsed = webPushSubscribeRequestSchema.safeParse({
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: 'k1', auth: 'k2' },
    });
    expect(parsed.success).toBe(true);
    expect(
      webPushSubscribeRequestSchema.safeParse({ endpoint: 'not-a-url', keys: {} }).success,
    ).toBe(false);
  });
});

describe('settings response shape (#368)', () => {
  it('carries the full matrix + mute + channel availability + VAPID key', () => {
    const matrix = Object.fromEntries(
      NOTIFICATION_TYPES.map((t) => [
        t,
        {
          inapp: true,
          email: true,
          telegram: true,
          discord: true,
          push: true,
          webpush: true,
        },
      ]),
    );
    const channels = {
      inapp: true,
      email: true,
      telegram: false,
      discord: false,
      push: false,
      webpush: false,
    };
    const parsed = notificationSettingsResponseSchema.safeParse({
      matrix,
      muted: false,
      channels,
      webPushPublicKey: null,
    });
    expect(parsed.success).toBe(true);
    // A missing type or channel flag is a contract break, not a default.
    const { ['chat.message']: _dropped, ...incomplete } = matrix;
    expect(
      notificationSettingsResponseSchema.safeParse({
        matrix: incomplete,
        muted: false,
        channels,
        webPushPublicKey: null,
      }).success,
    ).toBe(false);
  });
});
