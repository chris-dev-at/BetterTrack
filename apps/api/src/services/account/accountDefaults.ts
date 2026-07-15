import {
  NOTIFICATION_SETTING_CHANNELS,
  NOTIFICATION_TYPES,
  notificationChannelDefaultEnabled,
} from '@bettertrack/contracts';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { AppSettingsService } from '../appSettings/appSettingsService';

/**
 * Apply the admin-configured account defaults to a freshly-created account
 * (PROJECTPLAN.md §13.4 V4-P0d). Called from EVERY self-serve registration path
 * (open / invite-token `register`, the email-invite `acceptInvite`, and the
 * approval-queue approval) right after the user row + default portfolio exist. It
 * reads the defaults live, so a change
 * takes effect for the next registration only and never touches an existing
 * account (the caller never runs this for anyone but the account it just made).
 *
 * Each default maps to a concrete registration-time effect:
 *  - **chat off** → set the account's `chatBanned` flag so its first DM send is
 *    refused exactly like an admin ban (unified enforcement point).
 *  - **portfolio visibility** → stamp the account's default-visibility preference
 *    (only when it differs from the column default; the auto-provisioned "Main"
 *    portfolio is created private before this runs and stays private).
 *  - **notification matrix** → seed ONLY the cells that differ from the code lean
 *    default as per-(channel, type) overrides, so an unchanged panel writes
 *    nothing and the account keeps resolving the live lean default.
 *  - **developer status** → INERT (§13.4 V4-P0d, V6-9): the default is stored on
 *    the app-settings side but has zero per-account effect today, so nothing is
 *    written here.
 */
export interface ApplyAccountDefaultsDeps {
  appSettings: Pick<AppSettingsService, 'getAccountDefaults'>;
  userRepo: Pick<UserRepository, 'setChatBanned' | 'setDefaultPortfolioVisibility'>;
  notificationRepo: Pick<NotificationRepository, 'upsertChannelConfig'>;
}

export async function applyAccountDefaultsAtRegistration(
  deps: ApplyAccountDefaultsDeps,
  userId: string,
): Promise<void> {
  const { appSettings, userRepo, notificationRepo } = deps;
  const defaults = await appSettings.getAccountDefaults();

  // Chat off ⇒ register the account chat-disabled (same flag an admin ban sets).
  if (!defaults.chatEnabled) {
    await userRepo.setChatBanned(userId, true);
  }

  // Only write the visibility preference when it diverges from the column default.
  if (defaults.defaultPortfolioVisibility !== 'private') {
    await userRepo.setDefaultPortfolioVisibility(userId, defaults.defaultPortfolioVisibility);
  }

  // Seed only the notification cells that differ from the code lean default.
  for (const channel of NOTIFICATION_SETTING_CHANNELS) {
    const overrides: Record<string, boolean> = {};
    for (const type of NOTIFICATION_TYPES) {
      const value = defaults.notificationMatrix[type][channel];
      if (value !== notificationChannelDefaultEnabled(channel, type)) {
        overrides[type] = value;
      }
    }
    if (Object.keys(overrides).length > 0) {
      await notificationRepo.upsertChannelConfig(userId, channel, overrides);
    }
  }

  // developerStatus: intentionally inert until V6-9 — nothing to apply.
}
