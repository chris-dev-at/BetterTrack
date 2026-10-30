import {
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../db';
import {
  announcementReceipts,
  announcements,
  users,
  type AnnouncementReceiptRow,
  type AnnouncementRow,
} from '../schema';

/**
 * Who an announcement is shown to, and what each person did with it
 * (PROJECTPLAN §6.19.3, §6.19.5; contract §4). All user-side visibility lives
 * here, as SQL, so the list, the per-id read, `seen`, `dismiss`,
 * `acknowledge` and the gate's "pending for user" query can never disagree
 * about who is in the audience or when a window is open.
 *
 * Three predicates, defined once:
 *  • **audience** — `everyone`, or `existing_at_publish` with the account
 *    created STRICTLY before the frozen `audience_cutoff_at`. Admin-kind
 *    accounts never reach these queries (the user routes refuse them first).
 *  • **open** — published, `[starts_at, ends_at)` half-open against `at`.
 *  • **opened** (the per-id read) — published or archived, and the window had
 *    opened by now and before any archive: drafts, scheduled-but-not-open and
 *    "archived before anyone could see it" all read as not found.
 */

export interface AnnouncementViewer {
  id: string;
  /** `users.created_at` — the audience test compares it with the cutoff. */
  createdAt: Date;
}

/** The caller's receipt columns, flattened (absent receipt → all null). */
export interface ViewerReceipt {
  seenAt: Date | null;
  dismissedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedVia: 'web_session' | 'first_party_oauth' | null;
  acknowledgedLocale: string | null;
  acknowledgedContentSha256: string | null;
  lapsedAt: Date | null;
  lapseReason: 'ended' | 'archived' | null;
}

export interface VisibleAnnouncement {
  row: AnnouncementRow;
  receipt: ViewerReceipt;
}

export interface AcknowledgeInput {
  userId: string;
  announcementId: string;
  via: 'web_session' | 'first_party_oauth';
  grantId: string | null;
  locale: 'en' | 'de';
  contentSha256: string;
}

export type AcknowledgeOutcome =
  | { status: 'recorded'; receipt: AnnouncementReceiptRow }
  | { status: 'replayed'; receipt: AnnouncementReceiptRow }
  | { status: 'not-pending' }
  | { status: 'not-found' };

/** At most this many items in the user list (contract §4.1). */
const USER_LIST_LIMIT = 50;

export function audienceIncludes(createdAt: Date): SQL {
  return or(
    eq(announcements.audience, 'everyone'),
    gt(announcements.audienceCutoffAt, createdAt),
  ) as SQL;
}

/**
 * Membership of `users` in an audience, as a WHERE condition on `users`:
 * user-kind accounts only, and for `existing_at_publish` only those created
 * strictly before the cutoff. Account status does not change membership.
 */
export function audienceMemberCondition(
  audience: 'everyone' | 'existing_at_publish',
  cutoffAt: Date | null,
): SQL {
  if (audience === 'everyone') return eq(users.role, 'user');
  if (cutoffAt === null) return sql`false`;
  return and(eq(users.role, 'user'), lt(users.createdAt, cutoffAt)) as SQL;
}

/** The cutoff a row has, or — for a draft — would have if published at `at`. */
export function effectiveCutoff(row: AnnouncementRow, at: Date): Date {
  if (row.audienceCutoffAt) return row.audienceCutoffAt;
  return row.startsAt && row.startsAt.getTime() > at.getTime() ? row.startsAt : at;
}

export type ReceiptFilter =
  | 'pending'
  | 'acknowledged'
  | 'lapsed'
  | 'seen'
  | 'dismissed'
  | 'unseen'
  | 'all';

export interface ReceiptLogRow {
  userId: string | null;
  subjectToken: string | null;
  username: string | null;
  accountCreatedAt: Date | null;
  accountStatus: 'active' | 'disabled' | 'deleted';
  seenAt: Date | null;
  dismissedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedVia: 'web_session' | 'first_party_oauth' | null;
  acknowledgedLocale: string | null;
  acknowledgedContentSha256: string | null;
  lapsedAt: Date | null;
  lapseReason: 'ended' | 'archived' | null;
}

/** Keyset position: the live-account segment by user id, then deleted rows by token. */
export type ReceiptCursor =
  | { segment: 'live'; after: string }
  | { segment: 'deleted'; after: string };

export interface AnnouncementStatsRow {
  audience: number;
  seen: number;
  dismissed: number;
  acknowledged: number;
  acknowledgedByDeletedAccounts: number;
  lapsed: number;
}

export function windowOpenAt(at: Date): SQL {
  return and(
    or(isNull(announcements.startsAt), lte(announcements.startsAt, at)),
    or(isNull(announcements.endsAt), gt(announcements.endsAt, at)),
  ) as SQL;
}

/** Published, window open, viewer in the audience — the §4.1 predicate before receipts. */
function openFor(viewer: AnnouncementViewer, at: Date): SQL {
  return and(
    eq(announcements.lifecycle, 'published'),
    windowOpenAt(at),
    audienceIncludes(viewer.createdAt),
  ) as SQL;
}

/** The §4.2 predicate: visible to read, ended and archived included. */
function openedFor(viewer: AnnouncementViewer, at: Date): SQL {
  return and(
    or(eq(announcements.lifecycle, 'published'), eq(announcements.lifecycle, 'archived')),
    or(isNull(announcements.startsAt), lte(announcements.startsAt, at)),
    // An announcement archived before its window opened was never seen by anyone.
    or(
      isNull(announcements.archivedAt),
      isNull(announcements.startsAt),
      lte(announcements.startsAt, announcements.archivedAt),
    ),
    audienceIncludes(viewer.createdAt),
  ) as SQL;
}

const receiptColumns = {
  seenAt: announcementReceipts.seenAt,
  dismissedAt: announcementReceipts.dismissedAt,
  acknowledgedAt: announcementReceipts.acknowledgedAt,
  acknowledgedVia: announcementReceipts.acknowledgedVia,
  acknowledgedLocale: announcementReceipts.acknowledgedLocale,
  acknowledgedContentSha256: announcementReceipts.acknowledgedContentSha256,
  lapsedAt: announcementReceipts.lapsedAt,
  lapseReason: announcementReceipts.lapseReason,
};

function joinViewerReceipt(viewerId: string): SQL {
  return and(
    eq(announcementReceipts.announcementId, announcements.id),
    eq(announcementReceipts.userId, viewerId),
  ) as SQL;
}

/** `ack_required` first, then `once`, then `notice`. */
const KIND_RANK = sql`CASE ${announcements.kind} WHEN 'ack_required' THEN 0 WHEN 'once' THEN 1 ELSE 2 END`;

export function createAnnouncementReceiptRepository(db: Database) {
  async function upsertStamp(
    userId: string,
    announcementId: string,
    column: 'seenAt' | 'dismissedAt',
    at: Date,
  ): Promise<void> {
    const target = announcementReceipts[column];
    const excluded = column === 'seenAt' ? sql`excluded.seen_at` : sql`excluded.dismissed_at`;
    const values =
      column === 'seenAt'
        ? { userId, announcementId, seenAt: at, createdAt: at, updatedAt: at }
        : { userId, announcementId, seenAt: at, dismissedAt: at, createdAt: at, updatedAt: at };
    await db
      .insert(announcementReceipts)
      .values(values)
      .onConflictDoUpdate({
        target: [announcementReceipts.userId, announcementReceipts.announcementId],
        set: {
          [column]: sql`COALESCE(${target}, ${excluded})`,
          // A dismissal implies the item was shown.
          seenAt: sql`COALESCE(${announcementReceipts.seenAt}, excluded.seen_at)`,
          updatedAt: sql`CASE WHEN ${target} IS NULL THEN excluded.updated_at ELSE ${announcementReceipts.updatedAt} END`,
        },
      });
  }

  return {
    /**
     * `GET /notifications/announcements` (contract §4.1): open, in the
     * audience, minus dismissed `notice`/`once` and acknowledged
     * `ack_required`. `ack_required` first, oldest obligation first (by the
     * instant it first became visible, `audience_cutoff_at`); then `once`, then
     * `notice`, each newest first. Bounded.
     */
    async listOpenForViewer(viewer: AnnouncementViewer, at: Date): Promise<VisibleAnnouncement[]> {
      const rows = await db
        .select({ row: announcements, ...receiptColumns })
        .from(announcements)
        .leftJoin(announcementReceipts, joinViewerReceipt(viewer.id))
        .where(
          and(
            openFor(viewer, at),
            or(
              and(ne(announcements.kind, 'ack_required'), isNull(announcementReceipts.dismissedAt)),
              and(
                eq(announcements.kind, 'ack_required'),
                isNull(announcementReceipts.acknowledgedAt),
              ),
            ),
          ),
        )
        .orderBy(
          KIND_RANK,
          sql`CASE WHEN ${announcements.kind} = 'ack_required' THEN ${announcements.audienceCutoffAt} END ASC`,
          sql`${announcements.audienceCutoffAt} DESC`,
          asc(announcements.id),
        )
        .limit(USER_LIST_LIMIT);
      return rows.map(({ row, ...receipt }) => ({ row, receipt }));
    },

    /**
     * **The "pending for user" query** — what the acknowledgement gate (T2-B)
     * and every `MeResponse` read. `ack_required`, published, window open at
     * `at`, the viewer in the audience, not acknowledged. Oldest obligation
     * first. Served by `announcements_lifecycle_kind_window_idx` plus one
     * unique-index probe per live row.
     */
    async listPendingAcknowledgements(
      viewer: AnnouncementViewer,
      at: Date,
    ): Promise<AnnouncementRow[]> {
      const rows = await db
        .select({ row: announcements })
        .from(announcements)
        .leftJoin(announcementReceipts, joinViewerReceipt(viewer.id))
        .where(
          and(
            eq(announcements.kind, 'ack_required'),
            openFor(viewer, at),
            isNull(announcementReceipts.acknowledgedAt),
          ),
        )
        .orderBy(asc(announcements.audienceCutoffAt), asc(announcements.id));
      return rows.map((r) => r.row);
    },

    /** The §4.2 read: one announcement the viewer may look at, with their receipt. */
    async findOpenedForViewer(
      id: string,
      viewer: AnnouncementViewer,
      at: Date,
    ): Promise<VisibleAnnouncement | undefined> {
      const [found] = await db
        .select({ row: announcements, ...receiptColumns })
        .from(announcements)
        .leftJoin(announcementReceipts, joinViewerReceipt(viewer.id))
        .where(and(eq(announcements.id, id), openedFor(viewer, at)))
        .limit(1);
      if (!found) return undefined;
      const { row, ...receipt } = found;
      return { row, receipt };
    },

    /** Whether `id` is in the viewer's current list, receipts ignored (§4.3, §4.4). */
    async isOpenForViewer(
      id: string,
      viewer: AnnouncementViewer,
      at: Date,
    ): Promise<AnnouncementRow | undefined> {
      const [row] = await db
        .select()
        .from(announcements)
        .where(and(eq(announcements.id, id), openFor(viewer, at)))
        .limit(1);
      return row;
    },

    /**
     * `seen` — first write wins. Idempotency key `(user_id, announcement_id)`;
     * a repeat never moves `seen_at` and never touches `updated_at`.
     */
    markSeen(userId: string, announcementId: string, at: Date): Promise<void> {
      return upsertStamp(userId, announcementId, 'seenAt', at);
    },

    /** `dismiss` — first write wins, and stamps `seen_at` when still empty. */
    markDismissed(userId: string, announcementId: string, at: Date): Promise<void> {
      return upsertStamp(userId, announcementId, 'dismissedAt', at);
    },

    /**
     * Record one acknowledgement (contract §4.5), idempotent and first-write
     * wins. Idempotency key: `(user_id, announcement_id)`.
     *
     * One transaction that holds the announcement row `FOR SHARE` — archive
     * takes it `FOR UPDATE`, so an acknowledgement and an archive serialize —
     * and the caller's receipt `FOR UPDATE`. An existing acknowledgement is
     * returned unchanged (`replayed`). Liveness is re-checked on the DATABASE
     * clock under that lock: published, window open now. The write itself is
     * guarded `acknowledged_at IS NULL AND lapsed_at IS NULL`, so a lapse that
     * won the race leaves nothing to overwrite and a concurrent duplicate
     * acknowledge finds the winner's row (`replayed`). `onRecorded` runs in the
     * same transaction — the audit row commits with the receipt or not at all.
     */
    async acknowledge(
      input: AcknowledgeInput,
      onRecorded: (tx: Database, receipt: AnnouncementReceiptRow) => Promise<void>,
    ): Promise<AcknowledgeOutcome> {
      return db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [locked] = await tx
          .select({
            id: announcements.id,
            live: sql<boolean>`(${announcements.lifecycle} = 'published'
              AND (${announcements.startsAt} IS NULL OR ${announcements.startsAt} <= now())
              AND (${announcements.endsAt} IS NULL OR ${announcements.endsAt} > now()))`,
          })
          .from(announcements)
          .where(eq(announcements.id, input.announcementId))
          .for('share');
        if (!locked) return { status: 'not-found' };

        const [existing] = await tx
          .select()
          .from(announcementReceipts)
          .where(
            and(
              eq(announcementReceipts.userId, input.userId),
              eq(announcementReceipts.announcementId, input.announcementId),
            ),
          )
          .for('update');
        if (existing?.acknowledgedAt) return { status: 'replayed', receipt: existing };
        if (!locked.live || existing?.lapsedAt) return { status: 'not-pending' };

        const now = sql`now()`;
        const [written] = await tx
          .insert(announcementReceipts)
          .values({
            userId: input.userId,
            announcementId: input.announcementId,
            seenAt: now,
            acknowledgedAt: now,
            acknowledgedVia: input.via,
            acknowledgedGrantId: input.grantId,
            acknowledgedLocale: input.locale,
            acknowledgedContentSha256: input.contentSha256,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [announcementReceipts.userId, announcementReceipts.announcementId],
            set: {
              seenAt: sql`COALESCE(${announcementReceipts.seenAt}, excluded.seen_at)`,
              acknowledgedAt: sql`excluded.acknowledged_at`,
              acknowledgedVia: sql`excluded.acknowledged_via`,
              acknowledgedGrantId: sql`excluded.acknowledged_grant_id`,
              acknowledgedLocale: sql`excluded.acknowledged_locale`,
              acknowledgedContentSha256: sql`excluded.acknowledged_content_sha256`,
              updatedAt: sql`excluded.updated_at`,
            },
            setWhere: and(
              isNull(announcementReceipts.acknowledgedAt),
              isNull(announcementReceipts.lapsedAt),
            ),
          })
          .returning();
        if (!written) {
          const [winner] = await tx
            .select()
            .from(announcementReceipts)
            .where(
              and(
                eq(announcementReceipts.userId, input.userId),
                eq(announcementReceipts.announcementId, input.announcementId),
              ),
            );
          return winner?.acknowledgedAt
            ? { status: 'replayed', receipt: winner }
            : { status: 'not-pending' };
        }
        await onRecorded(tx, written);
        return { status: 'recorded', receipt: written };
      });
    },

    /**
     * The log's counts (contract §7.4). Live receipts count only for accounts
     * in the audience; pseudonymised rows of deleted accounts count ONLY in
     * `acknowledgedByDeletedAccounts`, never in audience or acknowledged.
     */
    async stats(row: AnnouncementRow, at: Date): Promise<AnnouncementStatsRow> {
      const member = audienceMemberCondition(row.audience, effectiveCutoff(row, at));
      const [audience] = await db.select({ n: count() }).from(users).where(member);
      const [live] = await db
        .select({
          seen: sql<number>`count(${announcementReceipts.seenAt})::int`,
          dismissed: sql<number>`count(${announcementReceipts.dismissedAt})::int`,
          acknowledged: sql<number>`count(${announcementReceipts.acknowledgedAt})::int`,
          lapsed: sql<number>`count(${announcementReceipts.lapsedAt})::int`,
        })
        .from(announcementReceipts)
        .innerJoin(users, eq(users.id, announcementReceipts.userId))
        .where(and(eq(announcementReceipts.announcementId, row.id), member));
      const [deleted] = await db
        .select({ n: count() })
        .from(announcementReceipts)
        .where(
          and(eq(announcementReceipts.announcementId, row.id), isNull(announcementReceipts.userId)),
        );
      return {
        audience: Number(audience?.n ?? 0),
        seen: live?.seen ?? 0,
        dismissed: live?.dismissed ?? 0,
        acknowledged: live?.acknowledged ?? 0,
        acknowledgedByDeletedAccounts: Number(deleted?.n ?? 0),
        lapsed: live?.lapsed ?? 0,
      };
    },

    /**
     * One keyset page of the acknowledgement log (contract §7.4, §7.5): every
     * audience account (with or without a receipt) ordered by account id, then
     * — for `acknowledged` and `all` only — the pseudonymised rows of deleted
     * accounts ordered by their token. Returns at most `limit` rows and the
     * cursor of the next page, or null. Never an e-mail or IP column.
     */
    async listReceiptLog(
      row: AnnouncementRow,
      filter: ReceiptFilter,
      cursor: ReceiptCursor | null,
      limit: number,
      at: Date,
    ): Promise<{ items: ReceiptLogRow[]; next: ReceiptCursor | null }> {
      const items: ReceiptLogRow[] = [];
      const ack = row.kind === 'ack_required';
      const liveFilter: SQL | undefined = (() => {
        switch (filter) {
          case 'pending':
            return ack
              ? and(
                  isNull(announcementReceipts.acknowledgedAt),
                  isNull(announcementReceipts.lapsedAt),
                )
              : isNull(announcementReceipts.dismissedAt);
          case 'acknowledged':
            return isNotNull(announcementReceipts.acknowledgedAt);
          case 'lapsed':
            return isNotNull(announcementReceipts.lapsedAt);
          case 'seen':
            return isNotNull(announcementReceipts.seenAt);
          case 'dismissed':
            return isNotNull(announcementReceipts.dismissedAt);
          case 'unseen':
            return isNull(announcementReceipts.seenAt);
          default:
            return undefined;
        }
      })();

      if (cursor === null || cursor.segment === 'live') {
        const rows = await db
          .select({
            userId: users.id,
            username: users.username,
            accountCreatedAt: users.createdAt,
            status: users.status,
            ...receiptColumns,
          })
          .from(users)
          .leftJoin(
            announcementReceipts,
            and(
              eq(announcementReceipts.userId, users.id),
              eq(announcementReceipts.announcementId, row.id),
            ),
          )
          .where(
            and(
              audienceMemberCondition(row.audience, effectiveCutoff(row, at)),
              cursor ? gt(users.id, cursor.after) : undefined,
              liveFilter,
            ),
          )
          .orderBy(asc(users.id))
          .limit(limit + 1);
        for (const r of rows.slice(0, limit)) {
          items.push({
            userId: r.userId,
            subjectToken: null,
            username: r.username,
            accountCreatedAt: r.accountCreatedAt,
            accountStatus: r.status,
            seenAt: r.seenAt,
            dismissedAt: r.dismissedAt,
            acknowledgedAt: r.acknowledgedAt,
            acknowledgedVia: r.acknowledgedVia,
            acknowledgedLocale: r.acknowledgedLocale,
            acknowledgedContentSha256: r.acknowledgedContentSha256,
            lapsedAt: r.lapsedAt,
            lapseReason: r.lapseReason,
          });
        }
        if (rows.length > limit) {
          return { items, next: { segment: 'live', after: items[items.length - 1]!.userId! } };
        }
      }

      if (filter !== 'acknowledged' && filter !== 'all') return { items, next: null };
      const room = limit - items.length;
      if (room <= 0) return { items, next: { segment: 'deleted', after: '' } };
      const deleted = await db
        .select({
          subjectToken: announcementReceipts.subjectToken,
          acknowledgedAt: announcementReceipts.acknowledgedAt,
          acknowledgedContentSha256: announcementReceipts.acknowledgedContentSha256,
        })
        .from(announcementReceipts)
        .where(
          and(
            eq(announcementReceipts.announcementId, row.id),
            isNull(announcementReceipts.userId),
            cursor?.segment === 'deleted' && cursor.after !== ''
              ? gt(announcementReceipts.subjectToken, cursor.after)
              : undefined,
          ),
        )
        .orderBy(asc(announcementReceipts.subjectToken))
        .limit(room + 1);
      for (const r of deleted.slice(0, room)) {
        items.push({
          userId: null,
          subjectToken: r.subjectToken,
          username: null,
          accountCreatedAt: null,
          accountStatus: 'deleted',
          seenAt: null,
          dismissedAt: null,
          acknowledgedAt: r.acknowledgedAt,
          acknowledgedVia: null,
          acknowledgedLocale: null,
          acknowledgedContentSha256: r.acknowledgedContentSha256,
          lapsedAt: null,
          lapseReason: null,
        });
      }
      return deleted.length > room
        ? { items, next: { segment: 'deleted', after: items[items.length - 1]!.subjectToken! } }
        : { items, next: null };
    },

    /** Whether any receipt of `announcementId` records an acknowledgement. */
    async hasAcknowledgements(announcementId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: announcementReceipts.id })
        .from(announcementReceipts)
        .where(
          and(
            eq(announcementReceipts.announcementId, announcementId),
            isNotNull(announcementReceipts.acknowledgedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}

export type AnnouncementReceiptRepository = ReturnType<typeof createAnnouncementReceiptRepository>;
