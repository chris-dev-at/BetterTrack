import {
  NOTIFICATION_TYPES,
  type NotificationMatrix,
  type NotificationSettingsResponse,
  type NotificationType,
  type UpdateNotificationSettingsRequest,
} from '@bettertrack/contracts';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8). Reads and
 * writes the per-user, **per-type × channel** matrix the dispatcher honors, for
 * the `GET/PATCH /settings/notifications` surface. Each V1 notification type is
 * routed independently to the in-app bell and/or email (both / bell-only /
 * email-only / muted).
 *
 * §6.10 defaults, enforced here rather than in the schema:
 *  - **In-app and email both default on.** A type with no stored override reads
 *    `enabled: true` on each channel, so a fresh user is routed to "both".
 *  - **Overrides live in `notification_settings.config`** (jsonb), one map per
 *    (userId, channel) row — no schema migration.
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

  /**
   * Resolve one channel's effective state for a type from the stored channel
   * state, applying §6.10 precedence: per-type override, then the channel-wide
   * `enabled` flag, then the channel default (on).
   */
  function effective(
    state: { enabled: boolean; overrides: Record<string, boolean> } | undefined,
    type: NotificationType,
  ): boolean {
    if (!state) return true;
    const override = state.overrides[type];
    return typeof override === 'boolean' ? override : state.enabled;
  }

  async function read(userId: string): Promise<NotificationSettingsResponse> {
    const states = await repo.channelStatesForUser(userId);
    const matrix = Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [
        type,
        { inapp: effective(states.inapp, type), email: effective(states.email, type) },
      ]),
    ) as NotificationMatrix;
    return { matrix };
  }

  return {
    get: read,

    async update(userId, body) {
      // Split the partial matrix into a per-channel override map, then merge each
      // into the channel's `config` jsonb (other types + the row's channel-wide
      // flag are preserved by the repository).
      const inappOverrides: Record<string, boolean> = {};
      const emailOverrides: Record<string, boolean> = {};
      for (const [type, routing] of Object.entries(body.matrix)) {
        if (!routing) continue;
        inappOverrides[type] = routing.inapp;
        emailOverrides[type] = routing.email;
      }
      if (Object.keys(inappOverrides).length > 0) {
        await repo.upsertChannelConfig(userId, 'inapp', inappOverrides);
      }
      if (Object.keys(emailOverrides).length > 0) {
        await repo.upsertChannelConfig(userId, 'email', emailOverrides);
      }
      return read(userId);
    },
  };
}
