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
 * duplicate row (§6.10 "deduped per (user, event key)"). The check is backed by
 * a partial unique expression index on `(user_id, payload->>'eventKey')`, so
 * two dispatchers racing past the read still collapse to one row at insert.
 */

/** The notification channel discriminator (`notification_channel` enum). */
export type NotificationChannel = 'inapp' | 'email' | 'telegram' | 'discord' | 'push' | 'webpush';

/** The four user-routable matrix channels (#368) resolved for one type. */
export interface TypeRouting {
  inapp: boolean;
  email: boolean;
  push: boolean;
  webpush: boolean;
}

/**
 * A row to insert; `id`/`createdAt` are defaulted by the schema. `readAt` lets
 * the dispatcher persist a presence-suppressed row already seen (#368: no
 * unread bump for the thread you're viewing); `hidden: true` writes a pure
 * dedupe marker that never surfaces in the inbox (in-app routed off / global
 * mute) but still blocks an at-least-once redelivery.
 */
export interface InsertNotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  readAt?: Date | null;
  hidden?: boolean;
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
    /**
     * Insert one in-app notification row; returns the new row's id (§4.5 —
     * the dispatcher publishes `notification.created` with it for the bell
     * push), or **null** when the partial unique index on
     * `(user_id, payload->>'eventKey')` rejected a concurrent duplicate — the
     * DB-level backstop behind {@link existsForEventKey} that keeps the dedupe
     * marker airtight even with a second dispatcher replica.
     */
    async insert(input: InsertNotificationInput): Promise<string | null> {
      const [row] = await db
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          payload: input.payload ?? null,
          readAt: input.readAt ?? null,
          hidden: input.hidden ?? false,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      return row?.id ?? null;
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
     * Whether a single notification `type` is enabled on a `channel` for the
     * user — the dispatcher's per-(type, channel) fan-out gate (§6.10 matrix).
     *
     * Precedence, in order:
     *  1. an explicit per-type override in `config` (the matrix cell) wins;
     *  2. otherwise the row's channel-wide `enabled` flag (legacy/global toggle);
     *  3. otherwise, with no row at all, the channel default — in-app on, email on.
     */
    async typeChannelEnabled(
      userId: string,
      type: string,
      channel: NotificationChannel,
    ): Promise<boolean> {
      const [row] = await db
        .select({ enabled: notificationSettings.enabled, config: notificationSettings.config })
        .from(notificationSettings)
        .where(
          and(eq(notificationSettings.userId, userId), eq(notificationSettings.channel, channel)),
        )
        .limit(1);
      // No row → the channel default (both in-app and email default on, §6.10).
      if (!row) return true;
      const override = (row.config as Record<string, boolean> | null)?.[type];
      if (typeof override === 'boolean') return override;
      return row.enabled;
    },

    /**
     * One type's routing across all four matrix channels (#368), resolved with
     * the same precedence as {@link typeChannelEnabled} in a single query —
     * the dispatcher's per-event gate.
     */
    async routingFor(userId: string, type: string): Promise<TypeRouting> {
      const rows = await db
        .select({
          channel: notificationSettings.channel,
          enabled: notificationSettings.enabled,
          config: notificationSettings.config,
        })
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId));
      const resolve = (channel: NotificationChannel): boolean => {
        const row = rows.find((r) => r.channel === channel);
        if (!row) return true;
        const override = (row.config as Record<string, boolean> | null)?.[type];
        if (typeof override === 'boolean') return override;
        return row.enabled;
      };
      return {
        inapp: resolve('inapp'),
        email: resolve('email'),
        push: resolve('push'),
        webpush: resolve('webpush'),
      };
    },

    /**
     * The user's per-channel state for building the settings matrix (§6.10): each
     * channel's `enabled` flag and its per-type `config` override map, or
     * `undefined` for a channel with no row. Strictly `user_id`-scoped.
     */
    async channelStatesForUser(
      userId: string,
    ): Promise<
      Partial<Record<NotificationChannel, { enabled: boolean; overrides: Record<string, boolean> }>>
    > {
      const rows = await db
        .select({
          channel: notificationSettings.channel,
          enabled: notificationSettings.enabled,
          config: notificationSettings.config,
        })
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId));
      const states: Partial<
        Record<NotificationChannel, { enabled: boolean; overrides: Record<string, boolean> }>
      > = {};
      for (const row of rows) {
        states[row.channel] = {
          enabled: row.enabled,
          overrides: (row.config as Record<string, boolean> | null) ?? {},
        };
      }
      return states;
    },

    /**
     * Merge per-type overrides into a channel's `config` jsonb, inserting or
     * updating the `(user_id, channel)` row (composite PK). Existing overrides for
     * other types and the row's `enabled` flag are preserved — only the supplied
     * cells change. Scoped to the given user, so it can never touch another
     * user's settings. No schema migration: the overrides live in the existing
     * `config` column.
     */
    async upsertChannelConfig(
      userId: string,
      channel: NotificationChannel,
      overrides: Record<string, boolean>,
    ): Promise<void> {
      const [existing] = await db
        .select({ enabled: notificationSettings.enabled, config: notificationSettings.config })
        .from(notificationSettings)
        .where(
          and(eq(notificationSettings.userId, userId), eq(notificationSettings.channel, channel)),
        )
        .limit(1);
      const enabled = existing?.enabled ?? true;
      const config = {
        ...((existing?.config as Record<string, boolean> | null) ?? {}),
        ...overrides,
      };
      await db
        .insert(notificationSettings)
        .values({ userId, channel, enabled, config })
        .onConflictDoUpdate({
          target: [notificationSettings.userId, notificationSettings.channel],
          set: { enabled, config },
        });
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
            // Hidden rows are dedupe markers, never inbox content (#368).
            eq(notifications.hidden, false),
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
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
            isNull(notifications.readAt),
          ),
        );
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
