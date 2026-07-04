import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

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

/** One notification row as read back for the user-facing list (§8). */
export interface NotificationRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

function toRecord(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
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

    /**
     * Newest-first notifications for one user, keyset paginated by UUIDv7 id
     * (§8). Scoped by `user_id` so another user's id is never returned — no
     * IDOR by construction (§10).
     */
    async listForUser(
      userId: string,
      params: { limit: number; cursor?: string },
    ): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            params.cursor ? lt(notifications.id, params.cursor) : undefined,
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(params.limit + 1);

      const hasMore = rows.length > params.limit;
      const page = hasMore ? rows.slice(0, params.limit) : rows;
      const items = page.map(toRecord);
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    /** Count of the user's unread notifications, for the bell badge (§6.10). */
    async countUnread(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
      return row?.count ?? 0;
    },

    /**
     * Mark exactly the given (owned, unread) rows read. Ids belonging to
     * another user, or already-read rows, are silently excluded — idempotent
     * and no cross-user leak.
     */
    async markRead(userId: string, ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, userId), inArray(notifications.id, [...ids])));
    },

    /** Mark every unread row for the user read (idempotent — a no-op if none). */
    async markAllRead(userId: string): Promise<void> {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    },
  };
}

export type NotificationRepository = ReturnType<typeof createNotificationRepository>;
