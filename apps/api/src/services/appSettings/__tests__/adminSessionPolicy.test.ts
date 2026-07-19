import { beforeEach, describe, expect, it } from 'vitest';

import type { AppSettingRow } from '../../../data/schema';
import type { AppSettingsRepository } from '../../../data/repositories/appSettingsRepository';
import { ADMIN_SESSION_LIFETIME_HOURS_KEY, createAppSettingsService } from '../appSettingsService';

/**
 * Unit coverage for the admin session lifetime resolution (§13.5 V5-P13c): the
 * env fallback and any stored value are CLAMPED to the plan's 6–24 h window on
 * read, so a bad env or a drifted stored row can never widen the window.
 */
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
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      store.set(key, row);
      return row;
    },
  } as AppSettingsRepository;
}

describe('admin session lifetime resolution (§13.5 V5-P13c)', () => {
  let repo: AppSettingsRepository;

  beforeEach(() => {
    repo = fakeRepo();
  });

  it('falls back to the env default when nothing is stored', async () => {
    const svc = createAppSettingsService({ repo, adminSessionLifetimeDefaultHours: 12 });
    const policy = await svc.getAdminSessionPolicy();
    expect(policy.sessionLifetimeHours).toBe(12);
    expect(policy.updatedAt).toBeNull();
    expect(policy.updatedBy).toBeNull();
  });

  it('clamps an out-of-window env default to the 6–24 h window', async () => {
    expect(
      await createAppSettingsService({
        repo,
        adminSessionLifetimeDefaultHours: 100,
      }).getAdminSessionLifetimeHours(),
    ).toBe(24);
    expect(
      await createAppSettingsService({
        repo: fakeRepo(),
        adminSessionLifetimeDefaultHours: 1,
      }).getAdminSessionLifetimeHours(),
    ).toBe(6);
  });

  it('clamps a stored value that drifted outside the window', async () => {
    const svc = createAppSettingsService({ repo, adminSessionLifetimeDefaultHours: 12 });
    await repo.upsert(ADMIN_SESSION_LIFETIME_HOURS_KEY, 999, 'admin-1');
    expect(await svc.getAdminSessionLifetimeHours()).toBe(24);
  });

  it('setAdminSessionLifetimeHours clamps before persisting and records the actor', async () => {
    const svc = createAppSettingsService({ repo, adminSessionLifetimeDefaultHours: 12 });
    const policy = await svc.setAdminSessionLifetimeHours(8, 'admin-1');
    expect(policy.sessionLifetimeHours).toBe(8);
    expect(policy.updatedBy).toBe('admin-1');
    expect(policy.updatedAt).not.toBeNull();
    // A stored, in-range value is echoed back verbatim.
    expect(await svc.getAdminSessionLifetimeHours()).toBe(8);
  });
});
