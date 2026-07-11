import { describe, expect, it } from 'vitest';

import {
  DEVICE_PLATFORMS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
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
      'account.invite',
      'account.temp_password',
      'alert.triggered',
      'chat.message',
    ]);
    expect(NOTIFICATION_SETTING_CHANNELS).toEqual(['inapp', 'email', 'push', 'webpush']);
    expect(DEVICE_PLATFORMS).toEqual(['android', 'ios', 'web']);
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
      NOTIFICATION_TYPES.map((t) => [t, { inapp: true, email: true, push: true, webpush: true }]),
    );
    const parsed = notificationSettingsResponseSchema.safeParse({
      matrix,
      muted: false,
      channels: { inapp: true, email: true, push: false, webpush: false },
      webPushPublicKey: null,
    });
    expect(parsed.success).toBe(true);
    // A missing type or channel flag is a contract break, not a default.
    const { ['chat.message']: _dropped, ...incomplete } = matrix;
    expect(
      notificationSettingsResponseSchema.safeParse({
        matrix: incomplete,
        muted: false,
        channels: { inapp: true, email: true, push: false, webpush: false },
        webPushPublicKey: null,
      }).success,
    ).toBe(false);
  });
});
