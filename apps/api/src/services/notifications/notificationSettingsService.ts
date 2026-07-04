import type {
  NotificationSettingsResponse,
  UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8). Reads and
 * writes the per-user `notification_settings` rows the dispatcher honors, for the
 * `GET/PATCH /settings/notifications` surface.
 *
 * Two §6.10 rules are enforced here, not in the schema:
 *  - **In-app is always on.** It is reported `enabled: true` regardless of any
 *    row, and a PATCH attempt to disable it is ignored (no row is written) — so
 *    the dispatcher's `channelEnabled(user, 'inapp')` never sees an explicit
 *    `false`.
 *  - **Email defaults on.** With no row the channel reads `enabled: true`; a
 *    PATCH persists the flag so the dispatcher's `channelEnabled(user, 'email')`
 *    reflects it.
 *
 * Every read/write is `user_id`-scoped through the repository — no cross-user
 * access (§10).
 */

export interface NotificationSettingsServiceDeps {
  repo: NotificationRepository;
}

export interface NotificationSettingsService {
  get(userId: string): Promise<NotificationSettingsResponse>;
  update(
    userId: string,
    body: UpdateNotificationSettingsRequest,
  ): Promise<NotificationSettingsResponse>;
}

export function createNotificationSettingsService(
  deps: NotificationSettingsServiceDeps,
): NotificationSettingsService {
  const { repo } = deps;

  async function read(userId: string): Promise<NotificationSettingsResponse> {
    const settings = await repo.settingsForUser(userId);
    return {
      // In-app is always on (§6.10) — never disableable, so it ignores any row.
      inapp: { enabled: true },
      // Email is on by default: only an explicit row turns it off.
      email: { enabled: settings.email ?? true },
    };
  }

  return {
    get: read,

    async update(userId, body) {
      // In-app cannot be disabled (§6.10): any `inapp` in the body is ignored.
      if (body.email !== undefined) {
        await repo.upsertChannelEnabled(userId, 'email', body.email.enabled);
      }
      return read(userId);
    },
  };
}
