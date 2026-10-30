import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../db';
import { audienceMemberCondition } from './announcementReceiptRepository';
import {
  announcementReceipts,
  announcements,
  users,
  type AnnouncementRow,
  type NewAnnouncementRow,
} from '../schema';

/**
 * Announcement persistence (§13.4 V4-P5b; data model §6.19.5). Owns the
 * `announcements` rows the admin composer writes plus the per-user
 * `announcement_receipts` rows (`announcement_dismissals` before 0122) a
 * caller stamps to hide the banner.
 *
 * ── Lifecycle (§6.19.4) ─────────────────────────────────────────────────────
 * `draft → published → archived`, with `published → draft` only while the
 * window has not opened. Every transition is ONE conditional UPDATE whose
 * WHERE clause is the transition's precondition, so two concurrent operators
 * cannot both win and a stale read cannot push a row through a transition its
 * current state forbids. `active` is written in lockstep for one release
 * (`active = (lifecycle = 'published')`) so a rollback reads consistent rows.
 *
 * Fan-out of the inbox notification itself
 * rides the existing {@link import('./notificationRepository').NotificationRepository}
 * via the shared `account.notice` type and per-user eventKey — no announcement
 * schema is duplicated on the notification side.
 */

export interface CreateAnnouncementInput {
  kind: 'notice' | 'once' | 'ack_required';
  audience: 'everyone' | 'existing_at_publish';
  severity: 'info' | 'warning' | 'critical';
  titleEn: string;
  bodyEn: string;
  titleDe: string | null;
  bodyDe: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  notifyByEmail: boolean;
  notifyByEmailAfterDays: number;
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
  kind?: 'notice' | 'once' | 'ack_required';
  audience?: 'everyone' | 'existing_at_publish';
  severity?: 'info' | 'warning' | 'critical';
  titleEn?: string;
  bodyEn?: string;
  titleDe?: string | null;
  bodyDe?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  notifyByEmail?: boolean;
  notifyByEmailAfterDays?: number;
  publishedAt?: Date | null;
}

