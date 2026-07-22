import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SECURITY_NOTIFICATION_TYPES,
  DEVICE_PLATFORMS,
  DEFAULT_QUIET_HOURS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  OPT_IN_NOTIFICATION_TYPES,
  isAccountSecurityNotificationType,
  isOptInNotificationType,
  isUrgentNotification,
  notificationChannelDefaultEnabled,
  quietHoursSchema,
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
      'earnings.reminder',
      'chat.message',
      'dividend.event',
      'budget.exceeded',
      'mirror.invite',
      'mirror.member_joined',
      'mirror.member_left',
      'mirror.member_removed',
      'mirror.removed',
      'mirror.ownership_transferred',
      'mirror.chain_dissolved',
      'mirror.sync_stalled',
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

  it('email defaults ON only for account/security; other channels default ON for every non-opt-in type', () => {
    for (const type of NOTIFICATION_TYPES) {
      // V5-P5 opt-in types default OFF on every channel — covered separately below.
      if (isOptInNotificationType(type)) continue;
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

describe('opt-in notification types (§13.5 V5-P5)', () => {
  it('the markets category is exactly the opt-in set', () => {
    expect([...OPT_IN_NOTIFICATION_TYPES].sort()).toEqual(['dividend.event', 'earnings.reminder']);
    const marketsCategory = NOTIFICATION_CATEGORIES.find((c) => c.key === 'markets');
    expect([...OPT_IN_NOTIFICATION_TYPES].sort()).toEqual(
      [...(marketsCategory?.types ?? [])].sort(),
    );
  });

  it('an opt-in type defaults OFF on every channel', () => {
    for (const type of OPT_IN_NOTIFICATION_TYPES) {
      expect(isOptInNotificationType(type)).toBe(true);
      for (const channel of NOTIFICATION_SETTING_CHANNELS) {
        expect(notificationChannelDefaultEnabled(channel, type)).toBe(false);
      }
    }
  });

  it('an opt-in type is not urgent (never bypasses quiet hours)', () => {
    for (const type of OPT_IN_NOTIFICATION_TYPES) {
      expect(isUrgentNotification({ type })).toBe(false);
    }
  });
});

describe('MIRRORCHAIN notification group (§13.5 V5-P7, design §11)', () => {
  const MIRROR_TYPES = [
    'mirror.invite',
    'mirror.member_joined',
    'mirror.member_left',
    'mirror.member_removed',
    'mirror.removed',
    'mirror.ownership_transferred',
    'mirror.chain_dissolved',
    'mirror.sync_stalled',
  ];

  it('registers all eight mirror.* types as ONE compact group row (anti-bloat)', () => {
    const group = NOTIFICATION_CATEGORIES.find((c) => c.key === 'mirrorchain');
    expect(group).toBeDefined();
    expect([...(group?.types ?? [])].sort()).toEqual([...MIRROR_TYPES].sort());
  });

  it('defaults in-app ON, email OFF (lean default), not opt-in', () => {
    for (const type of MIRROR_TYPES) {
      expect(isOptInNotificationType(type)).toBe(false);
      expect(isAccountSecurityNotificationType(type)).toBe(false);
      expect(notificationChannelDefaultEnabled('inapp', type)).toBe(true);
      expect(notificationChannelDefaultEnabled('push', type)).toBe(true);
      expect(notificationChannelDefaultEnabled('email', type)).toBe(false);
      // Not urgent — a membership change never bypasses quiet hours.
      expect(isUrgentNotification({ type })).toBe(false);
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
    // V5-P0 kill-switch: the response also carries the deployment-level
    // "offered at all?" flags so the SPA hides the setup cards without probing.
    const channelsConfigurable = { telegram: false, discord: false };
    // V5-P3: a full per-type cadence map ships alongside the matrix.
    const cadence = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, 'instant']));
    // V5-P3 quiet hours: the window/timezone block ships too (off by default).
    const quietHours = { enabled: false, startMinute: 1320, endMinute: 420, timezone: null };
    const parsed = notificationSettingsResponseSchema.safeParse({
      matrix,
      cadence,
      quietHours,
      muted: false,
      channels,
      channelsConfigurable,
      webPushPublicKey: null,
    });
    expect(parsed.success).toBe(true);
    // A missing type or channel flag is a contract break, not a default.
    const { ['chat.message']: _dropped, ...incomplete } = matrix;
    expect(
      notificationSettingsResponseSchema.safeParse({
        matrix: incomplete,
        cadence,
        quietHours,
        muted: false,
        channels,
        channelsConfigurable,
        webPushPublicKey: null,
      }).success,
    ).toBe(false);
  });
});

describe('quiet hours (§13.5 V5-P3)', () => {
  it('defaults are off with a 22:00→07:00 window and no timezone', () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({
      enabled: false,
      startMinute: 1320,
      endMinute: 420,
      timezone: null,
    });
    expect(quietHoursSchema.safeParse(DEFAULT_QUIET_HOURS).success).toBe(true);
  });

  it('accepts a valid IANA timezone and rejects a bogus one', () => {
    expect(
      quietHoursSchema.safeParse({
        enabled: true,
        startMinute: 0,
        endMinute: 1439,
        timezone: 'Europe/Vienna',
      }).success,
    ).toBe(true);
    expect(
      quietHoursSchema.safeParse({
        enabled: true,
        startMinute: 0,
        endMinute: 60,
        timezone: 'Mars/Phobos',
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-range minute boundaries', () => {
    expect(
      quietHoursSchema.safeParse({
        enabled: true,
        startMinute: 1440,
        endMinute: 0,
        timezone: null,
      }).success,
    ).toBe(false);
  });

  it('urgent bypass = account/security types or critical announcements only', () => {
    for (const type of ACCOUNT_SECURITY_NOTIFICATION_TYPES) {
      expect(isUrgentNotification({ type })).toBe(true);
    }
    expect(isUrgentNotification({ type: 'friend.request', announcementSeverity: 'critical' })).toBe(
      true,
    );
    expect(isUrgentNotification({ type: 'alert.triggered' })).toBe(false);
    expect(isUrgentNotification({ type: 'chat.message', announcementSeverity: 'warning' })).toBe(
      false,
    );
  });
});
