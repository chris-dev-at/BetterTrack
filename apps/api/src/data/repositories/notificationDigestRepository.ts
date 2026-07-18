import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import {
  DEFAULT_NOTIFICATION_CADENCE,
  type DigestCadence,
  type NotificationCadence,
  type NotificationType,
} from '@bettertrack/contracts';

import type { Database } from '../db';
import { notificationCadences, notificationDigestQueue } from '../schema';

/**
 * Digest persistence (PROJECTPLAN.md §13.5 V5-P3). Owns two things:
 *
 *  - the per-user per-type **cadence** (`notification_cadences`): absence of a
 *    row resolves to `instant`, so the whole feature is additive — no existing
 *    user is migrated and the dispatcher's instant path stays byte-identical;
 *  - the **digest queue** (`notification_digest_queue`): deferred (daily/weekly)
 *    items, one row per outbound channel, that the digest job groups by `period`
 *    and delivers as ONE summary.
 *
 * Delivery is idempotent per (user, period): {@link claimPeriod} stamps
 * `delivered_at` in the SAME UPDATE it reads the rows back, so a re-run or a
 * second worker claiming the same group gets zero rows and never double-sends.
 *
 * Every read/write is `user_id`-scoped (§10) — cross-user access is impossible
 * by construction.
 */

/** The outbound channels a digest item can target (never inapp/telegram/discord). */
export type DigestChannel = 'email' | 'push' | 'webpush';

/** Sentinel `period` for a quiet-hours-deferred row (delivered by time, not group). */
const DEFERRED_PERIOD = 'deferred';

/** One deferred item to enqueue (rendered strings + the grouping period). */
export interface EnqueueDigestItemInput {
  userId: string;
  type: string;
  channel: DigestChannel;
  cadence: DigestCadence;
  period: string;
  title: string;
  body: string;
  /** Push deep-link data (only meaningful for push/webpush); null for email. */
  data?: Record<string, string> | null;
}

/** A claimed digest row, as the renderer consumes it. */
export interface DigestQueueItem {
  id: string;
  userId: string;
  type: string;
  channel: DigestChannel;
  cadence: DigestCadence;
  period: string;
  title: string;
  body: string;
  data: Record<string, string> | null;
}

/**
 * One quiet-hours-deferred item (§13.5 V5-P3): an INSTANT-cadence outbound
 * notification (or a quiet-blocked digest summary) queued for INDIVIDUAL
 * delivery at `deliverAfter` (= the user's quiet-window end). Stored in the same
 * table with `cadence = 'instant'` and `deliver_after` set.
 */
export interface EnqueueDeferredItemInput {
  userId: string;
  type: string;
  channel: DigestChannel;
  title: string;
  body: string;
  /** Push deep-link data (push/webpush only); null for email. */
  data?: Record<string, string> | null;
  /** Wall-clock moment the row becomes due for delivery. */
  deliverAfter: Date;
}

/** A claimed deferred row, as the deferred-delivery job sends it individually. */
export interface DeferredQueueItem {
  id: string;
  userId: string;
  type: string;
  channel: DigestChannel;
  title: string;
  body: string;
  data: Record<string, string> | null;
}

/** A pending (user, period) group the digest job delivers one summary for. */
export interface PendingDigestGroup {
  userId: string;
  period: string;
}

function toItem(row: typeof notificationDigestQueue.$inferSelect): DigestQueueItem {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    channel: row.channel as DigestChannel,
    cadence: row.cadence as DigestCadence,
    period: row.period,
    title: row.title,
    body: row.body,
    data: (row.data as Record<string, string> | null) ?? null,
  };
}