/** What an archive did: the archived row, and whether this call archived it. */
export type ArchiveOutcome =
  | { status: 'archived'; row: AnnouncementRow; pendingAtArchive: number | null }
  | { status: 'already-archived'; row: AnnouncementRow }
  | { status: 'not-published' }
  | { status: 'not-found' };

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

    /** Always a draft (§6.19.4): nothing is released, delivered or visible. */
    async create(input: CreateAnnouncementInput): Promise<AnnouncementRow> {
      const values: NewAnnouncementRow = {
        kind: input.kind,
        audience: input.audience,
        lifecycle: 'draft',
        active: false,
        bodyFormat: 'markdown',
        severity: input.severity,
        titleEn: input.titleEn,
        bodyEn: input.bodyEn,
        titleDe: input.titleDe,
        bodyDe: input.bodyDe,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        notifyByEmail: input.notifyByEmail,
        notifyByEmailAfterDays: input.notifyByEmailAfterDays,
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
      for (const key of [
        'kind',
        'audience',
        'severity',
        'titleEn',
        'bodyEn',
        'titleDe',
        'bodyDe',
        'startsAt',
        'endsAt',
        'notifyByEmail',
        'notifyByEmailAfterDays',
        'publishedAt',
      ] as const) {
        if (patch[key] !== undefined) set[key] = patch[key];
      }
      const [row] = await db
        .update(announcements)
        .set(set)
        .where(eq(announcements.id, id))
        .returning();
      return row;
    },

    /**
     * Delete a DRAFT and its receipts (§6.19.4: a published announcement is
     * never deleted — it may hold acknowledgement evidence). The precondition
     * is in the DELETE itself. A draft can still hold legacy dismissals (the
     * pre-0122 route accepted any id) and never an acknowledgement; the
     * receipts go first because neither receipt key cascades, and only the
     * un-acknowledged ones — should one ever hold an acknowledgement, the
     * RESTRICT key refuses the whole delete rather than erase it.
     */
    async removeDraft(id: string): Promise<boolean> {
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [draft] = await tx
          .select({ id: announcements.id })
          .from(announcements)
          .where(and(eq(announcements.id, id), eq(announcements.lifecycle, 'draft')))
          .for('update');
        if (!draft) return false;
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
          .where(and(eq(announcements.id, id), eq(announcements.lifecycle, 'draft')))
          .returning({ id: announcements.id });
        return rows.length > 0;
      });
    },

    /**
     * draft → published. Stamps `released_at` / `released_by` and FREEZES
     * `audience_cutoff_at = GREATEST(at, starts_at)` — the instant it first
     * becomes visible (Chief ruling 2026-10-29); it never moves afterwards.
     * Precondition `lifecycle = 'draft'` in the UPDATE.
     */
    async publish(id: string, actorId: string, at: Date): Promise<AnnouncementRow | undefined> {
      const [row] = await db
        .update(announcements)
        .set({
          lifecycle: 'published',
          active: true,
          releasedAt: at,
          releasedBy: actorId,
          audienceCutoffAt: sql`GREATEST(${at}::timestamptz, COALESCE(${announcements.startsAt}, ${at}::timestamptz))`,
          updatedAt: at,
        })
        .where(and(eq(announcements.id, id), eq(announcements.lifecycle, 'draft')))
        .returning();
      return row;
    },

    /**
     * published → draft, only while the window has not opened (nobody can have
     * seen it, nothing was delivered). Precondition in the UPDATE.
     */
    async unpublish(id: string, at: Date): Promise<AnnouncementRow | undefined> {
      const [row] = await db
        .update(announcements)
        .set({
          lifecycle: 'draft',
          active: false,
          releasedAt: null,
          releasedBy: null,
          audienceCutoffAt: null,
          updatedAt: at,
        })
        .where(
          and(
            eq(announcements.id, id),
            eq(announcements.lifecycle, 'published'),
            isNull(announcements.publishedAt),
            gt(announcements.startsAt, at),
          ),
        )
        .returning();
      return row;
    },

    /**
     * published → archived; idempotent on an archived row. Takes the row
     * `FOR UPDATE` — an acknowledgement holds it `FOR SHARE` — so an archive and
     * an acknowledgement serialize and can never both win (§6.19.5). For
     * `ack_required` it counts who was still pending at that instant (the
     * `announcement.archive` audit meta).
     */
    async archive(id: string, actorId: string, at: Date): Promise<ArchiveOutcome> {
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [current] = await tx
          .select()
          .from(announcements)
          .where(eq(announcements.id, id))
          .for('update');
        if (!current) return { status: 'not-found' };
        if (current.lifecycle === 'archived') return { status: 'already-archived', row: current };
        if (current.lifecycle !== 'published') return { status: 'not-published' };
        let pendingAtArchive: number | null = null;
        if (current.kind === 'ack_required') {
          const [counted] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(users)
            .where(
              and(
                audienceMemberCondition(current.audience, current.audienceCutoffAt),
                sql`NOT EXISTS (SELECT 1 FROM ${announcementReceipts} r
                      WHERE r.announcement_id = ${id} AND r.user_id = ${users.id}
                        AND (r.acknowledged_at IS NOT NULL OR r.lapsed_at IS NOT NULL))`,
              ),
            );
          pendingAtArchive = counted?.n ?? 0;
        }
        const [row] = await tx
          .update(announcements)
          .set({
            lifecycle: 'archived',
            active: false,
            archivedAt: at,
            archivedBy: actorId,
            updatedAt: at,
          })
          .where(and(eq(announcements.id, id), eq(announcements.lifecycle, 'published')))
          .returning();
        return { status: 'archived', row: row!, pendingAtArchive };
      });
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
            eq(announcements.lifecycle, 'published'),
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
            eq(announcements.lifecycle, 'published'),
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
