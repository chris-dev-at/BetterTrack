import { and, desc, eq, isNotNull, isNull, lte, gte, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  announcementDismissals,
  announcements,
  type AnnouncementRow,
  type NewAnnouncementRow,
} from '../schema';

/**
 * Announcement persistence (§13.4 V4-P5b). Owns the `announcements` rows the
 * admin composer writes plus the per-user `announcement_dismissals` rows a
 * caller stamps to hide the banner. Fan-out of the inbox notification itself
 * rides the existing {@link import('./notificationRepository').NotificationRepository}
 * via the shared `account.notice` type and per-user eventKey — no announcement
 * schema is duplicated on the notification side.
 */

export interface CreateAnnouncementInput {
  severity: 'info' | 'warning' | 'critical';
  titleEn: string;
  bodyEn: string;
  titleDe: string;
  bodyDe: string;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  createdBy: string | null;
}

export interface UpdateAnnouncementInput {
  severity?: 'info' | 'warning' | 'critical';
  titleEn?: string;
  bodyEn?: string;
  titleDe?: string;
  bodyDe?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  active?: boolean;
  publishedAt?: Date | null;
}

export function createAnnouncementRepository(db: Database) {
  return {
    /** All announcements, newest first — the admin listing (never user-facing). */
    listAll(): Promise<AnnouncementRow[]> {
      return db.select().from(announcements).orderBy(desc(announcements.createdAt));
    },

    async findById(id: string): Promise<AnnouncementRow | undefined> {
      const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
      return row;
    },

    async create(input: CreateAnnouncementInput): Promise<AnnouncementRow> {
      const values: NewAnnouncementRow = {
        severity: input.severity,
        titleEn: input.titleEn,
        bodyEn: input.bodyEn,
        titleDe: input.titleDe,
        bodyDe: input.bodyDe,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        active: input.active,
        // `published_at` is stamped on first publish by the service, not here.
        createdBy: input.createdBy,
      };
      const [row] = await db.insert(announcements).values(values).returning();
      if (!row) throw new Error('Failed to insert announcement');
      return row;
    },

    async update(id: string, patch: UpdateAnnouncementInput): Promise<AnnouncementRow | undefined> {
      // Reject empty patches at the service layer — Drizzle rejects an empty
      // `.set({})` at query time otherwise.
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.severity !== undefined) set.severity = patch.severity;
      if (patch.titleEn !== undefined) set.titleEn = patch.titleEn;
      if (patch.bodyEn !== undefined) set.bodyEn = patch.bodyEn;
      if (patch.titleDe !== undefined) set.titleDe = patch.titleDe;
      if (patch.bodyDe !== undefined) set.bodyDe = patch.bodyDe;
      if (patch.startsAt !== undefined) set.startsAt = patch.startsAt;
      if (patch.endsAt !== undefined) set.endsAt = patch.endsAt;
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.publishedAt !== undefined) set.publishedAt = patch.publishedAt;
      const [row] = await db
        .update(announcements)
        .set(set)
        .where(eq(announcements.id, id))
        .returning();
      return row;
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db
        .delete(announcements)
        .where(eq(announcements.id, id))
        .returning({ id: announcements.id });
      return rows.length > 0;
    },

    /**
     * Every currently-active announcement (flagged on AND inside its window at
     * `at`) that the user has NOT dismissed. Newest-first, so the banner render
     * order matches the composer's list.
     */
    async listActiveForUser(userId: string, at: Date): Promise<AnnouncementRow[]> {
      // Left-join the dismissals for the caller so a WHERE nullness check
      // filters dismissed rows out in a single round trip.
      const rows = await db
        .select({
          row: announcements,
          dismissedAt: announcementDismissals.dismissedAt,
        })
        .from(announcements)
        .leftJoin(
          announcementDismissals,
          and(
            eq(announcementDismissals.announcementId, announcements.id),
            eq(announcementDismissals.userId, userId),
          ),
        )
        .where(
          and(
            eq(announcements.active, true),
            or(isNull(announcements.startsAt), lte(announcements.startsAt, at)),
            or(isNull(announcements.endsAt), gte(announcements.endsAt, at)),
            isNull(announcementDismissals.dismissedAt),
          ),
        )
        .orderBy(desc(announcements.createdAt));
      return rows.map((r) => r.row);
    },

    /**
     * Idempotent per-user dismissal. A repeat is a no-op (PK collision → do
     * nothing); a dismissal for a non-existent announcement id is a no-op too
     * (the FK write fails silently — the service checks existence first for
     * the 404 response shape).
     */
    async dismissForUser(userId: string, announcementId: string): Promise<void> {
      await db
        .insert(announcementDismissals)
        .values({ userId, announcementId })
        .onConflictDoNothing();
    },

    /** For tests: whether the caller has dismissed the given announcement. */
    async hasDismissed(userId: string, announcementId: string): Promise<boolean> {
      const [row] = await db
        .select({ dismissedAt: announcementDismissals.dismissedAt })
        .from(announcementDismissals)
        .where(
          and(
            eq(announcementDismissals.userId, userId),
            eq(announcementDismissals.announcementId, announcementId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /** For tests: whether the announcement has ever been published (fan-out flag). */
    async hasBeenPublished(id: string): Promise<boolean> {
      const [row] = await db
        .select({ publishedAt: announcements.publishedAt })
        .from(announcements)
        .where(and(eq(announcements.id, id), isNotNull(announcements.publishedAt)))
        .limit(1);
      return row !== undefined;
    },

    /** Row count — for admin-facing tests. */
    async count(): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(announcements);
      return row?.count ?? 0;
    },
  };
}

export type AnnouncementRepository = ReturnType<typeof createAnnouncementRepository>;
