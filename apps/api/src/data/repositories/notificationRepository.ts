import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { notificationChannelDefaultEnabled, type NotificationView } from '@bettertrack/contracts';

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
  archivedAt: Date | null;
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
    archivedAt: row.archivedAt,
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
      // Read ⟺ archived (V4-P0c): a row written already-read — a presence-
      // suppressed row, or a hidden dedupe marker (in-app off / muted) — is
      // archived on insert too, so it never lingers as a read-but-active row.
      const readAt = input.readAt ?? null;
      const [row] = await db
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          payload: input.payload ?? null,
          readAt,
          archivedAt: readAt,
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
     * Precedence, in order (V4-P0c lean email defaults, §16):
     *  1. an explicit per-type override in `config` (the matrix cell) wins;
     *  2. otherwise a channel master-off (`enabled: false`) forces off;
     *  3. otherwise the per-(channel, type) default
     *     ({@link notificationChannelDefaultEnabled}) — in-app on, email on ONLY
     *     for the account/security category.
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
      // No row → the per-(channel, type) default (§6.10, V4-P0c).
      if (!row) return notificationChannelDefaultEnabled(channel, type);
      const override = (row.config as Record<string, boolean> | null)?.[type];
      if (typeof override === 'boolean') return override;
      return row.enabled ? notificationChannelDefaultEnabled(channel, type) : false;
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
        if (!row) return notificationChannelDefaultEnabled(channel, type);
        const override = (row.config as Record<string, boolean> | null)?.[type];
        if (typeof override === 'boolean') return override;
        return row.enabled ? notificationChannelDefaultEnabled(channel, type) : false;
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
     * IDOR by construction (§10). `view` filters on the archive state (#437):
     * `active` (archived_at NULL — the pre-#437 behavior every existing client
     * keeps), `archived`, or `all`.
     */
    async listForUser(
      userId: string,
      params: { limit: number; cursor?: string; view?: NotificationView },
    ): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
      const view = params.view ?? 'active';
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            // Hidden rows are dedupe markers, never inbox content (#368).
            eq(notifications.hidden, false),
            view === 'active'
              ? isNull(notifications.archivedAt)
              : view === 'archived'
                ? isNotNull(notifications.archivedAt)
                : undefined,
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

    /**
     * Count of the user's unread notifications, for the bell badge (§6.10).
     * ACTIVE rows only (#437): an archived row never counts — though by the
     * archive-implies-read invariant an archived row is always read anyway,
     * the filter keeps the badge honest by construction.
     */
    async countUnread(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
            isNull(notifications.readAt),
            isNull(notifications.archivedAt),
          ),
        );
      return row?.count ?? 0;
    },

    /**
     * Mark exactly the given owned rows read — and, since read ⟺ archived
     * (V4-P0c), archive them in the same statement so the inbox (active view)
     * shows unread only and history lands under Archived. Both timestamps ride a
     * `coalesce` so a repeat preserves the original read/archive time (idempotent)
     * and never resurrects an already-archived row. Ids belonging to another user
     * are silently excluded — no cross-user leak.
     */
    async markRead(userId: string, ids: readonly string[], now: Date): Promise<void> {
      if (ids.length === 0) return;
      const nowIso = now.toISOString();
      await db
        .update(notifications)
        .set({
          readAt: sql`coalesce(${notifications.readAt}, ${nowIso}::timestamptz)`,
          archivedAt: sql`coalesce(${notifications.archivedAt}, ${nowIso}::timestamptz)`,
        })
        .where(and(eq(notifications.userId, userId), inArray(notifications.id, [...ids])));
    },

    /**
     * Mark every unread row for the user read — and archive it (read ⟺ archived,
     * V4-P0c). Idempotent (a no-op when none are unread); only unread rows are
     * touched, so already-read/archived timestamps are preserved.
     */
    async markAllRead(userId: string, now: Date): Promise<void> {
      await db
        .update(notifications)
        .set({ readAt: now, archivedAt: now })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    },

    // ── Archive state + deletion (#437, read=archive V4-P0c) ─────────────────

    /**
     * Archive one owned row: stamps `archived_at` and — archive-implies-read
     * (#437: a hidden-but-unread badge would lie) — `read_at` too, each only
     * when not already set, so a repeat is idempotent and preserves the
     * original timestamps. @returns false when the id isn't the caller's (or
     * doesn't exist / is a hidden marker) — indistinguishable, for the 404.
     */
    async archive(userId: string, id: string, now: Date): Promise<boolean> {
      // The COALESCE params ride a raw SQL fragment, outside the column's
      // drizzle type mapping — postgres-js needs the explicit ISO string +
      // ::timestamptz cast (a bare Date param fails to type-resolve there).
      const nowIso = now.toISOString();
      const rows = await db
        .update(notifications)
        .set({
          archivedAt: sql`coalesce(${notifications.archivedAt}, ${nowIso}::timestamptz)`,
          readAt: sql`coalesce(${notifications.readAt}, ${nowIso}::timestamptz)`,
        })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
          ),
        )
        .returning({ id: notifications.id });
      return rows.length > 0;
    },

    /**
     * Un-archive one owned row (back to active; `read_at` stays). Idempotent on
     * an already-active row. @returns false when the id isn't the caller's.
     */
    async unarchive(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .update(notifications)
        .set({ archivedAt: null })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
          ),
        )
        .returning({ id: notifications.id });
      return rows.length > 0;
    },

    /** Archive every read, still-active row for the user (bulk, idempotent). */
    async archiveAllRead(userId: string, now: Date): Promise<void> {
      await db
        .update(notifications)
        .set({ archivedAt: now })
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
            isNull(notifications.archivedAt),
            isNotNull(notifications.readAt),
          ),
        );
    },

    /**
     * Hard-delete one owned row. @returns false when nothing was deleted (not
     * the caller's, already gone, or a hidden dedupe marker — which must
     * survive so an at-least-once redelivery of its event stays deduped).
     */
    async deleteOne(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
          ),
        )
        .returning({ id: notifications.id });
      return rows.length > 0;
    },

    /**
     * Bulk hard delete for one user (#437): `archived` removes exactly the
     * archived set, `all` empties the user's notifications. Hidden dedupe
     * markers are infrastructure, not inbox content — they are never listed,
     * never archived, and stay behind so redeliveries keep deduping.
     */
    async deleteBulk(userId: string, scope: 'archived' | 'all'): Promise<void> {
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.hidden, false),
            scope === 'archived' ? isNotNull(notifications.archivedAt) : undefined,
          ),
        );
    },
  };
}

export type NotificationRepository = ReturnType<typeof createNotificationRepository>;
