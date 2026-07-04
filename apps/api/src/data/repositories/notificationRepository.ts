import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { notifications, notificationSettings } from '../schema';

/**
 * Notification persistence (PROJECTPLAN.md §6.10). Owns the in-app
 * `notifications` rows the dispatcher writes and the per-user
 * `notification_settings` read it needs to decide whether a channel is enabled.
 *
 * Dedupe is by **event key**: the dispatcher stamps a deterministic
 * `payload.eventKey` per (user, logical event), and {@link existsForEventKey}
 * lets an at-least-once redelivery of the same event become a no-op rather than a
 * duplicate row (§6.10 "deduped per (user, event key)").
 */

/** The notification channel discriminator (`notification_channel` enum). */
export type NotificationChannel = 'inapp' | 'email' | 'telegram' | 'discord';

/** A row to insert; `id`/`createdAt`/`readAt` are defaulted by the schema. */
export interface InsertNotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
}

export function createNotificationRepository(db: Database) {
  return {
    /** Insert one in-app notification row. */
    async insert(input: InsertNotificationInput): Promise<void> {
      await db.insert(notifications).values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        payload: input.payload ?? null,
      });
    },

    /**
     * Whether a notification with the given `payload.eventKey` already exists for
     * the user — the dedupe check. `undefined`/null payloads never match, so only
     * dispatcher-written rows participate.
     */
    async existsForEventKey(userId: string, eventKey: string): Promise<boolean> {
      const [row] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            sql`${notifications.payload} ->> 'eventKey' = ${eventKey}`,
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * The user's `enabled` flag for a channel, or `undefined` when the user has no
     * row for it — the caller applies the channel's default (in-app is on by
     * default, §6.10) so dispatch works before the settings write API ships.
     */
    async channelEnabled(
      userId: string,
      channel: NotificationChannel,
    ): Promise<boolean | undefined> {
      const [row] = await db
        .select({ enabled: notificationSettings.enabled })
        .from(notificationSettings)
        .where(
          and(eq(notificationSettings.userId, userId), eq(notificationSettings.channel, channel)),
        )
        .limit(1);
      return row?.enabled;
    },
  };
}

export type NotificationRepository = ReturnType<typeof createNotificationRepository>;
