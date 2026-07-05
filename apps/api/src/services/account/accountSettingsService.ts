import type { AccountSettingsResponse } from '@bettertrack/contracts';

import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * Settings → Account preferences (PROJECTPLAN.md §6.9, §6.11, §13.2 V2-P9). V1
 * exposes a single field — the **default portfolio visibility** applied when a
 * new portfolio is created (`private` default, or `friends`). Reads/writes the
 * per-user column; every operation is `user_id`-scoped through the repository (no
 * cross-user access, §10). Changing it only affects the *default* at creation
 * time — existing portfolios and explicit per-item toggles are untouched.
 */
export interface AccountSettingsServiceDeps {
  userRepo: UserRepository;
}

export interface AccountSettingsService {
  get(userId: string): Promise<AccountSettingsResponse>;
  update(
    userId: string,
    defaultPortfolioVisibility: 'private' | 'friends',
  ): Promise<AccountSettingsResponse>;
}

export function createAccountSettingsService(
  deps: AccountSettingsServiceDeps,
): AccountSettingsService {
  const { userRepo } = deps;
  return {
    async get(userId) {
      return { defaultPortfolioVisibility: await userRepo.getDefaultPortfolioVisibility(userId) };
    },

    async update(userId, defaultPortfolioVisibility) {
      await userRepo.setDefaultPortfolioVisibility(userId, defaultPortfolioVisibility);
      return { defaultPortfolioVisibility };
    },
  };
}