export function createNotificationDigestRepository(db: Database) {
  return {
    /** The cadence for one (user, type) — the default `instant` when unset. */
    async cadenceFor(userId: string, type: string): Promise<NotificationCadence> {
      const [row] = await db
        .select({ cadence: notificationCadences.cadence })
        .from(notificationCadences)
        .where(and(eq(notificationCadences.userId, userId), eq(notificationCadences.type, type)))
        .limit(1);
      return (row?.cadence as NotificationCadence | undefined) ?? DEFAULT_NOTIFICATION_CADENCE;
    },

    /**
     * The user's stored cadence overrides as a sparse map (types with no row are
     * absent — the settings service fills them with the default). Strictly
     * `user_id`-scoped.
     */
    async cadenceMapForUser(
      userId: string,
    ): Promise<Partial<Record<NotificationType, NotificationCadence>>> {
      const rows = await db
        .select({ type: notificationCadences.type, cadence: notificationCadences.cadence })
        .from(notificationCadences)
        .where(eq(notificationCadences.userId, userId));
      const map: Partial<Record<NotificationType, NotificationCadence>> = {};
      for (const row of rows) {
        map[row.type as NotificationType] = row.cadence as NotificationCadence;
      }
      return map;
    },

    /**
     * Upsert per-type cadence choices for one user. `instant` (the default) is
     * stored explicitly like any other value — reading it back is identical to
     * having no row, so no special-casing leaks into the read path. Scoped to
     * the given user; other users' rows are untouchable.
     */
    async setCadences(
      userId: string,
      entries: Partial<Record<NotificationType, NotificationCadence>>,
    ): Promise<void> {
      const values = Object.entries(entries)
        .filter(([, cadence]) => cadence !== undefined)
        .map(([type, cadence]) => ({ userId, type, cadence: cadence as NotificationCadence }));
      if (values.length === 0) return;
      await db
        .insert(notificationCadences)
        .values(values)
        .onConflictDoUpdate({
          target: [notificationCadences.userId, notificationCadences.type],
          set: { cadence: sql`excluded.cadence` },
        });
    },

    /** Enqueue one deferred item onto the digest queue. */
    async enqueue(item: EnqueueDigestItemInput): Promise<void> {
      await db.insert(notificationDigestQueue).values({
        userId: item.userId,
        type: item.type,
        channel: item.channel,
        cadence: item.cadence,
        period: item.period,
        title: item.title,
        body: item.body,
        data: item.data ?? null,
      });
    },

    /**
     * The distinct (user, period) groups with pending items for a cadence — the
     * job's work list. Each is delivered as exactly one digest per channel.
     *
     * Every pending group is returned (no period filter): whether a group's
     * period is *complete* is decided per user by the digest service, because
     * with V5-P3 timezone alignment the current (still-accumulating) period key
     * differs per recipient — the service compares each group against the user's
     * own local current period before claiming. Instant deferred rows (`cadence
     * = 'instant'`) never match here, so the grouped path never sees them.
     */
    async pendingGroups(cadence: DigestCadence): Promise<PendingDigestGroup[]> {
      const rows = await db
        .selectDistinct({
          userId: notificationDigestQueue.userId,
          period: notificationDigestQueue.period,
        })
        .from(notificationDigestQueue)
        .where(
          and(
            eq(notificationDigestQueue.cadence, cadence),
            isNull(notificationDigestQueue.deliveredAt),
          ),
        );
      return rows.map((r) => ({ userId: r.userId, period: r.period }));
    },

    /**
     * Queue one quiet-hours-deferred item (§13.5 V5-P3) for INDIVIDUAL delivery
     * at `deliverAfter`. Stored in the same table with `cadence = 'instant'` and
     * a fixed sentinel `period` (never grouped — the grouped path only queries
     * daily/weekly), so the deferred-delivery job claims it by `deliver_after`.
     */
    async enqueueDeferred(item: EnqueueDeferredItemInput): Promise<void> {
      await db.insert(notificationDigestQueue).values({
        userId: item.userId,
        type: item.type,
        channel: item.channel,
        cadence: 'instant',
        period: DEFERRED_PERIOD,
        title: item.title,
        body: item.body,
        data: item.data ?? null,
        deliverAfter: item.deliverAfter,
      });
    },

    /**
     * Atomically claim every deferred item now due (`deliver_after <= now`, not
     * yet delivered): the UPDATE stamps `delivered_at` and RETURNs the rows it
     * changed in one statement, so a re-run or a second worker claims zero and
     * never double-sends — the idempotency guarantee, and restart-safe because
     * the pending rows live in the DB until claimed. Each claimed row is
     * delivered as ITSELF (never grouped).
     */
    async claimDueDeferred(now: Date): Promise<DeferredQueueItem[]> {
      const rows = await db
        .update(notificationDigestQueue)
        .set({ deliveredAt: now })
        .where(
          and(
            eq(notificationDigestQueue.cadence, 'instant'),
            isNotNull(notificationDigestQueue.deliverAfter),
            isNull(notificationDigestQueue.deliveredAt),
            lte(notificationDigestQueue.deliverAfter, now),
          ),
        )
        .returning();
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        type: row.type,
        channel: row.channel as DigestChannel,
        title: row.title,
        body: row.body,
        data: (row.data as Record<string, string> | null) ?? null,
      }));
    },

    /**
     * Atomically claim every undelivered item for one (user, period, cadence):
     * the UPDATE stamps `delivered_at` and RETURNs the rows it changed in one
     * statement. A concurrent claimer's WHERE (delivered_at IS NULL) no longer
     * matches, so it gets zero rows — the idempotency guarantee (§13.5 V5-P3:
     * "running it twice delivers once"). An already-empty group returns `[]`.
     */
    async claimPeriod(
      userId: string,
      period: string,
      cadence: DigestCadence,
      now: Date,
    ): Promise<DigestQueueItem[]> {
      const rows = await db
        .update(notificationDigestQueue)
        .set({ deliveredAt: now })
        .where(
          and(
            eq(notificationDigestQueue.userId, userId),
            eq(notificationDigestQueue.period, period),
            eq(notificationDigestQueue.cadence, cadence),
            isNull(notificationDigestQueue.deliveredAt),
          ),
        )
        .returning();
      return rows.map(toItem);
    },
  };
}

export type NotificationDigestRepository = ReturnType<typeof createNotificationDigestRepository>;
