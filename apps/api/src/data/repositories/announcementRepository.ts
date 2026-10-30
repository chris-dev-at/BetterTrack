import { and, asc, desc, eq, gt, isNotNull, isNull, lte, gte, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import {
  announcementReceipts,
  announcements,
  type AnnouncementRow,
  type NewAnnouncementRow,
} from '../schema';

/**
 * Announcement persistence (§13.4 V4-P5b; data model §6.19.5). Owns the
 * `announcements` rows the admin composer writes plus the per-user
 * `announcement_receipts` rows (`announcement_dismissals` before 0122) a
 * caller stamps to hide the banner.
 *
 * ── The `active` ⇄ `lifecycle` lockstep (0122, one release) ─────────────────
 * The composer still speaks `active` until the §6.19 lifecycle API replaces
 * it; this repository is the one place both columns are written, and it keeps
 * them in the same lockstep the migration's backfill established:
 *   active = true  → `published`, `released_at` / `audience_cutoff_at` stamped
 *                    once (COALESCE — never moved again), `archived_at` NULL;
 *   active = false → `archived` when the row was ever delivered or holds
 *                    receipts, else `draft` (nothing released).
 * New rows are written `plain`: the current composer's bodies are plain text.
 * Fan-out of the inbox notification itself
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

/**
 * What one COMPLETED fan-out pass measured.
 *
 * `delivered` is the number of recipients confirmed to hold their inbox row at
 * the end of the pass — `walked - failed` — not the number of rows this pass
 * happened to INSERT. That distinction is the whole reason these counts can be
 * trusted: a re-run inserts nothing (the eventKey index collapses it) yet every
 * recipient is still delivered, and a pass resuming after a crash would
 * otherwise report only the tail it had left to write. Counting confirmations
 * rather than writes means the number cannot be double-counted by a retry and
 * cannot be under-reported by a resume.
 *
 * `failed` is the recipients whose insert threw on that pass. `delivered +
 * failed` is always the number of accounts walked.
 */
export interface AnnouncementDeliveryCounts {
  delivered: number;
  failed: number;
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

/**
 * The lifecycle columns that go with an `active` write (see the file header).
 * SQL, not values: whether the row was ever delivered (or holds receipts) and
 * whether it was already released are facts of the stored row, read in the
 * same UPDATE that changes it.
 */
function lifecycleLockstep(active: boolean): Record<string, unknown> {
  if (active) {
    return {
      lifecycle: sql`'published'::announcement_lifecycle`,
      releasedAt: sql`COALESCE(${announcements.releasedAt}, now())`,
      audienceCutoffAt: sql`COALESCE(${announcements.audienceCutoffAt}, GREATEST(now(), COALESCE(${announcements.startsAt}, now())))`,
      archivedAt: null,
      archivedBy: null,
    };
  }
  const keep = sql`(${announcements.publishedAt} IS NOT NULL OR EXISTS (SELECT 1 FROM ${announcementReceipts} WHERE ${announcementReceipts.announcementId} = ${announcements.id}))`;
  return {
    lifecycle: sql`CASE WHEN ${keep} THEN 'archived'::announcement_lifecycle ELSE 'draft'::announcement_lifecycle END`,
    releasedAt: sql`CASE WHEN ${keep} THEN COALESCE(${announcements.releasedAt}, now()) ELSE NULL END`,
    releasedBy: sql`CASE WHEN ${keep} THEN ${announcements.releasedBy} ELSE NULL END`,
    audienceCutoffAt: sql`CASE WHEN ${keep} THEN COALESCE(${announcements.audienceCutoffAt}, GREATEST(now(), COALESCE(${announcements.startsAt}, now()))) ELSE NULL END`,
    archivedAt: sql`CASE WHEN ${keep} THEN COALESCE(${announcements.archivedAt}, now()) ELSE NULL END`,
  };
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
      const now = new Date();
      const released =
        input.startsAt && input.startsAt.getTime() > now.getTime() ? input.startsAt : now;
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
        bodyFormat: 'plain',
        ...(input.active
          ? {
              lifecycle: 'published' as const,
              releasedAt: now,
              releasedBy: input.createdBy,
              audienceCutoffAt: released,
            }
          : {}),
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
      if (patch.active !== undefined) {
        set.active = patch.active;
        Object.assign(set, lifecycleLockstep(patch.active));
      }
      if (patch.publishedAt !== undefined) set.publishedAt = patch.publishedAt;
      const [row] = await db
        .update(announcements)
        .set(set)
        .where(eq(announcements.id, id))
        .returning();
      return row;
    },

    /**
     * Delete one announcement and its receipts. Neither receipt foreign key
     * cascades (§6.19.5), so the receipts go first, in the same transaction —
     * and only the ones WITHOUT an acknowledgement: should a row ever hold
     * one, the RESTRICT key refuses the whole delete rather than erase it.
     */
    async remove(id: string): Promise<boolean> {
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await tx
          .delete(announcementReceipts)
          .where(
            and(
              eq(announcementReceipts.announcementId, id),
              isNull(announcementReceipts.acknowledgedAt),
            ),
          );
        const rows = await tx
          .delete(announcements)
          .where(eq(announcements.id, id))
          .returning({ id: announcements.id });
        return rows.length > 0;
      });
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
          dismissedAt: announcementReceipts.dismissedAt,
        })
        .from(announcements)
        .leftJoin(
          announcementReceipts,
          and(
            eq(announcementReceipts.announcementId, announcements.id),
            eq(announcementReceipts.userId, userId),
          ),
        )
        .where(
          and(
            eq(announcements.active, true),
            or(isNull(announcements.startsAt), lte(announcements.startsAt, at)),
            or(isNull(announcements.endsAt), gte(announcements.endsAt, at)),
            isNull(announcementReceipts.dismissedAt),
          ),
        )
        .orderBy(desc(announcements.createdAt));
      return rows.map((r) => r.row);
    },

    /**
     * Idempotent per-user dismissal — first write wins.
     *
     * Idempotency key: `(user_id, announcement_id)`, the receipts' unique
     * constraint. The upsert COALESCEs `dismissed_at` (and `seen_at`, which a
     * dismissal implies), so a repeat never moves either instant and never
     * touches the rest of the receipt; `updated_at` moves only on the write
     * that actually stamped the dismissal. The service checks the announcement
     * exists first for the 404 shape.
     */
    async dismissForUser(userId: string, announcementId: string): Promise<void> {
      const now = new Date();
      await db
        .insert(announcementReceipts)
        .values({ userId, announcementId, dismissedAt: now, seenAt: now })
        .onConflictDoUpdate({
          target: [announcementReceipts.userId, announcementReceipts.announcementId],
          set: {
            dismissedAt: sql`COALESCE(${announcementReceipts.dismissedAt}, excluded.dismissed_at)`,
            seenAt: sql`COALESCE(${announcementReceipts.seenAt}, excluded.seen_at)`,
            updatedAt: sql`CASE WHEN ${announcementReceipts.dismissedAt} IS NULL THEN excluded.updated_at ELSE ${announcementReceipts.updatedAt} END`,
          },
        });
    },

    /** For tests: whether the caller has dismissed the given announcement. */
    async hasDismissed(userId: string, announcementId: string): Promise<boolean> {
      const [row] = await db
        .select({ dismissedAt: announcementReceipts.dismissedAt })
        .from(announcementReceipts)
        .where(
          and(
            eq(announcementReceipts.userId, userId),
            eq(announcementReceipts.announcementId, announcementId),
            isNotNull(announcementReceipts.dismissedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /**
     * Announcements the publish job owes a fan-out at `at` (#1909).
     *
     * Due = flagged active **and** never stamped **and** the display window is
     * open. The `ends_at > at` clause is the one that stops an operator
     * activating a long-expired announcement and mailing the whole user base
     * about it; note it is strict where the banner's own filter is inclusive,
     * so an announcement is never delivered in the final instant of a window it
     * is about to leave.
     *
     * Ordered oldest-first and bounded, so one run is a bounded unit of work and
     * the next tick continues from the same predicate — there is no cursor to
     * lose.
     */
    listDuePublications(at: Date, limit: number): Promise<AnnouncementRow[]> {
      return db
        .select()
        .from(announcements)
        .where(
          and(
            eq(announcements.active, true),
            isNull(announcements.publishedAt),
            or(isNull(announcements.startsAt), lte(announcements.startsAt, at)),
            or(isNull(announcements.endsAt), gt(announcements.endsAt, at)),
          ),
        )
        .orderBy(asc(announcements.createdAt))
        .limit(limit);
    },

    /**
     * **The per-announcement idempotency claim.** Stamp `published_at` and the
     * pass's counts, but only if nobody has stamped it yet.
     *
     * Idempotency key: `announcements.id` **where `published_at IS NULL`** — a
     * single conditional UPDATE, so the database decides the winner. Two workers
     * that walked the same announcement concurrently both arrive here and
     * exactly one row is affected; the loser returns `false` and records
     * nothing, which is what keeps the audit log from carrying two publications
     * of one announcement.
     *
     * Walk-then-claim (not claim-then-walk) is deliberate: a run that dies
     * mid-walk never reaches this statement, so `published_at` stays NULL and
     * the very next sweep tick re-publishes it. The per-recipient eventKey index
     * is what makes that re-walk free of duplicates — the two layers cover each
     * other, and neither alone is enough.
     *
     * `active = true` is in the predicate as well (#1941 review). The service
     * re-reads and re-checks before it walks, so this is belt to that braces:
     * an operator who switches an announcement off DURING the walk gets no
     * stamp, which leaves the row re-publishable if they switch it back on
     * rather than silently recording a publication they had just cancelled.
     */
    async claimPublication(
      id: string,
      publishedAt: Date,
      counts: AnnouncementDeliveryCounts,
    ): Promise<boolean> {
      const rows = await db
        .update(announcements)
        .set({
          publishedAt,
          deliveredCount: counts.delivered,
          failedCount: counts.failed,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(announcements.id, id),
            isNull(announcements.publishedAt),
            eq(announcements.active, true),
          ),
        )
        .returning({ id: announcements.id });
      return rows.length > 0;
    },

    /**
     * Record a LATER pass over an already-stamped announcement — the bounded
     * single retry after a partial delivery.
     *
     * Both counts are REPLACED, never accumulated: they describe the most recent
     * completed pass over the whole recipient set, so a clean retry honestly
     * reports every account delivered and 0 still failing. Accumulating would be
     * the double-count this design exists to make impossible.
     */
    async recordDeliveryOutcome(id: string, counts: AnnouncementDeliveryCounts): Promise<void> {
      await db
        .update(announcements)
        .set({
          deliveredCount: counts.delivered,
          failedCount: counts.failed,
          updatedAt: new Date(),
        })
        .where(eq(announcements.id, id));
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
