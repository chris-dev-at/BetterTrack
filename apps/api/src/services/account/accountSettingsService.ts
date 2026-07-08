import { DEFAULT_LOCALE, type AccountSettingsResponse } from '@bettertrack/contracts';

import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * Settings → Account preferences (PROJECTPLAN.md §6.9, §6.11, §13.2 V2-P9,
 * §13.3 V3-P1). Two fields:
 *  - **default portfolio visibility** applied when a new portfolio is created
 *    (`private` default, or `friends`); changing it only affects the default at
 *    creation time — existing portfolios and explicit per-item toggles are
 *    untouched.
 *  - **locale** — the UI-language preference the SPA reads to switch languages
 *    and that notification emails render in (EN default; §13.3 V3-P1).
 *
 * Reads/writes the per-user columns; every operation is `user_id`-scoped through
 * the repository (no cross-user access, §10). Updates are **partial**: only the
 * supplied fields change.
 */
export interface AccountSettingsServiceDeps {
  userRepo: UserRepository;
}

/** A partial account-settings patch — omitted fields are left untouched. */
export interface AccountSettingsPatch {
  defaultPortfolioVisibility?: 'private' | 'friends';
  locale?: string;
}

export interface AccountSettingsService {
  get(userId: string): Promise<AccountSettingsResponse>;
  update(userId: string, patch: AccountSettingsPatch): Promise<AccountSettingsResponse>;
}

export function createAccountSettingsService(
  deps: AccountSettingsServiceDeps,
): AccountSettingsService {
  const { userRepo } = deps;

  async function read(userId: string): Promise<AccountSettingsResponse> {
    const row = await userRepo.findById(userId);
    return {
      defaultPortfolioVisibility: row?.defaultPortfolioVisibility ?? 'private',
      locale: row?.locale ?? DEFAULT_LOCALE,
    };
  }

  return {
    get(userId) {
      return read(userId);
    },

    async update(userId, patch) {
      if (patch.defaultPortfolioVisibility !== undefined) {
        await userRepo.setDefaultPortfolioVisibility(userId, patch.defaultPortfolioVisibility);
      }
      if (patch.locale !== undefined) {
        await userRepo.setLocale(userId, patch.locale);
      }
      return read(userId);
    },
  };
}
