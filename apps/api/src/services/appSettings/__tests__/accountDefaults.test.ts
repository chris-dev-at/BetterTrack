import { describe, expect, it } from 'vitest';

import { NOTIFICATION_TYPES } from '@bettertrack/contracts';

import type { AppSettingsRepository } from '../../../data/repositories/appSettingsRepository';
import type { AppSettingRow } from '../../../data/schema';
import {
  ACCOUNT_DEFAULT_NOTIFICATION_MATRIX_KEY,
  createAppSettingsService,
  leanDefaultNotificationMatrix,
} from '../appSettingsService';

function fakeRepo(): AppSettingsRepository {
  const store = new Map<string, AppSettingRow>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async getAll() {
      return [...store.values()];
    },
    async upsert(key, value, updatedBy) {
      const row: AppSettingRow = {
        key,
        value,
        updatedBy,
        updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      };
      store.set(key, row);
      return row;
    },
  } as AppSettingsRepository;
}

describe('account-default notification matrix upgrades', () => {
  it('preserves legacy choices and fills newly introduced notification rows', async () => {
    const defaults = leanDefaultNotificationMatrix();
    const legacyMatrix = Object.fromEntries(
      Object.entries(defaults).filter(([type]) => !type.startsWith('feedback.')),
    ) as Record<string, unknown>;
    legacyMatrix['friend.request'] = {
      ...defaults['friend.request'],
      inapp: false,
      email: true,
    };
    expect(Object.keys(legacyMatrix)).toHaveLength(NOTIFICATION_TYPES.length - 2);

    const repo = fakeRepo();
    await repo.upsert(ACCOUNT_DEFAULT_NOTIFICATION_MATRIX_KEY, legacyMatrix, 'admin-1');
    const resolved = await createAppSettingsService({
      repo,
      adminSessionLifetimeDefaultHours: 12,
    }).getAccountDefaults();

    expect(resolved.notificationMatrix['friend.request']).toEqual({
      ...defaults['friend.request'],
      inapp: false,
      email: true,
    });
    expect(resolved.notificationMatrix['feedback.status_changed']).toEqual(
      defaults['feedback.status_changed'],
    );
    expect(resolved.notificationMatrix['feedback.reply_created']).toEqual(
      defaults['feedback.reply_created'],
    );
  });
});
